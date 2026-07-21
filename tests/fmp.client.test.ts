/**
 * FMP client tests — fixture mode, error-shape detection, EOD chunking,
 * cache-key stability. No network: live-path tests inject a fake fetch.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  FmpClient,
  createFmpClient,
  chunkDateRange,
  deriveAsOf,
  fmpCacheKey,
  fmpQueryString,
  isFmpErrorBody,
  fmpErrorMessage,
  FMP_TTLS,
  type CachedFetchFn,
  type FmpEodBarRow,
} from "@/providers/fmp";
import { makeLimiter } from "@/providers/http";

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "fmp");

/** Client with no key → fixture mode. */
function fixtureClient(): FmpClient {
  return createFmpClient({ apiKey: "", fixturesDir: FIXTURES_DIR });
}

/** Fake fetch returning a canned body/status; counts calls. */
function fakeFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls++;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls: () => calls };
}

/** Live-mode client with injected fetch and a fast limiter. */
function liveClient(fetchImpl: typeof fetch, cachedFetch?: CachedFetchFn): FmpClient {
  return createFmpClient({
    apiKey: "test-key",
    fixturesDir: FIXTURES_DIR,
    fetchImpl,
    limiter: makeLimiter(1000, 1000),
    ...(cachedFetch ? { cachedFetch } : {}),
  });
}

// ---------------------------------------------------------------------------
// Error-shape detection (object with "Error Message" — space included)
// ---------------------------------------------------------------------------

describe("isFmpErrorBody", () => {
  it("detects the documented 401 error object", () => {
    const body = { "Error Message": "Invalid API KEY. Feel free to create a Free API Key ..." };
    expect(isFmpErrorBody(body)).toBe(true);
    expect(fmpErrorMessage(body)).toContain("Invalid API KEY");
  });

  it("treats arrays as success even if elements mention errors", () => {
    expect(isFmpErrorBody([])).toBe(false);
    expect(isFmpErrorBody([{ "Error Message": "nope" }])).toBe(false);
  });

  it("ignores plain objects without the key and non-objects", () => {
    expect(isFmpErrorBody({ symbol: "AAPL" })).toBe(false);
    expect(isFmpErrorBody(null)).toBe(false);
    expect(isFmpErrorBody(undefined)).toBe(false);
    expect(isFmpErrorBody("Error Message")).toBe(false);
    expect(isFmpErrorBody(42)).toBe(false);
  });

  it("is keyed on the exact 'Error Message' key (with space)", () => {
    expect(isFmpErrorBody({ ErrorMessage: "x" })).toBe(false);
    expect(isFmpErrorBody({ error_message: "x" })).toBe(false);
  });
});

