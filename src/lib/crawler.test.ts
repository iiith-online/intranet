/**
 * Self-check for the crawler: runs it against a local fixture server and
 * verifies crawl coverage, robots handling, FTS search, and LIKE fallback.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crawl, recentPages, search } from "./crawler";
import { serveFixtures } from "../../testdata/fixtures";

let server: Server | null = null;
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

  // Content pages: /, /academic, /admissions, /restricted(403). /old redirects
  // to /academic (already seen) so only a 302 stub is recorded for it.
  // /private robots-blocked, external link dropped.
  expect(result.fetched).toBe(4);
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
    const statuses = Object.fromEntries(
      (db.query("SELECT url, status FROM pages").all() as { url: string; status: number }[]).map((r) => [
        r.url,
        r.status,
      ]),
    );
    expect(statuses[`${server!.url.href}restricted`]).toBe(403);
    expect(statuses[`${server!.url.href}old`]).toBe(302);
    expect(statuses[`${server!.url.href}academic`]).toBe(200); // not clobbered by the redirect stub
    const oldMeta = db.query("SELECT meta FROM pages WHERE url = ?").get(`${server!.url.href}old`) as {
      meta: string;
    };
    expect(oldMeta.meta).toContain("redirect: " + `${server!.url.href}academic`);
    const home = db
      .query("SELECT text FROM pages WHERE url = ?")
      .get(server!.url.href) as { text: string };
    expect(home.text).not.toContain("zzzsecretzzz"); // script content must not leak
    expect(home.text).toContain("campus life");
    expect(
      (db.query("SELECT title FROM pages WHERE url = ?").get(`${server!.url.href}admissions`) as { title: string })
        .title,
    ).toBe("Admissions 2026");
  } finally {
    db.close();
  }
});

test("FTS search ranks and snippets matches", async () => {
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
