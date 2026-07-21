/**
 * Stage B — Returns: WACC build, ROIC series, DuPont decomposition,
 * ROIC-vs-WACC spread.
 *
 * Pure, deterministic TypeScript: no network, no DB, no LLM (the application contract §4).
 * WACC methodology per the valuation methodology §1 (Damodaran-standard):
 * - Re = rf (FRED DGS10) + Blume beta (0.67·raw + 0.33, clamped [0.6, 2.0]) × ERP
 *   (FMP market-risk-premium, dated Damodaran US implied-ERP fallback);
 *   Re clamped [rf + 2.5, 25].
 * - Rd = TTM interest expense / avg total debt, accepted in [rf − 1, rf + 19],
 *   else synthetic rating via interest coverage → SPREADS_2026_01.
 * - Missing or implausible beta, debt, or interest inputs fail closed instead
 *   of manufacturing a capital structure, credit rating, or market exposure.
 * - The observed effective-tax rate is clamped [0, 35%]. The DCF uses company
 *   history for its terminal tax anchor and suppresses when none is available.
 * - WACC clamped [max(6, rf + 1), 20].
 *
 * All rates in this module are PERCENT units (4.48 = 4.48%) except tax rates,
 * which are fractions (0.21 = 21%) matching FMP's ratios.effectiveTaxRate.
 * Missing inputs never throw — nullable outputs + ManifestEntry-compatible gaps.
 * Every clamp that fires is recorded in clampsApplied[]; every method choice
 * and house rule in notes[]. Full precision returned; round at display time.
 */

import type { ManifestEntry } from "@/types/core";
import { isFiniteNumber, sortNewestFirst } from "@/pipeline/stageB/growth";

// ---------------------------------------------------------------------------
// SPREADS_2026_01 — Damodaran synthetic-rating spread table (verbatim)
// Source: pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/ratings.html
// "Date of Analysis: January 2026" — fetched 2026-07-05 (the valuation methodology §1.4).
// ---------------------------------------------------------------------------

export interface RatingSpreadBand {
  /** Inclusive lower ICR bound (−Infinity for the bottom band). */
  minIcr: number;
  /** Inclusive upper ICR bound, verbatim from the table (+Infinity for the top band). */
  maxIcr: number;
  rating: string;
  /** Default spread in percent (19.00 = 19%). */
  spreadPct: number;
}

export interface SyntheticSpreadTable {
  source: string;
  dateOfAnalysis: string;
  /** Large non-financial firms table. */
  nonFinancial: readonly RatingSpreadBand[];
  /** Financial-service firms table (tighter ICR brackets). */
  financial: readonly RatingSpreadBand[];
}

export const SPREADS_2026_01: SyntheticSpreadTable = {
  source: "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/ratings.html",
  dateOfAnalysis: "January 2026",
  nonFinancial: [
    { minIcr: Number.NEGATIVE_INFINITY, maxIcr: 0.199999, rating: "D2/D", spreadPct: 19.0 },
    { minIcr: 0.2, maxIcr: 0.649999, rating: "C2/C", spreadPct: 16.0 },
    { minIcr: 0.65, maxIcr: 0.799999, rating: "Ca2/CC", spreadPct: 12.61 },
    { minIcr: 0.8, maxIcr: 1.249999, rating: "Caa/CCC", spreadPct: 8.85 },
    { minIcr: 1.25, maxIcr: 1.499999, rating: "B3/B−", spreadPct: 5.09 },
    { minIcr: 1.5, maxIcr: 1.749999, rating: "B2/B", spreadPct: 3.21 },
    { minIcr: 1.75, maxIcr: 1.999999, rating: "B1/B+", spreadPct: 2.75 },
    { minIcr: 2, maxIcr: 2.2499999, rating: "Ba2/BB", spreadPct: 1.84 },
    { minIcr: 2.25, maxIcr: 2.49999, rating: "Ba1/BB+", spreadPct: 1.38 },
    { minIcr: 2.5, maxIcr: 2.999999, rating: "Baa2/BBB", spreadPct: 1.11 },
    { minIcr: 3, maxIcr: 4.249999, rating: "A3/A−", spreadPct: 0.89 },
    { minIcr: 4.25, maxIcr: 5.499999, rating: "A2/A", spreadPct: 0.78 },
    { minIcr: 5.5, maxIcr: 6.499999, rating: "A1/A+", spreadPct: 0.7 },
    { minIcr: 6.5, maxIcr: 8.499999, rating: "Aa2/AA", spreadPct: 0.55 },
    { minIcr: 8.5, maxIcr: Number.POSITIVE_INFINITY, rating: "Aaa/AAA", spreadPct: 0.4 },
  ],
  financial: [
    { minIcr: Number.NEGATIVE_INFINITY, maxIcr: 0.049999, rating: "D2/D", spreadPct: 19.0 },
    { minIcr: 0.05, maxIcr: 0.099999, rating: "C2/C", spreadPct: 16.0 },
    { minIcr: 0.1, maxIcr: 0.199999, rating: "Ca2/CC", spreadPct: 12.61 },
    { minIcr: 0.2, maxIcr: 0.299999, rating: "Caa/CCC", spreadPct: 8.85 },
    { minIcr: 0.3, maxIcr: 0.399999, rating: "B3/B−", spreadPct: 5.09 },
    { minIcr: 0.4, maxIcr: 0.499999, rating: "B2/B", spreadPct: 3.21 },
    { minIcr: 0.5, maxIcr: 0.599999, rating: "B1/B+", spreadPct: 2.75 },
    { minIcr: 0.6, maxIcr: 0.749999, rating: "Ba2/BB", spreadPct: 1.84 },
    { minIcr: 0.75, maxIcr: 0.899999, rating: "Ba1/BB+", spreadPct: 1.38 },
    { minIcr: 0.9, maxIcr: 1.199999, rating: "Baa2/BBB", spreadPct: 1.11 },
    { minIcr: 1.2, maxIcr: 1.49999, rating: "A3/A−", spreadPct: 0.89 },
    { minIcr: 1.5, maxIcr: 1.99999, rating: "A2/A", spreadPct: 0.78 },
    { minIcr: 2, maxIcr: 2.49999, rating: "A1/A+", spreadPct: 0.7 },
    { minIcr: 2.5, maxIcr: 2.99999, rating: "Aa2/AA", spreadPct: 0.55 },
    { minIcr: 3, maxIcr: Number.POSITIVE_INFINITY, rating: "Aaa/AAA", spreadPct: 0.4 },
  ],
};

