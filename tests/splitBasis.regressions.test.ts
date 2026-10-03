/**
 * Regressions from the independent review of 34a6aad (PR #3). Each case is
 * reproduced through a production function, with the expectation worked out
 * by hand in the comment beside it.
 *
 *  1. Coverage: a trading session the vendor did not answer for is never
 *     assumed to hold no split (no calendar-day tolerance at either edge or
 *     inside a gap).
 *  2. Vendor rows: each share and per-share field is kept only when that
 *     field itself matches the filer's restated value; one matching field
 *     approves nothing else.
 *  3. Vendor events: two descriptions of one split that disagree are a
 *     conflict, never two splits multiplied together.
 *  4. Yahoo: an event with an invalid ratio makes the answer's split list
 *     unavailable, never "no splits"; its prices still stand.
 */
import { describe, expect, it } from "vitest";
import { discoverStockSplits, shareBasisFactor, shareCountOnBasis, type StockSplits } from "@/edgar/splits";
import type { CompanyFacts } from "@/edgar/xbrl";
import { runStageB } from "@/pipeline/compute";
import { guardVendorShareFields } from "@/pipeline/keyless";
import type { DataBundle } from "@/pipeline/types";
import type { FmpIncomeStatementRow, FmpPayload, FmpRawRow } from "@/providers/fmp";
import { makeLimiter } from "@/providers/http";
import { mergeSplitEvidence, type VendorSplitEvidence } from "@/providers/splitEvents";
import { createYahooClient } from "@/providers/yahoo";
import type { FetchResult } from "@/types/core";

import { completeCurrencyBundle } from "./helpers/currencyBundle";

const EMPTY_FACTS: CompanyFacts = { cik: 1, entityName: "Test", facts: { "us-gaap": {}, dei: {} } };

function resolve(vendor: VendorSplitEvidence, asOf = "2026-09-30"): StockSplits {
  return discoverStockSplits(EMPTY_FACTS, { asOf, vendor });
}

function retrieved(
  events: { session: string; numerator: number; denominator: number }[],
  coverage: { from: string; to: string }[],
  source = "test:vendor",
): Extract<VendorSplitEvidence, { status: "retrieved" }> {
  return {
    status: "retrieved",
    source,
    events: events.map((e) => ({ ...e, ratio: e.numerator / e.denominator })),
    coverage,
  };
}

