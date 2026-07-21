/**
 * Watchlist data-layer tests. No network: an in-memory better-sqlite3 database
 * (setDbForTests) plus an injected FMP client stub. Covers:
 *   - add / remove / list idempotency + uppercase normalization;
 *   - getWatchlistView shape with a seeded `done` report (grade extraction from
 *     reportJson) + live quote + next-earnings selection;
 *   - graceful degradation when quote/earnings are gaps (fixture-mode analog):
 *     fields null, gaps[] populated, no throw.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The data layer depends transitively on @/report/query, which imports the
// `server-only` shim (a Next-build-time module absent under the plain-node test
// runner). Stub it to a no-op so the module graph resolves — it has no runtime
// behavior; its only job is to fail the Next build if pulled into client code.
vi.mock("server-only", () => ({}));

import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { reports, watchlist } from "@/db/schema";
import { REPORT_SPEC_VERSION } from "@/report/schema";
import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";
import type {
  FmpClient,
  FmpEarningsRow,
  FmpPayload,
  FmpQuoteRow,
  FmpResult,
} from "@/providers/fmp";
import {
  addToWatchlist,
  getWatchlistView,
  listWatchlist,
  normalizeSymbol,
  removeFromWatchlist,
} from "@/watchlist/watchlist";

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

let handle: DatabaseHandle;

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
});

afterEach(() => {
  setDbForTests(null);
  handle.sqlite.close();
});

const NOW = () => new Date("2026-07-06T00:00:00.000Z");

/** Build a Sourced ok-result for a set of typed rows. */
function ok<TRow extends Record<string, unknown>>(
  rows: TRow[],
  asOf: string,
): FetchResult<FmpPayload<TRow>> {
  const sourced: Sourced<FmpPayload<TRow>> = {
    data: { rows, raw: rows },
    asOf,
    source: "fmp",
    endpoint: "[stub]",
    fetchedAt: "2026-07-06T00:00:00.000Z",
  };
  return { ok: true, value: sourced };
}

function gapResult(field: string, reason: string): { ok: false; gap: ManifestEntry } {
  return { ok: false, gap: { field, reason, severity: "warn" } };
}

/**
 * A minimal FMP client stub exposing only the two methods getWatchlistView
 * calls. Cast through unknown to FmpClient — the data layer never touches the
 * other ~50 methods.
 */
function stubFmp(opts: {
  quote?: (symbol: string) => FmpResult<FmpQuoteRow>;
  earnings?: (symbol: string) => FmpResult<FmpEarningsRow>;
}): FmpClient {
  return {
    quote: (symbol: string) =>
      opts.quote
        ? opts.quote(symbol)
        : Promise.resolve(gapResult(`fmp.quote(${symbol})`, "no stub")),
    earnings: (symbol: string) =>
      opts.earnings
        ? opts.earnings(symbol)
        : Promise.resolve(gapResult(`fmp.earnings(${symbol})`, "no stub")),
  } as unknown as FmpClient;
}

/** Seed a `done` report row carrying the DEMO sample report JSON. */
function seedReport(symbol: string, createdAt: string, verificationRate: number): void {
  const reportJson = readFileSync(
    path.join(process.cwd(), "fixtures", "report", "DEMO-sample.json"),
    "utf8",
  );
  handle.db
    .insert(reports)
    .values({
      symbol,
      createdAt,
      model: "claude-opus-4-8",
      status: "done",
      reportJson,
      verificationRate,
      costUsd: 2.1,
      specVersion: REPORT_SPEC_VERSION,
    })
    .run();
}

/* ------------------------------------------------------------------------ *
 * Raw persistence
 * ------------------------------------------------------------------------ */

describe("normalizeSymbol", () => {
  it("uppercases and trims", () => {
    expect(normalizeSymbol("  aapl ")).toBe("AAPL");
    expect(normalizeSymbol("brk.b")).toBe("BRK.B");
  });
});

