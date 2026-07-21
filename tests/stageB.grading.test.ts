/**
 * Stage B — deterministic aspect scoring (grading.ts).
 *
 * Covers the scoring primitives (piecewise band interpolation, letter mapping,
 * stdev), a healthy-company end-to-end score, data-completeness accounting when
 * signals are missing, sector-policy suppression (a bank is not scored on
 * Altman/Beneish/net-debt), and the not-applicable paths (pre-revenue valuation,
 * financial-route balance sheet).
 */

import { describe, expect, it } from "vitest";

import {
  computeScores,
  bandScore,
  scoreToBand,
  stdev,
  normalizeAltmanForBanding,
  SCORE_BANDS_VERSION,
  type ScoringInputs,
} from "@/pipeline/stageB/grading";
import { ALTMAN_ZONES } from "@/pipeline/stageB/forensics";
import { metricPolicy } from "@/pipeline/stageB/sectorRouting";
import type { CompanyRouteResult, MetricPolicy } from "@/pipeline/stageB/sectorRouting";
import type { GrowthResult } from "@/pipeline/stageB/growth";
import type { RoicResult, RoicVsWaccSpread, WaccResult } from "@/pipeline/stageB/returns";
import type { CapitalResult } from "@/pipeline/stageB/capital";
import type { ForensicsReport } from "@/pipeline/stageB/forensics";
import type { TechnicalsResult } from "@/pipeline/stageB/technicals";
import type { ValuationResult } from "@/pipeline/stageB/valuation";
import type { SectorRoute, SectorOverlay } from "@/types/core";

/* ------------------------------------------------------------------------ *
 * Fixtures — minimal but typed; only the fields grading.ts reads are set.
 * ------------------------------------------------------------------------ */

function policy(suppress: string[] = []): MetricPolicy {
  return { suppress, lead: [] };
}

function route(base: SectorRoute = "general", overlays: SectorOverlay[] = []): CompanyRouteResult {
  return {
    base,
    overlays,
    evidence: { sector: null, industry: null },
    notes: [],
    gaps: [],
    asOf: { today: "2026-07-06", incomeTtm: null, incomeAnnual: null, cashflowTtm: null, cashflowAnnual: null },
  };
}

function cagr(windowYears: number, cagrPct: number | null) {
  return { windowYears, actualYears: windowYears, cagrPct, startDate: null, endDate: null, startValue: null, endValue: null };
}

function growth(over: Partial<GrowthResult> = {}): GrowthResult {
  return {
    asOf: "2025-09-30",
    period: "annual",
    revenueCagrs: [cagr(1, 18), cagr(3, 16), cagr(5, 15), cagr(10, 12)],
    epsDilutedCagrs: [cagr(1, 30), cagr(3, 25), cagr(5, 20), cagr(10, 18)],
    fcfCagrs: [cagr(1, 22), cagr(3, 20), cagr(5, 18), cagr(10, 15)],
    margins: {
      gross: { series: [{ date: "2025", pct: 78 }], slopePctPtsPerYear: 0.5 },
      operating: { series: [{ date: "2025", pct: 30 }], slopePctPtsPerYear: 1.2 },
      net: { series: [{ date: "2025", pct: 22 }], slopePctPtsPerYear: 0.8 },
    },
    revenueAcceleration: { latestYoyPct: 18, threeYearCagrPct: 16, deltaPctPts: 2, accelerating: true },
    notes: [],
    gaps: [],
    ...over,
  } as GrowthResult;
}

function roic(latestRoicPct: number | null = 22, series: (number | null)[] = [20, 21, 22, 23, 22]): RoicResult {
  return {
    series: series.map((roicPct, i) => ({ date: `202${i}`, roicPct, nopat: null, investedCapitalAvg: null, taxRateUsed: null, notes: [] })),
    latestRoicPct,
    asOf: "2025-09-30",
    notes: [],
    gaps: [],
  } as RoicResult;
}

function roicVsWacc(spreadPctPts: number | null = 6): RoicVsWaccSpread {
  return { spreadPctPts, note: "ROIC - WACC" };
}

function wacc(): WaccResult {
  return { waccPct: 9, costOfEquityPct: 10, notes: [], clampsApplied: [], gaps: [] } as unknown as WaccResult;
}

