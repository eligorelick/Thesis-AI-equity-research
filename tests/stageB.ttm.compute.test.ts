/**
 * Stage B — TTM synthesis gating (compute.ts; 2026-07 audit Defect B).
 *
 * sumField historically summed whatever quarters were non-null and labeled the
 * partial sum a full TTM: one null revenue quarter undercounted TTM revenue
 * ~25% (mis-routing real companies to pre-revenue and understating DCF
 * startRevenue), and the tax pair could sum over MISMATCHED quarter subsets.
 * The fix gates revenue (whole-row) and the tax pair (as a pair) on 4 complete
 * quarters while keeping partial tolerance for legitimately-sparse fields
 * (interestExpense / D&A are null in some quarters for debt-free firms).
 */

import { describe, expect, it } from "vitest";

import {
  runStageB,
  ttmCashFlow,
  ttmIncome,
  effectiveTaxRateFromTtm,
  payoutRatioPct3y,
  selectUsEquityRiskPremium,
} from "@/pipeline/compute";
import type { DataBundle } from "@/pipeline/types";
import type { FmpCashFlowRow, FmpIncomeStatementRow } from "@/providers/fmp";
import type { ManifestEntry } from "@/types/core";

function q(over: Partial<Record<string, number | string | null>> = {}): FmpIncomeStatementRow {
  return {
    date: "2026-03-31",
    revenue: 100,
    operatingIncome: 20,
    depreciationAndAmortization: 5,
    netIncome: 15,
    epsDiluted: 1.5,
    ebit: 21,
    interestExpense: 2,
    incomeBeforeTax: 19,
    incomeTaxExpense: 4,
    ...over,
  } as FmpIncomeStatementRow;
}

/** Distinct, contiguous quarter-ends (newest first) — audit M1 requires real TTM windows in fixtures. */
const QDATES = ["2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30"] as const;

/** Four contiguous quarters with per-index overrides (index 0 = newest). */
function fourQ(
  overrides: Array<Partial<Record<string, number | string | null>>> = [],
): FmpIncomeStatementRow[] {
  return QDATES.map((date, i) => q({ date, ...(overrides[i] ?? {}) }));
}

const fourFull = fourQ();

function cf(over: Partial<Record<string, number | string | null>> = {}): FmpCashFlowRow {
  return {
    date: "2026-03-31",
    operatingCashFlow: 100,
    capitalExpenditure: -20,
    depreciationAndAmortization: 5,
    ...over,
  } as FmpCashFlowRow;
}

/** Four contiguous cash-flow quarters with per-index overrides (index 0 = newest). */
function fourCf(
  overrides: Array<Partial<Record<string, number | string | null>>> = [],
): FmpCashFlowRow[] {
  return QDATES.map((date, i) => cf({ date, ...(overrides[i] ?? {}) }));
}

describe("selectUsEquityRiskPremium — country-keyed selection", () => {
  it("selects the United States row regardless of provider array order", () => {
    expect(
      selectUsEquityRiskPremium([
        { country: "Australia", totalEquityRiskPremium: 5.9 },
        { country: "United States", totalEquityRiskPremium: 4.18 },
        { country: "Zimbabwe", totalEquityRiskPremium: 12.3 },
      ]),
    ).toBe(4.18);
  });

  it("recognizes documented US aliases without falling back to another country", () => {
    expect(selectUsEquityRiskPremium([{ country: "USA", totalEquityRiskPremium: 4.18 }])).toBe(4.18);
    expect(selectUsEquityRiskPremium([{ country: "US", totalEquityRiskPremium: 4.18 }])).toBe(4.18);
  });

  it("returns null when the US row is absent or conflicting", () => {
    expect(selectUsEquityRiskPremium([{ country: "Canada", totalEquityRiskPremium: 4.9 }])).toBeNull();
    expect(
      selectUsEquityRiskPremium([
        { country: "US", totalEquityRiskPremium: 4.18 },
        { country: "United States", totalEquityRiskPremium: 4.72 },
      ]),
    ).toBeNull();
  });
});