describe("live mode error handling (injected fetch, no network)", () => {
  it("maps an Error Message body to a gap even with HTTP 200 (401-before-routing rule)", async () => {
    const { fetch } = fakeFetch({ "Error Message": "Invalid API KEY. ..." }, 200);
    const result = await liveClient(fetch).profile("AAPL");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.reason).toContain("Invalid API KEY");
      expect(result.gap.field).toBe("fmp.profile(AAPL)");
    }
  });

  it("maps unknown object envelopes to a gap instead of treating them as rows", async () => {
    const { fetch } = fakeFetch({ message: "temporarily unavailable" }, 200);
    const result = await liveClient(fetch).quote("AAPL");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.reason).toMatch(/object body/i);
    }
  });

  it("maps 401 auth errors to a gap without retrying (deterministic 4xx)", async () => {
    const { fetch, calls } = fakeFetch({ "Error Message": "Invalid API KEY." }, 401);
    const result = await liveClient(fetch).quote("AAPL");
    expect(result.ok).toBe(false);
    expect(calls()).toBe(1); // no retries on 4xx auth errors
  });

  it("returns a gap for an empty success array (no data ≠ throw)", async () => {
    const { fetch } = fakeFetch([], 200);
    const result = await liveClient(fetch).earnings("ZZZT");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gap.reason).toContain("empty array");
  });

  it("wraps a successful array body in Sourced with fmp provenance", async () => {
    const { fetch } = fakeFetch([{ symbol: "AAPL", price: 232.8, timestamp: 1783108800 }], 200);
    const result = await liveClient(fetch).quote("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.source).toBe("fmp");
      expect(result.value.endpoint).toBe("/stable/quote?symbol=AAPL");
      expect(result.value.data.rows[0]?.price).toBe(232.8);
      expect(result.value.asOf).toBe("2026-07-03"); // from unix-seconds timestamp
      expect(Array.isArray(result.value.data.raw)).toBe(true);
    }
  });

  it("coerces controlled numeric strings on critical endpoints", async () => {
    const { fetch } = fakeFetch([
      { symbol: "AAPL", price: "232.80", marketCap: "3500000000000", timestamp: "1783108800" },
    ]);
    const result = await liveClient(fetch).quote("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data.rows[0]?.price).toBe(232.8);
      expect(result.value.data.rows[0]?.marketCap).toBe(3_500_000_000_000);
      expect(result.value.data.rows[0]?.timestamp).toBe(1_783_108_800);
    }
  });

  it("returns an explicit schema-drift gap for invalid critical numeric fields", async () => {
    const { fetch } = fakeFetch([{ symbol: "AAPL", price: { amount: 232.8 } }]);
    const result = await liveClient(fetch).quote("AAPL");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.reason).toMatch(/schema drift/i);
      expect(result.gap.reason).toContain("price");
    }
  });

  it("rejects statement rows without a valid fiscal date", async () => {
    const { fetch } = fakeFetch([{ symbol: "AAPL", date: "last quarter", revenue: "1000" }]);
    const result = await liveClient(fetch).incomeStatement("AAPL");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gap.reason).toMatch(/schema drift.*date/i);
  });
});

// ---------------------------------------------------------------------------
// Fixture mode
// ---------------------------------------------------------------------------

