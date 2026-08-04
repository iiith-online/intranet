/**
 * Crawler + search index for intranet.iiit.ac.in (or any base URL).
 *
 * - BFS crawl, same-origin only, robots.txt exact-prefix disallow, rate limited.
 * - Pages stored in SQLite (bun:sqlite, no deps) with an FTS5 index; file
 *   bodies (PDF/XLS/…) are never downloaded, only their metadata is recorded.
 * - With `--push` (or DATABASE_URL set) every page is also upserted into
 *   Postgres (Neon), and the server reads from Postgres when DATABASE_URL is
 *   set — so device-side scans can contribute to a shared index.
 * - CLI: `bun run crawl [--base-url ...] [--max-pages 5000] [--delay-ms 250]
 *   [--timeout-ms 10000] [--cookie "..."] [--db path] [--fresh] [--push]`
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { neon } from "@neondatabase/serverless";

export const DEFAULT_DB = process.env.INTRANET_DB ?? join("index", "intranet.db");
const DEFAULT_BASE = "https://intranet.iiit.ac.in";
const UA = "iiit-intranet-indexer/0.1";
const DATABASE_URL = process.env.DATABASE_URL;

/** Portable Postgres handle: postgres.js (TCP) or the Neon serverless driver
 *  (HTTPS, for networks that block port 5432). Both take $n placeholders. */
type Db = {
  query(text: string, params?: any[]): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
};

export type CrawlOptions = {
  baseUrl?: string;
  dbPath?: string;
  maxPages?: number;
  delayMs?: number;
  timeoutMs?: number;
  cookie?: string;
  fresh?: boolean;
  /** Upsert every page into Postgres (requires DATABASE_URL). */
  push?: boolean;
  /** Label recorded in the pg `scans` table ("cli", "web", …). */
  scanSource?: string;
};

export type PageMeta = {
  kind: "html" | "file" | "redirect" | "error";
  description?: string;
  keywords?: string;
  ogTitle?: string;
  ogDescription?: string;
  canonical?: string;
  contentType?: string;
  contentLength?: number;
  lastModified?: string;
  redirectTo?: string;
};