describe("ttmIncome — completeness gating", () => {
  it("sums all fields when every quarter is complete", () => {
    const ttm = ttmIncome(fourFull);
    expect(ttm).not.toBeNull();
    expect(ttm!.revenue).toBe(400);
    expect(ttm!.incomeBeforeTax).toBe(76);
    expect(ttm!.incomeTaxExpense).toBe(16);
    expect(ttm!.interestExpense).toBe(8);
    expect(ttm!.date).toBe("2026-03-31");
  });

  it("returns null (annual-basis fallback) when a quarter's revenue is missing — never a partial TTM", () => {
    const rows = fourQ([{}, { revenue: null }]);
    expect(ttmIncome(rows)).toBeNull();
  });

  it("discloses the suppressed TTM via a gap sink when revenue is partial", () => {
    const gaps: ManifestEntry[] = [];
    const rows = fourQ([{}, { revenue: null }]);
    expect(ttmIncome(rows, gaps)).toBeNull();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].field).toBe("compute.ttmIncome");
    expect(gaps[0].severity).toBe("info");
    expect(gaps[0].reason).toMatch(/3\/4/);
  });

  it("suppresses partial operating income so DCF and EV/EBITDA cannot use a smaller period as TTM", () => {
    const gaps: ManifestEntry[] = [];
    const ttm = ttmIncome(fourQ([{}, { operatingIncome: null }]), gaps);
    expect(ttm).not.toBeNull();
    expect(ttm!.revenue).toBe(400);
    expect(ttm!.operatingIncome).toBeNull();
    expect(gaps.some((g) => g.field === "compute.ttmIncome.operatingIncome")).toBe(true);
  });

  it("suppresses partial D&A so EBITDA and FFO cannot mix incomplete periods", () => {
    const ttm = ttmIncome(fourQ([{}, { depreciationAndAmortization: null }]));
    expect(ttm).not.toBeNull();
    expect(ttm!.depreciationAndAmortization).toBeNull();
  });

  it("suppresses partial interest expense rather than understating the cost-of-debt proxy", () => {
    const ttm = ttmIncome(fourQ([{}, { interestExpense: null }, { interestExpense: null }]));
    expect(ttm).not.toBeNull();
    expect(ttm!.interestExpense).toBeNull();
  });

  it("nulls the tax pair together when either side is incomplete (no mismatched-quarter tax rates)", () => {
    const gaps: ManifestEntry[] = [];
    const rows = fourQ([{ incomeTaxExpense: null }]);
    const ttm = ttmIncome(rows, gaps);
    expect(ttm).not.toBeNull();
    expect(ttm!.incomeTaxExpense).toBeNull();
    expect(ttm!.incomeBeforeTax).toBeNull(); // pair-gated: identical quarter coverage or nothing
    expect(gaps.some((g) => g.field === "compute.ttmIncome.taxPair")).toBe(true);
  });

  it("still requires at least 4 quarterly rows", () => {
    expect(ttmIncome(fourFull.slice(0, 3))).toBeNull();
  });

  it("treats reported zero revenue as complete (pre-revenue issuers report 0, not null)", () => {
    const rows = fourQ([{ revenue: 0 }, { revenue: 0 }, { revenue: 0 }, { revenue: 0 }]);
    const ttm = ttmIncome(rows);
    expect(ttm).not.toBeNull();
    expect(ttm!.revenue).toBe(0);
  });
});

describe("ttmIncome/ttmCashFlow — quarter contiguity gate (audit M1)", () => {
  it("missing middle quarter (slice reaches back a 5th season): TTM suppressed with a disclosed gap", () => {
    const gaps: ManifestEntry[] = [];
    // 2025-09-30 absent from the feed → slice(0,4) grabs 2025-03-31: a 184-day
    // hole between 2025-12-31 and 2025-06-30 and a 365-day total span.
    const rows = [
      q({ date: "2026-03-31" }),
      q({ date: "2025-12-31" }),
      q({ date: "2025-06-30" }),
      q({ date: "2025-03-31" }),
    ];
    expect(ttmIncome(rows, gaps)).toBeNull();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].field).toBe("compute.ttmIncome");
    expect(gaps[0].reason).toMatch(/non-contiguous/i);
  });

  it("duplicated quarter (restatement double-row): TTM suppressed, never a double-counted season", () => {
    const gaps: ManifestEntry[] = [];
    const rows = [
      q({ date: "2026-03-31" }),
      q({ date: "2026-03-31" }),
      q({ date: "2025-12-31" }),
      q({ date: "2025-09-30" }),
    ];
    expect(ttmIncome(rows, gaps)).toBeNull();
    expect(gaps.some((g) => g.field === "compute.ttmIncome" && /duplicate/i.test(g.reason))).toBe(true);
  });

  it("quarters out of descending order are rejected (mis-sorted feed)", () => {
    const rows = [
      q({ date: "2025-06-30" }),
      q({ date: "2025-09-30" }),
      q({ date: "2025-12-31" }),
      q({ date: "2026-03-31" }),
    ];
    expect(ttmIncome(rows)).toBeNull();
  });

  it("53-week fiscal calendar (one 14-week quarter) still passes", () => {
    // Retail 4-4-5 calendar with the extra week: 98d + 91d + 91d gaps, 280-day span.
    const rows = [
      q({ date: "2026-02-01" }),
      q({ date: "2025-10-26" }),
      q({ date: "2025-07-27" }),
      q({ date: "2025-04-27" }),
    ];
    const ttm = ttmIncome(rows);
    expect(ttm).not.toBeNull();
    expect(ttm!.revenue).toBe(400);
    expect(ttm!.date).toBe("2026-02-01");
  });

  it("ttmCashFlow applies the identical gate (missing middle quarter → null + gap)", () => {
    const gaps: ManifestEntry[] = [];
    const rows = [
      cf({ date: "2026-03-31" }),
      cf({ date: "2025-12-31" }),
      cf({ date: "2025-06-30" }),
      cf({ date: "2025-03-31" }),
    ];
    expect(ttmCashFlow(rows, gaps)).toBeNull();
    expect(gaps.some((g) => g.field === "compute.ttmCashFlow" && /non-contiguous/i.test(g.reason))).toBe(true);
  });

  it("ttmCashFlow accepts a contiguous 53-week calendar", () => {
    const rows = [
      cf({ date: "2026-02-01" }),
      cf({ date: "2025-10-26" }),
      cf({ date: "2025-07-27" }),
      cf({ date: "2025-04-27" }),
    ];
    const ttm = ttmCashFlow(rows);
    expect(ttm).not.toBeNull();
    expect(ttm!.operatingCashFlow).toBe(400);
  });
});

