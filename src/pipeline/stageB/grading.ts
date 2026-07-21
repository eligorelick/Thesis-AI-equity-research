/**
 * Stage B — deterministic aspect scoring (the application contract §4; feature 1.1.0).
 *
 * PURE, deterministic TypeScript: no network, no DB, no LLM. Turns the other
 * Stage B module outputs into a 0–100 sub-score per aspect plus a route-adjusted
 * weighted composite. This is the reproducible numeric anchor beneath the LLM's
 * A–F letter grades (the judge is prompted to align its letter to `band` or
 * justify a deviation).
 *
 * Design rules:
 *  - Every signal maps a raw metric to 0–100 via a DOCUMENTED, versioned band
 *    table (see SCORE_BANDS_VERSION), piecewise-linear between named breakpoints.
 *    A band change is a visible, testable diff — same discipline as the DCF's
 *    versioned spread table.
 *  - Aspect score = weighted mean over the signals that had data. Missing signals
 *    are dropped and `dataCompleteness` (0–1) records the fraction of intended
 *    weight actually available — an aspect scored on half its inputs is disclosed,
 *    not silently defaulted (the application contract §1 rule #4).
 *  - Sector routing is honoured: a signal whose metric is in `metricPolicy.suppress`
 *    is skipped (a bank is never scored on Altman/Beneish/DCF/net-debt). An aspect
 *    with no valid signals for the route is `notApplicable`, not a forced grade.
 *  - Every driver is emitted as a TracedNumber (source `computed.scores.<aspect>.
 *    <signal>`) so it renders with provenance and reads as an audit trail.
 *
 * The numeric score is authoritative and reproducible; the letter band is a
 * convenience mapping. All breakpoints are versioned house rules, tunable via
 * the exported constant.
 */

import type { CompanyRouteResult } from "@/pipeline/stageB/sectorRouting";
import type { MetricPolicy } from "@/pipeline/stageB/sectorRouting";
import type { GrowthResult } from "@/pipeline/stageB/growth";
import type { RoicResult, RoicVsWaccSpread, WaccResult } from "@/pipeline/stageB/returns";
import type { CapitalResult } from "@/pipeline/stageB/capital";
import { ALTMAN_ZONES, type AltmanVariant, type ForensicsReport } from "@/pipeline/stageB/forensics";
import type { TechnicalsResult } from "@/pipeline/stageB/technicals";
import type { ValuationResult } from "@/pipeline/stageB/valuation";
import type { Grade } from "@/types/core";
import type {
  AspectScore,
  Scoring,
  ScoreAspect,
  TracedNumber,
} from "@/report/schema";

/** Versioned band-table id, stamped into the report for auditability. */
export const SCORE_BANDS_VERSION = "SCORE_BANDS_2026_07" as const;

/* ------------------------------------------------------------------------ *
 * Scoring primitives
 * ------------------------------------------------------------------------ */

/** A piecewise-linear breakpoint: [rawInput, score0to100], sorted by input asc. */
type BandPoint = readonly [number, number];

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * Map a raw metric value to 0–100 by linear interpolation between the nearest
 * two breakpoints; clamped flat outside the first/last breakpoint. `points`
 * must be sorted ascending by input. Returns a value in [0, 100].
 */
export function bandScore(value: number, points: readonly BandPoint[]): number {
  if (points.length === 0) return 50;
  if (value <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (value >= last[0]) return last[1];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (value >= x0 && value <= x1) {
      const frac = x1 === x0 ? 0 : (value - x0) / (x1 - x0);
      return y0 + (y1 - y0) * frac;
    }
  }
  return last[1]; // unreachable for sorted input
}