export type SpreadTableVariant = "nonFinancial" | "financial";

/**
 * ICR → rating band lookup. Values landing in the micro-gaps between verbatim
 * bounds (e.g. 0.1999995) resolve to the band below (last band whose minIcr ≤ icr).
 */
export function lookupSyntheticSpread(
  icr: number,
  variant: SpreadTableVariant = "nonFinancial",
): RatingSpreadBand {
  const bands = SPREADS_2026_01[variant];
  let match: RatingSpreadBand = bands[0];
  for (const band of bands) {
    if (icr >= band.minIcr) match = band;
  }
  return match;
}

// ---------------------------------------------------------------------------
// WACC constants (house rules per the valuation methodology §1)
// ---------------------------------------------------------------------------

/** Latest reviewed Damodaran US implied ERP fallback. Update value and date together. */
export const ERP_FALLBACK = Object.freeze({
  pct: 4.18,
  asOf: "2026-07-01",
  source: "Damodaran implied ERP (trailing 12-month adjusted payout)",
});
export const ERP_FALLBACK_PCT = ERP_FALLBACK.pct;
/** Maximum age of the static fallback; allows the published semiannual update cadence plus a short release buffer. */
export const ERP_FALLBACK_MAX_AGE_DAYS = 210;
/** ERP plausibility band (percent) outside which the fallback is used. */
export const ERP_PLAUSIBLE_PCT: readonly [number, number] = [3, 25];
/** Blume adjustment toward 1: beta_adj = 0.67·raw + 0.33. */
export const BLUME_RAW_WEIGHT = 0.67;
export const BLUME_MEAN_WEIGHT = 0.33;
export const BETA_CLAMP: readonly [number, number] = [0.6, 2.0];
/** Raw beta outside (0, 4] is treated as unusable; WACC fails closed. */
export const BETA_RAW_MAX = 4;
/** Cost-of-equity clamp: [rf + RE_FLOOR_OVER_RF, RE_CEILING_PCT] (percent). */
export const RE_FLOOR_OVER_RF_PCT = 2.5;
export const RE_CEILING_PCT = 25;
/** Effective-Rd acceptance band around rf: [rf − 1, rf + 19] (percent). */
export const RD_BAND_BELOW_RF_PCT = 1;
export const RD_BAND_ABOVE_RF_PCT = 19;
/** Debt below this share of total assets is de-minimis — effective Rd is noise. */
export const DE_MINIMIS_DEBT_TO_ASSETS = 0.02;
/** Effective tax rate clamp (fraction). */
export const TAX_CLAMP: readonly [number, number] = [0, 0.35];
/** WACC clamp: [max(6, rf + 1), 20] (percent). */
export const WACC_FLOOR_ABS_PCT = 6;
export const WACC_FLOOR_OVER_RF_PCT = 1;
export const WACC_CEILING_PCT = 20;
/**
 * A WACC clamp is disclosed as a manifest warn when it moves the rate by at
 * least this many percentage points (audit 2026-07-11 #5). Below this, a barely
 * biting floor/ceiling is not a data-quality problem and would only dilute the
 * manifest; the clamp is still recorded in clampsApplied either way.
 */
export const WACC_MATERIAL_CLAMP_PP = 0.5;
/** Synthetic spreads at/above this level (B2/B = 3.21) get a distress warning. */
export const DISTRESS_SPREAD_WARN_PCT = 3.21;

// ---------------------------------------------------------------------------
// computeWacc
// ---------------------------------------------------------------------------

export interface WaccInputs {
  /** Raw levered beta (FMP profile.beta). */
  beta: number | null;
  /** Risk-free rate in percent, from FRED DGS10 (e.g. 4.48). */
  riskFreePct: number | null;
  /** Equity risk premium in percent (FMP US market-risk-premium totalEquityRiskPremium). */
  erpPct: number | null;
  /** TTM interest expense (currency units). FMP zero-for-undisclosed handled here. */
  interestExpenseTtm: number | null;
  /** Average of the latest two totalDebt balances (currency units). */
  totalDebtAvg: number | null;
  /** Raw invalid observation, kept separate so it cannot be hidden by averaging. */
  negativeTotalDebtObservation?: number | null;
  /** Current market cap (currency units) — market-value equity weight. */
  marketCap: number | null;
  /** Effective tax rate as a FRACTION (FMP ratios.effectiveTaxRate, e.g. 0.183). */
  effectiveTaxRate: number | null;
  /** TTM EBIT (operating income) for the synthetic-rating ICR. */
  ebitTtm: number | null;
  /** ISO analysis date used only to enforce the dated ERP fallback's freshness. */
  analysisDate?: string;
  /** Use the financial-service spread table (banks/insurers/capital markets). Default false. */
  isFinancial?: boolean;
  /** Latest totalAssets — enables the 2%-of-assets de-minimis debt test when provided. */
  totalAssets?: number | null;
  /** Optional provenance passthrough (as-of dates of the inputs), echoed in the result. */
  asOf?: { riskFreeRate?: string; statements?: string; marketCap?: string };
}

export type CostOfDebtMethod = "effective" | "synthetic" | "none" | "unavailable";

