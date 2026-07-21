/**
 * Stage B tests — growth, returns (WACC/ROIC/DuPont), cash & capital.
 * Pure, no network. Anchors from the valuation methodology:
 * - SPREADS_2026_01 (Damodaran Jan-2026 ratings.html, verbatim)
 * - Blume example: beta 1.42 → 1.2814 → 1.28; Re ≈ 10.19% at rf 4.48 / ERP 4.46
 */

import { describe, expect, it } from "vitest";

import {
  cagrForWindow,
  computeGrowth,
  linearRegressionSlope,
  type GrowthCashFlowRow,
  type GrowthIncomeRow,
} from "@/pipeline/stageB/growth";
import {
  ERP_FALLBACK_PCT,
  SPREADS_2026_01,
  computeDupont,
  computeRoic,
  computeRoicVsWaccSpread,
  computeWacc,
  lookupSyntheticSpread,
  type ReturnsBalanceRow,
  type ReturnsIncomeRow,
  type WaccInputs,
} from "@/pipeline/stageB/returns";
import {
  computeCapital,
  type CapitalBalanceRow,
  type CapitalCashFlowRow,
  type CapitalIncomeRow,
  type MarketCapPoint,
} from "@/pipeline/stageB/capital";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function annualIncomeRows(
  values: ReadonlyArray<Partial<GrowthIncomeRow> & { revenue?: number | null }>,
  lastYear = 2025,
): GrowthIncomeRow[] {
  // values oldest → newest; returned newest-first like FMP.
  const n = values.length;
  return values
    .map((v, i) => ({ date: `${lastYear - (n - 1 - i)}-12-31`, ...v }))
    .reverse();
}

// ===========================================================================
// growth.ts
// ===========================================================================

describe("computeGrowth — CAGR exactness and windows", () => {
  it("computes exact CAGRs across all windows for clean 10% compounding", () => {
    const values = Array.from({ length: 11 }, (_, k) => ({ revenue: 100 * Math.pow(1.1, k) }));
    const income = annualIncomeRows(values);
    const res = computeGrowth(income, [], { period: "annual" });

    for (const point of res.revenueCagrs) {
      expect(point.cagrPct).not.toBeNull();
      expect(point.cagrPct as number).toBeCloseTo(10, 8);
      expect(point.actualYears).toBe(point.windowYears);
      expect(point.note ?? "").not.toContain("only");
    }
    expect(res.asOf).toBe("2025-12-31");
  });

  it("100 → 200 over 5 years is exactly (2^(1/5) − 1)", () => {
    const income = annualIncomeRows([
      { revenue: 100 },
      { revenue: 120 },
      { revenue: 130 },
      { revenue: 150 },
      { revenue: 170 },
      { revenue: 200 },
    ]);
    const res = computeGrowth(income, [], { period: "annual" });
    const p5 = res.revenueCagrs.find((c) => c.windowYears === 5);
    expect(p5?.cagrPct).toBeCloseTo((Math.pow(2, 1 / 5) - 1) * 100, 10);
    expect(p5?.startValue).toBe(100);
    expect(p5?.endValue).toBe(200);
    expect(p5?.startDate).toBe("2020-12-31");
    expect(p5?.endDate).toBe("2025-12-31");
  });

  it("degrades the 10y window to available history and annotates the actual span", () => {
    const income = annualIncomeRows([
      { revenue: 100 },
      { revenue: 110 },
      { revenue: 120 },
      { revenue: 130 },
      { revenue: 140 },
      { revenue: 150 },
    ]); // 6 rows → 5 years of span
    const res = computeGrowth(income, [], { period: "annual" });
    const p10 = res.revenueCagrs.find((c) => c.windowYears === 10);
    expect(p10?.actualYears).toBe(5);
    expect(p10?.cagrPct).toBeCloseTo((Math.pow(1.5, 1 / 5) - 1) * 100, 10);
    expect(p10?.note).toContain("only 5y");
  });

  it("returns null CAGR + note across sign flips (negative → positive EPS)", () => {
    const income = annualIncomeRows([
      { epsDiluted: -1, revenue: 100 },
      { epsDiluted: 0.5, revenue: 110 },
      { epsDiluted: 1.2, revenue: 120 },
      { epsDiluted: 2, revenue: 130 },
    ]);
    const res = computeGrowth(income, [], { period: "annual" });
    const p3 = res.epsDilutedCagrs.find((c) => c.windowYears === 3);
    expect(p3?.cagrPct).toBeNull();
    expect(p3?.note).toContain("sign flip");
    expect(p3?.startValue).toBe(-1);
    expect(p3?.endValue).toBe(2);
    // 1y window (0.5 → ... wait: newest-first ⇒ 1y = 1.2 → 2) is fine and positive
    const p1 = res.epsDilutedCagrs.find((c) => c.windowYears === 1);
    expect(p1?.cagrPct).toBeCloseTo((2 / 1.2 - 1) * 100, 10);
  });

  it("derives FCF from operatingCashFlow + capitalExpenditure when freeCashFlow missing", () => {
    const cashflow: GrowthCashFlowRow[] = [
      { date: "2025-12-31", operatingCashFlow: 150, capitalExpenditure: -30 },
      { date: "2024-12-31", operatingCashFlow: 120, capitalExpenditure: -20 },
    ];
    const res = computeGrowth([], cashflow, { period: "annual" });
    const p1 = res.fcfCagrs.find((c) => c.windowYears === 1);
    expect(p1?.startValue).toBe(100);
    expect(p1?.endValue).toBe(120);
    expect(p1?.cagrPct).toBeCloseTo(20, 10);
    expect(res.notes.join(" ")).toContain("operatingCashFlow + capitalExpenditure");
  });

  it("margin series is oldest→newest with an exact regression slope", () => {
    const income = annualIncomeRows([
      { revenue: 100, grossProfit: 50, operatingIncome: 20, netIncome: 10 },
      { revenue: 100, grossProfit: 51, operatingIncome: 20, netIncome: 10 },
      { revenue: 100, grossProfit: 52, operatingIncome: 20, netIncome: 10 },
      { revenue: 100, grossProfit: 53, operatingIncome: 20, netIncome: 10 },
      { revenue: 100, grossProfit: 54, operatingIncome: 20, netIncome: 10 },
      { revenue: 100, grossProfit: 55, operatingIncome: 20, netIncome: 10 },
    ]);
    const res = computeGrowth(income, [], { period: "annual" });
    const gross = res.margins.gross;
    const expected = [50, 51, 52, 53, 54, 55];
    gross.series.forEach((p, i) => expect(p.pct).toBeCloseTo(expected[i], 10));
    expect(gross.series[0].date < gross.series[5].date).toBe(true);
    expect(gross.slopePctPtsPerYear).toBeCloseTo(1, 3);
    expect(res.margins.operating.slopePctPtsPerYear).toBeCloseTo(0, 10);
  });

  it("uses elapsed fiscal years rather than array index for margin slopes", () => {
    const income: GrowthIncomeRow[] = [
      { date: "2024-12-31", revenue: 100, grossProfit: 30 },
      { date: "2020-12-31", revenue: 100, grossProfit: 20 },
      { date: "2019-12-31", revenue: 100, grossProfit: 10 },
    ];
    const res = computeGrowth(income, [], { period: "annual" });
    expect(res.margins.gross.slopePctPtsPerYear).toBeCloseTo(3.5708, 3);
    expect(res.margins.gross.note).toMatch(/irregular fiscal spacing|elapsed fiscal years/i);
  });

  it("flags revenue acceleration when latest YoY beats the 3y CAGR", () => {
    const income = annualIncomeRows([
      { revenue: 100 },
      { revenue: 110 },
      { revenue: 121 },
      { revenue: 145.2 },
    ]);
    const res = computeGrowth(income, [], { period: "annual" });
    const acc = res.revenueAcceleration;
    expect(acc.latestYoyPct).toBeCloseTo(20, 8);
    expect(acc.threeYearCagrPct).toBeCloseTo((Math.pow(1.452, 1 / 3) - 1) * 100, 8);
    expect(acc.deltaPctPts).toBeCloseTo(
      (acc.latestYoyPct as number) - (acc.threeYearCagrPct as number),
      12,
    );
    expect(acc.accelerating).toBe(true);
    expect(acc.note).toContain("house framing");
  });

  it("never throws on empty inputs — returns gaps instead", () => {
    const res = computeGrowth([], [], { period: "annual" });
    expect(res.asOf).toBeNull();
    expect(res.gaps.some((g) => g.field === "growth.incomeStatement" && g.severity === "critical")).toBe(true);
    expect(res.gaps.some((g) => g.field === "growth.fcf")).toBe(true);
    expect(res.revenueCagrs.every((c) => c.cagrPct === null)).toBe(true);
    expect(res.revenueAcceleration.accelerating).toBeNull();
  });

  it("sorts unordered input rows defensively", () => {
    const shuffled: GrowthIncomeRow[] = [
      { date: "2023-12-31", revenue: 110 },
      { date: "2025-12-31", revenue: 133.1 },
      { date: "2022-12-31", revenue: 100 },
      { date: "2024-12-31", revenue: 121 },
    ];
    const res = computeGrowth(shuffled, [], { period: "annual" });
    const p3 = res.revenueCagrs.find((c) => c.windowYears === 3);
    expect(p3?.cagrPct).toBeCloseTo(10, 8);
    expect(p3?.startDate).toBe("2022-12-31");
    expect(p3?.endDate).toBe("2025-12-31");
  });

  it("cagrForWindow reports insufficient history on a single point", () => {
    const point = cagrForWindow([{ date: "2025-12-31", value: 100 }], 3);
    expect(point.cagrPct).toBeNull();
    expect(point.note).toContain("insufficient history");
  });

  it("linearRegressionSlope needs at least 3 points", () => {
    expect(linearRegressionSlope([{ x: 0, y: 1 }, { x: 1, y: 2 }])).toBeNull();
    expect(
      linearRegressionSlope([
        { x: 0, y: 1 },
        { x: 1, y: 3 },
        { x: 2, y: 5 },
      ]),
    ).toBeCloseTo(2, 12);
  });
});

