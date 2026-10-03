import { describe, expect, it } from "vitest";

import { runStageB } from "@/pipeline/compute";
import type { DataBundle } from "@/pipeline/types";
import { currencyBundle, M } from "./helpers/currencyBundle";

function historyBundle(family: "income" | "cashflow", olderCurrency: string | null, linked = false): DataBundle {
  const bundle = currencyBundle({ siblingQuarterCurrencies: ["USD", "USD", "USD", "USD"] });
  const dates = Array.from({ length: 15 }, (_, index) =>
    new Date(Date.UTC(2026, 3 - index * 3, 0)).toISOString().slice(0, 10),
  );
  const rows = <T extends object>(data: T[]) => ({
    ok: true as const,
    value: { data: { rows: data, raw: {} }, source: "fmp" as const, endpoint: "fixture", asOf: dates[0]!, fetchedAt: bundle.builtAt },
  });
  const evidence = (date: string) => linked ? { cik: "0000000042", acceptedDate: `${date} 16:05:00` } : {};
  const currency = (member: "income" | "cashflow", index: number) =>
    family === member && index >= 4
      ? (olderCurrency === null ? {} : { reportedCurrency: olderCurrency })
      : { reportedCurrency: "USD" };
  bundle.statements.incomeQuarterly = rows(dates.map((date, index) => ({
    date, ...evidence(date), ...currency("income", index),
    revenue: 300 * M, operatingIncome: 60 * M, netIncome: 45 * M,
    epsDiluted: 0.45, weightedAverageShsOutDil: 100 * M,
    interestExpense: 4 * M, incomeBeforeTax: 57 * M, incomeTaxExpense: 12 * M,
    depreciationAndAmortization: 12.5 * M,
  })));
  bundle.statements.cashflowQuarterly = rows(dates.map((date, index) => ({
    date, ...evidence(date), ...currency("cashflow", index),
    operatingCashFlow: 55 * M, capitalExpenditure: -10 * M,
  })));
  bundle.statements.balanceQuarterly = rows(dates.map((date) => ({
    date, ...evidence(date), reportedCurrency: "USD", totalDebt: 0,
    cashAndShortTermInvestments: 120 * M, totalStockholdersEquity: 520 * M,
    totalAssets: 2050 * M, goodwill: 40 * M, intangibleAssets: 10 * M,
    minorityInterest: 0, preferredStock: 0,
  })));
  bundle.enterpriseValues = rows(dates.map((date) => ({
    date, marketCapitalization: 10000 * M, enterpriseValue: 9880 * M,
  })));
  return bundle;
}

function multiplesOf(result: ReturnType<typeof runStageB>) {
  if (result.valuation.multiples === null) throw new Error("expected general-route multiples");
  return result.valuation.multiples.multiples;
}

describe("own-history multiples use only quarters established in the model currency", () => {
  for (const currency of ["EUR", null]) {
    it(`excludes older income quarters whose currency is ${currency ?? "unknown"}`, () => {
      const result = runStageB(historyBundle("income", currency));
      const multiples = multiplesOf(result);
      // Only the latest four income quarters qualify: one valid TTM window,
      // below the eight observations required to publish a historical band.
      for (const key of ["peTtm", "evToSales", "evToEbitda"]) {
        expect(multiples.find((m) => m.key === key)?.ownHistory).toBeNull();
      }
      expect(multiples.find((m) => m.key === "peTtm")?.current).toBeCloseTo(55.5555555556, 8);
      expect(result.gaps.find((g) => g.field === "compute.incomeQuarterly.currency")?.reason).toMatch(/EUR|unknown/);
    });
    it(`excludes older cash-flow quarters whose currency is ${currency ?? "unknown"}`, () => {
      const result = runStageB(historyBundle("cashflow", currency));
      const multiples = multiplesOf(result);
      expect(multiples.find((m) => m.key === "priceToFcf")?.ownHistory).toBeNull();
      expect(multiples.find((m) => m.key === "peTtm")?.ownHistory?.observations).toBe(12);
      expect(result.gaps.find((g) => g.field === "compute.cashflowQuarterly.currency")?.reason).toMatch(/EUR|unknown/);
    });
  }

  it("keeps the twelve windows when every quarter states USD", () => {
    const result = runStageB(historyBundle("income", "USD"));
    const multiples = multiplesOf(result);
    expect(multiples.find((m) => m.key === "evToSales")?.ownHistory).toMatchObject({ observations: 12 });
    expect(multiples.find((m) => m.key === "evToSales")?.ownHistory?.p50).toBeCloseTo(8.2333333333, 8);
    expect(multiples.find((m) => m.key === "priceToFcf")?.ownHistory?.p50).toBeCloseTo(55.5555555556, 8);
  });

  it("keeps quarters whose missing currency is established by their own filing's statements", () => {
    const result = runStageB(historyBundle("income", null, true));
    expect(multiplesOf(result).find((m) => m.key === "peTtm")?.ownHistory?.observations).toBe(12);
    expect(result.gaps.some((g) => g.field === "compute.incomeQuarterly.currency")).toBe(false);
  });
});
