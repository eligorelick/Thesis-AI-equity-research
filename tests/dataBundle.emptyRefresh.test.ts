import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeFmpCachedFetch } from "@/pipeline/dataBundle";
import { createFmpClient } from "@/providers/fmp";
import { makeLimiter } from "@/providers/http";
import { flushPendingRefreshes } from "@/cache/apiCache";
import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { apiCache } from "@/db/schema";

/**
 * M6 keeps a transient empty refresh from erasing last-good provider data for
 * a whole TTL. `[]` is only the mildest anomalous shape: a zero-length 200 body
 * parses to `body: null`, which carries even less, so the same protection must
 * cover it. An unrecognized object envelope is covered by a different mechanism
 * — the loader rejects it, so the background refresh fails and the row stands —
 * and is asserted here so either protection failing is caught.
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

function cacheRows() {
  return handle.db.select().from(apiCache).all();
}

function cachedSymbol(): string | undefined {
  const rows = cacheRows();
  const envelope = JSON.parse(rows[0]?.bodyJson ?? "null") as {
    body?: Array<{ symbol?: string }> | null;
  };
  return Array.isArray(envelope.body) ? envelope.body[0]?.symbol : undefined;
}

/** Seed one good row, age it past its TTL, then let `refresh` answer the refetch. */
async function refreshLastGoodWith(refresh: () => Response): Promise<void> {
  let calls = 0;
  const fetchImpl = vi.fn(async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify([{ symbol: "AAPL", price: 200 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return refresh();
  });
  const client = createFmpClient({
    apiKey: "FMP-KEY",
    fetchImpl,
    limiter: makeLimiter(1000, 1000),
    cachedFetch: makeFmpCachedFetch(),
  });

  const first = await client.quote("AAPL");
  expect(first.ok).toBe(true);
  handle.db
    .update(apiCache)
    .set({ fetchedAt: new Date(Date.now() - 16 * 60_000).toISOString() })
    .run();

  await client.quote("AAPL");
  await flushPendingRefreshes();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
}

describe("FMP anomalous refresh cannot erase last-good cached data", () => {
  it("preserves last-good data when the refresh returns an empty array (M6 baseline)", async () => {
    await refreshLastGoodWith(
      () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    expect(cachedSymbol()).toBe("AAPL");
  });

  it("preserves last-good data when the refresh returns a zero-length 200 body", async () => {
    await refreshLastGoodWith(
      () => new Response("", { status: 200, headers: { "content-type": "application/json" } }),
    );

    expect(cachedSymbol()).toBe("AAPL");
  });

  it("preserves last-good data when the refresh returns an unrecognized object envelope", async () => {
    await refreshLastGoodWith(
      () =>
        new Response(JSON.stringify({ message: "temporarily unavailable" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    expect(cachedSymbol()).toBe("AAPL");
  });
});
