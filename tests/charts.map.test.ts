/**
 * Unit tests for src/components/charts/map.ts — the pure, server-safe adapters
 * that turn pipeline types (DataBundle / ComputedMetrics) and persisted Reports
 * into chart-ready row/series props.
 *
 * These functions are the seam between the deterministic quant layer and the
 * client chart components, so the invariants under test are:
 *   - missing/non-finite metrics degrade to `null` (a gap the chart renders as
 *     "no data"), never to a silent 0 — except `volume`, which deliberately
 *     defaults to 0 for the histogram pane (`?? 0` in source);
 *   - statements arrive DESC but every fundamentals series is emitted
 *     oldest→newest (ascByDate);
 *   - percent values are passed through / derived exactly once (no fraction↔
 *     percent double-application);
 *   - empty inputs / all-gap bundles produce empty arrays, not throws.
 *
 * No network, no React, no charting-library imports (mirrors the module).
 */

import { describe, expect, it } from "vitest";

import type { ComputedMetrics } from "@/pipeline/compute";
import type { DataBundle } from "@/pipeline/types";
import type { Report } from "@/report/schema";
import type {
  FmpCashFlowRow,
  FmpEodBarRow,
  FmpIncomeStatementRow,
  FmpRawRow,
} from "@/providers/fmp";

import {
  toPriceBars,
  toCrossMarkers,
  priceChartPropsFromBundle,
  relativeStrengthSeriesFromBundle,
  revenueRowsFromStatements,
  marginRowsFromComputed,
  fcfRowsFromStatements,
  shareCountRowsFromStatements,
  fundamentalsChartDataFromBundle,
  sensitivityCellsFromReport,
} from "@/components/charts/map";

// ---------------------------------------------------------------------------
// Fetch-wrapper helpers (structural — the module's rowsOf only reads
// f.ok && f.value.data.rows, so a minimal Sourced envelope is enough).
// ---------------------------------------------------------------------------

