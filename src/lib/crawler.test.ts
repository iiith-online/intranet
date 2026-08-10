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
import { buildFtsQuery, buildPgQuery, crawl, groupPages, groupTimeline, pageLinks, pgSearch, recentPages, search } from "./crawler";
import type { PageMeta } from "./crawler";
import { renderSnippet } from "../App";
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

  // Content pages: /, /academic, /admissions, /restricted(403) + guide.pdf,
  // broken.pdf and huge.pdf file records. /old redirects to /academic (already
  // seen) so only a 302 stub is recorded for it. /private robots-blocked,
  // external link dropped.
  expect(result.fetched).toBe(7);
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
    expect(homeMeta.headings).toContain("Welcome"); // h1 extracted

    // Files: PDF bodies are downloaded (≤ cap) and text-extracted; size/type
    // and last-modified are recorded alongside.
    const fileUrl = `${server!.url.href}files/guide.pdf`;
    const file = byUrl[fileUrl]!;
    const fileMeta = metaOf(fileUrl);
    expect(fileMeta.kind).toBe("file");
    expect(fileMeta.contentType).toBe("application/pdf");
    expect(fileMeta.contentLength).toBe(new TextEncoder().encode(FIXTURES["/files/guide.pdf"]!.body).length);
    expect(fileMeta.lastModified).toBeTruthy();
    expect(fileMeta.textExtracted).toBe(true);
    expect(file.text).toContain("Fee Structure");

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

test("PDF text extraction: guide.pdf body is indexed and searchable", async () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query("SELECT text, meta FROM pages WHERE url = ?")
      .get(`${server!.url.href}files/guide.pdf`) as { text: string; meta: string } | null;
    expect(row).not.toBeNull();
    expect(row!.text).toContain("Annual Fee Structure 2026");
    expect(JSON.parse(row!.meta).textExtracted).toBe(true);
  } finally {
    db.close();
  }
  // The phrase lives inside the PDF body, not in any HTML fixture link text.
  const hits = search(dbPath, "annual fee");
  expect(hits.some((h) => h.url.includes("/files/guide.pdf"))).toBe(true);
});

test("broken and oversized PDFs fall back to metadata-only without crashing", async () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query("SELECT url, text, meta FROM pages WHERE url LIKE '%/files/%'")
      .all() as { url: string; text: string; meta: string }[];
    const byUrl = Object.fromEntries(rows.map((r) => [r.url, r]));
    const broken = byUrl[`${server!.url.href}files/broken.pdf`]!;
    expect(broken).toBeDefined();
    expect(broken.text).toBe("");
    const brokenMeta = JSON.parse(broken.meta);
    expect(brokenMeta.kind).toBe("file");
    expect(brokenMeta.textExtracted).toBeUndefined(); // extraction failed → no flag
    const huge = byUrl[`${server!.url.href}files/huge.pdf`]!;
    expect(huge).toBeDefined();
    expect(huge.text).toBe(""); // content-length fast path: body never read
    expect(JSON.parse(huge.meta).contentLength).toBeGreaterThan(5 * 1024 * 1024);
    expect(JSON.parse(huge.meta).textExtracted).toBeUndefined();
  } finally {
    db.close();
  }
});

test("garbage query falls back to LIKE without throwing", async () => {
  const hits = search(dbPath, '"-- OR 1=1');
  expect(Array.isArray(hits)).toBe(true);
});

test("FTS snippet wraps the matched term in sentinel markers", () => {
  const hits = search(dbPath, "registration");
  expect(hits[0]!.url).toContain("/academic");
  expect(hits[0]!.snippet).toContain("\u0001registration\u0002");
});

test("pgSearch converts ts_headline <b> tags to sentinel markers", async () => {
  const fakeDb = {
    query: async () => [
      {
        url: "https://x/files/a.pdf",
        title: "A",
        meta: {},
        fetched_at: "2026-08-01T00:00:00Z",
        snip: "<b>term</b> in text",
      },
    ],
    end: async () => {},
  };
  const results = await pgSearch(fakeDb, "term");
  expect(results[0]!.snippet).toBe("\u0001term\u0002 in text");
});

test("renderSnippet escapes HTML before injecting <mark> (XSS-safe)", () => {
  const out = renderSnippet("<script>\u0001x\u0002</script>");
  expect(out).toContain("&lt;script&gt;");
  expect(out).not.toContain("<script>");
  expect(out).toContain(
    '<mark class="bg-yellow-200/60 text-inherit rounded px-0.5">x</mark>',
  );
});

test("renderSnippet converts sentinel markers to <mark> and escapes bare text", () => {
  expect(renderSnippet("a \u0001fee\u0002 b")).toBe(
    'a <mark class="bg-yellow-200/60 text-inherit rounded px-0.5">fee</mark> b',
  );
  expect(renderSnippet("a <b> b")).toBe("a &lt;b&gt; b");
});