describe("fixture mode (no API key)", () => {
  it("is enabled when the key is empty/missing", () => {
    expect(fixtureClient().fixtureMode).toBe(true);
    expect(createFmpClient({ apiKey: "k", fixturesDir: FIXTURES_DIR }).fixtureMode).toBe(false);
  });

  it("loads explicitly synthetic DEMO data wrapped in Sourced with [FIXTURE] + stale", async () => {
    const result = await fixtureClient().profile("DEMO");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.source).toBe("fmp");
      expect(result.value.stale).toBe(true);
      expect(result.value.endpoint).toContain("[FIXTURE]");
      expect(result.value.endpoint).toContain("/stable/profile?symbol=DEMO");
      expect(result.value.data.rows[0]?.symbol).toBe("DEMO");
      expect(result.value.data.rows[0]?.companyName).toBe(
        "Thesis Example Systems",
      );
      expect(JSON.stringify(result.value.data.rows)).toContain(
        "SYNTHETIC TEST DATA",
      );
      expect(JSON.stringify(result.value.data.rows)).not.toMatch(
        /Apple|AAPL|Timothy|Cupertino/i,
      );
    }
  });

  it("derives asOf from fixture row dates (fiscal period end)", async () => {
    const result = await fixtureClient().incomeStatement("DEMO", "annual", 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.asOf).toBe("2025-12-31");
      expect(result.value.data.rows).toHaveLength(3);
      expect(result.value.data.rows[0]?.revenue).toBe(12_500_000_000);
    }
  });

  it("falls back to <method>/default.json for symbol-less endpoints", async () => {
    const result = await fixtureClient().marketRiskPremium();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const us = result.value.data.rows.find((r) => r.country === "United States");
      expect(us?.totalEquityRiskPremium).toBe(5);
      expect(JSON.stringify(us)).toContain("SYNTHETIC TEST DATA");
    }
  });

  it("returns the documented gap when neither fixture exists", async () => {
    const result = await fixtureClient().profile("ZZZT");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.reason).toBe("no API key + no fixture");
      expect(result.gap.field).toBe("fmp.profile(ZZZT)");
      expect(result.gap.attemptedSources?.length).toBeGreaterThan(0);
    }
  });

  it("keeps quirky raw shapes intact (dcf 'Stock Price' key, segmentation data map)", async () => {
    const dcf = await fixtureClient().dcf("DEMO");
    expect(dcf.ok).toBe(true);
    if (dcf.ok) expect(dcf.value.data.rows[0]?.["Stock Price"]).toBe(40);

    const seg = await fixtureClient().revenueProductSegmentation("DEMO");
    expect(seg.ok).toBe(true);
    if (seg.ok) {
      const data = seg.value.data.rows[0]?.data as Record<string, number>;
      expect(data.Platform).toBe(7_500_000_000);
      expect(data.Services).toBe(5_000_000_000);
    }
  });

  it("serves a fictional bank route for DBNK", async () => {
    const profile = await fixtureClient().profile("DBNK");
    const income = await fixtureClient().incomeStatement("DBNK");
    expect(profile.ok && income.ok).toBe(true);
    if (profile.ok && income.ok) {
      expect(profile.value.data.rows[0]?.industry).toContain("Bank");
      const fy2025 = income.value.data.rows[0];
      expect(fy2025?.symbol).toBe("DBNK");
      expect(fy2025?.revenue).toBe(8_000_000_000);
      expect(fy2025?.netIncome).toBe(1_200_000_000);
      expect(JSON.stringify(profile.value.data.rows)).toContain(
        "SYNTHETIC TEST DATA",
      );
    }
  });

  it("serves the 300-row deterministic synthetic EOD fixture through the EOD method", async () => {
    const result = await fixtureClient().historicalPriceEodFull(
      "DEMO",
      "2024-11-01",
      "2025-12-31",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rows = result.value.data.rows;
      expect(rows.length).toBe(300);
      // newest-first per FMP convention
      const first = rows[0]?.date ?? "";
      const last = rows[rows.length - 1]?.date ?? "";
      expect(first > last).toBe(true);
      expect(result.value.stale).toBe(true);
      expect(rows.every((row) => row.symbol === "DEMO")).toBe(true);
      expect(JSON.stringify(rows)).toContain("SYNTHETIC TEST DATA");
    }
  });
});

// ---------------------------------------------------------------------------
// EOD 5-year chunking (pure)
// ---------------------------------------------------------------------------