export type SearchResult = {
  url: string;
  title: string;
  meta: PageMeta;
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
  links TEXT NOT NULL DEFAULT '[]',
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

type Fetched = {
  status: number;
  contentType?: string;
  contentLength?: number;
  lastModified?: string;
  body?: string;
  finalUrl?: string;
};

async function fetchPage(url: string, timeoutMs: number, cookie?: string): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, ...(cookie ? { cookie } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const contentLength = Number(res.headers.get("content-length") ?? NaN);
    const lastModified = res.headers.get("last-modified") ?? undefined;
    if (res.status !== 200) return { status: res.status, contentType, contentLength, lastModified, finalUrl: res.url };
    if (!contentType.includes("text/html")) {
      // Files are recorded with their metadata only; stop the download.
      res.body?.cancel();
      return { status: 200, contentType, contentLength, lastModified, finalUrl: res.url };
    }
    return { status: 200, contentType, contentLength, lastModified, body: await res.text(), finalUrl: res.url };
  } catch {
    return { status: -1 }; // network error / timeout
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

/** Decode HTML entities in extracted text (HTMLRewriter leaves them raw). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

/** Extract title/metadata/text/links via HTMLRewriter (Bun built-in).
 *  Content inside <script>/<style> is never delivered to text handlers on
 *  other elements, so no exclusions are needed. */
async function extractHtml(body: string, url: string): Promise<{ title: string; meta: PageMeta; text: string; links: string[] }> {
  const origin = new URL(url).origin;
  let title = "";
  const tags: Record<string, string> = {};
  const links = new Set<string>();
  const chunks: string[] = [];

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(t) {
        title += t.text;
      },
    })
    .on("meta", {
      element(el) {
        const key = el.getAttribute("name") ?? el.getAttribute("property") ?? el.getAttribute("http-equiv");
        const value = el.getAttribute("content");
        if (key && value) tags[key.toLowerCase()] = value;
      },
    })
    .on("link[rel]", {
      element(el) {
        if (el.getAttribute("rel") === "canonical") tags.canonical = el.getAttribute("href") ?? "";
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
        chunks.push(t.text);
      },
    });

  await rewriter.transform(new Response(body));

  const meta: PageMeta = {
    kind: "html",
    description: decodeEntities(tags.description || tags["og:description"] || ""),
    keywords: decodeEntities(tags.keywords ?? ""),
    ogTitle: decodeEntities(tags["og:title"] ?? ""),
    canonical: tags.canonical,
  };
  return {
    title: decodeEntities(title).trim().slice(0, 500),
    meta,
    text: decodeEntities(chunks.join(" ")).replace(/\s+/g, " ").trim().slice(0, 50_000),
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
  const maxPages = options.maxPages ?? 5000;
  const delayMs = options.delayMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cookie = options.cookie;
  const origin = new URL(baseUrl).origin;
  // Canonicalize the start URL (new URL adds the trailing slash) so "/" and a
  // bare host normalize to the same key as in-page links to "/".
  const start = sameOrigin(baseUrl, baseUrl) ?? baseUrl;

  const db = openDb(dbPath, options.fresh ?? false);
  const pgs = options.push ? await pg() : null;
  if (pgs) {
    await ensurePgSchema(pgs);
    // Mirror sqlite --fresh semantics: the pg index is rebuilt from this crawl.
    if (options.fresh) await pgs.query("DELETE FROM pages");
  }

  const disallow = await fetchRobots(baseUrl, timeoutMs, cookie);
  const isAllowed = (u: string) => {
    const p = new URL(u).pathname;
    return !disallow.some((d) => d && p.startsWith(d));
  };

  const insert = db.prepare(
    "INSERT OR REPLACE INTO pages (url, status, title, meta, text, links, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const queue: string[] = [start];
  const seen = new Set<string>();
  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  const pgBuffer: Array<{ url: string; status: number; title: string; meta: PageMeta; text: string; links: string[] }> = [];

  const record = (url: string, status: number, title: string, meta: PageMeta, text: string, links: string[]) => {
    insert.run(url, status, title, JSON.stringify(meta), text, JSON.stringify(links), new Date().toISOString());
    if (pgs) pgBuffer.push({ url, status, title, meta, text, links });
  };
  const flushPg = async () => {
    if (pgs && pgBuffer.length > 0) {
      const rows = pgBuffer.splice(0, 200);
      const cols = ["url", "status", "title", "meta", "text", "links", "fetched_at"];
      const params: unknown[] = [];
      const tuples: string[] = [];
      rows.forEach((r, i) => {
        const base = i * cols.length;
        tuples.push(`(${cols.map((_, j) => `$${base + j + 1}${j === 3 || j === 5 ? "::jsonb" : ""}`).join(", ")})`);
        params.push(
          r.url,
          r.status,
          r.title,
          JSON.stringify(r.meta),
          r.text,
          JSON.stringify(r.links),
          new Date().toISOString(),
        );
      });
      await pgs.query(
        `INSERT INTO pages (${cols.join(", ")}) VALUES ${tuples.join(", ")}
         ON CONFLICT (url) DO UPDATE SET
           status = EXCLUDED.status, title = EXCLUDED.title, meta = EXCLUDED.meta,
           text = EXCLUDED.text, links = EXCLUDED.links, fetched_at = EXCLUDED.fetched_at`,
        params,
      );
    }
  };

  while (queue.length > 0 && fetched < maxPages) {
    let url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!isAllowed(url)) {
      skipped++;
      continue;
    }

    const page = await fetchPage(url, timeoutMs, cookie);
    // fetch() already followed any redirect chain; record a 302 stub for the
    // original URL and index the final URL instead (same-origin only).
    const finalUrl = page.finalUrl ?? url;
    if (finalUrl !== url) {
      record(url, 302, "", { kind: "redirect", redirectTo: finalUrl }, "", []);
      url = finalUrl;
      if (seen.has(url) || !sameOrigin(url, baseUrl)) continue; // stub is all we record
      seen.add(url);
    }

    if (page.status === 200 && page.body) {
      const { title, meta, text, links } = await extractHtml(page.body, url);
      record(url, 200, title, { ...meta, contentType: page.contentType, contentLength: page.contentLength, lastModified: page.lastModified }, text, links);
      for (const link of links) if (!seen.has(link)) queue.push(link);
      fetched++;
    } else if (page.status === 200) {
      // File (PDF/XLS/…): metadata only, body was cancelled at fetch time.
      record(url, 200, "", { kind: "file", contentType: page.contentType, contentLength: page.contentLength, lastModified: page.lastModified }, "", []);
      fetched++;
    } else if (page.status === -1) {
      failed++;
    } else {
      record(url, page.status, "", { kind: "error", contentType: page.contentType }, "", []);
      fetched++;
    }

    if (pgBuffer.length >= 200) await flushPg();
    if (delayMs > 0) await Bun.sleep(delayMs);
  }

  await flushPg();
  if (pgs) {
    await pgs.query(
      "INSERT INTO scans (source, base_url, pages, failed) VALUES ($1, $2, $3, $4)",
      [options.scanSource ?? "cli", baseUrl, fetched, failed],
    );
  }
  db.run("DELETE FROM pages_fts");
  db.run("INSERT INTO pages_fts (url, title, text) SELECT url, title, text FROM pages");
  db.close();
  return { baseUrl, dbPath, fetched, skipped, failed };
}

function parseMeta(raw: string | null | undefined): PageMeta {
  if (!raw) return { kind: "error" };
  try {
    return JSON.parse(raw) as PageMeta;
  } catch {
    return { kind: "error" };
  }
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
      .all(phrase, limit) as { url: string; title: string; meta: string; fetched_at: string; snip: string | null }[];
    return rows.map((r) => ({
      url: r.url,
      title: r.title,
      meta: parseMeta(r.meta),
      fetched_at: r.fetched_at,
      snippet: r.snip ?? "",
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
      meta: parseMeta(r.meta),
      fetched_at: r.fetched_at,
      snippet: fallbackSnippet(r.text, query),
    }));
  } finally {
    db.close();
  }
}