// ===========================================================================
// returns.ts — SPREADS_2026_01
// ===========================================================================

describe("SPREADS_2026_01 — Damodaran Jan-2026 table (verbatim)", () => {
  it("carries source + date and 15 bands per variant", () => {
    expect(SPREADS_2026_01.dateOfAnalysis).toBe("January 2026");
    expect(SPREADS_2026_01.source).toContain("adamodar");
    expect(SPREADS_2026_01.nonFinancial).toHaveLength(15);
    expect(SPREADS_2026_01.financial).toHaveLength(15);
  });

  it("non-financial lookups hit the verbatim brackets (incl. edges)", () => {
    // Top edge: ≥ 8.50 → Aaa/AAA 0.40; just below → Aa2/AA 0.55
    expect(lookupSyntheticSpread(8.5)).toMatchObject({ rating: "Aaa/AAA", spreadPct: 0.4 });
    expect(lookupSyntheticSpread(8.499999)).toMatchObject({ rating: "Aa2/AA", spreadPct: 0.55 });
    // Bottom edge: ≤ 0.199999 → D2/D 19.00; 0.2 opens C2/C 16.00
    expect(lookupSyntheticSpread(0.199999)).toMatchObject({ rating: "D2/D", spreadPct: 19.0 });
    expect(lookupSyntheticSpread(-5)).toMatchObject({ rating: "D2/D", spreadPct: 19.0 });
    expect(lookupSyntheticSpread(0.2)).toMatchObject({ rating: "C2/C", spreadPct: 16.0 });
    // Mid-table: 3 – 4.249999 → A3/A− 0.89
    expect(lookupSyntheticSpread(3)).toMatchObject({ rating: "A3/A−", spreadPct: 0.89 });
    expect(lookupSyntheticSpread(4.249999)).toMatchObject({ rating: "A3/A−", spreadPct: 0.89 });
  });

  it("financial variant uses the tighter brackets", () => {
    expect(lookupSyntheticSpread(3, "financial")).toMatchObject({ rating: "Aaa/AAA", spreadPct: 0.4 });
    expect(lookupSyntheticSpread(2.99999, "financial")).toMatchObject({ rating: "Aa2/AA", spreadPct: 0.55 });
    expect(lookupSyntheticSpread(0.9, "financial")).toMatchObject({ rating: "Baa2/BBB", spreadPct: 1.11 });
    // Same ICR maps very differently across variants
    expect(lookupSyntheticSpread(3, "nonFinancial").rating).toBe("A3/A−");
  });
});

// ===========================================================================
// returns.ts — computeWacc
// ===========================================================================

