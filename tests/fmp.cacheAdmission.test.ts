import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeFmpCachedFetch, makeYahooCachedFetch } from "@/pipeline/dataBundle";
import { createFmpClient, FMP_TTLS } from "@/providers/fmp";
import { makeLimiter } from "@/providers/http";
import { createYahooClient, YAHOO_TTLS } from "@/providers/yahoo";
import { flushPendingRefreshes } from "@/cache/apiCache";
import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { apiCache } from "@/db/schema";

/**
 * Endpoint-contract validation used to run only AFTER `cachedFetch` had already
 * stored the body, so a schema-drifted HTTP 200 was persisted with the
 * endpoint's full TTL and then served as fresh for that whole window — and,
 * being non-empty, it also displaced the previous good row. The wrong-symbol
 * case never had this problem precisely because its check throws inside the
 * loader; schema drift now does the same.
 */
let handle: DatabaseHandle;

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
});

afterEach(async () => {
  await flushPendingRefreshes();
  setDbForTests(null);
  handle.sqlite.close();
  vi.restoreAllMocks();
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const cacheRows = () => handle.db.select().from(apiCache).all();

function client(fetchImpl: () => Promise<Response>) {
  return createFmpClient({
    apiKey: "FMP-KEY",
    fetchImpl,
    limiter: makeLimiter(1000, 1000),
    cachedFetch: makeFmpCachedFetch(),
  });
}

describe("FMP schema drift never reaches the durable cache", () => {
  it("rejects an object body on an array endpoint before it can displace the last-good row (audit 2026-09-06, F221)", async () => {
    // A non-error 200 envelope ({"message": ...}) on an optional-scope
    // statement endpoint normalised to zero rows and — not being an empty
    // ARRAY — was admitted and overwrote the previous statement row for the
    // full TTL.
    let call = 0;
    const good = [{ symbol: "AAPL", date: "2025-09-27", period: "FY", revenue: 100 }];
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? json({ message: "temporarily unavailable" }) : json(good);
    });

    const drifted = await client(fetchImpl).incomeStatement("AAPL", "annual", 5);
    expect(drifted.ok).toBe(false);
    if (drifted.ok) return;
    expect(drifted.gap.reason).toContain("object body where an array was expected");
    expect(cacheRows()).toEqual([]);

    const recovered = await client(fetchImpl).incomeStatement("AAPL", "annual", 5);
    expect(recovered.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cacheRows()).toHaveLength(1);
  });

  it("stores the millisecond TTLs of the provider clients as seconds (audit 2026-09-06, F232)", async () => {
    const fmpFetch = vi.fn(async () => json([{ symbol: "AAPL", price: 201 }]));
    const quote = await client(fmpFetch).quote("AAPL");
    expect(quote.ok).toBe(true);
    const fmpRow = cacheRows().find((row) => row.provider === "fmp");
    expect(fmpRow?.ttlSeconds).toBe(FMP_TTLS.quote / 1000);

    const start = 1_756_857_600; // 2026-09-03 00:00 UTC
    const chart = {
      chart: {
        result: [
          {
            meta: {
              currency: "USD",
              symbol: "AAPL",
              exchangeName: "NMS",
              instrumentType: "EQUITY",
              regularMarketTime: start + 23_400,
              gmtoffset: 0,
              regularMarketPrice: 101,
              chartPreviousClose: 100,
            },
            timestamp: [start],
            indicators: { quote: [{ open: [100], high: [102], low: [99], close: [101], volume: [10] }] },
          },
        ],
        error: null,
      },
    };
    const yahooFetch = vi.fn(async () => json(chart));
    const meta = await createYahooClient({
      fetchImpl: yahooFetch as unknown as typeof fetch,
      limiter: makeLimiter(1000, 1000),
      cachedFetch: makeYahooCachedFetch(),
    }).meta("AAPL");
    expect(meta.ok).toBe(true);
    const yahooRow = cacheRows().find((row) => row.provider === "yahoo");
    expect(yahooRow?.ttlSeconds).toBe(YAHOO_TTLS.quote / 1000);
  });

  it("does not cache a drifted body, and recovers on the next call", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // A declared numeric field arriving as an object: right symbol, wrong shape.
      return call === 1
        ? json([{ symbol: "AAPL", price: { value: 201 } }])
        : json([{ symbol: "AAPL", price: 201 }]);
    });

    const drifted = await client(fetchImpl).quote("AAPL");
    expect(drifted.ok).toBe(false);
    // Nothing admitted, so the next read is a cold miss that refetches.
    expect(cacheRows()).toHaveLength(0);

    const recovered = await client(fetchImpl).quote("AAPL");
    expect(recovered.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cacheRows()).toHaveLength(1);
  });

  it("keeps a previously good row when a later refresh drifts", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? json([{ symbol: "AAPL", price: 200 }])
        : json([{ symbol: "AAPL", price: "not-a-number" }]);
    });
    const c = client(fetchImpl);

    expect((await c.quote("AAPL")).ok).toBe(true);
    handle.db
      .update(apiCache)
      .set({ fetchedAt: new Date(Date.now() - 16 * 60_000).toISOString() })
      .run();

    await c.quote("AAPL");
    await flushPendingRefreshes();

    const envelope = JSON.parse(cacheRows()[0]?.bodyJson ?? "null") as {
      body?: Array<{ price?: unknown }>;
    };
    expect(envelope.body?.[0]?.price).toBe(200);
  });

  it("still caches a legitimately empty response", async () => {
    const fetchImpl = vi.fn(async () => json([]));

    const empty = await client(fetchImpl).quote("AAPL");

    expect(empty.ok).toBe(false);
    expect(cacheRows()).toHaveLength(1);
  });
});
