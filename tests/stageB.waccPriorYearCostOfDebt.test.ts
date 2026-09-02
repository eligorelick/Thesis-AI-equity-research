/**
 * WACC when the current interest expense is undisclosed.
 *
 * Some filers stop breaking interest expense out of "other income/(expense),
 * net" — Apple from FY2024 — so FMP reports 0 and the XBRL companyfacts carry
 * no tag either. The WACC used to fail closed on that zero, which suppressed
 * the DCF for one of the most-analysed issuers in the market. It now falls
 * back to the issuer's own last-DISCLOSED effective rate, subject to the same
 * recency and acceptance-band rules, and says so as a warning gap.
 */
import { describe, expect, it } from "vitest";

import { priorYearCostOfDebt } from "@/pipeline/compute";
import {
  computeWacc,
  PRIOR_YEAR_COST_OF_DEBT_MAX_YEARS_BACK,
  type WaccInputs,
} from "@/pipeline/stageB/returns";

const base: WaccInputs = {
  beta: 1.1,
  riskFreePct: 4,
  erpPct: 5,
  interestExpenseTtm: 0, // FMP zero-for-undisclosed
  totalDebtAvg: 100_000,
  marketCap: 4_000_000,
  effectiveTaxRate: 0.2,
  ebitTtm: 130_000,
  analysisDate: "2026-09-01",
  totalAssets: 365_000,
};

const prior = {
  pct: 3.4,
  fiscalYearEnd: "2023-09-30",
  yearsBack: 2,
  interestExpense: 3_933,
  totalDebtAvg: 115_600,
  ebit: 117_669,
};

describe("computeWacc with a prior-year cost of debt", () => {
  it("fails closed without the fallback, exactly as before", () => {
    const res = computeWacc(base);
    expect(res.waccPct).toBeNull();
    expect(res.costOfDebtMethod).toBe("unavailable");
    expect(res.gaps.some((g) => g.field === "returns.wacc.interestExpense" && g.severity === "critical")).toBe(true);
  });

  it("uses the last-disclosed effective rate, labels the method, and downgrades the gap to a warning", () => {
    const res = computeWacc({ ...base, priorYearCostOfDebt: prior });
    expect(res.costOfDebtMethod).toBe("historical");
    expect(res.costOfDebtPct).toBeCloseTo(3.4, 6);
    expect(res.waccPct).not.toBeNull();
    const gap = res.gaps.find((g) => g.field === "returns.wacc.interestExpense");
    expect(gap?.severity).toBe("warn");
    expect(gap?.reason).toContain("FY 2023-09-30");
    expect(gap?.reason).toContain("2 fiscal years back");
    expect(res.notes.some((n) => /latest fiscal year that disclosed it/.test(n))).toBe(true);
    // Debt weight is tiny here, so the WACC is essentially the cost of equity.
    expect(res.waccPct!).toBeLessThan(res.costOfEquityPct!);
    expect(res.costOfEquityPct! - res.waccPct!).toBeLessThan(0.25);
  });

  it("never overrides a disclosed positive interest expense", () => {
    const res = computeWacc({ ...base, interestExpenseTtm: 3_500, priorYearCostOfDebt: prior });
    expect(res.costOfDebtMethod).toBe("effective");
    expect(res.costOfDebtPct).toBeCloseTo(3.5, 6);
    expect(res.gaps.some((g) => g.field === "returns.wacc.interestExpense")).toBe(false);
  });

  it("refuses a negative current figure even when a prior year exists", () => {
    const res = computeWacc({ ...base, interestExpenseTtm: -10, priorYearCostOfDebt: prior });
    expect(res.costOfDebtMethod).toBe("unavailable");
    expect(res.gaps.find((g) => g.field === "returns.wacc.interestExpense")?.severity).toBe("critical");
  });

  it("refuses a disclosure older than the recency limit", () => {
    const stale = { ...prior, yearsBack: PRIOR_YEAR_COST_OF_DEBT_MAX_YEARS_BACK + 1 };
    const res = computeWacc({ ...base, priorYearCostOfDebt: stale });
    expect(res.costOfDebtMethod).toBe("unavailable");
    expect(res.waccPct).toBeNull();
  });

  it("prices an out-of-band historical coupon off today's rf through that year's own coverage ratio", () => {
    // Apple's case: fixed-rate debt issued when yields were low gives an
    // effective rate below rf − 1 today. The band rejects it (correctly — the
    // cost of debt is the marginal rate), and the synthetic rating is scored
    // on FY2023's own EBIT / interest, not on a TTM EBIT over a FY2023 coupon.
    const low = { ...prior, pct: 2.0 };
    const res = computeWacc({ ...base, riskFreePct: 4.2, priorYearCostOfDebt: low });
    expect(res.costOfDebtMethod).toBe("synthetic");
    expect(res.interestCoverageRatio).toBeCloseTo(117_669 / 3_933, 6);
    expect(res.syntheticRating).not.toBeNull();
    expect(res.costOfDebtPct).toBeCloseTo(4.2 + (res.syntheticSpreadPct ?? 0), 6);
    expect(res.waccPct).not.toBeNull();
    expect(res.notes.some((n) => /historical cost of debt 2.*outside acceptance band/.test(n))).toBe(true);
    expect(res.notes.some((n) => /ICR .* on FY 2023-09-30/.test(n))).toBe(true);
    expect(res.gaps.find((g) => g.field === "returns.wacc.interestExpense")?.severity).toBe("warn");
  });

  it("stays unavailable when the out-of-band historical year has no EBIT for a coverage ratio", () => {
    const implausible = { ...prior, pct: 40, ebit: null };
    const res = computeWacc({ ...base, priorYearCostOfDebt: implausible });
    // Outside [rf − 1, rf + 19] and nothing to score coverage on: no defensible
    // basis, so it stays unavailable — never silently accepted because it
    // happened to be the only number around.
    expect(res.costOfDebtMethod).toBe("unavailable");
    expect(res.waccPct).toBeNull();
    expect(res.notes.some((n) => /historical cost of debt 40.*outside acceptance band/.test(n))).toBe(true);
  });
});

