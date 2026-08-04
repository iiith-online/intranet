/**
 * Self-check for the crawler: runs it against a local fixture server and
 * verifies crawl coverage, robots handling, metadata capture, file handling,
 * FTS search, and LIKE fallback.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crawl, recentPages, search } from "./crawler";
import { FIXTURES, serveFixtures } from "../../testdata/fixtures";

let server: Server<undefined> | null = null;
let dbPath = "";

beforeAll(() => {
  server = serveFixtures();
  dbPath = join(tmpdir(), `iiit-crawl-test-${process.pid}.db`);
});

afterAll(async () => {
  server?.stop(true);
  // Windows: Bun defers the actual file release after Database.close(); the
  // timing is racy, so cleanup is best-effort (worst case: a temp file leaks).
  await Bun.sleep(500);
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      rmSync(f, { force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore EBUSY; tmpdir is cleaned by the OS eventually
    }
  }
});

test("crawl indexes reachable pages, respects robots, records errors and redirects", async () => {
  const result = await crawl({ baseUrl: server!.url.href, dbPath, maxPages: 100, delayMs: 0 });

  // Content pages: /, /academic, /admissions, /restricted(403) + the guide.pdf
  // file record. /old redirects to /academic (already seen) so only a 302 stub
  // is recorded for it. /private robots-blocked, external link dropped.
  expect(result.fetched).toBe(5);
  expect(result.skipped).toBe(1); // /private
  expect(result.failed).toBe(0);

  const pages = recentPages(dbPath, 100);
  const urls = pages.map((p) => p.url);
  expect(urls).toContain(server!.url.href);
  expect(urls).toContain(`${server!.url.href}academic`);
  expect(urls).toContain(`${server!.url.href}admissions`);
  expect(urls).not.toContain(`${server!.url.href}private`);
  expect(urls).not.toContain("https://example.com/away");

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT url, status, meta, text FROM pages").all() as {
      url: string;
      status: number;
      meta: string;
      text: string;
    }[];
    const byUrl = Object.fromEntries(rows.map((r) => [r.url, r]));
    const metaOf = (u: string) => JSON.parse(byUrl[u]!.meta);

    expect(byUrl[`${server!.url.href}restricted`]!.status).toBe(403);
    expect(metaOf(`${server!.url.href}restricted`).kind).toBe("error");

    const oldRow = byUrl[`${server!.url.href}old`]!;
    expect(oldRow.status).toBe(302);
    expect(metaOf(`${server!.url.href}old`).redirectTo).toBe(`${server!.url.href}academic`);
    expect(byUrl[`${server!.url.href}academic`]!.status).toBe(200); // not clobbered by the stub

    // Metadata capture: keywords meta tag + HTTP headers on the home page.
    const homeMeta = metaOf(server!.url.href);
    expect(homeMeta.kind).toBe("html");
    expect(homeMeta.keywords).toBe("campus, portal");
    expect(homeMeta.contentType).toContain("text/html");

    // Files: metadata only, no body content, size/type/last-modified recorded.
    const fileUrl = `${server!.url.href}files/guide.pdf`;
    const file = byUrl[fileUrl]!;
    const fileMeta = metaOf(fileUrl);
    expect(fileMeta.kind).toBe("file");
    expect(fileMeta.contentType).toBe("application/pdf");
    expect(fileMeta.contentLength).toBe(new TextEncoder().encode(FIXTURES["/files/guide.pdf"]!.body).length);
    expect(fileMeta.lastModified).toBeTruthy();
    expect(file.text).toBe("");

    const home = byUrl[server!.url.href]!;
    expect(home.text).not.toContain("zzzsecretzzz"); // script content must not leak
    expect(home.text).toContain("campus life");
    expect(JSON.parse(byUrl[`${server!.url.href}admissions`]!.meta)).toBeDefined();
  } finally {
    db.close();
  }
});

test("FTS search ranks, snippets, stems, and finds files by URL", async () => {
  const hits = search(dbPath, "registration");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.url).toContain("/academic");
  expect(hits[0]!.snippet).toContain("registration");

  const adm = search(dbPath, "applications");
  expect(adm.length).toBeGreaterThan(0);
  expect(adm[0]!.url).toContain("/admissions");

  // Porter stemming: "semesters" should match "semester" in the index
  const stemmed = search(dbPath, "semesters");
  expect(stemmed.some((h) => h.url.includes("/academic"))).toBe(true);

  // File URLs are searchable even though file bodies are not downloaded
  const byUrl = search(dbPath, "guide");
  expect(byUrl.some((h) => h.url.includes("/files/guide.pdf"))).toBe(true);

  // Content from <script> must not be findable
  expect(search(dbPath, "zzzsecretzzz")).toHaveLength(0);
});

test("garbage query falls back to LIKE without throwing", async () => {
  const hits = search(dbPath, '"-- OR 1=1');
  expect(Array.isArray(hits)).toBe(true);
});

test("search on missing db returns empty, not an error", () => {
  expect(search(join(tmpdir(), "does-not-exist.db"), "anything")).toHaveLength(0);
});
