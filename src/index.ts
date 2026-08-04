import { serve } from "bun";
import index from "./index.html";
import {
  crawl,
  indexHasPagesIndex,
  recentPagesIndex,
  searchIndex,
  DEFAULT_DB,
} from "./lib/crawler";
import type { SearchResult } from "./lib/crawler";

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

// Device-side scan: the server crawls the intranet (works when it runs on
// the campus network) and upserts everything into Postgres. Disabled on
// deployments that cannot reach the intranet (Vercel etc.) — opt in with
// INTRANET_ALLOW_SCAN=1. The crawl runs in the background; poll GET /api/scan.
let scanRunning = false;
let lastScan: { fetched: number; failed: number; error?: string } | null = null;

const server = serve({
  idleTimeout: 255, // max allowed; a scan runs in the background anyway
  routes: {
    // Serve index.html for all unmatched routes.
    "/*": index,

    "/api/search": async req => {
      const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
      let indexed = false;
      try {
        indexed = await indexHasPagesIndex();
      } catch {
        indexed = false;
      }
      let results: SearchResult[] = [];
      try {
        if (q) results = await searchIndex(q);
      } catch {
        results = [];
      }
      return Response.json({
        query: q,
        indexed,
        results,
      });
    },

    "/api/pages": async () => Response.json({ pages: await recentPagesIndex() }),

    "/api/scan": {
      async GET() {
        return Response.json({
          enabled: process.env.INTRANET_ALLOW_SCAN === "1",
          running: scanRunning,
          last: lastScan,
        });
      },
      async POST() {
        if (process.env.INTRANET_ALLOW_SCAN !== "1") {
          return Response.json({ error: "scanning disabled on this deployment" }, { status: 403 });
        }
        if (scanRunning) {
          return Response.json({ error: "a scan is already running" }, { status: 409 });
        }
        scanRunning = true;
        lastScan = null;
        crawl({ push: true, scanSource: "web" })
          .then((r) => {
            lastScan = { fetched: r.fetched, failed: r.failed };
          })
          .catch((e) => {
            lastScan = { fetched: 0, failed: 0, error: String(e) };
          })
          .finally(() => {
            scanRunning = false;
          });
        return Response.json({ started: true });
      },
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url} (db: ${DEFAULT_DB})`);