const waccBase: WaccInputs = {
  beta: 1.0,
  riskFreePct: 4.0,
  erpPct: 5.0,
  interestExpenseTtm: 5,
  totalDebtAvg: 100,
  marketCap: 900,
  effectiveTaxRate: 0.21,
  ebitTtm: 50,
  analysisDate: "2026-07-19",
};

describe("computeWacc — happy path and research anchor", () => {
  it("computes the full weighted result exactly", () => {
    const res = computeWacc(waccBase);
    // beta 1.0 → Blume 1.0 → final 1.0; Re = 4 + 5 = 9
    expect(res.betaFinal).toBeCloseTo(1.0, 12);
    expect(res.costOfEquityPct).toBeCloseTo(9, 12);
    // Rd effective 5% inside [3, 23]
    expect(res.costOfDebtMethod).toBe("effective");
    expect(res.costOfDebtPct).toBeCloseTo(5, 12);
    // WACC = 0.9·9 + 0.1·5·(1 − 0.21) = 8.495
    expect(res.weightEquity).toBeCloseTo(0.9, 12);
    expect(res.weightDebt).toBeCloseTo(0.1, 12);
    expect(res.waccPct).toBeCloseTo(8.495, 10);
    expect(res.waccRawPct).toBeCloseTo(8.495, 10);
    expect(res.clampsApplied).toHaveLength(0);
  });

  it("matches the research assumption-block anchor: beta 1.42 → 1.2814, Re ≈ 10.19%", () => {
    const res = computeWacc({
      ...waccBase,
      beta: 1.42,
      riskFreePct: 4.48,
      erpPct: 4.46,
      totalDebtAvg: 0,
    });
    expect(res.betaAdjusted).toBeCloseTo(1.2814, 10);
    expect(res.betaFinal).toBeCloseTo(1.2814, 10);
    expect(res.costOfEquityPct).toBeCloseTo(10.195044, 6); // research renders "10.19%"
  });
});

describe("computeWacc — fallback disclosure (audit 2026-07-11 #5)", () => {
  it("suppresses WACC when beta is unavailable instead of inventing a sector default", () => {
    const res = computeWacc({ ...waccBase, beta: null });
    expect(res.waccPct).toBeNull();
    expect(res.betaFinal).toBeNull();
    expect(res.gaps.some((g) => g.field === "returns.wacc.beta" && g.severity === "critical")).toBe(true);
  });

  it("emits an info manifest gap when the Damodaran ERP fallback is used", () => {
    const res = computeWacc({ ...waccBase, erpPct: 30 });
    expect(res.gaps.some((g) => g.field === "returns.wacc.erp" && g.severity === "info")).toBe(true);
  });

  it("does NOT gap beta/ERP when both inputs are valid and in-band", () => {
    const res = computeWacc(waccBase);
    expect(res.gaps.some((g) => g.field === "returns.wacc.beta")).toBe(false);
    expect(res.gaps.some((g) => g.field === "returns.wacc.erp")).toBe(false);
  });

  it("emits a warn manifest gap when a material WACC clamp binds the ceiling", () => {
    // beta 4 → Blume 3.01 → clamp 2.0; Re = 4 + 2.0·25 = 54 → clamped 25; wE 0.9
    // → raw WACC ≈ 22.9% > 20% ceiling (a >0.5pp material clamp that inflates DCF).
    const res = computeWacc({ ...waccBase, beta: 4, erpPct: 25 });
    expect(res.waccPct).toBeCloseTo(20, 10);
    expect(res.waccRawPct).toBeGreaterThan(20.5);
    expect(res.gaps.some((g) => g.field === "returns.wacc.clamp" && g.severity === "warn")).toBe(true);
  });
});

describe("computeWacc — beta pipeline", () => {
  it("fails closed for missing and implausible betas", () => {
    for (const beta of [null, 4.5, -0.2, 0]) {
      const res = computeWacc({ ...waccBase, beta });
      expect(res.betaFinal).toBeNull();
      expect(res.costOfEquityPct).toBeNull();
      expect(res.waccPct).toBeNull();
    }
  });

  it("clamps the Blume-adjusted beta at the 0.6 floor", () => {
    const res = computeWacc({ ...waccBase, beta: 0.2 });
    expect(res.betaAdjusted).toBeCloseTo(0.464, 10);
    expect(res.betaFinal).toBe(0.6);
    expect(res.clampsApplied.join(" ")).toContain("beta clamped");
  });

  it("clamps the Blume-adjusted beta at the 2.0 ceiling", () => {
    const res = computeWacc({ ...waccBase, beta: 3.5 });
    expect(res.betaAdjusted).toBeCloseTo(2.675, 10);
    expect(res.betaFinal).toBe(2.0);
    expect(res.clampsApplied.join(" ")).toContain("beta clamped");
  });
});

describe("computeWacc — ERP fallback", () => {
  it("uses the current dated fallback when ERP is missing", () => {
    const res = computeWacc({ ...waccBase, erpPct: null });
    expect(res.erpPct).toBe(ERP_FALLBACK_PCT);
    expect(ERP_FALLBACK_PCT).toBe(4.18);
    expect(res.notes.join(" ")).toContain("ERP fallback 4.18");
  });

  it("falls back when ERP is implausible (outside [3, 25])", () => {
    expect(computeWacc({ ...waccBase, erpPct: 30 }).erpPct).toBe(ERP_FALLBACK_PCT);
    expect(computeWacc({ ...waccBase, erpPct: 1 }).erpPct).toBe(ERP_FALLBACK_PCT);
    expect(computeWacc({ ...waccBase, erpPct: 3 }).erpPct).toBe(3); // band inclusive
  });

  it("suppresses cost of equity and WACC when the fallback has exceeded its freshness threshold", () => {
    const res = computeWacc({ ...waccBase, erpPct: null, analysisDate: "2027-02-01" });
    expect(res.erpPct).toBeNull();
    expect(res.costOfEquityPct).toBeNull();
    expect(res.waccPct).toBeNull();
    expect(res.gaps.some((g) => g.field === "returns.wacc.erp" && g.severity === "critical")).toBe(true);
  });

  it("does not use a dated fallback when the analysis date is unavailable", () => {
    const res = computeWacc({ ...waccBase, erpPct: null, analysisDate: undefined });
    expect(res.erpPct).toBeNull();
    expect(res.waccPct).toBeNull();
  });
});

