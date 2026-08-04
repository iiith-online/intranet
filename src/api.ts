/**
 * Request handlers for the search UI + API. Shared by the local Bun server
 * (src/index.ts) and the Vercel function (api/index.ts) so both serve the
 * same behavior.
 */

import { browseIndexPg, crawl, indexHasPagesIndex, pageLinksIndex, searchIndex, timelineIndexPg } from "./lib/crawler";
import type { SearchResult } from "./lib/crawler";

let scanRunning = false;
let lastScan: { fetched: number; failed: number; error?: string } | null = null;

export async function handleApiRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/search") {
    const q = url.searchParams.get("q")?.trim() ?? "";
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
    return Response.json({ query: q, indexed, results });
  }

  if (path === "/api/browse") {
    return Response.json({ groups: await browseIndexPg() });
  }

  if (path === "/api/timeline") {
    return Response.json({ periods: await timelineIndexPg() });
  }

  if (path === "/api/links") {
    const target = url.searchParams.get("url");
    if (!target) return Response.json({ links: [] });
    return Response.json({ links: await pageLinksIndex(target) });
  }

  // Device-side scan: the server crawls the intranet (works when it runs on
  // the campus network) and upserts everything into Postgres. Disabled on
  // deployments that cannot reach the intranet (Vercel etc.) — opt in with
  // INTRANET_ALLOW_SCAN=1. The crawl runs in the background; poll GET /api/scan.
  if (path === "/api/scan") {
    if (req.method === "GET") {
      return Response.json({ enabled: process.env.INTRANET_ALLOW_SCAN === "1", running: scanRunning, last: lastScan });
    }
    if (req.method === "POST") {
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
    }
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
