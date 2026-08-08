/**
 * Stage B sector routing / overlays / metric policy / degradation / runway.
 * Pure tests — no network, no db.
 */

import { describe, expect, it } from "vitest";

import {
  ADR_RATIOS,
  BURN_WINDOW_MAX_QUARTERS,
  DAYS_PER_QUARTER,
  PRE_REVENUE_TTM_REVENUE_FLOOR_USD,
  RECENT_IPO_MIN_QUARTERS,
  RECENT_IPO_WINDOW_MONTHS,
  SECTOR_ETF_MAP,
  SPY_BENCHMARK,
  computeRunway,
  degradationPlan,
  lookupAdrRatio,
  lookupSectorEtf,
  metricPolicy,
  routeCompany,
  type RoutingProfile,
  type RoutingStatements,
  type RunwayBalanceInput,
  type RunwayCashflowQuarter,
  type ShareCountQuarter,
} from "@/pipeline/stageB/sectorRouting";

const TODAY = "2026-07-06";

function profile(over: Partial<RoutingProfile> = {}): RoutingProfile {
  return {
    sector: "Technology",
    industry: "Consumer Electronics",
    isAdr: false,
    isEtf: false,
    isFund: false,
    ipoDate: "1980-12-12",
    country: "US",
    currency: "USD",
    sic: null,
    ...over,
  };
}

function profitableStatements(over: Partial<RoutingStatements> = {}): RoutingStatements {
  return {
    incomeTtm: {
      date: "2026-03-28",
      revenue: 400_000_000_000,
      netIncome: 100_000_000_000,
      reportedCurrency: "USD",
    },
    incomeAnnual: {
      date: "2025-09-27",
      revenue: 416_161_000_000,
      netIncome: 112_010_000_000,
      reportedCurrency: "USD",
    },
    cashflowTtm: { date: "2026-03-28", operatingCashFlow: 120_000_000_000 },
    cashflowAnnual: { date: "2025-09-27", operatingCashFlow: 118_000_000_000 },
    availableQuarters: 40,
    ...over,
  };
}

function route(p: Partial<RoutingProfile> = {}, s: Partial<RoutingStatements> = {}) {
  return routeCompany(profile(p), profitableStatements(s), { today: TODAY });
}

// ---------------------------------------------------------------------------
// Base routing — industry-prefix matching first
// ---------------------------------------------------------------------------