export interface WaccResult {
  /** Final WACC in percent (clamped). Null when rf or weights are unavailable. */
  waccPct: number | null;
  /** Pre-clamp WACC in percent. */
  waccRawPct: number | null;
  costOfEquityPct: number | null;
  /** After-tax adjustment is applied inside WACC; this is the pre-tax Rd in percent. */
  costOfDebtPct: number | null;
  costOfDebtMethod: CostOfDebtMethod;
  syntheticRating: string | null;
  syntheticSpreadPct: number | null;
  /** EBIT_TTM / interestExpense_TTM used for the synthetic rating (null when not computed). */
  interestCoverageRatio: number | null;
  betaRaw: number | null;
  betaAdjusted: number | null;
  betaFinal: number | null;
  riskFreePct: number | null;
  /** ERP actually used (input or current fallback), percent. */
  erpPct: number | null;
  /** Observed effective tax rate used for the debt tax shield (clamped fraction). */
  taxRateUsed: number | null;
  weightEquity: number | null;
  weightDebt: number | null;
  /** Method choices, fallbacks, house rules. */
  notes: string[];
  /** Every clamp that fired, with before → after values. */
  clampsApplied: string[];
  gaps: ManifestEntry[];
  asOf?: { riskFreeRate?: string; statements?: string; marketCap?: string };
}

function fmt(n: number): string {
  return String(Number(n.toFixed(4)));
}

