/**
 * Stage B — Growth: revenue/EPS/FCF CAGRs, margin series + trends,
 * revenue acceleration.
 *
 * Pure, deterministic TypeScript: no network, no DB, no LLM (the application contract §4).
 * Input rows use FMP's exact field names (the provider data contract §2.3); the integration
 * layer wires the DataBundle into these interfaces.
 *
 * Contract rules honored here:
 * - Missing inputs never throw → partial results + ManifestEntry-compatible gaps.
 * - Every house-rule threshold is annotated in notes[] instead of silently applied.
 * - Full precision is returned; rounding happens only at display time.
 * - CAGR is undefined across sign flips (or non-positive endpoints) → null + note.
 * - Windows degrade to available history; the actual span is annotated.
 */

import type { ManifestEntry } from "@/types/core";
import { deriveFcf } from "@/pipeline/stageB/financialValues";
import { normalizeQuarterRows } from "@/pipeline/stageB/quarterWindows";

// ---------------------------------------------------------------------------
// Input interfaces — field names exactly as FMP returns them (the provider data contract §2.3)
// ---------------------------------------------------------------------------

export interface GrowthIncomeRow {
  /** Fiscal period end, ISO yyyy-mm-dd. */
  date: string;
  /** Filing recency, used ONLY to pick the surviving row of a restated period. */
  acceptedDate?: string | null;
  filingDate?: string | null;
  revenue?: number | null;
  grossProfit?: number | null;
  operatingIncome?: number | null;
  netIncome?: number | null;
  epsDiluted?: number | null;
}

export interface GrowthCashFlowRow {
  /** Fiscal period end, ISO yyyy-mm-dd. */
  date: string;
  /** Filing recency, used ONLY to pick the surviving row of a restated period. */
  acceptedDate?: string | null;
  filingDate?: string | null;
  freeCashFlow?: number | null;
  operatingCashFlow?: number | null;
  /** FMP reports capex NEGATIVE (freeCashFlow = operatingCashFlow + capitalExpenditure). */
  capitalExpenditure?: number | null;
}

export interface GrowthOptions {
  /** Only annual rows are supported in v1 — quarterly CAGRs are not meaningful here. */
  period: "annual";
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export const CAGR_WINDOWS = [1, 3, 5, 10] as const;
export type CagrWindow = (typeof CAGR_WINDOWS)[number];

export interface CagrPoint {
  /** The requested window (1/3/5/10 years). */
  windowYears: CagrWindow;
  /** The span actually used (available history may be shorter). Null when uncomputable. */
  actualYears: number | null;
  /** Annualized growth in percent (full precision). Null on sign flip / missing data. */
  cagrPct: number | null;
  startDate: string | null;
  endDate: string | null;
  startValue: number | null;
  endValue: number | null;
  note?: string;
}

export interface MarginPoint {
  date: string;
  /** Margin in percent, full precision; null when revenue ≤ 0 or numerator missing. */
  pct: number | null;
}

export interface MarginTrend {
  /** Oldest → newest, up to MARGIN_SERIES_MAX_YEARS annual observations. */
  series: MarginPoint[];
  /**
   * Least-squares slope in percentage points per year over the annual series
   * (actual elapsed fiscal years). Null when fewer than REGRESSION_MIN_POINTS non-null points.
   */
  slopePctPtsPerYear: number | null;
  note?: string;
}

export interface RevenueAcceleration {
  latestYoyPct: number | null;
  threeYearCagrPct: number | null;
  /** latestYoyPct − threeYearCagrPct, in percentage points. */
  deltaPctPts: number | null;
  /** True when the latest YoY exceeds the 3y CAGR. Null when either input is null. */
  accelerating: boolean | null;
  note?: string;
}

export interface GrowthResult {
  /** Latest statement date used (fiscal period end) — provenance anchor. */
  asOf: string | null;
  period: "annual";
  revenueCagrs: CagrPoint[];
  epsDilutedCagrs: CagrPoint[];
  fcfCagrs: CagrPoint[];
  margins: { gross: MarginTrend; operating: MarginTrend; net: MarginTrend };
  revenueAcceleration: RevenueAcceleration;
  notes: string[];
  gaps: ManifestEntry[];
}

// ---------------------------------------------------------------------------
// House-rule constants (annotated in notes whenever they bite)
// ---------------------------------------------------------------------------

/** Margin series depth (house rule per the application contract §4: "up to 10yr"). */
export const MARGIN_SERIES_MAX_YEARS = 10;
/** Minimum non-null points for a regression slope (house rule). */
export const REGRESSION_MIN_POINTS = 3;
/** Tolerance (years) between index-implied and date-implied spans before we flag irregular spacing. */
export const IRREGULAR_SPACING_TOLERANCE_YEARS = 0.6;

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Small pure helpers (exported for reuse by sibling Stage B modules and tests)
// ---------------------------------------------------------------------------

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Sort rows newest-first by ISO date (defensive — FMP is usually newest-first already). */
export function sortNewestFirst<T extends { date: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * Least-squares slope of y over x. Returns null when fewer than
 * REGRESSION_MIN_POINTS points survive null-filtering or x has no variance.
 */
export function linearRegressionSlope(
  points: ReadonlyArray<{ x: number | null; y: number | null }>,
): number | null {
  const clean = points.filter((p): p is { x: number; y: number } =>
    isFiniteNumber(p.x) && isFiniteNumber(p.y));
  if (clean.length < REGRESSION_MIN_POINTS) return null;
  const n = clean.length;
  const meanX = clean.reduce((s, p) => s + p.x, 0) / n;
  const meanY = clean.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of clean) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) * (p.x - meanX);
  }
  if (den === 0) return null;
  return num / den;
}

