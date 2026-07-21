/**
 * Stage B — weighted forward projections (the application contract §4; feature 1.1.0).
 *
 * PURE, deterministic TypeScript: no network, no DB, no LLM. Projects revenue,
 * operating margin, free cash flow (unlevered/FCFF) and diluted EPS forward, in
 * three scenarios (bull / base / bear) plus a display-prior-weighted path.
 *
 * The engine REUSES the DCF's own assumptions rather than inventing a parallel
 * model, so the projection page can never contradict the valuation page:
 *  - the BASE path IS the DCF's forward `DcfYearRow[]` (already analyst-anchored
 *    near-term by buildDcfAssumptions, fading to terminal growth);
 *  - BULL / BEAR re-run the exported `runDcf` with growth shifted by sample σ
 *    from consecutive company history; the margin shift is scaled by the
 *    observed growth/margin correlation rather than assuming perfect covariance;
 *  - the WEIGHTED path uses an explicitly versioned 25/50/25 display prior.
 *    These weights are not presented as empirically calibrated probabilities.
 * Thin or irregular history suppresses the fan instead of inventing dispersion.
 *
 * EPS is the one series not directly a DcfYearRow: it is derived from the
 * forward operating path (EBIT × historical net-income/EBIT ratio) over a
 * buyback-trended diluted-share count, and is disclosed + skipped when those
 * inputs are missing (the application contract §1 rule #4).
 *
 * Every forward number is a TracedNumber sourced "computed.projections.<metric>.
 * <scenario>" (an ESTIMATE by construction — it never comes from model memory).
 * Route-inappropriate cases (banks/insurers/REITs/pre-revenue) return a
 * `notApplicableReason` rather than forcing an FCFF fan.
 */

import type { CompanyRouteResult } from "@/pipeline/stageB/sectorRouting";
import { hasIrregularAnnualSpacing, yearsBetweenDates } from "@/pipeline/stageB/growth";
import {
  runDcf,
  type DcfAssumptions,
  type DcfYearRow,
  type ValuationResult,
} from "@/pipeline/stageB/valuation";
import type { ManifestEntry } from "@/types/core";
import type {
  Projections,
  ProjectionSeries,
  ProjectionPoint,
  ProjectionMetric,
  TracedNumber,
} from "@/report/schema";

/** Forward horizon in years (annual). */
export const PROJECTION_HORIZON_YEARS = 5;
/** Versioned scenario-weight prior, stamped into the report. */
export const PROJECTION_WEIGHTS_VERSION = "UNBACKTESTED_SCENARIO_PRIOR_2026_07" as const;
/** Coarse display prior over the three scenarios (sums to 1; not empirical odds). */
export const PROJECTION_WEIGHTS = { bull: 0.25, base: 0.5, bear: 0.25 } as const;

/** Dispersion multiplier: bull/bear = base ± DISPERSION_K · σ. */
export const DISPERSION_K = 1.0;
/** Upper sanity bounds only; stable firms are no longer forced to show a band. */
const SIGMA_GROWTH_MAX = 25; // pp
const SIGMA_MARGIN_MAX = 12; // pp
/** Perturbed-path sanity clamps. */
const GROWTH_CLAMP: readonly [number, number] = [-30, 60]; // pct/yr
const MARGIN_CLAMP: readonly [number, number] = [0, 60]; // pct

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Sample standard deviation over finite values; null when fewer than 3 observations. */
function stdev(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 3) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}

function correlation(pairs: Array<{ x: number; y: number }>): number | null {
  if (pairs.length < 3) return null;
  const meanX = pairs.reduce((sum, p) => sum + p.x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, p) => sum + p.y, 0) / pairs.length;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (const pair of pairs) {
    const dx = pair.x - meanX;
    const dy = pair.y - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (varianceX <= 0 || varianceY <= 0) return 0;
  return clamp(covariance / Math.sqrt(varianceX * varianceY), -1, 1);
}

/** Median over finite values, or null. */
function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
}

/* ------------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------------ */

export interface ProjectionIncomeRow {
  date: string;
  revenue: number | null;
  /** EBIT (operating income), FMP names — used for the net-income/EBIT ratio. */
  ebit: number | null;
  netIncome: number | null;
  epsDiluted: number | null;
}

export interface ProjectionFcfRow {
  date: string;
  fcf: number | null;
}