function okFetch<TRow extends FmpRawRow>(rows: TRow[]) {
  return {
    ok: true as const,
    value: {
      data: { rows, raw: {} },
      asOf: "2026-01-01",
      source: "fmp" as const,
      endpoint: "fixture",
      fetchedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

const GAP = {
  ok: false as const,
  gap: { field: "x", reason: "fixture gap", severity: "info" as const },
};

/** Build a ComputedMetrics stub carrying just the smaCross fields toCrossMarkers reads. */
function computedWithCross(
  lastCrossDate: string | null,
  lastCrossType: "golden" | "death" | null,
): ComputedMetrics {
  return {
    technicals: { smaCross: { lastCrossDate, lastCrossType } },
  } as unknown as ComputedMetrics;
}

type MarginPt = { date: string; pct: number | null };

/** Build a ComputedMetrics stub carrying the three margin series marginRowsFromComputed reads. */
function computedWithMargins(
  gross: MarginPt[],
  operating: MarginPt[],
  net: MarginPt[],
): ComputedMetrics {
  return {
    growth: {
      margins: {
        gross: { series: gross },
        operating: { series: operating },
        net: { series: net },
      },
    },
  } as unknown as ComputedMetrics;
}

// ---------------------------------------------------------------------------
// toPriceBars
// ---------------------------------------------------------------------------

describe("toPriceBars", () => {
  it("maps complete OHLCV bars, truncating datetimes to the day", () => {
    const rows: FmpEodBarRow[] = [
      { date: "2026-01-02T00:00:00.000Z", open: 10, high: 12, low: 9, close: 11, volume: 5000 },
    ];
    expect(toPriceBars(rows)).toEqual([
      { date: "2026-01-02", open: 10, high: 12, low: 9, close: 11, volume: 5000 },
    ]);
  });

  it("drops a bar missing any of date/open/high/low/close (never fabricates a 0 price)", () => {
    const rows: FmpEodBarRow[] = [
      { date: "2026-01-02", open: 10, high: 12, low: 9, close: 11, volume: 100 }, // keep
      { date: "2026-01-03", open: 10, high: 12, low: 9, volume: 100 }, // missing close → drop
      { open: 10, high: 12, low: 9, close: 11, volume: 100 }, // missing date → drop
    ];
    const out = toPriceBars(rows);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("2026-01-02");
  });

  it("treats non-finite OHLC (NaN/Infinity) as missing and drops the bar", () => {
    const rows: FmpEodBarRow[] = [
      { date: "2026-01-02", open: Number.NaN, high: 12, low: 9, close: 11, volume: 100 },
      { date: "2026-01-03", open: 10, high: Number.POSITIVE_INFINITY, low: 9, close: 11, volume: 100 },
    ];
    expect(toPriceBars(rows)).toEqual([]);
  });

  it("defaults ONLY missing volume to 0 (histogram pane), keeping real OHLC", () => {
    const rows: FmpEodBarRow[] = [
      { date: "2026-01-02", open: 10, high: 12, low: 9, close: 11 },
    ];
    expect(toPriceBars(rows)[0].volume).toBe(0);
  });

  it("preserves input order and duplicates (chart re-sorts/de-dups defensively, map does not)", () => {
    const rows: FmpEodBarRow[] = [
      { date: "2026-01-03", open: 1, high: 2, low: 1, close: 2, volume: 1 },
      { date: "2026-01-02", open: 1, high: 2, low: 1, close: 2, volume: 1 },
      { date: "2026-01-02", open: 1, high: 2, low: 1, close: 2, volume: 1 },
    ];
    expect(toPriceBars(rows).map((r) => r.date)).toEqual([
      "2026-01-03",
      "2026-01-02",
      "2026-01-02",
    ]);
  });

  it("returns [] for empty input", () => {
    expect(toPriceBars([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toCrossMarkers
// ---------------------------------------------------------------------------

describe("toCrossMarkers", () => {
  it("emits the single latest cross, truncating the date to the day", () => {
    expect(toCrossMarkers(computedWithCross("2026-05-01T13:00:00.000Z", "golden"))).toEqual([
      { date: "2026-05-01", type: "golden" },
    ]);
  });

  it("emits nothing when there is no cross date", () => {
    expect(toCrossMarkers(computedWithCross(null, null))).toEqual([]);
  });

  it("emits nothing when a date exists but the type is null", () => {
    expect(toCrossMarkers(computedWithCross("2026-05-01", null))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// revenueRowsFromStatements
// ---------------------------------------------------------------------------

describe("revenueRowsFromStatements", () => {
  it("sorts DESC statements to oldest→newest and computes YoY growth in percent", () => {
    // Supplied newest-first (as FMP returns them).
    const rows: FmpIncomeStatementRow[] = [
      { date: "2024-12-31", revenue: 99 },
      { date: "2023-12-31", revenue: 110 },
      { date: "2022-12-31", revenue: 100 },
    ];
    const out = revenueRowsFromStatements(rows);
    expect(out.map((r) => r.period)).toEqual(["2022-12-31", "2023-12-31", "2024-12-31"]);
    // earliest year has no prior → null; then (110-100)/100*100 = 10; (99-110)/110*100 = -10
    expect(out[0].yoyGrowthPct).toBeNull();
    expect(out[1].yoyGrowthPct).toBeCloseTo(10, 10);
    expect(out[2].yoyGrowthPct).toBeCloseTo(-10, 10);
    expect(out.map((r) => r.revenue)).toEqual([100, 110, 99]);
  });

  it("uses |prior| in the denominator so a negative→less-negative move reads positive", () => {
    const rows: FmpIncomeStatementRow[] = [
      { date: "2022-12-31", revenue: -50 },
      { date: "2023-12-31", revenue: -40 },
    ];
    const out = revenueRowsFromStatements(rows);
    // (-40 - (-50)) / |−50| * 100 = 10/50*100 = 20
    expect(out[1].yoyGrowthPct).toBeCloseTo(20, 10);
  });

  it("maps missing revenue to null (never 0) and yields null YoY around the gap", () => {
    const rows: FmpIncomeStatementRow[] = [
      { date: "2022-12-31", revenue: 100 },
      { date: "2023-12-31" }, // revenue missing
      { date: "2024-12-31", revenue: 120 },
    ];
    const out = revenueRowsFromStatements(rows);
    expect(out[1].revenue).toBeNull();
    expect(out[1].yoyGrowthPct).toBeNull(); // current null
    expect(out[2].yoyGrowthPct).toBeNull(); // prior null
  });

  it("yields null YoY when the prior year's revenue is exactly 0 (no divide-by-zero)", () => {
    const rows: FmpIncomeStatementRow[] = [
      { date: "2022-12-31", revenue: 0 },
      { date: "2023-12-31", revenue: 50 },
    ];
    expect(revenueRowsFromStatements(rows)[1].yoyGrowthPct).toBeNull();
  });

  it("returns [] for empty input", () => {
    expect(revenueRowsFromStatements([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// marginRowsFromComputed
// ---------------------------------------------------------------------------

describe("marginRowsFromComputed", () => {
  it("passes the computed percent series through UNCHANGED (no ×100 double-apply)", () => {
    const computed = computedWithMargins(
      [
        { date: "2023-12-31", pct: 45.2 },
        { date: "2024-12-31", pct: 46.0 },
      ],
      [
        { date: "2023-12-31", pct: 30.1 },
        { date: "2024-12-31", pct: 31.0 },
      ],
      [
        { date: "2023-12-31", pct: 25.0 },
        { date: "2024-12-31", pct: 25.5 },
      ],
    );
    const out = marginRowsFromComputed(computed, []);
    expect(out).toEqual([
      { period: "2023-12-31", grossPct: 45.2, operatingPct: 30.1, netPct: 25.0 },
      { period: "2024-12-31", grossPct: 46.0, operatingPct: 31.0, netPct: 25.5 },
    ]);
  });

  it("preserves null points in the computed series (revenue ≤ 0 stays a gap, not 0)", () => {
    const computed = computedWithMargins(
      [{ date: "2023-12-31", pct: null }],
      [{ date: "2023-12-31", pct: null }],
      [{ date: "2023-12-31", pct: null }],
    );
    expect(marginRowsFromComputed(computed, [])[0]).toEqual({
      period: "2023-12-31",
      grossPct: null,
      operatingPct: null,
      netPct: null,
    });
  });

  it("falls back to deriving margins from statements (in percent) when the growth series is empty", () => {
    const computed = computedWithMargins([], [], []);
    const income: FmpIncomeStatementRow[] = [
      // supplied DESC; fallback sorts ascending
      { date: "2024-12-31", revenue: 200, grossProfit: 90, operatingIncome: 40, netIncome: 20 },
      { date: "2023-12-31", revenue: 100, grossProfit: 60, operatingIncome: 25, netIncome: 10 },
    ];
    const out = marginRowsFromComputed(computed, income);
    expect(out.map((r) => r.period)).toEqual(["2023-12-31", "2024-12-31"]);
    // 2023: 60/100=60%, 25/100=25%, 10/100=10%
    expect(out[0]).toEqual({ period: "2023-12-31", grossPct: 60, operatingPct: 25, netPct: 10 });
    // 2024: 90/200=45%, 40/200=20%, 20/200=10%
    expect(out[1]).toEqual({ period: "2024-12-31", grossPct: 45, operatingPct: 20, netPct: 10 });
  });

  it("fallback maps missing numerators / non-positive revenue to null", () => {
    const computed = computedWithMargins([], [], []);
    const income: FmpIncomeStatementRow[] = [
      { date: "2024-12-31", revenue: 0, grossProfit: 90, operatingIncome: 40, netIncome: 20 }, // rev 0 → all null
      { date: "2023-12-31", revenue: 100, netIncome: 10 }, // gross/op missing → null, net derived
    ];
    const out = marginRowsFromComputed(computed, income);
    expect(out[0]).toEqual({ period: "2023-12-31", grossPct: null, operatingPct: null, netPct: 10 });
    expect(out[1]).toEqual({ period: "2024-12-31", grossPct: null, operatingPct: null, netPct: null });
  });

  it("returns [] when both the computed series and the statement fallback are empty", () => {
    expect(marginRowsFromComputed(computedWithMargins([], [], []), [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fcfRowsFromStatements
// ---------------------------------------------------------------------------

describe("fcfRowsFromStatements", () => {
  it("uses reported freeCashFlow and computes conversion = FCF/NI in percent (dates matched to income)", () => {
    const cashflow: FmpCashFlowRow[] = [{ date: "2024-12-31", freeCashFlow: 5000 }];
    const income: FmpIncomeStatementRow[] = [{ date: "2024-12-31", netIncome: 2500 }];
    const out = fcfRowsFromStatements(cashflow, income);
    expect(out[0]).toEqual({ period: "2024-12-31", fcf: 5000, conversionPct: 200 });
  });

  it("derives FCF = OCF + capex when freeCashFlow is absent (capex is negative by convention)", () => {
    const cashflow: FmpCashFlowRow[] = [
      { date: "2024-12-31", operatingCashFlow: 6000, capitalExpenditure: -1000 },
    ];
    const income: FmpIncomeStatementRow[] = [{ date: "2024-12-31", netIncome: 2500 }];
    expect(fcfRowsFromStatements(cashflow, income)[0].fcf).toBe(5000);
  });

  it("treats missing capex as 0 in the OCF fallback (FCF = OCF)", () => {
    const cashflow: FmpCashFlowRow[] = [{ date: "2024-12-31", operatingCashFlow: 6000 }];
    expect(fcfRowsFromStatements(cashflow, [])[0].fcf).toBe(6000);
  });

  it("maps FCF to null (not 0) when neither freeCashFlow nor operatingCashFlow is present", () => {
    const cashflow: FmpCashFlowRow[] = [{ date: "2024-12-31", capitalExpenditure: -1000 }];
    const out = fcfRowsFromStatements(cashflow, []);
    expect(out[0].fcf).toBeNull();
    expect(out[0].conversionPct).toBeNull();
  });

  it("yields null conversion when net income is missing, zero, or its date does not match", () => {
    const cashflow: FmpCashFlowRow[] = [
      { date: "2024-12-31", freeCashFlow: 5000 }, // no matching income date
      { date: "2023-12-31", freeCashFlow: 5000 }, // matching income NI = 0
    ];
    const income: FmpIncomeStatementRow[] = [{ date: "2023-12-31", netIncome: 0 }];
    const out = fcfRowsFromStatements(cashflow, income);
    const byDate = Object.fromEntries(out.map((r) => [r.period, r.conversionPct]));
    expect(byDate["2024-12-31"]).toBeNull();
    expect(byDate["2023-12-31"]).toBeNull();
  });

  it("sorts DESC cashflow rows to oldest→newest", () => {
    const cashflow: FmpCashFlowRow[] = [
      { date: "2024-12-31", freeCashFlow: 20 },
      { date: "2022-12-31", freeCashFlow: 10 },
      { date: "2023-12-31", freeCashFlow: 15 },
    ];
    expect(fcfRowsFromStatements(cashflow, []).map((r) => r.period)).toEqual([
      "2022-12-31",
      "2023-12-31",
      "2024-12-31",
    ]);
  });

  it("returns [] for empty cashflow input", () => {
    expect(fcfRowsFromStatements([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// shareCountRowsFromStatements
// ---------------------------------------------------------------------------

describe("shareCountRowsFromStatements", () => {
  it("emits diluted share counts oldest→newest, null where the field is missing", () => {
    const income: FmpIncomeStatementRow[] = [
      { date: "2024-12-31", weightedAverageShsOutDil: 15000 },
      { date: "2023-12-31" }, // missing
      { date: "2022-12-31", weightedAverageShsOutDil: 16000 },
    ];
    const out = shareCountRowsFromStatements(income);
    expect(out).toEqual([
      { period: "2022-12-31", dilutedShares: 16000 },
      { period: "2023-12-31", dilutedShares: null },
      { period: "2024-12-31", dilutedShares: 15000 },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(shareCountRowsFromStatements([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// priceChartPropsFromBundle
// ---------------------------------------------------------------------------

describe("priceChartPropsFromBundle", () => {
  it("combines EOD bars and the latest cross marker", () => {
    const bundle = {
      eodPrices: okFetch<FmpEodBarRow>([
        { date: "2026-01-02", open: 10, high: 12, low: 9, close: 11, volume: 100 },
      ]),
    } as unknown as DataBundle;
    const out = priceChartPropsFromBundle(bundle, computedWithCross("2026-01-02", "death"));
    expect(out.rows).toHaveLength(1);
    expect(out.crosses).toEqual([{ date: "2026-01-02", type: "death" }]);
  });

  it("degrades to empty rows when the EOD fetch is a gap", () => {
    const bundle = { eodPrices: GAP } as unknown as DataBundle;
    const out = priceChartPropsFromBundle(bundle, computedWithCross(null, null));
    expect(out.rows).toEqual([]);
    expect(out.crosses).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// relativeStrengthSeriesFromBundle
// ---------------------------------------------------------------------------

describe("relativeStrengthSeriesFromBundle", () => {
  const bar = (date: string, close: number): FmpEodBarRow => ({
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  });

  it("builds primary (symbol) + benchmark (SPY, sector ETF) series, keeping only close+date", () => {
    const bundle = {
      symbol: "NVDA",
      eodPrices: okFetch<FmpEodBarRow>([bar("2026-01-02", 100), bar("2026-01-03", 110)]),
      benchmarkPrices: {
        spy: okFetch<FmpEodBarRow>([bar("2026-01-02", 500)]),
        sectorEtf: okFetch<FmpEodBarRow>([bar("2026-01-02", 200)]),
        sectorEtfSymbol: "XLK",
      },
    } as unknown as DataBundle;

    const series = relativeStrengthSeriesFromBundle(bundle);
    expect(series.map((s) => [s.label, s.role])).toEqual([
      ["NVDA", "primary"],
      ["SPY", "benchmark"],
      ["XLK", "benchmark"],
    ]);
    expect(series[0].rows).toEqual([
      { date: "2026-01-02", close: 100 },
      { date: "2026-01-03", close: 110 },
    ]);
  });

  it("drops the symbol series entirely when there are no usable closes (empty, not a zero row)", () => {
    const bundle = {
      symbol: "NVDA",
      eodPrices: okFetch<FmpEodBarRow>([{ date: "2026-01-02", open: 1, high: 1, low: 1, volume: 1 }]),
      benchmarkPrices: {
        spy: okFetch<FmpEodBarRow>([bar("2026-01-02", 500)]),
        sectorEtf: GAP,
        sectorEtfSymbol: null,
      },
    } as unknown as DataBundle;
    const series = relativeStrengthSeriesFromBundle(bundle);
    expect(series.map((s) => s.label)).toEqual(["SPY"]);
  });

  it("drops the sector series when its symbol is null even if rows exist", () => {
    const bundle = {
      symbol: "NVDA",
      eodPrices: okFetch<FmpEodBarRow>([bar("2026-01-02", 100)]),
      benchmarkPrices: {
        spy: GAP,
        sectorEtf: okFetch<FmpEodBarRow>([bar("2026-01-02", 200)]),
        sectorEtfSymbol: null,
      },
    } as unknown as DataBundle;
    const series = relativeStrengthSeriesFromBundle(bundle);
    expect(series.map((s) => s.label)).toEqual(["NVDA"]);
  });

  it("returns [] when every price fetch is a gap", () => {
    const bundle = {
      symbol: "NVDA",
      eodPrices: GAP,
      benchmarkPrices: { spy: GAP, sectorEtf: GAP, sectorEtfSymbol: "XLK" },
    } as unknown as DataBundle;
    expect(relativeStrengthSeriesFromBundle(bundle)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fundamentalsChartDataFromBundle
// ---------------------------------------------------------------------------

describe("fundamentalsChartDataFromBundle", () => {
  it("assembles all four datasets, preferring the computed margin series", () => {
    const bundle = {
      statements: {
        incomeAnnual: okFetch<FmpIncomeStatementRow>([
          { date: "2024-12-31", revenue: 220, weightedAverageShsOutDil: 15000, netIncome: 20 },
          { date: "2023-12-31", revenue: 200, weightedAverageShsOutDil: 16000, netIncome: 10 },
        ]),
        cashflowAnnual: okFetch<FmpCashFlowRow>([
          { date: "2024-12-31", freeCashFlow: 40 },
          { date: "2023-12-31", freeCashFlow: 20 },
        ]),
      },
    } as unknown as DataBundle;

    const computed = computedWithMargins(
      [{ date: "2023-12-31", pct: 50 }, { date: "2024-12-31", pct: 52 }],
      [{ date: "2023-12-31", pct: 20 }, { date: "2024-12-31", pct: 22 }],
      [{ date: "2023-12-31", pct: 5 }, { date: "2024-12-31", pct: 9 }],
    );

    const data = fundamentalsChartDataFromBundle(bundle, computed);

    // revenue: oldest→newest, YoY (220-200)/200*100 = 10
    expect(data.revenue.map((r) => r.period)).toEqual(["2023-12-31", "2024-12-31"]);
    expect(data.revenue[1].yoyGrowthPct).toBeCloseTo(10, 10);
    // margins: taken from computed series (percent), oldest→newest
    expect(data.margins.map((m) => m.grossPct)).toEqual([50, 52]);
    // fcf: conversion 20/10=200% (2023), 40/20=200% (2024)
    expect(data.fcf.map((f) => f.fcf)).toEqual([20, 40]);
    expect(data.fcf[0].conversionPct).toBeCloseTo(200, 10);
    // shareCount oldest→newest
    expect(data.shareCount.map((s) => s.dilutedShares)).toEqual([16000, 15000]);
  });

  it("degrades to empty datasets when all statement fetches are gaps", () => {
    const bundle = {
      statements: { incomeAnnual: GAP, cashflowAnnual: GAP },
    } as unknown as DataBundle;
    const data = fundamentalsChartDataFromBundle(bundle, computedWithMargins([], [], []));
    expect(data).toEqual({ revenue: [], margins: [], fcf: [], shareCount: [] });
  });
});

// ---------------------------------------------------------------------------
// sensitivityCellsFromReport
// ---------------------------------------------------------------------------

describe("sensitivityCellsFromReport", () => {
  it("returns the DCF sensitivity grid as-is (identity passthrough)", () => {
    const grid = [
      { waccPct: 8, terminalGrowthPct: 2, perShare: 150 },
      { waccPct: 9, terminalGrowthPct: 3, perShare: 130 },
    ];
    const report = {
      valuation: { dcf: { sensitivityGrid: grid } },
    } as unknown as Report;
    expect(sensitivityCellsFromReport(report)).toBe(grid);
  });

  it("returns an empty grid when the DCF produced no cells", () => {
    const report = {
      valuation: { dcf: { sensitivityGrid: [] } },
    } as unknown as Report;
    expect(sensitivityCellsFromReport(report)).toEqual([]);
  });
});