test("buildFtsQuery builds per-term AND of prefixed terms", () => {
  expect(buildFtsQuery("fee struct")).toBe('"fee"* AND "struct"*');
  expect(buildFtsQuery("annual fee structure 2026")).toBe('"annual"* AND "fee"* AND "structure"* AND "2026"*');
});

test("buildFtsQuery keeps apostrophes and hyphens inside terms", () => {
  expect(buildFtsQuery("don't-stop")).toBe('"don\'t-stop"*');
  expect(buildFtsQuery("don't stop")).toBe('"don\'t"* AND "stop"*');
});

test("buildFtsQuery returns null for empty or whitespace-only input", () => {
  expect(buildFtsQuery("")).toBeNull();
  expect(buildFtsQuery("   ")).toBeNull();
});

test("buildFtsQuery wraps balanced quotes as a phrase, doubling internal quotes", () => {
  expect(buildFtsQuery('"academic affairs"')).toBe('"""academic affairs"""');
  expect(buildFtsQuery('say "hi" now')).toBe('"say ""hi"" now"');
});

test("buildFtsQuery returns null for unbalanced quotes", () => {
  expect(buildFtsQuery('"academic affairs')).toBeNull();
  expect(buildFtsQuery('fee "struct')).toBeNull();
});

test("buildPgQuery escapes apostrophes, strips operator chars, appends :*", () => {
  expect(buildPgQuery("don't")).toBe("don''t:*");
  expect(buildPgQuery("don't-stop")).toBe("don''t-stop:*");
  expect(buildPgQuery("fee & struct")).toBe("fee:* & struct:*");
  expect(buildPgQuery("a:b")).toBe("ab:*");
});

test("buildPgQuery returns null for empty input or when no terms survive", () => {
  expect(buildPgQuery("")).toBeNull();
  expect(buildPgQuery("   ")).toBeNull();
  expect(buildPgQuery("& | : *")).toBeNull();
});

test("buildPgQuery passes balanced quotes through as phrase, null for unbalanced", () => {
  expect(buildPgQuery('"academic affairs"')).toBe('"academic affairs"');
  expect(buildPgQuery('"academic affairs')).toBeNull();
});

test("multi-word prefix AND: 'fee struct' finds the /academic page", async () => {
  const hits = search(dbPath, "fee struct");
  expect(hits.some((h) => h.url.includes("/academic"))).toBe(true);
});

test("fully-quoted input still phrase-matches", async () => {
  const hits = search(dbPath, '"academic affairs"');
  expect(hits.some((h) => h.url.includes("/academic"))).toBe(true);
});

test("search on missing db returns empty, not an error", () => {
  expect(search(join(tmpdir(), "does-not-exist.db"), "anything")).toHaveLength(0);
});

test("groupPages categorizes offices, quick links, files by topic", () => {
  const m = {} as PageMeta;
  const rows = [
    { url: "https://x/offices/default/offices_x?office=Library+Office", status: 200, title: "IIIT-H Offices", meta: m },
    { url: "https://x/offices/default/offices_x?office=Admissions+Office", status: 200, title: "IIIT-H Offices", meta: m },
    { url: "https://x/offices/static/files/UG-PG-TuitionFee-18-19.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/List-of-Holidays-2026.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/Form-for-Leave.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/random-thing.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/default/telephone_directory", status: 200, title: "", meta: m },
    { url: "https://x/offices/default/old_events", status: 200, title: "", meta: m },
    { url: "https://x/offices/dead-link", status: 404, title: "", meta: m },
    { url: "https://x/other/secret-stuff", status: 200, title: "", meta: m },
  ];
  const groups = groupPages(rows);
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));

  expect(byId.offices?.items.map((i) => i.title)).toEqual(["Admissions Office", "Library Office"]);
  expect(byId["quick-links"]?.items.map((i) => i.title)).toEqual(["Old Events", "Telephone Directory"]);
  expect(byId.fees?.items[0]?.title).toBe("UG-PG-TuitionFee-18-19.pdf");
  expect(byId.holidays?.items[0]?.title).toBe("List-of-Holidays-2026.pdf");
  expect(byId.forms?.items[0]?.title).toBe("Form-for-Leave.pdf"); // "Form" word boundary, not "information"
  expect(byId["files-other"]?.items[0]?.title).toBe("random-thing.pdf");
  expect(byId.misc?.items[0]?.title).toBe("Secret Stuff");
  expect(byId.offices?.items.some((i) => i.url.includes("dead-link"))).toBe(false); // 404s excluded
});

