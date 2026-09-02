import { describe, expect, it } from "vitest";

import { getProviderLimiter, makeLimiter, setProviderLimiter } from "@/providers/http";
import type { CachedFetchFn } from "@/providers/fmp";
import {
  createYahooClient,
  yahooSymbol,
  YAHOO_DEFAULT_USER_AGENT,
  YAHOO_TTLS,
} from "@/providers/yahoo";

/**
 * Yahoo's chart endpoint is the keyless price source. These tests pin the three
 * things the rest of the pipeline depends on: FMP-shaped rows, exchange-local
 * session dates, and every failure degrading to a disclosed gap (never a throw
 * and never a zero-filled bar).
 */

/** A chart payload the way Yahoo serves it: session-open timestamps, exchange offset, null bars possible. */
function chart(
  overrides: Partial<{
    symbol: string;
    bars: number;
    nullAt: number[];
    error: { code: string; description: string } | null;
    gmtoffset: number;
  }> = {},
) {
  const symbol = overrides.symbol ?? "AAPL";
  const bars = overrides.bars ?? 5;
  const nullAt = new Set(overrides.nullAt ?? []);
  const gmtoffset = overrides.gmtoffset ?? -14400;
  const start = Date.UTC(2026, 7, 24, 13, 30) / 1000; // 2026-08-24 09:30 New York
  const timestamp: number[] = [];
  const open: (number | null)[] = [];
  const high: (number | null)[] = [];
  const low: (number | null)[] = [];
  const close: (number | null)[] = [];
  const volume: (number | null)[] = [];
  const adjclose: (number | null)[] = [];
  for (let i = 0; i < bars; i++) {
    timestamp.push(start + i * 86400);
    const isNull = nullAt.has(i);
    open.push(isNull ? null : 100 + i);
    high.push(isNull ? null : 101 + i);
    low.push(isNull ? null : 99 + i);
    close.push(isNull ? null : 100.5 + i);
    volume.push(isNull ? null : 1000 + i);
    adjclose.push(isNull ? null : 100.4 + i);
  }
  return {
    chart: {
      result: overrides.error
        ? null
        : [
            {
              meta: {
                currency: "USD",
                symbol,
                exchangeName: "NMS",
                fullExchangeName: "NasdaqGS",
                instrumentType: "EQUITY",
                firstTradeDate: 345479400,
                regularMarketTime: start + (bars - 1) * 86400 + 23400,
                gmtoffset,
                regularMarketPrice: 100.5 + bars - 1,
                regularMarketDayHigh: 101 + bars - 1,
                regularMarketDayLow: 99 + bars - 1,
                regularMarketVolume: 1000 + bars - 1,
                fiftyTwoWeekHigh: 130,
                fiftyTwoWeekLow: 80,
                chartPreviousClose: 99.5,
                longName: "Apple Inc.",
                shortName: "Apple Inc.",
              },
              timestamp,
              indicators: { quote: [{ open, high, low, close, volume }], adjclose: [{ adjclose }] },
            },
          ],
      error: overrides.error ?? null,
    },
  };
}

