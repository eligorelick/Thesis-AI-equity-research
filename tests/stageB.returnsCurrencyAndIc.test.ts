import { describe, expect, it } from "vitest";

import { computeRoic, computeWacc } from "@/pipeline/stageB/returns";

/**
 * Two capital-cost defects.
 *
 * 1. WACC weights divide a market cap denominated in the TRADING currency by a
 *    debt balance denominated in the REPORTING currency. For an ADR the ratio
 *    is off by the FX rate, so the equity/debt mix — and therefore the WACC, and
 *    therefore the whole DCF discount rate and the ROIC-vs-WACC spread — is
 *    wrong. Every other consumer of this pair in the codebase already guards it
 *    (valuation's DCF and excess-return routes, Altman's X4).
 *
 * 2. ROIC invested capital subtracted cashAndCashEquivalents ONLY, while the
 *    house net-debt resolver (and the DCF's sales-to-capital) subtract cash +
 *    short-term investments. For a cash-rich issuer holding most liquidity in
 *    T-bills and commercial paper, invested capital was overstated by the
 *    short-term-investment balance, so ROIC was understated — and the
 *    ROIC-vs-WACC spread carries 0.35 of the quality aspect.
 */
const WACC_BASE = {
  beta: 1.1,
  riskFreePct: 4.2,
  erpPct: 5.0,
  interestExpenseTtm: 40,
  totalDebtAvg: 1000,
  marketCap: 4000,
  effectiveTaxRate: 0.21,
  ebitTtm: 600,
  analysisDate: "2026-01-15",
};

describe("WACC weights guard the ADR currency mismatch", () => {
  it("computes weights normally when both currencies agree", () => {
    const r = computeWacc({ ...WACC_BASE, reportedCurrency: "USD", quoteCurrency: "USD" });

    expect(r.weightEquity).not.toBeNull();
    expect(r.waccPct).not.toBeNull();
  });

  it("computes weights normally when currency is simply unknown", () => {
    const r = computeWacc({ ...WACC_BASE });

    expect(r.weightEquity).not.toBeNull();
  });

  it("suppresses the weights and WACC when reporting and quote currency differ", () => {
    const r = computeWacc({ ...WACC_BASE, reportedCurrency: "TWD", quoteCurrency: "USD" });

    expect(r.weightEquity).toBeNull();
    expect(r.weightDebt).toBeNull();
    expect(r.waccPct).toBeNull();
    const gap = r.gaps.find((g) => g.field === "returns.wacc.weights.currency");
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe("critical");
    // Cost of equity is currency-free and stays available for disclosure.
    expect(r.costOfEquityPct).not.toBeNull();
  });

  it("does NOT suppress a debt-free foreign issuer, whose weights never touch market cap", () => {
    const r = computeWacc({
      ...WACC_BASE,
      totalDebtAvg: 0,
      interestExpenseTtm: 0,
      reportedCurrency: "TWD",
      quoteCurrency: "USD",
    });

    expect(r.weightEquity).toBe(1);
    expect(r.weightDebt).toBe(0);
    expect(r.gaps.some((g) => g.field === "returns.wacc.weights.currency")).toBe(false);
  });
});

describe("ROIC invested capital uses the house cash convention", () => {
  const income = [
    { date: "2025-12-31", revenue: 1000, operatingIncome: 200, ebit: 200, incomeBeforeTax: 180, incomeTaxExpense: 36 },
    { date: "2024-12-31", revenue: 900, operatingIncome: 180, ebit: 180, incomeBeforeTax: 160, incomeTaxExpense: 32 },
  ];

  const balanceRow = (over: Record<string, unknown>) => ({
    date: "2025-12-31",
    totalDebt: 500,
    totalStockholdersEquity: 1500,
    cashAndCashEquivalents: 100,
    totalAssets: 3000,
    ...over,
  });

  it("subtracts cash + short-term investments, not cash alone", () => {
    // Same company; the second row simply discloses that 400 of its liquidity
    // sits in short-term investments rather than in cash.
    const cashOnly = computeRoic(income, [
      balanceRow({}),
      balanceRow({ date: "2024-12-31" }),
    ]);
    const withSti = computeRoic(income, [
      balanceRow({ shortTermInvestments: 400 }),
      balanceRow({ date: "2024-12-31", shortTermInvestments: 400 }),
    ]);

    expect(cashOnly.latestRoicPct).not.toBeNull();
    expect(withSti.latestRoicPct).not.toBeNull();
    // Less invested capital for the same NOPAT ⇒ strictly higher ROIC.
    expect(withSti.latestRoicPct as number).toBeGreaterThan(cashOnly.latestRoicPct as number);
  });

  it("prefers the combined cashAndShortTermInvestments field when present", () => {
    const combined = computeRoic(income, [
      balanceRow({ cashAndShortTermInvestments: 500 }),
      balanceRow({ date: "2024-12-31", cashAndShortTermInvestments: 500 }),
    ]);
    const components = computeRoic(income, [
      balanceRow({ shortTermInvestments: 400 }),
      balanceRow({ date: "2024-12-31", shortTermInvestments: 400 }),
    ]);

    expect(combined.latestRoicPct).toBeCloseTo(components.latestRoicPct as number, 10);
  });

  it("still suppresses when no cash basis can be resolved at all", () => {
    const r = computeRoic(income, [
      balanceRow({ cashAndCashEquivalents: null }),
      balanceRow({ date: "2024-12-31", cashAndCashEquivalents: null }),
    ]);

    expect(r.latestRoicPct).toBeNull();
  });
});