function isoDayEpoch(v: string | undefined): number | null {
  if (v === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const epoch = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(epoch) ? epoch : null;
}

export function computeWacc(inputs: WaccInputs): WaccResult {
  const notes: string[] = [];
  const clampsApplied: string[] = [];
  const gaps: ManifestEntry[] = [];
  const variant: SpreadTableVariant = inputs.isFinancial ? "financial" : "nonFinancial";

  // --- Beta: raw → Blume → clamp; fail closed if unavailable ------------------
  const betaRaw = isFiniteNumber(inputs.beta) ? inputs.beta : null;
  let betaAdjusted: number | null = null;
  let betaFinal: number | null = null;
  if (betaRaw === null || betaRaw <= 0 || betaRaw > BETA_RAW_MAX) {
    notes.push(
      `cost of equity unavailable (raw beta ${betaRaw === null ? "missing" : fmt(betaRaw)} is null/≤0/>${BETA_RAW_MAX})`,
    );
    // Disclose the missing→meaningful substitution in the manifest (not just a
    // note), so it reaches the appendix and can inform confidence (audit
    // 2026-07-11 #5). Beta is material to the cost of equity and thus the DCF.
    gaps.push({
      field: "returns.wacc.beta",
      reason: `raw beta ${
        betaRaw === null ? "missing" : `${fmt(betaRaw)} implausible (≤0 or >${BETA_RAW_MAX})`
      } — no evidence-backed sector beta was available, so cost of equity and WACC were suppressed`,
      severity: "critical",
    });
  } else {
    betaAdjusted = BLUME_RAW_WEIGHT * betaRaw + BLUME_MEAN_WEIGHT;
    notes.push(`Blume adjustment: beta_adj = ${BLUME_RAW_WEIGHT}·raw + ${BLUME_MEAN_WEIGHT}`);
    betaFinal = betaAdjusted;
    if (betaFinal < BETA_CLAMP[0]) {
      clampsApplied.push(`beta clamped ${fmt(betaFinal)} → ${BETA_CLAMP[0]} (floor)`);
      betaFinal = BETA_CLAMP[0];
    } else if (betaFinal > BETA_CLAMP[1]) {
      clampsApplied.push(`beta clamped ${fmt(betaFinal)} → ${BETA_CLAMP[1]} (ceiling)`);
      betaFinal = BETA_CLAMP[1];
    }
  }

  // --- ERP: observed US value or freshness-gated Damodaran fallback -----------
  let erpPct: number | null;
  if (
    isFiniteNumber(inputs.erpPct) &&
    inputs.erpPct >= ERP_PLAUSIBLE_PCT[0] &&
    inputs.erpPct <= ERP_PLAUSIBLE_PCT[1]
  ) {
    erpPct = inputs.erpPct;
  } else {
    const analysisEpoch = isoDayEpoch(inputs.analysisDate);
    const fallbackEpoch = isoDayEpoch(ERP_FALLBACK.asOf) as number;
    const fallbackAgeDays = analysisEpoch === null
      ? null
      : Math.floor((analysisEpoch - fallbackEpoch) / 86_400_000);
    const fallbackCurrent =
      fallbackAgeDays !== null && fallbackAgeDays >= 0 && fallbackAgeDays <= ERP_FALLBACK_MAX_AGE_DAYS;
    const inputReason = isFiniteNumber(inputs.erpPct)
      ? `${fmt(inputs.erpPct)}% outside plausibility band [${ERP_PLAUSIBLE_PCT[0]}, ${ERP_PLAUSIBLE_PCT[1]}]%`
      : "missing";

    if (fallbackCurrent) {
      erpPct = ERP_FALLBACK_PCT;
      notes.push(
        `ERP fallback ${ERP_FALLBACK_PCT}% used (${ERP_FALLBACK.source}, as of ${ERP_FALLBACK.asOf}) — input ${inputReason}`,
      );
      gaps.push({
        field: "returns.wacc.erp",
        reason: `equity risk premium ${inputReason} — dated Damodaran ${ERP_FALLBACK_PCT}% fallback used for the cost of equity`,
        severity: "info",
      });
    } else {
      erpPct = null;
      const freshnessReason = fallbackAgeDays === null
        ? "analysis date missing or invalid"
        : fallbackAgeDays < 0
          ? `fallback post-dates analysis by ${Math.abs(fallbackAgeDays)} days`
          : `fallback is ${fallbackAgeDays} days old (limit ${ERP_FALLBACK_MAX_AGE_DAYS})`;
      notes.push(`ERP unavailable — ${inputReason}; static fallback rejected because ${freshnessReason}`);
      gaps.push({
        field: "returns.wacc.erp",
        reason: `equity risk premium ${inputReason}; ${ERP_FALLBACK.asOf} static fallback rejected because ${freshnessReason} — cost of equity and WACC not computed`,
        severity: "critical",
      });
    }
  }

  // --- Tax rate ----------------------------------------------------------------
  let taxRateUsed: number | null;
  if (isFiniteNumber(inputs.effectiveTaxRate)) {
    taxRateUsed = inputs.effectiveTaxRate;
    if (taxRateUsed < TAX_CLAMP[0]) {
      clampsApplied.push(`tax rate clamped ${fmt(taxRateUsed)} → ${TAX_CLAMP[0]} (floor)`);
      taxRateUsed = TAX_CLAMP[0];
    } else if (taxRateUsed > TAX_CLAMP[1]) {
      clampsApplied.push(`tax rate clamped ${fmt(taxRateUsed)} → ${TAX_CLAMP[1]} (ceiling)`);
      taxRateUsed = TAX_CLAMP[1];
    }
  } else {
    taxRateUsed = null;
  }

  const base: Omit<
    WaccResult,
    "waccPct" | "waccRawPct" | "costOfEquityPct" | "costOfDebtPct" | "costOfDebtMethod" | "weightEquity" | "weightDebt"
  > = {
    syntheticRating: null,
    syntheticSpreadPct: null,
    interestCoverageRatio: null,
    betaRaw,
    betaAdjusted,
    betaFinal,
    riskFreePct: isFiniteNumber(inputs.riskFreePct) ? inputs.riskFreePct : null,
    erpPct,
    taxRateUsed,
    notes,
    clampsApplied,
    gaps,
    asOf: inputs.asOf,
  };

  // --- Risk-free rate is load-bearing ------------------------------------------
  if (!isFiniteNumber(inputs.riskFreePct)) {
    gaps.push({
      field: "returns.wacc",
      reason: "riskFreePct (FRED DGS10) missing — WACC not computable",
      severity: "critical",
      attemptedSources: ["fred:DGS10"],
    });
    return {
      ...base,
      waccPct: null,
      waccRawPct: null,
      costOfEquityPct: null,
      costOfDebtPct: null,
      costOfDebtMethod: "unavailable",
      weightEquity: null,
      weightDebt: null,
    };
  }
  const rf = inputs.riskFreePct;

  if (erpPct === null) {
    return {
      ...base,
      waccPct: null,
      waccRawPct: null,
      costOfEquityPct: null,
      costOfDebtPct: null,
      costOfDebtMethod: "unavailable",
      weightEquity: null,
      weightDebt: null,
    };
  }

  if (betaFinal === null) {
    return {
      ...base,
      waccPct: null,
      waccRawPct: null,
      costOfEquityPct: null,
      costOfDebtPct: null,
      costOfDebtMethod: "unavailable",
      weightEquity: null,
      weightDebt: null,
    };
  }

  // --- Cost of equity -----------------------------------------------------------
  let re = rf + betaFinal * erpPct;
  const reFloor = rf + RE_FLOOR_OVER_RF_PCT;
  if (re < reFloor) {
    clampsApplied.push(`cost of equity clamped ${fmt(re)}% → ${fmt(reFloor)}% (floor rf + ${RE_FLOOR_OVER_RF_PCT})`);
    re = reFloor;
  } else if (re > RE_CEILING_PCT) {
    clampsApplied.push(`cost of equity clamped ${fmt(re)}% → ${RE_CEILING_PCT}% (ceiling)`);
    re = RE_CEILING_PCT;
  }

  // --- Cost of debt --------------------------------------------------------------
  let costOfDebtPct: number | null = null;
  let costOfDebtMethod: CostOfDebtMethod = "none";
  let syntheticRating: string | null = null;
  let syntheticSpreadPct: number | null = null;
  let interestCoverageRatio: number | null = null;

  const debtAvg = isFiniteNumber(inputs.totalDebtAvg) ? inputs.totalDebtAvg : null;
  const negativeDebtObservation =
    isFiniteNumber(inputs.negativeTotalDebtObservation) && inputs.negativeTotalDebtObservation < 0
      ? inputs.negativeTotalDebtObservation
      : null;
  const hasDebt = debtAvg !== null && debtAvg > 0;
  if (negativeDebtObservation !== null) {
    notes.push("negative totalDebt observation — invalid capital-structure data; WACC unavailable");
    gaps.push({
      field: "returns.wacc.weights",
      reason: `negative total debt observation (${fmt(negativeDebtObservation)}) — invalid data cannot establish a debt-free capital structure`,
      severity: "critical",
    });
    return {
      ...base,
      waccPct: null,
      waccRawPct: null,
      costOfEquityPct: re,
      costOfDebtPct: null,
      costOfDebtMethod: "unavailable",
      weightEquity: null,
      weightDebt: null,
    };
  } else if (debtAvg === null) {
    notes.push("totalDebtAvg missing — debt/equity weights and WACC are unavailable");
    gaps.push({
      field: "returns.wacc.weights",
      reason: "average total debt missing — cannot distinguish debt-free from unknown leverage",
      severity: "critical",
    });
    return {
      ...base,
      waccPct: null,
      waccRawPct: null,
      costOfEquityPct: re,
      costOfDebtPct: null,
      costOfDebtMethod: "unavailable",
      weightEquity: null,
      weightDebt: null,
    };
  } else if (debtAvg < 0) {
    notes.push("totalDebtAvg is negative — invalid capital-structure data; WACC unavailable");
    gaps.push({
      field: "returns.wacc.weights",
      reason: `average total debt is negative (${fmt(debtAvg)}) — invalid data cannot establish a debt-free capital structure`,
      severity: "critical",
    });
    return {
      ...base,
      waccPct: null,
      waccRawPct: null,
      costOfEquityPct: re,
      costOfDebtPct: null,
      costOfDebtMethod: "unavailable",
      weightEquity: null,
      weightDebt: null,
    };
  } else if (debtAvg === 0) {
    notes.push("no debt (totalDebtAvg = 0) — WACC = cost of equity");
  }

  if (taxRateUsed === null) {
    if (hasDebt) {
      notes.push("effective tax rate unavailable — debt tax shield and WACC are unavailable");
      gaps.push({
        field: "returns.wacc.effectiveTaxRate",
        reason: "effective tax rate missing with debt outstanding — after-tax debt cost cannot be computed without inventing a tax shield",
        severity: "critical",
      });
    } else if (debtAvg !== null) {
      notes.push("effective tax rate unavailable but immaterial to debt-free WACC");
    }
  }

  if (hasDebt) {
    // FMP zero-for-undisclosed: interestExpense === 0 is implausible with real
    // debt, and a NEGATIVE figure (interest income netted, or a vendor sign flip —
    // the same data-quality class the code rejects for totalDebt) is invalid.
    // Neither can establish a cost of debt; only a positive figure is usable.
    const intExpRaw = isFiniteNumber(inputs.interestExpenseTtm) ? inputs.interestExpenseTtm : null;
    const intExp = intExpRaw !== null && intExpRaw > 0 ? intExpRaw : null;
    if (intExpRaw === null || intExpRaw <= 0) {
      const intExpNegative = intExpRaw !== null && intExpRaw < 0;
      // Basis-neutral wording: the caller may have passed the TTM figure OR the
      // annual fallback (compute.ts discloses which) — don't claim "Ttm" here.
      notes.push(
        intExpNegative
          ? `interest expense negative (${fmt(intExpRaw)}) with debt outstanding — implausible (interest income netted or vendor sign flip); cost of debt and WACC unavailable`
          : intExpRaw === 0
            ? "interest expense = 0 treated as undisclosed (FMP zero-for-undisclosed policy) — cost of debt and WACC unavailable"
            : "interest expense missing with debt outstanding — cost of debt and WACC unavailable",
      );
      gaps.push({
        field: "returns.wacc.interestExpense",
        reason: intExpNegative
          ? `interest expense negative (${fmt(intExpRaw)}) with debt outstanding — implausible sign; cost of debt cannot be inferred`
          : intExpRaw === 0
            ? "interest expense reported as 0 with debt outstanding — treated as undisclosed; cost of debt cannot be inferred"
            : "interest expense missing with debt outstanding — cost of debt cannot be inferred",
        severity: "critical",
      });
    }

    const rdBand: readonly [number, number] = [rf - RD_BAND_BELOW_RF_PCT, rf + RD_BAND_ABOVE_RF_PCT];
    const deMinimis =
      isFiniteNumber(inputs.totalAssets) &&
      inputs.totalAssets > 0 &&
      debtAvg < DE_MINIMIS_DEBT_TO_ASSETS * inputs.totalAssets;
    if (deMinimis) {
      notes.push(
        `debt < ${DE_MINIMIS_DEBT_TO_ASSETS * 100}% of total assets — effective Rd treated as noise, synthetic rating used`,
      );
    }

    const rdEffective = intExp !== null && intExp > 0 ? (intExp / debtAvg) * 100 : null;

    if (rdEffective !== null && !deMinimis && rdEffective >= rdBand[0] && rdEffective <= rdBand[1]) {
      costOfDebtPct = rdEffective;
      costOfDebtMethod = "effective";
      notes.push(
        `effective cost of debt ${fmt(rdEffective)}% accepted (band [rf − ${RD_BAND_BELOW_RF_PCT}, rf + ${RD_BAND_ABOVE_RF_PCT}] = [${fmt(rdBand[0])}, ${fmt(rdBand[1])}]%)`,
      );
    } else {
      if (rdEffective !== null && !deMinimis) {
        notes.push(
          `effective cost of debt ${fmt(rdEffective)}% outside acceptance band [${fmt(rdBand[0])}, ${fmt(rdBand[1])}]% — synthetic rating used`,
        );
      }
      // Synthetic rating requires a positive observed interest expense. Missing
      // or provider-placeholder zero cannot establish an infinite coverage
      // ratio and must not be converted into an AAA spread.
      if (intExp === null || intExp <= 0) {
        costOfDebtMethod = "unavailable";
      } else if (isFiniteNumber(inputs.ebitTtm)) {
        interestCoverageRatio = inputs.ebitTtm / intExp;
        const band = lookupSyntheticSpread(interestCoverageRatio, variant);
        costOfDebtPct = rf + band.spreadPct;
        costOfDebtMethod = "synthetic";
        syntheticRating = band.rating;
        syntheticSpreadPct = band.spreadPct;
        notes.push(
          `synthetic rating ${band.rating} from ICR ${fmt(interestCoverageRatio)} (${variant} table, SPREADS_2026_01 ${SPREADS_2026_01.dateOfAnalysis}) — Rd = rf + ${fmt(band.spreadPct)}%`,
        );
        if (band.spreadPct >= DISTRESS_SPREAD_WARN_PCT) {
          notes.push(
            `synthetic rating ${band.rating} ≤ B — book debt weights may understate distress (house warning)`,
          );
        }
      } else {
        // Effective rejected and no EBIT for the ICR: there is no defensible
        // basis for either accepting or synthetically replacing the rate.
        gaps.push({
          field: "returns.wacc.costOfDebt",
          reason: "effective cost of debt outside the acceptance band and ebitTtm missing — synthetic rating unavailable",
          severity: "critical",
        });
        costOfDebtMethod = "unavailable";
      }
    }
  }

  // --- Weights + final WACC -------------------------------------------------------
  const mcap = isFiniteNumber(inputs.marketCap) && inputs.marketCap > 0 ? inputs.marketCap : null;
  let weightEquity: number | null;
  let weightDebt: number | null;
  if (!hasDebt) {
    weightEquity = 1;
    weightDebt = 0;
    if (mcap === null) {
      notes.push("market cap unavailable but no debt — weights trivially 100% equity");
    }
  } else if (mcap === null) {
    gaps.push({
      field: "returns.wacc.weights",
      reason: "market cap missing with debt outstanding — E/D weights not computable",
      severity: "critical",
    });
    return {
      ...base,
      waccPct: null,
      waccRawPct: null,
      costOfEquityPct: re,
      costOfDebtPct,
      costOfDebtMethod,
      syntheticRating,
      syntheticSpreadPct,
      interestCoverageRatio,
      weightEquity: null,
      weightDebt: null,
    };
  } else {
    weightEquity = mcap / (mcap + debtAvg);
    weightDebt = debtAvg / (mcap + debtAvg);
    notes.push("debt weight uses book totalDebt (avg of latest two periods) as market-value proxy");
  }

  if (weightDebt > 0 && (costOfDebtPct === null || taxRateUsed === null)) {
    return {
      ...base,
      waccPct: null,
      waccRawPct: null,
      costOfEquityPct: re,
      costOfDebtPct,
      costOfDebtMethod,
      syntheticRating,
      syntheticSpreadPct,
      interestCoverageRatio,
      weightEquity,
      weightDebt,
    };
  }

  const debtLeg = weightDebt !== null && weightDebt > 0 && costOfDebtPct !== null && taxRateUsed !== null
    ? weightDebt * costOfDebtPct * (1 - taxRateUsed)
    : 0;
  const waccRawPct = (weightEquity ?? 1) * re + debtLeg;
  const waccFloor = Math.max(WACC_FLOOR_ABS_PCT, rf + WACC_FLOOR_OVER_RF_PCT);
  let waccPct = waccRawPct;
  if (waccPct < waccFloor) {
    clampsApplied.push(
      `WACC clamped ${fmt(waccPct)}% → ${fmt(waccFloor)}% (floor max(${WACC_FLOOR_ABS_PCT}, rf + ${WACC_FLOOR_OVER_RF_PCT}))`,
    );
    // A bound headline WACC materially changes the DCF discount rate. Disclose
    // it in the manifest (not only clampsApplied, which has no other consumer)
    // when the adjustment is material (audit 2026-07-11 #5).
    if (waccFloor - waccRawPct >= WACC_MATERIAL_CLAMP_PP) {
      gaps.push({
        field: "returns.wacc.clamp",
        reason: `WACC floor bound: raw ${fmt(waccRawPct)}% raised to ${fmt(waccFloor)}% (max(${WACC_FLOOR_ABS_PCT}, rf+${WACC_FLOOR_OVER_RF_PCT})) — materially raises the DCF discount rate`,
        severity: "warn",
      });
    }
    waccPct = waccFloor;
  } else if (waccPct > WACC_CEILING_PCT) {
    clampsApplied.push(`WACC clamped ${fmt(waccPct)}% → ${WACC_CEILING_PCT}% (ceiling)`);
    if (waccRawPct - WACC_CEILING_PCT >= WACC_MATERIAL_CLAMP_PP) {
      gaps.push({
        field: "returns.wacc.clamp",
        reason: `WACC ceiling bound: raw ${fmt(waccRawPct)}% lowered to ${WACC_CEILING_PCT}% — materially lowers the DCF discount rate and inflates intrinsic value`,
        severity: "warn",
      });
    }
    waccPct = WACC_CEILING_PCT;
  }

  return {
    ...base,
    waccPct,
    waccRawPct,
    costOfEquityPct: re,
    costOfDebtPct,
    costOfDebtMethod,
    syntheticRating,
    syntheticSpreadPct,
    interestCoverageRatio,
    weightEquity,
    weightDebt,
  };
}

// ---------------------------------------------------------------------------
// ROIC — NOPAT / average invested capital, 5-year series
// ---------------------------------------------------------------------------

export interface ReturnsIncomeRow {
  /** Fiscal period end, ISO yyyy-mm-dd. */
  date: string;
  revenue?: number | null;
  operatingIncome?: number | null;
  ebit?: number | null;
  incomeBeforeTax?: number | null;
  incomeTaxExpense?: number | null;
  netIncome?: number | null;
}

export interface ReturnsBalanceRow {
  /** Fiscal period end, ISO yyyy-mm-dd. */
  date: string;
  totalDebt?: number | null;
  totalStockholdersEquity?: number | null;
  cashAndCashEquivalents?: number | null;
  totalAssets?: number | null;
}

export interface RoicYear {
  date: string;
  /** NOPAT / avg invested capital, percent, full precision. Null when uncomputable. */
  roicPct: number | null;
  nopat: number | null;
  investedCapitalAvg: number | null;
  /** Effective tax fraction used for NOPAT that year (clamped). */
  taxRateUsed: number | null;
  notes: string[];
}

export interface RoicResult {
  /** Oldest → newest, up to ROIC_SERIES_MAX_YEARS entries. */
  series: RoicYear[];
  latestRoicPct: number | null;
  /** Latest fiscal period end used. */
  asOf: string | null;
  notes: string[];
  gaps: ManifestEntry[];
}

export const ROIC_SERIES_MAX_YEARS = 5;
/** Balance rows within this many days of the income date are considered the same period. */
export const BALANCE_MATCH_TOLERANCE_DAYS = 45;

function findBalanceForDate(
  balancesNewestFirst: ReadonlyArray<ReturnsBalanceRow>,
  isoDate: string,
): ReturnsBalanceRow | null {
  const target = Date.parse(isoDate);
  let best: ReturnsBalanceRow | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const b of balancesNewestFirst) {
    if (b.date === isoDate) return b;
    const t = Date.parse(b.date);
    if (!Number.isFinite(t) || !Number.isFinite(target)) continue;
    const delta = Math.abs(t - target) / (24 * 3600 * 1000);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = b;
    }
  }
  return bestDelta <= BALANCE_MATCH_TOLERANCE_DAYS ? best : null;
}