/** The mutable view of a chart's meta, for tests that blank individual fields. */
function metaOf(body: ReturnType<typeof chart>): Record<string, unknown> {
  return body.chart.result![0]!.meta as unknown as Record<string, unknown>;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    calls.push({ url, headers });
    const { status, body } = handler(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A transport that never answers — the network-failure path, not an HTTP status. */
function rejectingFetch(message: string) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new TypeError(message);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(fetchImpl: typeof fetch, cachedFetch?: CachedFetchFn) {
  return createYahooClient({
    fetchImpl,
    limiter: makeLimiter(1000, 1000),
    now: () => new Date("2026-09-01T00:00:00Z"),
    ...(cachedFetch ? { cachedFetch } : {}),
  });
}

describe("yahooSymbol", () => {
  it("uppercases and maps FMP class separators to Yahoo's", () => {
    expect(yahooSymbol("brk.b")).toBe("BRK-B");
    expect(yahooSymbol("AAPL")).toBe("AAPL");
    expect(yahooSymbol(" spy ")).toBe("SPY");
  });
});

describe("YahooClient.dailyHistory", () => {
  it("returns FMP-shaped bars newest first, dated in the exchange's calendar, split-adjusted close", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: chart({ bars: 5 }) }));
    const res = await client(impl).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rows = res.value.data.rows;
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      symbol: "AAPL",
      date: "2026-08-28",
      open: 104,
      high: 105,
      low: 103,
      close: 104.5,
      volume: 1004,
      adjClose: 104.4,
    });
    expect(rows[4]!.date).toBe("2026-08-24");
    expect(res.value.data.raw).toBeNull();
    expect(res.value.source).toBe("yahoo");
    expect(res.value.endpoint).toBe(
      "/v8/finance/chart/AAPL?interval=1d&period1=2026-08-20&period2=2026-09-01",
    );
    expect(res.value.asOf).toBe("2026-08-28");
    expect(res.value.fetchedAt).toBe("2026-09-01T00:00:00.000Z");
    // The request itself: epoch bounds, an exclusive period2, a User-Agent, one call.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/AAPL\?/);
    expect(calls[0]!.url).toContain("interval=1d");
    expect(calls[0]!.url).toContain("period1=1787184000"); // 2026-08-20T00:00:00Z
    expect(calls[0]!.url).toContain("period2=1788307200"); // 2026-09-02T00:00:00Z (to + 1d, exclusive)
    expect(calls[0]!.url).toContain("events=div%2Csplits");
    expect(calls[0]!.headers["user-agent"]).toMatch(/Mozilla/);
    expect(calls[0]!.headers["user-agent"]).toBe(YAHOO_DEFAULT_USER_AGENT);
  });

  it("drops null bars instead of emitting zeros", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: chart({ bars: 4, nullAt: [1] }) }));
    const res = await client(impl).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data.rows.map((r) => r.date)).toEqual([
      "2026-08-27",
      "2026-08-26",
      "2026-08-24",
    ]);
  });

  it("dates bars by the exchange gmtoffset rather than by UTC", async () => {
    // A session that opens 09:00 in a +09:00 exchange is still 2026-08-24 there
    // while UTC has not yet reached it; the row must carry the session's date.
    const { impl } = fakeFetch(() => ({ status: 200, body: chart({ bars: 1, gmtoffset: 32400 }) }));
    const res = await client(impl).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data.rows[0]!.date).toBe("2026-08-24");
  });

  it("maps a class separator to Yahoo's dash and stamps rows with the mapped symbol", async () => {
    // `.` is a CLASS separator in FMP's US tickers (BRK.B), which Yahoo spells
    // BRK-B. It is not a general dot-to-dash rule: Yahoo spells Toyota 7203.T,
    // where the `.T` is an exchange suffix, and the branch is US-only.
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: chart({ bars: 1, symbol: "BRK-B" }) }));
    const res = await client(impl).dailyHistory("BRK.B", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls[0]!.url).toContain("/v8/finance/chart/BRK-B?");
    expect(res.value.data.rows[0]!.symbol).toBe("BRK-B");
  });

  it("keeps a bar whose volume alone is missing, but never invents a zero volume", async () => {
    const body = chart({ bars: 1 });
    body.chart.result![0]!.indicators.quote[0]!.volume = [null];
    const { impl } = fakeFetch(() => ({ status: 200, body }));
    const res = await client(impl).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.value.data.rows[0]!;
    expect(row).toMatchObject({ date: "2026-08-24", close: 100.5 });
    // A literal 0 would pass Stage B's `typeof === "number" && >= 0` guard and
    // be averaged into the 20d/90d volume trend as real, undisclosed data.
    expect(row.volume).toBeUndefined();
    expect("volume" in row).toBe(false);
  });

  it("turns a Yahoo error envelope into a disclosed gap, not an exception", async () => {
    const { impl } = fakeFetch(() => ({
      status: 404,
      body: chart({
        error: { code: "Not Found", description: "No data found, symbol may be delisted" },
      }),
    }));
    const res = await client(impl).dailyHistory("ZZZZ", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.field).toBe("yahoo.dailyHistory(ZZZZ)");
    expect(res.gap.reason).toMatch(/No data found/);
    expect(res.gap.severity).toBe("warn");
    expect(res.gap.attemptedSources).toEqual([
      "/v8/finance/chart/ZZZZ?interval=1d&period1=2026-08-20&period2=2026-09-01",
    ]);
  });

  it("turns a 429 (missing or blocked User-Agent) into a gap after the transport's retries", async () => {
    let calls = 0;
    const { impl } = fakeFetch(() => {
      calls++;
      return { status: 429, body: "Too Many Requests" };
    });
    const res = await createYahooClient({
      fetchImpl: impl,
      limiter: makeLimiter(1000, 1000),
      now: () => new Date("2026-09-01T00:00:00Z"),
      retryBaseDelayMs: 1,
    }).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.reason).toMatch(/429/);
    // The transport's default is 3 retries after the first attempt.
    expect(calls).toBe(4);
  });

  it("turns a non-retriable HTTP error with a well-formed body into a gap", async () => {
    const { impl } = fakeFetch(() => ({ status: 500, body: chart({ bars: 1 }) }));
    const res = await createYahooClient({
      fetchImpl: impl,
      limiter: makeLimiter(1000, 1000),
      now: () => new Date("2026-09-01T00:00:00Z"),
      maxRetries: 0,
    }).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.reason).toMatch(/HTTP 500/);
  });

  it("turns a hard transport failure into a gap rather than throwing", async () => {
    const { impl, calls } = rejectingFetch("socket hang up");
    const res = await createYahooClient({
      fetchImpl: impl,
      limiter: makeLimiter(1000, 1000),
      now: () => new Date("2026-09-01T00:00:00Z"),
      maxRetries: 0,
      timeoutMs: 5_000,
    }).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.reason).toMatch(/transport failure/);
    expect(res.gap.reason).toMatch(/socket hang up/);
    expect(calls).toHaveLength(1);
  });

  it("propagates a job cancellation instead of disclosing it as a data gap", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: chart({ bars: 1 }) }));
    const yahoo = createYahooClient({
      fetchImpl: impl,
      limiter: makeLimiter(1000, 1000),
      now: () => new Date("2026-09-01T00:00:00Z"),
      signal: AbortSignal.abort(new Error("job canceled by the user")),
    });
    await expect(yahoo.dailyHistory("AAPL", "2026-08-20", "2026-09-01")).rejects.toThrow(/canceled/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a schema-drifted body as a gap and never caches it", async () => {
    let cacheWrites = 0;
    const cachedFetch: CachedFetchFn = async (_key, _ttl, loader) => {
      const value = await loader();
      cacheWrites++;
      return { value };
    };
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: { chart: { result: [{ meta: {}, timestamp: "no" }], error: null } },
    }));
    const res = await client(impl, cachedFetch).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.reason).toMatch(/schema/i);
    expect(cacheWrites).toBe(0);
  });

  it("treats an empty result list as a gap", async () => {
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: { chart: { result: [], error: null } },
    }));
    const res = await client(impl).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.reason).toMatch(/no chart result/i);
  });

  it("treats a body that is not JSON as a gap", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: "<html>blocked</html>" }));
    const res = await client(impl).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.reason).toMatch(/unparseable/i);
  });

  it("treats a chart whose sessions are all null as a gap, not an empty success", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: chart({ bars: 2, nullAt: [0, 1] }) }));
    const res = await client(impl).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.reason).toMatch(/no daily bars/i);
  });

  it("keys the cache by the exact request and uses the history TTL", async () => {
    const keys: { key: string; ttl: number }[] = [];
    const cachedFetch: CachedFetchFn = async (key, ttl, loader) => {
      keys.push({ key, ttl });
      return { value: await loader() };
    };
    const { impl } = fakeFetch(() => ({ status: 200, body: chart() }));
    await client(impl, cachedFetch).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(keys).toEqual([
      {
        key: "yahoo:/v8/finance/chart/AAPL?interval=1d&period1=2026-08-20&period2=2026-09-01",
        ttl: YAHOO_TTLS.history,
      },
    ]);
  });

  it("prefers the cache's own fetchedAt and carries its staleness into the provenance", async () => {
    const cachedFetch: CachedFetchFn = async (_key, _ttl, loader) => ({
      value: await loader(),
      fetchedAt: "2026-08-29T12:00:00.000Z",
      stale: true,
      staleReason: "empty-refresh-preserved",
    });
    const { impl } = fakeFetch(() => ({ status: 200, body: chart({ bars: 5 }) }));
    const res = await client(impl, cachedFetch).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fetchedAt).toBe("2026-08-29T12:00:00.000Z");
    // Dropping these would print "unknown" in the sources appendix and stop
    // report/diff.ts ever flagging a Yahoo-backed report as stale.
    expect(res.value.stale).toBe(true);
    expect(res.value.staleReason).toBe("empty-refresh-preserved");
  });

  it("leaves stale unset when the cache served a fresh body", async () => {
    const cachedFetch: CachedFetchFn = async (_key, _ttl, loader) => ({ value: await loader() });
    const { impl } = fakeFetch(() => ({ status: 200, body: chart({ bars: 5 }) }));
    const res = await client(impl, cachedFetch).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stale).toBeUndefined();
    expect(res.value.staleReason).toBeUndefined();
  });

  it("honours a custom base URL and defaults the clock, limiter and User-Agent in production shape", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: chart({ bars: 1 }) }));
    const res = await createYahooClient({
      fetchImpl: impl,
      baseUrl: "https://query2.finance.yahoo.com/",
    }).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls[0]!.url.startsWith("https://query2.finance.yahoo.com/v8/finance/chart/AAPL?")).toBe(
      true,
    );
    // No `now` injected: the fetch stamp is a real clock reading, not a fixture.
    expect(Number.isNaN(Date.parse(res.value.fetchedAt))).toBe(false);
  });

  it("throttles through the shared provider registry when no limiter is injected", async () => {
    // The client must not own a private bucket: N per-company clients would
    // then issue 2N req/s to an unofficial endpoint, and setProviderLimiter —
    // http.ts's documented "tighter throttle after live verification" hook —
    // would be dead for Yahoo.
    const inner = makeLimiter(1000, 1000);
    let taken = 0;
    setProviderLimiter("yahoo", {
      ...inner,
      take: async (n?: number) => {
        taken++;
        await inner.take(n);
      },
    });
    const { impl } = fakeFetch(() => ({ status: 200, body: chart({ bars: 1 }) }));
    const res = await createYahooClient({ fetchImpl: impl }).dailyHistory(
      "AAPL",
      "2026-08-20",
      "2026-09-01",
    );
    expect(res.ok).toBe(true);
    expect(taken).toBe(1);
    expect(getProviderLimiter("yahoo").ratePerSec).toBe(1000);
  });
});

