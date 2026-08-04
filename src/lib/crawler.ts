/**
 * Crawler + search index for intranet.iiit.ac (or any base URL).
 *
 * - BFS crawl, same-origin only, robots.txt exact-prefix disallow, rate limited.
 * - Stores pages in SQLite (bun:sqlite, no deps) with an FTS5 index.
 * - CLI: `bun run crawl [--base-url ...] [--max-pages 500] [--delay-ms 250]
 *   [--timeout-ms 10000] [--cookie "..."] [--db path] [--fresh] [--verbose]`
 *
 * The live intranet only resolves on the campus network / VPN; running the
 * crawler elsewhere yields zero pages, which is expected, not a bug.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_DB = process.env.INTRANET_DB ?? join("index", "intranet.db");
const DEFAULT_BASE = "https://intranet.iiit.ac";
const UA = "iiit-intranet-indexer/0.1";

export type CrawlOptions = {
  baseUrl?: string;
  dbPath?: string;
  maxPages?: number;
  delayMs?: number;
  timeoutMs?: number;
  cookie?: string;
  fresh?: boolean;
};

export type PageRow = {
  url: string;
  status: number;
  title: string;
  meta: string;
  text: string;
  fetched_at: string;
};

export type SearchResult = {
  url: string;
  title: string;
  meta: string;
  fetched_at: string;
  snippet: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL
);
`;

// url is full-text indexed too: most intranet content is PDF/XLS files whose
// filenames are the only searchable text (snippet column 2 = text).
const FTS_SCHEMA = `CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(url, title, text, tokenize='porter')`;

function openDb(dbPath: string, fresh: boolean): Database {
  if (fresh) rmSync(dbPath, { force: true });
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  db.run(FTS_SCHEMA);
  // Recreate pages_fts if it was created by an older schema (url UNINDEXED).
  const existing = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pages_fts'").get() as
    | { sql: string }
    | undefined;
  if (existing && existing.sql.includes("UNINDEXED")) {
    db.run("DROP TABLE pages_fts");
    db.run(FTS_SCHEMA);
  }
  return db;
}

function sameOrigin(url: string, base: string): string | null {
  try {
    const u = new URL(url, base);
    if (u.origin !== new URL(base).origin) return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

async function fetchRobots(baseUrl: string, timeoutMs: number, cookie?: string): Promise<string[]> {
  try {
    const res = await fetch(new URL("/robots.txt", baseUrl), {
      headers: { "user-agent": UA, ...(cookie ? { cookie } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const disallow: string[] = [];
    for (const line of (await res.text()).split(/\r?\n/)) {
      const m = /^disallow:\s*(\S+)/i.exec(line.trim());
      if (m?.[1]) disallow.push(m[1]);
    }
    return disallow;
  } catch {
    return [];
  }
}

type Fetched = { status: number; contentType?: string; body?: string; finalUrl?: string };

async function fetchPage(url: string, timeoutMs: number, cookie?: string): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, ...(cookie ? { cookie } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status !== 200) return { status: res.status, contentType, finalUrl: res.url };
    return { status: 200, contentType, body: await res.text(), finalUrl: res.url };
  } catch {
    return { status: -1 }; // network error / timeout
  }
}

type Extracted = { title: string; meta: string; text: string; links: string[] };

/** Extract title/meta/text/links via HTMLRewriter (Bun built-in).
 *  Content inside <script>/<style> is never delivered to text handlers on
 *  other elements, so no exclusions are needed. */
async function extractHtml(body: string, url: string): Promise<Extracted> {
  const origin = new URL(url).origin;
  let title = "";
  let meta = "";
  let text = "";
  const links = new Set<string>();

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(t) {
        title += t.text;
      },
    })
    .on("meta", {
      element(el) {
        if (el.getAttribute("name") === "description") meta = el.getAttribute("content") ?? "";
      },
    })
    .on("a[href]", {
      element(el) {
        const href = el.getAttribute("href");
        if (href) {
          const u = sameOrigin(href, url);
          if (u) links.add(u);
        }
      },
    })
    .on("p, h1, h2, h3, h4, h5, h6, li, td, th, div, span, a", {
      text(t) {
        text += t.text + " ";
      },
    });

  await rewriter.transform(new Response(body));

  return {
    title: title.trim().slice(0, 500),
    meta: meta.trim().slice(0, 1000),
    text: text.replace(/\s+/g, " ").trim().slice(0, 50_000),
    links: [...links],
  };
}