function capital(over: Partial<CapitalResult> = {}): CapitalResult {
  return {
    asOf: "2025-09-30",
    fcf: { series: [], latestFcf: 1000, latestConversion: 1.05 },
    capexIntensity: { series: [], latestPct: 5, slopePctPtsPerYear: 0 },
    maintenanceVsGrowthCapex: { capexToDALatest: 1, capexToDA5yAvg: 1, impliedMaintenanceCapex: null, impliedGrowthCapex: null, note: "" },
    netDebtToEbitda: { value: 0.8, netDebt: 800, ebitda: 1000, asOf: "2025-09-30" },
    interestCoverage: { value: 15, ebit: 900, interestExpense: 60 },
    sbc: { latest: 50, pctOfRevenue: 3, pctOfFcf: 8 },
    shareCount: { trendPct: -10, annualizedPct: -2.5, direction: "buyback", startDate: null, endDate: null, startShares: null, endShares: null, actualYears: 5 },
    buybackPriceAnalysis: { totalRepurchased: 5000, avgPricePaidProxy: 120, currentPrice: 150, premiumDiscountPct: 25, years: [], note: "" },
    notes: [],
    gaps: [],
    ...over,
  } as CapitalResult;
}

function forensics(over: Partial<ForensicsReport> = {}): ForensicsReport {
  return {
    altmanSelection: { variant: "original", notes: [] },
    altman: { variant: "original", score: 4.2, zone: "safe", thresholds: { distressBelow: 1.81, safeAbove: 3 }, components: { x1: null, x2: null, x3: null, x4: null, x5: null }, notes: [], gaps: [], asOf: { balanceSheet: null, incomeStatement: null, marketCap: null } },
    beneish: { score: -2.6, verdict: "unlikely", indices: {} as never, tataBalanceSheet: null, neutralized: [], clamped: [], notes: [], gaps: [], asOf: { current: null, prior: null } },
    piotroski: { score: 8, outOf: 9, signals: {} as never, notes: [], gaps: [], asOf: { current: null, prior: null, prior2: null } },
    accruals: { cashFlowAccrualRatio: 0.03, balanceSheetAccrualRatio: null, aggregateAccrualsCashFlow: null, aggregateAccrualsBalanceSheet: null, noaCurrent: null, noaPrior: null, scaler: "avgNOA", scalerValue: null, band: "unremarkable", notes: [], gaps: [], asOf: { current: null, prior: null } },
    flags: [],
    notes: [],
    gaps: [],
    ...over,
  } as ForensicsReport;
}

function technicals(): TechnicalsResult {
  return {
    asOf: "2025-09-30",
    lastClose: 150,
    rowsUsed: 1000,
    smaCross: { sma50: 148, sma200: 138, state: "golden", lastCrossDate: null, lastCrossType: null },
    rsi14: 58,
    macd: {} as never,
    range52w: { high52w: 160, low52w: 100, highDate: null, lowDate: null, pctFromHigh: -6, pctFromLow: 50, distanceFromHigh: null, distanceFromLow: null, positionPct: 83, asOf: null },
    relativeStrength: {
      benchmark: { benchmarkSymbol: "SPY", points: [{ months: 3, symbolReturnPct: 10, benchmarkReturnPct: 5, differentialPctPoints: 5 }, { months: 6, symbolReturnPct: 20, benchmarkReturnPct: 8, differentialPctPoints: 12 }, { months: 12, symbolReturnPct: 30, benchmarkReturnPct: 15, differentialPctPoints: 15 }], notes: [], gaps: [], asOf: null },
      sector: null,
    },
    volumeTrend: {} as never,
    atr14: {} as never,
    drawdowns: [],
    read: {} as never,
    notes: [],
    gaps: [],
  } as unknown as TechnicalsResult;
}

function valuationDcf(perShare = 190, impliedGrowth = 8, pePercentile = 40): ValuationResult {
  return {
    kind: "dcf",
    route: "general",
    assumptions: null,
    dcf: { perShare } as never,
    sensitivity: null,
    reverseDcf: { method: "growth", impliedRevenueGrowthPct: impliedGrowth, impliedTerminalMarginPct: null, notes: [], gaps: [] },
    multiples: {
      multiples: [{ key: "peTtm", current: 28, basis: "", ownHistory: { percentileRank: pePercentile, p5: null, p25: null, p50: null, p75: null, p95: null, observations: 12, basis: "" }, peers: null }],
      sectorAppropriate: [],
      asOf: { quote: null, statements: null },
      notes: [],
      gaps: [],
    },
    notes: [],
    gaps: [],
  } as unknown as ValuationResult;
}