describe("computeWacc — clamp boundaries", () => {
  it("cost-of-equity floor rf + 2.5 fires", () => {
    const res = computeWacc({ ...waccBase, beta: 0.2, erpPct: 3, totalDebtAvg: 0 });
    // beta 0.2 → Blume 0.464 → clamp 0.6; Re raw = 4 + 0.6·3 = 5.8 < 6.5
    expect(res.costOfEquityPct).toBeCloseTo(6.5, 12);
    expect(res.clampsApplied.join(" ")).toContain("cost of equity clamped");
  });

  it("cost-of-equity ceiling 25 fires", () => {
    const res = computeWacc({ ...waccBase, beta: 3.0, erpPct: 12, totalDebtAvg: 0 });
    // beta 3 → Blume 2.34 → clamp 2.0; Re raw = 4 + 24 = 28 → 25
    expect(res.costOfEquityPct).toBe(25);
    expect(res.clampsApplied.join(" ")).toContain("cost of equity clamped");
  });

  it("WACC floor max(6, rf + 1) fires and both raw + clamped are returned", () => {
    const res = computeWacc({
      ...waccBase,
      riskFreePct: 2,
      beta: 0.2,
      erpPct: 3,
      totalDebtAvg: 0,
    });
    // Re raw = 2 + 0.6·3 = 3.8 → floor 4.5; WACC raw 4.5 → floor max(6, 3) = 6
    expect(res.waccRawPct).toBeCloseTo(4.5, 12);
    expect(res.waccPct).toBe(6);
    expect(res.clampsApplied.join(" ")).toContain("WACC clamped");
  });

  it("WACC ceiling 20 fires", () => {
    const res = computeWacc({ ...waccBase, beta: 3.0, erpPct: 12, totalDebtAvg: 0 });
    expect(res.waccRawPct).toBe(25);
    expect(res.waccPct).toBe(20);
    expect(res.clampsApplied.join(" ")).toContain("WACC clamped");
  });

  it("clamps an observed effective tax rate into [0, 0.35]", () => {
    const hi = computeWacc({ ...waccBase, effectiveTaxRate: 0.5 });
    expect(hi.taxRateUsed).toBe(0.35);
    expect(hi.clampsApplied.join(" ")).toContain("tax rate clamped");
    // WACC uses the clamped rate: 0.9·9 + 0.1·5·0.65 = 8.425
    expect(hi.waccPct).toBeCloseTo(8.425, 10);
    const lo = computeWacc({ ...waccBase, effectiveTaxRate: -0.1 });
    expect(lo.taxRateUsed).toBe(0);
  });

  it("suppresses levered WACC when the tax shield has no observed tax rate", () => {
    const missing = computeWacc({ ...waccBase, effectiveTaxRate: null });
    expect(missing.taxRateUsed).toBeNull();
    expect(missing.waccPct).toBeNull();
    expect(missing.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "returns.wacc.effectiveTaxRate", severity: "critical" }),
      ]),
    );
    expect(missing.notes.join(" ")).not.toContain("25%");
  });

  it("does not require a tax-rate assumption for a debt-free WACC", () => {
    const missing = computeWacc({ ...waccBase, totalDebtAvg: 0, effectiveTaxRate: null });
    expect(missing.taxRateUsed).toBeNull();
    expect(missing.waccPct).not.toBeNull();
    expect(missing.waccRawPct).toBe(missing.costOfEquityPct);
    expect(missing.gaps).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "returns.wacc.effectiveTaxRate", severity: "critical" }),
      ]),
    );
  });
});

describe("computeWacc — cost of debt: acceptance band and synthetic rating", () => {
  it("accepts the effective rate on both inclusive band edges [rf − 1, rf + 19]", () => {
    const atCeiling = computeWacc({ ...waccBase, interestExpenseTtm: 23 }); // 23% = rf + 19
    expect(atCeiling.costOfDebtMethod).toBe("effective");
    expect(atCeiling.costOfDebtPct).toBeCloseTo(23, 12);
    const atFloor = computeWacc({ ...waccBase, interestExpenseTtm: 3 }); // 3% = rf − 1
    expect(atFloor.costOfDebtMethod).toBe("effective");
    expect(atFloor.costOfDebtPct).toBeCloseTo(3, 12);
  });

  it("rejects an effective rate above the band and uses the synthetic rating", () => {
    const res = computeWacc({ ...waccBase, interestExpenseTtm: 30, ebitTtm: 90 });
    // RdEff 30% > 23%; ICR = 90/30 = 3 → A3/A− 0.89 → Rd = 4 + 0.89
    expect(res.costOfDebtMethod).toBe("synthetic");
    expect(res.interestCoverageRatio).toBeCloseTo(3, 12);
    expect(res.syntheticRating).toBe("A3/A−");
    expect(res.costOfDebtPct).toBeCloseTo(4.89, 10);
  });

  it("rejects an effective rate below the band (artifact) and uses the synthetic rating", () => {
    const res = computeWacc({ ...waccBase, interestExpenseTtm: 1, ebitTtm: 50 });
    // RdEff 1% < 3%; ICR = 50 → Aaa/AAA 0.40
    expect(res.costOfDebtMethod).toBe("synthetic");
    expect(res.syntheticRating).toBe("Aaa/AAA");
    expect(res.costOfDebtPct).toBeCloseTo(4.4, 10);
  });

  it("treats interestExpense = 0 as undisclosed and suppresses WACC", () => {
    const res = computeWacc({ ...waccBase, interestExpenseTtm: 0 });
    expect(res.waccPct).toBeNull();
    expect(res.costOfDebtMethod).toBe("unavailable");
    expect(res.syntheticRating).toBeNull();
    expect(res.notes.join(" ")).toContain("zero-for-undisclosed");
    expect(res.gaps.some((g) => g.field === "returns.wacc.interestExpense")).toBe(true);
  });

  it("does not infer AAA when interest expense is missing with real debt", () => {
    const res = computeWacc({ ...waccBase, interestExpenseTtm: null });
    expect(res.waccPct).toBeNull();
    expect(res.costOfDebtPct).toBeNull();
    expect(res.costOfDebtMethod).toBe("unavailable");
    expect(res.syntheticRating).toBeNull();
  });

  it("suppresses WACC WITH a disclosed gap when interest expense is negative with real debt", () => {
    // A negative interest expense (interest income netted / vendor sign flip) with
    // debt outstanding is implausible. Pre-fix it fell through the zero/missing
    // block and suppressed WACC SILENTLY (costOfDebtMethod 'unavailable', gaps: []).
    // Now it fails closed with a disclosed manifest gap + note, like every other
    // WACC failure mode.
    const res = computeWacc({ ...waccBase, interestExpenseTtm: -120 });
    expect(res.waccPct).toBeNull();
    expect(res.costOfDebtPct).toBeNull();
    expect(res.costOfDebtMethod).toBe("unavailable");
    expect(res.syntheticRating).toBeNull();
    expect(
      res.gaps.some((g) => g.field === "returns.wacc.interestExpense" && g.severity === "critical"),
    ).toBe(true);
    expect(res.notes.join(" ")).toContain("negative");
  });

  it("uses the financial table when isFinancial", () => {
    const res = computeWacc({
      ...waccBase,
      isFinancial: true,
      interestExpenseTtm: 30,
      ebitTtm: 81,
    });
    // ICR 2.7 → financial 2.5–2.99999 → Aa2/AA 0.55
    expect(res.syntheticRating).toBe("Aa2/AA");
    expect(res.costOfDebtPct).toBeCloseTo(4.55, 10);
  });

  it("applies the de-minimis debt rule (< 2% of assets) — synthetic even when in-band", () => {
    const res = computeWacc({ ...waccBase, totalAssets: 100_000 });
    // debt 100 = 0.1% of assets; effective 5% would have been accepted
    expect(res.costOfDebtMethod).toBe("synthetic");
    expect(res.notes.join(" ")).toContain("% of total assets");
  });

  it("suppresses WACC when effective debt cost is implausible and EBIT is missing", () => {
    const res = computeWacc({ ...waccBase, interestExpenseTtm: 30, ebitTtm: null });
    expect(res.waccPct).toBeNull();
    expect(res.costOfDebtMethod).toBe("unavailable");
    expect(res.costOfDebtPct).toBeNull();
    expect(res.gaps.some((g) => g.field === "returns.wacc.costOfDebt")).toBe(true);
  });

  it("warns on distressed synthetic ratings (≤ B)", () => {
    const res = computeWacc({ ...waccBase, interestExpenseTtm: 40, ebitTtm: 60 });
    // ICR 1.5 → B2/B 3.21
    expect(res.syntheticRating).toBe("B2/B");
    expect(res.notes.join(" ")).toContain("understate distress");
  });
});

