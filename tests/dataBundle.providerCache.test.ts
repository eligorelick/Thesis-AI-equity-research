import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dedupeFredSeriesSpecs,
  makeCachedFredSeries,
  makeCachedFinraShortInterestTrend,
  makeCachedFinnhubInsiderSentiment,
} from "@/pipeline/dataBundle";
import { flushPendingRefreshes } from "@/cache/apiCache";
import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { apiCache } from "@/db/schema";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cacheRows() {
  return handle.db.select().from(apiCache).all();
}

describe("dataBundle provider cache wrappers", () => {
  it("dedupes FRED specs by id and units before cold-cache bundle fetches", () => {
    expect(
      dedupeFredSeriesSpecs([
        { id: "DGS10", units: "lin" },
        { id: "dgs10", units: "lin" },
        { id: "CPIAUCSL", units: "pc1" },
        { id: "CPIAUCSL", units: "lin" },
      ]),
    ).toEqual([
      { id: "DGS10", units: "lin" },
      { id: "CPIAUCSL", units: "pc1" },
      { id: "CPIAUCSL", units: "lin" },
    ]);
  });

  it("does not cache FRED csv fallback under a configured API key", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.stlouisfed.org")) {
        return jsonResponse({ error_code: 400, error_message: "Bad Request" }, 400);
      }
      return new Response("observation_date,DGS10\n2026-07-01,4.25\n", {
        status: 200,
        headers: { "content-type": "text/csv" },
      });
    });
    const fetchSeries = makeCachedFredSeries({
      apiKey: "BAD-FRED-KEY",
      fetchImpl,
      retryDelaysMs: [],
      minRequestIntervalMs: 0,
    });

    const first = await fetchSeries("DGS10", { start: "2026-07-01" });
    const second = await fetchSeries("DGS10", { start: "2026-07-01" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.endpoint).toContain("fredgraph.csv");
      expect(second.value.data).toEqual(first.value.data);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(cacheRows()).toHaveLength(0);
  });

  it("caches successful FINRA trend responses and avoids repeat partition/data calls", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/partitions/")) {
        return jsonResponse({ availablePartitions: [{ partitions: ["2026-06-30", "2026-06-15"] }] });
      }
      return jsonResponse([
        {
          symbolCode: "AAPL",
          issueName: "APPLE INC",
          settlementDate: "2026-06-15",
          currentShortPositionQuantity: 95_000_000,
        },
        {
          symbolCode: "AAPL",
          issueName: "APPLE INC",
          settlementDate: "2026-06-30",
          currentShortPositionQuantity: 100_000_000,
        },
      ]);
    });
    const fetchTrend = makeCachedFinraShortInterestTrend({
      fetchImpl,
      retryDelaysMs: [],
      minRequestIntervalMs: 0,
    });

    const first = await fetchTrend("aapl", 12);
    const second = await fetchTrend("AAPL", 12);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.data.map((r) => r.settlementDate)).toEqual(["2026-06-15", "2026-06-30"]);
      expect(second.value.data).toEqual(first.value.data);
      expect(second.value.source).toBe("finra");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cacheRows()).toHaveLength(1);
    expect(cacheRows()[0]?.provider).toBe("finra");
  });

  it("does not cache FINRA gaps", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "down" }, 500));
    const fetchTrend = makeCachedFinraShortInterestTrend({
      fetchImpl,
      retryDelaysMs: [],
      minRequestIntervalMs: 0,
    });

    const first = await fetchTrend("AAPL", 12);
    const second = await fetchTrend("AAPL", 12);

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cacheRows()).toHaveLength(0);
  });

  it("caches successful Finnhub insider sentiment responses", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { year: 2026, month: 5, change: -10_000, mspr: -4.2 },
          { year: 2026, month: 6, change: 15_000, mspr: 6.5 },
        ],
      }),
    );
    const fetchSentiment = makeCachedFinnhubInsiderSentiment({
      apiKey: "FH-KEY",
      fetchImpl,
      retryDelaysMs: [],
      maxRequestsPerMinute: 0,
    });

    const first = await fetchSentiment("aapl", "2025-07-07", "2026-07-07");
    const second = await fetchSentiment("AAPL", "2025-07-07", "2026-07-07");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.asOf).toBe("2026-06-01");
      expect(second.value.data).toEqual(first.value.data);
      expect(second.value.source).toBe("finnhub");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cacheRows()).toHaveLength(1);
    expect(cacheRows()[0]?.provider).toBe("finnhub");
  });
});