/** Grade-letter bands over the 0–100 composite/aspect score (house rule). */
export function scoreToBand(score: number): Grade {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

/** Population standard deviation over finite values; null when < 2 points. */
export function stdev(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/* ------------------------------------------------------------------------ *
 * Signal + aspect assembly
 * ------------------------------------------------------------------------ */

/** One scored input to an aspect. `raw === null` ⇒ dropped (no data). */
interface Signal {
  /** Stable id -> becomes the driver TracedNumber source suffix. */
  name: string;
  raw: number | null;
  unit: string;
  weight: number;
  band: readonly BandPoint[];
  /** metricPolicy.suppress key that removes this signal for the route, if any. */
  suppressedBy?: string;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * An AspectScore plus the weight bookkeeping the composite needs to distinguish
 * route-INAPPLICABLE evidence (a metric meaningless for this route) from
 * route-applicable evidence that is merely MISSING. Only the AspectScore is
 * persisted; the weight fields are internal to composite assembly.
 */
interface ScoredAspect {
  aspect: AspectScore;
  /**
   * Sum of signal weights whose metric is NOT suppressed by the route policy —
   * i.e. the weight this aspect COULD support if every route-applicable input
   * had data. `usedWeight ≤ applicableWeight ≤ totalWeight`.
   */
  applicableWeight: number;
  /** Sum of ALL signal weights (the `dataCompleteness` denominator). */
  totalWeight: number;
  /**
   * True when the aspect is inapplicable to the route as a whole: the caller
   * passed an explicit not-applicable reason (e.g. pre-revenue valuation,
   * financial-route balance sheet) OR the route suppresses every signal. A
   * DEFAULT not-applicable (signals exist for the route but their data is
   * absent) is data-missing, NOT route-inapplicable, so it still counts toward
   * the completeness denominator.
   */
  routeInapplicable: boolean;
}

/**
 * Reduce a signal list into an AspectScore. Signals suppressed by the route
 * policy are removed from the applicable set entirely; signals with no data are
 * dropped from the score but still counted in `totalWeight`. `dataCompleteness`
 * = availableWeight / totalWeight. When nothing survives, the aspect is
 * `notApplicable`.
 */
function scoreAspect(
  aspect: ScoreAspect,
  signals: Signal[],
  weightPct: number,
  asOf: string,
  note: string,
  policy: MetricPolicy,
  notApplicableReason: string | null = null,
): ScoredAspect {
  const drivers: TracedNumber[] = [];
  let acc = 0;
  let usedWeight = 0;
  let applicableWeight = 0;
  const totalWeight = signals.reduce((a, s) => a + s.weight, 0) || 1;

  for (const s of signals) {
    if (s.suppressedBy && policy.suppress.includes(s.suppressedBy)) continue;
    // Applicable to this route (not policy-suppressed), whether or not data exists.
    applicableWeight += s.weight;
    if (!isNum(s.raw)) continue;
    const sub = bandScore(s.raw, s.band);
    acc += sub * s.weight;
    usedWeight += s.weight;
    drivers.push({
      value: round2(s.raw),
      unit: s.unit,
      source: `computed.scores.${aspect}.${s.name}`,
      asOf,
      verified: true, // deterministic, computed from sourced inputs (not model memory)
    });
  }

  if (notApplicableReason !== null || usedWeight === 0) {
    return {
      aspect: {
        score: null,
        band: null,
        weightPct,
        dataCompleteness: 0,
        drivers,
        notApplicableReason:
          notApplicableReason ??
          "no applicable signals available for this route — aspect not scored",
        note,
      },
      applicableWeight,
      totalWeight,
      // Route-inapplicable when the caller declared it, or when the route
      // suppresses EVERY signal (nothing applicable to measure here). A default
      // not-applicable with applicableWeight > 0 is data-missing (still counts
      // against completeness), not route-inapplicable.
      routeInapplicable: notApplicableReason !== null || applicableWeight === 0,
    };
  }

  const score = round2(acc / usedWeight);
  return {
    aspect: {
      score,
      band: scoreToBand(score),
      weightPct,
      dataCompleteness: round2(usedWeight / totalWeight),
      drivers,
      notApplicableReason: null,
      note,
    },
    applicableWeight,
    totalWeight,
    routeInapplicable: false,
  };
}

/* ------------------------------------------------------------------------ *
 * Per-aspect band tables (see SCORE_BANDS_VERSION) — documented house rules
 * ------------------------------------------------------------------------ */

// Growth-style CAGR (percent): negative bad, strong compounding good.
const CAGR_BAND: readonly BandPoint[] = [
  [-20, 5],
  [0, 35],
  [10, 62],
  [20, 78],
  [35, 92],
  [50, 98],
];
// Margin slope (pp/yr): expanding margins reward, eroding penalise.
const MARGIN_SLOPE_BAND: readonly BandPoint[] = [
  [-5, 18],
  [-1, 42],
  [0, 55],
  [1, 70],
  [3, 88],
];
// ROIC − WACC spread (pp): the value-creation axis.
const SPREAD_BAND: readonly BandPoint[] = [
  [-10, 12],
  [-3, 38],
  [0, 55],
  [5, 75],
  [12, 92],
];
// ROIC level (percent).
const ROIC_LEVEL_BAND: readonly BandPoint[] = [
  [0, 18],
  [8, 45],
  [15, 65],
  [25, 82],
  [40, 95],
];
// ROIC stability = stdev of the ROIC series (pp): lower = more durable moat.
const ROIC_STABILITY_BAND: readonly BandPoint[] = [
  [1, 90],
  [3, 72],
  [6, 52],
  [12, 30],
  [25, 12],
];
// Gross margin level (percent): pricing power proxy.
const GROSS_MARGIN_BAND: readonly BandPoint[] = [
  [10, 30],
  [30, 52],
  [50, 70],
  [65, 84],
  [80, 94],
];
// Net debt / EBITDA (ratio): net cash best, high leverage worst.
const NET_DEBT_EBITDA_BAND: readonly BandPoint[] = [
  [-1, 92],
  [0, 82],
  [1, 72],
  [2, 60],
  [3, 45],
  [4, 30],
  [6, 12],
];
// Interest coverage (EBIT/interest ratio): higher safer.
const COVERAGE_BAND: readonly BandPoint[] = [
  [1, 18],
  [3, 45],
  [6, 65],
  [10, 80],
  [20, 92],
];
// FCF conversion (FCF/NI fraction).
const FCF_CONVERSION_BAND: readonly BandPoint[] = [
  [0, 18],
  [0.5, 45],
  [0.8, 62],
  [1.0, 76],
  [1.3, 90],
];
// SBC as % of FCF: lower is better (dilution drag).
const SBC_FCF_BAND: readonly BandPoint[] = [
  [0, 90],
  [10, 72],
  [25, 52],
  [50, 30],
  [100, 10],
];
// SBC as % of revenue: lower better.
const SBC_REV_BAND: readonly BandPoint[] = [
  [0, 88],
  [3, 68],
  [8, 46],
  [15, 24],
  [25, 10],
];
// Share-count annualised change (percent): buybacks (negative) reward.
const SHARE_TREND_BAND: readonly BandPoint[] = [
  [-8, 90],
  [-3, 76],
  [0, 58],
  [3, 40],
  [10, 18],
];
// Buyback price discipline: premium/discount to today (percent, positive = bought below today).
const BUYBACK_DISCIPLINE_BAND: readonly BandPoint[] = [
  [-40, 28],
  [-15, 45],
  [0, 58],
  [20, 75],
  [50, 90],
];
// Piotroski F fraction (score/outOf).
const PIOTROSKI_BAND: readonly BandPoint[] = [
  [0.33, 20],
  [0.55, 48],
  [0.67, 62],
  [0.78, 78],
  [0.89, 90],
  [1.0, 96],
];
// Altman Z-score banded on the ORIGINAL 1968 scale (1.81 distress / 2.99 safe).
// Scores from other variants (private, Z″, Z″-EM) live on different scales and
// MUST be passed through normalizeAltmanForBanding() first.
const ALTMAN_Z_BAND: readonly BandPoint[] = [
  [1.0, 15],
  [1.81, 35],
  [2.5, 55],
  [3.0, 72],
  [5.0, 92],
];

/**
 * Map an Altman score from its variant's scale onto the original 1968 scale
 * (which ALTMAN_Z_BAND is calibrated to) by anchoring the variant's published
 * distress/safe thresholds (ALTMAN_ZONES) to the original's 1.81/2.99. Affine,
 * so relative position inside (and beyond) the grey zone is preserved: a Z″
 * score of 2.7 (safe on the 1.10/2.60 scale) now bands like a safe original
 * score instead of a grey one.
 */
export function normalizeAltmanForBanding(score: number, variant: AltmanVariant): number {
  if (variant === "original") return score;
  const from = ALTMAN_ZONES[variant];
  const to = ALTMAN_ZONES.original;
  const slope = (to.safeAbove - to.distressBelow) / (from.safeAbove - from.distressBelow);
  return to.distressBelow + (score - from.distressBelow) * slope;
}
// Beneish M-score: MORE NEGATIVE is cleaner (flag threshold ≈ -1.78). bandScore
// requires x ASCENDING, so the breakpoints run -4 → -1 (score descending 92 → 22).
const BENEISH_M_BAND: readonly BandPoint[] = [
  [-4.0, 92],
  [-3.0, 82],
  [-2.22, 62],
  [-1.78, 45],
  [-1.0, 22],
];
// |Accruals ratio| (fraction): lower = higher earnings quality.
const ACCRUALS_ABS_BAND: readonly BandPoint[] = [
  [0.02, 82],
  [0.1, 58],
  [0.2, 38],
  [0.4, 16],
];
// RSI-14 (0–100): momentum, with an overbought haircut past ~75.
const RSI_BAND: readonly BandPoint[] = [
  [20, 28],
  [40, 52],
  [55, 70],
  [70, 80],
  [80, 62],
  [90, 45],
];
// SMA50/SMA200 gap (percent): trend strength.
const SMA_GAP_BAND: readonly BandPoint[] = [
  [-10, 22],
  [-2, 44],
  [0, 55],
  [3, 70],
  [10, 86],
];
// 52-week position (percent 0–100).
const POSITION_BAND: readonly BandPoint[] = [
  [10, 30],
  [40, 52],
  [60, 68],
  [85, 86],
];
// Relative strength vs SPY, 6-month differential (pp).
const REL_STRENGTH_BAND: readonly BandPoint[] = [
  [-25, 22],
  [-5, 48],
  [0, 55],
  [10, 72],
  [30, 90],
];
// Valuation: DCF upside (percent) — more upside = more attractive.
const UPSIDE_BAND: readonly BandPoint[] = [
  [-40, 15],
  [-15, 40],
  [0, 55],
  [20, 75],
  [50, 92],
];
// Valuation: own-history multiple percentile (0–100) — LOWER = cheaper = better.
const MULTIPLE_PERCENTILE_BAND: readonly BandPoint[] = [
  [10, 88],
  [25, 74],
  [50, 56],
  [75, 38],
  [90, 20],
];
// Valuation: reverse-DCF market-implied growth MINUS achievable growth (pp).
// Market pricing LESS than achievable ⇒ cheap.
const IMPLIED_VS_ACHIEVABLE_BAND: readonly BandPoint[] = [
  [-15, 90],
  [-5, 70],
  [0, 55],
  [10, 35],
  [25, 15],
];

/* ------------------------------------------------------------------------ *
 * Helper extractors
 * ------------------------------------------------------------------------ */

function cagr(result: { windowYears: number; cagrPct: number | null }[], window: number): number | null {
  const p = result.find((c) => c.windowYears === window);
  return p && isNum(p.cagrPct) ? p.cagrPct : null;
}

/** 5y CAGR, falling back to 3y then 1y. */
function bestCagr(rows: { windowYears: number; cagrPct: number | null }[]): number | null {
  return cagr(rows, 5) ?? cagr(rows, 3) ?? cagr(rows, 1);
}

/** Latest non-null margin from an oldest→newest series. */
function latestMarginPct(series: { pct: number | null }[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (isNum(series[i].pct)) return series[i].pct;
  }
  return null;
}

/** Own-history percentile of a named multiple (valuation, any route). */
function multiplePercentile(valuation: ValuationResult, keys: string[]): number | null {
  if (valuation.kind === "pre-revenue") return null;
  const stats = valuation.multiples?.multiples ?? [];
  for (const key of keys) {
    const stat = stats.find((m) => m.key === key);
    const pr = stat?.ownHistory?.percentileRank;
    if (isNum(pr)) return pr;
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * Composite weight vectors (route-adjusted; each sums to 100)
 * ------------------------------------------------------------------------ */

type WeightVector = Record<ScoreAspect, number>;

const WEIGHTS_GENERAL: WeightVector = {
  fundamentals: 20,
  valuation: 20,
  quality: 15,
  balanceSheet: 15,
  moat: 15,
  leadership: 10,
  technicals: 5,
};
// Financials: balance sheet is capital-adequacy (not net-debt) and we don't
// compute it, so it usually drops out — tilt toward quality/valuation.
const WEIGHTS_FINANCIAL: WeightVector = {
  fundamentals: 15,
  valuation: 22,
  quality: 26,
  balanceSheet: 10,
  moat: 15,
  leadership: 7,
  technicals: 5,
};
const WEIGHTS_REIT: WeightVector = {
  fundamentals: 15,
  valuation: 25,
  quality: 15,
  balanceSheet: 15,
  moat: 15,
  leadership: 10,
  technicals: 5,
};

function weightsForRoute(route: CompanyRouteResult): WeightVector {
  switch (route.base) {
    case "bank":
    case "insurer":
    case "reit-mortgage":
      return WEIGHTS_FINANCIAL;
    case "reit":
      return WEIGHTS_REIT;
    default:
      return WEIGHTS_GENERAL;
  }
}

/* ------------------------------------------------------------------------ *
 * computeScores — the public entry point
 * ------------------------------------------------------------------------ */

export interface ScoringInputs {
  route: CompanyRouteResult;
  policy: MetricPolicy;
  growth: GrowthResult;
  roic: RoicResult;
  roicVsWacc: RoicVsWaccSpread;
  wacc: WaccResult;
  capital: CapitalResult;
  forensics: ForensicsReport;
  technicals: TechnicalsResult;
  valuation: ValuationResult;
  /** Latest quote price (for DCF upside); null when unavailable. */
  currentPrice: number | null;
  /** Fallback as-of (bundle builtAt slice) for drivers lacking their own. */
  asOf: string;
}

export function computeScores(inputs: ScoringInputs): Scoring {
  const { route, policy, growth, roic, roicVsWacc, capital, forensics, technicals, valuation } = inputs;
  const weights = weightsForRoute(route);
  const financial = route.base === "bank" || route.base === "insurer" || route.base === "reit-mortgage";

  // --- Fundamentals --------------------------------------------------------
  const fundamentals = scoreAspect(
    "fundamentals",
    [
      { name: "revenueCagr", raw: bestCagr(growth.revenueCagrs), unit: "%", weight: 0.35, band: CAGR_BAND },
      { name: "operatingMarginSlope", raw: growth.margins.operating.slopePctPtsPerYear, unit: "pp/yr", weight: 0.3, band: MARGIN_SLOPE_BAND },
      // GAAP EPS growth is suppressed on routes where it is non-economic (REITs:
      // real-estate depreciation swamps net income, so FFO/AFFO growth leads).
      // Tagged so the route policy drops it instead of scoring fundamentals on a
      // metric the policy forbids displaying.
      { name: "epsCagr", raw: bestCagr(growth.epsDilutedCagrs), unit: "%", weight: 0.2, band: CAGR_BAND, suppressedBy: "epsGrowth" },
      { name: "fcfCagr", raw: bestCagr(growth.fcfCagrs), unit: "%", weight: 0.15, band: CAGR_BAND },
    ],
    weights.fundamentals,
    inputs.asOf,
    "Growth + margin trajectory: revenue/EPS/FCF CAGRs and operating-margin slope. EPS CAGR is dropped where the route suppresses GAAP EPS growth (REITs).",
    policy,
  );

  // --- Valuation (route-aware) --------------------------------------------
  const valuationSignals: Signal[] = [];
  if (valuation.kind === "dcf") {
    const perShare = valuation.dcf?.perShare ?? null;
    const upside =
      isNum(perShare) && isNum(inputs.currentPrice) && inputs.currentPrice > 0
        ? (perShare / inputs.currentPrice - 1) * 100
        : null;
    valuationSignals.push({ name: "dcfUpside", raw: upside, unit: "%", weight: 0.4, band: UPSIDE_BAND, suppressedBy: "fcfDcf" });
    const impliedG = valuation.reverseDcf?.impliedRevenueGrowthPct ?? null;
    const achievable = bestCagr(growth.revenueCagrs);
    const impliedVsAchievable = isNum(impliedG) && isNum(achievable) ? impliedG - achievable : null;
    valuationSignals.push({ name: "reverseImpliedVsAchievable", raw: impliedVsAchievable, unit: "pp", weight: 0.3, band: IMPLIED_VS_ACHIEVABLE_BAND, suppressedBy: "fcfDcf" });
    valuationSignals.push({ name: "peOwnPercentile", raw: multiplePercentile(valuation, ["peTtm", "evToEbitda", "priceToFcf"]), unit: "pctile", weight: 0.3, band: MULTIPLE_PERCENTILE_BAND });
  } else if (valuation.kind === "excess-return") {
    const cur = valuation.excessReturn?.roePathPct?.value?.[0] ?? null; // current/achievable ROE (path start)
    const implied = valuation.excessReturn?.reverseSolve?.impliedSteadyRoePct ?? null;
    // Match IMPLIED_VS_ACHIEVABLE_BAND's convention: (market-implied − achievable).
    // When the market implies a LOWER steady-state ROE than the bank actually
    // earns, it is too pessimistic ⇒ cheap ⇒ high score (negative input → high).
    const impliedVsAchievable = isNum(cur) && isNum(implied) ? implied - cur : null;
    valuationSignals.push({ name: "roeImpliedVsAchievable", raw: impliedVsAchievable, unit: "pp", weight: 0.5, band: IMPLIED_VS_ACHIEVABLE_BAND });
    valuationSignals.push({ name: "priceToTbvPercentile", raw: multiplePercentile(valuation, ["priceToTbv", "priceToBook"]), unit: "pctile", weight: 0.5, band: MULTIPLE_PERCENTILE_BAND });
  } else if (valuation.kind === "reit") {
    valuationSignals.push({ name: "pFfoPercentile", raw: multiplePercentile(valuation, ["priceToFfo", "priceToAffo"]), unit: "pctile", weight: 1.0, band: MULTIPLE_PERCENTILE_BAND });
  } else if (valuation.kind === "dcf-suppressed") {
    // Mirror the "dcf" branch's signal shape so dataCompleteness matches the
    // unprofitable overlay's actual scoring behavior from before this fix:
    // dcfUpside/reverseImpliedVsAchievable still count toward totalWeight but
    // are excluded via suppressedBy (no dcf/reverseDcf object exists to source
    // them from), so only peOwnPercentile actually scores — same math as the
    // "dcf" branch already produced for unprofitable-overlay routes.
    valuationSignals.push({ name: "dcfUpside", raw: null, unit: "%", weight: 0.4, band: UPSIDE_BAND, suppressedBy: "fcfDcf" });
    valuationSignals.push({ name: "reverseImpliedVsAchievable", raw: null, unit: "pp", weight: 0.3, band: IMPLIED_VS_ACHIEVABLE_BAND, suppressedBy: "fcfDcf" });
    valuationSignals.push({ name: "peOwnPercentile", raw: multiplePercentile(valuation, ["peTtm", "evToEbitda", "priceToFcf"]), unit: "pctile", weight: 0.3, band: MULTIPLE_PERCENTILE_BAND });
  }
  const valuationScore =
    valuation.kind === "pre-revenue"
      ? scoreAspect("valuation", [], weights.valuation, inputs.asOf, "Valuation not modelled for pre-revenue companies (runway framing instead).", policy, "Pre-revenue: no meaningful intrinsic-value model.")
      : scoreAspect(
          "valuation",
          valuationSignals,
          weights.valuation,
          inputs.asOf,
          "Attractiveness vs intrinsic value: DCF upside, reverse-DCF implied vs achievable growth, and multiple percentile.",
          policy,
        );

  // --- Quality (value creation + accounting integrity) --------------------
  const piotroskiFrac =
    forensics.piotroski && isNum(forensics.piotroski.score) && forensics.piotroski.outOf > 0
      ? forensics.piotroski.score / forensics.piotroski.outOf
      : null;
  const quality = scoreAspect(
    "quality",
    [
      { name: "roicVsWaccSpread", raw: roicVsWacc.spreadPctPts, unit: "pp", weight: 0.35, band: SPREAD_BAND },
      { name: "piotroskiF", raw: piotroskiFrac, unit: "frac", weight: 0.22, band: PIOTROSKI_BAND, suppressedBy: "piotroskiF" },
      { name: "altmanZ", raw: forensics.altman && isNum(forensics.altman.score) ? normalizeAltmanForBanding(forensics.altman.score, forensics.altman.variant) : null, unit: "z", weight: 0.16, band: ALTMAN_Z_BAND, suppressedBy: "altmanZ" },
      { name: "accrualsRatioAbs", raw: forensics.accruals && isNum(forensics.accruals.cashFlowAccrualRatio) ? Math.abs(forensics.accruals.cashFlowAccrualRatio) : null, unit: "frac", weight: 0.15, band: ACCRUALS_ABS_BAND },
      { name: "beneishM", raw: forensics.beneish?.score ?? null, unit: "m", weight: 0.12, band: BENEISH_M_BAND, suppressedBy: "beneishM" },
    ],
    weights.quality,
    inputs.asOf,
    "Value creation (ROIC−WACC) and accounting integrity (Piotroski, Altman, accruals, Beneish).",
    policy,
  );

  // --- Balance sheet & capital --------------------------------------------
  const balanceSheet = financial
    ? scoreAspect("balanceSheet", [], weights.balanceSheet, inputs.asOf, "Balance-sheet strength for financials is capital-adequacy (CET1/leverage), not net-debt — not modelled in v1.", policy, "Financial route: net-debt/coverage framing not meaningful; capital adequacy not computed.")
    : scoreAspect(
        "balanceSheet",
        [
          { name: "netDebtToEbitda", raw: capital.netDebtToEbitda.value, unit: "x", weight: 0.3, band: NET_DEBT_EBITDA_BAND, suppressedBy: "netDebtToEbitda" },
          { name: "interestCoverage", raw: capital.interestCoverage.value, unit: "x", weight: 0.2, band: COVERAGE_BAND },
          { name: "fcfConversion", raw: capital.fcf.latestConversion, unit: "frac", weight: 0.2, band: FCF_CONVERSION_BAND },
          { name: "sbcPctOfFcf", raw: capital.sbc.pctOfFcf, unit: "%", weight: 0.15, band: SBC_FCF_BAND },
          { name: "shareCountTrend", raw: capital.shareCount.annualizedPct, unit: "%", weight: 0.15, band: SHARE_TREND_BAND },
        ],
        weights.balanceSheet,
        inputs.asOf,
        "Financial strength: leverage, coverage, FCF conversion, dilution, and buyback cadence.",
        policy,
      );

  // --- Moat (durability proxy: ROIC level + stability + gross margin) ------
  const roicStdev = stdev(roic.series.map((r) => r.roicPct).filter(isNum));
  const moat = scoreAspect(
    "moat",
    [
      { name: "roicLevel", raw: roic.latestRoicPct, unit: "%", weight: 0.45, band: ROIC_LEVEL_BAND },
      { name: "roicStability", raw: roicStdev, unit: "pp", weight: 0.3, band: ROIC_STABILITY_BAND },
      // Gross margin is a hard-suppressed metric on some routes (banks: FMP emits
      // garbage revenue−costOfRevenue on an interest-income statement; pre-revenue:
      // no meaningful revenue base). Tagged so the route policy drops this signal
      // rather than scoring moat on a number the policy forbids displaying — a bank
      // with no ROIC framing then reads moat as not-applicable, not a garbage grade.
      { name: "grossMarginLevel", raw: latestMarginPct(growth.margins.gross.series), unit: "%", weight: 0.25, band: GROSS_MARGIN_BAND, suppressedBy: "grossMargin" },
    ],
    weights.moat,
    inputs.asOf,
    "Quantitative moat proxy: level and durability of ROIC plus gross-margin (pricing-power) level. Gross margin is dropped where the route suppresses it (banks, pre-revenue).",
    policy,
  );

  // --- Leadership (deterministic capital-stewardship proxy) ----------------
  const leadership = scoreAspect(
    "leadership",
    [
      { name: "buybackDiscipline", raw: capital.buybackPriceAnalysis.premiumDiscountPct, unit: "%", weight: 0.3, band: BUYBACK_DISCIPLINE_BAND },
      { name: "capitalDeployment", raw: roicVsWacc.spreadPctPts, unit: "pp", weight: 0.25, band: SPREAD_BAND },
      { name: "shareCountTrend", raw: capital.shareCount.annualizedPct, unit: "%", weight: 0.25, band: SHARE_TREND_BAND },
      { name: "sbcPctOfRevenue", raw: capital.sbc.pctOfRevenue, unit: "%", weight: 0.2, band: SBC_REV_BAND },
    ],
    weights.leadership,
    inputs.asOf,
    "Capital-stewardship proxy (buyback discipline, capital deployment above cost, dilution). Qualitative leadership assessed in the analyst grade.",
    policy,
  );

  // --- Technicals ----------------------------------------------------------
  const smaGap =
    isNum(technicals.smaCross.sma50) && isNum(technicals.smaCross.sma200) && technicals.smaCross.sma200 > 0
      ? (technicals.smaCross.sma50 / technicals.smaCross.sma200 - 1) * 100
      : null;
  const rs6 = technicals.relativeStrength.benchmark.points.find((p) => p.months === 6)?.differentialPctPoints ?? null;
  const technicalsScore = scoreAspect(
    "technicals",
    [
      { name: "smaGap", raw: smaGap, unit: "%", weight: 0.25, band: SMA_GAP_BAND },
      { name: "rsi14", raw: technicals.rsi14, unit: "rsi", weight: 0.2, band: RSI_BAND },
      { name: "position52w", raw: technicals.range52w.positionPct, unit: "%", weight: 0.25, band: POSITION_BAND },
      { name: "relStrength6m", raw: rs6, unit: "pp", weight: 0.3, band: REL_STRENGTH_BAND },
    ],
    weights.technicals,
    inputs.asOf,
    "Trend + momentum: SMA50/200 gap, RSI-14, 52-week position, 6-month relative strength vs SPY.",
    policy,
  );

  const scored = {
    fundamentals,
    valuation: valuationScore,
    quality,
    balanceSheet,
    moat,
    leadership,
    technicals: technicalsScore,
  } satisfies Record<ScoreAspect, ScoredAspect>;

  const aspects = {
    fundamentals: fundamentals.aspect,
    valuation: valuationScore.aspect,
    quality: quality.aspect,
    balanceSheet: balanceSheet.aspect,
    moat: moat.aspect,
    leadership: leadership.aspect,
    technicals: technicalsScore.aspect,
  } satisfies Record<ScoreAspect, AspectScore>;

  // --- Composite: completeness-weighted mean over aspects with a score -----
  // Each aspect enters at route weight × its OWN data completeness, so an aspect
  // scored on a fraction of its intended signals influences the composite in
  // proportion to the data behind it — a well-supported aspect dominates a thin
  // one, instead of the old behaviour where a 20%-sourced aspect carried full
  // weight. The unsupported composite fraction is then regularized to neutral,
  // preventing sparse-but-favorable data from producing an extreme grade.
  //
  // `compWeight` is the evidence actually behind the composite. `maxCompWeight`
  // is the MOST evidence this ROUTE could ever supply — the sum of each aspect's
  // route-applicable weight (route weight × non-suppressed signal fraction),
  // EXCLUDING aspects that are inapplicable to the route entirely. Shrinkage is
  // measured against that route-applicable ceiling, NOT a fixed 100: a metric
  // that is meaningless for the route (a bank's Altman/Beneish/net-debt, a
  // pre-revenue company's DCF) is not missing evidence, so a fully-observed
  // bank/REIT is not structurally capped below A. Genuinely-absent applicable
  // data still shrinks the grade, because it lowers compWeight below the ceiling.
  let compAcc = 0;
  let compWeight = 0;
  let maxCompWeight = 0;
  for (const key of Object.keys(scored) as ScoreAspect[]) {
    const sc = scored[key];
    if (!sc.routeInapplicable) {
      // Route-applicable ceiling: full route weight scaled by the fraction of
      // this aspect's signal weight the route does not suppress.
      maxCompWeight += weights[key] * (sc.applicableWeight / sc.totalWeight);
    }
    if (sc.aspect.score !== null) {
      const eff = weights[key] * sc.aspect.dataCompleteness;
      compAcc += sc.aspect.score * eff;
      compWeight += eff;
    }
  }
  const rawCompositeScore = compWeight > 0 ? compAcc / compWeight : null;
  // Completeness is measured over ROUTE-APPLICABLE evidence (ceiling), so a
  // fully-observed company on ANY route shrinks by 0. Guard the empty ceiling.
  const overallCompleteness = maxCompWeight > 0 ? Math.min(1, compWeight / maxCompWeight) : 0;
  // Missing evidence is uncertainty, not evidence that the remaining favorable
  // signals deserve an extreme grade. Shrink only the unsupported fraction to
  // the neutral midpoint; a fully observed company (for its route) is unchanged.
  const compositeScore = rawCompositeScore !== null
    ? round2(50 + (rawCompositeScore - 50) * overallCompleteness)
    : null;

  return {
    aspects,
    composite: {
      score: compositeScore,
      band: compositeScore !== null ? scoreToBand(compositeScore) : null,
      weights,
      methodology:
        `Route-adjusted, completeness-weighted mean of the seven aspect scores: each aspect enters at route weight × data completeness. The unsupported fraction is then shrunk to the neutral midpoint (50); completeness ${round2(overallCompleteness * 100)}% is measured over route-applicable evidence (metrics the route suppresses or that are meaningless for it are excluded, not counted as missing). Fully observed scores are unchanged on any route, while sparse favorable data cannot create an extreme grade. Bands remain versioned house rules pending outcome backtesting.`,
    },
    bandsVersion: SCORE_BANDS_VERSION,
  };
}
