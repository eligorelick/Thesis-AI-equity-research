/**
 * The currency of a trailing four-quarter window, established from evidence.
 *
 *  - Each quarter is KNOWN (its own label, or a label on another statement of
 *    the SAME FILING), UNKNOWN (no evidence) or in CONFLICT (evidence names
 *    two currencies). The three stay distinct.
 *  - A shared period-end date is not a shared filing: another statement's
 *    label is borrowed only through a filing identity both rows carry (the
 *    SEC acceptance timestamp, and the CIK when both state one).
 *  - A window whose currency is not established is not a sum at all — not
 *    for the DCF, and not for the "dimensionless" ratios built on its sums
 *    (interest coverage, the cost of debt, routing signs). Those fall back to
 *    the latest annual statement, whose own-period ratios stay valid; a window
 *    established in one currency keeps its within-window ratios even when the
 *    annual statement is in another.
 *
 * Real Stage B over tests/helpers/currencyBundle.ts. The fixture's TTM
 * interest is 4 × 4 = 16 against the FY2025 annual 15, both over 300 of
 * average debt, so the cost of debt reads 5.33% on the TTM basis and 5.00% on
 * the annual one; TTM revenue is 1,200 against the annual 1,000.
 */
import { describe, expect, it } from "vitest";

import { runStageB, ttmCashFlow, ttmIncome, type ComputedMetrics } from "@/pipeline/compute";
import type { FmpCashFlowRow, FmpIncomeStatementRow } from "@/providers/fmp";
import type { ManifestEntry } from "@/types/core";

import { M, currencyBundle, type CurrencyBundleOptions } from "./helpers/currencyBundle";

const UNLABELLED = [null, null, null, null] as const;
const TTM_COST_OF_DEBT = (16 / 300) * 100;
const ANNUAL_COST_OF_DEBT = (15 / 300) * 100;

function run(opts: CurrencyBundleOptions): ComputedMetrics {
  return runStageB(currencyBundle(opts));
}

function startRevenue(c: ComputedMetrics): number | undefined {
  return c.valuation.kind === "dcf" ? c.valuation.assumptions?.startRevenue.value : undefined;
}

function incomeGap(c: ComputedMetrics): ManifestEntry | undefined {
  return c.gaps.find((g) => g.field === "compute.ttmIncome.currency" || g.field === "compute.ttmIncome");
}

/** The TTM window was used: DCF anchor, cost of debt and routing all read it. */
function expectTtmBasis(c: ComputedMetrics): void {
  expect(startRevenue(c)).toBe(1200 * M);
  expect(c.returns.wacc.costOfDebtPct).toBeCloseTo(TTM_COST_OF_DEBT, 9);
  expect(c.route.asOf.incomeTtm).toBe("2026-03-31");
}

/** Every consumer fell back to the FY2025 annual statement. */
function expectAnnualBasis(c: ComputedMetrics): void {
  expect(startRevenue(c)).toBe(1000 * M);
  expect(c.returns.wacc.costOfDebtPct).toBeCloseTo(ANNUAL_COST_OF_DEBT, 9);
  expect(c.route.asOf.incomeTtm).toBeNull();
}

describe("a quarter's currency from another statement needs a shared filing", () => {
  it("control: USD-labelled quarters are summed", () => {
    expectTtmBasis(run({}));
  });

  it("borrows the balance-sheet and cash-flow label of the SAME filing", () => {
    const c = run({ quarterCurrencies: UNLABELLED, siblingQuarterCurrencies: ["USD", "USD", "USD", "USD"], filingLinks: "shared" });
    expectTtmBasis(c);
    expect(incomeGap(c)).toBeUndefined();
  });

  it("does not borrow from rows that merely share a period-end date", () => {
    const c = run({ quarterCurrencies: UNLABELLED, siblingQuarterCurrencies: ["USD", "USD", "USD", "USD"], filingLinks: "none" });
    expectAnnualBasis(c);
    expect(incomeGap(c)?.reason).toMatch(/not linked to the same filing|no .*filing/i);
  });

  it("control: a non-USD window linked by filing is established in that currency", () => {
    const c = run({
      profileCurrency: "JPY",
      annualCurrency: "JPY",
      quarterCurrencies: UNLABELLED,
      siblingQuarterCurrencies: ["JPY", "JPY", "JPY", "JPY"],
      filingLinks: "shared",
    });
    expectTtmBasis(c);
    expect(c.fairValue.perShare?.unit).toBe("JPY/share");
  });
});