export interface ProjectionsInputs {
  route: CompanyRouteResult;
  /** The valuation result — projections only run on the general DCF route. */
  valuation: ValuationResult;
  waccPct: number | null;
  netDebt: number | null;
  /** Latest diluted share count (for the EPS series). */
  dilutedShares: number | null;
  /** Annual income history (any order). */
  incomeHistory: ProjectionIncomeRow[];
  /** Annual FCF history (any order) — for the FCF fan's historical half. */
  fcfHistory: ProjectionFcfRow[];
  /** Annualised share-count change (percent; negative = buybacks). */
  shareCountAnnualizedPct: number | null;
  /** Currency label for revenue/FCF/EPS units. */
  currency: string;
  asOf: string;
}

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

function tn(value: number, unit: string, metric: ProjectionMetric, scenario: string, asOf: string): TracedNumber {
  return {
    value: round2(value),
    unit,
    source: `computed.projections.${metric}.${scenario}`,
    asOf,
    verified: true, // deterministic, computed from sourced inputs (not model memory)
  };
}

function point(period: string, value: number, unit: string, metric: ProjectionMetric, scenario: string, asOf: string): ProjectionPoint {
  return { period, value: tn(value, unit, metric, scenario, asOf) };
}

/** Fiscal-year label from an ISO date; falls back to the raw string. */
function fyLabel(dateIso: string): string {
  const y = Number.parseInt(dateIso.slice(0, 4), 10);
  return Number.isFinite(y) ? `FY${y}` : dateIso;
}

/** Shift a path by a constant delta with sanity clamps. */
function shiftPath(path: number[], delta: number, lo: number, hi: number): number[] {
  return path.map((v) => clamp(v + delta, lo, hi));
}

/** Weighted blend of three same-length scenario paths. */
function weightedPath(bull: number[], base: number[], bear: number[]): number[] {
  const w = PROJECTION_WEIGHTS;
  return base.map((b, i) => w.bull * bull[i] + w.base * b + w.bear * bear[i]);
}