describe("routeCompany base routing", () => {
  it("'Banks - Regional' -> bank", () => {
    const r = route({ sector: "Financial Services", industry: "Banks - Regional" });
    expect(r.base).toBe("bank");
    expect(r.overlays).toEqual([]);
    expect(r.evidence).toEqual({ sector: "Financial Services", industry: "Banks - Regional", sic: null });
  });

  it("is case-insensitive and trims (' banks - DIVERSIFIED ')", () => {
    const r = route({ sector: "Financial Services", industry: "  banks - DIVERSIFIED  " });
    expect(r.base).toBe("bank");
    expect(r.evidence.industry).toBe("banks - DIVERSIFIED");
  });

  it("'Insurance - Property & Casualty' -> insurer", () => {
    const r = route({ sector: "Financial Services", industry: "Insurance - Property & Casualty" });
    expect(r.base).toBe("insurer");
  });

  it("'Insurance - Brokers' -> general (fee-based, not balance-sheet; research §3)", () => {
    const r = route({ sector: "Financial Services", industry: "Insurance - Brokers" });
    expect(r.base).toBe("general");
    expect(r.notes.some((n) => /broker/i.test(n) && /GENERAL/i.test(n))).toBe(true);
  });

  it("'REIT - Mortgage' -> reit-mortgage (checked before generic REIT prefix)", () => {
    const r = route({ sector: "Real Estate", industry: "REIT - Mortgage" });
    expect(r.base).toBe("reit-mortgage");
  });

  it("'REIT - Industrial' -> reit", () => {
    const r = route({ sector: "Real Estate", industry: "REIT - Industrial" });
    expect(r.base).toBe("reit");
  });

  it("Financial Services sector without bank/insurance/REIT industry -> general with note", () => {
    const r = route({ sector: "Financial Services", industry: "Asset Management" });
    expect(r.base).toBe("general");
    expect(r.notes.some((n) => n.includes("Financial Services"))).toBe(true);
  });

  it("falls back to SIC when industry gives no match (6021 -> bank)", () => {
    const r = route({ sector: null, industry: null, sic: "6021 NATIONAL COMMERCIAL BANKS" });
    expect(r.base).toBe("bank");
    expect(r.evidence.sic).toBe("6021 NATIONAL COMMERCIAL BANKS");
  });

  it("SIC 6411 -> insurer; SIC 6798 -> reit (with mortgage-indeterminate note)", () => {
    expect(route({ industry: null, sector: null, sic: "6411" }).base).toBe("insurer");
    const reit = route({ industry: null, sector: null, sic: "6798" });
    expect(reit.base).toBe("reit");
    expect(reit.notes.some((n) => n.includes("SIC alone"))).toBe(true);
  });

  it("missing sector+industry+sic -> general with a route.base gap", () => {
    const r = route({ sector: null, industry: null, sic: null });
    expect(r.base).toBe("general");
    expect(r.gaps.some((g) => g.field === "route.base" && g.severity === "warn")).toBe(true);
  });

  it("ETF/fund -> critical gap, no company routing", () => {
    const r = route({ isEtf: true });
    expect(r.gaps.some((g) => g.field === "route.base" && g.severity === "critical")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

describe("routeCompany overlays", () => {
  it("Biotechnology + negative NI + $3M revenue -> general + [unprofitable, pre-revenue]", () => {
    const r = route(
      { sector: "Healthcare", industry: "Biotechnology" },
      {
        incomeTtm: {
          date: "2026-03-31",
          revenue: 3_000_000,
          netIncome: -50_000_000,
          reportedCurrency: "USD",
        },
        cashflowTtm: { date: "2026-03-31", operatingCashFlow: -45_000_000 },
        availableQuarters: 30,
      },
    );
    expect(r.base).toBe("general");
    expect(r.overlays).toEqual(["unprofitable", "pre-revenue"]);
    // house-rule thresholds must be annotated in notes
    expect(r.notes.some((n) => n.includes("house rule") && n.includes("pre-revenue"))).toBe(true);
    expect(r.notes.some((n) => n.toLowerCase().includes("unprofitable"))).toBe(true);
  });

  it("pre-revenue floor is strict: revenue exactly $10M is NOT pre-revenue", () => {
    const r = route({}, {
      incomeTtm: {
        date: "2026-03-31",
        revenue: PRE_REVENUE_TTM_REVENUE_FLOOR_USD,
        netIncome: 1,
        reportedCurrency: "USD",
      },
    });
    expect(r.overlays).not.toContain("pre-revenue");
  });

  it("unprofitable triggers on negative OCF even when net income is positive", () => {
    const r = route({}, { cashflowTtm: { date: "2026-03-31", operatingCashFlow: -1 } });
    expect(r.overlays).toContain("unprofitable");
  });

  it("netIncome/OCF of exactly 0 does not trigger unprofitable", () => {
    const r = route(
      {},
      {
        incomeTtm: {
          date: "2026-03-31",
          revenue: 5_000_000_000,
          netIncome: 0,
          reportedCurrency: "USD",
        },
        cashflowTtm: { date: "2026-03-31", operatingCashFlow: 0 },
      },
    );
    expect(r.overlays).not.toContain("unprofitable");
  });

  it("falls back to annual statements when TTM missing (with a note)", () => {
    const r = route(
      {},
      {
        incomeTtm: null,
        cashflowTtm: null,
        incomeAnnual: {
          date: "2025-12-31",
          revenue: 2_000_000,
          netIncome: -10_000_000,
          reportedCurrency: "USD",
        },
        cashflowAnnual: { date: "2025-12-31", operatingCashFlow: -8_000_000 },
      },
    );
    expect(r.overlays).toEqual(["unprofitable", "pre-revenue"]);
    expect(r.notes.some((n) => n.includes("annual"))).toBe(true);
  });

  it("records gaps instead of throwing when statements are entirely missing", () => {
    const r = route(
      {},
      { incomeTtm: null, incomeAnnual: null, cashflowTtm: null, cashflowAnnual: null, availableQuarters: null },
    );
    expect(r.gaps.some((g) => g.field === "route.overlays.unprofitable")).toBe(true);
    expect(r.gaps.some((g) => g.field === "route.overlays.preRevenue")).toBe(true);
    expect(r.overlays).toEqual([]);
  });

  it("recent-ipo by date: ipoDate within 24 months of today", () => {
    const r = route({ ipoDate: "2025-01-15" });
    expect(r.overlays).toContain("recent-ipo");
    expect(r.notes.some((n) => n.includes(`${RECENT_IPO_WINDOW_MONTHS} months`))).toBe(true);
  });

  it("recent-ipo date boundary: exactly 24 months ago is included, one day more is not", () => {
    expect(route({ ipoDate: "2024-07-06" }).overlays).toContain("recent-ipo");
    expect(route({ ipoDate: "2024-07-05" }).overlays).not.toContain("recent-ipo");
  });

  // Audit 2026-07-11 finding #4: sparse quarterly history is NOT evidence of a
  // recent IPO. A recent-ipo overlay requires a VERIFIED ipoDate inside the
  // window; a mature issuer with incomplete data coverage is "insufficient
  // historical coverage", disclosed as a gap, never routed as a recent IPO.
  it("mature issuer with sparse history is NOT recent-ipo — insufficient historical coverage instead (audit #4)", () => {
    const r = route({ ipoDate: "2000-01-01" }, { availableQuarters: 5 });
    expect(r.overlays).not.toContain("recent-ipo");
    expect(r.gaps.some((g) => g.field === "route.insufficientHistory")).toBe(true);
  });

  it("AAPL-style mature issuer with only 4 fixture quarters is NOT recent-ipo", () => {
    // Default profile ipoDate is 1980-12-12 (see profile() helper).
    const r = route({}, { availableQuarters: 4 });
    expect(r.overlays).not.toContain("recent-ipo");
    expect(r.gaps.some((g) => g.field === "route.insufficientHistory")).toBe(true);
  });

  it("missing ipoDate with sparse history is NOT recent-ipo (no verified listing date)", () => {
    const r = route({ ipoDate: null }, { availableQuarters: 3 });
    expect(r.overlays).not.toContain("recent-ipo");
    expect(r.gaps.some((g) => g.field === "route.insufficientHistory")).toBe(true);
  });

  it("genuine recent IPO (verified ipoDate in window) still routes recent-ipo with sparse history", () => {
    const r = route({ ipoDate: "2025-06-01" }, { availableQuarters: 3 });
    expect(r.overlays).toContain("recent-ipo");
    // Thin history is EXPECTED for a genuine recent IPO — no insufficient-coverage gap.
    expect(r.gaps.some((g) => g.field === "route.insufficientHistory")).toBe(false);
  });

  it("mature issuer with full history is neither recent-ipo nor insufficient-coverage", () => {
    const r = route({ ipoDate: "2000-01-01" }, { availableQuarters: RECENT_IPO_MIN_QUARTERS });
    expect(r.overlays).not.toContain("recent-ipo");
    expect(r.gaps.some((g) => g.field === "route.insufficientHistory")).toBe(false);
  });

  it("TSM profile -> adr overlay; overlays compose in fixed order", () => {
    const r = route(
      { sector: "Technology", industry: "Semiconductors", isAdr: true, country: "TW", ipoDate: "1997-10-08" },
      {
        incomeTtm: {
          date: "2026-03-31",
          revenue: 3_000_000,
          netIncome: -1,
          reportedCurrency: "USD",
        },
        cashflowTtm: { date: "2026-03-31", operatingCashFlow: -1 },
      },
    );
    expect(r.base).toBe("general");
    expect(r.overlays).toEqual(["unprofitable", "pre-revenue", "adr"]);
  });

  it("carries the inputs' as-of dates for provenance", () => {
    const r = route();
    expect(r.asOf.today).toBe(TODAY);
    expect(r.asOf.incomeTtm).toBe("2026-03-28");
    expect(r.asOf.incomeAnnual).toBe("2025-09-27");
  });

  it("throws TypeError only for the programming error of an unparseable today", () => {
    expect(() => routeCompany(profile(), profitableStatements(), { today: "garbage" })).toThrow(TypeError);
  });
});

describe("routeCompany pre-revenue currency gate", () => {
  it.each([
    { revenue: 0, reportedCurrency: "USD", expected: true },
    { revenue: 9_999_999, reportedCurrency: "  usd  ", expected: true },
    { revenue: 10_000_000, reportedCurrency: "USD", expected: false },
  ])(
    "applies the raw USD threshold without losing zero or the strict boundary: $revenue $reportedCurrency",
    ({ revenue, reportedCurrency, expected }) => {
      const r = route({}, {
        incomeTtm: {
          date: "2026-03-31",
          revenue,
          netIncome: 1,
          reportedCurrency,
        },
      });

      expect(r.overlays.includes("pre-revenue")).toBe(expected);
      expect(r.gaps.filter((g) => g.field === "route.overlays.preRevenue.currency")).toHaveLength(0);
    },
  );

  it.each([
    { label: "JPY/low", revenue: 5_000_000 },
    { label: "JPY/high", revenue: 500_000_000 },
  ])("skips only the pre-revenue overlay and discloses non-USD currency for $label", ({ revenue }) => {
    const r = route(
      {},
      {
        incomeTtm: {
          date: "2026-03-31",
          revenue,
          netIncome: -1,
          reportedCurrency: "JPY",
        },
        cashflowTtm: { date: "2026-03-31", operatingCashFlow: -1 },
      },
    );

    expect(r.overlays).toEqual(["unprofitable"]);
    const currencyGaps = r.gaps.filter((g) => g.field === "route.overlays.preRevenue.currency");
    expect(currencyGaps).toHaveLength(1);
    expect(currencyGaps[0]).toEqual(
      expect.objectContaining({
        severity: "warn",
        reason: expect.stringMatching(/ttm revenue.*JPY.*proven USD.*10,000,000.*no FX conversion/i),
      }),
    );
  });

  it.each([
    { label: "missing", reportedCurrency: null },
    { label: "invalid", reportedCurrency: "US$" },
  ])("skips the currency-sensitive threshold when the selected observation currency is $label", ({ reportedCurrency }) => {
    const r = route({}, {
      incomeTtm: {
        date: "2026-03-31",
        revenue: 1,
        netIncome: 1,
        reportedCurrency,
      },
    });

    expect(r.overlays).not.toContain("pre-revenue");
    const currencyGaps = r.gaps.filter((g) => g.field === "route.overlays.preRevenue.currency");
    expect(currencyGaps).toHaveLength(1);
    expect(currencyGaps[0].reason).toMatch(/ttm revenue.*unknown or invalid.*proven USD/i);
  });

  it("evaluates the annual fallback only when TTM revenue is unavailable, using that annual row's currency", () => {
    const annualUsd = route({}, {
      incomeTtm: null,
      incomeAnnual: {
        date: "2025-12-31",
        revenue: 9_999_999,
        netIncome: 1,
        reportedCurrency: " usd ",
      },
    });
    expect(annualUsd.overlays).toContain("pre-revenue");
    expect(annualUsd.gaps.some((g) => g.field === "route.overlays.preRevenue.currency")).toBe(false);

    const annualJpy = route({}, {
      incomeTtm: null,
      incomeAnnual: {
        date: "2025-12-31",
        revenue: 1,
        netIncome: 1,
        reportedCurrency: "JPY",
      },
    });
    expect(annualJpy.overlays).not.toContain("pre-revenue");
    expect(annualJpy.gaps.filter((g) => g.field === "route.overlays.preRevenue.currency")).toHaveLength(1);
    expect(annualJpy.gaps.find((g) => g.field === "route.overlays.preRevenue.currency")?.reason).toMatch(
      /annual revenue.*JPY/i,
    );
    expect(annualJpy.notes.some((note) => /pre-revenue overlay evaluated/i.test(note))).toBe(false);
  });

  it("does not replace a selected non-USD TTM revenue observation with an annual USD row", () => {
    const r = route({}, {
      incomeTtm: {
        date: "2026-03-31",
        revenue: 1,
        netIncome: 1,
        reportedCurrency: "JPY",
      },
      incomeAnnual: {
        date: "2025-12-31",
        revenue: 1,
        netIncome: 1,
        reportedCurrency: "USD",
      },
    });

    expect(r.overlays).not.toContain("pre-revenue");
    expect(r.gaps.filter((g) => g.field === "route.overlays.preRevenue.currency")).toHaveLength(1);
    expect(r.gaps.find((g) => g.field === "route.overlays.preRevenue.currency")?.reason).toMatch(/ttm revenue.*JPY/i);
    expect(r.notes.some((note) => /pre-revenue.*annual/i.test(note))).toBe(false);
  });

  it("keeps missing revenue on the existing revenue-gap path without adding a currency gap", () => {
    const r = route({}, {
      incomeTtm: {
        date: "2026-03-31",
        revenue: null,
        netIncome: 1,
        reportedCurrency: null,
      },
      incomeAnnual: null,
    });

    expect(r.overlays).not.toContain("pre-revenue");
    expect(r.gaps.filter((g) => g.field === "route.overlays.preRevenue")).toHaveLength(1);
    expect(r.gaps.filter((g) => g.field === "route.overlays.preRevenue.currency")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ADR ratio map + lookup
// ---------------------------------------------------------------------------

describe("ADR_RATIOS / lookupAdrRatio", () => {
  it("TSM: 1 ADS = 5 ordinary shares, 21% withholding, TSMC IR source", () => {
    const res = lookupAdrRatio("tsm");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.symbol).toBe("TSM");
      expect(res.ratio.ordinarySharesPerAds).toBe(5);
      expect(res.ratio.withholdingPct).toBe(21);
      expect(res.ratio.country).toBe("TW");
      expect(res.ratio.source).toBe("TSMC IR Jan-2026");
    }
    expect(ADR_RATIOS.TSM.ordinarySharesPerAds).toBe(5);
  });

  it("unknown ADR -> gap path (never throws)", () => {
    const res = lookupAdrRatio("NVO");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.gap.field).toBe("adr.ratio");
      expect(res.gap.severity).toBe("warn");
      expect(res.gap.reason).toContain("NVO");
    }
  });
});

// ---------------------------------------------------------------------------
// Sector ETF map
// ---------------------------------------------------------------------------

describe("SECTOR_ETF_MAP / lookupSectorEtf", () => {
  it("maps all 11 FMP sectors to SPDR ETFs with the SPY benchmark", () => {
    expect(Object.keys(SECTOR_ETF_MAP)).toHaveLength(11);
    expect(SECTOR_ETF_MAP["Technology"]).toEqual({ etf: "XLK", benchmark: SPY_BENCHMARK });
    expect(SECTOR_ETF_MAP["Real Estate"].etf).toBe("XLRE");
    for (const entry of Object.values(SECTOR_ETF_MAP)) expect(entry.benchmark).toBe("SPY");
  });

  it("lookup is case-insensitive/trimmed; unknown sector degrades to SPY-only with a gap", () => {
    const hit = lookupSectorEtf("  financial services ");
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.etf).toBe("XLF");
    const miss = lookupSectorEtf("Conglomerates");
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.benchmark).toBe("SPY");
      expect(miss.gap.severity).toBe("info");
    }
  });
});

// ---------------------------------------------------------------------------
// metricPolicy
// ---------------------------------------------------------------------------

describe("metricPolicy", () => {
  it("bank suppression list contains evEbitda (hard product rule) and friends", () => {
    const policy = metricPolicy("bank");
    for (const banned of ["evEbitda", "currentRatio", "fcfDcf", "altmanZ", "beneishM"]) {
      expect(policy.suppress).toContain(banned);
    }
    expect(policy.lead).toContain("pTbv");
    expect(policy.lead).toContain("rote");
  });

  it("suppress always wins over lead when overlays compose", () => {
    const policy = metricPolicy({
      base: "general",
      overlays: ["unprofitable", "pre-revenue"],
      evidence: { sector: "Healthcare", industry: "Biotechnology" },
    });
    // base general leads with pe/evEbitda, but overlays suppress them
    expect(policy.suppress).toContain("pe");
    expect(policy.suppress).toContain("evEbitda");
    expect(policy.lead).not.toContain("pe");
    expect(policy.lead).not.toContain("evEbitda");
    // pre-revenue suppresses evToSales even though unprofitable leads with it
    expect(policy.lead).not.toContain("evToSales");
    expect(policy.lead).toContain("cashRunway");
  });

  it("reit suppresses EPS-led framing; reit-mortgage suppresses FFO", () => {
    expect(metricPolicy("reit").suppress).toContain("pe");
    expect(metricPolicy("reit").lead).toContain("pFfo");
    expect(metricPolicy("reit-mortgage").suppress).toContain("pFfo");
    expect(metricPolicy("reit-mortgage").lead).toContain("priceToBook");
  });

  it("returns fresh arrays (no shared mutable state)", () => {
    const a = metricPolicy("bank");
    a.suppress.push("mutated");
    expect(metricPolicy("bank").suppress).not.toContain("mutated");
  });
});

// ---------------------------------------------------------------------------
// degradationPlan
// ---------------------------------------------------------------------------

describe("degradationPlan", () => {
  it("recent-ipo: no-5y/10y-CAGRs note and thin-estimates note present", () => {
    const plan = degradationPlan("general", ["recent-ipo"], 5);
    const all = plan.items.map((i) => i.disclosure).join("\n");
    expect(all).toContain("No 5y/10y CAGRs");
    expect(all).toContain("5 quarters");
    expect(all).toContain("thin coverage");
    expect(plan.items.some((i) => i.target === "technicals.sma200" && i.action === "suppress")).toBe(true);
  });

  it("pre-revenue: valuation replaced by runway framing", () => {
    const plan = degradationPlan("general", ["pre-revenue", "unprofitable"], 12);
    const valuation = plan.items.find((i) => i.target === "valuation" && i.action === "replace");
    expect(valuation).toBeDefined();
    expect(valuation?.replacement).toBe("runway-framing");
    expect(valuation?.disclosure).toContain("runway framing");
    expect(valuation?.disclosure).toContain("house rule");
    // unprofitable adds the DCF replacement too
    expect(plan.items.some((i) => i.target === "valuation.dcf" && i.action === "replace")).toBe(true);
  });

  it("bank route degrades forensics and DCF with disclosures", () => {
    const plan = degradationPlan("bank", [], 40);
    const targets = plan.items.map((i) => i.target);
    expect(targets).toContain("valuation.evEbitda");
    expect(targets).toContain("forensics");
    expect(plan.items.find((i) => i.target === "valuation.dcf")?.replacement).toBe("excess-return-model");
  });

  it("adr overlay yields gross-yield / currency / cadence annotations", () => {
    const plan = degradationPlan("general", ["adr"], 40);
    const all = plan.items.map((i) => i.disclosure).join("\n");
    expect(all).toContain("GROSS");
    expect(all).toContain("reportedCurrency");
    expect(all).toContain("20-F");
  });

  it("unknown quarter depth on recent-ipo records an info gap", () => {
    const plan = degradationPlan("general", ["recent-ipo"], null);
    expect(plan.gaps.some((g) => g.field === "degradation.availableQuarters")).toBe(true);
    expect(plan.items.map((i) => i.disclosure).join("\n")).toContain("unknown number of quarters");
  });
});

// ---------------------------------------------------------------------------
// computeRunway
// ---------------------------------------------------------------------------

const goldenBalance: RunwayBalanceInput = {
  date: "2026-03-31",
  cashAndCashEquivalents: 300_000_000,
  shortTermInvestments: 200_000_000,
  cashAndShortTermInvestments: 500_000_000,
};

/** 4 quarters, each burning 50M (OCF −40M + capex −10M; FMP capex is negative). */
const goldenQuarters: RunwayCashflowQuarter[] = [
  { date: "2026-03-31", operatingCashFlow: -40_000_000, capitalExpenditure: -10_000_000 },
  { date: "2025-12-31", operatingCashFlow: -40_000_000, capitalExpenditure: -10_000_000 },
  { date: "2025-09-30", operatingCashFlow: -40_000_000, capitalExpenditure: -10_000_000 },
  { date: "2025-06-30", operatingCashFlow: -40_000_000, capitalExpenditure: -10_000_000 },
];

const goldenShares: ShareCountQuarter[] = [
  { date: "2026-03-31", weightedAverageShsOutDil: 120_000_000 },
  { date: "2025-03-31", weightedAverageShsOutDil: 110_000_000 },
  { date: "2024-03-31", weightedAverageShsOutDil: 100_000_000 },
];

describe("computeRunway", () => {
  it("golden case: 500M liquidity / 50M avg burn = 10.0 quarters, exhaustion 2028-09-29", () => {
    const r = computeRunway(goldenBalance, goldenQuarters, goldenShares);
    expect(r.burning).toBe(true);
    expect(r.avgQuarterlyBurn).toBe(50_000_000);
    expect(r.burnWindowQuarters).toBe(BURN_WINDOW_MAX_QUARTERS);
    expect(r.burnWindowDates[0]).toBe("2026-03-31");
    expect(r.liquidAssets).toBe(500_000_000);
    expect(r.liquidAssetsBasis).toBe("cashAndShortTermInvestments");
    expect(r.liquidAssetsAsOf).toBe("2026-03-31");
    expect(r.runwayQuarters).toBe(10);
    // 2026-03-31 + 10 × 91.3125 days = 913.125 days → 2028-09-29
    expect(r.estimatedExhaustionDate).toBe("2028-09-29");
  });

  it("golden dilution: 100M -> 120M over 2 years = +20% total, ~9.55%/yr", () => {
    const r = computeRunway(goldenBalance, goldenQuarters, goldenShares);
    expect(r.dilution).not.toBeNull();
    expect(r.dilution?.sharesLatest).toBe(120_000_000);
    expect(r.dilution?.sharesPrior).toBe(100_000_000);
    expect(r.dilution?.sharesPriorAsOf).toBe("2024-03-31");
    expect(r.dilution?.spanDays).toBe(730);
    expect(r.dilution?.totalGrowth).toBeCloseTo(0.2, 10);
    expect(r.dilution?.annualizedGrowth).toBeCloseTo(0.0955, 3);
  });

  it("uses only the most recent 4 quarters and averages the window", () => {
    const withOld = [
      ...goldenQuarters,
      { date: "2025-03-31", operatingCashFlow: -900_000_000, capitalExpenditure: 0 },
    ];
    const r = computeRunway(goldenBalance, withOld, []);
    expect(r.burnWindowQuarters).toBe(4);
    expect(r.avgQuarterlyBurn).toBe(50_000_000);
  });

  it("not burning: avg OCF+capex >= 0 -> null runway + self-funding note", () => {
    const r = computeRunway(
      goldenBalance,
      [{ date: "2026-03-31", operatingCashFlow: 50_000_000, capitalExpenditure: -10_000_000 }],
      [],
    );
    expect(r.burning).toBe(false);
    expect(r.avgQuarterlyBurn).toBeNull();
    expect(r.runwayQuarters).toBeNull();
    expect(r.estimatedExhaustionDate).toBeNull();
    expect(r.notes.some((n) => n.includes("self-funding"))).toBe(true);
  });

  it("suppresses combined liquidity and runway when short-term investments are missing", () => {
    const r = computeRunway(
      { date: "2026-03-31", cashAndCashEquivalents: 300_000_000, shortTermInvestments: null },
      goldenQuarters,
      [],
    );
    expect(r.liquidAssets).toBeNull();
    expect(r.liquidAssetsBasis).toBeNull();
    expect(r.liquidAssetsAsOf).toBeNull();
    expect(r.runwayQuarters).toBeNull();
    expect(r.gaps.filter((g) => g.field === "runway.liquidAssets")).toHaveLength(1);
  });

  it("uses a finite combined liquidity field even when separate components are absent", () => {
    const r = computeRunway(
      {
        date: "2026-03-31",
        cashAndCashEquivalents: null,
        shortTermInvestments: null,
        cashAndShortTermInvestments: 500_000_000,
      },
      goldenQuarters,
      [],
    );
    expect(r.liquidAssets).toBe(500_000_000);
    expect(r.liquidAssetsBasis).toBe("cashAndShortTermInvestments");
    expect(r.runwayQuarters).toBe(10);
    expect(r.gaps.some((g) => g.field === "runway.liquidAssets")).toBe(false);
  });

  it("falls back from an invalid combined field only when both components are finite", () => {
    const r = computeRunway(
      {
        date: "2026-03-31",
        cashAndCashEquivalents: 300_000_000,
        shortTermInvestments: 200_000_000,
        cashAndShortTermInvestments: Number.NaN,
      },
      goldenQuarters,
      [],
    );
    expect(r.liquidAssets).toBe(500_000_000);
    expect(r.liquidAssetsBasis).toBe("cash+shortTermInvestments");
    expect(r.runwayQuarters).toBe(10);
  });

  it("falls back from a negative combined field to non-negative finite components", () => {
    const r = computeRunway(
      {
        date: "2026-03-31",
        cashAndCashEquivalents: 300_000_000,
        shortTermInvestments: 200_000_000,
        cashAndShortTermInvestments: -1,
      },
      goldenQuarters,
      [],
    );
    expect(r.liquidAssets).toBe(500_000_000);
    expect(r.liquidAssetsBasis).toBe("cash+shortTermInvestments");
    expect(r.runwayQuarters).toBe(10);
  });

  it("suppresses liquidity when either separate component is negative", () => {
    const r = computeRunway(
      {
        date: "2026-03-31",
        cashAndCashEquivalents: 300_000_000,
        shortTermInvestments: -1,
      },
      goldenQuarters,
      [],
    );
    expect(r.liquidAssets).toBeNull();
    expect(r.runwayQuarters).toBeNull();
    expect(r.gaps.filter((g) => g.field === "runway.liquidAssets")).toHaveLength(1);
  });

  it("preserves literal zero as valid combined liquidity", () => {
    const r = computeRunway(
      {
        date: "2026-03-31",
        cashAndCashEquivalents: null,
        shortTermInvestments: null,
        cashAndShortTermInvestments: 0,
      },
      goldenQuarters,
      [],
    );
    expect(r.liquidAssets).toBe(0);
    expect(r.liquidAssetsBasis).toBe("cashAndShortTermInvestments");
    expect(r.runwayQuarters).toBe(0);
    expect(r.gaps.some((g) => g.field === "runway.liquidAssets")).toBe(false);
  });

  it("suppresses a non-finite component liquidity sum", () => {
    const r = computeRunway(
      {
        date: "2026-03-31",
        cashAndCashEquivalents: Number.MAX_VALUE,
        shortTermInvestments: Number.MAX_VALUE,
      },
      goldenQuarters,
      [],
    );
    expect(r.liquidAssets).toBeNull();
    expect(r.runwayQuarters).toBeNull();
    const liquidityGaps = r.gaps.filter((g) => g.field === "runway.liquidAssets");
    expect(liquidityGaps).toHaveLength(1);
    expect(liquidityGaps[0].reason).toContain("sum was non-finite");
    expect(liquidityGaps[0].reason).not.toContain("were not finite non-negative values");
  });

  it("missing liquidity entirely -> gap, no throw, burn still computed", () => {
    const r = computeRunway(
      { date: "2026-03-31", cashAndCashEquivalents: null, shortTermInvestments: null },
      goldenQuarters,
      [],
    );
    expect(r.liquidAssets).toBeNull();
    expect(r.gaps.some((g) => g.field === "runway.liquidAssets")).toBe(true);
    expect(r.burning).toBe(true);
    expect(r.avgQuarterlyBurn).toBe(50_000_000);
    expect(r.runwayQuarters).toBeNull();
  });

  it("retains a finite zero OCF plus zero capex row as self-funding", () => {
    const r = computeRunway(
      goldenBalance,
      [{ date: "2026-03-31", operatingCashFlow: 0, capitalExpenditure: 0 }],
      [],
    );
    expect(r.burnWindowQuarters).toBe(1);
    expect(r.burnWindowDates).toEqual(["2026-03-31"]);
    expect(r.burning).toBe(false);
    expect(r.avgQuarterlyBurn).toBeNull();
    expect(r.runwayQuarters).toBeNull();
    expect(r.notes.some((n) => n.includes("self-funding"))).toBe(true);
    expect(r.gaps.some((g) => g.field === "runway.operatingCashFlow")).toBe(false);
    expect(r.gaps.some((g) => g.field === "runway.capitalExpenditure")).toBe(false);
  });

  it("missing capex suppresses burn and emits one precise input gap", () => {
    const r = computeRunway(
      goldenBalance,
      [{ date: "2026-03-31", operatingCashFlow: -40_000_000, capitalExpenditure: null }],
      [],
    );
    expect(r.burning).toBeNull();
    expect(r.avgQuarterlyBurn).toBeNull();
    expect(r.runwayQuarters).toBeNull();
    expect(r.burnWindowQuarters).toBe(0);
    expect(r.gaps.filter((g) => g.field === "runway.capitalExpenditure")).toHaveLength(1);
    expect(r.gaps.some((g) => g.field === "runway.avgQuarterlyBurn")).toBe(false);
  });

  it("missing operating cash flow suppresses burn and emits one precise input gap", () => {
    const r = computeRunway(
      goldenBalance,
      [{ date: "2026-03-31", operatingCashFlow: null, capitalExpenditure: -10_000_000 }],
      [],
    );
    expect(r.burning).toBeNull();
    expect(r.avgQuarterlyBurn).toBeNull();
    expect(r.runwayQuarters).toBeNull();
    expect(r.burnWindowQuarters).toBe(0);
    expect(r.gaps.filter((g) => g.field === "runway.operatingCashFlow")).toHaveLength(1);
    expect(r.gaps.some((g) => g.field === "runway.avgQuarterlyBurn")).toBe(false);
  });

  it("deduplicates repeated missing cash-flow inputs across the burn window", () => {
    const r = computeRunway(
      goldenBalance,
      [
        { date: "2026-03-31", operatingCashFlow: -40_000_000, capitalExpenditure: null },
        { date: "2025-12-31", operatingCashFlow: -35_000_000, capitalExpenditure: null },
      ],
      [],
    );
    expect(r.gaps.filter((g) => g.field === "runway.capitalExpenditure")).toHaveLength(1);
  });

  it("computes 50M burn and 10-quarter runway from a complete FMP-sign pair", () => {
    const r = computeRunway(
      goldenBalance,
      [{ date: "2026-03-31", operatingCashFlow: -40_000_000, capitalExpenditure: -10_000_000 }],
      [],
    );
    expect(r.avgQuarterlyBurn).toBe(50_000_000);
    expect(r.runwayQuarters).toBe(10);
  });

  it("averages finite FCF rows without overflowing the accumulator", () => {
    const r = computeRunway(
      {
        date: "2026-03-31",
        cashAndCashEquivalents: null,
        shortTermInvestments: null,
        cashAndShortTermInvestments: 500_000_000,
      },
      [
        { date: "2026-03-31", operatingCashFlow: -Number.MAX_VALUE, capitalExpenditure: 0 },
        { date: "2025-12-31", operatingCashFlow: -Number.MAX_VALUE, capitalExpenditure: 0 },
      ],
      [],
    );
    expect(r.avgQuarterlyBurn).toBe(Number.MAX_VALUE);
    expect(Number.isFinite(r.avgQuarterlyBurn)).toBe(true);
    expect(Number.isFinite(r.runwayQuarters)).toBe(true);
    expect(r.notes.join(" ")).not.toMatch(/Infinity|NaN/);
  });

  it("averages multiple negative subnormal FCF rows without underflowing to zero", () => {
    const r = computeRunway(
      {
        date: "2026-03-31",
        cashAndCashEquivalents: null,
        shortTermInvestments: null,
        cashAndShortTermInvestments: 0,
      },
      [
        { date: "2026-03-31", operatingCashFlow: -Number.MIN_VALUE, capitalExpenditure: 0 },
        { date: "2025-12-31", operatingCashFlow: -Number.MIN_VALUE, capitalExpenditure: 0 },
      ],
      [],
    );
    expect(r.burning).toBe(true);
    expect(r.avgQuarterlyBurn).toBe(Number.MIN_VALUE);
    expect(r.runwayQuarters).toBe(0);
  });

  it("preserves a negative normalized mean when its burn magnitude underflows", () => {
    const r = computeRunway(
      {
        date: "2026-03-31",
        cashAndCashEquivalents: null,
        shortTermInvestments: null,
        cashAndShortTermInvestments: 500_000_000,
      },
      [
        { date: "2026-03-31", operatingCashFlow: -Number.MIN_VALUE, capitalExpenditure: 0 },
        { date: "2025-12-31", operatingCashFlow: -Number.MIN_VALUE, capitalExpenditure: 0 },
        { date: "2025-09-30", operatingCashFlow: Number.MIN_VALUE, capitalExpenditure: 0 },
      ],
      [],
    );
    expect(r.burning).toBe(true);
    expect(r.avgQuarterlyBurn).toBeNull();
    expect(r.runwayQuarters).toBeNull();
    expect(r.estimatedExhaustionDate).toBeNull();
    expect(r.gaps.filter((g) => g.field === "runway.avgQuarterlyBurn")).toHaveLength(1);
    expect(r.notes.some((n) => n.includes("self-funding"))).toBe(false);
  });

  it.each([
    {
      label: "positive, negative, vanished negative",
      values: [Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MIN_VALUE],
    },
    {
      label: "negative, vanished negative, positive",
      values: [-Number.MAX_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE],
    },
  ])("fails closed when mixed-scale normalization loses a nonzero FCF term: $label", ({ values }) => {
    const r = computeRunway(
      goldenBalance,
      values.map((operatingCashFlow, index) => ({
        date: ["2026-03-31", "2025-12-31", "2025-09-30"][index],
        operatingCashFlow,
        capitalExpenditure: 0,
      })),
      [],
    );
    expect(r.burning).toBeNull();
    expect(r.avgQuarterlyBurn).toBeNull();
    expect(r.runwayQuarters).toBeNull();
    expect(r.estimatedExhaustionDate).toBeNull();
    const precisionGaps = r.gaps.filter((g) => g.field === "runway.avgQuarterlyBurn");
    expect(precisionGaps).toHaveLength(1);
    expect(precisionGaps[0].reason).toContain("precision loss");
    expect(r.notes.some((n) => n.includes("self-funding"))).toBe(false);
  });

  it.each([
    {
      label: "residual survives summation but vanishes in the mean",
      values: [Number.MAX_VALUE, -Number.MAX_VALUE, -1e-15],
    },
    {
      label: "residual would be erased by naive summation order",
      values: [Number.MAX_VALUE, -1e-15, -Number.MAX_VALUE],
    },
    {
      label: "positive residual vanishes in the mean",
      values: [Number.MAX_VALUE, -Number.MAX_VALUE, 1e-15],
    },
  ])("fails closed when a normalized residual loses precision: $label", ({ values }) => {
    const r = computeRunway(
      goldenBalance,
      values.map((operatingCashFlow, index) => ({
        date: ["2026-03-31", "2025-12-31", "2025-09-30"][index],
        operatingCashFlow,
        capitalExpenditure: 0,
      })),
      [],
    );
    expect(r.burning).toBeNull();
    expect(r.avgQuarterlyBurn).toBeNull();
    expect(r.runwayQuarters).toBeNull();
    expect(r.estimatedExhaustionDate).toBeNull();
    const precisionGaps = r.gaps.filter((g) => g.field === "runway.avgQuarterlyBurn");
    expect(precisionGaps).toHaveLength(1);
    expect(precisionGaps[0].reason).toContain("precision loss");
    expect(r.notes.some((n) => n.includes("self-funding"))).toBe(false);
  });

  it("keeps an exact nonzero cancellation self-funding when normalization loses no term", () => {
    const r = computeRunway(
      goldenBalance,
      [
        { date: "2026-03-31", operatingCashFlow: Number.MAX_VALUE, capitalExpenditure: 0 },
        { date: "2025-12-31", operatingCashFlow: -Number.MAX_VALUE, capitalExpenditure: 0 },
      ],
      [],
    );
    expect(r.burning).toBe(false);
    expect(r.avgQuarterlyBurn).toBeNull();
    expect(r.runwayQuarters).toBeNull();
    expect(r.gaps.some((g) => g.field === "runway.avgQuarterlyBurn")).toBe(false);
    expect(r.notes.some((n) => n.includes("self-funding"))).toBe(true);
  });

  it("suppresses a non-finite runway result with one precise gap", () => {
    const r = computeRunway(
      {
        date: "2026-03-31",
        cashAndCashEquivalents: null,
        shortTermInvestments: null,
        cashAndShortTermInvestments: Number.MAX_VALUE,
      },
      [{ date: "2026-03-31", operatingCashFlow: -Number.MIN_VALUE, capitalExpenditure: 0 }],
      [],
    );
    expect(r.burning).toBe(true);
    expect(r.avgQuarterlyBurn).toBe(Number.MIN_VALUE);
    expect(r.runwayQuarters).toBeNull();
    expect(r.estimatedExhaustionDate).toBeNull();
    expect(r.gaps.filter((g) => g.field === "runway.runwayQuarters")).toHaveLength(1);
  });

  it("omits an exhaustion date when a finite runway exceeds the supported Date range", () => {
    const r = computeRunway(
      {
        date: "2026-03-31",
        cashAndCashEquivalents: null,
        shortTermInvestments: null,
        cashAndShortTermInvestments: 1e308,
      },
      [{ date: "2026-03-31", operatingCashFlow: -1e300, capitalExpenditure: 0 }],
      [],
    );
    expect(r.runwayQuarters).toBe(100_000_000);
    expect(r.estimatedExhaustionDate).toBeNull();
    expect(r.notes.some((n) => n.includes("supported date range"))).toBe(true);
  });

  it("uses the generic burn gap only when no quarterly cash-flow history exists", () => {
    const r = computeRunway(goldenBalance, [], []);
    expect(r.burning).toBeNull();
    expect(r.burnWindowQuarters).toBe(0);
    expect(r.gaps.filter((g) => g.field === "runway.avgQuarterlyBurn")).toHaveLength(1);
  });

  it("drops an impossible calendar date from the cash-flow burn window", () => {
    const r = computeRunway(
      goldenBalance,
      [
        { date: "2026-02-31", operatingCashFlow: -900_000_000, capitalExpenditure: 0 },
        { date: "2026-03-31", operatingCashFlow: -40_000_000, capitalExpenditure: -10_000_000 },
      ],
      [],
    );
    expect(r.burnWindowQuarters).toBe(1);
    expect(r.burnWindowDates).toEqual(["2026-03-31"]);
    expect(r.avgQuarterlyBurn).toBe(50_000_000);
  });

  it("does not estimate exhaustion from an impossible balance-sheet date", () => {
    const r = computeRunway(
      { ...goldenBalance, date: "2026-02-31" },
      [{ date: "2026-03-31", operatingCashFlow: -40_000_000, capitalExpenditure: -10_000_000 }],
      [],
    );
    expect(r.runwayQuarters).toBe(10);
    expect(r.liquidAssetsAsOf).toBeNull();
    expect(r.estimatedExhaustionDate).toBeNull();
    expect(r.notes.filter((n) => n.includes('balance date "2026-02-31" unparseable'))).toHaveLength(1);
  });

  it.each(["2024-02-29", "2026-03-31T15:00:00Z"])(
    "retains valid balance date provenance for %s",
    (date) => {
      const r = computeRunway(
        { ...goldenBalance, date },
        [{ date: "2026-03-31", operatingCashFlow: -40_000_000, capitalExpenditure: -10_000_000 }],
        [],
      );
      expect(r.liquidAssetsAsOf).toBe(date);
      expect(r.estimatedExhaustionDate).not.toBeNull();
      expect(r.notes.some((n) => n.includes("balance date") && n.includes("unparseable"))).toBe(false);
    },
  );

  it("dilution gap paths: empty history and single point", () => {
    const none = computeRunway(goldenBalance, goldenQuarters, []);
    expect(none.dilution).toBeNull();
    expect(none.gaps.some((g) => g.field === "runway.dilution")).toBe(true);
    const single = computeRunway(goldenBalance, goldenQuarters, [goldenShares[0]]);
    expect(single.dilution).toBeNull();
    expect(single.gaps.some((g) => g.field === "runway.dilution")).toBe(true);
  });

  it("quarter length constant is 365.25/4 (annotated house rule)", () => {
    expect(DAYS_PER_QUARTER).toBeCloseTo(91.3125, 10);
    const r = computeRunway(goldenBalance, goldenQuarters, []);
    expect(r.notes.some((n) => n.includes("house rule"))).toBe(true);
  });
});
