/**
 * Stage B forensics — pure, no network. Anchor values come from
 * the forensic methodology (primary-source-verified coefficients).
 */

import { describe, expect, it } from "vitest";

import {
  ALTMAN_COEFFICIENTS,
  ALTMAN_ZONES,
  BENEISH_COEFFICIENTS,
  classifyAccrualBand,
  classifyAltmanZone,
  classifyBeneishVerdict,
  computeAccruals,
  computeAltman,
  computeBeneish,
  computePiotroski,
  computeSupportFlags,
  alignForensicPeriods,
  isFinancialForensicsSuppressed,
  runForensics,
  selectAltmanVariant,
  type AltmanInputs,
  type ForensicsPeriod,
} from "@/pipeline/stageB/forensics";
import type { CompanyRoute } from "@/types/core";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const generalRoute: CompanyRoute = {
  base: "general",
  overlays: [],
  evidence: { sector: "Technology", industry: "Consumer Electronics" },
};

const bankRoute: CompanyRoute = {
  base: "bank",
  overlays: [],
  evidence: { sector: "Financial Services", industry: "Banks - Diversified" },
};

/**
 * AAPL cross-check scenario — the exact inputs FMP's financial-scores endpoint
 * returned in the research capture (units: billions), research §1.6.
 * FMP reported altmanZScore = 10.6497 for these inputs.
 */
const aaplAltmanInputs: AltmanInputs = {
  balance: {
    date: "2025-09-27",
    // workingCapital = -4.263 (research capture): CA - CL chosen to reproduce it
    totalCurrentAssets: 100,
    totalCurrentLiabilities: 104.263,
    totalAssets: 379.297,
    retainedEarnings: -2.177,
    totalLiabilities: 291.107,
    totalStockholdersEquity: 88.19, // totalAssets - totalLiabilities
  },
  income: { date: "2025-09-27", ebit: 141.597, revenue: 435.617 },
  marketCap: 4022.5,
  marketCapAsOf: "2026-02-16",
};

// ---------------------------------------------------------------------------
// Altman — coefficients, AAPL divergence, zones, edge cases
// ---------------------------------------------------------------------------

describe("computeAltman — verified coefficients", () => {
  it("reproduces the original-1968 model on FMP's own AAPL inputs (research §1.6)", () => {
    const r = computeAltman(aaplAltmanInputs, "original");
    expect(r.score).not.toBeNull();
    // Our original variant uses the exact 1968 X5 coefficient 0.999.
    expect(r.score!).toBeCloseTo(10.6485, 3);
    // FMP applies original Z with X5 coefficient 1.0 to EVERY company.
    // Adding back the 0.001 * X5 difference must reproduce FMP's 10.6497.
    const fmpEquivalent = r.score! + (1.0 - 0.999) * r.components.x5!;
    expect(fmpEquivalent).toBeCloseTo(10.6497, 3);
    expect(r.zone).toBe("safe");
  });

  it("z2 variant on the same AAPL inputs diverges hugely from FMP (variant-aware by design)", () => {
    // AAPL routed by FMP sector "Technology" (no SIC) is a non-manufacturer -> Z''.
    // Z'' drops X5 and uses BOOK equity in X4, so it legitimately differs from
    // FMP's one-size-fits-all original-1968 score of 10.6497.
    const r = computeAltman(aaplAltmanInputs, "z2");
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeCloseTo(2.7343, 3);
    expect(r.zone).toBe("safe"); // > 2.60
    expect(r.components.x5).toBeNull(); // X5 dropped
    expect(r.score!).toBeLessThan(5);
    expect(10.6497).toBeGreaterThan(10); // documents the magnitude of divergence
  });

  it("z2-em adds exactly the +3.25 constant to z2", () => {
    const z2 = computeAltman(aaplAltmanInputs, "z2");
    const em = computeAltman(aaplAltmanInputs, "z2-em");
    expect(em.score! - z2.score!).toBeCloseTo(3.25, 10);
    expect(em.thresholds).toEqual({ distressBelow: 4.35, safeAbove: 5.85 });
  });

  it("private variant uses the re-estimated coefficients", () => {
    // Simple round numbers: TA 100, WC 10, RE 20, EBIT 15, BVE 40, TL 60, Sales 90.
    const r = computeAltman(
      {
        balance: {
          date: "2025-12-31",
          totalCurrentAssets: 30,
          totalCurrentLiabilities: 20,
          totalAssets: 100,
          retainedEarnings: 20,
          totalLiabilities: 60,
          totalStockholdersEquity: 40,
        },
        income: { date: "2025-12-31", ebit: 15, revenue: 90 },
      },
      "private",
    );
    const expected =
      0.717 * 0.1 + 0.847 * 0.2 + 3.107 * 0.15 + 0.42 * (40 / 60) + 0.998 * 0.9;
    expect(r.score!).toBeCloseTo(expected, 10);
  });

  it("coefficient table matches the research anchors exactly", () => {
    expect(ALTMAN_COEFFICIENTS.original).toEqual({
      x1: 1.2, x2: 1.4, x3: 3.3, x4: 0.6, x5: 0.999, constant: 0,
    });
    expect(ALTMAN_COEFFICIENTS.private).toEqual({
      x1: 0.717, x2: 0.847, x3: 3.107, x4: 0.42, x5: 0.998, constant: 0,
    });
    expect(ALTMAN_COEFFICIENTS.z2).toEqual({
      x1: 6.56, x2: 3.26, x3: 6.72, x4: 1.05, x5: 0, constant: 0,
    });
    expect(ALTMAN_COEFFICIENTS["z2-em"]).toEqual({
      x1: 6.56, x2: 3.26, x3: 6.72, x4: 1.05, x5: 0, constant: 3.25,
    });
  });

  it("missing current assets/liabilities -> null score + 'unclassified balance sheet' gap", () => {
    const r = computeAltman(
      {
        balance: { date: "2025-12-31", totalAssets: 100, totalLiabilities: 60, retainedEarnings: 5, totalStockholdersEquity: 40 },
        income: { date: "2025-12-31", ebit: 10, revenue: 50 },
        marketCap: 200,
      },
      "original",
    );
    expect(r.score).toBeNull();
    expect(r.zone).toBeNull();
    expect(r.gaps.some((g) => g.reason.includes("unclassified balance sheet"))).toBe(true);
  });

  it("null retainedEarnings -> treated as 0 with an explicit caveat, score still computed", () => {
    const r = computeAltman(
      {
        balance: {
          date: "2025-12-31",
          totalCurrentAssets: 30,
          totalCurrentLiabilities: 20,
          totalAssets: 100,
          retainedEarnings: null,
          totalLiabilities: 60,
        },
        income: { date: "2025-12-31", ebit: 15, revenue: 90 },
        marketCap: 120,
      },
      "original",
    );
    expect(r.score).not.toBeNull();
    expect(r.components.x2).toBe(0);
    expect(r.notes.some((n) => n.includes("treated as 0"))).toBe(true);
    expect(r.gaps.some((g) => g.field === "forensics.altman.retainedEarnings")).toBe(true);
  });

  it("marketCap missing for the original variant -> null score + gap (no silent degrade)", () => {
    const inputs: AltmanInputs = { ...aaplAltmanInputs, marketCap: null };
    const r = computeAltman(inputs, "original");
    expect(r.score).toBeNull();
    expect(r.gaps.some((g) => g.field === "forensics.altman.marketCap")).toBe(true);
  });

  it("ADR currency mismatch (quote != statements) -> original X4/Z suppressed with FX gap", () => {
    // Market cap in USD but books in TWD (e.g. TSM): market-equity X4 would be off
    // by the FX rate, so the original variant suppresses X4/Z rather than emit a
    // wrong bankruptcy verdict.
    const inputs: AltmanInputs = { ...aaplAltmanInputs, reportedCurrency: "TWD", quoteCurrency: "USD" };
    const r = computeAltman(inputs, "original");
    expect(r.score).toBeNull();
    expect(r.components.x4).toBeNull();
    expect(r.gaps.some((g) => g.field === "forensics.altman.currency")).toBe(true);
    expect(r.notes.some((n) => /currency mismatch/i.test(n))).toBe(true);
  });

  it("matching currencies (quote == statements) compute the original X4 normally", () => {
    const inputs: AltmanInputs = { ...aaplAltmanInputs, reportedCurrency: "USD", quoteCurrency: "USD" };
    const r = computeAltman(inputs, "original");
    expect(r.score).not.toBeNull();
    expect(r.components.x4).not.toBeNull();
    expect(r.gaps.some((g) => g.field === "forensics.altman.currency")).toBe(false);
  });

  it("total liabilities <= 0 saturates X4 at the +20 house cap with a note", () => {
    const r = computeAltman(
      {
        balance: {
          date: "2025-12-31",
          totalCurrentAssets: 50,
          totalCurrentLiabilities: 0,
          totalAssets: 100,
          retainedEarnings: 10,
          totalLiabilities: 0,
          totalStockholdersEquity: 100,
        },
        income: { date: "2025-12-31", ebit: 10, revenue: 80 },
      },
      "z2",
    );
    expect(r.components.x4).toBe(20);
    expect(r.notes.some((n) => n.includes("House rule") && n.includes("saturated"))).toBe(true);
  });

  it("negative book equity computes X4 as-is and emits a RED note", () => {
    const r = computeAltman(
      {
        balance: {
          date: "2025-12-31",
          totalCurrentAssets: 20,
          totalCurrentLiabilities: 40,
          totalAssets: 100,
          retainedEarnings: -80,
          totalLiabilities: 130,
          totalStockholdersEquity: -30,
        },
        income: { date: "2025-12-31", ebit: -5, revenue: 60 },
      },
      "z2",
    );
    expect(r.components.x4).toBeCloseTo(-30 / 130, 10);
    expect(r.notes.some((n) => n.includes("negative book equity"))).toBe(true);
  });
});

