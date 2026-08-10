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
      <a href="/files/guide.pdf">Guide</a><a href="/files/broken.pdf">Broken</a><a href="/files/huge.pdf">Huge</a><a href="/files/big.html">Big</a><a href="https://example.com/away">External</a></body></html>`,
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
  "/files/big.html": {
    status: 200,
    type: "text/html",
    // 3 MB HTML body served WITHOUT content-length below (chunked transfer) —
    // the crawler's streamed reader must enforce the 2 MB HTML cap itself.
    body: "<html><body>" + "0".repeat(3 * 1024 * 1024) + "</body></html>",
  },
  "/robots.txt": { status: 200, type: "text/plain", body: "User-agent: *\nDisallow: /private\n" },
};

/** Fixture server with a switchable variant. One instance keeps the same
 *  port/origin across variant flips — a second server on the same port is
 *  racy on Windows (stop/rebind can silently land on a new port). */
export type FixtureServer = Server<undefined> & {
  setVariant(v: "removed-academic" | null): void;
};

export function serveFixtures(options: { port?: number; variant?: "removed-academic" } = {}): FixtureServer {
  const state: { variant: "removed-academic" | null } = { variant: options.variant ?? null };
  const server = Bun.serve({
    port: options.port ?? 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (state.variant === "removed-academic") {
        if (path === "/academic") return new Response("gone", { status: 404 });
        // Hanging route: the promise never settles; only the crawler's
        // AbortSignal.timeout ends this request.
        if (path === "/admissions") return new Promise<Response>(() => {});
      }
      const f = FIXTURES[path];
      if (!f) return new Response("not found", { status: 404 });
      if (f.status === 302) {
        const location = state.variant === "removed-academic" ? "/admissions" : "/academic";
        return new Response("", { status: 302, headers: { location } });
      }
      // Conditional GET: every 200 route carries last-modified; when the
      // client echoes it back with a date >= ours, answer 304 with no body
      // (variant-agnostic — applies to all routes alike). Exception: the
      // variant's "/" genuinely changed (the /academic link was removed), so
      // its last-modified is bumped — a stale IMS must not 304 it, otherwise
      // crawl 2 could not discover the variant's link graph.
      const lastModified = (p: string) =>
        state.variant === "removed-academic" && p === "/"
          ? "Tue, 05 Aug 2025 00:00:00 GMT"
          : "Mon, 04 Aug 2025 00:00:00 GMT";
      if (f.status === 200) {
        const ims = req.headers.get("if-modified-since");
        if (ims) {
          const imsDate = new Date(ims).getTime();
          const lmDate = new Date(lastModified(path)).getTime();
          if (Number.isFinite(imsDate) && imsDate >= lmDate) {
            return new Response(null, { status: 304, headers: { "last-modified": lastModified(path) } });
          }
        }
      }
      if (path === "/files/big.html") {
        // Chunked: no content-length header (Bun auto-chunks ReadableStream
        // bodies but sets content-length for a plain string body).
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(f.body));
            c.close();
          },
        });
        return new Response(stream, {
          status: f.status,
          headers: {
            "content-type": f.type,
            "last-modified": lastModified(path),
          },
        });
      }
      const body = state.variant === "removed-academic" && path === "/" ? FIXTURES["/"]!.body.replace('<a href="/academic">Academic</a>', "") : f.body;
      // Huge route: real content-length exceeds the PDF cap; the crawler must
      // reject it on the fast path without reading the 6 MB body.
      const bodyBytes = new TextEncoder().encode(body);
      const contentLength = path === "/files/huge.pdf" ? 6 * 1024 * 1024 : bodyBytes.length;
      return new Response(body, {
        status: f.status,
        headers: {
          "content-type": f.type,
          "content-length": String(contentLength),
          "last-modified": "Mon, 04 Aug 2025 00:00:00 GMT",
        },
      });
    },
  });
  return Object.assign(server, {
    setVariant(v: "removed-academic" | null) {
      state.variant = v;
    },
  });
}