describe("effectiveTaxRateFromTtm — WACC fallback when FMP ratios rows are absent", () => {
  it("derives the rate from the complete tax pair", () => {
    const ttm = ttmIncome(fourFull);
    expect(effectiveTaxRateFromTtm(ttm)).toBeCloseTo(16 / 76, 9);
  });

  it("returns null on pre-tax losses (a negative-base rate is meaningless)", () => {
    const rows = fourFull.map((r) => q({ ...r, incomeBeforeTax: -10 }));
    expect(effectiveTaxRateFromTtm(ttmIncome(rows))).toBeNull();
  });

  it("returns null when the pair was suppressed or TTM missing", () => {
    expect(effectiveTaxRateFromTtm(null)).toBeNull();
    const rows = fourQ([{ incomeTaxExpense: null }]);
    expect(effectiveTaxRateFromTtm(ttmIncome(rows))).toBeNull();
  });
});

describe("ttmCashFlow — completeness gating", () => {
  it("suppresses partial operating cash flow and capex rather than emitting a smaller FCF as TTM", () => {
    const ttm = ttmCashFlow(fourCf([{}, { operatingCashFlow: null }, { capitalExpenditure: null }]));
    expect(ttm).not.toBeNull();
    expect(ttm!.operatingCashFlow).toBeNull();
    expect(ttm!.capitalExpenditure).toBeNull();
    expect(ttm!.depreciationAndAmortization).toBe(20);
  });
});

/* -------------------------------------------------------------------------- *
 * runStageB wiring — 2026-07-09 audit H2 / H3 / M3 / M4 / M5 / L4.
 *
 * These drive the REAL runStageB with a minimal typed bundle so the point-in-
 * time anchors (net debt convention, quarterly share count, quarterly balance
 * row), the ADR currency guard on the DCF path, the excess-return CoE
 * suppression, and the payout-ratio wiring are pinned at the ORCHESTRATOR
 * level, not just inside the pure modules.
 * -------------------------------------------------------------------------- */

const BUILT_AT = "2026-07-06T00:00:00.000Z";

/**
 * All currency totals below are written in $M and scaled to absolute dollars
 * (routing's pre-revenue floor is an absolute $10M). Per-share and share-count
 * fields stay unscaled so bridge identities are hand-checkable.
 */
const M = 1_000_000;
const NO_SCALE = new Set(["epsDiluted", "weightedAverageShsOutDil"]);
function scaleRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [
        k,
        typeof v === "number" && !NO_SCALE.has(k) ? v * M : v,
      ]),
    ),
  );
}

function okF<T>(data: T, asOf: string, endpoint = "fmp") {
  return {
    ok: true as const,
    value: { data, asOf, source: "fmp" as const, endpoint, fetchedAt: BUILT_AT },
  };
}
const gapF = {
  ok: false as const,
  gap: { field: "fixture", reason: "fixture gap", severity: "info" as const },
};
function fmpP<T>(rows: T[], asOf: string, endpoint = "fmp") {
  return okF({ rows, raw: {} }, asOf, endpoint);
}

interface WiringOpts {
  /** reportedCurrency stamped on income rows (default "USD"). */
  reportedCurrency?: string;
  /** Replace the quarterly balance rows (empty array = annual fallback). */
  balanceQuarterly?: Record<string, unknown>[];
  /** Null out quarterly weightedAverageShsOutDil (annual-shares fallback). */
  nullQuarterlyShares?: boolean;
  /** Zero quarterly weightedAverageShsOutDil (FMP zero-for-undisclosed sentinel). */
  zeroQuarterlyShares?: boolean;
  /** Route a bank instead of a general company. */
  bank?: boolean;
  /** Remove every risk-free-rate source (treasury + FRED DGS10). */
  noRiskFree?: boolean;
  /** Null interestExpense on 2 of the latest 4 quarters (completeness gate → TTM field null). */
  partialQuarterlyInterest?: boolean;
  /** Null ebit AND operatingIncome on 2 of the latest 4 quarters (gate → both TTM fields null). */
  partialQuarterlyEbit?: boolean;
  /** Inflate quarterly interest so effective Rd lands outside the acceptance band (forces synthetic path). */
  bigQuarterlyInterest?: boolean;
  /** Override latest-two annual totalDebt observations (before the fixture's $M scaling). */
  annualDebt?: readonly [number, number];
}