describe("classifyAltmanZone — thresholds straddled per variant", () => {
  it("original 1.80 / 2.99", () => {
    expect(classifyAltmanZone(1.7999, "original")).toBe("distress");
    expect(classifyAltmanZone(1.8, "original")).toBe("grey"); // boundary -> grey
    expect(classifyAltmanZone(2.99, "original")).toBe("grey");
    expect(classifyAltmanZone(2.9901, "original")).toBe("safe");
  });
  it("private 1.23 / 2.90", () => {
    expect(classifyAltmanZone(1.2299, "private")).toBe("distress");
    expect(classifyAltmanZone(1.2301, "private")).toBe("grey");
    expect(classifyAltmanZone(2.8999, "private")).toBe("grey");
    expect(classifyAltmanZone(2.9001, "private")).toBe("safe");
  });
  it("z2 1.10 / 2.60", () => {
    expect(classifyAltmanZone(1.0999, "z2")).toBe("distress");
    expect(classifyAltmanZone(1.1001, "z2")).toBe("grey");
    expect(classifyAltmanZone(2.5999, "z2")).toBe("grey");
    expect(classifyAltmanZone(2.6001, "z2")).toBe("safe");
  });
  it("z2-em 4.35 / 5.85", () => {
    expect(classifyAltmanZone(4.3499, "z2-em")).toBe("distress");
    expect(classifyAltmanZone(4.3501, "z2-em")).toBe("grey");
    expect(classifyAltmanZone(5.8499, "z2-em")).toBe("grey");
    expect(classifyAltmanZone(5.8501, "z2-em")).toBe("safe");
  });
  it("zone table matches research anchors", () => {
    expect(ALTMAN_ZONES).toEqual({
      original: { distressBelow: 1.8, safeAbove: 2.99 },
      private: { distressBelow: 1.23, safeAbove: 2.9 },
      z2: { distressBelow: 1.1, safeAbove: 2.6 },
      "z2-em": { distressBelow: 4.35, safeAbove: 5.85 },
    });
  });
});

