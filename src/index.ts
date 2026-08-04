import { serve } from "bun";
import index from "./index.html";
import { handleApiRequest } from "./api";
import { crawl, indexHasPagesIndex, DEFAULT_DB } from "./lib/crawler";

// First boot without a usable index (missing or empty after an off-campus
// crawl): try to build one. Only works on the campus network (the intranet
// does not resolve off-campus); failures are non-fatal.
try {
  if (!(await indexHasPagesIndex())) {
    crawl({ push: !!process.env.DATABASE_URL })
      .then((r) => console.log(`initial crawl: ${r.fetched} pages indexed, ${r.failed} failed (${r.baseUrl})`))
      .catch((e) => console.error(`initial crawl failed: ${e}`));
  }
} catch (e) {
  console.error(`index check failed (${e}); continuing without auto-crawl`);
}

const server = serve({
  idleTimeout: 255, // max allowed; a scan runs in the background anyway
  routes: {
    // Serve index.html for all unmatched routes.
    "/*": index,

    "/api/*": async req => handleApiRequest(req),
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url} (db: ${DEFAULT_DB})`);