describe("YahooClient.quote and meta", () => {
  it("builds an FMP-shaped quote from the chart meta", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: chart({ bars: 3 }) }));
    const res = await client(impl).quote("AAPL");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.value.data.rows[0]!;
    expect(row).toMatchObject({
      symbol: "AAPL",
      name: "Apple Inc.",
      price: 102.5,
      dayHigh: 103,
      dayLow: 101,
      yearHigh: 130,
      yearLow: 80,
      previousClose: 99.5,
      volume: 1002,
      exchange: "NMS",
      currency: "USD",
    });
    // FmpQuoteRow spells "the vendor did not send this" as an absent key, so a
    // keyless market cap is omitted rather than nulled into later arithmetic.
    expect(row.marketCap).toBeUndefined();
    expect(row.change as number).toBeCloseTo(3, 10);
    expect(row.changePercentage as number).toBeCloseTo((102.5 / 99.5 - 1) * 100, 10);
    expect(typeof row.timestamp).toBe("number");
    expect(res.value.asOf).toBe("2026-08-26");
    expect(res.value.source).toBe("yahoo");
    expect(res.value.endpoint).toBe("/v8/finance/chart/AAPL?range=5d&interval=1d");
    expect(calls[0]!.url).toContain("range=5d");
  });

  it("exposes the meta needed for a keyless profile", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: chart() }));
    const res = await client(impl).meta("AAPL");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data).toMatchObject({
      symbol: "AAPL",
      currency: "USD",
      exchangeName: "NMS",
      fullExchangeName: "NasdaqGS",
      longName: "Apple Inc.",
      instrumentType: "EQUITY",
      firstTradeDate: "1980-12-12",
      regularMarketPrice: 104.5,
      regularMarketDayHigh: 105,
      regularMarketDayLow: 103,
      regularMarketVolume: 1004,
      fiftyTwoWeekHigh: 130,
      fiftyTwoWeekLow: 80,
      chartPreviousClose: 99.5,
    });
  });

  it("nulls every absent meta field and falls back to the fetch date for asOf", async () => {
    const body = chart({ bars: 2 });
    const meta = metaOf(body);
    delete meta["longName"];
    delete meta["currency"];
    delete meta["exchangeName"];
    delete meta["fullExchangeName"];
    delete meta["instrumentType"];
    meta["firstTradeDate"] = null;
    meta["regularMarketTime"] = null;
    meta["regularMarketDayHigh"] = null;
    meta["regularMarketDayLow"] = null;
    meta["regularMarketVolume"] = null;
    meta["fiftyTwoWeekHigh"] = null;
    meta["fiftyTwoWeekLow"] = null;
    meta["chartPreviousClose"] = null;
    const { impl } = fakeFetch(() => ({ status: 200, body }));
    const res = await client(impl).meta("AAPL");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data).toEqual({
      symbol: "AAPL",
      currency: null,
      exchangeName: null,
      fullExchangeName: null,
      longName: "Apple Inc.", // shortName is the documented fallback
      instrumentType: null,
      firstTradeDate: null,
      regularMarketPrice: 101.5,
      regularMarketTime: null,
      regularMarketDayHigh: null,
      regularMarketDayLow: null,
      regularMarketVolume: null,
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
      chartPreviousClose: null,
    });
    expect(res.value.asOf).toBe("2026-09-01");
  });

  it("omits change and changePercentage when Yahoo gives no previous close", async () => {
    const body = chart({ bars: 2 });
    metaOf(body)["chartPreviousClose"] = null;
    const { impl } = fakeFetch(() => ({ status: 200, body }));
    const res = await client(impl).quote("AAPL");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.value.data.rows[0]!;
    expect(row.change).toBeUndefined();
    expect(row.changePercentage).toBeUndefined();
    expect(row.previousClose).toBeUndefined();
  });

  it("never divides by a zero previous close", async () => {
    const body = chart({ bars: 2 });
    metaOf(body)["chartPreviousClose"] = 0;
    const { impl } = fakeFetch(() => ({ status: 200, body }));
    const res = await client(impl).quote("AAPL");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.value.data.rows[0]!;
    expect(row.previousClose).toBe(0); // reported faithfully, however implausible
    expect(row.change).toBe(101.5);
    expect(row.changePercentage).toBeUndefined();
  });

  it("reports a missing price as a gap rather than a zero quote", async () => {
    const body = chart({ bars: 2 });
    (body.chart.result![0]!.meta as { regularMarketPrice: number | null }).regularMarketPrice = null;
    const { impl } = fakeFetch(() => ({ status: 200, body }));
    const res = await client(impl).quote("AAPL");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.field).toBe("yahoo.quote(AAPL)");
    expect(res.gap.reason).toMatch(/regularMarketPrice/);
  });

  it("reports a zero price as a gap too", async () => {
    const body = chart({ bars: 2 });
    metaOf(body)["regularMarketPrice"] = 0;
    const { impl } = fakeFetch(() => ({ status: 200, body }));
    const res = await client(impl).quote("AAPL");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.reason).toMatch(/regularMarketPrice/);
  });

  it("re-labels an upstream fetch gap as a quote gap", async () => {
    const { impl } = fakeFetch(() => ({
      status: 404,
      body: chart({ error: { code: "Not Found", description: "No data found" } }),
    }));
    const res = await client(impl).quote("zzzz");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.field).toBe("yahoo.quote(ZZZZ)");
    expect(res.gap.reason).toMatch(/No data found/);
    expect(res.gap.attemptedSources).toEqual(["/v8/finance/chart/ZZZZ?range=5d&interval=1d"]);
  });

  it("carries cache staleness through both meta and the quote built from it", async () => {
    const cachedFetch: CachedFetchFn = async (_key, _ttl, loader) => ({
      value: await loader(),
      stale: true,
      staleReason: "empty-refresh-preserved",
    });
    const { impl } = fakeFetch(() => ({ status: 200, body: chart({ bars: 3 }) }));
    const yahoo = client(impl, cachedFetch);

    const metaRes = await yahoo.meta("AAPL");
    expect(metaRes.ok).toBe(true);
    if (!metaRes.ok) return;
    expect(metaRes.value.stale).toBe(true);
    expect(metaRes.value.staleReason).toBe("empty-refresh-preserved");

    const quoteRes = await yahoo.quote("AAPL");
    expect(quoteRes.ok).toBe(true);
    if (!quoteRes.ok) return;
    expect(quoteRes.value.stale).toBe(true);
    expect(quoteRes.value.staleReason).toBe("empty-refresh-preserved");
  });

  it("caches the meta call under the quote TTL", async () => {
    const keys: { key: string; ttl: number }[] = [];
    const cachedFetch: CachedFetchFn = async (key, ttl, loader) => {
      keys.push({ key, ttl });
      return { value: await loader() };
    };
    const { impl } = fakeFetch(() => ({ status: 200, body: chart() }));
    await client(impl, cachedFetch).meta("brk.b");
    expect(keys).toEqual([
      { key: "yahoo:/v8/finance/chart/BRK-B?range=5d&interval=1d", ttl: YAHOO_TTLS.quote },
    ]);
  });
});