export type BrowseItem = { url: string; title: string; meta: PageMeta };
export type BrowseGroup = { id: string; title: string; items: BrowseItem[] };

const FILE_TOPICS: Array<{ id: string; title: string; re: RegExp }> = [
  { id: "fees", title: "Fees & Payments", re: /fee|tuition|refund/ },
  { id: "timetables", title: "Timetables & Schedules", re: /timetable|time-table|tut[-_]|tutorial|schedule|almanac|calendar/ },
  { id: "holidays", title: "Holidays", re: /holiday/ },
  { id: "committees", title: "Committees", re: /committee/ },
  { id: "policies", title: "Policies & Guidelines", re: /policy|guideline|regulation|manual/ },
  { id: "forms", title: "Forms", re: /(^|[-_ ])form/ },
  { id: "notices", title: "Notices & Circulars", re: /circular|notice|notification|letter|order/ },
  { id: "student-life", title: "Student Life", re: /student|hostel|mess|accommodation/ },
  { id: "recruitment", title: "Recruitment", re: /recruit|vacanc|job/ },
  { id: "minutes", title: "Meeting Minutes", re: /minute|meeting/ },
  { id: "finance", title: "Finance & Audit", re: /budget|audit|expenditure|finance/ },
];
const FILE_OTHER = { id: "files-other", title: "Other Documents" };

function humanize(path: string): string {
  const last = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? path);
  return last
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\.\w+$/, "");
}

/** Group indexed pages the way the original intranet presents them (offices,
 *  quick links, documents by topic) — but with counts and cleaner labels. */
