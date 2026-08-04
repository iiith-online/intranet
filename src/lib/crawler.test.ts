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
import { crawl, groupPages, groupTimeline, recentPages, search } from "./crawler";
import type { PageMeta } from "./crawler";
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
    expect(homeMeta.headings).toContain("Welcome"); // h1 extracted

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

test("groupPages categorizes offices, files by topic, and quick links", () => {
  const m = {} as PageMeta;
  const rows = [
    { url: "https://x/offices/default/offices_x?office=Library+Office", status: 200, title: "IIIT-H Offices", meta: m, text: "Library hours: 9am-9pm" },
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
  expect(byId.offices?.items.find((i) => i.title === "Library Office")?.text).toContain("Library hours");
  expect(byId.fees?.items[0]?.text).toBeUndefined(); // files carry no text
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
