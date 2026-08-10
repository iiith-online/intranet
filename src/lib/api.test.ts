import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiHandler } from "../api";

/**
 * Stub crawl: resolves immediately, never touches the real crawler or network.
 * Type-matched to `crawl`'s return shape.
 */
const stubCrawl = async () => ({ baseUrl: "http://x", dbPath: "x", fetched: 1, skipped: 0, failed: 0 });

// POST /api/scan gate-checks INTRANET_ALLOW_SCAN === "1" FIRST (api.ts), so it
// must be set for every scan test; restored afterwards so no case leaks into
// another (false confidence: without it every POST 403s as "scanning disabled").
beforeEach(() => {
  process.env.INTRANET_ALLOW_SCAN = "1";
});

afterEach(() => {
  delete process.env.INTRANET_ALLOW_SCAN;
  delete process.env.INTRANET_SCAN_TOKEN;
});

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("scan token gate", () => {
  test("missing header 403s with the token-specific body", async () => {
    process.env.INTRANET_SCAN_TOKEN = "testtoken";
    const handler = createApiHandler({ crawl: stubCrawl });

    const res = await handler(new Request("http://x/api/scan", { method: "POST" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invalid scan token" });
  });

  test("wrong token 403s with the same token-specific body", async () => {
    process.env.INTRANET_SCAN_TOKEN = "testtoken";
    const handler = createApiHandler({ crawl: stubCrawl });

    const res = await handler(
      new Request("http://x/api/scan", { method: "POST", headers: { "x-scan-token": "wrongtoken" } }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invalid scan token" });
  });

  test("correct token starts a scan with the stub crawl", async () => {
    process.env.INTRANET_SCAN_TOKEN = "testtoken";
    const handler = createApiHandler({ crawl: stubCrawl });

    const res = await handler(
      new Request("http://x/api/scan", { method: "POST", headers: { "x-scan-token": "testtoken" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true });

    // The stub crawl resolves asynchronously; wait a tick, then assert the
    // state it wrote is visible through GET.
    await tick();
    const get = await handler(new Request("http://x/api/scan"));
    const body = (await get.json()) as { running: boolean; last: { fetched: number } | null };
    expect(body.running).toBe(false);
    expect(body.last?.fetched).toBe(1);
  });

  test("tokenless deployment behaves as before (no header needed)", async () => {
    const handler = createApiHandler({ crawl: stubCrawl });

    const res = await handler(new Request("http://x/api/scan", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true });
  });
});

describe("scan GET", () => {
  test("reports enabled/running/last plus tokenRequired only when token set", async () => {
    process.env.INTRANET_SCAN_TOKEN = "testtoken";
    const handler = createApiHandler({ crawl: stubCrawl });

    const res = await handler(new Request("http://x/api/scan"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.running).toBe(false);
    expect(body.last).toBeNull();
    expect(body.tokenRequired).toBe(true);
  });

  test("no tokenRequired field when token unset (existing shape unchanged)", async () => {
    const handler = createApiHandler({ crawl: stubCrawl });

    const res = await handler(new Request("http://x/api/scan"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.running).toBe(false);
    expect(body.last).toBeNull();
    expect("tokenRequired" in body).toBe(false);
  });
});

describe("other routes", () => {
  test("unknown path 404s", async () => {
    const handler = createApiHandler({ crawl: stubCrawl });

    const res = await handler(new Request("http://x/api/nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("method not allowed on /api/scan", async () => {
    const handler = createApiHandler({ crawl: stubCrawl });

    const res = await handler(new Request("http://x/api/scan", { method: "PUT" }));
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "method not allowed" });
  });

  test("empty search query returns empty results with indexed status", async () => {
    const handler = createApiHandler({ crawl: stubCrawl });

    const res = await handler(new Request("http://x/api/search?q="));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { query: string; indexed: boolean; results: unknown[] };
    expect(body.query).toBe("");
    expect(typeof body.indexed).toBe("boolean");
    expect(body.results).toEqual([]);
  });
});
