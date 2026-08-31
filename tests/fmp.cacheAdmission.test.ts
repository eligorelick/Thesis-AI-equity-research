import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeFmpCachedFetch } from "@/pipeline/dataBundle";
import { createFmpClient } from "@/providers/fmp";
import { makeLimiter } from "@/providers/http";
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