describe("computeWacc — missing inputs never throw", () => {
  it("missing risk-free rate → null WACC + critical gap", () => {
    const res = computeWacc({ ...waccBase, riskFreePct: null });
    expect(res.waccPct).toBeNull();
    expect(res.costOfEquityPct).toBeNull();
    expect(res.gaps.some((g) => g.field === "returns.wacc" && g.severity === "critical")).toBe(true);
  });

  it("missing market cap with debt outstanding → null WACC + critical gap, Re/Rd still reported", () => {
    const res = computeWacc({ ...waccBase, marketCap: null });
    expect(res.waccPct).toBeNull();
    expect(res.weightEquity).toBeNull();
    expect(res.costOfEquityPct).toBeCloseTo(9, 12);
    expect(res.costOfDebtPct).toBeCloseTo(5, 12);
    expect(res.gaps.some((g) => g.field === "returns.wacc.weights" && g.severity === "critical")).toBe(true);
  });

  it("debt-free company → WACC equals cost of equity", () => {
    const res = computeWacc({ ...waccBase, totalDebtAvg: 0 });
    expect(res.costOfDebtMethod).toBe("none");
    expect(res.weightEquity).toBe(1);
    expect(res.waccPct).toBeCloseTo(9, 12);
  });

  it("missing debt is unknown, not debt-free, and suppresses WACC", () => {
    const res = computeWacc({ ...waccBase, totalDebtAvg: null });
    expect(res.waccPct).toBeNull();
    expect(res.weightEquity).toBeNull();
    expect(res.weightDebt).toBeNull();
    expect(res.gaps.some((g) => g.field === "returns.wacc.weights" && g.severity === "critical")).toBe(true);
  });

  it("negative debt is invalid data, not debt-free, and suppresses WACC", () => {
    const res = computeWacc({ ...waccBase, totalDebtAvg: -1 });
    expect(res.waccPct).toBeNull();
    expect(res.weightEquity).toBeNull();
    expect(res.weightDebt).toBeNull();
    expect(
      res.gaps.some(
        (g) =>
          g.field === "returns.wacc.weights" &&
          g.severity === "critical" &&
          g.reason.includes("negative"),
      ),
    ).toBe(true);
  });

  it("echoes provenance as-of dates", () => {
    const asOf = { riskFreeRate: "2026-07-01", statements: "2025-12-31" };
    expect(computeWacc({ ...waccBase, asOf }).asOf).toEqual(asOf);
  });
});

// ===========================================================================
// returns.ts — ROIC and DuPont
// ===========================================================================

const roicIncome: ReturnsIncomeRow[] = [
  {
    date: "2025-12-31",
    revenue: 1000,
    operatingIncome: 200,
    incomeBeforeTax: 100,
    incomeTaxExpense: 20,
    netIncome: 80,
  },
  {
    date: "2024-12-31",
    revenue: 900,
    operatingIncome: 180,
    incomeBeforeTax: 90,
    incomeTaxExpense: 18,
    netIncome: 72,
  },
];
const roicBalance: ReturnsBalanceRow[] = [
  {
    date: "2025-12-31",
    totalDebt: 300,
    totalStockholdersEquity: 700,
    cashAndCashEquivalents: 100,
    totalAssets: 2200,
  },
  {
    date: "2024-12-31",
    totalDebt: 300,
    totalStockholdersEquity: 500,
    cashAndCashEquivalents: 0,
    totalAssets: 1800,
  },
];