export function groupPages(rows: { url: string; status: number; title: string; meta: PageMeta }[]): BrowseGroup[] {
  const offices: Record<string, BrowseItem[]> = {};
  const files: Record<string, BrowseItem[]> = {};
  const quick: BrowseItem[] = [];
  const misc: BrowseItem[] = [];
  for (const row of rows) {
    if (row.status !== 200) continue;
    let u: URL;
    try {
      u = new URL(row.url);
    } catch {
      continue;
    }
    const path = u.pathname;
    if (path.startsWith("/offices/default/offices_x")) {
      const name = decodeURIComponent(u.searchParams.get("office") ?? "Other");
      (offices[name] ??= []).push({ url: row.url, title: name, meta: row.meta });
    } else if (path.startsWith("/offices/static/files/")) {
      const name = decodeURIComponent(path.split("/").pop() ?? row.url);
      const topic = FILE_TOPICS.find((t) => t.re.test(name.toLowerCase())) ?? FILE_OTHER;
      (files[topic.id] ??= []).push({ url: row.url, title: name, meta: row.meta });
    } else if (
      path === "/offices" || path === "/offices/default" || path === "/offices/default/index" ||
      path === "/offices/default/old_events" || path === "/offices/default/telephone_directory" ||
      path === "/offices/default/display_all_files" || path === "/offices/default/search" || path === "/"
    ) {
      quick.push({ url: row.url, title: humanize(path), meta: row.meta });
    } else {
      misc.push({ url: row.url, title: humanize(path), meta: row.meta });
    }
  }
  const sortItems = (items: BrowseItem[]) => [...items].sort((a, b) => a.title.localeCompare(b.title));
  const groups: BrowseGroup[] = [];
  const officeNames = Object.keys(offices).sort((a, b) => a.localeCompare(b));
  if (officeNames.length) {
    groups.push({ id: "offices", title: "Offices", items: officeNames.flatMap((n) => sortItems(offices[n]!)) });
  }
  if (quick.length) groups.push({ id: "quick-links", title: "Quick Links", items: sortItems(quick) });
  for (const t of FILE_TOPICS) {
    if (files[t.id]) groups.push({ id: t.id, title: t.title, items: sortItems(files[t.id]!) });
  }
  if (files[FILE_OTHER.id]) {
    groups.push({ id: FILE_OTHER.id, title: FILE_OTHER.title, items: sortItems(files[FILE_OTHER.id]!) });
  }
  if (misc.length) groups.push({ id: "misc", title: "Other Pages", items: sortItems(misc) });
  return groups;
}

export function browseIndex(dbPath: string = DEFAULT_DB): BrowseGroup[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query("SELECT url, status, title, meta FROM pages")
      .all() as { url: string; status: number; title: string; meta: string }[];
    return groupPages(rows.map((r) => ({ url: r.url, status: r.status, title: r.title, meta: parseMeta(r.meta) })));
  } finally {
    db.close();
  }
}

export async function browseIndexPg(): Promise<BrowseGroup[]> {
  const pgs = await pg();
  if (!pgs) return browseIndex();
  const rows = await pgs.query("SELECT url, status, title, meta FROM pages");
  return groupPages(
    rows.map((r) => ({
      url: String(r.url),
      status: Number(r.status),
      title: String(r.title ?? ""),
      meta: (r.meta ?? {}) as PageMeta,
    })),
  );
}

export function recentPages(dbPath: string, limit = 50): { url: string; title: string; status: number; meta: PageMeta; fetched_at: string }[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        "SELECT url, title, status, meta, fetched_at FROM pages WHERE status = 200 ORDER BY fetched_at DESC LIMIT ?",
      )
      .all(limit) as { url: string; title: string; status: number; meta: string; fetched_at: string }[];
    return rows.map((r) => ({ url: r.url, title: r.title, status: r.status, meta: parseMeta(r.meta), fetched_at: r.fetched_at }));
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

// ---------------------------------------------------------------------------
// Postgres (Neon) sink + reads. Used when DATABASE_URL is set; the crawl
// pushes into it with --push and the server reads from it.
// ---------------------------------------------------------------------------

let _db: Db | null = null;

async function pg(): Promise<Db | null> {
  if (!DATABASE_URL) return null;
  if (_db) return _db;
  const isNeon = new URL(DATABASE_URL).hostname.endsWith(".neon.tech");
  if (isNeon) {
    // Neon's plain TCP endpoint (5432) is blocked on some networks; the
    // serverless driver talks HTTPS on 443 instead.
    const sql = neon(DATABASE_URL);
    _db = {
      query: (text, params = []) => sql.query(text, params) as Promise<Record<string, unknown>[]>,
      end: async () => {},
    };
  } else {
    const pgs = postgres(DATABASE_URL, { max: 5 });
    _db = {
      query: (text, params = []) => pgs.unsafe(text, params) as Promise<Record<string, unknown>[]>,
      end: () => pgs.end(),
    };
  }
  return _db;
}

