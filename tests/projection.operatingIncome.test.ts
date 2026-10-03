import { describe, expect, it } from "vitest";

import { priorYearCostOfDebt, runStageB } from "@/pipeline/compute";
import type { DataBundle } from "@/pipeline/types";
import { currencyBundle, M } from "./helpers/currencyBundle";

/** Synthetic issuer: positive non-operating gains make vendor EBIT exceed operating income. */
function operatingBundle(broadVendorEbit: boolean): DataBundle {
  const bundle = currencyBundle({ siblingQuarterCurrencies: ["USD", "USD", "USD", "USD"] });
  for (const result of [bundle.statements.incomeAnnual, bundle.statements.incomeQuarterly]) {
    if (!result.ok) throw new Error("expected income fixture");
    for (const row of result.value.data.rows) {
      row.ebit = (row.operatingIncome ?? 0) + (broadVendorEbit ? 300 * M : 0);
    }
  }
  return bundle;
}

describe("operating projections use operating income rather than broader vendor EBIT", () => {
  it("labels the synthetic FY2025 operating margin as 200 / 1000 = 20%", () => {
    const computed = runStageB(operatingBundle(true));
    const margin = computed.projections.series.find((s) => s.metric === "operatingMargin");
    expect(margin?.historical.find((p) => p.period === "FY2025")?.value.value).toBe(20);
  });

  it("non-operating gains cannot change operating scenario dispersion, targets or projected EPS", () => {
    const control = runStageB(operatingBundle(false));
    const broad = runStageB(operatingBundle(true));
    expect(control.projections.series.length).toBeGreaterThan(0);
    expect(control.scenarioTargets.targets.length).toBeGreaterThan(0);
    expect(broad.projections).toEqual(control.projections);
    expect(broad.scenarioTargets).toEqual(control.scenarioTargets);
  });

  it("does not fill a missing historical operating margin with vendor EBIT", () => {
    const bundle = operatingBundle(true);
    if (!bundle.statements.incomeAnnual.ok) throw new Error("expected income fixture");
    delete bundle.statements.incomeAnnual.value.data.rows[0]!.operatingIncome;
    const computed = runStageB(bundle);
    const margin = computed.projections.series.find((s) => s.metric === "operatingMargin");
    expect(margin).toBeDefined();
    expect(margin?.historical.some((p) => p.period === "FY2025")).toBe(false);
  });

  it("does not substitute broader vendor EBIT for an unavailable operating return or capital coverage", () => {
    const bundle = operatingBundle(true);
    if (!bundle.statements.incomeAnnual.ok) throw new Error("expected income fixture");
    delete bundle.statements.incomeAnnual.value.data.rows[0]!.operatingIncome;
    const computed = runStageB(bundle);
    expect(computed.returns.roic.series.find((p) => p.date === "2025-12-31")?.roicPct).toBeNull();
    expect(computed.capital.interestCoverage.value).toBeNull();
  });
});

describe("WACC coverage uses the same operating-income definition", () => {
  it("TTM synthetic coverage is 240 operating income / 400 interest = 0.6, excluding non-operating gains", () => {
    const bundle = operatingBundle(true);
    if (!bundle.statements.incomeQuarterly.ok) throw new Error("expected income fixture");
    for (const row of bundle.statements.incomeQuarterly.value.data.rows) row.interestExpense = 100 * M;
    const computed = runStageB(bundle);
    expect(computed.returns.wacc.costOfDebtMethod).toBe("synthetic");
    expect(computed.returns.wacc.interestCoverageRatio).toBeCloseTo(0.6, 9);
  });

  it("a missing TTM operating-income leg uses the complete annual pair rather than vendor EBIT", () => {
    const bundle = operatingBundle(true);
    if (!bundle.statements.incomeQuarterly.ok) throw new Error("expected income fixture");
    for (const row of bundle.statements.incomeQuarterly.value.data.rows) {
      delete row.operatingIncome;
      row.interestExpense = 100 * M;
    }
    const computed = runStageB(bundle);
    // Annual interest 15 / average annual debt 300 = 5%, in the acceptance band.
    expect(computed.returns.wacc.costOfDebtMethod).toBe("effective");
    expect(computed.returns.wacc.costOfDebtPct).toBeCloseTo(5, 9);
    expect(computed.returns.wacc.debtBasis).toMatch(/fiscal-year-end/);
  });

  it("annual fallback cannot use vendor EBIT when operating income is missing too", () => {
    const bundle = operatingBundle(true);
    for (const result of [bundle.statements.incomeAnnual, bundle.statements.incomeQuarterly]) {
      if (!result.ok) throw new Error("expected income fixture");
      for (const row of result.value.data.rows) {
        delete row.operatingIncome;
        row.interestExpense = 100 * M;
      }
    }
    const computed = runStageB(bundle);
    expect(computed.returns.wacc.interestCoverageRatio).toBeNull();
    expect(computed.returns.wacc.syntheticRating).toBeNull();
  });

  it("historical coverage carries operating income, and leaves it missing when unavailable", () => {
    const income = [
      { date: "2025-12-31", interestExpense: 0 },
      { date: "2024-12-31", interestExpense: 15, operatingIncome: 180, ebit: 480 },
    ];
    const balances = [
      { date: "2024-12-31", totalDebt: 300 },
      { date: "2023-12-31", totalDebt: 300 },
    ];
    expect(priorYearCostOfDebt(income, balances)?.ebit).toBe(180);
    expect(priorYearCostOfDebt([income[0]!, { ...income[1]!, operatingIncome: undefined }], balances)?.ebit).toBeNull();
  });
});