describe("computeRoic", () => {
  it("computes NOPAT / average invested capital", () => {
    const res = computeRoic(roicIncome, roicBalance);
    const latest = res.series[res.series.length - 1];
    // t = 20/100 = 0.2 → NOPAT = 200·0.8 = 160
    expect(latest.nopat).toBeCloseTo(160, 12);
    expect(latest.taxRateUsed).toBeCloseTo(0.2, 12);
    // IC 2025 = 300 + 700 − 100 = 900; IC 2024 = 300 + 500 − 0 = 800 → avg 850
    expect(latest.investedCapitalAvg).toBeCloseTo(850, 12);
    expect(latest.roicPct).toBeCloseTo((160 / 850) * 100, 10);
    expect(res.latestRoicPct).toBe(latest.roicPct);
    expect(res.asOf).toBe("2025-12-31");
  });

  it.each([
    ["pre-tax loss", { incomeBeforeTax: -50, incomeTaxExpense: 5 }],
    ["missing tax expense", { incomeBeforeTax: 100, incomeTaxExpense: null }],
  ])("suppresses ROIC for %s instead of inventing a tax rate", (_label, override) => {
    const res = computeRoic([{ ...roicIncome[0], ...override }], roicBalance);
    const latest = res.series[res.series.length - 1];
    expect(latest.taxRateUsed).toBeNull();
    expect(latest.nopat).toBeNull();
    expect(latest.roicPct).toBeNull();
    expect(latest.notes.join(" ")).toContain("tax rate unavailable");
    expect(res.gaps).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "returns.roic.taxRate", severity: "warn" })]),
    );
  });

  it("guards negative invested capital (roic null + note)", () => {
    const res = computeRoic(roicIncome.slice(0, 1), [
      {
        date: "2025-12-31",
        totalDebt: 100,
        totalStockholdersEquity: -500,
        cashAndCashEquivalents: 200,
      },
    ]);
    const latest = res.series[res.series.length - 1];
    expect(latest.roicPct).toBeNull();
    expect(latest.notes.join(" ")).toContain("invested capital ≤ 0");
  });

  it("treats negative total debt as invalid input instead of computing ROIC from it", () => {
    const balances = roicBalance.map((row) =>
      row.date === "2025-12-31" ? { ...row, totalDebt: -100 } : row,
    );
    const res = computeRoic(roicIncome, balances);
    expect(res.latestRoicPct).toBeNull();
    expect(res.series.at(-1)?.notes.join(" ")).toMatch(/totalDebt.*negative/i);
  });

  it.each(["totalDebt", "cashAndCashEquivalents"] as const)(
    "suppresses ROIC when %s is missing instead of substituting zero",
    (field) => {
      const balances = roicBalance.map((row) =>
        row.date === "2025-12-31" ? { ...row, [field]: null } : row,
      );
      const res = computeRoic(roicIncome, balances);
      expect(res.latestRoicPct).toBeNull();
      expect(res.series.at(-1)?.notes.join(" ")).toContain(`${field} missing`);
    },
  );

  it("never throws on empty inputs", () => {
    const res = computeRoic([], []);
    expect(res.series).toHaveLength(0);
    expect(res.gaps.some((g) => g.field === "returns.roic")).toBe(true);
  });
});

describe("computeDupont", () => {
  it("decomposes ROE and the identity holds within fp tolerance", () => {
    const res = computeDupont(roicIncome, roicBalance);
    const latest = res.latest;
    expect(latest).not.toBeNull();
    // avgAssets = (2200 + 1800)/2 = 2000; avgEquity = (700 + 500)/2 = 600
    expect(latest?.netMargin).toBeCloseTo(80 / 1000, 12);
    expect(latest?.assetTurnover).toBeCloseTo(1000 / 2000, 12);
    expect(latest?.leverage).toBeCloseTo(2000 / 600, 12);
    expect(latest?.roePct).toBeCloseTo((80 / 600) * 100, 12);
    // Identity: margin × turnover × leverage × 100 === roePct
    const product =
      (latest?.netMargin as number) *
      (latest?.assetTurnover as number) *
      (latest?.leverage as number) *
      100;
    expect(product).toBeCloseTo(latest?.roePct as number, 9);
  });

  it("guards negative average equity", () => {
    const res = computeDupont(roicIncome.slice(0, 1), [
      { date: "2025-12-31", totalAssets: 2000, totalStockholdersEquity: -100 },
    ]);
    expect(res.latest?.leverage).toBeNull();
    expect(res.latest?.roePct).toBeNull();
    expect(res.latest?.notes.join(" ")).toContain("equity ≤ 0");
  });
});

describe("computeRoicVsWaccSpread", () => {
  it("returns the spread in percentage points", () => {
    const res = computeRoicVsWaccSpread(18.8235, 9.0);
    expect(res.spreadPctPts).toBeCloseTo(9.8235, 10);
    expect(res.note).toContain("spread");
  });

  it("returns null when either side is missing", () => {
    expect(computeRoicVsWaccSpread(null, 9).spreadPctPts).toBeNull();
    expect(computeRoicVsWaccSpread(12, null).spreadPctPts).toBeNull();
  });
});

// ===========================================================================
// capital.ts
// ===========================================================================

const capIncome: CapitalIncomeRow[] = [
  {
    date: "2025-12-31",
    revenue: 200,
    operatingIncome: 200,
    interestExpense: 25,
    netIncome: 100,
    weightedAverageShsOutDil: 100,
  },
  {
    date: "2024-12-31",
    revenue: 180,
    operatingIncome: 170,
    interestExpense: 25,
    netIncome: 90,
    weightedAverageShsOutDil: 104,
  },
];
const capCashflow: CapitalCashFlowRow[] = [
  {
    date: "2025-12-31",
    netIncome: 100,
    depreciationAndAmortization: 50,
    stockBasedCompensation: 10,
    operatingCashFlow: 110,
    capitalExpenditure: -30,
    freeCashFlow: 80,
    commonStockRepurchased: -100,
  },
  {
    date: "2024-12-31",
    netIncome: 90,
    depreciationAndAmortization: 45,
    stockBasedCompensation: 9,
    operatingCashFlow: 100,
    capitalExpenditure: -25,
    freeCashFlow: 75,
    commonStockRepurchased: 0,
  },
];
const capBalance: CapitalBalanceRow[] = [
  {
    date: "2025-12-31",
    totalDebt: 600,
    netDebt: 500,
    cashAndCashEquivalents: 100,
    shortTermInvestments: 50,
    cashAndShortTermInvestments: 150,
  },
];
const capMcapHistory: MarketCapPoint[] = [
  { date: "2025-09-30", marketCap: 1100 },
  { date: "2025-06-30", marketCap: 900 },
];

