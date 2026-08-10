/**
 * Sample intranet pages used by the crawler tests and the local smoke run.
 * Clearly fake data — the real index is only ever produced by `bun run crawl`.
 */

import type { Server } from "bun";

/** Minimal one-page PDF (Catalog → Pages → Page → Content stream + Type1 font).
 *  xref offsets are COMPUTED from the actual byte positions while the file is
 *  assembled — hand-typed offsets get rejected by pdf.js. ASCII-only bodies
 *  keep string length == byte length. */
export function buildMinimalPdf(text: string): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const content = `BT /F1 24 Tf 72 720 Td (${esc(text)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets[i] = pdf.length;
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  const entries = [`0000000000 65535 f \n`];
  for (const off of offsets) entries.push(`${String(off).padStart(10, "0")} 00000 n \n`);
  pdf += `xref\n0 ${objects.length + 1}\n${entries.join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return pdf;
}

export const FIXTURES: Record<string, { status: number; type: string; body: string }> = {
  "/": {
    status: 200,
    type: "text/html",
    body: `<!doctype html><html><head><title>IIIT Intranet</title><meta name="description" content="Campus portal home"><meta name="keywords" content="campus, portal"></head>
      <body><h1>Welcome</h1><p>Find everything about campus life.</p>
      <script>var zzz = "zzzsecretzzz";</script>
      <a href="/academic">Academic</a><a href="/admissions">Admissions</a>
      <a href="/restricted">Restricted</a>
      <a href="/private">Private</a><a href="/old">Old</a>
      <a href="/files/guide.pdf">Guide</a><a href="/files/broken.pdf">Broken</a><a href="/files/huge.pdf">Huge</a><a href="https://example.com/away">External</a></body></html>`,
  },
  "/academic": {
    status: 200,
    type: "text/html",
    body: `<html><head><title>Academic Affairs</title></head><body><p>Course registration opens every semester. Timetables and exams. Annual Fee Structure 2026.</p><a href="/">Home</a></body></html>`,
  },
  "/admissions": {
    status: 200,
    type: "text/html",
    body: `<html><head><title>Admissions 2026</title></head><body><p>Applications for the new session are open. Check eligibility.</p></body></html>`,
  },
  "/restricted": { status: 403, type: "text/plain", body: "forbidden" },
  "/private": { status: 200, type: "text/html", body: `<html><title>Secret</title><body>hidden content</body></html>` },
  "/old": { status: 302, type: "text/plain", body: "" },
  "/files/guide.pdf": {
    status: 200,
    type: "application/pdf",
    body: buildMinimalPdf("Annual Fee Structure 2026"),
  },
  "/files/broken.pdf": {
    status: 200,
    type: "application/pdf",
    body: "%PDF-1.4 this is not a real pdf \u0000\u0001 garbage bytes",
  },
  "/files/huge.pdf": {
    status: 200,
    type: "application/pdf",
    // Real 6 MB body: Bun's server recomputes content-length from the actual
    // bytes (a lying header gets overridden), and this must exceed the default
    // 5 MB cap so the crawler rejects it on the content-length fast path.
    body: "%PDF-1.4 " + "0".repeat(6 * 1024 * 1024 - 8),
  },
  "/robots.txt": { status: 200, type: "text/plain", body: "User-agent: *\nDisallow: /private\n" },
};

export function serveFixtures(options: { port?: number } = {}): Server<undefined> {
  return Bun.serve({
    port: options.port ?? 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const f = FIXTURES[path];
      if (!f) return new Response("not found", { status: 404 });
      if (f.status === 302) {
        return new Response("", { status: 302, headers: { location: "/academic" } });
      }
      // Huge route: real content-length exceeds the PDF cap; the crawler must
      // reject it on the fast path without reading the 6 MB body.
      const bodyBytes = new TextEncoder().encode(f.body);
      const contentLength = path === "/files/huge.pdf" ? 6 * 1024 * 1024 : bodyBytes.length;
      return new Response(f.body, {
        status: f.status,
        headers: {
          "content-type": f.type,
          "content-length": String(contentLength),
          "last-modified": "Mon, 04 Aug 2025 00:00:00 GMT",
        },
      });
    },
  });
}