function valuationDcfSuppressed(pePercentile = 40): ValuationResult {
  return {
    kind: "dcf-suppressed",
    route: "general",
    multiples: {
      multiples: [{ key: "peTtm", current: 28, basis: "", ownHistory: { percentileRank: pePercentile, p5: null, p25: null, p50: null, p75: null, p95: null, observations: 12, basis: "" }, peers: null }],
      sectorAppropriate: [],
      asOf: { quote: null, statements: null },
      notes: [],
      gaps: [],
    },
    notes: ["fcfDcf suppressed by metric policy (unprofitable overlay)"],
    gaps: [],
  } as unknown as ValuationResult;
}

function makeInputs(over: Partial<ScoringInputs> = {}): ScoringInputs {
  return {
    route: route(),
    policy: policy(),
    growth: growth(),
    roic: roic(),
    roicVsWacc: roicVsWacc(),
    wacc: wacc(),
    capital: capital(),
    forensics: forensics(),
    technicals: technicals(),
    valuation: valuationDcf(),
    currentPrice: 150,
    asOf: "2026-07-06",
    ...over,
  };
}

/* ------------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------------ */

describe("grading — primitives", () => {
  it("bandScore clamps below/above and interpolates linearly", () => {
    const band = [[0, 20] as const, [10, 80] as const];
    expect(bandScore(-5, band)).toBe(20); // clamp low
    expect(bandScore(15, band)).toBe(80); // clamp high
    expect(bandScore(5, band)).toBeCloseTo(50, 6); // midpoint
    expect(bandScore(2.5, band)).toBeCloseTo(35, 6);
  });

  it("scoreToBand maps 0–100 to A–F at documented thresholds", () => {
    expect(scoreToBand(90)).toBe("A");
    expect(scoreToBand(85)).toBe("A");
    expect(scoreToBand(84.9)).toBe("B");
    expect(scoreToBand(70)).toBe("B");
    expect(scoreToBand(55)).toBe("C");
    expect(scoreToBand(40)).toBe("D");
    expect(scoreToBand(39.9)).toBe("F");
  });

  it("stdev is null below 2 points and correct otherwise", () => {
    expect(stdev([5])).toBeNull();
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 6);
  });
});

/* ------------------------------------------------------------------------ *
 * End to end
 * ------------------------------------------------------------------------ */