function wiringBundle(opts: WiringOpts = {}): DataBundle {
  const rc = opts.reportedCurrency ?? "USD";
  const incomeAnnual = [
    { date: "2025-12-31", fiscalYear: "2025", period: "FY", revenue: 1000, grossProfit: 400, operatingIncome: 200, ebit: 200, netIncome: 150, epsDiluted: 1.5, weightedAverageShsOutDil: 101, interestExpense: 15, incomeBeforeTax: 190, incomeTaxExpense: 40, depreciationAndAmortization: 50, reportedCurrency: rc },
    { date: "2024-12-31", fiscalYear: "2024", period: "FY", revenue: 900, grossProfit: 360, operatingIncome: 180, ebit: 180, netIncome: 140, epsDiluted: 1.4, weightedAverageShsOutDil: 102, interestExpense: 15, incomeBeforeTax: 175, incomeTaxExpense: 35, depreciationAndAmortization: 45, reportedCurrency: rc },
    { date: "2023-12-31", fiscalYear: "2023", period: "FY", revenue: 800, grossProfit: 320, operatingIncome: 160, ebit: 160, netIncome: 130, epsDiluted: 1.27, weightedAverageShsOutDil: 103, interestExpense: 14, incomeBeforeTax: 158, incomeTaxExpense: 28, depreciationAndAmortization: 40, reportedCurrency: rc },
    { date: "2022-12-31", fiscalYear: "2022", period: "FY", revenue: 700, grossProfit: 280, operatingIncome: 140, ebit: 140, netIncome: 110, epsDiluted: 1.06, weightedAverageShsOutDil: 104, interestExpense: 13, incomeBeforeTax: 135, incomeTaxExpense: 25, depreciationAndAmortization: 35, reportedCurrency: rc },
  ];
  const qShs = opts.zeroQuarterlyShares ? 0 : opts.nullQuarterlyShares ? null : 100;
  const incomeQuarterly: Record<string, number | string | null>[] = [
    { date: "2026-03-31", fiscalYear: "2026", period: "Q1", revenue: 250, operatingIncome: 50, ebit: 50, netIncome: 37.5, epsDiluted: 0.375, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 47.5, incomeTaxExpense: 10, depreciationAndAmortization: 12.5, reportedCurrency: rc },
    { date: "2025-12-31", fiscalYear: "2025", period: "Q4", revenue: 250, operatingIncome: 50, ebit: 50, netIncome: 37.5, epsDiluted: 0.375, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 47.5, incomeTaxExpense: 10, depreciationAndAmortization: 12.5, reportedCurrency: rc },
    { date: "2025-09-30", fiscalYear: "2025", period: "Q3", revenue: 250, operatingIncome: 50, ebit: 50, netIncome: 37.5, epsDiluted: 0.375, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 47.5, incomeTaxExpense: 10, depreciationAndAmortization: 12.5, reportedCurrency: rc },
    { date: "2025-06-30", fiscalYear: "2025", period: "Q2", revenue: 250, operatingIncome: 50, ebit: 50, netIncome: 37.5, epsDiluted: 0.375, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 47.5, incomeTaxExpense: 10, depreciationAndAmortization: 12.5, reportedCurrency: rc },
    // Four older quarters so availableQuarters >= 8 (no recent-ipo overlay).
    { date: "2025-03-31", fiscalYear: "2025", period: "Q1", revenue: 240, operatingIncome: 48, ebit: 48, netIncome: 36, epsDiluted: 0.36, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 45.5, incomeTaxExpense: 9.5, depreciationAndAmortization: 12, reportedCurrency: rc },
    { date: "2024-12-31", fiscalYear: "2024", period: "Q4", revenue: 235, operatingIncome: 47, ebit: 47, netIncome: 36, epsDiluted: 0.35, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 45, incomeTaxExpense: 9, depreciationAndAmortization: 12, reportedCurrency: rc },
    { date: "2024-09-30", fiscalYear: "2024", period: "Q3", revenue: 230, operatingIncome: 46, ebit: 46, netIncome: 35, epsDiluted: 0.34, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 44, incomeTaxExpense: 9, depreciationAndAmortization: 11.5, reportedCurrency: rc },
    { date: "2024-06-30", fiscalYear: "2024", period: "Q2", revenue: 225, operatingIncome: 45, ebit: 45, netIncome: 34, epsDiluted: 0.33, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 43, incomeTaxExpense: 8.5, depreciationAndAmortization: 11, reportedCurrency: rc },
  ];
  if (opts.bigQuarterlyInterest) {
    for (let i = 0; i < 4; i++) incomeQuarterly[i].interestExpense = 25;
  }
  if (opts.partialQuarterlyInterest) {
    incomeQuarterly[1].interestExpense = null;
    incomeQuarterly[2].interestExpense = null;
  }
  if (opts.partialQuarterlyEbit) {
    for (const i of [1, 2]) {
      incomeQuarterly[i].ebit = null;
      incomeQuarterly[i].operatingIncome = null;
    }
  }
  const annualDebt = opts.annualDebt ?? [300, 290];
  const balanceAnnual = [
    { date: "2025-12-31", totalAssets: 2000, totalLiabilities: 1500, totalStockholdersEquity: 500, totalEquity: 500, totalDebt: annualDebt[0], netDebt: 240, cashAndCashEquivalents: 60, cashAndShortTermInvestments: 100, goodwill: 40, intangibleAssets: 10, minorityInterest: 0, preferredStock: 0 },
    { date: "2024-12-31", totalAssets: 1900, totalLiabilities: 1450, totalStockholdersEquity: 450, totalEquity: 450, totalDebt: annualDebt[1], netDebt: 230, cashAndCashEquivalents: 60, cashAndShortTermInvestments: 95, goodwill: 40, intangibleAssets: 10, minorityInterest: 0, preferredStock: 0 },
  ];
  // Derived (house convention) net debt on the quarterly row: 280 - 120 = 160.
  // The vendor field is deliberately DIFFERENT (210 = 280 - 70, cash-only) so a
  // test can tell exactly which one the bridge used.
  const balanceQuarterly =
    opts.balanceQuarterly ??
    [{ date: "2026-03-31", totalAssets: 2050, totalLiabilities: 1530, totalStockholdersEquity: 520, totalEquity: 520, totalDebt: 280, netDebt: 210, cashAndCashEquivalents: 70, cashAndShortTermInvestments: 120, goodwill: 40, intangibleAssets: 10, minorityInterest: 0, preferredStock: 0 }];
  const cashflowAnnual = [
    { date: "2025-12-31", operatingCashFlow: 220, capitalExpenditure: -40, freeCashFlow: 180, netIncome: 150, depreciationAndAmortization: 50, stockBasedCompensation: 10, commonStockRepurchased: -20, commonDividendsPaid: -30, commonStockIssuance: 10, netCashProvidedByOperatingActivities: 220, netCashProvidedByInvestingActivities: -40 },
    { date: "2024-12-31", operatingCashFlow: 205, capitalExpenditure: -38, freeCashFlow: 167, netIncome: 140, depreciationAndAmortization: 45, stockBasedCompensation: 9, commonStockRepurchased: -30, commonDividendsPaid: -28, commonStockIssuance: 2, netCashProvidedByOperatingActivities: 205, netCashProvidedByInvestingActivities: -38 },
    { date: "2023-12-31", operatingCashFlow: 190, capitalExpenditure: -35, freeCashFlow: 155, netIncome: 130, depreciationAndAmortization: 40, stockBasedCompensation: 8, commonStockRepurchased: -13, commonDividendsPaid: -26, commonStockIssuance: 0, netCashProvidedByOperatingActivities: 190, netCashProvidedByInvestingActivities: -35 },
  ];
  const cashflowQuarterly = [
    { date: "2026-03-31", operatingCashFlow: 55, capitalExpenditure: -10, freeCashFlow: 45, netIncome: 37.5, depreciationAndAmortization: 12.5 },
    { date: "2025-12-31", operatingCashFlow: 55, capitalExpenditure: -10, freeCashFlow: 45, netIncome: 37.5, depreciationAndAmortization: 12.5 },
    { date: "2025-09-30", operatingCashFlow: 55, capitalExpenditure: -10, freeCashFlow: 45, netIncome: 37.5, depreciationAndAmortization: 12.5 },
    { date: "2025-06-30", operatingCashFlow: 55, capitalExpenditure: -10, freeCashFlow: 45, netIncome: 37.5, depreciationAndAmortization: 12.5 },
  ];
  const bundle = {
    symbol: opts.bank ? "BNK" : "GEN",
    builtAt: BUILT_AT,
    profile: fmpP(
      [{
        companyName: opts.bank ? "Test Bancorp" : "Test General Co",
        sector: opts.bank ? "Financial Services" : "Technology",
        industry: opts.bank ? "Banks - Diversified" : "Consumer Electronics",
        price: 100, marketCap: 10000 * M, beta: 1.0, currency: "USD", country: "US",
        ipoDate: "2000-01-01", isAdr: false, isEtf: false, isFund: false,
      }],
      "2026-07-01",
      "profile",
    ),
    quote: fmpP([{ symbol: opts.bank ? "BNK" : "GEN", price: 100, marketCap: 10000 * M, timestamp: 1751731200 }], "2026-07-05", "quote"),
    statements: {
      incomeAnnual: fmpP(scaleRows(incomeAnnual), "2025-12-31", "income-statement"),
      incomeQuarterly: fmpP(scaleRows(incomeQuarterly), "2026-03-31", "income-statement"),
      balanceAnnual: fmpP(scaleRows(balanceAnnual), "2025-12-31", "balance-sheet"),
      balanceQuarterly: fmpP(scaleRows(balanceQuarterly), "2026-03-31", "balance-sheet"),
      cashflowAnnual: fmpP(scaleRows(cashflowAnnual), "2025-12-31", "cash-flow"),
      cashflowQuarterly: fmpP(scaleRows(cashflowQuarterly), "2026-03-31", "cash-flow"),
      periods: { annualRequested: 10, quarterlyRequested: 8 },
    },
    keyMetrics: gapF,
    keyMetricsTtm: fmpP([{ returnOnEquityTTM: 0.12 }], "2026-03-31", "key-metrics-ttm"),
    ratios: gapF,
    ratiosTtm: fmpP([{ effectiveTaxRateTTM: 0.2 }], "2026-03-31", "ratios-ttm"),
    enterpriseValues: gapF,
    analystEstimates: gapF,
    marketCapHistory: gapF,
    eodPrices: gapF,
    benchmarkPrices: { spy: gapF, sectorEtf: gapF, sectorEtfSymbol: null },
    macro: { core: {}, sector: {}, gicsSector: null, attribution: "" },
    treasury: opts.noRiskFree ? gapF : fmpP([{ date: "2026-07-04", year10: 4.0 }], "2026-07-04", "treasury"),
    marketRiskPremium: fmpP([{ totalEquityRiskPremium: 4.5 }], "2026-07-01", "market-risk-premium"),
    asOf: {},
    gaps: [],
  } as unknown as DataBundle;
  return bundle;
}

