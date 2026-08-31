import { describe, expect, it } from "vitest";

import {
  valueCompany,
  type MultiplesFrameworkInputs,
} from "@/pipeline/stageB/valuation";
import { computeFairValue } from "@/pipeline/stageB/fairValue";
import type { CompanyRoute } from "@/types/core";

/**
 * The general DCF route suppresses its per-share value when the statements'
 * reportedCurrency differs from the quote currency, because the intrinsic value
 * would be denominated in the reporting currency while the price it is graded
 * against is in the trading currency (the ADR case; the code cites TSM, where
 * the error is roughly +800%).
 *
 * The bank / insurer / mortgage-REIT route produces a per-share value the exact
 * same way — `excessReturn.perShare`, consumed by `computeFairValue` for
 * `upsidePct` — so it needs the same guard. A foreign bank with a US listing is
 * an ordinary case, not an exotic one.
 */
const route = (
  base: CompanyRoute["base"],
  overlays: CompanyRoute["overlays"] = [],
): CompanyRoute => ({ base, overlays, evidence: { sector: null, industry: null } });

/** Statements in TWD, quote in USD — the mismatch the DCF guard exists for. */
function adrMultiples(): MultiplesFrameworkInputs {
  return {
    quote: { price: 100, marketCap: 10000, currency: "USD" },
    reportedCurrency: "TWD",
    incomeTtm: {
      date: "2025-12-31",
      revenue: 1000,
      operatingIncome: 200,
      depreciationAndAmortization: 50,
      netIncome: 144,
      epsDiluted: 1.44,
    },
    cashFlowTtm: {
      date: "2025-12-31",
      operatingCashFlow: 180,
      capitalExpenditure: -30,
      depreciationAndAmortization: 50,
    },
    balance: {
      date: "2025-12-31",
      totalDebt: 300,
      cashAndShortTermInvestments: 100,
      totalStockholdersEquity: 500,
      goodwill: 50,
      intangibleAssets: 50,
      minorityInterest: 0,
      preferredStock: 0,
    },
  };
}

const EXCESS_RETURN_INPUTS = {
  bookValue: 500,
  currentRoePct: 12,
  costOfEquityPct: 10,
  years: 10,
  payoutRatioPct: 40,
  dilutedShares: 100,
  marketCap: 600,
} as const;

describe("ADR currency guard on the excess-return route", () => {
  it("suppresses the excess-return per-share when reported and quote currency differ", () => {
    const r = valueCompany(route("bank"), {
      currentPrice: 100,
      waccPct: 9,
      netDebt: 200,
      dilutedShares: 100,
      dcfInputs: null,
      multiples: adrMultiples(),
      excessReturn: { ...EXCESS_RETURN_INPUTS },
      reit: null,
    });

    expect(r.kind).toBe("excess-return");
    if (r.kind !== "excess-return") return;

    expect(r.excessReturn.perShare).toBeNull();
    expect(r.gaps.some((g) => g.field === "valuation.excessReturn.currency")).toBe(true);
    expect(r.notes.join(" ")).toMatch(/TWD[\s\S]*USD|currency/i);
  });

  it("does not report a cross-currency upside for an ADR bank", () => {
    const r = valueCompany(route("bank"), {
      currentPrice: 100,
      waccPct: 9,
      netDebt: 200,
      dilutedShares: 100,
      dcfInputs: null,
      multiples: adrMultiples(),
      excessReturn: { ...EXCESS_RETURN_INPUTS },
      reit: null,
    });

    const fv = computeFairValue({
      valuation: r,
      currentPrice: 100,
      currency: "USD",
      asOf: "2025-12-31",
    });

    expect(fv.status).toBe("suppressed");
    expect(fv.upsidePct).toBeNull();
  });

  it("still values a same-currency bank normally", () => {
    const same = adrMultiples();
    same.reportedCurrency = "USD";

    const r = valueCompany(route("bank"), {
      currentPrice: 100,
      waccPct: 9,
      netDebt: 200,
      dilutedShares: 100,
      dcfInputs: null,
      multiples: same,
      excessReturn: { ...EXCESS_RETURN_INPUTS },
      reit: null,
    });

    expect(r.kind).toBe("excess-return");
    if (r.kind !== "excess-return") return;

    expect(r.excessReturn.perShare).not.toBeNull();
    expect(r.gaps.some((g) => g.field === "valuation.excessReturn.currency")).toBe(false);
  });
});