function fmt(n: number): string {
  return String(Number(n.toFixed(4)));
}

export function yearsBetweenDates(olderIso: string, newerIso: string): number | null {
  const a = Date.parse(olderIso);
  const b = Date.parse(newerIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / MS_PER_YEAR;
}

/** True when any adjacent fiscal observation is not approximately annual. */
export function hasIrregularAnnualSpacing(datesOldestFirst: readonly string[]): boolean {
  for (let i = 1; i < datesOldestFirst.length; i++) {
    const years = yearsBetweenDates(datesOldestFirst[i - 1], datesOldestFirst[i]);
    if (years === null || years < 0.7 || years > 1.3) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// CAGR core
// ---------------------------------------------------------------------------

interface SeriesPoint {
  date: string;
  value: number | null;
}

/**
 * CAGR over a requested window against a newest-first annual series.
 * - Window degrades to available history (actualYears annotated).
 * - Sign flips / non-positive endpoints → cagrPct null + note (SPEC rule).
 * - Irregular fiscal spacing detected via dates → date-based span used + note.
 */
export function cagrForWindow(
  pointsNewestFirst: ReadonlyArray<SeriesPoint>,
  windowYears: CagrWindow,
): CagrPoint {
  const empty: CagrPoint = {
    windowYears,
    actualYears: null,
    cagrPct: null,
    startDate: null,
    endDate: null,
    startValue: null,
    endValue: null,
  };
  if (pointsNewestFirst.length === 0) {
    return { ...empty, note: "no data" };
  }

  // End = most recent finite value (walk inward if the latest is null).
  let endIdx = 0;
  while (endIdx < pointsNewestFirst.length && !isFiniteNumber(pointsNewestFirst[endIdx].value)) {
    endIdx += 1;
  }
  if (endIdx >= pointsNewestFirst.length) {
    return { ...empty, note: "no finite values in series" };
  }
  const notes: string[] = [];
  if (endIdx > 0) {
    notes.push(`latest ${endIdx} period(s) missing — endpoint moved to ${pointsNewestFirst[endIdx].date}`);
  }

  // Start = value `windowYears` periods older, degraded to oldest available,
  // then walked toward the endpoint until a finite value is found.
  let startIdx = Math.min(endIdx + windowYears, pointsNewestFirst.length - 1);
  while (startIdx > endIdx && !isFiniteNumber(pointsNewestFirst[startIdx].value)) {
    startIdx -= 1;
  }
  if (startIdx <= endIdx) {
    return {
      ...empty,
      endDate: pointsNewestFirst[endIdx].date,
      endValue: pointsNewestFirst[endIdx].value,
      note: "insufficient history (need at least two finite annual values)",
    };
  }

  const end = pointsNewestFirst[endIdx];
  const start = pointsNewestFirst[startIdx];
  const endValue = end.value as number;
  const startValue = start.value as number;

  // Span: index difference assumes annual spacing; cross-check against dates.
  let years: number = startIdx - endIdx;
  const dateYears = yearsBetweenDates(start.date, end.date);
  if (dateYears !== null && Math.abs(dateYears - years) > IRREGULAR_SPACING_TOLERANCE_YEARS) {
    notes.push(
      `irregular fiscal spacing: index-implied ${years}y vs date-implied ${fmt(dateYears)}y — date-based span used`,
    );
    years = dateYears;
  }
  if (years < windowYears - 0.001) {
    notes.push(`requested ${windowYears}y window, only ${fmt(years)}y of history available`);
  }

  const base: CagrPoint = {
    windowYears,
    actualYears: years,
    cagrPct: null,
    startDate: start.date,
    endDate: end.date,
    startValue,
    endValue,
    note: notes.length > 0 ? notes.join("; ") : undefined,
  };

  if (startValue <= 0 || endValue <= 0) {
    notes.push(
      `CAGR undefined across sign flip / non-positive endpoint (start=${fmt(startValue)}, end=${fmt(endValue)})`,
    );
    return { ...base, note: notes.join("; ") };
  }
  if (years <= 0) {
    notes.push("non-positive span — CAGR undefined");
    return { ...base, note: notes.join("; ") };
  }

  const cagrPct = (Math.pow(endValue / startValue, 1 / years) - 1) * 100;
  return { ...base, cagrPct, note: notes.length > 0 ? notes.join("; ") : undefined };
}

// ---------------------------------------------------------------------------
// computeGrowth
// ---------------------------------------------------------------------------

export function computeGrowth(
  income: ReadonlyArray<GrowthIncomeRow>,
  cashflow: ReadonlyArray<GrowthCashFlowRow>,
  options: GrowthOptions,
): GrowthResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];

  // Collapse restated/duplicate fiscal periods BEFORE any series is built.
  // FMP can return the same fiscal year twice (an original and its
  // restatement). Left in place, both rows entered every series: the CAGR
  // window counted one fiscal year as two, so an "N-year" CAGR spanned N-1
  // actual years and could anchor on the SUPERSEDED figure. The house rule is
  // the one `normalizeQuarterRows` already implements for quarters — whole
  // row, provably-latest filing wins, ambiguous duplicates rejected outright
  // rather than guessed at — and it is period-agnostic, so annual rows use it
  // unchanged.
  const incNorm = normalizeQuarterRows(income);
  const cfNorm = normalizeQuarterRows(cashflow);
  for (const { period, reason } of incNorm.rejected) {
    gaps.push({ field: "growth.incomeStatement.period", reason: `annual income period ${period} dropped: ${reason}`, severity: "warn" });
  }
  for (const { period, reason } of cfNorm.rejected) {
    gaps.push({ field: "growth.cashFlow.period", reason: `annual cash-flow period ${period} dropped: ${reason}`, severity: "warn" });
  }
  if (incNorm.rows.length !== income.length || cfNorm.rows.length !== cashflow.length) {
    notes.push(
      `Duplicate/restated annual periods collapsed before the growth series were built ` +
        `(income ${income.length}->${incNorm.rows.length}, cash flow ${cashflow.length}->${cfNorm.rows.length}); ` +
        "the most recently filed row wins.",
    );
  }

  const inc = sortNewestFirst(incNorm.rows);
  const cf = sortNewestFirst(cfNorm.rows);

  if (inc.length === 0) {
    gaps.push({
      field: "growth.incomeStatement",
      reason: "no annual income-statement rows provided",
      severity: "critical",
    });
  }
  if (cf.length === 0) {
    gaps.push({
      field: "growth.fcf",
      reason: "no annual cash-flow rows provided — FCF CAGRs unavailable",
      severity: "warn",
    });
  }

  const asOf = inc[0]?.date ?? cf[0]?.date ?? null;

  // --- CAGR series -----------------------------------------------------------
  const revenueSeries: SeriesPoint[] = inc.map((r) => ({
    date: r.date,
    value: isFiniteNumber(r.revenue) ? r.revenue : null,
  }));
  const epsSeries: SeriesPoint[] = inc.map((r) => ({
    date: r.date,
    value: isFiniteNumber(r.epsDiluted) ? r.epsDiluted : null,
  }));

  let fcfDerivedFromComponents = false;
  const fcfSeries: SeriesPoint[] = cf.map((r) => {
    if (isFiniteNumber(r.freeCashFlow)) return { date: r.date, value: r.freeCashFlow };
    const derivedFcf = deriveFcf(r.operatingCashFlow, r.capitalExpenditure);
    if (derivedFcf !== null) {
      fcfDerivedFromComponents = true;
      return { date: r.date, value: derivedFcf };
    }
    return { date: r.date, value: null };
  });
  if (fcfDerivedFromComponents) {
    notes.push(
      "FCF derived as operatingCashFlow + capitalExpenditure (FMP capex negative) for rows missing freeCashFlow",
    );
  }
  if (inc.length > 0 && epsSeries.every((p) => p.value === null)) {
    gaps.push({
      field: "growth.epsDiluted",
      reason: "epsDiluted missing on all income rows",
      severity: "warn",
    });
  }

  const revenueCagrs = CAGR_WINDOWS.map((w) => cagrForWindow(revenueSeries, w));
  const epsDilutedCagrs = CAGR_WINDOWS.map((w) => cagrForWindow(epsSeries, w));
  const fcfCagrs = CAGR_WINDOWS.map((w) => cagrForWindow(fcfSeries, w));

  // A CAGR whose requested horizon was not met is still labelled "10y"/"5y"
  // downstream: the payload forwards windowYears but neither `actualYears` nor
  // the per-point note, so a 4-year span could be read and cited as a ten-year
  // compound growth rate. Fold the shortfall into GrowthResult.notes, which the
  // payload already serializes, so the horizon actually used is stated wherever
  // the figure is used.
  const pushHorizonNotes = (label: string, points: readonly CagrPoint[]): void => {
    for (const p of points) {
      if (p.cagrPct === null || !isFiniteNumber(p.actualYears)) continue;
      if (p.actualYears >= p.windowYears - 0.001) continue;
      notes.push(
        `${label} ${p.windowYears}y CAGR is computed over only ${p.actualYears.toFixed(1)} years ` +
          `(${p.startDate ?? "?"} → ${p.endDate ?? "?"}) — the full ${p.windowYears}-year history is unavailable; ` +
          "read it as that shorter span, not a full-horizon rate.",
      );
    }
  };
  pushHorizonNotes("Revenue", revenueCagrs);
  pushHorizonNotes("Diluted EPS", epsDilutedCagrs);
  pushHorizonNotes("Free cash flow", fcfCagrs);

  // --- Margin series + trend ---------------------------------------------------
  const marginRows = inc.slice(0, MARGIN_SERIES_MAX_YEARS).reverse(); // oldest → newest
  const buildMargin = (
    numerator: (r: GrowthIncomeRow) => number | null | undefined,
    label: string,
  ): MarginTrend => {
    const series: MarginPoint[] = marginRows.map((r) => {
      const num = numerator(r);
      const rev = r.revenue;
      if (!isFiniteNumber(num) || !isFiniteNumber(rev) || rev <= 0) {
        return { date: r.date, pct: null };
      }
      return { date: r.date, pct: (num / rev) * 100 };
    });
    const oldestDate = series[0]?.date;
    const slope = linearRegressionSlope(
      series.map((p) => ({
        x: oldestDate === undefined ? null : yearsBetweenDates(oldestDate, p.date),
        y: p.pct,
      })),
    );
    const trendNotes: string[] = [];
    if (series.some((p) => p.pct === null)) {
      trendNotes.push(`${label} margin null where revenue ≤ 0 or numerator missing`);
    }
    if (slope === null && series.length > 0) {
      trendNotes.push(
        `slope requires ≥${REGRESSION_MIN_POINTS} non-null annual points (house rule)`,
      );
    }
    if (hasIrregularAnnualSpacing(series.map((p) => p.date))) {
      trendNotes.push("irregular fiscal spacing detected — slope uses actual elapsed fiscal years");
    }
    return {
      series,
      slopePctPtsPerYear: slope,
      note: trendNotes.length > 0 ? trendNotes.join("; ") : undefined,
    };
  };

  const margins = {
    gross: buildMargin((r) => r.grossProfit, "gross"),
    operating: buildMargin((r) => r.operatingIncome, "operating"),
    net: buildMargin((r) => r.netIncome, "net"),
  };

  // --- Revenue acceleration: latest YoY vs 3y CAGR ------------------------------
  const yoyPoint = cagrForWindow(revenueSeries, 1);
  const threeYearPoint = revenueCagrs.find((c) => c.windowYears === 3) ?? cagrForWindow(revenueSeries, 3);
  // Latest YoY only counts when it truly spans ~1 year of history.
  const latestYoyPct =
    yoyPoint.cagrPct !== null && yoyPoint.actualYears !== null && yoyPoint.actualYears <= 1.5
      ? yoyPoint.cagrPct
      : null;
  const threeYearCagrPct = threeYearPoint.cagrPct;
  const accelNotes: string[] = [
    "revenue acceleration = latest YoY minus 3y CAGR (house framing per the application contract §4)",
  ];
  if (latestYoyPct === null) accelNotes.push("latest YoY unavailable");
  if (threeYearCagrPct === null) accelNotes.push("3y revenue CAGR unavailable");
  const deltaPctPts =
    latestYoyPct !== null && threeYearCagrPct !== null ? latestYoyPct - threeYearCagrPct : null;
  const revenueAcceleration: RevenueAcceleration = {
    latestYoyPct,
    threeYearCagrPct,
    deltaPctPts,
    accelerating: deltaPctPts !== null ? deltaPctPts > 0 : null,
    note: accelNotes.join("; "),
  };

  return {
    asOf,
    period: options.period,
    revenueCagrs,
    epsDilutedCagrs,
    fcfCagrs,
    margins,
    revenueAcceleration,
    notes,
    gaps,
  };
}
