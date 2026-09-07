/**
 * FMP subscription-aware `limit` handling.
 *
 * Lower FMP tiers reject any statement-family request whose `limit` exceeds
 * the plan's cap with an HTTP 402 text body such as:
 *   Premium Query Parameter: 'Special Parameters : The values for 'limit' must
 *   be between 0 and 5 based on your current subscription. ...
 * The client used to surface that as an opaque "unparseable body" gap, so a
 * key that could serve five fiscal years served none and every downstream
 * metric collapsed. It now reads the cap from the provider's own message,
 * retries once within it, remembers the cap for the key, and discloses the
 * truncation on the payload so the bundle can record it.
 */
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import {
  createFmpClient,
  parseFmpLimitCap,
  resetFmpPlanLimits,
  type CachedFetchFn,
} from "@/providers/fmp";
import { makeLimiter } from "@/providers/http";

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "fmp");
const CAP_MESSAGE =
  "Premium Query Parameter: 'Special Parameters : The values for 'limit' must be between 0 and 5 based on your current subscription. Please visit our subscription page to upgrade your plan at https://financialmodelingprep.com/";

function statementRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: "AAPL",
    date: `${2025 - i}-09-30`,
    period: "FY",
    revenue: 100 + i,
  }));
}

/** Fake fetch that enforces a `limit` cap the way FMP's lower tiers do. */
function cappedFetch(cap: number): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    const limit = Number(new URL(url).searchParams.get("limit") ?? "0");
    if (limit > cap) {
      return new Response(CAP_MESSAGE, { status: 402, headers: { "content-type": "text/plain" } });
    }
    return new Response(JSON.stringify(statementRows(Math.min(limit, cap))), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, urls };
}

function client(fetchImpl: typeof fetch, apiKey = "plan-limit-test-key", cachedFetch?: CachedFetchFn) {
  return createFmpClient({
    apiKey,
    fixturesDir: FIXTURES_DIR,
    fetchImpl,
    limiter: makeLimiter(1000, 1000),
    ...(cachedFetch ? { cachedFetch } : {}),
  });
}

afterEach(() => {
  resetFmpPlanLimits();
});

describe("parseFmpLimitCap", () => {
  it("reads the cap out of FMP's premium-parameter rejection", () => {
    expect(parseFmpLimitCap(CAP_MESSAGE)).toBe(5);
    expect(parseFmpLimitCap("The values for 'limit' must be between 0 and 30 based on")).toBe(30);
  });

  it("returns null for every other body", () => {
    expect(parseFmpLimitCap("Restricted Endpoint: This endpoint is not available under your current subscription")).toBeNull();
    expect(parseFmpLimitCap("")).toBeNull();
    expect(parseFmpLimitCap("[]")).toBeNull();
    expect(parseFmpLimitCap("The values for 'limit' must be between 0 and x")).toBeNull();
  });
});