/** Observed effective tax fraction for a single year, clamped [0, 0.35]. */
function yearTaxRate(row: ReturnsIncomeRow, notes: string[]): number | null {
  const pretax = row.incomeBeforeTax;
  const tax = row.incomeTaxExpense;
  if (!isFiniteNumber(pretax) || pretax <= 0) {
    notes.push("tax rate unavailable because pre-tax income is missing or non-positive — NOPAT and ROIC suppressed");
    return null;
  }
  if (!isFiniteNumber(tax)) {
    notes.push("tax rate unavailable because income tax expense is missing — NOPAT and ROIC suppressed");
    return null;
  }
  const t = tax / pretax;
  if (t < TAX_CLAMP[0]) {
    notes.push(`effective tax ${fmt(t)} clamped to ${TAX_CLAMP[0]}`);
    return TAX_CLAMP[0];
  }
  if (t > TAX_CLAMP[1]) {
    notes.push(`effective tax ${fmt(t)} clamped to ${TAX_CLAMP[1]}`);
    return TAX_CLAMP[1];
  }
  return t;
}

/** Invested capital = totalDebt + totalStockholdersEquity − cash (research S2C definition). */
function investedCapital(b: ReturnsBalanceRow, notes: string[]): number | null {
  if (!isFiniteNumber(b.totalStockholdersEquity)) {
    notes.push(`totalStockholdersEquity missing on ${b.date} — invested capital uncomputable`);
    return null;
  }
  if (!isFiniteNumber(b.totalDebt)) {
    notes.push(`totalDebt missing on ${b.date} — invested capital uncomputable`);
    return null;
  }
  if (b.totalDebt < 0) {
    notes.push(`totalDebt is negative on ${b.date} — invested capital uncomputable`);
    return null;
  }
  if (!isFiniteNumber(b.cashAndCashEquivalents)) {
    notes.push(`cashAndCashEquivalents missing on ${b.date} — invested capital uncomputable`);
    return null;
  }
  return b.totalDebt + b.totalStockholdersEquity - b.cashAndCashEquivalents;
}