export async function crawl(options: CrawlOptions = {}): Promise<{
  baseUrl: string;
  dbPath: string;
  fetched: number;
  skipped: number;
  failed: number;
}> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE;
  const dbPath = options.dbPath ?? DEFAULT_DB;
  const maxPages = options.maxPages ?? 500;
  const delayMs = options.delayMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cookie = options.cookie;
  const origin = new URL(baseUrl).origin;
  // Canonicalize the start URL (new URL adds the trailing slash) so "/" and a
  // bare host normalize to the same key as in-page links to "/".
  const start = sameOrigin(baseUrl, baseUrl) ?? baseUrl;

  const db = openDb(dbPath, options.fresh ?? false);
  const disallow = await fetchRobots(baseUrl, timeoutMs, cookie);
  const isAllowed = (u: string) => {
    const p = new URL(u).pathname;
    return !disallow.some((d) => d && p.startsWith(d));
  };

  const insert = db.prepare(
    "INSERT OR REPLACE INTO pages (url, status, title, meta, text, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const queue: string[] = [start];
  const seen = new Set<string>();
  let fetched = 0;
  let skipped = 0;
  let failed = 0;

  while (queue.length > 0 && fetched < maxPages) {
    let url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!isAllowed(url)) {
      skipped++;
      continue;
    }

    let page = await fetchPage(url, timeoutMs, cookie);
    // fetch() already followed any redirect chain; record a 302 stub for the
    // original URL and index the final URL instead (same-origin only).
    const finalUrl = page.finalUrl ?? url;
    if (finalUrl !== url) {
      insert.run(url, 302, "", "redirect: " + finalUrl, "", new Date().toISOString());
      url = finalUrl;
      if (seen.has(url) || !sameOrigin(url, baseUrl)) continue; // stub is all we record
      seen.add(url);
    }

    if (page.status === 200 && page.body && page.contentType?.includes("text/html")) {
      const { title, meta, text, links } = await extractHtml(page.body, url);
      insert.run(url, 200, title, meta, text, new Date().toISOString());
      for (const link of links) if (!seen.has(link)) queue.push(link);
      fetched++;
    } else if (page.status === 200 && page.body) {
      insert.run(url, 200, "", "non-html: " + (page.contentType ?? ""), "", new Date().toISOString());
      fetched++;
    } else if (page.status === -1) {
      failed++;
    } else {
      insert.run(url, page.status, "", page.meta ?? "", "", new Date().toISOString());
      fetched++;
    }

    if (delayMs > 0) await Bun.sleep(delayMs);
  }

  db.run("DELETE FROM pages_fts");
  db.run("INSERT INTO pages_fts (url, title, text) SELECT url, title, text FROM pages");
  db.close();
  return { baseUrl, dbPath, fetched, skipped, failed };
}

function fallbackSnippet(text: string, query: string): string {
  const t = text.trim();
  const i = t.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return t.slice(0, 160);
  const start = Math.max(0, i - 60);
  return (start > 0 ? "…" : "") + t.slice(start, start + 160) + (start + 160 < t.length ? "…" : "");
}

export function search(dbPath: string, query: string, limit = 20): SearchResult[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    // Treat the input as a literal phrase; on syntax error fall back to LIKE.
    const phrase = '"' + query.replace(/"/g, '""') + '"';
    const rows = db
      .query(
        `SELECT p.url, p.title, p.meta, p.fetched_at, bm25(pages_fts) AS score,
                snippet(pages_fts, 2, '…', '…', '…', 12) AS snip
         FROM pages_fts JOIN pages p ON p.url = pages_fts.url
         WHERE pages_fts MATCH ? ORDER BY score LIMIT ?`,
      )
      .all(phrase, limit) as { url: string; title: string; meta: string; fetched_at: string; snip: string | null; text?: string }[];
    return rows.map((r) => ({
      url: r.url,
      title: r.title,
      meta: r.meta,
      fetched_at: r.fetched_at,
      snippet: r.snip || fallbackSnippet("", query),
    }));
  } catch {
    const q = `%${query}%`;
    const rows = db
      .query(
        `SELECT url, title, meta, fetched_at, text FROM pages WHERE title LIKE ? OR text LIKE ? OR url LIKE ? ORDER BY fetched_at DESC LIMIT ?`,
      )
      .all(q, q, q, limit) as { url: string; title: string; meta: string; fetched_at: string; text: string }[];
    return rows.map((r) => ({
      url: r.url,
      title: r.title,
      meta: r.meta,
      fetched_at: r.fetched_at,
      snippet: fallbackSnippet(r.text, query),
    }));
  } finally {
    db.close();
  }
}

export function recentPages(dbPath: string, limit = 50): { url: string; title: string; status: number; fetched_at: string }[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query(
        "SELECT url, title, status, fetched_at FROM pages WHERE status = 200 ORDER BY fetched_at DESC LIMIT ?",
      )
      .all(limit) as { url: string; title: string; status: number; fetched_at: string }[];
  } finally {
    db.close();
  }
}

export function indexExists(dbPath: string = DEFAULT_DB): boolean {
  return existsSync(dbPath);
}

/** True when the index has at least one recorded page (an empty DB from an
 *  off-campus crawl should not block the on-campus auto-crawl). */
export function indexHasPages(dbPath: string = DEFAULT_DB): boolean {
  if (!existsSync(dbPath)) return false;
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT count(*) AS c FROM pages").get() as { c: number }).c > 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const arg = (name: string, def?: string) => {
    const i = Bun.argv.indexOf(`--${name}`);
    return i === -1 ? def : (Bun.argv[i + 1] ?? "true");
  };
  const options: CrawlOptions = {
    baseUrl: arg("base-url", DEFAULT_BASE),
    dbPath: arg("db", DEFAULT_DB),
    maxPages: Number(arg("max-pages", "500")),
    delayMs: Number(arg("delay-ms", "250")),
    timeoutMs: Number(arg("timeout-ms", "10000")),
    cookie: arg("cookie"),
    fresh: Bun.argv.includes("--fresh"),
  };
  const started = Date.now();
  console.log(`crawling ${options.baseUrl} → ${options.dbPath}`);
  const result = await crawl(options);
  console.log(
    `done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${result.fetched} pages indexed, ` +
      `${result.skipped} robots-skipped, ${result.failed} failed`,
  );
}