describe("chunkDateRange", () => {
  it("returns a single chunk for spans under 5 years", () => {
    expect(chunkDateRange("2024-01-01", "2025-06-30")).toEqual([
      { from: "2024-01-01", to: "2025-06-30" },
    ]);
  });

  it("splits a 12-year span into 3 contiguous, non-overlapping chunks", () => {
    const chunks = chunkDateRange("2014-01-01", "2026-01-01");
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ from: "2014-01-01", to: "2018-12-31" });
    expect(chunks[1]).toEqual({ from: "2019-01-01", to: "2023-12-31" });
    expect(chunks[2]).toEqual({ from: "2024-01-01", to: "2026-01-01" });
    // full coverage: each chunk starts the day after the previous ends
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = new Date(`${chunks[i - 1]!.to}T00:00:00Z`).getTime();
      const nextStart = new Date(`${chunks[i]!.from}T00:00:00Z`).getTime();
      expect(nextStart - prevEnd).toBe(86_400_000);
    }
  });

  it("handles the exact 5-year boundary without an empty tail chunk", () => {
    const chunks = chunkDateRange("2020-01-01", "2024-12-31");
    expect(chunks).toEqual([{ from: "2020-01-01", to: "2024-12-31" }]);
  });

  it("handles from == to", () => {
    expect(chunkDateRange("2026-07-06", "2026-07-06")).toEqual([
      { from: "2026-07-06", to: "2026-07-06" },
    ]);
  });

  it("throws on inverted ranges and malformed dates (programming errors)", () => {
    expect(() => chunkDateRange("2026-01-02", "2026-01-01")).toThrow();
    expect(() => chunkDateRange("01/01/2026", "2026-06-01")).toThrow();
  });

  it("drives one request per chunk in live mode and merges/dedupes rows", async () => {
    const requested: string[] = [];
    let call = 0;
    const impl = (async (url: unknown) => {
      const u = String(url);
      requested.push(u);
      call++;
      // overlap: both chunks return the boundary date row → must dedupe
      const rows: FmpEodBarRow[] =
        call === 1
          ? [
              { symbol: "AAPL", date: "2018-12-31", close: 39.44 },
              { symbol: "AAPL", date: "2014-01-02", close: 19.75 },
            ]
          : [
              { symbol: "AAPL", date: "2020-06-01", close: 80.46 },
              { symbol: "AAPL", date: "2018-12-31", close: 39.44 },
            ];
      return new Response(JSON.stringify(rows), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createFmpClient({
      apiKey: "test-key",
      fetchImpl: impl,
      limiter: makeLimiter(1000, 1000),
    });
    const result = await client.historicalPriceEodFull("AAPL", "2014-01-01", "2020-12-31");
    expect(requested).toHaveLength(2);
    expect(requested[0]).toContain("from=2014-01-01");
    expect(requested[0]).toContain("to=2018-12-31");
    expect(requested[1]).toContain("from=2019-01-01");
    expect(requested[1]).toContain("to=2020-12-31");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const dates = result.value.data.rows.map((r) => r.date);
      expect(dates).toEqual(["2020-06-01", "2018-12-31", "2014-01-02"]); // newest-first, deduped
    }
  });

  it("accepts a truncated newest window when only an OLDER chunk fails (2026-07 audit)", async () => {
    let call = 0;
    const impl = (async () => {
      call++;
      // chunk 1 = oldest (2014..2018) fails; chunk 2 = newest (2019..2020) succeeds.
      // 402 is non-retriable so one fetch = one chunk.
      if (call === 1) {
        return new Response(JSON.stringify({ "Error Message": "plan limited" }), { status: 402 });
      }
      return new Response(
        JSON.stringify([
          { symbol: "AAPL", date: "2020-06-01", close: 80.46 },
          { symbol: "AAPL", date: "2019-03-01", close: 43.2 },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = createFmpClient({
      apiKey: "test-key",
      fetchImpl: impl,
      limiter: makeLimiter(1000, 1000),
    });
    const result = await client.historicalPriceEodFull("AAPL", "2014-01-01", "2020-12-31");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data.rows.map((r) => r.date)).toEqual(["2020-06-01", "2019-03-01"]);
      expect(result.value.endpoint).toContain("history truncated to 2019-01-01..2020-12-31");
      expect(result.value.endpoint).toContain("1 older chunk(s) failed");
    }
  });

  it("drops successful chunks OLDER than a failure so the series never has a mid-window hole", async () => {
    let call = 0;
    const impl = (async () => {
      call++;
      // 3 chunks oldest->newest: ok, FAIL, ok. Accepting chunk 1 would leave a
      // hole across chunk 2 that silently corrupts drawdowns/relative strength.
      if (call === 1) {
        return new Response(JSON.stringify([{ symbol: "AAPL", date: "2012-06-01", close: 20 }]), { status: 200 });
      }
      if (call === 2) {
        return new Response(JSON.stringify({ "Error Message": "plan limited" }), { status: 402 });
      }
      return new Response(JSON.stringify([{ symbol: "AAPL", date: "2020-06-01", close: 80.46 }]), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createFmpClient({
      apiKey: "test-key",
      fetchImpl: impl,
      limiter: makeLimiter(1000, 1000),
    });
    const result = await client.historicalPriceEodFull("AAPL", "2010-01-01", "2020-12-31");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data.rows.map((r) => r.date)).toEqual(["2020-06-01"]);
      expect(result.value.endpoint).toContain("1 disjoint older chunk(s) dropped");
    }
  });

  it("returns a gap instead of partial EOD history when the NEWEST chunk fails", async () => {
    let call = 0;
    const impl = (async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify([{ symbol: "AAPL", date: "2018-12-31", close: 39.44 }]), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ "Error Message": "plan limited" }), { status: 402 });
    }) as unknown as typeof fetch;

    const client = createFmpClient({
      apiKey: "test-key",
      fetchImpl: impl,
      limiter: makeLimiter(1000, 1000),
    });
    const result = await client.historicalPriceEodFull("AAPL", "2014-01-01", "2020-12-31");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.reason).toMatch(/partial EOD/i);
    }
  });

  it("refuses stale history when the NEWEST EOD chunk is empty", async () => {
    let call = 0;
    const impl = (async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify([{ symbol: "AAPL", date: "2018-12-31", close: 39.44 }]), {
          status: 200,
        });
      }
      // A 200/empty response for the latest five-year window does not prove
      // the prior window is current; serving it would corrupt every technical.
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createFmpClient({
      apiKey: "test-key",
      fetchImpl: impl,
      limiter: makeLimiter(1000, 1000),
    });
    const result = await client.historicalPriceEodFull("AAPL", "2014-01-01", "2020-12-31");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.reason).toMatch(/partial EOD/i);
    }
  });

  // ---- H1: weekend/holiday "no new bar yet" recovery ----------------------
  // A run when today's bar is unpublished (weekend, exchange holiday, pre-close)
  // must keep the valid history through the prior close instead of erasing ALL
  // technicals. The 5-year chunk boundary collapses the newest chunk to the last
  // few calendar days for these eras; an EMPTY small newest chunk means "no bar
  // yet", not staleness.

  it("(a) Saturday run: an empty single-day newest chunk falls back to the prior close", async () => {
    // from/to chosen so chunkDateRange yields chunk1={2021-01-03..2026-01-02}
    // and a 1-day newest chunk2={2026-01-03(Sat)..2026-01-04(Sun)} that is empty.
    let call = 0;
    const impl = (async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify([
            { symbol: "AAPL", date: "2026-01-02", close: 250.1 },
            { symbol: "AAPL", date: "2025-12-31", close: 248.4 },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 }); // no weekend bar
    }) as unknown as typeof fetch;

    const client = createFmpClient({ apiKey: "test-key", fetchImpl: impl, limiter: makeLimiter(1000, 1000) });
    const result = await client.historicalPriceEodFull("AAPL", "2021-01-03", "2026-01-04");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data.rows.map((r) => r.date)).toEqual(["2026-01-02", "2025-12-31"]);
      expect(result.value.endpoint).toContain("no published bar yet");
      // asOf reflects the real last close, never a future/today placeholder.
      expect(result.value.asOf).toBe("2026-01-02");
    }
  });

  it("(b) holiday long-weekend run: an empty multi-day (<=7d) newest chunk still recovers", async () => {
    // chunk2={2026-01-16..2026-01-19} spans 3 calendar days (a Fri–Mon holiday
    // weekend); empty because no bar published across it yet.
    let call = 0;
    const impl = (async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify([{ symbol: "AAPL", date: "2026-01-15", close: 245.0 }]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createFmpClient({ apiKey: "test-key", fetchImpl: impl, limiter: makeLimiter(1000, 1000) });
    const result = await client.historicalPriceEodFull("AAPL", "2021-01-16", "2026-01-19");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data.rows.map((r) => r.date)).toEqual(["2026-01-15"]);
      expect(result.value.endpoint).toContain("no published bar yet");
    }
  });

  it("(c) single-chunk era: a full window in one chunk returns normally (no regression)", async () => {
    // 4-year window → chunkDateRange yields exactly ONE chunk; the recent bar is
    // inside it, so there is no empty-newest-chunk interaction at all.
    let call = 0;
    const impl = (async () => {
      call++;
      return new Response(
        JSON.stringify([
          { symbol: "AAPL", date: "2026-01-02", close: 250.1 },
          { symbol: "AAPL", date: "2022-01-03", close: 180.0 },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = createFmpClient({ apiKey: "test-key", fetchImpl: impl, limiter: makeLimiter(1000, 1000) });
    const result = await client.historicalPriceEodFull("AAPL", "2022-01-03", "2026-01-03");
    expect(call).toBe(1); // exactly one chunk
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data.rows.map((r) => r.date)).toEqual(["2026-01-02", "2022-01-03"]);
      expect(result.value.endpoint).not.toContain("no published bar yet");
      expect(result.value.endpoint).not.toContain("history truncated");
    }
  });

  it("(d) small empty newest chunk still REFUSES when the prior chunk failed (no anchor close)", async () => {
    // Same era as (a) but the older chunk is rate-limited: there is no valid
    // prior close to anchor to, so the no-new-bar shortcut must NOT engage.
    let call = 0;
    const impl = (async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ "Error Message": "plan limited" }), { status: 402 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createFmpClient({ apiKey: "test-key", fetchImpl: impl, limiter: makeLimiter(1000, 1000) });
    const result = await client.historicalPriceEodFull("AAPL", "2021-01-03", "2026-01-04");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Older chunk failed AND newest is empty → the whole series is unusable.
      expect(result.gap.reason).toMatch(/EOD/i);
    }
  });

  it("(e) delisted/long-halted symbol still REFUSES: prior chunk ok but its bars end months ago", async () => {
    // Same {today,today}-style empty newest chunk as (a), but the prior chunk's
    // newest BAR is ~6 months older than the request end (delisting / long
    // halt / upstream data gap). The no-new-bar shortcut must NOT engage —
    // serving July closes as "current" on a January run would silently corrupt
    // every technical while the disclosure claims a weekend/holiday.
    let call = 0;
    const impl = (async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify([
            { symbol: "GONE", date: "2025-07-11", close: 12.4 },
            { symbol: "GONE", date: "2025-07-10", close: 12.9 },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createFmpClient({ apiKey: "test-key", fetchImpl: impl, limiter: makeLimiter(1000, 1000) });
    const result = await client.historicalPriceEodFull("GONE", "2021-01-03", "2026-01-04");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.reason).toMatch(/partial EOD history refused/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Cache keys & TTLs
// ---------------------------------------------------------------------------

describe("fmpCacheKey", () => {
  it("is stable across param insertion order", () => {
    const a = fmpCacheKey("income-statement", { symbol: "AAPL", period: "annual", limit: 10 });
    const b = fmpCacheKey("income-statement", { limit: 10, period: "annual", symbol: "AAPL" });
    expect(a).toBe(b);
    expect(a).toBe("fmp:/stable/income-statement?limit=10&period=annual&symbol=AAPL");
  });

  it("drops undefined params and never embeds the api key", () => {
    const key = fmpCacheKey("treasury-rates", { from: undefined, to: undefined });
    expect(key).toBe("fmp:/stable/treasury-rates");
    expect(key).not.toContain("apikey");
  });

  it("distinguishes different endpoints and params", () => {
    expect(fmpCacheKey("quote", { symbol: "AAPL" })).not.toBe(fmpCacheKey("quote", { symbol: "JPM" }));
    expect(fmpCacheKey("ratios", { symbol: "AAPL" })).not.toBe(fmpCacheKey("ratios-ttm", { symbol: "AAPL" }));
  });

  it("encodes reserved characters (index symbols like ^GSPC)", () => {
    expect(fmpQueryString({ symbol: "^GSPC" })).toBe("symbol=%5EGSPC");
  });

  it("passes the canonical key + DATA_MAP §3 TTL to cachedFetch", async () => {
    const seen: Array<{ key: string; ttlMs: number }> = [];
    const cachedFetch: CachedFetchFn = async (key, ttlMs, loader) => {
      seen.push({ key, ttlMs });
      return { value: await loader() };
    };
    const { fetch } = fakeFetch([{ symbol: "AAPL", price: 1 }], 200);
    await liveClient(fetch, cachedFetch).quote("AAPL");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.key).toBe("fmp:/stable/quote?symbol=AAPL");
    expect(seen[0]?.ttlMs).toBe(FMP_TTLS.quote);
    expect(FMP_TTLS.quote).toBe(15 * 60_000);
    expect(FMP_TTLS.incomeStatement).toBe(24 * 3_600_000);
    expect(FMP_TTLS.sectorPeSnapshot).toBe(3_600_000);
    expect(FMP_TTLS.treasuryRates).toBe(2 * 3_600_000);
  });

  it("propagates cache staleness into Sourced.stale", async () => {
    const cachedFetch: CachedFetchFn = async (_key, _ttl, loader) => ({
      value: await loader(),
      stale: true,
      fetchedAt: "2026-07-01T00:00:00.000Z",
    });
    const { fetch } = fakeFetch([{ symbol: "AAPL", date: "2026-06-30" }], 200);
    const result = await liveClient(fetch, cachedFetch).marketCap("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stale).toBe(true);
      expect(result.value.fetchedAt).toBe("2026-07-01T00:00:00.000Z");
    }
  });
});

// ---------------------------------------------------------------------------
// asOf derivation
// ---------------------------------------------------------------------------

describe("deriveAsOf", () => {
  it("prefers row.date (fiscal period end), trimming datetimes", () => {
    expect(deriveAsOf([{ date: "2024-09-28" }], "2026-07-06T00:00:00Z")).toBe("2024-09-28");
    expect(deriveAsOf([{ date: "2026-06-05 08:13:10" }], "2026-07-06T00:00:00Z")).toBe("2026-06-05");
  });

  it("uses the newest row date when provider rows arrive out of order", () => {
    expect(
      deriveAsOf(
        [
          { date: "2024-09-28" },
          { date: "2026-03-28" },
          { date: "2025-09-27" },
        ],
        "2026-07-06T00:00:00Z",
      ),
    ).toBe("2026-03-28");
  });

  it("falls back to filingDate, then unix-seconds timestamp, then the fetch date", () => {
    expect(deriveAsOf([{ filingDate: "2024-11-01" }], "2026-07-06T00:00:00Z")).toBe("2024-11-01");
    expect(deriveAsOf([{ timestamp: 1783108800 }], "2026-07-06T00:00:00Z")).toBe("2026-07-03");
    expect(deriveAsOf([{ price: 1 }], "2026-07-06T12:34:56Z")).toBe("2026-07-06");
    expect(deriveAsOf([], "2026-07-06T12:34:56Z")).toBe("2026-07-06");
  });

  it("clamps a future max row date to the fetch date (forward-looking estimates/earnings) (L2)", () => {
    // analystEstimates rows dated 2026..2030 must NOT surface a future "as of".
    expect(deriveAsOf([{ date: "2028-12-31" }, { date: "2030-06-30" }], "2026-07-06T00:00:00Z")).toBe("2026-07-06");
    // Mixed past + future scheduled rows → newest PAST date wins; the future row is ignored.
    expect(deriveAsOf([{ date: "2026-05-01" }, { date: "2026-11-01" }], "2026-07-06T00:00:00Z")).toBe("2026-05-01");
    // A future unix timestamp (year 2100) also clamps to the fetch date.
    expect(deriveAsOf([{ timestamp: 4102444800 }], "2026-07-06T00:00:00Z")).toBe("2026-07-06");
  });
});
