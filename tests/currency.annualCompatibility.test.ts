/**
 * Calculations that combine separate statements (income with balance sheet or
 * cash flow) or separate years need every row they combine established in ONE
 * currency — the model's. A row labelled in another currency, or carrying no
 * label at all, is not compatible by default: it is excluded from those
 * calculations with a disclosed reason, and anything built on them is
 * withheld. No exchange rate is ever invented.
 *
 * Ratios within one statement row (a margin) stay: a row is one presentation
 * currency, whatever it is.
 *
 * Every expected value below is worked from tests/helpers/currencyBundle.ts
 * (millions). The quarters are unlabelled, so the trailing window is withheld
 * and every consumer takes the ANNUAL fallback:
 *   cost of debt   = FY2025 interest 15 / avg debt (300 + 300) / 2        = 5%
 *   net debt/EBITDA= (debt 300 − cash & STI 100) / (EBIT 200 + D&A 50)     = 0.8
 *   ROE (DuPont)   = FY2025 net income 150 / avg equity (500 + 450) / 2    = 31.58%
 *   revenue YoY    = 1000 / 900 − 1                                          = 11.11%
 *   FCF conversion = (OCF 220 − capex 40 − SBC 10) / net income 150         = 1.1333
 *   capex / revenue= 40 / 1000                                               = 4%
 *   gross margin   = 400/1000, 360/900, 320/800, 280/700                     = 40% each
 */
import { describe, expect, it } from "vitest";

import { runStageB, type ComputedMetrics } from "@/pipeline/compute";

import { currencyBundle, type CurrencyBundleOptions } from "./helpers/currencyBundle";

const UNLABELLED_QUARTERS = [null, null, null, null] as const;

function run(opts: CurrencyBundleOptions): ComputedMetrics {
  return runStageB(currencyBundle({ quarterCurrencies: UNLABELLED_QUARTERS, ...opts }));
}

function dcfPerShare(c: ComputedMetrics): number | null {
  return c.valuation.kind === "dcf" ? (c.valuation.dcf?.perShare ?? null) : null;
}

function gap(c: ComputedMetrics, field: string): string | undefined {
  return c.gaps.find((g) => g.field === field)?.reason;
}

/** Within-row and same-currency results that no currency gate may disturb. */
function expectIncomeOnlyFiguresKept(c: ComputedMetrics): void {
  expect(c.growth.margins.gross.series.map((p) => p.pct)).toEqual([40, 40, 40, 40]);
}

describe("controls: one established currency throughout", () => {
  for (const [label, opts] of [
    ["USD", {}],
    ["JPY", { profileCurrency: "JPY", annualCurrency: "JPY" }],
  ] as const) {
    it(`${label}: 15 interest / 300 debt = 5%, and every combined figure is computed`, () => {
      const c = run(opts);
      expect(c.returns.wacc.costOfDebtPct).toBeCloseTo(5, 9);
      expect(c.returns.wacc.waccPct).not.toBeNull();
      expect(c.returns.roic.latestRoicPct).not.toBeNull();
      expect(c.returns.dupont.latest?.roePct).toBeCloseTo((150 / 475) * 100, 9);
      expect(c.capital.netDebtToEbitda.value).toBeCloseTo(0.8, 9);
      expect(c.growth.revenueAcceleration.latestYoyPct).toBeCloseTo((1000 / 900 - 1) * 100, 9);
      expect(c.capital.fcf.latestConversion).toBeCloseTo(170 / 150, 9);
      expect(dcfPerShare(c)).not.toBeNull();
      expectIncomeOnlyFiguresKept(c);
      expect(c.gaps.filter((g) => /^compute\.(income|balance|cashflow)Annual\.currency$/.test(g.field))).toEqual([]);
    });
  }
});

