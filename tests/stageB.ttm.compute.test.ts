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
  routeMetricsBlock,
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
    reportedCurrency: "USD",
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
    expect(ttm!.reportedCurrency).toBe("USD");
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

describe("ttmIncome — reported currency consensus", () => {
  it("normalizes agreeing reported currency values across all contributing quarters", () => {
    const ttm = ttmIncome(fourQ([
      { reportedCurrency: " usd " },
      { reportedCurrency: "USD" },
      { reportedCurrency: "Usd" },
      { reportedCurrency: "  USD  " },
    ]));

    expect(ttm).not.toBeNull();
    expect(ttm!.reportedCurrency).toBe("USD");
  });

  it.each([
    {
      label: "mixed USD/JPY",
      currencies: ["USD", "JPY", "USD", "JPY"],
    },
    {
      label: "missing value",
      currencies: ["USD", null, "USD", "USD"],
    },
    {
      label: "invalid code",
      currencies: ["USD", "US$", "USD", "USD"],
    },
  ])("keeps reported currency null for $label without suppressing the numeric TTM row", ({ currencies }) => {
    const ttm = ttmIncome(
      fourQ(currencies.map((reportedCurrency) => ({ reportedCurrency }))),
    );

    expect(ttm).not.toBeNull();
    expect(ttm!.revenue).toBe(400);
    expect(ttm!.reportedCurrency).toBeNull();
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

  it("normalizes out-of-order quarters before selecting the current TTM window", () => {
    const rows = [
      q({ date: "2025-06-30" }),
      q({ date: "2025-09-30" }),
      q({ date: "2025-12-31" }),
      q({ date: "2026-03-31" }),
    ];
    const ttm = ttmIncome(rows);
    expect(ttm).not.toBeNull();
    expect(ttm?.date).toBe("2026-03-31");
    expect(ttm?.revenue).toBe(400);
  });

  it("uses the uniquely latest accepted duplicate as a whole row and derives currency from selected rows only", () => {
    const rows = [
      q({
        date: "2026-03-31",
        acceptedDate: "2026-05-01 15:00:00",
        revenue: 900,
        reportedCurrency: "JPY",
      }),
      q({
        date: "2026-03-31",
        acceptedDate: "2026-05-01 16:00:00",
        revenue: 150,
        reportedCurrency: " usd ",
      }),
      q({ date: "2025-12-31", reportedCurrency: "USD" }),
      q({ date: "2025-09-30", reportedCurrency: "Usd" }),
      q({ date: "2025-06-30", reportedCurrency: "USD" }),
    ];

    const ttm = ttmIncome(rows);

    expect(ttm).not.toBeNull();
    expect(ttm?.date).toBe("2026-03-31");
    expect(ttm?.revenue).toBe(450);
    expect(ttm?.reportedCurrency).toBe("USD");
  });

  it("selects a cash-flow restatement by later filing day without double-counting the period", () => {
    const rows = [
      cf({ date: "2026-03-31", filingDate: "2026-04-30", operatingCashFlow: 900 }),
      cf({ date: "2026-03-31", filingDate: "2026-05-01", operatingCashFlow: 150 }),
      cf({ date: "2025-12-31" }),
      cf({ date: "2025-09-30" }),
      cf({ date: "2025-06-30" }),
    ];

    const ttm = ttmCashFlow(rows);

    expect(ttm).not.toBeNull();
    expect(ttm?.operatingCashFlow).toBe(450);
  });

  it("does not roll current income TTM backward when the newest duplicate is ambiguous", () => {
    const gaps: ManifestEntry[] = [];
    const rows = [
      q({ date: "2026-03-31", filingDate: "2026-05-01", revenue: 900 }),
      q({ date: "2026-03-31", filingDate: "2026-05-01", revenue: 150 }),
      q({ date: "2025-12-31" }),
      q({ date: "2025-09-30" }),
      q({ date: "2025-06-30" }),
      q({ date: "2025-03-31" }),
    ];

    expect(ttmIncome(rows, gaps)).toBeNull();
    expect(gaps.some((gap) => gap.field === "compute.ttmIncome" && /duplicate|ambiguous/i.test(gap.reason))).toBe(true);
    expect(gaps.some((gap) => gap.field === "compute.quarterRows.income" && /2026-03-31/.test(gap.reason))).toBe(true);
  });

  it("does not roll current cash-flow TTM backward when an in-window duplicate is ambiguous", () => {
    const gaps: ManifestEntry[] = [];
    const rows = [
      cf({ date: "2026-03-31" }),
      cf({ date: "2025-12-31", acceptedDate: "2026-02-01 16:00:00" }),
      cf({ date: "2025-12-31", acceptedDate: "2026-02-01 16:00:00" }),
      cf({ date: "2025-09-30" }),
      cf({ date: "2025-06-30" }),
      cf({ date: "2025-03-31" }),
    ];

    expect(ttmCashFlow(rows, gaps)).toBeNull();
    expect(gaps.some((gap) => gap.field === "compute.ttmCashFlow" && /duplicate|ambiguous/i.test(gap.reason))).toBe(true);
    expect(gaps.some((gap) => gap.field === "compute.quarterRows.cashFlow" && /2025-12-31/.test(gap.reason))).toBe(true);
  });

  it("ignores an ambiguous old period numerically but still discloses its rejection", () => {
    const gaps: ManifestEntry[] = [];
    const rows = [
      ...fourFull,
      q({ date: "2024-12-31", filingDate: "2025-02-01" }),
      q({ date: "2024-12-31", filingDate: "2025-02-01" }),
    ];

    const ttm = ttmIncome(rows, gaps);

    expect(ttm?.revenue).toBe(400);
    expect(gaps.some((gap) => gap.field === "compute.quarterRows.income" && /2024-12-31/.test(gap.reason))).toBe(true);
    expect(gaps.some((gap) => gap.field === "compute.ttmIncome")).toBe(false);
  });

  it("ignores a provably old malformed timestamp numerically but still discloses its rejection", () => {
    const gaps: ManifestEntry[] = [];
    const ttm = ttmIncome([q({ date: "2010-12-31T00:00:00Z" }), ...fourFull], gaps);

    expect(ttm?.revenue).toBe(400);
    expect(gaps.some((gap) => gap.field === "compute.quarterRows.income" && /2010-12-31/.test(gap.reason))).toBe(true);
    expect(gaps.some((gap) => gap.field === "compute.ttmIncome")).toBe(false);
  });

  it("rejects an impossible newest calendar date instead of rolling it through Date.parse", () => {
    const gaps: ManifestEntry[] = [];
    const rows = [
      q({ date: "2026-04-31" }),
      ...fourFull,
    ];

    expect(ttmIncome(rows, gaps)).toBeNull();
    expect(gaps.some((gap) => /2026-04-31|invalid fiscal/i.test(gap.reason))).toBe(true);
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

  it("ttmCashFlow normalizes out-of-order rows and rejects an impossible newest date", () => {
    const outOfOrder = [
      cf({ date: "2025-06-30" }),
      cf({ date: "2026-03-31" }),
      cf({ date: "2025-09-30" }),
      cf({ date: "2025-12-31" }),
    ];
    expect(ttmCashFlow(outOfOrder)?.operatingCashFlow).toBe(400);

    const gaps: ManifestEntry[] = [];
    expect(ttmCashFlow([cf({ date: "2026-04-31" }), ...fourCf()], gaps)).toBeNull();
    expect(gaps.some((gap) => /2026-04-31|invalid fiscal/i.test(gap.reason))).toBe(true);
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
  /** Per-quarter currency override for the latest TTM window. */
  quarterlyReportedCurrencies?: readonly (string | null)[];
  /** Revenue per latest TTM quarter before the fixture's $M scaling. */
  quarterlyRevenue?: number;
  /** Replace the quarterly balance rows (empty array = annual fallback). */
  balanceQuarterly?: Record<string, unknown>[];
  /** Drop both cash fields from every annual balance row (no whole row anywhere). */
  annualCashMissing?: boolean;
  /** Null out quarterly weightedAverageShsOutDil (annual-shares fallback). */
  nullQuarterlyShares?: boolean;
  /** Zero quarterly weightedAverageShsOutDil (FMP zero-for-undisclosed sentinel). */
  zeroQuarterlyShares?: boolean;
  /** Route a bank instead of a general company. */
  bank?: boolean;
  /**
   * Route an equity REIT, and make the trailing window differ from the fiscal
   * year (quarterly net income 50 a quarter against FY 150) so a test can tell
   * which period FFO was built on.
   */
  reit?: boolean;
  /** SEC SIC code carried on the EDGAR bundle (Altman variant selection). */
  sic?: string;
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
  /** Drop the FMP key-metrics-TTM row — the keyless (SEC + Yahoo) path has none. */
  noKeyMetricsTtm?: boolean;
  /** Zero the latest annual and TTM-window interest expense (FMP zero-for-undisclosed). */
  zeroInterestExpense?: boolean;
}

function wiringBundle(opts: WiringOpts = {}): DataBundle {
  const rc = opts.reportedCurrency ?? "USD";
  const qRevenue = opts.quarterlyRevenue ?? 250;
  const qReportedCurrency = (index: number): string | null =>
    opts.quarterlyReportedCurrencies === undefined
      ? rc
      : (opts.quarterlyReportedCurrencies[index] ?? null);
  const incomeAnnual = [
    { date: "2025-12-31", fiscalYear: "2025", period: "FY", revenue: 1000, grossProfit: 400, operatingIncome: 200, ebit: 200, netIncome: 150, epsDiluted: 1.5, weightedAverageShsOutDil: 101, interestExpense: 15, incomeBeforeTax: 190, incomeTaxExpense: 40, depreciationAndAmortization: 50, reportedCurrency: rc },
    { date: "2024-12-31", fiscalYear: "2024", period: "FY", revenue: 900, grossProfit: 360, operatingIncome: 180, ebit: 180, netIncome: 140, epsDiluted: 1.4, weightedAverageShsOutDil: 102, interestExpense: 15, incomeBeforeTax: 175, incomeTaxExpense: 35, depreciationAndAmortization: 45, reportedCurrency: rc },
    { date: "2023-12-31", fiscalYear: "2023", period: "FY", revenue: 800, grossProfit: 320, operatingIncome: 160, ebit: 160, netIncome: 130, epsDiluted: 1.27, weightedAverageShsOutDil: 103, interestExpense: 14, incomeBeforeTax: 158, incomeTaxExpense: 28, depreciationAndAmortization: 40, reportedCurrency: rc },
    { date: "2022-12-31", fiscalYear: "2022", period: "FY", revenue: 700, grossProfit: 280, operatingIncome: 140, ebit: 140, netIncome: 110, epsDiluted: 1.06, weightedAverageShsOutDil: 104, interestExpense: 13, incomeBeforeTax: 135, incomeTaxExpense: 25, depreciationAndAmortization: 35, reportedCurrency: rc },
  ];
  const qShs = opts.zeroQuarterlyShares ? 0 : opts.nullQuarterlyShares ? null : 100;
  const incomeQuarterly: Record<string, number | string | null>[] = [
    { date: "2026-03-31", fiscalYear: "2026", period: "Q1", revenue: qRevenue, operatingIncome: 50, ebit: 50, netIncome: 37.5, epsDiluted: 0.375, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 47.5, incomeTaxExpense: 10, depreciationAndAmortization: 12.5, reportedCurrency: qReportedCurrency(0) },
    { date: "2025-12-31", fiscalYear: "2025", period: "Q4", revenue: qRevenue, operatingIncome: 50, ebit: 50, netIncome: 37.5, epsDiluted: 0.375, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 47.5, incomeTaxExpense: 10, depreciationAndAmortization: 12.5, reportedCurrency: qReportedCurrency(1) },
    { date: "2025-09-30", fiscalYear: "2025", period: "Q3", revenue: qRevenue, operatingIncome: 50, ebit: 50, netIncome: 37.5, epsDiluted: 0.375, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 47.5, incomeTaxExpense: 10, depreciationAndAmortization: 12.5, reportedCurrency: qReportedCurrency(2) },
    { date: "2025-06-30", fiscalYear: "2025", period: "Q2", revenue: qRevenue, operatingIncome: 50, ebit: 50, netIncome: 37.5, epsDiluted: 0.375, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 47.5, incomeTaxExpense: 10, depreciationAndAmortization: 12.5, reportedCurrency: qReportedCurrency(3) },
    // Four older quarters so availableQuarters >= 8 (no recent-ipo overlay).
    { date: "2025-03-31", fiscalYear: "2025", period: "Q1", revenue: 240, operatingIncome: 48, ebit: 48, netIncome: 36, epsDiluted: 0.36, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 45.5, incomeTaxExpense: 9.5, depreciationAndAmortization: 12, reportedCurrency: rc },
    { date: "2024-12-31", fiscalYear: "2024", period: "Q4", revenue: 235, operatingIncome: 47, ebit: 47, netIncome: 36, epsDiluted: 0.35, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 45, incomeTaxExpense: 9, depreciationAndAmortization: 12, reportedCurrency: rc },
    { date: "2024-09-30", fiscalYear: "2024", period: "Q3", revenue: 230, operatingIncome: 46, ebit: 46, netIncome: 35, epsDiluted: 0.34, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 44, incomeTaxExpense: 9, depreciationAndAmortization: 11.5, reportedCurrency: rc },
    { date: "2024-06-30", fiscalYear: "2024", period: "Q2", revenue: 225, operatingIncome: 45, ebit: 45, netIncome: 34, epsDiluted: 0.33, weightedAverageShsOutDil: qShs, interestExpense: 4, incomeBeforeTax: 43, incomeTaxExpense: 8.5, depreciationAndAmortization: 11, reportedCurrency: rc },
  ];
  if (opts.reit) {
    // TTM net income 4 x 50 = 200 against FY2025's 150, so the FFO figure names
    // the period it was built on.
    for (let i = 0; i < 4; i++) incomeQuarterly[i].netIncome = 50;
  }
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
  if (opts.zeroInterestExpense) {
    // Latest fiscal year undisclosed; FY2024 (15 on 290 avg debt) still discloses it.
    incomeAnnual[0].interestExpense = 0;
    for (let i = 0; i < 4; i++) incomeQuarterly[i].interestExpense = 0;
  }
  const annualDebt = opts.annualDebt ?? [300, 290];
  const balanceAnnual = [
    { date: "2025-12-31", totalAssets: 2000, totalLiabilities: 1500, totalStockholdersEquity: 500, totalEquity: 500, totalDebt: annualDebt[0], netDebt: 240, cashAndCashEquivalents: 60, cashAndShortTermInvestments: 100, goodwill: 40, intangibleAssets: 10, minorityInterest: 0, preferredStock: 0 },
    { date: "2024-12-31", totalAssets: 1900, totalLiabilities: 1450, totalStockholdersEquity: 450, totalEquity: 450, totalDebt: annualDebt[1], netDebt: 230, cashAndCashEquivalents: 60, cashAndShortTermInvestments: 95, goodwill: 40, intangibleAssets: 10, minorityInterest: 0, preferredStock: 0 },
  ].map((row) => {
    if (!opts.annualCashMissing) return row;
    return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "cashAndCashEquivalents" && key !== "cashAndShortTermInvestments"));
  });
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
    symbol: opts.bank ? "BNK" : opts.reit ? "RET" : "GEN",
    builtAt: BUILT_AT,
    profile: fmpP(
      [{
        companyName: opts.bank ? "Test Bancorp" : opts.reit ? "Test Properties" : "Test General Co",
        sector: opts.bank ? "Financial Services" : opts.reit ? "Real Estate" : "Technology",
        industry: opts.bank ? "Banks - Diversified" : opts.reit ? "REIT - Industrial" : "Consumer Electronics",
        price: 100, marketCap: 10000 * M, beta: 1.0, currency: "USD", country: "US",
        ipoDate: "2000-01-01", isAdr: false, isEtf: false, isFund: false,
      }],
      "2026-07-01",
      "profile",
    ),
    quote: fmpP([{ symbol: opts.bank ? "BNK" : opts.reit ? "RET" : "GEN", price: 100, marketCap: 10000 * M, timestamp: 1751731200 }], "2026-07-05", "quote"),
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
    keyMetricsTtm: opts.noKeyMetricsTtm
      ? gapF
      : fmpP([{ returnOnEquityTTM: 0.12 }], "2026-03-31", "key-metrics-ttm"),
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
    // The SIC reaches Stage B only through the EDGAR bundle; FMP's profile has
    // none. Altman's variant selection is SIC-decisive.
    edgar: { sic: opts.sic ?? null },
  } as unknown as DataBundle;
  return bundle;
}

describe("runStageB wiring — reported currency routing gate", () => {
  it("keeps mixed USD/JPY TTM reported currency unknown, discloses one route gap, and makes no threshold decision", () => {
    const computed = runStageB(
      wiringBundle({
        quarterlyRevenue: 1,
        quarterlyReportedCurrencies: ["USD", "JPY", "USD", "JPY"],
      }),
    );

    expect(computed.route.overlays).not.toContain("pre-revenue");
    const routeCurrencyGaps = computed.route.gaps.filter(
      (g) => g.field === "route.overlays.preRevenue.currency",
    );
    expect(routeCurrencyGaps).toHaveLength(1);
    expect(routeCurrencyGaps[0].reason).toMatch(/ttm revenue.*unknown or invalid.*proven USD/i);
    expect(computed.gaps.filter((g) => g.field === "route.overlays.preRevenue.currency")).toHaveLength(1);
  });

  it("routes agreeing normalized USD TTM reported currency through the strict raw threshold", () => {
    const computed = runStageB(
      wiringBundle({
        quarterlyRevenue: 1,
        quarterlyReportedCurrencies: [" usd ", "USD", "Usd", "  USD"],
      }),
    );

    expect(computed.route.overlays).toContain("pre-revenue");
    expect(computed.route.gaps.some((g) => g.field === "route.overlays.preRevenue.currency")).toBe(false);
  });

  it("keeps complete reported currency inputs compatible with existing routing", () => {
    const computed = runStageB(wiringBundle());

    expect(computed.route.base).toBe("general");
    expect(computed.route.overlays).toEqual([]);
    expect(computed.route.gaps.some((g) => g.field === "route.overlays.preRevenue.currency")).toBe(false);
  });

  it("passes absent TTM as null so annual reported currency fallback provenance remains honest", () => {
    const bundle = wiringBundle();
    if (!bundle.statements.incomeQuarterly.ok) throw new Error("expected quarterly income fixture");
    bundle.statements.incomeQuarterly.value.data.rows =
      bundle.statements.incomeQuarterly.value.data.rows.slice(0, 3);

    const computed = runStageB(bundle);

    expect(computed.route.asOf.incomeTtm).toBeNull();
    expect(computed.route.asOf.incomeAnnual).toBe("2025-12-31");
    expect(computed.route.notes.some((note) => /TTM revenue unavailable.*annual revenue/i.test(note))).toBe(true);
    expect(computed.route.gaps.some((g) => g.field === "route.overlays.preRevenue.currency")).toBe(false);
  });

  it("keeps a suppressed cash-flow TTM distinct from the annual routing fallback", () => {
    const bundle = wiringBundle();
    if (!bundle.statements.cashflowQuarterly.ok) throw new Error("expected quarterly cash-flow fixture");
    bundle.statements.cashflowQuarterly.value.data.rows =
      bundle.statements.cashflowQuarterly.value.data.rows.slice(0, 3);

    const computed = runStageB(bundle);

    expect(computed.route.asOf.cashflowTtm).toBeNull();
    expect(computed.route.asOf.cashflowAnnual).toBe("2025-12-31");
    expect(computed.route.notes.some((note) => /TTM operating cash flow unavailable.*annual OCF/i.test(note))).toBe(true);
  });
});

describe("runStageB wiring — normalized quarterly statement families", () => {
  it("uses uniquely latest whole income, cash-flow, and balance rows across every downstream consumer", () => {
    const bundle = wiringBundle();
    if (
      !bundle.statements.incomeQuarterly.ok ||
      !bundle.statements.cashflowQuarterly.ok ||
      !bundle.statements.balanceQuarterly.ok
    ) {
      throw new Error("expected quarterly statement fixtures");
    }

    const incomeRows = bundle.statements.incomeQuarterly.value.data.rows;
    const cashRows = bundle.statements.cashflowQuarterly.value.data.rows;
    const balanceRows = bundle.statements.balanceQuarterly.value.data.rows;
    const incomeLatest = incomeRows[0];
    const cashLatest = cashRows[0];
    const balanceLatest = balanceRows[0];

    incomeRows.splice(
      0,
      1,
      { ...incomeLatest, acceptedDate: "2026-05-01 15:00:00", revenue: 900 * M, weightedAverageShsOutDil: 5 },
      { ...incomeLatest, acceptedDate: "2026-05-01 16:00:00" },
    );
    // Seven unique periods plus one duplicate: history depth must be seven, not eight raw rows.
    incomeRows.pop();
    cashRows.splice(
      0,
      1,
      { ...cashLatest, acceptedDate: "2026-05-01 15:00:00", operatingCashFlow: 900 * M },
      { ...cashLatest, acceptedDate: "2026-05-01 16:00:00" },
    );
    balanceRows.splice(
      0,
      1,
      { ...balanceLatest, acceptedDate: "2026-05-01 15:00:00", totalDebt: 999 * M },
      { ...balanceLatest, acceptedDate: "2026-05-01 16:00:00" },
    );

    const computed = runStageB(bundle);

    expect(computed.route.asOf.incomeTtm).toBe("2026-03-31");
    expect(computed.route.asOf.cashflowTtm).toBe("2026-03-31");
    expect(computed.route.gaps.some((gap) => gap.field === "route.insufficientHistory")).toBe(true);
    expect(computed.gaps.some((gap) => gap.field.startsWith("compute.quarterRows"))).toBe(false);
    expect(computed.valuation.kind).toBe("dcf");
    if (computed.valuation.kind !== "dcf" || computed.valuation.dcf === null) return;
    expect((computed.valuation.dcf.enterpriseValue - (computed.valuation.dcf.equityValue as number)) / M).toBeCloseTo(160, 6);
    expect((computed.valuation.dcf.equityValue as number) / computed.valuation.dcf.perShare!).toBeCloseTo(100, 6);
  });

  it("does not double-weight a resolvable cash-flow restatement in runway history", () => {
    const bundle = wiringBundle({ quarterlyRevenue: 1 });
    if (!bundle.statements.cashflowQuarterly.ok) throw new Error("expected quarterly cash-flow fixture");
    const rows = bundle.statements.cashflowQuarterly.value.data.rows;
    const latest = rows[0];
    rows.splice(
      0,
      1,
      { ...latest, acceptedDate: "2026-05-01 15:00:00", operatingCashFlow: -900 * M },
      { ...latest, acceptedDate: "2026-05-01 16:00:00" },
    );

    const computed = runStageB(bundle);

    expect(computed.route.overlays).toContain("pre-revenue");
    expect(computed.runway).not.toBeNull();
    expect(computed.runway?.burnWindowDates).toHaveLength(4);
    expect(new Set(computed.runway?.burnWindowDates).size).toBe(4);
    expect(computed.runway?.burnWindowDates.filter((date) => date === "2026-03-31")).toHaveLength(1);
  });
});

describe("runStageB wiring — net debt convention + point-in-time anchors (audit H2/M3/M4)", () => {
  it("keeps provider price rows when missing provider volume propagates into technicals", () => {
    const bundle = wiringBundle();
    const start = Date.parse("2026-01-01T00:00:00Z");
    const eod: Array<{
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume?: number;
    }> = Array.from({ length: 120 }, (_, i) => {
      const close = 100 + i;
      return {
        date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
        open: close,
        high: close,
        low: close,
        close,
        volume: 1_000,
      };
    });
    const spy = eod.map((row, i) => ({
      ...row,
      open: 200 + i,
      high: 200 + i,
      low: 200 + i,
      close: 200 + i,
    }));
    delete eod[119].volume;
    eod[100].volume = Number.NaN;
    eod[80].volume = -1;
    spy[119].volume = -1;
    bundle.eodPrices = fmpP(eod, eod[119].date, "historical-price-eod/full");
    bundle.benchmarkPrices = {
      spy: fmpP(spy, spy[119].date, "historical-price-eod/full"),
      sectorEtf: gapF,
      sectorEtfSymbol: null,
    };

    const computed = runStageB(bundle);
    const p3 = computed.technicals.relativeStrength.benchmark.points.find(
      (point) => point.months === 3,
    );

    expect(computed.technicals.rowsUsed).toBe(120);
    expect(computed.technicals.asOf).toBe(eod[119].date);
    expect(computed.technicals.lastClose).toBe(219);
    expect(computed.technicals.volumeTrend.avg90d).toBeNull();
    expect(computed.technicals.volumeTrend.ratio).toBeNull();
    expect(computed.technicals.volumeTrend.state).toBeNull();
    expect(p3?.benchmarkReturnPct).not.toBeNull();
    expect(
      computed.technicals.notes.some((note) => /SPY:.*unavailable volume/i.test(note)),
    ).toBe(true);
  });

  it("sales-to-capital uses the newest complete whole balance point with quarterly provenance (audit H4)", () => {
    const computed = runStageB(wiringBundle());
    if (computed.valuation.kind !== "dcf") throw new Error("expected dcf kind");
    const assumptions = computed.valuation.assumptions;
    expect(assumptions).not.toBeNull();
    if (assumptions === null) return;

    // TTM revenue = 1000. New quarterly invested capital is the hand-derived
    // whole-row value: 280 debt + 520 equity - 120 cash = 680.
    expect(assumptions.salesToCapital.value).toBeCloseTo(1000 / 680, 12);
    expect(assumptions.salesToCapital.value).toBeCloseTo(1.4705882352941178, 12);
    expect(assumptions.salesToCapital.basis).toContain("2026-03-31");
    expect(assumptions.salesToCapital.basis).toContain("quarter");
  });

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

  it("rejects vendor cash-only netDebt when house-convention components are missing: the whole annual row anchors instead", () => {
    const computed = runStageB(
      wiringBundle({
        balanceQuarterly: [
          // No totalDebt/cash components: derivation impossible on this row; vendor netDebt present.
          { date: "2026-03-31", totalStockholdersEquity: 520, netDebt: 210, minorityInterest: 0, preferredStock: 0 },
        ],
      }),
    );
    if (computed.valuation.kind !== "dcf") throw new Error("expected dcf kind");
    // The newest row is not whole while the 2025-12-31 annual row is, so the
    // anchor falls back to the annual row (disclosed) and the bridge carries
    // its derived 300 − 100 = 200 — never the quarterly vendor 210.
    const dcf = computed.valuation.dcf!;
    expect((dcf.enterpriseValue - (dcf.equityValue as number)) / M).toBeCloseTo(200, 6);
    expect(computed.valuation.notes).toContain(
      "balance anchor: the newest balance row (quarter 2026-03-31) lacks totalDebt and cashAndShortTermInvestments, so net debt, invested capital and the EV bridge use the annual row as of 2025-12-31, the newest row carrying totalDebt, totalStockholdersEquity and cashAndShortTermInvestments",
    );
    expect(computed.gaps.some((g) => g.field === "valuation.balanceAnchor" && g.severity === "info")).toBe(true);
    expect(computed.gaps.some((g) => g.field === "valuation.netDebt")).toBe(false);
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
    // Neither 280 (cash as zero) nor 210 (vendor): the whole annual row anchors.
    const dcf = computed.valuation.dcf!;
    expect((dcf.enterpriseValue - (dcf.equityValue as number)) / M).toBeCloseTo(200, 6);
    expect(computed.valuation.assumptions!.salesToCapital.basis).toContain("annual balance as of 2025-12-31");
    expect(computed.valuation.notes.some((n) => n.startsWith("balance anchor: the newest balance row (quarter 2026-03-31) lacks cashAndShortTermInvestments, so"))).toBe(true);
  });

  it("with no whole balance row anywhere, missing cash is still NOT zero and vendor netDebt is still rejected", () => {
    const computed = runStageB(
      wiringBundle({
        annualCashMissing: true,
        balanceQuarterly: [
          { date: "2026-03-31", totalAssets: 2050, totalLiabilities: 1530, totalStockholdersEquity: 520, totalEquity: 520, totalDebt: 280, netDebt: 210, goodwill: 40, intangibleAssets: 10, minorityInterest: 0, preferredStock: 0 },
        ],
      }),
    );
    if (computed.valuation.kind !== "dcf") throw new Error("expected dcf kind");
    expect(computed.valuation.assumptions).toBeNull();
    expect(computed.valuation.gaps.some((g) => g.field === "valuation.dcf.salesToCapital")).toBe(true);
    expect(computed.valuation.dcf).toBeNull();
    expect(computed.valuation.notes.some((n) => /vendor.*rejected|net debt unavailable/i.test(n))).toBe(true);
    expect(computed.valuation.notes.some((n) => n.startsWith("balance anchor:"))).toBe(false);
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
    const assumptions = computed.valuation.assumptions!;
    // Annual (2025-12-31) derived net debt: 300 − 100 = 200 — not the stale quarterly 160.
    expect((dcf.enterpriseValue - (dcf.equityValue as number)) / M).toBeCloseTo(200, 6);
    // The same selected annual whole row anchors invested capital:
    // 300 debt + 500 equity - 100 cash = 700; TTM revenue = 1000.
    expect(assumptions.salesToCapital.value).toBeCloseTo(1000 / 700, 12);
    expect(assumptions.salesToCapital.basis).toContain("2025-12-31");
    expect(assumptions.salesToCapital.basis).toContain("annual");
    const pb = computed.valuation.multiples.multiples.find((m) => m.key === "priceToBook");
    expect(pb?.basis).toMatch(/annual/i);
    expect(pb?.current).toBeCloseTo(10000 / 500, 9);
  });
});

describe("runStageB wiring — the SEC SIC reaches Altman variant selection", () => {
  // Altman's variant branch is SIC-decisive, but compute.ts passed no SIC to
  // either routeCompany or the forensics classification, and FMP's profile
  // carries none — so the branch was dead code and every company fell to a
  // sector/industry string heuristic. The original 1968 Z is estimated on
  // MANUFACTURERS and puts MARKET equity in X4; Z" drops X5 and uses BOOK
  // equity, so the wrong variant swaps the single largest term in the score.
  it("routes a SIC 3571 manufacturer to the original 1968 Z despite a Technology sector", () => {
    const computed = runStageB(wiringBundle({ sic: "3571" }));

    expect(computed.route.evidence.sic).toBe("3571");
    expect(computed.forensics.altmanSelection.variant).toBe("original");
  });

  it("falls back to the sector heuristic (non-manufacturer) when no SIC is available", () => {
    const computed = runStageB(wiringBundle());

    expect(computed.route.evidence.sic ?? null).toBeNull();
    expect(computed.forensics.altmanSelection.variant).not.toBe("original");
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

/* ---------------------------------------------------------------------------
 * Task 8 — fallbacks the live keyless (SEC + Yahoo) run on JPM needed.
 * ------------------------------------------------------------------------- */

describe("runStageB wiring — keyless excess-return and WACC fallbacks (task 8)", () => {
  // DuPont FY2025: net income 150 / average equity (500 + 450) / 2 = 475.
  const DUPONT_ROE_PCT = (150 / 475) * 100;

  it("bank with no key-metrics TTM: current ROE falls back to the DuPont decomposition", () => {
    const computed = runStageB(wiringBundle({ bank: true, noKeyMetricsTtm: true }));
    expect(computed.returns.dupont.latest?.roePct).toBeCloseTo(DUPONT_ROE_PCT, 9);
    expect(computed.valuation.kind).toBe("excess-return");
    if (computed.valuation.kind !== "excess-return") return;
    const er = computed.valuation.excessReturn;
    // The model RUNS on the statements-derived ROE instead of being suppressed.
    expect(er.roePathPct.value[0]).toBeCloseTo(DUPONT_ROE_PCT, 9);
    expect(er.equityValue).not.toBeNull();
    expect(er.perShare).not.toBeNull();
    expect(er.gaps.some((g) => g.field === "valuation.excessReturn.currentRoe")).toBe(false);
    expect(computed.gaps.some((g) => g.field === "valuation.excessReturn.currentRoe")).toBe(false);
    // The substituted basis is named rather than passed off as the TTM figure.
    expect(
      computed.valuation.notes.some(
        (n) => /DuPont/i.test(n) && /key-metrics TTM unavailable/i.test(n),
      ),
    ).toBe(true);
  });

  it("control: the vendor key-metrics TTM ROE still wins when present, with no DuPont note", () => {
    const computed = runStageB(wiringBundle({ bank: true }));
    expect(computed.valuation.kind).toBe("excess-return");
    if (computed.valuation.kind !== "excess-return") return;
    expect(computed.valuation.excessReturn.roePathPct.value[0]).toBeCloseTo(12, 9);
    expect(computed.valuation.notes.some((n) => /DuPont/i.test(n))).toBe(false);
  });

  it("bank with an undisclosed interest expense: no historical cost-of-debt inference", () => {
    const computed = runStageB(wiringBundle({ bank: true, zeroInterestExpense: true }));
    const w = computed.returns.wacc;
    // Deposits fund a bank; interest expense / long-term debt is not its cost of
    // debt, and the financial route's valuation never consumes the figure.
    expect(w.costOfDebtMethod).toBe("unavailable");
    expect(w.costOfDebtPct).toBeNull();
    expect(computed.returns.notes.some((n) => /cost of debt taken from FY/i.test(n))).toBe(false);
    expect(
      computed.returns.gaps.some(
        (g) => g.field === "returns.wacc.interestExpense" && /inferred from the FY/i.test(g.reason),
      ),
    ).toBe(false);
    // ...and the gap that replaces it is a WARNING. A critical one would make
    // buildDataCompleteness report state "blocked" (completeness.ts), re-blocking
    // the very keyless bank report the DuPont ROE fallback above unblocks.
    const gap = computed.returns.gaps.find((g) => g.field === "returns.wacc.interestExpense");
    expect(gap?.severity).toBe("warn");
    expect(gap?.reason).toMatch(/costed on equity alone/i);
    expect(
      computed.gaps.some(
        (g) => g.field === "returns.wacc.interestExpense" && g.severity === "critical",
      ),
    ).toBe(false);
    // Existing behaviour is otherwise untouched: cost of equity is still carried.
    expect(w.costOfEquityPct).not.toBeNull();
  });

  it("control: a non-financial route still infers the historical cost of debt", () => {
    const computed = runStageB(wiringBundle({ zeroInterestExpense: true }));
    const w = computed.returns.wacc;
    // FY2024 interest 15 / 290 (no FY2023 balance row to average) ≈ 5.17%.
    expect(w.costOfDebtMethod).toBe("historical");
    expect(w.costOfDebtPct).toBeCloseTo((15 / 290) * 100, 9);
    expect(
      computed.returns.gaps.some(
        (g) => g.field === "returns.wacc.interestExpense" && /inferred from the FY 2024-12-31/i.test(g.reason),
      ),
    ).toBe(true);
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

describe("runStageB wiring — FFO is built on ONE period, and carries that period's as-of", () => {
  it("builds FFO on the latest fiscal year and labels the REIT block with the FFO period end", () => {
    // computeNareitFfo resolves its XBRL components at the ANNUAL period end,
    // so passing trailing net income, D&A and capex as the fallbacks made the
    // fallback path a hybrid — a fiscal-year figure where the tags resolved, a
    // trailing one where they did not — while the block still carried the
    // trailing income date as its as-of. Here FY2025 net income is 150 and the
    // trailing window is 200, so the printed basis names the period used.
    const computed = runStageB(wiringBundle({ reit: true }));

    expect(computed.valuation.kind).toBe("reit");
    if (computed.valuation.kind !== "reit") throw new Error("expected the REIT valuation branch");
    // The as-of is the FFO period end (FY2025), not the trailing income date
    // 2026-03-31 the block used to carry.
    expect(computed.valuation.reit.asOf).toBe("2025-12-31");

    const notes = [...computed.valuation.notes, ...computed.valuation.reit.notes].join(" ");
    expect(notes).toContain("net income 150000000");
    expect(notes).not.toContain("net income 200000000");
    expect(notes).toContain("FISCAL YEAR ending 2025-12-31");
    expect(notes).toContain("not on a trailing twelve months");
  });
});

describe("routeMetricsBlock — the report-ready route metrics, and nothing on other routes", () => {
  it("carries every computed bank metric plus the P/TBV-against-ROTE reading", () => {
    const block = routeMetricsBlock(runStageB(wiringBundle({ bank: true })));

    expect(block).not.toBeNull();
    expect(block?.route).toBe("bank");
    const keys = (block?.metrics ?? []).map((m) => m.key);
    // The pairing a financial is actually judged on...
    for (const key of ["pTbv", "rote", "justifiedPTbv", "premiumToJustified"]) {
      expect(keys, key).toContain(key);
    }
    // ...and the route metrics themselves, computed or withheld with a reason.
    for (const key of ["nim", "efficiencyRatio", "provisionsToLoans", "depositCost"]) {
      expect(keys, key).toContain(key);
    }
    for (const m of block?.metrics ?? []) {
      // Never a value AND a withholding, and never a blank with no reason.
      if (m.value === null) expect(m.withheldReason, m.key).not.toBeNull();
      else expect(m.withheldReason, m.key).toBeNull();
    }
  });

  it("returns null on the general route, so an ordinary report gains no empty block", () => {
    expect(routeMetricsBlock(runStageB(wiringBundle()))).toBeNull();
  });
});