describe("computeCapital — core ratios", () => {
  const res = computeCapital(capIncome, capCashflow, capBalance, capMcapHistory, { price: 20 });

  it("net debt / EBITDA uses own EBITDA (opInc + cash-flow D&A)", () => {
    // House net debt = 600 - (100 cash + 50 STI) = 450; EBITDA = 250.
    expect(res.netDebtToEbitda.ebitda).toBeCloseTo(250, 12);
    expect(res.netDebtToEbitda.netDebt).toBe(450);
    expect(res.netDebtToEbitda.value).toBeCloseTo(1.8, 12);
    expect(res.netDebtToEbitda.asOf).toBe("2025-12-31");
    expect(res.netDebtToEbitda.resolution.components.shortTermInvestments).toBe(50);
  });

  it("interest coverage = EBIT / interest", () => {
    expect(res.interestCoverage.value).toBeCloseTo(200 / 25, 12);
  });

  it("SBC as % of revenue and % of FCF", () => {
    expect(res.sbc.latest).toBe(10);
    expect(res.sbc.pctOfRevenue).toBeCloseTo(5, 12); // 10/200
    expect(res.sbc.pctOfFcf).toBeCloseTo(12.5, 12); // 10/80
  });

  it("FCF conversion = FCF / NI", () => {
    expect(res.fcf.latestFcf).toBe(80);
    expect(res.fcf.latestConversion).toBeCloseTo(0.8, 12);
    expect(res.fcf.series[0].date < res.fcf.series[1].date).toBe(true); // oldest→newest
  });

  it("capex intensity = |capex| / revenue", () => {
    expect(res.capexIntensity.latestPct).toBeCloseTo(15, 12); // 30/200
  });

  it("maintenance-vs-growth split is labeled a heuristic", () => {
    // |capex| 30 vs D&A 50 → maintenance 30, growth 0, ratio 0.6
    expect(res.maintenanceVsGrowthCapex.capexToDALatest).toBeCloseTo(0.6, 12);
    expect(res.maintenanceVsGrowthCapex.impliedMaintenanceCapex).toBe(30);
    expect(res.maintenanceVsGrowthCapex.impliedGrowthCapex).toBe(0);
    expect(res.maintenanceVsGrowthCapex.note).toContain("HEURISTIC");
  });

  it("buyback price analysis: dollar-weighted proxy vs current price, labeled heuristic", () => {
    const bb = res.buybackPriceAnalysis;
    // FY2025: avg mcap (900 + 1100)/2 = 1000; shares 100 → price proxy 10;
    // $100 repurchased → 10 shares proxy; avg paid 10 vs price 20 → +100%
    expect(bb.totalRepurchased).toBe(100);
    expect(bb.years).toHaveLength(1);
    expect(bb.years[0].avgMarketCap).toBeCloseTo(1000, 12);
    expect(bb.years[0].avgPriceProxy).toBeCloseTo(10, 12);
    expect(bb.years[0].sharesProxy).toBeCloseTo(10, 12);
    expect(bb.avgPricePaidProxy).toBeCloseTo(10, 12);
    expect(bb.currentPrice).toBe(20);
    expect(bb.premiumDiscountPct).toBeCloseTo(100, 10);
    expect(bb.note).toContain("HEURISTIC");
  });

  it("carries the statement as-of date", () => {
    expect(res.asOf).toBe("2025-12-31");
  });

  it("buyback price proxy divides by BASIC shares (matches marketCap base), not diluted", () => {
    // marketCap = price × shares OUTSTANDING (basic). Dividing by DILUTED would
    // inflate the denominator and understate the price paid. Basic 100 vs diluted 125.
    const income: CapitalIncomeRow[] = [
      {
        date: "2025-12-31",
        revenue: 200,
        operatingIncome: 200,
        interestExpense: 25,
        netIncome: 100,
        weightedAverageShsOut: 100,
        weightedAverageShsOutDil: 125,
      },
    ];
    const r = computeCapital(income, capCashflow.slice(0, 1), capBalance, capMcapHistory, { price: 20 });
    const y = r.buybackPriceAnalysis.years[0];
    // avg mcap 1000 / BASIC 100 = 10 (correct); diluted 125 would give 8 (understated).
    expect(y.avgPriceProxy).toBeCloseTo(10, 12);
    expect(r.buybackPriceAnalysis.avgPricePaidProxy).toBeCloseTo(10, 12);
    expect(y.note ?? "").not.toContain("used diluted");
  });

  it("buyback price proxy falls back to diluted when basic is absent, and says so", () => {
    // capIncome has only diluted (100) → fallback path, same 10 proxy, with a note.
    const y = res.buybackPriceAnalysis.years[0];
    expect(y.avgPriceProxy).toBeCloseTo(10, 12);
    expect(y.note ?? "").toContain("used diluted");
  });
});

describe("computeCapital — zero-as-null and denominator guards", () => {
  it("interest expense 0 → coverage null + disclosed gap (FMP zero-for-undisclosed)", () => {
    const income = [{ ...capIncome[0], interestExpense: 0 }];
    const res = computeCapital(income, capCashflow, capBalance, [], { price: null });
    expect(res.interestCoverage.value).toBeNull();
    expect(res.interestCoverage.note).toContain("zero-for-undisclosed");
    expect(res.gaps.some((g) => g.field === "capital.interestCoverage")).toBe(true);
  });

  it("FCF conversion null when net income ≤ 0", () => {
    const cf = [{ ...capCashflow[0], netIncome: -50 }];
    const inc = [{ ...capIncome[0], netIncome: -50 }];
    const res = computeCapital(inc, cf, capBalance, [], { price: null });
    expect(res.fcf.latestConversion).toBeNull();
    expect(res.fcf.series[res.fcf.series.length - 1].note).toContain("not meaningful");
  });

  it("SBC % of FCF null when FCF ≤ 0", () => {
    const cf = [{ ...capCashflow[0], freeCashFlow: -10 }];
    const res = computeCapital(capIncome, cf, capBalance, [], { price: null });
    expect(res.sbc.pctOfFcf).toBeNull();
    expect(res.sbc.note).toContain("not meaningful");
  });

  it("net debt/EBITDA null when EBITDA ≤ 0", () => {
    const inc = [{ ...capIncome[0], operatingIncome: -100 }];
    const res = computeCapital(inc, capCashflow, capBalance, [], { price: null });
    expect(res.netDebtToEbitda.value).toBeNull();
    expect(res.netDebtToEbitda.note).toContain("not meaningful");
  });

  it("falls back to the vendor ebitda field when cash-flow D&A is missing (noted)", () => {
    const inc = [{ ...capIncome[0], ebitda: 250 }];
    const cf = [{ ...capCashflow[0], depreciationAndAmortization: null }];
    const res = computeCapital(inc, cf, capBalance, [], { price: null });
    expect(res.netDebtToEbitda.ebitda).toBe(250);
    expect(res.netDebtToEbitda.note).toContain("vendor ebitda");
  });

  it("suppresses net debt when short-term investments are unknown", () => {
    const bal = [{ date: "2025-12-31", totalDebt: 600, cashAndCashEquivalents: 100 }];
    const res = computeCapital(capIncome, capCashflow, bal, [], { price: null });
    expect(res.netDebtToEbitda.netDebt).toBeNull();
    expect(res.netDebtToEbitda.note).toMatch(/short-term investments|combined cash/i);
  });

  it("derives net debt when a zero short-term-investment balance is explicit", () => {
    const bal = [{
      date: "2025-12-31",
      totalDebt: 600,
      cashAndCashEquivalents: 100,
      shortTermInvestments: 0,
    }];
    const res = computeCapital(capIncome, capCashflow, bal, [], { price: null });
    expect(res.netDebtToEbitda.netDebt).toBe(500);
    expect(res.netDebtToEbitda.resolution.cashBasis).toBe("component-sum");
  });
});

