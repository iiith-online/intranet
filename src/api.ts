/**
 * Request handlers for the search UI + API. Shared by the local Bun server
 * (src/index.ts) and the Vercel function (api/index.ts) so both serve the
 * same behavior.
 */

import { browseIndexPg, crawl, indexHasPagesIndex, pageLinksIndex, searchIndex, timelineIndexPg } from "./lib/crawler";
import type { SearchResult } from "./lib/crawler";

type CrawlFn = typeof crawl;
type ScanStatus = { fetched: number; failed: number; error?: string };

/**
 * Constant-time token comparison: both sides are hashed to fixed-length
 * (64-char) sha256 hex first, then compared as equal-length strings — never
 * timingSafeEqual on the raw secrets themselves.
 */
function tokenMatches(header: string | null): boolean {
  const expected = process.env.INTRANET_SCAN_TOKEN;
  if (!expected) return true;
  if (!header) return false;
  const actual = new Bun.CryptoHasher("sha256").update(header).digest("hex");
  const want = new Bun.CryptoHasher("sha256").update(expected).digest("hex");
  return actual === want;
}

/**
 * Factory so tests can inject a stub crawl and get isolated scan state.
 * `handleApiRequest` (exported below) is the default instance used by
 * src/index.ts and api/index.ts — its behavior is unchanged.
 */
export function createApiHandler(deps: { crawl?: CrawlFn } = {}): (req: Request) => Promise<Response> {
  const doCrawl = deps.crawl ?? crawl;
  let scanRunning = false;
  let lastScan: ScanStatus | null = null;

  return async function handleApiRequest(req: Request): Promise<Response> {
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
        return Response.json({
          enabled: process.env.INTRANET_ALLOW_SCAN === "1",
          running: scanRunning,
          last: lastScan,
          ...(process.env.INTRANET_SCAN_TOKEN ? { tokenRequired: true } : {}),
        });
      }
      if (req.method === "POST") {
        if (process.env.INTRANET_ALLOW_SCAN !== "1") {
          return Response.json({ error: "scanning disabled on this deployment" }, { status: 403 });
        }
        if (!tokenMatches(req.headers.get("x-scan-token"))) {
          return Response.json({ error: "invalid scan token" }, { status: 403 });
        }
        if (scanRunning) {
          return Response.json({ error: "a scan is already running" }, { status: 409 });
        }
        scanRunning = true;
        lastScan = null;
        doCrawl({ push: true, scanSource: "web" })
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
  };
}

export const handleApiRequest = createApiHandler();
