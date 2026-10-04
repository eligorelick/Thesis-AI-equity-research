import { afterEach, describe, expect, it, vi } from "vitest";

import { createFmpClient, resetFmpPlanLimits, type CachedFetchFn, type FmpClientConfig } from "@/providers/fmp";
import { FMP_ACCESS_TTL_MS, parseFmpRestriction, resetFmpAccess } from "@/providers/fmpAccess";
import { makeLimiter } from "@/providers/http";

const ENDPOINT_DENIED = "Restricted Endpoint: This endpoint is not available under your current subscription. Please visit our subscription page to upgrade your plan.";
const SYMBOL_DENIED = "Premium Query Parameter: Special Endpoint : This value set for symbol is not available under your current subscription.";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function client(fetchImpl: typeof fetch, config: Partial<FmpClientConfig> = {}) {
  return createFmpClient({ apiKey: "access-test-key", fetchImpl, limiter: makeLimiter(10_000, 10_000), ...config });
}

afterEach(() => { resetFmpPlanLimits(); });

describe("FMP response-driven subscription access", () => {
  it("recognizes only explicit restrictions and gives symbol scope priority", () => {
    expect(parseFmpRestriction(ENDPOINT_DENIED)).toBe("endpoint");
    expect(parseFmpRestriction(SYMBOL_DENIED)).toBe("symbol");
    expect(parseFmpRestriction(`${ENDPOINT_DENIED} ${SYMBOL_DENIED}`)).toBe("symbol");
    expect(parseFmpRestriction("Premium Query Parameter: limit is too large")).toBeNull();
    expect(parseFmpRestriction("Invalid API key")).toBeNull();
    expect(parseFmpRestriction("Daily request limit reached")).toBeNull();
  });

  it("learns an endpoint restriction once across symbols, concurrent calls, and clients", async () => {
    const fetchImpl = vi.fn(async () => new Response(ENDPOINT_DENIED, { status: 402 }));
    const results = await Promise.all([
      client(fetchImpl).quote("SCHW"),
      client(fetchImpl).quote("AAPL"),
      client(fetchImpl).quote("SCHW"),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, gap: { expected: true, reason: expect.stringContaining("Restricted Endpoint") } });
      if (!result.ok) {
        expect(result.gap.reason).not.toContain("unparseable");
        expect(result.gap.reason).not.toContain("subscription page");
        expect(result.gap.reason).not.toContain("access-test-key");
      }
    }
  });

  it("cancels a waiting request promptly without releasing or aborting the owner probe", async () => {
    const response = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const ownerController = new AbortController();
    const waiterController = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      started.resolve();
      return response.promise;
    });
    const owner = client(fetchImpl, { signal: ownerController.signal }).quote("SCHW");
    await started.promise;
    try {
      const waiter = client(fetchImpl, { signal: waiterController.signal }).quote("AAPL");
      const canceled = new DOMException("Waiting report canceled", "AbortError");
      const rejected = expect(waiter).rejects.toBe(canceled);
      waiterController.abort(canceled);
      // The owner is still unresolved here: cancellation cannot wait for it.
      await rejected;
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

      // A third request must still wait on the original owner's gate.
      const survivor = client(fetchImpl).quote("MSFT");
      await Promise.resolve();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      response.resolve(new Response(ENDPOINT_DENIED, { status: 402 }));
      expect(await owner).toMatchObject({ ok: false, gap: { expected: true } });
      expect(await survivor).toMatchObject({ ok: false, gap: { expected: true } });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await client(fetchImpl).quote("AAPL")).toMatchObject({ ok: false, gap: { expected: true } });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      response.resolve(new Response(ENDPOINT_DENIED, { status: 402 }));
      await owner;
    }
  });

  it("keeps a symbol refusal separate from other symbols and endpoints", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const symbol = url.searchParams.get("symbol");
      return url.pathname.endsWith("/quote") && symbol === "SCHW"
        ? new Response(SYMBOL_DENIED, { status: 402 })
        : json([{ symbol, companyName: "Example issuer", price: 100 }]);
    });
    const c = client(fetchImpl);
    expect((await c.quote("SCHW")).ok).toBe(false);
    expect((await c.quote("AAPL")).ok).toBe(true);
    expect((await c.profile("SCHW")).ok).toBe(true);
    expect((await c.quote("SCHW")).ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not attribute a denied batch to every symbol in that batch", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.searchParams.get("symbols") === "AAPL,SCHW"
        ? new Response(SYMBOL_DENIED, { status: 402 })
        : json([{ symbol: "AAPL", price: 100 }]);
    });
    const c = client(fetchImpl);
    expect((await c.batchQuote(["AAPL", "SCHW"])).ok).toBe(false);
    expect((await c.batchQuote(["AAPL"])).ok).toBe(true);
    expect((await c.batchQuote(["AAPL", "SCHW"])).ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("isolates observations by key and provider base URL", async () => {
    const denied = vi.fn(async () => new Response(ENDPOINT_DENIED, { status: 402 }));
    const allowed = vi.fn(async () => json([{ symbol: "AAPL", price: 100 }]));
    await client(denied).quote("AAPL");
    expect((await client(allowed, { apiKey: "different-key" }).quote("AAPL")).ok).toBe(true);
    expect((await client(allowed, { baseUrl: "https://example.invalid/stable" }).quote("AAPL")).ok).toBe(true);
    expect(allowed).toHaveBeenCalledTimes(2);
  });

  it("rechecks after expiry or an explicit reset so subscription changes recover", async () => {
    let clock = Date.parse("2026-10-03T12:00:00Z");
    let denied = true;
    const fetchImpl = vi.fn(async () => denied
      ? new Response(ENDPOINT_DENIED, { status: 402 })
      : json([{ symbol: "AAPL", price: 100 }]));
    const c = client(fetchImpl, { now: () => new Date(clock) });
    await c.quote("AAPL");
    denied = false;
    clock += FMP_ACCESS_TTL_MS - 1;
    expect((await c.quote("AAPL")).ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 1;
    expect((await c.quote("AAPL")).ok).toBe(true);
    denied = true;
    await c.quote("AAPL");
    denied = false;
    resetFmpAccess();
    expect((await c.quote("AAPL")).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([200, 402, 403])("classifies an explicit JSON error message at HTTP %s", async (status) => {
    const fetchImpl = vi.fn(async () => json({ "Error Message": SYMBOL_DENIED }, status));
    const c = client(fetchImpl);
    expect(await c.quote("SCHW")).toMatchObject({ ok: false, gap: { expected: true } });
    await c.quote("SCHW");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 401, body: ENDPOINT_DENIED },
    { status: 402, body: "Premium Query Parameter: other parameter is unavailable" },
    { status: 403, body: "Invalid API key" },
    { status: 200, body: "malformed JSON" },
  ])("does not learn auth or ambiguous failures ($status)", async ({ status, body }) => {
    const fetchImpl = vi.fn(async () => new Response(body, { status }));
    const c = client(fetchImpl);
    const result = await c.quote("AAPL");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gap.expected).toBeUndefined();
    await c.quote("AAPL");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not skip successful cache hits after a live restriction was learned", async () => {
    const fetchImpl = vi.fn(async () => new Response(ENDPOINT_DENIED, { status: 402 }));
    await client(fetchImpl).quote("AAPL");
    const cachedFetch = vi.fn(async () => ({
      value: { body: [{ symbol: "AAPL", price: 100 }], status: 200, fetchedAt: "2026-10-01T12:00:00Z" },
      fetchedAt: "2026-10-01T12:00:00Z",
      stale: true,
    })) as unknown as CachedFetchFn;
    const result = await client(fetchImpl, { cachedFetch }).quote("AAPL");
    expect(result).toMatchObject({ ok: true, value: { stale: true, fetchedAt: "2026-10-01T12:00:00Z" } });
    expect(cachedFetch).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never admits a subscription rejection into the response cache", async () => {
    let stored = 0;
    const cachedFetch: CachedFetchFn = async (_key, _ttl, loader) => {
      const value = await loader();
      stored++;
      return { value };
    };
    const fetchImpl = vi.fn(async () => new Response(ENDPOINT_DENIED, { status: 402 }));
    const c = client(fetchImpl, { cachedFetch });
    await c.quote("AAPL");
    await c.quote("AAPL");
    expect(stored).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("pays one explicit refusal for multiple EOD windows and preserves expected disclosure", async () => {
    const fetchImpl = vi.fn(async () => new Response(SYMBOL_DENIED, { status: 402 }));
    const result = await client(fetchImpl).historicalPriceEodFull("SCHW", "2001-01-01", "2026-10-03");
    expect(result).toMatchObject({ ok: false, gap: { expected: true, reason: expect.stringContaining("FMP subscription") } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still retrieves cached recent EOD windows after an older window is restricted", async () => {
    const fetchImpl = vi.fn(async () => new Response(SYMBOL_DENIED, { status: 402 }));
    const cachedFetch: CachedFetchFn = async <T>(key: string, _ttl: number, loader: () => Promise<T>) => {
      if (key.includes("from=2021-01-01")) {
        return {
          value: { body: [{ symbol: "SCHW", date: "2025-12-31", close: 100 }], status: 200, fetchedAt: "2026-01-01T00:00:00Z" } as T,
          fetchedAt: "2026-01-01T00:00:00Z",
          stale: true,
        };
      }
      return { value: await loader() };
    };
    const result = await client(fetchImpl, { cachedFetch }).historicalPriceEodFull("SCHW", "2016-01-01", "2025-12-31");
    expect(result).toMatchObject({ ok: true, value: { stale: true, fetchedAt: "2026-01-01T00:00:00Z" } });
    if (result.ok) expect(result.value.endpoint).toContain("history truncated to 2021-01-01");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not present old cached prices as current when the newest EOD window is restricted", async () => {
    const fetchImpl = vi.fn(async () => new Response(ENDPOINT_DENIED, { status: 402 }));
    const cachedFetch: CachedFetchFn = async <T>(key: string, _ttl: number, loader: () => Promise<T>) => {
      if (key.includes("from=2016-01-01")) {
        return {
          value: { body: [{ symbol: "SCHW", date: "2020-12-31", close: 50 }], status: 200, fetchedAt: "2021-01-01T00:00:00Z" } as T,
        };
      }
      return { value: await loader() };
    };
    const result = await client(fetchImpl, { cachedFetch }).historicalPriceEodFull("SCHW", "2016-01-01", "2025-12-31");
    expect(result).toMatchObject({ ok: false, gap: { expected: true, reason: expect.stringContaining("newest chunk failed") } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