describe("runStageB wiring — net debt convention + point-in-time anchors (audit H2/M3/M4)", () => {
  it("DCF equity bridge nets cash & short-term investments from the LATEST QUARTERLY balance row, not the vendor netDebt field", () => {
    const computed = runStageB(wiringBundle());
    expect(computed.valuation.kind).toBe("dcf");
    if (computed.valuation.kind !== "dcf") return;
    const dcf = computed.valuation.dcf;
    expect(dcf).not.toBeNull();
    // Bridge identity: EV - equity = netDebt + minority(0) + preferred(0).
    // House convention on the quarterly row: 280 totalDebt - 120 cash&STI = 160 ($M).
    // (Vendor netDebt is 210 on the quarterly row and 240 on the annual row —
    // the old code used 240.)
    expect((dcf!.enterpriseValue - (dcf!.equityValue as number)) / M).toBeCloseTo(160, 6);
  });

  it("per-share values divide by the LATEST QUARTERLY diluted share count (audit M3)", () => {
    const computed = runStageB(wiringBundle());
    if (computed.valuation.kind !== "dcf") throw new Error("expected dcf kind");
    const dcf = computed.valuation.dcf!;
    // quarterly weightedAverageShsOutDil = 100; annual = 101.
    expect((dcf.equityValue as number) / (dcf.perShare as number)).toBeCloseTo(100, 9);
  });

  it("falls back to the ANNUAL diluted share count with a disclosing note when quarterly is unavailable", () => {
    const computed = runStageB(wiringBundle({ nullQuarterlyShares: true }));
    if (computed.valuation.kind !== "dcf") throw new Error("expected dcf kind");
    const dcf = computed.valuation.dcf!;
    expect((dcf.equityValue as number) / (dcf.perShare as number)).toBeCloseTo(101, 9);
    expect(
      computed.valuation.notes.some((n) => /annual/i.test(n) && /share/i.test(n)),
    ).toBe(true);
  });

  it("whole-row annual fallback when no quarterly balance exists (audit M4) — derived convention still applies", () => {
    const computed = runStageB(wiringBundle({ balanceQuarterly: [] }));
    if (computed.valuation.kind !== "dcf") throw new Error("expected dcf kind");
    const dcf = computed.valuation.dcf!;
    // Annual row derived: 300 - 100 = 200 ($M; vendor field says 240).
    expect((dcf.enterpriseValue - (dcf.equityValue as number)) / M).toBeCloseTo(200, 6);
    const pb = computed.valuation.multiples.multiples.find((m) => m.key === "priceToBook");
    expect(pb?.basis).toMatch(/annual/i);
    // P/B anchored to the annual equity (500).
    expect(pb?.current).toBeCloseTo(10000 / 500, 9);
  });

  it("multiples balance anchors + basis string use the quarterly row when present (audit M4)", () => {
    const computed = runStageB(wiringBundle());
    if (computed.valuation.kind !== "dcf") throw new Error("expected dcf kind");
    const pb = computed.valuation.multiples.multiples.find((m) => m.key === "priceToBook");
    expect(pb?.current).toBeCloseTo(10000 / 520, 9);
    expect(pb?.basis).toMatch(/quarter/i);
  });

  it("rejects vendor cash-only netDebt when house-convention components are missing", () => {
    const computed = runStageB(
      wiringBundle({
        balanceQuarterly: [
          // No totalDebt/cash components: derivation impossible; vendor netDebt present.
          { date: "2026-03-31", totalStockholdersEquity: 520, netDebt: 210, minorityInterest: 0, preferredStock: 0 },
        ],
      }),
    );
    if (computed.valuation.kind !== "dcf") throw new Error("expected dcf kind");
    const dcf = computed.valuation.dcf!;
    expect(dcf.equityValue).toBeNull();
    expect(dcf.perShare).toBeNull();
    expect(computed.valuation.notes.some((n) => /net debt unavailable/i.test(n))).toBe(true);
    expect(computed.gaps.some((g) => g.field === "valuation.netDebt")).toBe(true);
  });

  it("missing cash is NOT zero and does not fall back to incompatible vendor netDebt", () => {
    const computed = runStageB(
      wiringBundle({
        balanceQuarterly: [
          // totalDebt present, BOTH cash fields absent: deriving totalDebt − 0
          // would overstate net debt by the whole cash balance (280 vs vendor 210).
          { date: "2026-03-31", totalAssets: 2050, totalLiabilities: 1530, totalStockholdersEquity: 520, totalEquity: 520, totalDebt: 280, netDebt: 210, goodwill: 40, intangibleAssets: 10, minorityInterest: 0, preferredStock: 0 },
        ],
      }),
    );
    if (computed.valuation.kind !== "dcf") throw new Error("expected dcf kind");
    const dcf = computed.valuation.dcf!;
    expect(dcf.equityValue).toBeNull();
    expect(dcf.perShare).toBeNull();
    expect(computed.valuation.notes.some((n) => /vendor.*rejected|net debt unavailable/i.test(n))).toBe(true);
  });

  it("a quarterly share count of literal 0 (zero-for-undisclosed) falls back to the ANNUAL count (fix-review)", () => {
    const computed = runStageB(wiringBundle({ zeroQuarterlyShares: true }));
    if (computed.valuation.kind !== "dcf") throw new Error("expected dcf kind");
    const dcf = computed.valuation.dcf!;
    expect((dcf.equityValue as number) / (dcf.perShare as number)).toBeCloseTo(101, 9);
    expect(computed.valuation.notes.some((n) => /annual/i.test(n) && /share/i.test(n))).toBe(true);
  });

  it("a quarterly balance row OLDER than the annual row loses: the fresher annual row anchors (fix-review)", () => {
    const computed = runStageB(
      wiringBundle({
        balanceQuarterly: [
          // Lagging quarterly feed: row predates the 2025-12-31 annual row.
          { date: "2025-06-30", totalAssets: 2050, totalLiabilities: 1530, totalStockholdersEquity: 520, totalEquity: 520, totalDebt: 280, netDebt: 210, cashAndCashEquivalents: 70, cashAndShortTermInvestments: 120, goodwill: 40, intangibleAssets: 10, minorityInterest: 0, preferredStock: 0 },
        ],
      }),
    );
    if (computed.valuation.kind !== "dcf") throw new Error("expected dcf kind");
    const dcf = computed.valuation.dcf!;
    // Annual (2025-12-31) derived net debt: 300 − 100 = 200 — not the stale quarterly 160.
    expect((dcf.enterpriseValue - (dcf.equityValue as number)) / M).toBeCloseTo(200, 6);
    const pb = computed.valuation.multiples.multiples.find((m) => m.key === "priceToBook");
    expect(pb?.basis).toMatch(/annual/i);
    expect(pb?.current).toBeCloseTo(10000 / 500, 9);
  });
});