describe("selectAltmanVariant", () => {
  it("AAPL by FMP sector (no SIC): Technology -> non-manufacturer -> z2", () => {
    const sel = selectAltmanVariant(generalRoute, {
      sector: "Technology",
      industry: "Consumer Electronics",
    });
    expect(sel.variant).toBe("z2");
    expect(sel.notes.some((n) => n.includes("House heuristic"))).toBe(true);
  });

  it("SIC 2000-3999 is decisive: manufacturer -> original (AAPL's SIC 3571 would route here)", () => {
    const sel = selectAltmanVariant(generalRoute, { sicCode: "3571" });
    expect(sel.variant).toBe("original");
  });

  it("SIC outside 2000-3999 -> z2", () => {
    const sel = selectAltmanVariant(generalRoute, { sicCode: "7372" }); // prepackaged software
    expect(sel.variant).toBe("z2");
  });

  it("emerging market -> z2-em regardless of manufacturer status", () => {
    const sel = selectAltmanVariant(generalRoute, { sicCode: "3571" }, true);
    expect(sel.variant).toBe("z2-em");
  });

  it("financials -> null with an explanatory note (bank route, FS sector, SIC 6022)", () => {
    expect(selectAltmanVariant(bankRoute).variant).toBeNull();
    expect(selectAltmanVariant(bankRoute).notes.length).toBeGreaterThan(0);
    const bySector = selectAltmanVariant(generalRoute, { sector: "Financial Services" });
    expect(bySector.variant).toBeNull();
    const bySic = selectAltmanVariant(generalRoute, { sicCode: "6022" });
    expect(bySic.variant).toBeNull();
    expect(bySic.notes.some((n) => n.includes("6000"))).toBe(true);
  });

  it("mortgage REITs suppressed; equity REITs computed with a caution note", () => {
    const mreit: CompanyRoute = {
      base: "reit-mortgage",
      overlays: [],
      evidence: { sector: "Real Estate", industry: "REIT - Mortgage" },
    };
    expect(selectAltmanVariant(mreit).variant).toBeNull();
    const reit: CompanyRoute = {
      base: "reit",
      overlays: [],
      evidence: { sector: "Real Estate", industry: "REIT - Industrial" },
    };
    const sel = selectAltmanVariant(reit);
    expect(sel.variant).toBe("z2");
    expect(sel.notes.some((n) => n.toLowerCase().includes("caution"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Beneish M — coefficient exactness, neutralization, clamping, verdicts
// ---------------------------------------------------------------------------

/** Two identical years, NI = CFO -> every index 1.0, TATA 0 -> M = -2.480. */
function beneishSteadyStatePeriods(): { current: ForensicsPeriod; prior: ForensicsPeriod } {
  const income = {
    revenue: 1000,
    costOfRevenue: 600,
    sellingGeneralAndAdministrativeExpenses: 200,
    netIncomeFromContinuingOperations: 80,
    netIncome: 80,
  };
  const balance = {
    totalAssets: 1000,
    totalCurrentAssets: 400,
    accountsReceivables: 100,
    propertyPlantEquipmentNet: 300,
    totalCurrentLiabilities: 200,
    longTermDebt: 100,
  };
  const cashFlow = { netCashProvidedByOperatingActivities: 80, depreciationAndAmortization: 50 };
  return {
    current: {
      income: { date: "2025-12-31", ...income },
      balance: { date: "2025-12-31", ...balance },
      cashFlow: { date: "2025-12-31", ...cashFlow },
    },
    prior: {
      income: { date: "2024-12-31", ...income },
      balance: { date: "2024-12-31", ...balance },
      cashFlow: { date: "2024-12-31", ...cashFlow },
    },
  };
}

/**
 * Hand-constructed "manipulator-ish" fixture with analytically known indices:
 * DSRI = (200/1300)/(100/1000)            = 1.538461538...
 * GMI  = 0.40 / 0.37                       = 1.081081081...
 * AQI  = (1 - 830/1200) / (1 - 700/1000)   = 1.027777778...
 * SGI  = 1300/1000                         = 1.3
 * DEPI = (50/350) / (45/375)               = 1.190476190...
 * SGAI = (240/1300)/(200/1000)             = 0.923076923...
 * TATA = (120 - 60)/1200                   = 0.05
 * LVGI = (400/1200)/(300/1000)             = 1.111111111...
 * M    = -1.4302301538 (hand-summed against Table 3 coefficients)
 */
function beneishManipulatorPeriods(): { current: ForensicsPeriod; prior: ForensicsPeriod } {
  return {
    current: {
      income: {
        date: "2025-12-31",
        revenue: 1300,
        costOfRevenue: 819, // GM_t = 0.37 exactly
        sellingGeneralAndAdministrativeExpenses: 240,
        netIncomeFromContinuingOperations: 120,
      },
      balance: {
        date: "2025-12-31",
        totalAssets: 1200,
        totalCurrentAssets: 500,
        accountsReceivables: 200,
        propertyPlantEquipmentNet: 330,
        totalCurrentLiabilities: 250,
        longTermDebt: 150,
      },
      cashFlow: {
        date: "2025-12-31",
        netCashProvidedByOperatingActivities: 60,
        depreciationAndAmortization: 45,
      },
    },
    prior: {
      income: {
        date: "2024-12-31",
        revenue: 1000,
        costOfRevenue: 600, // GM_p = 0.40
        sellingGeneralAndAdministrativeExpenses: 200,
        netIncomeFromContinuingOperations: 80,
      },
      balance: {
        date: "2024-12-31",
        totalAssets: 1000,
        totalCurrentAssets: 400,
        accountsReceivables: 100,
        propertyPlantEquipmentNet: 300,
        totalCurrentLiabilities: 200,
        longTermDebt: 100,
      },
      cashFlow: {
        date: "2024-12-31",
        netCashProvidedByOperatingActivities: 100,
        depreciationAndAmortization: 50,
      },
    },
  };
}

describe("computeBeneish — coefficient exactness", () => {
  it("TATA coefficient is 4.679 (NOT the 4.697 transcription error)", () => {
    expect(BENEISH_COEFFICIENTS.tata).toBe(4.679);
    expect(BENEISH_COEFFICIENTS).toEqual({
      intercept: -4.84, dsri: 0.92, gmi: 0.528, aqi: 0.404, sgi: 0.892,
      depi: 0.115, sgai: -0.172, tata: 4.679, lvgi: -0.327,
    });
  });

  it("steady state (all indices 1, TATA 0) -> M = -2.480 exactly", () => {
    const { current, prior } = beneishSteadyStatePeriods();
    const r = computeBeneish(current, prior);
    expect(r.indices.dsri).toBeCloseTo(1, 12);
    expect(r.indices.gmi).toBeCloseTo(1, 12);
    expect(r.indices.aqi).toBeCloseTo(1, 12);
    expect(r.indices.sgi).toBeCloseTo(1, 12);
    expect(r.indices.depi).toBeCloseTo(1, 12);
    expect(r.indices.sgai).toBeCloseTo(1, 12);
    expect(r.indices.lvgi).toBeCloseTo(1, 12);
    expect(r.indices.tata).toBeCloseTo(0, 12);
    expect(r.neutralized).toEqual([]);
    expect(r.score!).toBeCloseTo(-2.48, 9);
    expect(r.verdict).toBe("unlikely");
  });

  it("manipulator fixture: every index and M to 1e-6 against hand-computed anchors", () => {
    const { current, prior } = beneishManipulatorPeriods();
    const r = computeBeneish(current, prior);
    expect(r.indices.dsri!).toBeCloseTo(1.5384615385, 6);
    expect(r.indices.gmi!).toBeCloseTo(1.0810810811, 6);
    expect(r.indices.aqi!).toBeCloseTo(1.0277777778, 6);
    expect(r.indices.sgi!).toBeCloseTo(1.3, 12);
    expect(r.indices.depi!).toBeCloseTo(1.1904761905, 6);
    expect(r.indices.sgai!).toBeCloseTo(0.9230769231, 6);
    expect(r.indices.tata!).toBeCloseTo(0.05, 12);
    expect(r.indices.lvgi!).toBeCloseTo(1.1111111111, 6);
    expect(r.neutralized).toEqual([]);
    expect(r.clamped).toEqual([]);
    expect(r.score!).toBeCloseTo(-1.4302301538, 6);
    expect(r.verdict).toBe("flag");
  });
});

describe("classifyBeneishVerdict — three-band thresholds straddled", () => {
  it("bands: < -2.22 unlikely / [-2.22, -1.78] grey / > -1.78 flag", () => {
    expect(classifyBeneishVerdict(-2.2201)).toBe("unlikely");
    expect(classifyBeneishVerdict(-2.22)).toBe("grey");
    expect(classifyBeneishVerdict(-2.0)).toBe("grey");
    expect(classifyBeneishVerdict(-1.78)).toBe("grey");
    expect(classifyBeneishVerdict(-1.7799)).toBe("flag");
  });
});

describe("computeBeneish — neutral-1.0 fallback and clamping", () => {
  it("missing SG&A in both years -> SGAI neutralized to 1.0 with a note; M still computed", () => {
    const { current, prior } = beneishManipulatorPeriods();
    delete current.income!.sellingGeneralAndAdministrativeExpenses;
    delete prior.income!.sellingGeneralAndAdministrativeExpenses;
    const r = computeBeneish(current, prior);
    expect(r.indices.sgai).toBe(1);
    expect(r.neutralized).toContain("SGAI");
    expect(r.notes.some((n) => n.includes("SGAI") && n.includes("neutral 1.0"))).toBe(true);
    expect(r.score).not.toBeNull();
    // M changes by exactly the SGAI-term difference (coefficient -0.172).
    const base = computeBeneish(
      beneishManipulatorPeriods().current,
      beneishManipulatorPeriods().prior,
    );
    expect(r.score! - base.score!).toBeCloseTo(-0.172 * (1 - 0.9230769231), 6);
  });

  it("SG&A of exactly 0 is treated as FMP zero-for-undisclosed -> neutralized", () => {
    const { current, prior } = beneishManipulatorPeriods();
    current.income!.sellingGeneralAndAdministrativeExpenses = 0;
    prior.income!.sellingGeneralAndAdministrativeExpenses = 0;
    const r = computeBeneish(current, prior);
    expect(r.indices.sgai).toBe(1);
    expect(r.neutralized).toContain("SGAI");
  });

  it("missing D&A -> DEPI neutralized (paper's own convention for missing COMPUSTAT #65)", () => {
    const { current, prior } = beneishManipulatorPeriods();
    delete current.cashFlow!.depreciationAndAmortization;
    const r = computeBeneish(current, prior);
    expect(r.indices.depi).toBe(1);
    expect(r.neutralized).toContain("DEPI");
  });

  it("extreme DSRI is clamped to 10 with a house-rule note", () => {
    const { current, prior } = beneishManipulatorPeriods();
    current.balance!.accountsReceivables = 100000; // AR/Sales ratio explodes
    const r = computeBeneish(current, prior);
    expect(r.indices.dsri).toBe(10);
    expect(r.clamped).toContain("DSRI");
    expect(r.notes.some((n) => n.includes("House rule") && n.includes("DSRI"))).toBe(true);
  });

  it("negative gross margin -> GMI neutralized + standalone RED note", () => {
    const { current, prior } = beneishManipulatorPeriods();
    current.income!.costOfRevenue = 1400; // > revenue 1300
    const r = computeBeneish(current, prior);
    expect(r.indices.gmi).toBe(1);
    expect(r.neutralized).toContain("GMI");
    expect(r.notes.some((n) => n.includes("negative gross margin"))).toBe(true);
  });

  it("TATA not computable (no cash-flow statement) -> M unavailable with critical gap", () => {
    const { current, prior } = beneishManipulatorPeriods();
    current.cashFlow = null;
    const r = computeBeneish(current, prior);
    expect(r.score).toBeNull();
    expect(r.verdict).toBeNull();
    expect(r.indices.tata).toBeNull();
    expect(r.gaps.some((g) => g.field === "forensics.beneish.tata" && g.severity === "critical")).toBe(true);
    // Other indices still reported for diagnostics.
    expect(r.indices.dsri!).toBeCloseTo(1.5384615385, 6);
  });

  it("pre-revenue / missing revenue -> M unavailable with explanatory gap", () => {
    const { current, prior } = beneishManipulatorPeriods();
    prior.income!.revenue = 0;
    const r = computeBeneish(current, prior);
    expect(r.score).toBeNull();
    expect(r.gaps.some((g) => g.reason.includes("pre-revenue"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Piotroski F — paper denominators, /7 degradation, de-minimis
// ---------------------------------------------------------------------------

/**
 * 3-year fixture engineered so all nine signals pass AND so that using the
 * WRONG denominators would flip signals:
 * - ΔLEVER with average TA: 33/110 = 0.300 < 33/102.5 = 0.322 -> 1 (pass).
 *   With BEGINNING TA it would be 33/100 = 0.330 vs 33/105 = 0.314 -> rise -> 0.
 * - ΔTURN with beginning TA: 110/100 = 1.100 > 100/105 = 0.952 -> 1 (pass).
 *   With END-of-year TA it would be 110/120 = 0.917 < 100/100 = 1.0 -> 0.
 */
function piotroskiPeriods(): {
  current: ForensicsPeriod;
  prior: ForensicsPeriod;
  prior2: ForensicsPeriod;
} {
  return {
    current: {
      income: {
        date: "2025-12-31",
        revenue: 110,
        grossProfit: 45,
        netIncomeFromContinuingOperations: 7,
      },
      balance: {
        date: "2025-12-31",
        totalAssets: 120,
        longTermDebt: 33,
        totalCurrentAssets: 66,
        totalCurrentLiabilities: 30,
      },
      cashFlow: {
        date: "2025-12-31",
        netCashProvidedByOperatingActivities: 9,
        commonStockIssuance: 0,
      },
    },
    prior: {
      income: {
        date: "2024-12-31",
        revenue: 100,
        grossProfit: 40,
        netIncomeFromContinuingOperations: 5,
      },
      balance: {
        date: "2024-12-31",
        totalAssets: 100,
        longTermDebt: 33,
        totalCurrentAssets: 60,
        totalCurrentLiabilities: 30,
      },
      cashFlow: {
        date: "2024-12-31",
        netCashProvidedByOperatingActivities: 8,
        commonStockIssuance: 0,
      },
    },
    prior2: { balance: { date: "2023-12-31", totalAssets: 105 } },
  };
}

describe("computePiotroski — verified denominators", () => {
  it("scores 9/9 on the engineered fixture", () => {
    const { current, prior, prior2 } = piotroskiPeriods();
    const r = computePiotroski(current, prior, prior2);
    expect(r.outOf).toBe(9);
    expect(r.score).toBe(9);
    for (const s of Object.values(r.signals)) expect(s.value).toBe(1);
  });

  it("ΔLEVER uses AVERAGE total assets (beginning-of-year TA would flip it to 0)", () => {
    const { current, prior, prior2 } = piotroskiPeriods();
    const r = computePiotroski(current, prior, prior2);
    // avg denominators: 33/110 = 0.300 < 33/102.5 = 0.322 -> leverage fell -> 1.
    // beginning-of-year TA: 33/100 = 0.330 vs 33/105 = 0.314 -> rose -> 0.
    expect(r.signals.leverageDown.value).toBe(1);
    expect(r.signals.leverageDown.detail).toContain("average-TA");
  });

  it("ΔTURN uses BEGINNING-of-year total assets (end-of-year TA would flip it to 0)", () => {
    const { current, prior, prior2 } = piotroskiPeriods();
    const r = computePiotroski(current, prior, prior2);
    // beginning TA: 110/100 = 1.100 > 100/105 = 0.952 -> 1.
    // end-of-year TA: 110/120 = 0.917 < 100/100 = 1.000 -> 0.
    expect(r.signals.turnoverUp.value).toBe(1);
    expect(r.signals.turnoverUp.detail).toContain("beginning-of-year");
  });

  it("ROA/CFO use beginning-of-year TA (prior period's totalAssets)", () => {
    const { current, prior, prior2 } = piotroskiPeriods();
    const r = computePiotroski(current, prior, prior2);
    // ROA = 7/100 = 7.00% (not 7/120 = 5.83%).
    expect(r.signals.roaPositive.detail).toContain("7.00%");
    // CFO/TA_begin = 9/100 = 9.00%.
    expect(r.signals.cfoPositive.detail).toContain("9.00%");
  });

  it("only 2 years -> ΔROA and Δturnover omitted, score out of 7 with a note", () => {
    const { current, prior } = piotroskiPeriods();
    const r = computePiotroski(current, prior, null);
    expect(r.outOf).toBe(7);
    expect(r.score).toBe(7);
    expect(r.signals.roaImproved.value).toBeNull();
    expect(r.signals.turnoverUp.value).toBeNull();
    expect(r.notes.some((n) => n.includes("out of 7"))).toBe(true);
    expect(r.gaps.some((g) => g.field === "forensics.piotroski")).toBe(true);
  });

  it("equity issuance: strict de-minimis 0 by default, threshold param annotated as house rule", () => {
    const { current, prior, prior2 } = piotroskiPeriods();
    current.cashFlow!.commonStockIssuance = 50;
    const strict = computePiotroski(current, prior, prior2);
    expect(strict.signals.noEquityIssuance.value).toBe(0);
    expect(strict.score).toBe(8);
    const lenient = computePiotroski(current, prior, prior2, { equityIssuanceDeMinimis: 100 });
    expect(lenient.signals.noEquityIssuance.value).toBe(1);
    expect(lenient.notes.some((n) => n.includes("de-minimis") && n.includes("House rule"))).toBe(true);
  });

  it("missing commonStockIssuance -> treated as no issuance with note + info gap", () => {
    const { current, prior, prior2 } = piotroskiPeriods();
    delete current.cashFlow!.commonStockIssuance;
    const r = computePiotroski(current, prior, prior2);
    expect(r.signals.noEquityIssuance.value).toBe(1);
    expect(r.gaps.some((g) => g.field === "forensics.piotroski.commonStockIssuance")).toBe(true);
  });

  it("zero long-term debt in both years -> point awarded with non-canonical note", () => {
    const { current, prior, prior2 } = piotroskiPeriods();
    current.balance!.longTermDebt = 0;
    prior.balance!.longTermDebt = 0;
    const r = computePiotroski(current, prior, prior2);
    expect(r.signals.leverageDown.value).toBe(1);
    expect(r.notes.some((n) => n.includes("zero long-term debt"))).toBe(true);
  });

  it("accrual signal: CFO > NI passes, CFO < NI fails", () => {
    const { current, prior, prior2 } = piotroskiPeriods();
    current.cashFlow!.netCashProvidedByOperatingActivities = 5; // < NI 7
    const r = computePiotroski(current, prior, prior2);
    expect(r.signals.accrualQuality.value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Accruals
// ---------------------------------------------------------------------------

describe("computeAccruals", () => {
  const current: ForensicsPeriod = {
    income: { date: "2025-12-31", netIncome: 100 },
    balance: {
      date: "2025-12-31",
      totalAssets: 1200,
      cashAndShortTermInvestments: 100,
      totalLiabilities: 700,
      totalDebt: 250,
    },
    cashFlow: {
      date: "2025-12-31",
      netIncome: 100,
      netCashProvidedByOperatingActivities: 60,
      netCashProvidedByInvestingActivities: -20,
    },
  };
  const prior: ForensicsPeriod = {
    balance: {
      date: "2024-12-31",
      totalAssets: 1000,
      cashAndShortTermInvestments: 100,
      totalLiabilities: 600,
      totalDebt: 200,
    },
  };

  it("cash-flow approach primary: (NI - CFO - CFI)/avg NOA", () => {
    const r = computeAccruals(current, prior);
    // NOA_t = (1200-100)-(700-250) = 650; NOA_p = (1000-100)-(600-200) = 500; avg = 575.
    expect(r.noaCurrent).toBe(650);
    expect(r.noaPrior).toBe(500);
    expect(r.scaler).toBe("avgNOA");
    expect(r.scalerValue).toBe(575);
    // aggregate CF accruals = 100 - 60 - (-20) = 60 -> 60/575.
    expect(r.aggregateAccrualsCashFlow).toBe(60);
    expect(r.cashFlowAccrualRatio!).toBeCloseTo(60 / 575, 12);
    expect(r.band).toBe("elevated"); // 10.43% -> 10-20% band
    // BS secondary: 150/575.
    expect(r.balanceSheetAccrualRatio!).toBeCloseTo(150 / 575, 12);
    expect(r.notes.some((n) => n.includes("House-rule bands"))).toBe(true);
    // CF vs BS diverge by ~15.7pp > 10pp -> M&A/FX divergence note.
    expect(r.notes.some((n) => n.includes("diverge"))).toBe(true);
  });

  it("bands annotated as house rules: <10% unremarkable, 10-20% elevated, >20% red", () => {
    expect(classifyAccrualBand(0.0999)).toBe("unremarkable");
    expect(classifyAccrualBand(0.1)).toBe("elevated");
    expect(classifyAccrualBand(0.1999)).toBe("elevated");
    expect(classifyAccrualBand(0.2)).toBe("red");
    expect(classifyAccrualBand(-0.25)).toBe("red"); // absolute value
  });

  it("NOA <= 0 -> rescaled by average total assets with a house-rule note", () => {
    const cur2: ForensicsPeriod = {
      ...current,
      balance: {
        date: "2025-12-31",
        totalAssets: 1000,
        cashAndShortTermInvestments: 900,
        totalLiabilities: 700,
        totalDebt: 100,
      },
    };
    const pri2: ForensicsPeriod = {
      balance: {
        date: "2024-12-31",
        totalAssets: 1000,
        cashAndShortTermInvestments: 900,
        totalLiabilities: 700,
        totalDebt: 100,
      },
    };
    const r = computeAccruals(cur2, pri2);
    expect(r.noaCurrent).toBe(-500);
    expect(r.scaler).toBe("avgTotalAssets");
    expect(r.scalerValue).toBe(1000);
    expect(r.cashFlowAccrualRatio!).toBeCloseTo(60 / 1000, 12);
    expect(r.notes.some((n) => n.includes("average total assets"))).toBe(true);
  });

  it("missing CF statement -> partial result + gap, no throw", () => {
    const r = computeAccruals({ ...current, cashFlow: null, income: null }, prior);
    expect(r.cashFlowAccrualRatio).toBeNull();
    expect(r.balanceSheetAccrualRatio).not.toBeNull(); // BS approach still works
    expect(r.gaps.some((g) => g.field === "forensics.accruals.cashFlow")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Support flags — plain-English strings
// ---------------------------------------------------------------------------

describe("computeSupportFlags", () => {
  const B = 1_000_000_000;

  it("receivables grew 25% vs revenue 8% -> warn flag with the SPEC §4 sentence", () => {
    const r = computeSupportFlags({
      income: [
        { date: "2025-12-31", revenue: 1.08 * B },
        { date: "2024-12-31", revenue: 1.0 * B },
      ],
      balance: [
        { date: "2025-12-31", accountsReceivables: 0.125 * B },
        { date: "2024-12-31", accountsReceivables: 0.1 * B },
      ],
    });
    const flag = r.flags.find((f) => f.id === "receivables-vs-revenue");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warn"); // gap 17pp: >15 warn, <=25 not yet flag
    expect(flag!.message).toContain("Receivables grew 25.0% while revenue grew 8.0%");
    expect(flag!.message).toContain("channel stuffing");
    expect(flag!.heuristic).toBe(true);
    expect(flag!.rule).toContain("15");
    expect(flag!.asOf).toEqual(["2024-12-31", "2025-12-31"]);
  });

  it("gap > 25pp escalates to severity 'flag'", () => {
    const r = computeSupportFlags({
      income: [
        { date: "2025-12-31", revenue: 1.08 * B },
        { date: "2024-12-31", revenue: 1.0 * B },
      ],
      balance: [
        { date: "2025-12-31", accountsReceivables: 0.14 * B }, // +40%
        { date: "2024-12-31", accountsReceivables: 0.1 * B },
      ],
    });
    expect(r.flags.find((f) => f.id === "receivables-vs-revenue")!.severity).toBe("flag");
  });

  it("inventory vs revenue: same thresholds, obsolescence wording", () => {
    const r = computeSupportFlags({
      income: [
        { date: "2025-12-31", revenue: 1.05 * B },
        { date: "2024-12-31", revenue: 1.0 * B },
      ],
      balance: [
        { date: "2025-12-31", inventory: 0.135 * B }, // +35% vs +5% -> 30pp -> flag
        { date: "2024-12-31", inventory: 0.1 * B },
      ],
    });
    const flag = r.flags.find((f) => f.id === "inventory-vs-revenue");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("flag");
    expect(flag!.message).toContain("Inventory grew 35.0% while revenue grew 5.0%");
    expect(flag!.message).toContain("obsolescence");
  });

  it("revenue collapse suppresses the inventory gap flag -> overhang info instead", () => {
    const r = computeSupportFlags({
      income: [
        { date: "2025-12-31", revenue: 0.85 * B }, // -15%
        { date: "2024-12-31", revenue: 1.0 * B },
      ],
      balance: [
        { date: "2025-12-31", inventory: 0.105 * B }, // +5%
        { date: "2024-12-31", inventory: 0.1 * B },
      ],
    });
    expect(r.flags.find((f) => f.id === "inventory-vs-revenue")).toBeUndefined();
    const overhang = r.flags.find((f) => f.id === "inventory-overhang");
    expect(overhang).toBeDefined();
    expect(overhang!.severity).toBe("info");
    expect(overhang!.message).toContain("overhang");
  });

  it("tiny base-year revenue suppresses growth flags (house floor, annotated)", () => {
    const r = computeSupportFlags({
      income: [
        { date: "2025-12-31", revenue: 5_000_000 },
        { date: "2024-12-31", revenue: 2_000_000 },
      ],
      balance: [
        { date: "2025-12-31", accountsReceivables: 3_000_000 },
        { date: "2024-12-31", accountsReceivables: 1_000_000 },
      ],
    });
    expect(r.flags.find((f) => f.id === "receivables-vs-revenue")).toBeUndefined();
    expect(r.notes.some((n) => n.includes("floor"))).toBe(true);
  });

  it("serial one-time items: breach in 3 of last 5 years -> 'flag' with count in message", () => {
    const yr = (date: string, oi: number, other: number) => ({
      date,
      revenue: 1 * B,
      operatingIncome: oi,
      totalOtherIncomeExpensesNet: other,
    });
    const r = computeSupportFlags({
      income: [
        yr("2025-12-31", 100e6, -20e6), // breach
        yr("2024-12-31", 100e6, 5e6),
        yr("2023-12-31", 100e6, 15e6), // breach
        yr("2022-12-31", 100e6, -11e6), // breach
        yr("2021-12-31", 100e6, 2e6),
      ],
      balance: [],
    });
    const flag = r.flags.find((f) => f.id === "serial-one-time-items");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("flag");
    expect(flag!.message).toContain("3 of the last 5 fiscal years");
  });

  it("single current-year breach -> warn", () => {
    const r = computeSupportFlags({
      income: [
        {
          date: "2025-12-31",
          revenue: 1 * B,
          operatingIncome: 100e6,
          totalOtherIncomeExpensesNet: -30e6,
        },
      ],
      balance: [],
    });
    const flag = r.flags.find((f) => f.id === "one-time-items");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warn");
    expect(flag!.message).toContain("30.0%");
  });

  // A share of 20% (= |-20e6| / |100e6|) breaches the 10% one-time-items rule.
  const oneTimeYear = (date: string, oi: number, other: number) => ({
    date,
    revenue: 1 * B,
    operatingIncome: oi,
    totalOtherIncomeExpensesNet: other,
  });

  it("serial-one-time counts DISTINCT fiscal years, not duplicated rows", () => {
    // A vendor restatement double-row of the latest breach year (2025) must NOT
    // be counted as a second distinct breach year. Distinct breach years are
    // {2025, 2024} = 2 < the serial threshold (3) -> no serial flag.
    const r = computeSupportFlags({
      income: [
        oneTimeYear("2025-12-31", 100e6, -20e6), // breach
        oneTimeYear("2025-12-31", 100e6, -20e6), // DUPLICATE of 2025
        oneTimeYear("2024-12-31", 100e6, -20e6), // breach
        oneTimeYear("2023-12-31", 100e6, 2e6), // no breach (2% share)
      ],
      balance: [],
    });
    expect(r.flags.find((f) => f.id === "serial-one-time-items")).toBeUndefined();
    // The latest-year single-breach warn still fires (share 20%).
    expect(r.flags.find((f) => f.id === "one-time-items")).toBeDefined();
  });

  it("serial-one-time still fires on 3 distinct breach years despite a duplicate row", () => {
    const r = computeSupportFlags({
      income: [
        oneTimeYear("2025-12-31", 100e6, -20e6), // breach
        oneTimeYear("2025-12-31", 100e6, -20e6), // DUPLICATE of 2025 (collapses to 1 year)
        oneTimeYear("2024-12-31", 100e6, -20e6), // breach
        oneTimeYear("2023-12-31", 100e6, -20e6), // breach
      ],
      balance: [],
    });
    const flag = r.flags.find((f) => f.id === "serial-one-time-items");
    expect(flag).toBeDefined();
    // 3 distinct breach years out of 3 distinct evaluated years (dup collapsed).
    expect(flag!.message).toContain("3 of the last 3 fiscal years");
    expect(flag!.asOf).toEqual(["2025-12-31", "2024-12-31", "2023-12-31"]);
  });

  it("missing prior-year revenue emits a disclosed gap (was a silent skip)", () => {
    const r = computeSupportFlags({
      income: [
        { date: "2025-12-31", revenue: 1.2 * B },
        { date: "2024-12-31" }, // prior-year revenue missing
      ],
      balance: [
        { date: "2025-12-31", accountsReceivables: 0.3 * B, inventory: 0.3 * B },
        { date: "2024-12-31", accountsReceivables: 0.1 * B, inventory: 0.1 * B },
      ],
    });
    // Growth-gap flags cannot be scaled without a prior-year revenue base.
    expect(r.flags.find((f) => f.id === "receivables-vs-revenue")).toBeUndefined();
    expect(r.flags.find((f) => f.id === "inventory-vs-revenue")).toBeUndefined();
    // ...but the skip is now disclosed instead of silent.
    expect(r.gaps.some((g) => g.field === "forensics.flags.revenueBase")).toBe(true);
  });

  it("non-positive prior-year revenue: explanatory note + disclosed gap", () => {
    const r = computeSupportFlags({
      income: [
        { date: "2025-12-31", revenue: 1.2 * B },
        { date: "2024-12-31", revenue: -5e6 }, // non-positive base
      ],
      balance: [
        { date: "2025-12-31", accountsReceivables: 0.3 * B },
        { date: "2024-12-31", accountsReceivables: 0.1 * B },
      ],
    });
    expect(r.notes.some((n) => n.includes("non-positive"))).toBe(true);
    expect(r.gaps.some((g) => g.field === "forensics.flags.revenueBase")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runForensics — orchestration + financial suppression
// ---------------------------------------------------------------------------

describe("runForensics", () => {
  function fullInputs() {
    const { current, prior, prior2 } = piotroskiPeriods();
    return {
      income: [current.income!, prior.income!],
      balance: [current.balance!, prior.balance!, prior2.balance!],
      cashFlow: [current.cashFlow!, prior.cashFlow!],
      marketCap: 500,
    };
  }

  it("bank route: Altman/Beneish/accruals null with explanatory notes; Piotroski computed", () => {
    const report = runForensics(bankRoute, fullInputs());
    expect(report.altman).toBeNull();
    expect(report.altmanSelection.variant).toBeNull();
    expect(report.beneish).toBeNull();
    expect(report.accruals).toBeNull();
    expect(report.piotroski).not.toBeNull();
    expect(report.notes.some((n) => n.includes("Beneish") && n.includes("financial"))).toBe(true);
    expect(report.notes.some((n) => n.includes("Accrual") && n.includes("suppressed"))).toBe(true);
    expect(report.notes.some((n) => n.includes("Piotroski") && n.includes("non-financial"))).toBe(true);
    expect(isFinancialForensicsSuppressed(bankRoute)).toBe(true);
  });

  it("general route: everything computed; AAPL-style sector routing picks z2", () => {
    const report = runForensics(generalRoute, fullInputs());
    expect(report.altmanSelection.variant).toBe("z2");
    expect(report.altman).not.toBeNull();
    expect(report.altman!.variant).toBe("z2");
    expect(report.beneish).not.toBeNull();
    expect(report.beneish!.score).not.toBeNull();
    expect(report.piotroski).not.toBeNull();
    expect(report.piotroski!.outOf).toBe(9); // 3rd-year balance sheet present
    expect(report.accruals).not.toBeNull();
  });

  it("single fiscal year: Beneish/Piotroski/accruals unavailable with gaps, Altman still computed", () => {
    const { current } = piotroskiPeriods();
    const report = runForensics(generalRoute, {
      income: [current.income!],
      balance: [current.balance!],
      cashFlow: [current.cashFlow!],
      marketCap: 500,
    });
    expect(report.beneish).toBeNull();
    expect(report.piotroski).toBeNull();
    expect(report.accruals).toBeNull();
    expect(report.altman).not.toBeNull(); // single-period computable
    expect(report.gaps.some((g) => g.field === "forensics.beneish")).toBe(true);
    expect(report.gaps.some((g) => g.field === "forensics.piotroski")).toBe(true);
  });

  it("joins statement rows by fiscal date instead of array index", () => {
    const aligned = alignForensicPeriods({
      income: [{ date: "2025-12-31" }, { date: "2024-12-31" }],
      balance: [{ date: "2025-12-31" }, { date: "2023-12-31" }],
      cashFlow: [{ date: "2025-12-31" }, { date: "2024-12-31" }],
    });
    expect(aligned).toHaveLength(3);
    expect(aligned[1].income?.date).toBe("2024-12-31");
    expect(aligned[1].cashFlow?.date).toBe("2024-12-31");
    expect(aligned[1].balance).toBeNull();
    expect(aligned[2].balance?.date).toBe("2023-12-31");
    expect(aligned[2].income).toBeNull();
  });

  it("aligns small fiscal-date differences within the explicit tolerance", () => {
    const aligned = alignForensicPeriods({
      income: [{ date: "2025-09-27" }],
      balance: [{ date: "2025-09-28" }],
      cashFlow: [{ date: "2025-09-26" }],
    });
    expect(aligned).toHaveLength(1);
    expect(aligned[0].income).not.toBeNull();
    expect(aligned[0].balance).not.toBeNull();
    expect(aligned[0].cashFlow).not.toBeNull();
  });

  it("dedupes an FMP restatement double-row instead of spawning a phantom period", () => {
    // Same fiscal-year income statement emitted twice. Pre-fix the second row
    // spawned an income-only phantom cluster at periods[1], 0 days from periods[0].
    const aligned = alignForensicPeriods({
      income: [
        { date: "2024-12-31", revenue: 100 },
        { date: "2024-12-31", revenue: 100 }, // duplicate fiscal-year row
        { date: "2023-12-31", revenue: 90 },
      ],
      balance: [{ date: "2024-12-31" }, { date: "2023-12-31" }],
      cashFlow: [{ date: "2024-12-31" }, { date: "2023-12-31" }],
    });
    // Two fiscal periods, NOT three — the duplicate collapses into 2024.
    expect(aligned).toHaveLength(2);
    expect(aligned[0].income?.date).toBe("2024-12-31");
    expect(aligned[1].income?.date).toBe("2023-12-31");
    expect(aligned[1].balance?.date).toBe("2023-12-31");
  });

  it("when a fiscal period is duplicated, the more complete row survives", () => {
    // Sparse row (1 finite numeric field) arrives first; the richer row (3
    // fields) arrives second and must win the dedupe.
    const aligned = alignForensicPeriods({
      income: [
        { date: "2024-12-31", revenue: 100 },
        { date: "2024-12-31", revenue: 100, netIncome: 20, costOfRevenue: 60 },
      ],
      balance: [],
      cashFlow: [],
    });
    expect(aligned).toHaveLength(1);
    expect(aligned[0].income?.netIncome).toBe(20);
    expect(aligned[0].income?.costOfRevenue).toBe(60);
  });

  it("rejects an unmatched latest statement instead of cross-pairing it", () => {
    const inputs = fullInputs();
    inputs.income = [{ ...inputs.income[0], date: "2025-06-30" }, inputs.income[1]];
    const report = runForensics(generalRoute, inputs);
    expect(report.notes.some((n) => n.includes("alignment"))).toBe(true);
    expect(report.altman).toBeNull();
    expect(report.gaps.some((g) => g.field === "forensics.statementAlignment")).toBe(true);
  });

  it("suppresses all change-based forensic metrics when fiscal years are not consecutive", () => {
    const inputs = fullInputs();
    inputs.income[1] = { ...inputs.income[1], date: "2023-12-31" };
    inputs.balance[1] = { ...inputs.balance[1], date: "2023-12-31" };
    inputs.cashFlow[1] = { ...inputs.cashFlow[1], date: "2023-12-31" };
    inputs.balance = inputs.balance.slice(0, 2);
    const report = runForensics(generalRoute, inputs);
    expect(report.altman).not.toBeNull();
    expect(report.beneish).toBeNull();
    expect(report.piotroski).toBeNull();
    expect(report.accruals).toBeNull();
    expect(report.gaps.some((g) => g.field === "forensics.fiscalContinuity")).toBe(true);
  });

  it("a duplicated latest-year statement does not gate out change-based forensics", () => {
    // FMP emits the latest fiscal year's income statement twice. The real
    // 2025->2024 consecutive pair is intact; only the vendor artifact differs.
    const inputs = fullInputs();
    inputs.income = [inputs.income[0], { ...inputs.income[0] }, inputs.income[1]];
    const report = runForensics(generalRoute, inputs);
    expect(report.beneish).not.toBeNull();
    expect(report.beneish!.score).not.toBeNull();
    expect(report.piotroski).not.toBeNull();
    expect(report.piotroski!.outOf).toBe(9); // 3rd-year balance sheet still reached
    expect(report.accruals).not.toBeNull();
    // No spurious not-consecutive gap: the phantom period is gone.
    expect(report.gaps.some((g) => g.field === "forensics.fiscalContinuity")).toBe(false);
  });

  it("discloses a sub-annual transition stub while still computing YoY forensics", () => {
    // 2025-12-31 minus ~305 days = 2025-03-01: a consecutive-but-sub-annual stub
    // (>= the 300-day floor, < the 340-day disclosure threshold).
    const inputs = fullInputs();
    inputs.income[1] = { ...inputs.income[1], date: "2025-03-01" };
    inputs.balance[1] = { ...inputs.balance[1], date: "2025-03-01" };
    inputs.cashFlow[1] = { ...inputs.cashFlow[1], date: "2025-03-01" };
    inputs.balance = inputs.balance.slice(0, 2); // drop the now-non-consecutive 2023 prior2
    const report = runForensics(generalRoute, inputs);
    // Fail-open: the YoY comparison is still computed...
    expect(report.beneish).not.toBeNull();
    expect(report.beneish!.score).not.toBeNull();
    // ...but the stub is disclosed with a note + gap.
    expect(report.gaps.some((g) => g.field === "forensics.fiscalContinuity.subAnnual")).toBe(true);
    expect(report.notes.some((n) => n.includes("sub-annual"))).toBe(true);
    // A normal 365-day gap must NOT trigger the sub-annual disclosure.
    const clean = runForensics(generalRoute, fullInputs());
    expect(clean.gaps.some((g) => g.field === "forensics.fiscalContinuity.subAnnual")).toBe(false);
  });

  it("DSRI above the manipulator-sample mean 1.465 surfaces a flag even when M is benign", () => {
    const { current, prior } = beneishManipulatorPeriods();
    // Soften the fixture so M itself is benign but DSRI (1.538) stays high:
    // TATA = (120 - 300)/1200 = -0.15 -> M ~= -2.366 -> "unlikely".
    current.cashFlow!.netCashProvidedByOperatingActivities = 300;
    const report = runForensics(generalRoute, {
      income: [current.income!, prior.income!],
      balance: [current.balance!, prior.balance!],
      cashFlow: [current.cashFlow!, prior.cashFlow!],
      marketCap: 5000,
    });
    expect(report.beneish!.verdict).not.toBe("flag");
    const dsriFlag = report.flags.find((f) => f.id === "dsri-elevated");
    expect(dsriFlag).toBeDefined();
    expect(dsriFlag!.message).toContain("1.465");
  });
});