describe("computeCapital — capex trajectory slope", () => {
  it("computes an exact slope on a clean ramp", () => {
    const years = [2021, 2022, 2023, 2024, 2025];
    const inc: CapitalIncomeRow[] = years.map((y) => ({
      date: `${y}-12-31`,
      revenue: 100,
      operatingIncome: 20,
      netIncome: 10,
      weightedAverageShsOutDil: 100,
    }));
    const cf: CapitalCashFlowRow[] = years.map((y, i) => ({
      date: `${y}-12-31`,
      capitalExpenditure: -(10 + i), // 10..14 oldest→newest → 10%..14% of revenue
      operatingCashFlow: 30,
      freeCashFlow: 30 - (10 + i),
      depreciationAndAmortization: 10,
      netIncome: 10,
    }));
    const res = computeCapital(inc, cf, [], [], { price: null });
    const expected = [10, 11, 12, 13, 14];
    res.capexIntensity.series.forEach((p, i) =>
      expect(p.capexToRevenuePct).toBeCloseTo(expected[i], 10),
    );
    expect(res.capexIntensity.slopePctPtsPerYear).toBeCloseTo(1, 3);
  });

  it("uses elapsed fiscal years rather than array index on irregular history", () => {
    const years = [2019, 2020, 2024];
    const inc: CapitalIncomeRow[] = years.map((y) => ({ date: `${y}-12-31`, revenue: 100 }));
    const cf: CapitalCashFlowRow[] = years.map((y, i) => ({
      date: `${y}-12-31`,
      capitalExpenditure: -(10 + i * 10),
    }));
    const res = computeCapital(inc, cf, [], [], { price: null });
    expect(res.capexIntensity.slopePctPtsPerYear).toBeCloseTo(3.5708, 3);
    expect(res.notes.join(" ")).toMatch(/irregular fiscal spacing|elapsed fiscal years/i);
  });
});

describe("computeCapital — diluted share-count trend", () => {
  function incomeWithShares(sharesOldestFirst: number[]): CapitalIncomeRow[] {
    const n = sharesOldestFirst.length;
    return sharesOldestFirst
      .map((s, i) => ({
        date: `${2025 - (n - 1 - i)}-12-31`,
        revenue: 100,
        netIncome: 10,
        weightedAverageShsOutDil: s,
      }))
      .reverse();
  }

  it("shrinking count → buyback with exact trend %", () => {
    const res = computeCapital(
      incomeWithShares([1000, 980, 960, 940, 920, 900]),
      [],
      [],
      [],
      { price: null },
    );
    expect(res.shareCount.trendPct).toBeCloseTo(-10, 10);
    expect(res.shareCount.direction).toBe("buyback");
    expect(res.shareCount.actualYears).toBe(5);
    expect(res.shareCount.annualizedPct).toBeCloseTo((Math.pow(0.9, 1 / 5) - 1) * 100, 10);
    expect(res.shareCount.note).toContain("house rule");
  });

  it("growing count → dilution", () => {
    const res = computeCapital(
      incomeWithShares([1000, 1020, 1040, 1060, 1080, 1100]),
      [],
      [],
      [],
      { price: null },
    );
    expect(res.shareCount.trendPct).toBeCloseTo(10, 10);
    expect(res.shareCount.direction).toBe("dilution");
  });

  it("change within ±1% total → flat (house rule)", () => {
    const res = computeCapital(
      incomeWithShares([1000, 1001, 1002, 1003, 1004, 1005]),
      [],
      [],
      [],
      { price: null },
    );
    expect(res.shareCount.trendPct).toBeCloseTo(0.5, 10);
    expect(res.shareCount.direction).toBe("flat");
  });

  it("annotates a shorter-than-requested window", () => {
    const res = computeCapital(incomeWithShares([1000, 950, 900]), [], [], [], { price: null });
    expect(res.shareCount.actualYears).toBe(2);
    expect(res.shareCount.note).toContain("only 2y");
  });
});

describe("computeCapital — missing inputs never throw", () => {
  it("returns gaps for empty inputs", () => {
    const res = computeCapital([], [], [], [], { price: null });
    expect(res.asOf).toBeNull();
    expect(res.gaps.some((g) => g.field === "capital.incomeStatement" && g.severity === "critical")).toBe(true);
    expect(res.gaps.some((g) => g.field === "capital.cashFlow" && g.severity === "critical")).toBe(true);
    expect(res.gaps.some((g) => g.field === "capital.balanceSheet")).toBe(true);
    expect(res.shareCount.direction).toBeNull();
    expect(res.buybackPriceAnalysis.totalRepurchased).toBe(0);
    expect(res.netDebtToEbitda.value).toBeNull();
  });

  it("buyback analysis degrades when market-cap history is missing", () => {
    const res = computeCapital(capIncome, capCashflow, capBalance, [], { price: 20 });
    expect(res.buybackPriceAnalysis.totalRepurchased).toBe(100);
    expect(res.buybackPriceAnalysis.avgPricePaidProxy).toBeNull();
    expect(res.buybackPriceAnalysis.years[0].note).toContain("no market-cap history");
  });
});