describe("runStageB wiring — ADR currency guard on the DCF path (audit H3)", () => {
  it("TSM-shaped inputs (TWD statements, USD quote): DCF suppressed with a gap; valuation aspect not saturated", () => {
    const computed = runStageB(wiringBundle({ reportedCurrency: "TWD" }));
    expect(computed.valuation.kind).toBe("dcf");
    if (computed.valuation.kind !== "dcf") return;
    expect(computed.valuation.dcf).toBeNull();
    expect(computed.valuation.reverseDcf).toBeNull();
    expect(computed.valuation.sensitivity).toBeNull();
    expect(
      computed.gaps.some((g) => g.field === "valuation.dcf.currency" && g.severity === "critical"),
    ).toBe(true);
    // Grading must NOT band a mixed-currency +N00% "upside": the dcfUpside and
    // reverse-DCF signals are dropped (reweighted), never scored.
    const v = computed.scores.aspects.valuation;
    expect(v.drivers.some((d) => d.source.endsWith(".dcfUpside"))).toBe(false);
    expect(v.drivers.some((d) => d.source.endsWith(".reverseImpliedVsAchievable"))).toBe(false);
    expect(v.score === null || v.score < 90).toBe(true);
  });

  it("same-currency company is unaffected (control)", () => {
    const computed = runStageB(wiringBundle());
    if (computed.valuation.kind !== "dcf") throw new Error("expected dcf kind, got " + computed.valuation.kind + " route=" + computed.route.base + " overlays=" + JSON.stringify(computed.route.overlays) + " notes=" + JSON.stringify(computed.valuation.notes));
    expect(computed.valuation.dcf).not.toBeNull();
    expect(computed.gaps.some((g) => g.field === "valuation.dcf.currency")).toBe(false);
    expect(
      computed.scores.aspects.valuation.drivers.some((d) => d.source.endsWith(".dcfUpside")),
    ).toBe(true);
  });
});