test("groupPages collapses document versions into one entry", () => {
  const m = {} as PageMeta;
  const rows = [
    { url: "https://x/offices/static/files/UG1-Timetable-V1.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/UG1-Timetable-V2.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/UG1-Timetable-V3.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/List_of_Holidays_2017_revised.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/List of Holidays - Year 2026.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/UG1-T3-Tut-Lab-Schedule.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/UG1-Tut-Schedule-S19-V1.pdf", status: 200, title: "", meta: m },
  ];
  const groups = groupPages(rows);
  const timetables = groups.find((g) => g.id === "timetables")!;

  const tt = timetables.items.find((i) => i.title.includes("Timetable"));
  expect(tt?.versions?.length).toBe(3); // V1 + V2 + V3 collapsed
  expect(tt?.versions?.map((v) => v.title)).toEqual([
    "UG1-Timetable-V1.pdf",
    "UG1-Timetable-V2.pdf",
    "UG1-Timetable-V3.pdf",
  ]);

  const holidays = groups.find((g) => g.id === "holidays")!;
  expect(holidays.items).toHaveLength(1); // year + "revised" markers stripped
  expect(holidays.items[0]?.versions?.length).toBe(2);

  // Different documents must NOT merge.
  const tutLab = timetables.items.find((i) => i.title.includes("Tut-Lab"));
  expect(tutLab).toBeDefined();
  const s19 = timetables.items.find((i) => i.title.includes("S19"));
  expect(s19).toBeDefined();
  expect(timetables.items).toHaveLength(3);
});

test("groupPages collapses batch-coded and date-stamped documents", () => {
  const m = {} as PageMeta;
  const rows = [
    { url: "https://x/offices/static/files/UG1-Timetable-V1.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/UG1_M24-Timetable-V3.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/Almanac_2025-26.docx", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/Almanac_M25_Final-Ver2.1.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/Almanac_S25-Final.pdf", status: 200, title: "", meta: m },
    { url: "https://x/offices/static/files/Non-UG1_Courses_Lecture_Timetable_M24-V7.pdf", status: 200, title: "", meta: m },
  ];
  const groups = groupPages(rows);
  const timetables = groups.find((g) => g.id === "timetables")!;

  const tt = timetables.items.find((i) => i.title.includes("Timetable") && !i.title.includes("Lecture"));
  expect(tt?.versions?.length).toBe(2); // V1 + M24 batch variant
  const almanac = timetables.items.find((i) => i.title.includes("Almanac"));
  expect(almanac?.versions?.length).toBe(3); // year range + batch codes + Final-Ver2.1
  expect(almanac?.title).toBe("Almanac");
  const nonUg1 = timetables.items.find((i) => i.title.includes("Non-UG1"));
  expect(nonUg1?.versions).toBeUndefined(); // a genuinely different document
});

test("groupTimeline orders entries by month of last-modified, newest first", () => {
  const mk = (url: string, lm: string | undefined, status = 200) => ({
    url,
    status,
    title: "",
    meta: { kind: "file", lastModified: lm } as PageMeta,
  });
  const rows = [
    mk("https://x/files/b.pdf", "2026-08-03T07:45:21Z"),
    mk("https://x/files/a.pdf", "2026-08-01T10:00:00Z"),
    mk("https://x/files/c.pdf", "2026-07-15T00:00:00Z"),
    mk("https://x/files/no-date.pdf", undefined),
    mk("https://x/files/bad.pdf", "not-a-date"),
    mk("https://x/files/dead.pdf", "2026-08-02T00:00:00Z", 404),
  ];
  const periods = groupTimeline(rows);

  expect(periods.map((p) => p.id)).toEqual(["2026-08", "2026-07"]);
  expect(periods[0]!.label).toBe("August 2026");
  expect(periods[0]!.items.map((i) => i.title)).toEqual(["b.pdf", "a.pdf"]); // date desc within month
  expect(periods[1]!.items).toHaveLength(1);
  const all = periods.flatMap((p) => p.items);
  expect(all.some((i) => i.url.includes("no-date"))).toBe(false); // no timestamp → excluded
  expect(all.some((i) => i.url.includes("bad"))).toBe(false); // unparseable → excluded
  expect(all.some((i) => i.url.includes("dead"))).toBe(false); // 404 → excluded
});

test("pageLinks resolves a page's stored links to indexed titles", async () => {
  await crawl({ baseUrl: server!.url.href, dbPath, maxPages: 100, delayMs: 0 });
  const links = pageLinks(dbPath, server!.url.href);

  expect(links.some((l) => l.url.includes("/academic"))).toBe(true);
  expect(links.some((l) => l.url.includes("/admissions"))).toBe(true);
  expect(links.find((l) => l.url.includes("/academic"))?.title).toBe("Academic Affairs");
  expect(links.find((l) => l.url.includes("example.com"))).toBeUndefined(); // external links not stored
  expect(pageLinks(dbPath, `${server!.url.href}does-not-exist`)).toHaveLength(0);
});