describe("priorYearCostOfDebt from annual statements", () => {
  const income = [
    { date: "2025-09-27", interestExpense: 0, operatingIncome: 133_050_000_000 },
    { date: "2024-09-28", interestExpense: 0, operatingIncome: 123_216_000_000 },
    { date: "2023-09-30", interestExpense: 3_933_000_000, operatingIncome: 114_301_000_000, ebit: 117_669_000_000 },
    { date: "2022-09-24", interestExpense: 2_931_000_000, operatingIncome: 119_437_000_000 },
  ];
  const balance = [
    { date: "2025-09-27", totalDebt: 100_000_000_000 },
    { date: "2024-09-28", totalDebt: 106_629_000_000 },
    { date: "2023-09-30", totalDebt: 111_088_000_000 },
    { date: "2022-09-24", totalDebt: 120_069_000_000 },
  ];

  it("picks the newest prior year with a positive figure and averages that year's debt with the year before", () => {
    const result = priorYearCostOfDebt(income, balance);
    expect(result).not.toBeNull();
    expect(result?.fiscalYearEnd).toBe("2023-09-30");
    expect(result?.yearsBack).toBe(2);
    expect(result?.interestExpense).toBe(3_933_000_000);
    expect(result?.totalDebtAvg).toBeCloseTo((111_088_000_000 + 120_069_000_000) / 2, 0);
    expect(result?.pct).toBeCloseTo((3_933_000_000 / ((111_088_000_000 + 120_069_000_000) / 2)) * 100, 6);
    // EBIT for the coverage ratio comes from the same fiscal year, preferring
    // the reported ebit field over operating income.
    expect(result?.ebit).toBe(117_669_000_000);
  });

  it("never reads the latest row itself, and returns null when nothing recent disclosed interest", () => {
    expect(priorYearCostOfDebt([{ date: "2025-09-27", interestExpense: 500 }], balance)).toBeNull();
    expect(
      priorYearCostOfDebt(
        income.map((row) => ({ ...row, interestExpense: 0 })),
        balance,
      ),
    ).toBeNull();
  });

  it("requires a matching balance sheet with positive debt", () => {
    expect(priorYearCostOfDebt(income, [])).toBeNull();
    expect(
      priorYearCostOfDebt(income, balance.map((row) => ({ ...row, totalDebt: 0 }))),
    ).toBeNull();
  });

  it("looks no further back than the recency limit", () => {
    const deep = [
      { date: "2025-09-27", interestExpense: 0 },
      { date: "2024-09-28", interestExpense: 0 },
      { date: "2023-09-30", interestExpense: 0 },
      { date: "2022-09-24", interestExpense: 0 },
      { date: "2021-09-25", interestExpense: 2_645_000_000 },
    ];
    expect(priorYearCostOfDebt(deep, [...balance, { date: "2021-09-25", totalDebt: 124_719_000_000 }])).toBeNull();
  });
});