describe("runStageB wiring — excess-return CoE suppression + payout wiring (audit M5/L4)", () => {
  it("bank with no risk-free rate: excess-return model SUPPRESSED with a critical gap, not run at a silent 10% CoE (audit M5)", () => {
    const computed = runStageB(wiringBundle({ bank: true, noRiskFree: true }));
    expect(computed.valuation.kind).toBe("excess-return");
    if (computed.valuation.kind !== "excess-return") return;
    expect(computed.valuation.excessReturn.equityValue).toBeNull();
    expect(computed.valuation.excessReturn.perShare).toBeNull();
    // The suppression gap lives on the model result — same place as the
    // existing bookValue-missing critical gap.
    expect(
      computed.valuation.excessReturn.gaps.some(
        (g) => g.field === "valuation.excessReturn.costOfEquity" && g.severity === "critical",
      ),
    ).toBe(true);
  });

  it("bank with CoE available: payout ratio is wired from cash-flow history (audit L4)", () => {
    const computed = runStageB(wiringBundle({ bank: true }));
    expect(computed.valuation.kind).toBe("excess-return");
    if (computed.valuation.kind !== "excess-return") return;
    const er = computed.valuation.excessReturn;
    expect(er.equityValue).not.toBeNull();
    // Hand-computed (dividends + net buybacks) / net income per year, 3y avg:
    //   2025: (30 + 20 - 10) / 150 = 40/150
    //   2024: (28 + 30 - 2)  / 140 = 56/140
    //   2023: (26 + 13 - 0)  / 130 = 39/130
    const expected = ((40 / 150 + 56 / 140 + 39 / 130) / 3) * 100;
    expect(er.payoutRatioPct.value).toBeCloseTo(expected, 9);
    expect(er.payoutRatioPct.basis).toMatch(/caller-provided/i);
  });
});