/** Historical annualized revenue growth from dated oldest→newest observations. */
function annualizedGrowthPct(revenues: Array<{ date: string; value: number }>): number[] {
  const out: number[] = [];
  for (let i = 1; i < revenues.length; i++) {
    const prior = revenues[i - 1];
    const current = revenues[i];
    const years = yearsBetweenDates(prior.date, current.date);
    if (prior.value > 0 && current.value > 0 && years !== null && years > 0) {
      out.push((Math.pow(current.value / prior.value, 1 / years) - 1) * 100);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Shared scenario construction — reused by the projection fan (this module)
 * AND the deterministic scenario price targets (scenarioTargets.ts), so the two
 * can never disagree on what "bull"/"bear" mean. Both consume the SAME σ and the
 * SAME clone-and-shift perturbation of the base DCF assumptions.
 * ------------------------------------------------------------------------ */

export interface ScenarioDispersion {
  /** Revenue-growth sample σ, percentage points; null when evidence is too thin. */
  sigmaGrowth: number | null;
  /** Operating-margin sample σ, percentage points; null when evidence is too thin. */
  sigmaMargin: number | null;
  /** Empirical correlation of annual growth and the corresponding margin. */
  growthMarginCorrelation: number | null;
  /** Retained compatibility name: true now means unavailable, never defaulted. */
  growthDefaulted: boolean;
  /** Retained compatibility name: true now means unavailable, never defaulted. */
  marginDefaulted: boolean;
  /** True when any measured series contained a nonconsecutive fiscal interval. */
  irregularHistory: boolean;
}

/**
 * The company's OWN historical dispersion of revenue growth + operating margin,
 * capped only at an upper sanity bound. Thin history returns null and suppresses
 * the fan/targets rather than fabricating a default band.
 */
export function scenarioDispersion(incomeHistory: ProjectionIncomeRow[]): ScenarioDispersion {
  const incomeAsc = incomeHistory
    .filter((r) => r.date.length > 0)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const revenueSeries = incomeAsc.flatMap((r) =>
    isNum(r.revenue) ? [{ date: r.date, value: r.revenue }] : []);
  const marginSeries = incomeAsc.flatMap((r) =>
    isNum(r.ebit) && isNum(r.revenue) && r.revenue > 0
      ? [{ date: r.date, value: (r.ebit / r.revenue) * 100 }]
      : []);
  const growthIrregular = hasIrregularAnnualSpacing(revenueSeries.map((p) => p.date));
  const marginIrregular = hasIrregularAnnualSpacing(marginSeries.map((p) => p.date));
  const rawSigmaG = growthIrregular ? null : stdev(annualizedGrowthPct(revenueSeries));
  const rawSigmaM = marginIrregular ? null : stdev(marginSeries.map((p) => p.value));
  const marginByDate = new Map(marginSeries.map((point) => [point.date, point.value]));
  const paired: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < revenueSeries.length; i++) {
    const prior = revenueSeries[i - 1];
    const current = revenueSeries[i];
    const years = yearsBetweenDates(prior.date, current.date);
    const margin = marginByDate.get(current.date);
    if (years !== null && years > 0 && prior.value > 0 && current.value > 0 && margin !== undefined) {
      paired.push({
        x: (Math.pow(current.value / prior.value, 1 / years) - 1) * 100,
        y: margin,
      });
    }
  }
  return {
    sigmaGrowth: rawSigmaG === null ? null : clamp(rawSigmaG, 0, SIGMA_GROWTH_MAX),
    sigmaMargin: rawSigmaM === null ? null : clamp(rawSigmaM, 0, SIGMA_MARGIN_MAX),
    growthMarginCorrelation:
      growthIrregular || marginIrregular ? null : correlation(paired),
    growthDefaulted: rawSigmaG === null,
    marginDefaulted: rawSigmaM === null,
    irregularHistory: growthIrregular || marginIrregular,
  };
}

/**
 * Clone the base DCF assumptions and shift the growth + operating-margin paths
 * by a constant delta (percentage points), with the same sanity clamps the fan
 * uses. Pure — the caller runs the shifted assumptions through the DCF engine.
 */
export function perturbScenarioAssumptions(
  assumptions: DcfAssumptions,
  growthDelta: number,
  marginDelta: number,
): DcfAssumptions {
  const cloned: DcfAssumptions = structuredClone(assumptions);
  cloned.growthPath.value = shiftPath(assumptions.growthPath.value, growthDelta, GROWTH_CLAMP[0], GROWTH_CLAMP[1]);
  cloned.ebitMarginPath.value = shiftPath(assumptions.ebitMarginPath.value, marginDelta, MARGIN_CLAMP[0], MARGIN_CLAMP[1]);
  return cloned;
}

/* ------------------------------------------------------------------------ *
 * computeProjections
 * ------------------------------------------------------------------------ */

function notApplicable(reason: string): Projections {
  return {
    horizonYears: PROJECTION_HORIZON_YEARS,
    scenarioWeights: { ...PROJECTION_WEIGHTS },
    weightsVersion: PROJECTION_WEIGHTS_VERSION,
    series: [],
    notApplicableReason: reason,
  };
}

export function computeProjections(inputs: ProjectionsInputs): Projections {
  const { valuation, asOf, currency } = inputs;

  // Projections run only on the general FCFF-DCF route (SPEC §6: financials /
  // REITs use book-value models; pre-revenue uses runway framing).
  if (valuation.kind !== "dcf") {
    return notApplicable(
      `Forward FCFF projections are only modelled on the general route; this company routed to "${valuation.kind}".`,
    );
  }
  const assumptions = valuation.assumptions;
  const baseDcf = valuation.dcf;
  if (assumptions === null || baseDcf === null || baseDcf.yearRows.length === 0) {
    return notApplicable("DCF assumptions/forward path unavailable — no basis for projections.");
  }
  if (!isNum(inputs.waccPct)) {
    return notApplicable("WACC unavailable — cannot re-run the forward model for scenarios.");
  }

  const H = Math.min(PROJECTION_HORIZON_YEARS, assumptions.years);

  // --- Dispersion from the company's own history ---------------------------
  const disclosures: ManifestEntry[] = [];
  const incomeAsc = inputs.incomeHistory
    .filter((r) => r.date.length > 0)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const rawDisp = scenarioDispersion(inputs.incomeHistory);
  if (rawDisp.sigmaGrowth === null || rawDisp.sigmaMargin === null) {
    return notApplicable(
      "At least four consecutive annual revenue observations and three margin observations are required for sample dispersion; scenario fan suppressed rather than using house defaults.",
    );
  }
  const sigmaGrowth = rawDisp.sigmaGrowth;
  const sigmaMargin = rawDisp.sigmaMargin;
  if (rawDisp.irregularHistory) {
    disclosures.push({
      field: "projections.dispersion.spacing",
      reason: "nonconsecutive fiscal history rejected from dispersion estimates — scenario fan suppressed",
      severity: "warn",
    });
  }
  if (rawDisp.growthMarginCorrelation === null) {
    disclosures.push({
      field: "projections.dispersion.covariance",
      reason: "insufficient paired history to estimate growth/margin covariance — margin path left at base in scenarios",
      severity: "warn",
    });
  }

  // --- Bull / bear paths via the SAME DCF engine ---------------------------
  const dg = DISPERSION_K * sigmaGrowth;
  const dm = DISPERSION_K * sigmaMargin * (rawDisp.growthMarginCorrelation ?? 0);

  const runScenario = (growthDelta: number, marginDelta: number): DcfYearRow[] =>
    runDcf(perturbScenarioAssumptions(assumptions, growthDelta, marginDelta), {
      waccPct: inputs.waccPct as number,
      netDebt: inputs.netDebt,
      dilutedShares: inputs.dilutedShares,
    }).yearRows;

  const bullRows = runScenario(dg, dm);
  const bearRows = runScenario(-dg, -dm);
  const baseRows = baseDcf.yearRows;

  // Forward fiscal-year labels track the DCF's BASE period. The base path grows
  // from startRevenue (= the TTM/statements figure), so labelling off the last
  // ANNUAL date would mislabel mid-year filers (TTM more recent than the last
  // FYE) by up to a year. Prefer the statements date the DCF actually built from.
  const baseDate =
    assumptions.asOf.statements ??
    (incomeAsc.length > 0 ? incomeAsc[incomeAsc.length - 1].date : asOf);
  const lastFy = Number.parseInt(baseDate.slice(0, 4), 10);
  const fwdPeriod = (t: number): string => (Number.isFinite(lastFy) ? `FY${lastFy + t}` : `Y+${t}`);

  const assumptionLines: string[] = [
    `Base path is the DCF forward trajectory (near-term anchored to ${assumptions.growthPath.basis.includes("analyst") ? "analyst consensus" : "historical CAGR"}, fading to ${round2(assumptions.terminal.gTermPct.value)}% terminal growth).`,
    `Bull/bear shift growth by ±${round2(dg)}pp and margin by ±${round2(dm)}pp; the margin shift is sample σ scaled by the company's observed growth/margin correlation (${rawDisp.growthMarginCorrelation === null ? "unavailable" : round2(rawDisp.growthMarginCorrelation)}).`,
    `Weighted path uses the coarse unbacktested display prior ${PROJECTION_WEIGHTS.bull}·bull + ${PROJECTION_WEIGHTS.base}·base + ${PROJECTION_WEIGHTS.bear}·bear; these are not empirical probabilities.`,
  ];

  // --- Build series --------------------------------------------------------
  const revUnit = currency;
  const series: ProjectionSeries[] = [];

  // Historical helpers (last up to 4 actual years, oldest→newest).
  const histTail = <T,>(rows: T[]): T[] => rows.slice(Math.max(0, rows.length - 4));

  // Revenue
  series.push(
    buildSeries(
      "revenue",
      revUnit,
      histTail(incomeAsc.filter((r) => isNum(r.revenue))).map((r) => ({ period: fyLabel(r.date), value: r.revenue as number })),
      bullRows.slice(0, H).map((r) => r.revenue),
      baseRows.slice(0, H).map((r) => r.revenue),
      bearRows.slice(0, H).map((r) => r.revenue),
      fwdPeriod,
      assumptionLines,
      disclosures,
      asOf,
    ),
  );

  // Operating margin (percent)
  const marginHist = incomeAsc
    .filter((r) => isNum(r.ebit) && isNum(r.revenue) && (r.revenue as number) > 0)
    .map((r) => ({ period: fyLabel(r.date), value: ((r.ebit as number) / (r.revenue as number)) * 100 }));
  series.push(
    buildSeries(
      "operatingMargin",
      "%",
      histTail(marginHist),
      bullRows.slice(0, H).map((r) => r.ebitMarginPct),
      baseRows.slice(0, H).map((r) => r.ebitMarginPct),
      bearRows.slice(0, H).map((r) => r.ebitMarginPct),
      fwdPeriod,
      assumptionLines,
      disclosures,
      asOf,
    ),
  );

  // Free cash flow (unlevered / FCFF)
  const fcfAsc = inputs.fcfHistory.filter((r) => r.date.length > 0 && isNum(r.fcf)).sort((a, b) => a.date.localeCompare(b.date));
  series.push(
    buildSeries(
      "fcf",
      revUnit,
      histTail(fcfAsc).map((r) => ({ period: fyLabel(r.date), value: r.fcf as number })),
      bullRows.slice(0, H).map((r) => r.fcff),
      baseRows.slice(0, H).map((r) => r.fcff),
      bearRows.slice(0, H).map((r) => r.fcff),
      fwdPeriod,
      [
        ...assumptionLines,
        "FCF shown is unlevered free cash flow (FCFF), consistent with the DCF (NOPAT − reinvestment).",
        "Scenario paths can cross: the higher-growth (bull) case reinvests more up front, so its near-term FCF may sit BELOW the lower-growth (bear) case before overtaking it as growth matures. The shaded band is the scenario range, not a strict bull-over-bear ordering.",
      ],
      disclosures,
      asOf,
    ),
  );

  // Diluted EPS (derived; disclosed + skipped when inputs missing)
  const epsSeries = buildEpsSeries(inputs, { bullRows, baseRows, bearRows }, H, incomeAsc, fwdPeriod, assumptionLines, asOf);
  if (epsSeries) series.push(epsSeries);

  return {
    horizonYears: H,
    scenarioWeights: { ...PROJECTION_WEIGHTS },
    weightsVersion: PROJECTION_WEIGHTS_VERSION,
    series,
    notApplicableReason: null,
  };
}

/* ------------------------------------------------------------------------ *
 * Series builders
 * ------------------------------------------------------------------------ */

function buildSeries(
  metric: ProjectionMetric,
  unit: string,
  historical: { period: string; value: number }[],
  bull: number[],
  base: number[],
  bear: number[],
  fwdPeriod: (t: number) => string,
  assumptions: string[],
  disclosures: ManifestEntry[],
  asOf: string,
): ProjectionSeries {
  const weighted = weightedPath(bull, base, bear);
  const mk = (arr: number[], scenario: string): ProjectionPoint[] =>
    arr.map((v, i) => point(fwdPeriod(i + 1), v, unit, metric, scenario, asOf));
  return {
    metric,
    unit,
    historical: historical.map((h) => point(h.period, h.value, unit, metric, "historical", asOf)),
    bull: mk(bull, "bull"),
    base: mk(base, "base"),
    bear: mk(bear, "bear"),
    weighted: mk(weighted, "weighted"),
    assumptions,
    disclosures: [...disclosures],
  };
}

function buildEpsSeries(
  inputs: ProjectionsInputs,
  rows: { bullRows: DcfYearRow[]; baseRows: DcfYearRow[]; bearRows: DcfYearRow[] },
  H: number,
  incomeAsc: ProjectionIncomeRow[],
  fwdPeriod: (t: number) => string,
  assumptionLines: string[],
  asOf: string,
): ProjectionSeries | null {
  const shares0 = inputs.dilutedShares;
  const niToEbit = median(
    incomeAsc
      .filter((r) => isNum(r.netIncome) && isNum(r.ebit) && (r.ebit as number) > 0)
      .map((r) => (r.netIncome as number) / (r.ebit as number)),
  );
  if (!isNum(shares0) || shares0 <= 0 || niToEbit === null) {
    // Disclosed elsewhere by the caller's revenue series; simply skip EPS.
    return null;
  }
  const g = isNum(inputs.shareCountAnnualizedPct) ? inputs.shareCountAnnualizedPct / 100 : 0;
  const sharesAt = (t: number): number => shares0 * Math.pow(1 + g, t); // t = 1..H

  const epsPath = (dcfRows: DcfYearRow[]): number[] =>
    dcfRows.slice(0, H).map((r, i) => (r.ebit * niToEbit) / sharesAt(i + 1));

  const bull = epsPath(rows.bullRows);
  const base = epsPath(rows.baseRows);
  const bear = epsPath(rows.bearRows);

  const histEps = incomeAsc
    .filter((r) => isNum(r.epsDiluted))
    .slice(-4)
    .map((r) => ({ period: fyLabel(r.date), value: r.epsDiluted as number }));

  const unit = `${inputs.currency}/share`;
  const weighted = weightedPath(bull, base, bear);
  const mk = (arr: number[], scenario: string): ProjectionPoint[] =>
    arr.map((v, i) => point(fwdPeriod(i + 1), v, unit, "epsDiluted", scenario, asOf));
  return {
    metric: "epsDiluted",
    unit,
    historical: histEps.map((h) => point(h.period, h.value, unit, "epsDiluted", "historical", asOf)),
    bull: mk(bull, "bull"),
    base: mk(base, "base"),
    bear: mk(bear, "bear"),
    weighted: mk(weighted, "weighted"),
    assumptions: [
      ...assumptionLines,
      `EPS = forward EBIT × median historical net-income/EBIT ratio (${round2(niToEbit)}) ÷ diluted shares trended ${round2(g * 100)}%/yr (buyback/dilution history).`,
    ],
    disclosures: [],
  };
}