async function ensurePgSchema(db: Db): Promise<void> {
  for (const stmt of [
    `CREATE TABLE IF NOT EXISTS pages (
      url TEXT PRIMARY KEY,
      status INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      meta JSONB NOT NULL DEFAULT '{}',
      text TEXT NOT NULL DEFAULT '',
      links JSONB NOT NULL DEFAULT '[]',
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS pages_fetched_idx ON pages (fetched_at DESC)`,
    `CREATE INDEX IF NOT EXISTS pages_fts_idx ON pages USING GIN (to_tsvector('english', title || ' ' || text || ' ' || url))`,
    `CREATE TABLE IF NOT EXISTS scans (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      base_url TEXT NOT NULL,
      pages INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  ]) {
    await db.query(stmt);
  }
}

async function pgSearch(db: Db, query: string, limit = 20): Promise<SearchResult[]> {
  try {
    const rows = await db.query(
      `SELECT url, title, meta, fetched_at,
              ts_headline('english', title || ' ' || text, plainto_tsquery('english', $1),
                          'MaxWords=24, MinWords=8') AS snip
       FROM pages
       WHERE to_tsvector('english', title || ' ' || text || ' ' || url) @@ plainto_tsquery('english', $1)
       ORDER BY ts_rank(to_tsvector('english', title || ' ' || text || ' ' || url), plainto_tsquery('english', $1)) DESC
       LIMIT $2`,
      [query, limit],
    );
    return rows.map((r) => ({
      url: String(r.url),
      title: String(r.title ?? ""),
      meta: (r.meta ?? {}) as PageMeta,
      fetched_at: new Date(r.fetched_at as string).toISOString(),
      snippet: String(r.snip ?? "").replace(/<[^>]+>/g, ""), // ts_headline adds <b> markup
    }));
  } catch {
    // Garbage query → ILIKE fallback.
    const like = `%${query}%`;
    const rows = await db.query(
      `SELECT url, title, meta, fetched_at, text FROM pages
       WHERE title ILIKE $1 OR text ILIKE $1 OR url ILIKE $1
       ORDER BY fetched_at DESC LIMIT $2`,
      [like, limit],
    );
    return rows.map((r) => ({
      url: String(r.url),
      title: String(r.title ?? ""),
      meta: (r.meta ?? {}) as PageMeta,
      fetched_at: new Date(r.fetched_at as string).toISOString(),
      snippet: fallbackSnippet(String(r.text ?? ""), query),
    }));
  }
}

// Unified reads used by the server: Postgres when DATABASE_URL is set,
// SQLite otherwise. Keeps local dev (no DB) and shared-index deployments
// on the same code path.

export async function searchIndex(query: string, limit = 20): Promise<SearchResult[]> {
  const pgs = await pg();
  return pgs ? pgSearch(pgs, query, limit) : search(DEFAULT_DB, query, limit);
}

export async function recentPagesIndex(limit = 50): Promise<{ url: string; title: string; status: number; meta: PageMeta; fetched_at: string }[]> {
  const pgs = await pg();
  if (!pgs) return recentPages(DEFAULT_DB, limit);
  const rows = await pgs.query(
    "SELECT url, title, status, meta, fetched_at FROM pages WHERE status = 200 ORDER BY fetched_at DESC LIMIT $1",
    [limit],
  );
  return rows.map((r) => ({
    url: String(r.url),
    title: String(r.title ?? ""),
    status: Number(r.status),
    meta: (r.meta ?? {}) as PageMeta,
    fetched_at: new Date(r.fetched_at as string).toISOString(),
  }));
}

export async function indexHasPagesIndex(): Promise<boolean> {
  const pgs = await pg();
  if (!pgs) return indexHasPages(DEFAULT_DB);
  const rows = await pgs.query("SELECT count(*)::int AS c FROM pages");
  return Number(rows[0]?.c ?? 0) > 0;
}

if (import.meta.main) {
  const arg = (name: string, def?: string) => {
    const i = Bun.argv.indexOf(`--${name}`);
    return i === -1 ? def : (Bun.argv[i + 1] ?? "true");
  };
  const options: CrawlOptions = {
    baseUrl: arg("base-url", DEFAULT_BASE),
    dbPath: arg("db", DEFAULT_DB),
    maxPages: Number(arg("max-pages", "5000")),
    delayMs: Number(arg("delay-ms", "250")),
    timeoutMs: Number(arg("timeout-ms", "10000")),
    cookie: arg("cookie"),
    fresh: Bun.argv.includes("--fresh"),
    push: Bun.argv.includes("--push"),
  };
  const started = Date.now();
  console.log(`crawling ${options.baseUrl} → ${options.dbPath}${options.push ? " (+postgres)" : ""}`);
  const result = await crawl(options);
  console.log(
    `done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${result.fetched} pages indexed, ` +
      `${result.skipped} robots-skipped, ${result.failed} failed`,
  );
  const db = await pg();
  await db?.end(); // release the pool so the process can exit
}
