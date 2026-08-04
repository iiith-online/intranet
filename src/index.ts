import { serve } from "bun";
import index from "./index.html";
import { crawl, indexExists, indexHasPages, recentPages, search, DEFAULT_DB } from "./lib/crawler";

// First boot without a usable index (missing or empty after an off-campus
// crawl): try to build one. Only works on the campus network (the intranet
// does not resolve off-campus); failures are non-fatal.
if (!indexHasPages()) {
  crawl()
    .then((r) => console.log(`initial crawl: ${r.fetched} pages indexed, ${r.failed} failed (${r.baseUrl})`))
    .catch((e) => console.error(`initial crawl failed: ${e}`));
}

const server = serve({
  routes: {
    // Serve index.html for all unmatched routes.
    "/*": index,

    "/api/search": async req => {
      const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
      return Response.json({
        query: q,
        indexed: indexExists(),
        results: q ? search(DEFAULT_DB, q) : [],
      });
    },

    "/api/pages": async () => Response.json({ pages: recentPages(DEFAULT_DB) }),
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