describe("1. coverage: an unanswered trading session is not assumed split-free", () => {
  it("withholds a count carried to 2026-06-17 when the vendor answered only through Monday 2026-06-15", () => {
    // Tuesday 2026-06-16 and Wednesday 2026-06-17 are trading sessions nobody
    // vouched for: a split first traded on either would put the count filed
    // 2026-02-01 on the wrong basis. Expected: withheld, not factor 1.
    const splits = resolve(retrieved([], [{ from: "2026-01-01", to: "2026-06-15" }]));
    const basis = shareBasisFactor(splits, "2026-02-01", null, "2026-06-17");
    expect(basis).toMatchObject({ withheld: expect.stringMatching(/not every session from 2026-02-01 to 2026-06-17/) });
    // Control: a session inside the coverage is established.
    expect(shareBasisFactor(splits, "2026-02-01", null, "2026-06-15")).toEqual({ factor: 1 });
  });

  it("withholds across an internal gap: coverage ending Tuesday 2026-06-09 and restarting Friday 2026-06-12", () => {
    // Wednesday 2026-06-10 and Thursday 2026-06-11 are uncovered trading days.
    const splits = resolve(
      retrieved([], [
        { from: "2026-01-01", to: "2026-06-09" },
        { from: "2026-06-12", to: "2026-09-30" },
      ]),
    );
    expect(shareCountOnBasis(splits, 10_000_000, "2026-02-01", null, "2026-09-30")).toMatchObject({
      withheld: expect.stringMatching(/covers 2026-01-01 … 2026-06-09, 2026-06-12 … 2026-09-30, not every session from 2026-02-01 to 2026-09-30/),
    });
    // Control: overlapping or touching spans (the next starts the day after the last ends) are one span.
    const joined = resolve(
      retrieved([], [
        { from: "2026-01-01", to: "2026-06-09" },
        { from: "2026-06-10", to: "2026-09-30" },
      ]),
    );
    expect(shareCountOnBasis(joined, 10_000_000, "2026-02-01", null, "2026-09-30")).toEqual({ value: 10_000_000 });
  });

  it("does not let the session window of a pinned split's neighbour be narrowed by a gap the vendor did not cover", () => {
    // A tagged split with no vendor event and a vendor gap over its window: the
    // window stays unnarrowed and a count across it is withheld.
    const tagged: CompanyFacts = {
      cik: 1,
      entityName: "Test",
      facts: {
        "us-gaap": {
          StockholdersEquityNoteStockSplitConversionRatio1: {
            label: "ratio",
            units: { pure: [{ end: "2026-06-12", val: 4, accn: "a", fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-08-05" }] },
          },
        },
        dei: {},
      },
    };
    const splits = discoverStockSplits(tagged, {
      asOf: "2026-09-30",
      vendor: retrieved([], [
        { from: "2026-01-01", to: "2026-06-09" },
        { from: "2026-06-12", to: "2026-09-30" },
      ]),
    });
    expect(shareCountOnBasis(splits, 10_000_000, "2026-02-01", null, "2026-09-30")).toMatchObject({ withheld: expect.any(String) });
  });
});

describe("2. vendor rows: each field's split basis is established on its own", () => {
  // A 4-for-1 first traded 2026-06-15 postdates every period below, so every
  // vendor row has to be shown to be on the post-split basis.
  const SPLITS = resolve(retrieved([{ session: "2026-06-15", numerator: 4, denominator: 1 }], [{ from: "1995-01-01", to: "2026-09-30" }]));

  it("keeps diluted shares that match, and withholds basic shares and EPS that do not", () => {
    // Filer (restated, post-split): 40M diluted, 40M basic, EPS $2.50.
    // Vendor: 40M diluted (matches), 10M basic and EPS $10 (pre-split, ×¼ and ×4).
    const filer = [{ date: "2025-12-31", weightedAverageShsOutDil: 40_000_000, weightedAverageShsOut: 40_000_000, epsDiluted: 2.5, eps: 2.5 }];
    const vendor: FmpRawRow[] = [{ date: "2025-12-31", revenue: 1_000, weightedAverageShsOutDil: 40_000_000, weightedAverageShsOut: 10_000_000, epsDiluted: 10, eps: 10 }];
    const out = guardVendorShareFields(vendor, filer, SPLITS, "2026-09-30");
    expect(out.rows[0]).toEqual({ date: "2025-12-31", revenue: 1_000, weightedAverageShsOutDil: 40_000_000 });
    expect(out.withheld.map((w) => w.field).sort()).toEqual(["eps", "epsDiluted", "weightedAverageShsOut"]);
    expect(out.withheld.find((w) => w.field === "eps")!.reason).toMatch(/vendor's eps for 2025-12-31 \(10\) differs from the filer's \(2\.5\)/);
  });

  it("withholds a field the filer has no value for, even when another field matches", () => {
    const filer = [{ date: "2025-12-31", weightedAverageShsOutDil: 40_000_000 }];
    const vendor: FmpRawRow[] = [{ date: "2025-12-31", weightedAverageShsOutDil: 40_000_000, epsDiluted: 2.5 }];
    const out = guardVendorShareFields(vendor, filer, SPLITS, "2026-09-30");
    expect(out.rows[0]).toEqual({ date: "2025-12-31", weightedAverageShsOutDil: 40_000_000 });
    expect(out.withheld).toEqual([{ date: "2025-12-31", field: "epsDiluted", reason: expect.stringMatching(/no filed epsDiluted for 2025-12-31/) }]);
  });

  it("keeps every field that matches, including ordinary EPS rounding within 3%", () => {
    const filer = [{ date: "2025-12-31", weightedAverageShsOutDil: 40_000_000, weightedAverageShsOut: 39_000_000, epsDiluted: 2.4975, eps: 2.5625 }];
    const vendor: FmpRawRow[] = [{ date: "2025-12-31", weightedAverageShsOutDil: 40_000_000, weightedAverageShsOut: 39_000_000, epsDiluted: 2.5, eps: 2.56 }];
    const out = guardVendorShareFields(vendor, filer, SPLITS, "2026-09-30");
    expect(out.withheld).toEqual([]);
    expect(out.rows[0]).toEqual(vendor[0]);
  });

  it("full Stage B: vendor EPS four times the filer's restated $0.45 never reaches P/E (55.5556, not 13.8889)", () => {
    // Price $100; four restated quarterly EPS of $0.45 → TTM $1.80 → P/E
    // 100 / 1.8 = 55.5556. The vendor's quarters carry 4 × 0.45 = $1.80 each,
    // TTM $7.20 → 100 / 7.2 = 13.8889 if they were used.
    const control = completeCurrencyBundle({ debt: 300 });
    const rowsOf = <T extends FmpRawRow>(m: FetchResult<FmpPayload<T>>): T[] => (m.ok ? m.value.data.rows : []);
    const filerQuarters = rowsOf(control.statements.incomeQuarterly);
    expect(filerQuarters.slice(0, 4).map((r) => r.epsDiluted)).toEqual([0.45, 0.45, 0.45, 0.45]);
    const inflate = (rows: FmpIncomeStatementRow[]): FmpIncomeStatementRow[] =>
      rows.map((r) => ({
        ...r,
        ...(typeof r.epsDiluted === "number" ? { epsDiluted: r.epsDiluted * 4 } : {}),
        ...(typeof r.eps === "number" ? { eps: r.eps * 4 } : {}),
      }));
    const guard = (member: FetchResult<FmpPayload<FmpIncomeStatementRow>>, filer: FmpRawRow[]): FetchResult<FmpPayload<FmpIncomeStatementRow>> => {
      if (!member.ok) return member;
      const out = guardVendorShareFields(inflate(member.value.data.rows), filer, SPLITS, "2026-09-30");
      return { ok: true, value: { ...member.value, data: { ...member.value.data, rows: out.rows } } };
    };
    const bundle: DataBundle = {
      ...control,
      statements: {
        ...control.statements,
        incomeQuarterly: guard(control.statements.incomeQuarterly, filerQuarters),
        incomeAnnual: guard(control.statements.incomeAnnual, rowsOf(control.statements.incomeAnnual)),
      },
    };
    const pe = (runStageB(bundle) as unknown as { valuation: { multiples: { multiples: { key: string; current: number | null }[] } } }).valuation.multiples.multiples.find((m) => m.key === "peTtm")!.current;
    expect(pe).not.toBeCloseTo(13.8889, 3);
    // With EPS withheld, P/E is the vendor's own market cap over TTM net income, which this fixture states consistently.
    expect(pe).toBeCloseTo(55.5556, 3);
    const guardedQuarter = rowsOf(bundle.statements.incomeQuarterly)[0]!;
    expect(guardedQuarter.epsDiluted).toBeUndefined();
    expect(guardedQuarter.weightedAverageShsOutDil).toBe(filerQuarters[0]!.weightedAverageShsOutDil);
  });
});

describe("3. vendor events: disagreeing descriptions of one split", () => {
  const COVER = [{ from: "1995-01-01", to: "2026-09-30" }];

  it("does not multiply a 4-for-1 and a 5-for-1 reported for the same session (10M must not become 200M)", () => {
    const merged = mergeSplitEvidence([
      retrieved([{ session: "2026-06-15", numerator: 4, denominator: 1 }], COVER, "daily"),
      retrieved([{ session: "2026-06-15", numerator: 5, denominator: 1 }], COVER, "full"),
    ]);
    const splits = resolve(merged);
    expect(splits.events).toEqual([]);
    expect(splits.unresolved).toHaveLength(1);
    expect(splits.notes.find((n) => n.severity === "warn")!.text).toMatch(/2026-06-15.*4-for-1.*5-for-1/);
    const count = shareCountOnBasis(splits, 10_000_000, "2026-02-01", null, "2026-09-30");
    expect(count).not.toEqual({ value: 200_000_000 });
    expect(count).toMatchObject({ withheld: expect.any(String) });
  });

  it("treats the same ratio reported for sessions days apart as one disputed date, not two splits", () => {
    // ×16 would follow from applying both.
    const splits = resolve(
      mergeSplitEvidence([
        retrieved([{ session: "2026-06-15", numerator: 4, denominator: 1 }], COVER, "daily"),
        retrieved([{ session: "2026-06-16", numerator: 4, denominator: 1 }], COVER, "full"),
      ]),
    );
    expect(splits.events).toEqual([]);
    expect(shareCountOnBasis(splits, 10_000_000, "2026-02-01", null, "2026-09-30")).toMatchObject({ withheld: expect.any(String) });
  });

  it("control: identical duplicates are one split (10M → 40M)", () => {
    const splits = resolve(
      mergeSplitEvidence([
        retrieved([{ session: "2026-06-15", numerator: 4, denominator: 1 }], COVER, "daily"),
        retrieved([{ session: "2026-06-15", numerator: 4, denominator: 1 }], COVER, "full"),
      ]),
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2026-06-15", 4]]);
    expect(shareCountOnBasis(splits, 10_000_000, "2026-02-01", null, "2026-09-30")).toEqual({ value: 40_000_000 });
  });

  it("control: genuinely separate splits compound (10M → ×2 → ×3 = 60M)", () => {
    const splits = resolve(retrieved([
      { session: "2021-07-20", numerator: 2, denominator: 1 },
      { session: "2026-06-15", numerator: 3, denominator: 1 },
    ], COVER));
    expect(shareCountOnBasis(splits, 10_000_000, "2021-02-01", null, "2026-09-30")).toEqual({ value: 60_000_000 });
  });

  it("a tagged split whose vendor descriptions disagree is not applied either", () => {
    const tagged: CompanyFacts = {
      cik: 1,
      entityName: "Test",
      facts: {
        "us-gaap": {
          StockholdersEquityNoteStockSplitConversionRatio1: {
            label: "ratio",
            units: { pure: [{ end: "2026-06-12", val: 4, accn: "a", fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-08-05" }] },
          },
        },
        dei: {},
      },
    };
    const splits = discoverStockSplits(tagged, {
      asOf: "2026-09-30",
      vendor: mergeSplitEvidence([
        retrieved([{ session: "2026-06-15", numerator: 4, denominator: 1 }], COVER, "daily"),
        retrieved([{ session: "2026-06-15", numerator: 5, denominator: 1 }], COVER, "full"),
      ]),
    });
    expect(splits.events).toEqual([]);
    expect(shareCountOnBasis(splits, 10_000_000, "2026-02-01", null, "2026-09-30")).toMatchObject({ withheld: expect.any(String) });
  });
});

describe("4. Yahoo: an invalid split event is never read as 'no splits'", () => {
  function yahooWith(splits: Record<string, unknown>) {
    const start = Date.UTC(2026, 7, 24, 13, 30) / 1000;
    const timestamp = [0, 1, 2, 3, 4].map((i) => start + i * 86400);
    const close = [100, 101, 102, 103, 104];
    const body = {
      chart: {
        result: [
          {
            meta: { currency: "USD", symbol: "TEST", regularMarketPrice: 104, regularMarketTime: timestamp[4]! + 23400, gmtoffset: -14400 },
            timestamp,
            events: { splits },
            indicators: { quote: [{ open: close, high: close, low: close, close, volume: close }], adjclose: [{ adjclose: close }] },
          },
        ],
        error: null,
      },
    };
    const impl = (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    return createYahooClient({ fetchImpl: impl, limiter: makeLimiter(1000, 1000), now: () => new Date("2026-08-29T00:00:00Z"), maxRetries: 0 });
  }
  const at = Date.UTC(2026, 7, 26, 13, 30) / 1000;

  it("a 4:0 event makes the full split list unavailable, with the reason", async () => {
    const res = await yahooWith({ [String(at)]: { date: at, numerator: 4, denominator: 0 } }).splitHistory("TEST");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data.status).toBe("unavailable");
    expect(res.value.data.status === "unavailable" && res.value.data.reason).toMatch(/2026-08-26.*numerator 4, denominator 0/);
  });

  it("the daily history keeps its prices while its split list is unavailable", async () => {
    const res = await yahooWith({ [String(at)]: { date: at, numerator: 4, denominator: 0 } }).dailyHistory("TEST", "2026-08-24", "2026-08-28");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data.rows.map((r) => r.close)).toEqual([104, 103, 102, 101, 100]);
    expect(res.value.data.splitEvents?.status).toBe("unavailable");
  });

  it("negative, zero and 1:1 ratios are invalid too; a valid 4:1 is listed", async () => {
    for (const bad of [{ numerator: -4, denominator: 1 }, { numerator: 0, denominator: 1 }, { numerator: 1, denominator: 1 }]) {
      const res = await yahooWith({ [String(at)]: { date: at, ...bad } }).splitHistory("TEST");
      expect(res.ok && res.value.data.status).toBe("unavailable");
    }
    const good = await yahooWith({ [String(at)]: { date: at, numerator: 4, denominator: 1 } }).splitHistory("TEST");
    expect(good.ok && good.value.data).toMatchObject({ status: "retrieved", events: [{ session: "2026-08-26", ratio: 4 }] });
  });
});