describe("FMP plan limit cap", () => {
  it("retries within the subscription cap and discloses the truncation on the payload", async () => {
    const { fetch, urls } = cappedFetch(5);
    const result = await client(fetch).incomeStatement("AAPL", "annual", 10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.rows).toHaveLength(5);
    expect(result.value.data.planLimit).toEqual({ requested: 10, applied: 5 });
    expect(result.value.endpoint).toContain("limit=5");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("limit=10");
    expect(urls[1]).toContain("limit=5");
  });

  it("clamps every later request for the same key proactively, across client instances", async () => {
    const first = cappedFetch(5);
    await client(first.fetch).incomeStatement("AAPL", "annual", 10);

    const second = cappedFetch(5);
    const result = await client(second.fetch).cashFlow("AAPL", "quarter", 24);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.planLimit).toEqual({ requested: 24, applied: 5 });
    expect(second.urls).toHaveLength(1);
    expect(second.urls[0]).toContain("limit=5");
  });

  it("keys the cap by API key so another key is not clamped", async () => {
    const first = cappedFetch(5);
    await client(first.fetch, "key-a").incomeStatement("AAPL", "annual", 10);

    const second = cappedFetch(100);
    const result = await client(second.fetch, "key-b").incomeStatement("AAPL", "annual", 10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.planLimit).toBeUndefined();
    expect(result.value.data.rows).toHaveLength(10);
    expect(second.urls[0]).toContain("limit=10");
  });

  it("keeps the gate after a within-cap first request: a later over-cap wave pays exactly one refusal (audit 2026-09-06, F223/F227)", async () => {
    // The old probe recorded "no cap on this key" after ANY successful first
    // request, so a wave of larger limits then paid one 402 per call.
    const { fetch, urls } = cappedFetch(5);
    const c = client(fetch);
    const within = await c.incomeStatement("AAPL", "annual", 5);
    expect(within.ok).toBe(true);
    expect(urls).toHaveLength(1);

    const wave = await Promise.all([
      c.incomeStatement("AAPL", "quarter", 10),
      c.cashFlow("AAPL", "annual", 10),
      c.balanceSheet("AAPL", "annual", 10),
    ]);
    expect(wave.every((result) => result.ok)).toBe(true);
    const refused = urls.filter((url) => Number(new URL(url).searchParams.get("limit")) > 5);
    expect(refused).toHaveLength(1);
    expect(urls).toHaveLength(1 + 1 + 3);
  });

  it("does not take a cache hit as proof of the key's cap", async () => {
    // A probe answered from the durable cache never asked the vendor; the
    // next over-cap wave still probes once instead of paying one refusal each.
    const cached = (async () => ({
      value: { body: statementRows(10), status: 200, fetchedAt: "2026-09-06T00:00:00.000Z" },
      fetchedAt: "2026-09-06T00:00:00.000Z",
    })) as unknown as CachedFetchFn;
    const primed = cappedFetch(5);
    const fromCache = await client(primed.fetch, "cache-key", cached).incomeStatement("AAPL", "annual", 10);
    expect(fromCache.ok).toBe(true);
    expect(primed.urls).toHaveLength(0);

    const live = cappedFetch(5);
    const c = client(live.fetch, "cache-key");
    const wave = await Promise.all([
      c.incomeStatement("AAPL", "quarter", 10),
      c.cashFlow("AAPL", "annual", 10),
    ]);
    expect(wave.every((result) => result.ok)).toBe(true);
    const refused = live.urls.filter((url) => Number(new URL(url).searchParams.get("limit")) > 5);
    expect(refused).toHaveLength(1);
  });

  it("leaves requests already within the cap untouched", async () => {
    const { fetch, urls } = cappedFetch(5);
    const result = await client(fetch).incomeStatement("AAPL", "annual", 5);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.planLimit).toBeUndefined();
    expect(urls).toHaveLength(1);
  });

  it("does not loop when the provider rejects even the clamped limit", async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return new Response(CAP_MESSAGE, { status: 402, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    const result = await client(impl).incomeStatement("AAPL", "annual", 10);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.gap.reason).toContain("HTTP 402");
    expect(calls).toBe(2);
  });

  it("treats other 402 rejections as ordinary disclosed gaps without a retry", async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return new Response(
        "Restricted Endpoint: This endpoint is not available under your current subscription",
        { status: 402, headers: { "content-type": "text/plain" } },
      );
    }) as unknown as typeof fetch;
    const result = await client(impl).insiderTradingSearch("AAPL");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.gap.reason).toContain("Restricted Endpoint");
    expect(calls).toBe(1);
  });

  it("caches the clamped request under the limit actually sent", async () => {
    const keys: string[] = [];
    const cachedFetch: CachedFetchFn = async (key, _ttl, loader) => {
      keys.push(key);
      return { value: await loader() };
    };
    const { fetch } = cappedFetch(5);
    const result = await client(fetch, "plan-limit-test-key", cachedFetch).incomeStatement("AAPL", "annual", 10);

    expect(result.ok).toBe(true);
    expect(keys.at(-1)).toContain("limit=5");
    expect(keys.at(-1)).not.toContain("limit=10");
  });
});
