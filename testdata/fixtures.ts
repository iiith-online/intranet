/**
 * Sample intranet pages used by the crawler tests and the local smoke run.
 * Clearly fake data — the real index is only ever produced by `bun run crawl`.
 */

import type { Server } from "bun";

export const FIXTURES: Record<string, { status: number; type: string; body: string }> = {
  "/": {
    status: 200,
    type: "text/html",
    body: `<!doctype html><html><head><title>IIIT Intranet</title><meta name="description" content="Campus portal home"></head>
      <body><h1>Welcome</h1><p>Find everything about campus life.</p>
      <script>var zzz = "zzzsecretzzz";</script>
      <a href="/academic">Academic</a><a href="/admissions">Admissions</a>
      <a href="/restricted">Restricted</a>
      <a href="/private">Private</a><a href="/old">Old</a><a href="https://example.com/away">External</a></body></html>`,
  },
  "/academic": {
    status: 200,
    type: "text/html",
    body: `<html><head><title>Academic Affairs</title></head><body><p>Course registration opens every semester. Timetables and exams.</p><a href="/">Home</a></body></html>`,
  },
  "/admissions": {
    status: 200,
    type: "text/html",
    body: `<html><head><title>Admissions 2026</title></head><body><p>Applications for the new session are open. Check eligibility.</p></body></html>`,
  },
  "/restricted": { status: 403, type: "text/plain", body: "forbidden" },
  "/private": { status: 200, type: "text/html", body: `<html><title>Secret</title><body>hidden content</body></html>` },
  "/old": { status: 302, type: "text/plain", body: "" },
  "/robots.txt": { status: 200, type: "text/plain", body: "User-agent: *\nDisallow: /private\n" },
};

export function serveFixtures(options: { port?: number } = {}): Server {
  return Bun.serve({
    port: options.port ?? 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const f = FIXTURES[path];
      if (!f) return new Response("not found", { status: 404 });
      if (f.status === 302) {
        return new Response("", { status: 302, headers: { location: "/academic" } });
      }
      return new Response(f.body, { status: f.status, headers: { "content-type": f.type } });
    },
  });
}