describe("runStageB wiring — gated-null TTM WACC inputs fall back to annual (audit M2)", () => {
  it("does not let a negative debt observation cancel against positive debt and impersonate debt-free WACC", () => {
    const computed = runStageB(wiringBundle({ annualDebt: [-300, 300] }));
    expect(computed.returns.wacc.waccPct).toBeNull();
    expect(computed.returns.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "returns.wacc.weights",
          severity: "critical",
          reason: expect.stringMatching(/negative total debt observation/i),
        }),
      ]),
    );
  });

  it("uses the annual interest expense when the TTM field is completeness-gated null — not the AAA no-interest branch", () => {
    const computed = runStageB(wiringBundle({ partialQuarterlyInterest: true }));
    const w = computed.returns.wacc;
    // Annual interest 15, avg totalDebt (300 + 290)/2 = 295 → effective
    // Rd = 15/295·100 ≈ 5.0847%, inside the acceptance band
    // [rf − 1, rf + 19] = [3, 23] with rf = 4 → method "effective".
    // The old existence-keyed ternary passed null → synthetic AAA (rf + 0.4).
    expect(w.costOfDebtMethod).toBe("effective");
    expect(w.costOfDebtPct).toBeCloseTo((15 / 295) * 100, 9);
    expect(w.syntheticRating).toBeNull();
    // Basis disclosed: the figure is annual, not TTM.
    expect(
      computed.returns.notes.some((n) => /interest expense/i.test(n) && /annual/i.test(n)),
    ).toBe(true);
  });

  it("uses the annual operating income for the synthetic-rating ICR when TTM ebit AND operatingIncome are gated null", () => {
    const computed = runStageB(
      wiringBundle({ partialQuarterlyEbit: true, bigQuarterlyInterest: true }),
    );
    const w = computed.returns.wacc;
    // TTM interest 4×25 = 100; Rd_eff = 100/295·100 ≈ 33.9% — outside [3, 23]
    // → synthetic path. ICR must use the annual operating income 200:
    // ICR = 200/100 = 2.0 → Ba2/BB (spread 1.84) → Rd = 4 + 1.84 = 5.84.
    // The old code passed ebitTtm = null → clamped-effective fallback instead.
    expect(w.costOfDebtMethod).toBe("synthetic");
    expect(w.interestCoverageRatio).toBeCloseTo(2.0, 9);
    expect(w.syntheticRating).toBe("Ba2/BB");
    expect(w.costOfDebtPct).toBeCloseTo(4 + 1.84, 9);
    expect(computed.returns.notes.some((n) => /EBIT/i.test(n) && /annual/i.test(n))).toBe(true);
  });

  it("control: with complete TTM quarters the TTM interest expense is used (no annual-fallback note)", () => {
    const computed = runStageB(wiringBundle());
    const w = computed.returns.wacc;
    // TTM interest 4×4 = 16 / 295 avg debt ≈ 5.42% — effective, from TTM.
    expect(w.costOfDebtMethod).toBe("effective");
    expect(w.costOfDebtPct).toBeCloseTo((16 / 295) * 100, 9);
    expect(
      computed.returns.notes.some((n) => /interest expense/i.test(n) && /annual/i.test(n)),
    ).toBe(false);
  });
});

describe("payoutRatioPct3y — (dividends + net buybacks) / net income, 3y average (audit L4)", () => {
  function cfy(
    date: string,
    ni: number | null,
    div: number | null,
    rep: number | null,
    iss: number | null,
  ): FmpCashFlowRow {
    return {
      date,
      netIncome: ni,
      commonDividendsPaid: div,
      commonStockRepurchased: rep,
      commonStockIssuance: iss,
    } as FmpCashFlowRow;
  }

  it("averages the per-year ratios over the latest 3 positive-net-income years", () => {
    // 2025: (30 + 20 - 10)/100 = 40%; 2024: (50 + 60 - 10)/200 = 50%;
    // 2023: (45 + 30 - 0)/150 = 50% -> avg = 140/3.
    const rows = [
      cfy("2025-12-31", 100, -30, -20, 10),
      cfy("2024-12-31", 200, -50, -60, 10),
      cfy("2023-12-31", 150, -45, -30, 0),
    ];
    expect(payoutRatioPct3y(rows)).toBeCloseTo(140 / 3, 9);
  });

  it("skips loss years and returns null below 2 usable years (default + disclosure applies downstream)", () => {
    const rows = [
      cfy("2025-12-31", -50, -30, -20, 0),
      cfy("2024-12-31", 100, -30, 0, 0),
      cfy("2023-12-31", -10, -30, 0, 0),
    ];
    expect(payoutRatioPct3y(rows)).toBeNull();
  });

  it("returns null when no payout fields are reported at all (missing != zero)", () => {
    const rows = [
      cfy("2025-12-31", 100, null, null, null),
      cfy("2024-12-31", 100, null, null, null),
      cfy("2023-12-31", 100, null, null, null),
    ];
    expect(payoutRatioPct3y(rows)).toBeNull();
  });

  it("clamps the average into [0, 100]", () => {
    // 300% and 200% payout years -> avg 250 -> clamped to 100.
    const high = [cfy("2025-12-31", 10, -30, 0, 0), cfy("2024-12-31", 10, -20, 0, 0)];
    expect(payoutRatioPct3y(high)).toBe(100);
    // Net issuance dominating -> negative -> clamped to 0.
    const negative = [cfy("2025-12-31", 100, 0, 0, 50), cfy("2024-12-31", 100, 0, 0, 60)];
    expect(payoutRatioPct3y(negative)).toBe(0);
  });

  it("only looks at the latest 3 fiscal years (a wild 4th year is ignored)", () => {
    const rows = [
      cfy("2025-12-31", 100, -40, 0, 0), // 40%
      cfy("2024-12-31", -5, -40, 0, 0), // loss year, skipped
      cfy("2023-12-31", 100, -60, 0, 0), // 60%
      cfy("2022-12-31", 100, -1000, 0, 0), // outside the 3y window
    ];
    expect(payoutRatioPct3y(rows)).toBeCloseTo(50, 9);
  });
});