export function computeRoic(
  income: ReadonlyArray<ReturnsIncomeRow>,
  balance: ReadonlyArray<ReturnsBalanceRow>,
): RoicResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const inc = sortNewestFirst(income);
  const bal = sortNewestFirst(balance);

  if (inc.length === 0 || bal.length === 0) {
    gaps.push({
      field: "returns.roic",
      reason: `missing ${inc.length === 0 ? "income" : "balance"} rows — ROIC series unavailable`,
      severity: "warn",
    });
    return { series: [], latestRoicPct: null, asOf: inc[0]?.date ?? null, notes, gaps };
  }
  notes.push(
    "invested capital = totalDebt + totalStockholdersEquity − cashAndCashEquivalents (house definition per the valuation methodology §2.2)",
  );

  const series: RoicYear[] = [];
  const take = Math.min(ROIC_SERIES_MAX_YEARS, inc.length);
  for (let i = take - 1; i >= 0; i -= 1) {
    const row = inc[i];
    const yearNotes: string[] = [];
    const entry: RoicYear = {
      date: row.date,
      roicPct: null,
      nopat: null,
      investedCapitalAvg: null,
      taxRateUsed: null,
      notes: yearNotes,
    };
    series.push(entry);

    const ebit = isFiniteNumber(row.operatingIncome)
      ? row.operatingIncome
      : isFiniteNumber(row.ebit)
        ? row.ebit
        : null;
    if (ebit === null) {
      yearNotes.push("operatingIncome/ebit missing — NOPAT uncomputable");
      continue;
    }
    if (!isFiniteNumber(row.operatingIncome) && isFiniteNumber(row.ebit)) {
      yearNotes.push("operatingIncome missing — ebit field used");
    }
    const t = yearTaxRate(row, yearNotes);
    if (t === null) {
      gaps.push({
        field: "returns.roic.taxRate",
        reason: `${row.date}: an observed effective tax rate could not be computed — NOPAT and ROIC suppressed for this period`,
        severity: "warn",
      });
      continue;
    }
    const nopat = ebit * (1 - t);
    entry.taxRateUsed = t;
    entry.nopat = nopat;

    const balNow = findBalanceForDate(bal, row.date);
    if (balNow === null) {
      yearNotes.push(`no balance sheet within ${BALANCE_MATCH_TOLERANCE_DAYS}d of ${row.date}`);
      continue;
    }
    const icNow = investedCapital(balNow, yearNotes);
    if (icNow === null) continue;

    // Previous-period balance for averaging: the next-older income date, else nearest older balance.
    const prevIncomeDate = i + 1 < inc.length ? inc[i + 1].date : null;
    const balPrev = prevIncomeDate !== null ? findBalanceForDate(bal, prevIncomeDate) : null;
    let icAvg: number;
    if (balPrev !== null && balPrev !== balNow) {
      const icPrev = investedCapital(balPrev, yearNotes);
      if (icPrev !== null) {
        icAvg = (icNow + icPrev) / 2;
      } else {
        icAvg = icNow;
        yearNotes.push("prior invested capital uncomputable — single-period IC used");
      }
    } else {
      icAvg = icNow;
      yearNotes.push("no prior balance sheet — single-period IC used");
    }

    if (icAvg <= 0) {
      yearNotes.push(
        `average invested capital ≤ 0 (${fmt(icAvg)}) — ROIC not meaningful (buyback-depleted equity guard)`,
      );
      entry.investedCapitalAvg = icAvg;
      continue;
    }
    entry.investedCapitalAvg = icAvg;
    entry.roicPct = (nopat / icAvg) * 100;
  }

  const latest = series.length > 0 ? series[series.length - 1] : null;
  return {
    series,
    latestRoicPct: latest?.roicPct ?? null,
    asOf: inc[0].date,
    notes,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// DuPont — netMargin × assetTurnover × leverage = ROE, 5-year series
// ---------------------------------------------------------------------------

export interface DupontYear {
  date: string;
  /** netIncome / revenue (fraction, full precision). */
  netMargin: number | null;
  /** revenue / average totalAssets. */
  assetTurnover: number | null;
  /** average totalAssets / average totalStockholdersEquity. */
  leverage: number | null;
  /** netIncome / average equity, percent. Product identity: roePct = netMargin·turnover·leverage·100. */
  roePct: number | null;
  notes: string[];
}

export interface DupontResult {
  /** Oldest → newest, up to 5 entries. */
  series: DupontYear[];
  latest: DupontYear | null;
  asOf: string | null;
  notes: string[];
  gaps: ManifestEntry[];
}

export const DUPONT_SERIES_MAX_YEARS = 5;

export function computeDupont(
  income: ReadonlyArray<ReturnsIncomeRow>,
  balance: ReadonlyArray<ReturnsBalanceRow>,
): DupontResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const inc = sortNewestFirst(income);
  const bal = sortNewestFirst(balance);

  if (inc.length === 0 || bal.length === 0) {
    gaps.push({
      field: "returns.dupont",
      reason: `missing ${inc.length === 0 ? "income" : "balance"} rows — DuPont series unavailable`,
      severity: "warn",
    });
    return { series: [], latest: null, asOf: inc[0]?.date ?? null, notes, gaps };
  }
  notes.push("DuPont uses average assets/equity (current and prior period) where a prior balance exists");

  const series: DupontYear[] = [];
  const take = Math.min(DUPONT_SERIES_MAX_YEARS, inc.length);
  for (let i = take - 1; i >= 0; i -= 1) {
    const row = inc[i];
    const yearNotes: string[] = [];
    const entry: DupontYear = {
      date: row.date,
      netMargin: null,
      assetTurnover: null,
      leverage: null,
      roePct: null,
      notes: yearNotes,
    };
    series.push(entry);

    const balNow = findBalanceForDate(bal, row.date);
    if (balNow === null) {
      yearNotes.push(`no balance sheet within ${BALANCE_MATCH_TOLERANCE_DAYS}d of ${row.date}`);
      continue;
    }
    const prevIncomeDate = i + 1 < inc.length ? inc[i + 1].date : null;
    const balPrev = prevIncomeDate !== null ? findBalanceForDate(bal, prevIncomeDate) : null;

    const avgOf = (
      now: number | null | undefined,
      prev: number | null | undefined,
      label: string,
    ): number | null => {
      if (!isFiniteNumber(now)) {
        yearNotes.push(`${label} missing on ${balNow.date}`);
        return null;
      }
      if (balPrev !== null && balPrev !== balNow && isFiniteNumber(prev)) {
        return (now + prev) / 2;
      }
      yearNotes.push(`no prior ${label} — single-period value used`);
      return now;
    };

    const avgAssets = avgOf(balNow.totalAssets, balPrev?.totalAssets, "totalAssets");
    const avgEquity = avgOf(
      balNow.totalStockholdersEquity,
      balPrev?.totalStockholdersEquity,
      "totalStockholdersEquity",
    );

    const revenue = isFiniteNumber(row.revenue) ? row.revenue : null;
    const ni = isFiniteNumber(row.netIncome) ? row.netIncome : null;

    if (revenue === null || revenue <= 0) {
      yearNotes.push("revenue missing or ≤ 0 — margin/turnover not meaningful");
    } else if (ni !== null) {
      entry.netMargin = ni / revenue;
    }
    if (revenue !== null && revenue > 0 && avgAssets !== null && avgAssets > 0) {
      entry.assetTurnover = revenue / avgAssets;
    } else if (avgAssets !== null && avgAssets <= 0) {
      yearNotes.push("average assets ≤ 0 — turnover not meaningful");
    }
    if (avgAssets !== null && avgEquity !== null) {
      if (avgEquity <= 0) {
        yearNotes.push("average equity ≤ 0 — leverage/ROE not meaningful (negative-equity guard)");
      } else if (avgAssets > 0) {
        entry.leverage = avgAssets / avgEquity;
      }
    }
    if (ni !== null && avgEquity !== null && avgEquity > 0) {
      entry.roePct = (ni / avgEquity) * 100;
    }
  }

  const latest = series.length > 0 ? series[series.length - 1] : null;
  return { series, latest, asOf: inc[0].date, notes, gaps };
}

// ---------------------------------------------------------------------------
// ROIC vs WACC spread
// ---------------------------------------------------------------------------

export interface RoicVsWaccSpread {
  /** ROIC − WACC in percentage points (positive = value creation). Null when either is null. */
  spreadPctPts: number | null;
  note: string;
}

export function computeRoicVsWaccSpread(
  roicPct: number | null,
  waccPct: number | null,
): RoicVsWaccSpread {
  if (!isFiniteNumber(roicPct) || !isFiniteNumber(waccPct)) {
    return {
      spreadPctPts: null,
      note: "ROIC vs WACC spread unavailable — one or both inputs missing",
    };
  }
  return {
    spreadPctPts: roicPct - waccPct,
    note: `spread = ROIC ${fmt(roicPct)}% − WACC ${fmt(waccPct)}% (positive = returns above cost of capital)`,
  };
}