describe("USD income with JPY balance sheets", () => {
  const c = run({ balanceAnnualCurrencies: ["JPY", "JPY"] });

  it("does not divide USD interest by JPY debt", () => {
    expect(c.returns.wacc.costOfDebtPct).toBeNull();
    expect(c.returns.wacc.waccPct).toBeNull();
    expect(gap(c, "compute.balanceAnnual.currency")).toMatch(/JPY/);
    expect(gap(c, "compute.balanceAnnual.currency")).toMatch(/USD/);
    expect(gap(c, "compute.balanceAnnual.currency")).toMatch(/no (FX|exchange)/i);
  });

  it("withholds the returns and valuation that combine them", () => {
    expect(c.returns.roic.latestRoicPct).toBeNull();
    expect(c.returns.dupont.latest?.roePct ?? null).toBeNull();
    expect(c.capital.netDebtToEbitda.value).toBeNull();
    expect(dcfPerShare(c)).toBeNull();
    expect(c.fairValue.upsidePct).toBeNull();
  });

  it("keeps what never touches the balance sheet", () => {
    expect(c.growth.revenueAcceleration.latestYoyPct).toBeCloseTo((1000 / 900 - 1) * 100, 9);
    expect(c.capital.fcf.latestConversion).toBeCloseTo(170 / 150, 9);
    expect(c.capital.capexIntensity.latestPct).toBeCloseTo(4, 9);
    expectIncomeOnlyFiguresKept(c);
  });

  it("stays withheld when the trailing window is usable too", () => {
    // USD quarters give a TTM; its interest still may not meet JPY debt.
    const ttm = runStageB(currencyBundle({ balanceAnnualCurrencies: ["JPY", "JPY"] }));
    expect(ttm.returns.wacc.costOfDebtPct).toBeNull();
    expect(ttm.returns.roic.latestRoicPct).toBeNull();
  });
});

describe("missing currency evidence establishes nothing", () => {
  it("unlabelled balance sheets are not assumed to be in the income statement's USD", () => {
    const c = run({ balanceAnnualCurrencies: [null, null] });
    expect(c.returns.wacc.costOfDebtPct).toBeNull();
    expect(c.returns.roic.latestRoicPct).toBeNull();
    expect(c.capital.netDebtToEbitda.value).toBeNull();
    expect(dcfPerShare(c)).toBeNull();
    expect(gap(c, "compute.balanceAnnual.currency")).toMatch(/not established|unknown/i);
    expectIncomeOnlyFiguresKept(c);
  });

  it("unlabelled cash flows are not assumed to be in USD either", () => {
    const c = run({ cashflowAnnualCurrencies: [null, null, null] });
    expect(c.capital.fcf.latestConversion).toBeNull();
    expect(c.capital.capexIntensity.latestPct).toBeNull();
    expect(gap(c, "compute.cashflowAnnual.currency")).toMatch(/not established|unknown/i);
    // The balance-sheet side is still USD with USD income.
    expect(c.returns.wacc.costOfDebtPct).toBeCloseTo(5, 9);
  });
});

describe("a year in another currency breaks the history there", () => {
  const c = run({ incomeAnnualCurrencies: ["USD", "EUR", "USD", "USD"] });

  it("computes no growth across the USD/EUR break", () => {
    expect(c.growth.revenueAcceleration.latestYoyPct).toBeNull();
    expect(c.growth.revenueCagrs.every((p) => p.cagrPct === null)).toBe(true);
    expect(gap(c, "compute.incomeAnnual.currency")).toMatch(/2024-12-31[^|]*EUR/);
  });

  it("keeps the same-year, same-currency figures and every row's margin", () => {
    expect(c.returns.wacc.costOfDebtPct).toBeCloseTo(5, 9);
    // DuPont averages equity with the balance sheet of the PRIOR INCOME year;
    // FY2024's income is out, so FY2025 is read on year-end equity: 150 / 500.
    expect(c.returns.dupont.latest?.roePct).toBeCloseTo((150 / 500) * 100, 9);
    expect(c.capital.netDebtToEbitda.value).toBeCloseTo(0.8, 9);
    expectIncomeOnlyFiguresKept(c);
  });
});