describe("add / remove / list", () => {
  it("normalizes to uppercase on add", () => {
    addToWatchlist("aapl");
    const rows = listWatchlist();
    expect(rows.map((r) => r.symbol)).toEqual(["AAPL"]);
  });

  it("is idempotent: re-adding keeps a single row and the original addedAt", () => {
    addToWatchlist("aapl");
    const first = listWatchlist()[0];
    addToWatchlist("AAPL"); // same canonical symbol
    const rows = listWatchlist();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.addedAt).toBe(first?.addedAt);
  });

  it("remove is idempotent and case-insensitive", () => {
    addToWatchlist("aapl");
    addToWatchlist("msft");
    removeFromWatchlist("AAPL");
    expect(listWatchlist().map((r) => r.symbol)).toEqual(["MSFT"]);
    // removing an absent symbol is a no-op, not an error
    removeFromWatchlist("AAPL");
    expect(listWatchlist().map((r) => r.symbol)).toEqual(["MSFT"]);
  });

  it("lists oldest-added first", () => {
    addToWatchlist("aaa");
    addToWatchlist("bbb");
    addToWatchlist("ccc");
    expect(listWatchlist().map((r) => r.symbol)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("rejects an empty symbol", () => {
    expect(() => addToWatchlist("   ")).toThrow();
  });
});

/* ------------------------------------------------------------------------ *
 * getWatchlistView — enrichment
 * ------------------------------------------------------------------------ */

describe("getWatchlistView", () => {
  it("returns an empty array when the watchlist is empty", async () => {
    const view = await getWatchlistView({ fmp: stubFmp({}), now: NOW });
    expect(view).toEqual([]);
  });

  it("joins the latest done report grades, quote, and next earnings", async () => {
    addToWatchlist("aapl");
    seedReport("AAPL", "2026-06-01T00:00:00.000Z", 0.97);

    const fmp = stubFmp({
      quote: () => Promise.resolve(ok<FmpQuoteRow>([{ price: 211.5, changePercentage: 1.23, name: "Apple Inc." }], "2026-07-05")),
      earnings: () =>
        Promise.resolve(
          ok<FmpEarningsRow>(
            [
              { date: "2026-05-01", epsActual: 1.5 }, // past
              { date: "2026-07-31", epsActual: null }, // next future
              { date: "2026-10-30", epsActual: null }, // later future
            ],
            "2026-07-05",
          ),
        ),
    });

    const [row] = await getWatchlistView({ fmp, now: NOW });
    expect(row?.symbol).toBe("AAPL");
    expect(row?.price).toBe(211.5);
    expect(row?.changePct).toBeCloseTo(1.23);
    expect(row?.asOf).toBe("2026-07-05");
    expect(row?.grades).toEqual({
      fundamentals: "A",
      valuation: "C",
      technicals: "B",
      quality: "A",
      leadership: "A",
      moat: "A",
    });
    expect(row?.lastReportAt).toBe("2026-06-01T00:00:00.000Z");
    expect(row?.verificationRate).toBeCloseTo(0.97);
    expect(row?.nextEarnings).toBe("2026-07-31"); // earliest on/after today
    expect(row?.companyName).toBe("Apple Inc.");
    expect(row?.gaps).toEqual([]);
  });

  it("degrades gracefully when quote and earnings are gaps (fixture-mode analog)", async () => {
    addToWatchlist("nokey");

    const fmp = stubFmp({
      quote: (s) => Promise.resolve(gapResult(`fmp.quote(${s})`, "no API key + no fixture")),
      earnings: (s) => Promise.resolve(gapResult(`fmp.earnings(${s})`, "no API key + no fixture")),
    });

    const [row] = await getWatchlistView({ fmp, now: NOW });
    expect(row?.symbol).toBe("NOKEY");
    expect(row?.price).toBeNull();
    expect(row?.changePct).toBeNull();
    expect(row?.asOf).toBeNull();
    expect(row?.grades).toBeNull(); // no report seeded
    expect(row?.lastReportAt).toBeNull();
    expect(row?.nextEarnings).toBeNull();
    // both the price and earnings gaps are recorded, nothing thrown
    expect(row?.gaps.some((g) => g.startsWith("price:"))).toBe(true);
    expect(row?.gaps.some((g) => g.startsWith("earnings:"))).toBe(true);
  });

  it("does not throw when a provider call rejects — records the gap", async () => {
    addToWatchlist("boom");
    const fmp = stubFmp({
      quote: () => Promise.reject(new Error("network down")),
      earnings: () => Promise.resolve(ok<FmpEarningsRow>([], "2026-07-05")),
    });

    const [row] = await getWatchlistView({ fmp, now: NOW });
    expect(row?.price).toBeNull();
    expect(row?.gaps.some((g) => g.includes("network down"))).toBe(true);
    // earnings returned rows=[] → the client would gap upstream; here the empty
    // array yields "no future earnings date found"
    expect(row?.nextEarnings).toBeNull();
  });

  it("has no grades when no report exists but still returns price", async () => {
    addToWatchlist("msft");
    const fmp = stubFmp({
      quote: () => Promise.resolve(ok<FmpQuoteRow>([{ price: 500, changePercentage: -0.5 }], "2026-07-05")),
      earnings: () => Promise.resolve(ok<FmpEarningsRow>([{ date: "2026-08-01", epsActual: null }], "2026-07-05")),
    });

    const [row] = await getWatchlistView({ fmp, now: NOW });
    expect(row?.grades).toBeNull();
    expect(row?.lastReportAt).toBeNull();
    expect(row?.price).toBe(500);
    expect(row?.changePct).toBeCloseTo(-0.5);
    expect(row?.nextEarnings).toBe("2026-08-01");
  });

  it("picks the latest done report when several exist", async () => {
    addToWatchlist("aapl");
    seedReport("AAPL", "2026-05-01T00:00:00.000Z", 0.9);
    seedReport("AAPL", "2026-06-15T00:00:00.000Z", 0.95);

    const [row] = await getWatchlistView({ fmp: stubFmp({}), now: NOW });
    expect(row?.lastReportAt).toBe("2026-06-15T00:00:00.000Z");
    expect(row?.verificationRate).toBeCloseTo(0.95);
  });
});

/* ------------------------------------------------------------------------ *
 * DB round-trip sanity (the raw table)
 * ------------------------------------------------------------------------ */

describe("watchlist table round-trip", () => {
  it("stores exactly the normalized symbol as the primary key", () => {
    addToWatchlist("brk.b");
    const rows = handle.db.select().from(watchlist).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.symbol).toBe("BRK.B");
  });
});

/* ------------------------------------------------------------------------ *
 * Cache-bridge semantics
 * ------------------------------------------------------------------------ */

// Regression: watchlist.defaultFmpClient used to roll its own cachedFetch
// bridge WITHOUT the M6 empty-body guard, so a transient FMP 200-[] on a
// sidebar refresh could overwrite a good cached row the pipeline reads. The
// watchlist now reuses the pipeline's makeFmpCachedFetch; this pins the M6
// behavior of that shared bridge against a real in-memory api_cache.
describe("shared FMP cache bridge (M6 empty-body protection)", () => {
  it("a transient empty FMP body never overwrites a good cached row", async () => {
    const { makeFmpCachedFetch } = await import("@/pipeline/dataBundle");
    const { flushPendingRefreshes } = await import("@/cache/apiCache");
    const bridge = makeFmpCachedFetch();
    const key = "quote?symbol=M6TEST";
    type Exchange = { body: unknown[]; status: number };
    const good: Exchange = { body: [{ symbol: "M6TEST", price: 42 }], status: 200 };
    const empty: Exchange = { body: [], status: 200 };

    // First fetch is a cache MISS → stores the good body.
    const first = await bridge<Exchange>(key, 0, async () => good);
    expect(first.value.body).toHaveLength(1);

    // Age the stored row deterministically so every subsequent ttl-0 call takes
    // the STALE path (ageSeconds > 0). Preservation never re-stores the row, so
    // its fetchedAt stays fixed and the row remains stale for the rest of the
    // test — without this the same-millisecond calls can be served "fresh" and
    // no background refresh (hence no empty-refresh preservation) ever fires.
    await new Promise((r) => setTimeout(r, 10));

    // Second call (ttl 0 → stale hit): serves the good body IMMEDIATELY and
    // fires a fire-and-forget background refresh whose loader returns a
    // transient empty body. The served value is the stale good row REGARDLESS
    // of the M6 guard — so this return alone cannot prove the refresh write was
    // suppressed (the reason this test used to be non-discriminating).
    const second = await bridge<Exchange>(key, 0, async () => empty);
    expect(second.value.body).toHaveLength(1);

    // Drain the background refresh, THEN read again. THIS is the discriminating
    // assertion: only if makeFmpCachedFetch still passes isEmptyBody does the
    // good row survive the empty refresh — otherwise the empty body has now
    // overwritten it and the third read returns []. The retained-empty
    // condition is surfaced as staleReason 'empty-refresh-preserved'.
    await flushPendingRefreshes();
    const third = await bridge<Exchange>(key, 0, async () => empty);
    expect(third.value.body).toHaveLength(1);
    expect(third.value.body[0]).toEqual({ symbol: "M6TEST", price: 42 });
    expect(third.stale).toBe(true);
    expect(third.staleReason).toBe("empty-refresh-preserved");

    // Drain the third call's own background refresh so no fire-and-forget write
    // outlives the in-memory DB (afterEach closes the sqlite handle).
    await flushPendingRefreshes();
  });

  it("a first-ever empty body still caches (expected-empty semantics intact)", async () => {
    const { makeFmpCachedFetch } = await import("@/pipeline/dataBundle");
    const bridge = makeFmpCachedFetch();
    const key = "quote?symbol=EMPTYFIRST";
    type Exchange = { body: unknown[]; status: number };
    const empty: Exchange = { body: [], status: 200 };
    const first = await bridge<Exchange>(key, 60_000, async () => empty);
    expect(first.value.body).toHaveLength(0);

    // Prove the empty body was actually STORED, not merely returned: a second
    // fresh-TTL call is a cache HIT whose loader must NOT be invoked. If the
    // first-ever empty had been suppressed, this would miss and throw.
    const second = await bridge<Exchange>(key, 60_000, async () => {
      throw new Error("cache miss — a first-ever empty body was not stored");
    });
    expect(second.value.body).toHaveLength(0);
  });
});