describe("conflicting evidence stays a conflict", () => {
  it("does not collapse same-filing siblings in two currencies into 'unknown'", () => {
    const c = run({
      quarterCurrencies: UNLABELLED,
      balanceQuarterCurrencies: ["USD", "USD", "USD", "USD"],
      cashflowQuarterCurrencies: ["EUR", "USD", "USD", "USD"],
      filingLinks: "shared",
    });
    expectAnnualBasis(c);
    const reasons = c.gaps.filter((g) => g.field.startsWith("compute.ttmIncome")).map((g) => g.reason).join(" | ");
    expect(reasons).toMatch(/conflict/i);
    expect(reasons).toMatch(/2026-03-31/);
    expect(reasons).toMatch(/EUR/);
    expect(reasons).toMatch(/USD/);
    expect(reasons).not.toMatch(/could not be established/);
  });

  it("treats a quarter's own label contradicted by its own filing's other statements as a conflict", () => {
    const c = run({
      quarterCurrencies: ["USD", "USD", "USD", "USD"],
      siblingQuarterCurrencies: ["USD", "USD", "TWD", "USD"],
      filingLinks: "shared",
    });
    expectAnnualBasis(c);
    expect(c.gaps.find((g) => g.field === "compute.ttmIncome")?.reason).toMatch(/conflict[^|]*2025-09-30/i);
  });

  it("keeps the three states apart at the window level (direct TTM builder)", () => {
    const row = (date: string, code: string | null, acceptedDate?: string): FmpIncomeStatementRow =>
      ({ date, revenue: 1, interestExpense: 1, ...(code === null ? {} : { reportedCurrency: code }), ...(acceptedDate ? { acceptedDate } : {}) }) as FmpIncomeStatementRow;
    const dates = ["2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30"];
    const filed = (d: string) => `${d} 20:00:00`;

    const known: ManifestEntry[] = [];
    expect(ttmIncome(dates.map((d) => row(d, "USD")), known)?.reportedCurrency).toBe("USD");
    expect(known).toEqual([]);

    const unknown: ManifestEntry[] = [];
    expect(ttmIncome(dates.map((d) => row(d, null)), unknown)).toBeNull();
    expect(unknown.map((g) => g.reason).join()).toMatch(/could not be established/);
    expect(unknown.map((g) => g.reason).join()).not.toMatch(/conflict/i);

    const conflict: ManifestEntry[] = [];
    const siblings = [
      ...dates.map((d) => ({ date: d, reportedCurrency: "USD", acceptedDate: filed(d) })),
      { date: dates[1], reportedCurrency: "GBP", acceptedDate: filed(dates[1]!) },
    ];
    expect(ttmIncome(dates.map((d) => row(d, null, filed(d))), conflict, siblings)).toBeNull();
    expect(conflict.map((g) => g.reason).join()).toMatch(/conflict.*2025-12-31.*(GBP.*USD|USD.*GBP)/i);

    // The cash-flow window follows the same rules.
    const cf: ManifestEntry[] = [];
    expect(
      ttmCashFlow(dates.map((d) => ({ date: d, operatingCashFlow: 1 }) as FmpCashFlowRow), cf, dates.map((d) => ({ date: d, reportedCurrency: "USD" }))),
    ).toBeNull();
    expect(cf.map((g) => g.reason).join()).toMatch(/not linked to the same filing/);
  });
});

describe("ratios over a window's sums need the window in one established currency", () => {
  it("an unlabelled window feeds no coverage, cost of debt or routing sign — the annual statement does", () => {
    const c = run({ quarterCurrencies: UNLABELLED });
    expectAnnualBasis(c);
  });

  it("a window in one known currency keeps its within-window uses, but is never divided by debt in another", () => {
    // A currency change: quarters in TWD, the last annual statements in USD.
    // The DCF anchors on the annual statement; routing still reads the TWD
    // window's own sums. The cost of debt would divide TWD interest by the
    // USD fiscal-year-end debt, so it moves to the annual basis instead:
    // USD interest over USD debt.
    const c = run({
      quarterCurrencies: ["TWD", "TWD", "TWD", "TWD"],
      siblingQuarterCurrencies: ["TWD", "TWD", "TWD", "TWD"],
      filingLinks: "shared",
    });
    expect(startRevenue(c)).toBe(1000 * M);
    expect(c.route.asOf.incomeTtm).toBe("2026-03-31");
    expect(c.gaps.find((g) => g.field === "compute.ttmIncome.currency")?.reason).toMatch(/TWD/);
    expect(c.returns.wacc.costOfDebtPct).toBeCloseTo(ANNUAL_COST_OF_DEBT, 9);
    expect(c.returns.notes.join(" ")).toMatch(/TWD.*USD|currenc/i);
  });
});

describe("the runway divides liquidity by an average of quarterly burn", () => {
  const USD_FILINGS = { burning: true, filingLinks: "shared", siblingQuarterCurrencies: ["USD", "USD", "USD", "USD"] } as const;

  it("control: burn quarters and liquidity in one currency give a runway", () => {
    const rw = run(USD_FILINGS).runway;
    expect(rw?.avgQuarterlyBurn).toBe(65 * M);
    expect(rw?.liquidAssets).toBe(120 * M);
    expect(rw?.runwayQuarters).toBeCloseTo(120 / 65, 9);
  });

  it("does not average burn quarters whose currency is not established", () => {
    const c = run({ ...USD_FILINGS, filingLinks: "none", siblingQuarterCurrencies: UNLABELLED });
    expect(c.runway?.avgQuarterlyBurn ?? null).toBeNull();
    expect(c.runway?.runwayQuarters ?? null).toBeNull();
    expect(c.runway?.estimatedExhaustionDate ?? null).toBeNull();
    // The quarter-end liquidity is one row: still stated.
    expect(c.runway?.liquidAssets).toBe(120 * M);
    expect(c.gaps.find((g) => g.field === "runway.currency")?.reason).toMatch(/burn/);
  });

  it("does not divide liquidity by a burn in another currency", () => {
    // Each row labelled in its own right, no filing linkage (linked, EUR cash
    // flows beside USD balance sheets would be a conflict, not a currency).
    const c = run({
      ...USD_FILINGS,
      filingLinks: "none",
      cashflowQuarterCurrencies: ["EUR", "EUR", "EUR", "EUR"],
      balanceQuarterCurrencies: ["USD", "USD", "USD", "USD"],
    });
    expect(c.runway?.avgQuarterlyBurn).toBe(65 * M);
    expect(c.runway?.liquidAssets).toBe(120 * M);
    expect(c.runway?.runwayQuarters ?? null).toBeNull();
    expect(c.gaps.find((g) => g.field === "runway.currency")?.reason).toMatch(/EUR.*USD|USD.*EUR/);
  });
});