describe("grading — computeScores", () => {
  it("a healthy company scores well across aspects with a composite band", () => {
    const s = computeScores(makeInputs());
    expect(s.bandsVersion).toBe(SCORE_BANDS_VERSION);
    // Every aspect scored (general route, full data).
    for (const key of Object.keys(s.aspects) as (keyof typeof s.aspects)[]) {
      expect(s.aspects[key].score).not.toBeNull();
      expect(s.aspects[key].dataCompleteness).toBe(1);
      expect(s.aspects[key].drivers.length).toBeGreaterThan(0);
    }
    // A strong compounder should land composite in B/A territory.
    expect(s.composite.score).not.toBeNull();
    expect(s.composite.score!).toBeGreaterThan(60);
    expect(["A", "B"]).toContain(s.composite.band);
    // Weights emitted sum to 100 for audit.
    const sum = Object.values(s.composite.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it("drivers are traced numbers sourced under computed.scores.*", () => {
    const s = computeScores(makeInputs());
    const d = s.aspects.quality.drivers[0];
    expect(d.source).toMatch(/^computed\.scores\.quality\./);
    expect(d.verified).toBe(true);
    expect(d.asOf).toBe("2026-07-06");
  });

  it("dataCompleteness drops when signals are missing", () => {
    const thin = makeInputs({
      growth: growth({
        revenueCagrs: [cagr(5, 15)],
        epsDilutedCagrs: [cagr(5, null)],
        fcfCagrs: [cagr(5, null)],
        margins: {
          gross: { series: [], slopePctPtsPerYear: null },
          operating: { series: [], slopePctPtsPerYear: null },
          net: { series: [], slopePctPtsPerYear: null },
        },
      } as Partial<GrowthResult>),
    });
    const f = computeScores(thin).aspects.fundamentals;
    // Only revenueCagr (weight 0.35) survived of total 1.0.
    expect(f.dataCompleteness).toBeCloseTo(0.35, 2);
    expect(f.score).not.toBeNull();
  });

  it("composite is the completeness-weighted mean — thin aspects carry proportionally less", () => {
    // Same thin-fundamentals fixture: fundamentals is scored on 35% of its
    // signal weight, so it enters the composite at 0.35× its route weight. The
    // composite must equal the completeness-weighted mean, and must DIFFER from
    // the old naive route-weighted mean (which ignored completeness).
    const s = computeScores(
      makeInputs({
        growth: growth({
          revenueCagrs: [cagr(5, 15)],
          epsDilutedCagrs: [cagr(5, null)],
          fcfCagrs: [cagr(5, null)],
          margins: {
            gross: { series: [], slopePctPtsPerYear: null },
            operating: { series: [], slopePctPtsPerYear: null },
            net: { series: [], slopePctPtsPerYear: null },
          },
        } as Partial<GrowthResult>),
      }),
    );
    const round2 = (v: number): number => Math.round(v * 100) / 100;
    const w = s.composite.weights;
    let effAcc = 0;
    let effW = 0;
    let naiveAcc = 0;
    let naiveW = 0;
    let sawThin = false;
    for (const key of Object.keys(s.aspects) as (keyof typeof s.aspects)[]) {
      const a = s.aspects[key];
      if (a.score === null) continue;
      if (a.dataCompleteness < 1) sawThin = true;
      effAcc += a.score * w[key] * a.dataCompleteness;
      effW += w[key] * a.dataCompleteness;
      naiveAcc += a.score * w[key];
      naiveW += w[key];
    }
    expect(sawThin).toBe(true); // fixture actually exercises the down-weighting
    // Composite uses the completeness-weighted mean, then shrinks only the
    // unsupported fraction to neutral so sparse evidence cannot look extreme.
    const raw = effAcc / effW;
    const completeness = Math.min(1, effW / 100);
    expect(s.composite.score).toBe(round2(50 + (raw - 50) * completeness));
    // ...and is NOT the naive route-weighted mean (guards against a regression).
    expect(round2(effAcc / effW)).not.toBe(round2(naiveAcc / naiveW));
  });

  it("composite renormalises over available aspects when one is not applicable", () => {
    const s = computeScores(makeInputs({ valuation: { kind: "pre-revenue", route: "general", multiples: null, notes: [], gaps: [] } as ValuationResult, route: route("general", ["pre-revenue"]) }));
    expect(s.aspects.valuation.score).toBeNull();
    expect(s.aspects.valuation.notApplicableReason).not.toBeNull();
    // Composite still computed from the remaining aspects.
    expect(s.composite.score).not.toBeNull();
  });

  it("dcf-suppressed valuation (unprofitable overlay) keeps dataCompleteness at 0.3, not 0 or 1 (2026-07 audit finding 3)", () => {
    // Mirrors the "dcf" branch's unprofitable-overlay behavior exactly: dcfUpside
    // (0.4) and reverseImpliedVsAchievable (0.3) are suppressed via metric
    // policy, only peOwnPercentile (0.3) actually scores — same math as before
    // the dcf-suppressed kind existed, so this must NOT regress to 0 (no
    // signals emitted) or silently jump to 1.0 (only the un-suppressed signal
    // counted toward totalWeight).
    const s = computeScores(
      makeInputs({
        valuation: valuationDcfSuppressed(),
        route: route("general", ["unprofitable"]),
        policy: policy(["fcfDcf"]),
      }),
    );
    expect(s.aspects.valuation.score).not.toBeNull();
    expect(s.aspects.valuation.dataCompleteness).toBeCloseTo(0.3, 2);
  });

  function withBeneish(score: number): ForensicsReport {
    return forensics({
      beneish: {
        score,
        verdict: score < -1.78 ? "unlikely" : "flag",
        indices: {} as never,
        tataBalanceSheet: null,
        neutralized: [],
        clamped: [],
        notes: [],
        gaps: [],
        asOf: { current: null, prior: null },
      },
    } as Partial<ForensicsReport>);
  }

  it("Beneish sub-score rewards a clean M-score (more negative) over a flagged one", () => {
    // A clean M well below the -1.78 flag must score BETTER on Quality than an M above it.
    const clean = computeScores(makeInputs({ forensics: withBeneish(-3.2) }));
    const flagged = computeScores(makeInputs({ forensics: withBeneish(-0.5) }));
    expect(clean.aspects.quality.score).not.toBeNull();
    expect(clean.aspects.quality.score!).toBeGreaterThan(flagged.aspects.quality.score!);
  });
});

/* ------------------------------------------------------------------------ *
 * Sector routing
 * ------------------------------------------------------------------------ */

describe("grading — sector routing", () => {
  it("a bank route suppresses Altman/Beneish and marks balance sheet not-applicable", () => {
    const bankPolicy = policy(["evEbitda", "netDebt", "netDebtToEbitda", "fcfDcf", "altmanZ", "beneishM"]);
    const s = computeScores(
      makeInputs({
        route: route("bank"),
        policy: bankPolicy,
        valuation: {
          kind: "excess-return",
          route: "bank",
          excessReturn: { roePathPct: { value: [14, 12], basis: "" }, reverseSolve: { impliedSteadyRoePct: 10, notes: [] } } as never,
          multiples: { multiples: [{ key: "priceToTbv", current: 1.3, basis: "", ownHistory: { percentileRank: 35, p5: null, p25: null, p50: null, p75: null, p95: null, observations: 10, basis: "" }, peers: null }], sectorAppropriate: [], asOf: { quote: null, statements: null }, notes: [], gaps: [] },
          notes: [],
          gaps: [],
        } as unknown as ValuationResult,
      }),
    );
    // Balance sheet not scored for financials.
    expect(s.aspects.balanceSheet.score).toBeNull();
    expect(s.aspects.balanceSheet.notApplicableReason).toMatch(/financial/i);
    // Quality dropped the suppressed Altman/Beneish signals -> completeness < 1.
    expect(s.aspects.quality.dataCompleteness).toBeLessThan(1);
    const qNames = s.aspects.quality.drivers.map((d) => d.source);
    expect(qNames.some((n) => n.includes("altmanZ"))).toBe(false);
    expect(qNames.some((n) => n.includes("beneishM"))).toBe(false);
    expect(qNames.some((n) => n.includes("roicVsWaccSpread"))).toBe(true);
    // Financial weights used.
    expect(s.composite.weights.quality).toBe(26);
  });

  function excessReturnVal(curRoe: number, impliedRoe: number, tbvPercentile = 40): ValuationResult {
    return {
      kind: "excess-return",
      route: "bank",
      excessReturn: { roePathPct: { value: [curRoe, curRoe - 1], basis: "" }, reverseSolve: { impliedSteadyRoePct: impliedRoe, notes: [] } } as never,
      multiples: { multiples: [{ key: "priceToTbv", current: 1.2, basis: "", ownHistory: { percentileRank: tbvPercentile, p5: null, p25: null, p50: null, p75: null, p95: null, observations: 10, basis: "" }, peers: null }], sectorAppropriate: [], asOf: { quote: null, statements: null }, notes: [], gaps: [] },
      notes: [],
      gaps: [],
    } as unknown as ValuationResult;
  }

  it("excess-return valuation rewards a bank the market underprices (implied ROE < achievable)", () => {
    const bankPolicy = policy(["altmanZ", "beneishM", "netDebtToEbitda", "fcfDcf"]);
    // Cheap: bank earns 15% ROE, market implies only 9% ⇒ too pessimistic.
    const cheap = computeScores(makeInputs({ route: route("bank"), policy: bankPolicy, valuation: excessReturnVal(15, 9) }));
    // Rich: bank earns 9%, market implies 15% ⇒ too optimistic.
    const rich = computeScores(makeInputs({ route: route("bank"), policy: bankPolicy, valuation: excessReturnVal(9, 15) }));
    expect(cheap.aspects.valuation.score).not.toBeNull();
    expect(rich.aspects.valuation.score).not.toBeNull();
    expect(cheap.aspects.valuation.score!).toBeGreaterThan(rich.aspects.valuation.score!);
  });
});

/* ------------------------------------------------------------------------ *
 * Altman variant normalization (2026-07 audit Defect A)
 * ------------------------------------------------------------------------ */

describe("grading — Altman variant-aware banding", () => {
  it("normalizeAltmanForBanding is identity for the original variant", () => {
    expect(normalizeAltmanForBanding(2.7, "original")).toBe(2.7);
    expect(normalizeAltmanForBanding(0.4, "original")).toBe(0.4);
  });

  it("maps each variant's published zone anchors onto the original 1.81/2.99 anchors", () => {
    for (const variant of ["private", "z2", "z2-em"] as const) {
      const z = ALTMAN_ZONES[variant];
      expect(normalizeAltmanForBanding(z.distressBelow, variant)).toBeCloseTo(1.81, 9);
      expect(normalizeAltmanForBanding(z.safeAbove, variant)).toBeCloseTo(2.99, 9);
    }
  });

  it("is affine beyond the anchors (relative grey-zone position preserved)", () => {
    // z2 grey-zone midpoint (1.85) must land at the original grey midpoint.
    expect(normalizeAltmanForBanding(1.85, "z2")).toBeCloseTo((1.81 + 2.99) / 2, 9);
    // Above safe: z2 2.7 -> 1.81 + (2.7 - 1.1) * (1.18 / 1.5).
    expect(normalizeAltmanForBanding(2.7, "z2")).toBeCloseTo(1.81 + (2.7 - 1.1) * (1.18 / 1.5), 9);
  });

  function forensicsWithAltman(variant: "original" | "z2", score: number): ForensicsReport {
    return forensics({
      altmanSelection: { variant, notes: [] },
      altman: {
        variant,
        score,
        zone: "grey",
        thresholds: ALTMAN_ZONES[variant],
        components: { x1: null, x2: null, x3: null, x4: null, x5: null },
        notes: [],
        gaps: [],
        asOf: { balanceSheet: null, incomeStatement: null, marketCap: null },
      } as ForensicsReport["altman"],
    });
  }

  it("a safe-zone z2 score no longer banded as if it were a grey original score", () => {
    // 2.7 is SAFE on the z2 scale (safeAbove 2.6) but grey on the original
    // scale (safeAbove 2.99). Same number, different variants — the z2 company
    // must now get the higher quality sub-score.
    const z2 = computeScores(makeInputs({ forensics: forensicsWithAltman("z2", 2.7) }));
    const orig = computeScores(makeInputs({ forensics: forensicsWithAltman("original", 2.7) }));
    expect(z2.aspects.quality.score).not.toBeNull();
    expect(orig.aspects.quality.score).not.toBeNull();
    expect(z2.aspects.quality.score!).toBeGreaterThan(orig.aspects.quality.score!);
  });

  it("a distressed z2 score is banded as distressed, not mid-grey", () => {
    // 0.5 is deep distress on z2 (distressBelow 1.1); on the original scale the
    // old code would band 0.5 near the floor anyway, but 1.7 (z2 grey-low)
    // must band clearly below an original 1.7-equivalent… normalized 1.7(z2)
    // ≈ 2.276(original scale) > raw 1.7, so distress/grey ordering holds.
    const deepDistress = computeScores(makeInputs({ forensics: forensicsWithAltman("z2", 0.5) }));
    const safe = computeScores(makeInputs({ forensics: forensicsWithAltman("z2", 3.5) }));
    expect(deepDistress.aspects.quality.score!).toBeLessThan(safe.aspects.quality.score!);
  });
});

/* ------------------------------------------------------------------------ *
 * Currency-suppressed DCF (audit H3): grading must REWEIGHT, not zero-score
 * ------------------------------------------------------------------------ */

describe("grading — currency-suppressed DCF path (audit H3)", () => {
  it("kind 'dcf' with dcf/reverseDcf null reweights the valuation aspect onto the multiple percentile", () => {
    // The ADR currency guard suppresses dcf + reverseDcf (both null) while the
    // multiples framework stays available. The dcfUpside (0.4) and
    // reverseImpliedVsAchievable (0.3) signals must be DROPPED (no data), the
    // aspect scored on peOwnPercentile alone with completeness 0.3 — never a
    // saturated UPSIDE_BAND score from a mixed-currency +800% "upside".
    const suppressed = {
      ...(valuationDcf() as unknown as Record<string, unknown>),
      assumptions: null,
      dcf: null,
      sensitivity: null,
      reverseDcf: null,
    } as unknown as ValuationResult;
    const s = computeScores(makeInputs({ valuation: suppressed, currentPrice: 100 }));
    const v = s.aspects.valuation;
    // peOwnPercentile fixture = 40 -> MULTIPLE_PERCENTILE_BAND breakpoints
    // [25,74]..[50,56]: 74 + (56-74)*(40-25)/25 = 74 - 10.8 = 63.2 exactly.
    expect(v.score).toBeCloseTo(63.2, 6);
    expect(v.dataCompleteness).toBeCloseTo(0.3, 6);
    expect(v.drivers.some((d) => d.source.endsWith(".dcfUpside"))).toBe(false);
    expect(v.drivers.some((d) => d.source.endsWith(".reverseImpliedVsAchievable"))).toBe(false);
    expect(v.drivers.some((d) => d.source.endsWith(".peOwnPercentile"))).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Composite completeness over ROUTE-APPLICABLE evidence (audit finding 1)
 *
 * A metric that the sector route legitimately suppresses (a bank's Altman /
 * Beneish / net-debt / gross-margin) is NOT missing evidence — the completeness
 * shrinkage must measure against the route-applicable ceiling, not a fixed 100,
 * so a fully-observed non-general company is not structurally capped below A.
 * ------------------------------------------------------------------------ */

describe("grading — composite completeness excludes route-inapplicable evidence (finding 1)", () => {
  const round2 = (v: number): number => Math.round(v * 100) / 100;

  function bankExcessReturn(curRoe = 15, impliedRoe = 9, tbvPercentile = 40): ValuationResult {
    return {
      kind: "excess-return",
      route: "bank",
      excessReturn: { roePathPct: { value: [curRoe, curRoe - 1], basis: "" }, reverseSolve: { impliedSteadyRoePct: impliedRoe, notes: [] } } as never,
      multiples: { multiples: [{ key: "priceToTbv", current: 1.2, basis: "", ownHistory: { percentileRank: tbvPercentile, p5: null, p25: null, p50: null, p75: null, p95: null, observations: 10, basis: "" }, peers: null }], sectorAppropriate: [], asOf: { quote: null, statements: null }, notes: [], gaps: [] },
      notes: [],
      gaps: [],
    } as unknown as ValuationResult;
  }

  /**
   * A bank observed on every metric its route allows. Using the REAL bank
   * metric policy, three things are route-suppressed / meaningless (NOT missing):
   *   - balanceSheet: net-debt/coverage framing not meaningful for a bank,
   *   - quality: Altman Z (0.16) + Beneish M (0.12) suppressed,
   *   - moat: gross margin (0.25) suppressed (FMP emits garbage for banks).
   * Everything else (revenue/EPS/FCF growth, ROIC level+stability, excess-return
   * valuation, capital stewardship, technicals) is fully present.
   */
  function fullyObservedBank(): ScoringInputs {
    return makeInputs({ route: route("bank"), policy: metricPolicy("bank"), valuation: bankExcessReturn() });
  }

  /** Recompute the raw completeness-weighted mean + its supporting weight from the returned aspects. */
  function rawAndCompWeight(s: ReturnType<typeof computeScores>): { raw: number; compWeight: number } {
    const w = s.composite.weights;
    let acc = 0;
    let cw = 0;
    for (const key of Object.keys(s.aspects) as (keyof typeof s.aspects)[]) {
      const a = s.aspects[key];
      if (a.score === null) continue;
      const eff = w[key] * a.dataCompleteness;
      acc += a.score * eff;
      cw += eff;
    }
    return { raw: acc / cw, compWeight: cw };
  }

  it("a fully-observed bank composite is NOT shrunk toward neutral", () => {
    const s = computeScores(fullyObservedBank());
    const { raw, compWeight } = rawAndCompWeight(s);

    // The route-applicable ceiling equals the evidence actually present, so the
    // shrink factor is exactly 1 and the composite equals the raw weighted mean
    // (50 + (raw − 50)·1 = raw). This is the finding-1 fix: route-inapplicable
    // evidence is excluded from the completeness denominator.
    expect(s.composite.score).toBe(round2(raw));
    expect(s.composite.score!).toBeGreaterThan(50);

    // compWeight can never reach 100 on a bank: balanceSheet (10) is dropped and
    // quality/moat lose their suppressed signals. Hand-derived route-applicable
    // weight = 15 + 22 + 26·0.72 + 15·0.75 + 7 + 5 = 78.97.
    expect(round2(compWeight)).toBe(78.97);

    // The OLD denominator (a fixed 100) would have shrunk this identical bank
    // by ×0.7897 toward 50 — a structural cap the fix removes.
    const oldShrunk = round2(50 + (raw - 50) * Math.min(1, compWeight / 100));
    expect(oldShrunk).toBeLessThan(s.composite.score!);
    // For this fixture the cap pushed the grade down a full band (B → C).
    expect(scoreToBand(oldShrunk)).not.toBe(s.composite.band);
  });

  it("a genuinely thin GENERAL company is still shrunk toward neutral", () => {
    // Two of fundamentals' four signals are absent DATA (not route-suppressed),
    // so the general-route ceiling stays 100 and the missing applicable evidence
    // pulls the composite below the raw mean — the opposite of the bank above.
    const thin = computeScores(
      makeInputs({
        growth: growth({
          revenueCagrs: [cagr(5, 15)],
          epsDilutedCagrs: [cagr(5, null)],
          fcfCagrs: [cagr(5, null)],
          margins: {
            gross: { series: [{ date: "2025", pct: 78 }], slopePctPtsPerYear: 0.5 },
            operating: { series: [{ date: "2025", pct: 30 }], slopePctPtsPerYear: null },
            net: { series: [], slopePctPtsPerYear: null },
          },
        } as Partial<GrowthResult>),
      }),
    );
    const { raw } = rawAndCompWeight(thin);
    expect(thin.aspects.fundamentals.dataCompleteness).toBeLessThan(1);
    expect(thin.composite.score!).toBeLessThan(round2(raw)); // shrunk
  });
});

/* ------------------------------------------------------------------------ *
 * Bank moat drops the policy-suppressed gross-margin signal (audit finding 2)
 * ------------------------------------------------------------------------ */

describe("grading — bank moat never scores on suppressed gross margin (finding 2)", () => {
  function bankInputs(over: Partial<ScoringInputs> = {}): ScoringInputs {
    return makeInputs({
      route: route("bank"),
      policy: metricPolicy("bank"),
      valuation: {
        kind: "excess-return",
        route: "bank",
        excessReturn: { roePathPct: { value: [14, 13], basis: "" }, reverseSolve: { impliedSteadyRoePct: 10, notes: [] } } as never,
        multiples: { multiples: [{ key: "priceToTbv", current: 1.2, basis: "", ownHistory: { percentileRank: 40, p5: null, p25: null, p50: null, p75: null, p95: null, observations: 10, basis: "" }, peers: null }], sectorAppropriate: [], asOf: { quote: null, statements: null }, notes: [], gaps: [] },
        notes: [],
        gaps: [],
      } as unknown as ValuationResult,
      ...over,
    });
  }

  it("gross margin (hard-suppressed for banks) is never a moat driver; moat scores on ROIC level + stability", () => {
    const s = computeScores(bankInputs());
    const names = s.aspects.moat.drivers.map((d) => d.source);
    expect(names.some((n) => n.endsWith(".grossMarginLevel"))).toBe(false);
    expect(names.some((n) => n.endsWith(".roicLevel"))).toBe(true);
    expect(names.some((n) => n.endsWith(".roicStability"))).toBe(true);
    // roicLevel 0.45 + roicStability 0.30 survive of the 1.0 moat weight; the
    // 0.25 gross-margin weight is route-suppressed ⇒ completeness caps at 0.75.
    expect(s.aspects.moat.dataCompleteness).toBeCloseTo(0.75, 6);
  });

  it("a bank with no ROIC framing yields a not-applicable moat (disclosed), not a garbage gross-margin grade", () => {
    const s = computeScores(bankInputs({ roic: roic(null, [null, null, null, null, null]) }));
    expect(s.aspects.moat.score).toBeNull();
    expect(s.aspects.moat.notApplicableReason).not.toBeNull();
    expect(s.aspects.moat.drivers.length).toBe(0);
  });

  it("gross margin remains a moat driver on the general route (unchanged)", () => {
    const s = computeScores(makeInputs());
    const names = s.aspects.moat.drivers.map((d) => d.source);
    expect(names.some((n) => n.endsWith(".grossMarginLevel"))).toBe(true);
    expect(s.aspects.moat.dataCompleteness).toBe(1);
  });
});

/* ------------------------------------------------------------------------ *
 * REIT fundamentals drops the policy-suppressed EPS-growth signal (finding 3)
 * ------------------------------------------------------------------------ */

describe("grading — REIT fundamentals never scores on suppressed EPS growth (finding 3)", () => {
  function reitValuation(pFfoPercentile = 40): ValuationResult {
    return {
      kind: "reit",
      route: "reit",
      multiples: { multiples: [{ key: "priceToFfo", current: 15, basis: "", ownHistory: { percentileRank: pFfoPercentile, p5: null, p25: null, p50: null, p75: null, p95: null, observations: 10, basis: "" }, peers: null }], sectorAppropriate: [], asOf: { quote: null, statements: null }, notes: [], gaps: [] },
      notes: [],
      gaps: [],
    } as unknown as ValuationResult;
  }

  it("EPS CAGR (GAAP EPS growth suppressed for REITs) is never a fundamentals driver", () => {
    const s = computeScores(makeInputs({ route: route("reit"), policy: metricPolicy("reit"), valuation: reitValuation() }));
    const names = s.aspects.fundamentals.drivers.map((d) => d.source);
    expect(names.some((n) => n.endsWith(".epsCagr"))).toBe(false);
    expect(names.some((n) => n.endsWith(".revenueCagr"))).toBe(true);
    // revenueCagr 0.35 + operatingMarginSlope 0.30 + fcfCagr 0.15 survive of 1.0;
    // the 0.20 EPS-CAGR weight is route-suppressed ⇒ completeness caps at 0.80.
    expect(s.aspects.fundamentals.dataCompleteness).toBeCloseTo(0.8, 6);
  });

  it("EPS CAGR remains a fundamentals driver on the general route (unchanged)", () => {
    const s = computeScores(makeInputs());
    const names = s.aspects.fundamentals.drivers.map((d) => d.source);
    expect(names.some((n) => n.endsWith(".epsCagr"))).toBe(true);
    expect(s.aspects.fundamentals.dataCompleteness).toBe(1);
  });
});
