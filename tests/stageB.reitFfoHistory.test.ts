import { describe, expect, it } from "vitest";

import {
  multiplesFramework,
  type EnterpriseValuesRow,
  type MultiplesFrameworkInputs,
  type QuarterlyFundamentalsRow,
} from "@/pipeline/stageB/valuation";

/**
 * Equity REITs are scored on P/FFO and P/AFFO alone
 * (SECTOR_APPROPRIATE_MULTIPLES.reit), and `multiplePercentile` over those two
 * keys is the REIT branch's ONLY valuation signal at weight 1.0.
 *
 * But `DERIVED_HISTORY_KEYS` contained neither key, so no own-history band
 * could ever be derived for them; the vendor pre-baked history does not carry
 * P/FFO either. Every equity REIT therefore scored a null valuation aspect and
 * had its composite permanently shrunk toward 50 — for evidence the pipeline
 * could compute all along, since `compute.ts` already builds the CURRENT
 * ffoApprox as netIncome + D&A from the same quarterly rows.
 */
const QUARTERS = 24;

function quarterDates(count: number): string[] {
  const suffixes = ["12-31", "09-30", "06-30", "03-31"];
  return Array.from({ length: count }, (_, index) => {
    const year = 2026 - Math.floor(index / 4);
    return `${year}-${suffixes[index % 4]}`;
  });
}

function quarters(): QuarterlyFundamentalsRow[] {
  return quarterDates(QUARTERS).map((date, index) => ({
    date,
    revenue: 100,
    operatingIncome: 30,
    // Vary D&A slightly so the FFO series is not degenerate. The FFO history
    // reads the INCOME-statement field specifically, matching how the current
    // ffoApprox is built.
    depreciationAndAmortization: 20 + (index % 3),
    incomeDepreciationAndAmortization: 20 + (index % 3),
    netIncome: 10,
    operatingCashFlow: 28,
    capitalExpenditure: -5,
    totalStockholdersEquity: 500,
    totalDebt: 0,
    cashAndShortTermInvestments: 0,
    preferredStock: 0,
    minorityInterest: 0,
  }));
}

function evHistory(dates: readonly string[]): EnterpriseValuesRow[] {
  return dates.map((date) => ({ date, marketCapitalization: 1200, enterpriseValue: 1200 }));
}

function reitInputs(): MultiplesFrameworkInputs {
  const q = quarters();
  return {
    quote: { price: 30, marketCap: 1200, currency: "USD" },
    reportedCurrency: "USD",
    incomeTtm: { date: "2026-12-31", revenue: 400, operatingIncome: 120, netIncome: 40, depreciationAndAmortization: 80, epsDiluted: 1 },
    cashFlowTtm: { date: "2026-12-31", operatingCashFlow: 112, capitalExpenditure: -20, depreciationAndAmortization: 80 },
    balance: {
      date: "2026-12-31",
      totalDebt: 0,
      cashAndShortTermInvestments: 0,
      totalStockholdersEquity: 500,
      goodwill: 0,
      intangibleAssets: 0,
      minorityInterest: 0,
      preferredStock: 0,
    },
    quarterlyFundamentals: q,
    enterpriseValuesHistory: evHistory(q.map((r) => r.date)),
    // Current FFO/AFFO as compute.ts builds them: NI + D&A, then minus |capex|.
    ffoApprox: 40 + 80,
    affoApprox: 40 + 80 - 20,
  } as MultiplesFrameworkInputs;
}

describe("equity REITs get a derived P/FFO own-history band", () => {
  it("builds own-history observations for priceToFfo and priceToAffo", () => {
    const r = multiplesFramework("reit", reitInputs());

    const ffo = r.multiples.find((m) => m.key === "priceToFfo");
    const affo = r.multiples.find((m) => m.key === "priceToAffo");

    expect(ffo?.current).not.toBeNull();
    expect(ffo?.ownHistory).not.toBeNull();
    expect(ffo?.ownHistory?.observations ?? 0).toBeGreaterThan(0);
    expect(affo?.ownHistory?.observations ?? 0).toBeGreaterThan(0);
  });

  it("gives the REIT a percentile rank, which is its only valuation signal", () => {
    const r = multiplesFramework("reit", reitInputs());
    const ffo = r.multiples.find((m) => m.key === "priceToFfo");

    expect(ffo?.ownHistory?.percentileRank).not.toBeNull();
  });

  it("derives the history the same way the current value is built (NI + D&A)", () => {
    const r = multiplesFramework("reit", reitInputs());
    const ffo = r.multiples.find((m) => m.key === "priceToFfo");

    // Four quarters of NI 10 and D&A 20..22 => TTM FFO in [120, 128];
    // mcap 1200 => P/FFO in [9.3, 10.0].
    const p5 = ffo?.ownHistory?.p5;
    const p95 = ffo?.ownHistory?.p95;
    expect(p5).not.toBeUndefined();
    expect(p95).not.toBeUndefined();
    expect(p5 as number).toBeGreaterThan(9);
    expect(p95 as number).toBeLessThan(10.1);
  });

  it("does not derive REIT-only series for a general issuer", () => {
    const r = multiplesFramework("general", reitInputs());

    // priceToFfo is not a general-route multiple at all.
    expect(r.multiples.some((m) => m.key === "priceToFfo")).toBe(false);
  });
});
