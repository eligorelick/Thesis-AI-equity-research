/**
 * Stage B — Technicals. Pure, deterministic computation from EOD OHLCV rows
 * (FMP `historical-price-eod/full` field names: date/open/high/low/close/volume).
 * FMP indicator endpoints are NOT used — everything is computed locally
 * (the application contract §4, the provider data contract §2.7).
 *
 * Design rules honored here:
 * - No network / db / LLM. Plain typed inputs in, typed results out.
 * - Missing inputs never throw: partial results + ManifestEntry-compatible gaps.
 * - House-rule thresholds are annotated in `notes`/`flags`, never silent.
 * - Full precision returned; rounding only inside display strings (flags).
 *
 * Conventions (documented for the correctness oracle):
 * - RSI: Wilder smoothing, seed = simple average of the first `period` gains/losses.
 * - ATR: true range = max(h−l, |h−prevClose|, |l−prevClose|), defined from the
 *   second bar; seed = simple average of first `period` TRs, then Wilder smoothing.
 * - EMA: seeded with the SMA of the first n values, multiplier 2/(n+1).
 * - SMA cross / MACD crossover: sign tracking ignores exact-zero days; a cross is
 *   recorded on the first day the sign is nonzero AND opposite to the last
 *   nonzero sign (so touching equality without crossing is not a cross).
 * - Calendar windows (52w, RS, drawdowns) are date-based; SMA/RSI/ATR/MACD and
 *   volume averages are trading-row-based.
 */

import type { ManifestEntry } from "@/types/core";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** One EOD bar, FMP field names, rows sorted ASC by date. */
export interface OhlcvRow {
  /** ISO date "YYYY-MM-DD" (longer strings are truncated to the date part) */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Benchmark rows (SPY / sector ETF) share the same shape. */
export type BenchmarkRow = OhlcvRow;

// ---------------------------------------------------------------------------
// Small shared helpers (exported where useful for tests)
// ---------------------------------------------------------------------------

export interface SeriesPoint {
  date: string;
  value: number | null;
}

/** Normalize a row date to "YYYY-MM-DD"; returns null if unparseable. */
function isoDay(d: string): string | null {
  const s = d.length > 10 ? d.slice(0, 10) : d;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function epochUtc(dayIso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayIso);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Shift an ISO day by whole months, clamping the day-of-month (Mar 31 −1mo → Feb 28/29). */
export function shiftMonths(dayIso: string, deltaMonths: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dayIso);
  if (!m) return dayIso;
  const y = Number(m[1]);
  const mo0 = Number(m[2]) - 1 + deltaMonths;
  const y2 = y + Math.floor(mo0 / 12);
  const m2 = ((mo0 % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(y2, m2 + 1, 0)).getUTCDate();
  const d2 = Math.min(Number(m[3]), lastDay);
  return `${y2}-${pad2(m2 + 1)}-${pad2(d2)}`;
}

/**
 * Sanitize an input series: drop rows with unparseable dates or non-finite /
 * non-positive prices, truncate datetimes to days, and re-sort ASC if the
 * caller's contract (sorted ASC) was violated. Never throws.
 */
export function sanitizeRows(
  rows: readonly OhlcvRow[] | null | undefined,
  label: string,
): { rows: OhlcvRow[]; notes: string[] } {
  const notes: string[] = [];
  if (!rows || rows.length === 0) return { rows: [], notes };
  const clean: OhlcvRow[] = [];
  let dropped = 0;
  for (const r of rows) {
    const day = typeof r.date === "string" ? isoDay(r.date) : null;
    const ok =
      day !== null &&
      Number.isFinite(r.open) &&
      Number.isFinite(r.high) &&
      Number.isFinite(r.low) &&
      Number.isFinite(r.close) &&
      Number.isFinite(r.volume) &&
      r.close > 0 &&
      r.high > 0 &&
      r.low > 0 &&
      r.volume >= 0;
    if (!ok) {
      dropped += 1;
      continue;
    }
    clean.push({ ...r, date: day });
  }
  if (dropped > 0) {
    notes.push(`${label}: dropped ${dropped} row(s) with invalid dates or non-finite/non-positive values.`);
  }
  let sorted = true;
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].date < clean[i - 1].date) {
      sorted = false;
      break;
    }
  }
  if (!sorted) {
    clean.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    notes.push(`${label}: input rows were not sorted ASC by date — re-sorted defensively.`);
  }
  return { rows: clean, notes };
}

// ---------------------------------------------------------------------------
// SMA + golden/death cross
// ---------------------------------------------------------------------------

/** Simple moving average of closes; value is null until n rows are available. */
export function sma(rows: readonly OhlcvRow[], n: number): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  if (!Number.isInteger(n) || n <= 0) {
    for (const r of rows) out.push({ date: r.date, value: null });
    return out;
  }
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    sum += rows[i].close;
    if (i >= n) sum -= rows[i - n].close;
    out.push({ date: rows[i].date, value: i >= n - 1 ? sum / n : null });
  }
  return out;
}

export type CrossType = "golden" | "death";

export interface SmaCrossState {
  /** Latest SMA(fast) — null when history < fast rows */
  sma50: number | null;
  /** Latest SMA(slow) — null when history < slow rows */
  sma200: number | null;
  /**
   * Current regime: "golden" when SMA(fast) above SMA(slow), "death" when
   * below (per last nonzero sign — exact equality keeps the prior regime),
   * "none" when the slow SMA never existed or the spread was never nonzero.
   */
  state: CrossType | "none";
  /** Date of the most recent observed cross within the supplied history, if any */
  lastCrossDate: string | null;
  lastCrossType: CrossType | null;
}

/** SMA(fast)/SMA(slow) cross detection with exact-equality handling (see header). */
export function smaCross(rows: readonly OhlcvRow[], fast = 50, slow = 200): SmaCrossState {
  const fastS = sma(rows, fast);
  const slowS = sma(rows, slow);
  let lastSign = 0;
  let lastCrossDate: string | null = null;
  let lastCrossType: CrossType | null = null;
  for (let i = 0; i < rows.length; i++) {
    const f = fastS[i].value;
    const s = slowS[i].value;
    if (f === null || s === null) continue;
    const diff = f - s;
    const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    if (sign === 0) continue; // exact equality: not a cross by itself
    if (lastSign !== 0 && sign !== lastSign) {
      lastCrossDate = rows[i].date;
      lastCrossType = sign > 0 ? "golden" : "death";
    }
    lastSign = sign;
  }
  const smaFastNow = rows.length > 0 ? fastS[rows.length - 1].value : null;
  const smaSlowNow = rows.length > 0 ? slowS[rows.length - 1].value : null;
  return {
    sma50: smaFastNow,
    sma200: smaSlowNow,
    state: lastSign > 0 ? "golden" : lastSign < 0 ? "death" : "none",
    lastCrossDate,
    lastCrossType,
  };
}

// ---------------------------------------------------------------------------
// RSI (Wilder)
// ---------------------------------------------------------------------------

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0 && avgGain === 0) return 50; // flat series — conventional midpoint (documented)
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Wilder RSI over a close series. Seed = simple average of the first `period`
 * gains/losses; thereafter avg = (prevAvg·(period−1) + current)/period.
 * Output aligned to input; null until index `period`.
 */
export function rsiSeries(closes: readonly number[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array<number | null>(closes.length).fill(null);
  if (!Number.isInteger(period) || period <= 0 || closes.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d;
    else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

export interface RsiResult {
  value: number | null;
  asOf: string | null;
}

/** Latest RSI(period) from OHLCV rows (uses closes). Null when rows ≤ period. */
export function rsi14(rows: readonly OhlcvRow[], period = 14): RsiResult {
  if (rows.length === 0) return { value: null, asOf: null };
  const series = rsiSeries(rows.map((r) => r.close), period);
  return { value: series[series.length - 1], asOf: rows[rows.length - 1].date };
}

// ---------------------------------------------------------------------------
// EMA + MACD
// ---------------------------------------------------------------------------

/** EMA seeded with the SMA of the first n values; null until index n−1. */
export function emaSeries(values: readonly number[], n: number): Array<number | null> {
  const out: Array<number | null> = new Array<number | null>(values.length).fill(null);
  if (!Number.isInteger(n) || n <= 0 || values.length < n) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  let ema = sum / n;
  out[n - 1] = ema;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

export type MacdCrossType = "bullish" | "bearish";

export interface MacdSnapshot {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
  /** Regime by last nonzero histogram sign; "none" when signal never existed */
  state: MacdCrossType | "none";
  lastCrossoverDate: string | null;
  lastCrossoverType: MacdCrossType | null;
  /** Trading bars since the last signal-line crossover (0 = crossed on the last bar) */
  barsSinceCrossover: number | null;
  asOf: string | null;
}

/** MACD(fast, slow, signal) on closes with signal-line crossover tracking. */
export function macd(
  rows: readonly OhlcvRow[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdSnapshot {
  const empty: MacdSnapshot = {
    macd: null,
    signal: null,
    histogram: null,
    state: "none",
    lastCrossoverDate: null,
    lastCrossoverType: null,
    barsSinceCrossover: null,
    asOf: rows.length > 0 ? rows[rows.length - 1].date : null,
  };
  if (rows.length < slow) return empty;
  const closes = rows.map((r) => r.close);
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  const macdVals: number[] = [];
  const macdDates: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const f = fastE[i];
    const s = slowE[i];
    if (f === null || s === null) continue;
    macdVals.push(f - s);
    macdDates.push(rows[i].date);
  }
  const signalArr = emaSeries(macdVals, signalPeriod);
  let lastSign = 0;
  let lastCrossIdx = -1;
  let lastCrossType: MacdCrossType | null = null;
  for (let j = 0; j < macdVals.length; j++) {
    const s = signalArr[j];
    if (s === null) continue;
    const h = macdVals[j] - s;
    const sign = h > 0 ? 1 : h < 0 ? -1 : 0;
    if (sign === 0) continue;
    if (lastSign !== 0 && sign !== lastSign) {
      lastCrossIdx = j;
      lastCrossType = sign > 0 ? "bullish" : "bearish";
    }
    lastSign = sign;
  }
  const lastMacd = macdVals.length > 0 ? macdVals[macdVals.length - 1] : null;
  const lastSignal = signalArr.length > 0 ? signalArr[signalArr.length - 1] : null;
  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram: lastMacd !== null && lastSignal !== null ? lastMacd - lastSignal : null,
    state: lastSign > 0 ? "bullish" : lastSign < 0 ? "bearish" : "none",
    lastCrossoverDate: lastCrossIdx >= 0 ? macdDates[lastCrossIdx] : null,
    lastCrossoverType: lastCrossType,
    barsSinceCrossover: lastCrossIdx >= 0 ? macdVals.length - 1 - lastCrossIdx : null,
    asOf: rows[rows.length - 1].date,
  };
}

// ---------------------------------------------------------------------------
// 52-week range position
// ---------------------------------------------------------------------------

export interface Range52w {
  /** Highest intraday high in the trailing 12 calendar months */
  high52w: number | null;
  /** Lowest intraday low in the trailing 12 calendar months */
  low52w: number | null;
  /** Date of the most recent occurrence of each extreme */
  highDate: string | null;
  lowDate: string | null;
  /** (close/high − 1)·100 — ≤ 0 when below the high */
  pctFromHigh: number | null;
  /** (close/low − 1)·100 — ≥ 0 when above the low */
  pctFromLow: number | null;
  /** Absolute price distance (close − extreme) */
  distanceFromHigh: number | null;
  distanceFromLow: number | null;
  /** (close − low)/(high − low)·100; null when high == low */
  positionPct: number | null;
  asOf: string | null;
}

/** Position within the trailing-12-calendar-month high/low range. */
export function range52w(rows: readonly OhlcvRow[]): Range52w {
  const empty: Range52w = {
    high52w: null,
    low52w: null,
    highDate: null,
    lowDate: null,
    pctFromHigh: null,
    pctFromLow: null,
    distanceFromHigh: null,
    distanceFromLow: null,
    positionPct: null,
    asOf: null,
  };
  if (rows.length === 0) return empty;
  const last = rows[rows.length - 1];
  const cutoff = shiftMonths(last.date, -12);
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let highDate: string | null = null;
  let lowDate: string | null = null;
  for (const r of rows) {
    if (r.date < cutoff) continue;
    if (r.high >= high) {
      high = r.high;
      highDate = r.date;
    }
    if (r.low <= low) {
      low = r.low;
      lowDate = r.date;
    }
  }
  if (!Number.isFinite(high) || !Number.isFinite(low)) return { ...empty, asOf: last.date };
  const c = last.close;
  return {
    high52w: high,
    low52w: low,
    highDate,
    lowDate,
    pctFromHigh: high > 0 ? (c / high - 1) * 100 : null,
    pctFromLow: low > 0 ? (c / low - 1) * 100 : null,
    distanceFromHigh: c - high,
    distanceFromLow: c - low,
    positionPct: high > low ? ((c - low) / (high - low)) * 100 : null,
    asOf: last.date,
  };
}

// ---------------------------------------------------------------------------
// Relative strength vs benchmark
// ---------------------------------------------------------------------------

export interface RelativeStrengthPoint {
  months: 3 | 6 | 12;
  /** Close-to-close total price return over the window, percent */
  symbolReturnPct: number | null;
  benchmarkReturnPct: number | null;
  /** symbol − benchmark, percentage points; null when either side is missing */
  differentialPctPoints: number | null;
}

export interface RelativeStrengthSet {
  benchmarkSymbol: string;
  points: RelativeStrengthPoint[];
  notes: string[];
  gaps: ManifestEntry[];
  asOf: string | null;
}

const RS_WINDOWS: ReadonlyArray<3 | 6 | 12> = [3, 6, 12];

/** Last row with date ≤ cutoff (rows sorted ASC), else null. */
function rowAtOrBefore(rows: readonly OhlcvRow[], cutoff: string): OhlcvRow | null {
  let found: OhlcvRow | null = null;
  for (const r of rows) {
    if (r.date <= cutoff) found = r;
    else break;
  }
  return found;
}

/**
 * Total-return differential vs a benchmark over 3/6/12 months, close-to-close.
 * Dividends are unavailable in the EOD feed, so this approximates total return
 * (note emitted). Window start = last row at or before (lastDate − N months).
 */
export function relativeStrength(
  rows: readonly OhlcvRow[],
  benchmarkRows: readonly BenchmarkRow[],
  benchmarkSymbol: string,
  fieldPrefix = `technicals.relativeStrength.${benchmarkSymbol}`,
): RelativeStrengthSet {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const points: RelativeStrengthPoint[] = RS_WINDOWS.map((months) => ({
    months,
    symbolReturnPct: null,
    benchmarkReturnPct: null,
    differentialPctPoints: null,
  }));
  const asOf = rows.length > 0 ? rows[rows.length - 1].date : null;
  if (rows.length === 0) {
    gaps.push({
      field: fieldPrefix,
      reason: "no symbol price history supplied",
      severity: "warn",
    });
    return { benchmarkSymbol, points, notes, gaps, asOf };
  }
  if (benchmarkRows.length === 0) {
    gaps.push({
      field: fieldPrefix,
      reason: `no ${benchmarkSymbol} benchmark history supplied`,
      severity: "warn",
    });
  }
  notes.push(
    "Relative strength uses split-adjusted close-to-close price returns; dividends unavailable in the EOD feed, so figures approximate total return.",
  );
  const symLast = rows[rows.length - 1];
  const benchLast = benchmarkRows.length > 0 ? benchmarkRows[benchmarkRows.length - 1] : null;
  if (benchLast) {
    const driftDays = Math.abs(epochUtc(benchLast.date) - epochUtc(symLast.date)) / 86_400_000;
    if (Number.isFinite(driftDays) && driftDays > 7) {
      notes.push(
        `${benchmarkSymbol} history ends ${benchLast.date} vs symbol ${symLast.date} (>7 days apart) — differentials computed on mismatched end dates.`,
      );
    }
  }
  for (const point of points) {
    const cutoff = shiftMonths(symLast.date, -point.months);
    const symStart = rowAtOrBefore(rows, cutoff);
    if (symStart && symStart.close > 0) {
      point.symbolReturnPct = (symLast.close / symStart.close - 1) * 100;
    } else {
      gaps.push({
        field: `${fieldPrefix}.${point.months}mo`,
        reason: `insufficient symbol history for the ${point.months}-month window (need data at/before ${cutoff})`,
        severity: "info",
      });
    }
    if (benchLast) {
      const benchStart = rowAtOrBefore(benchmarkRows, cutoff);
      if (benchStart && benchStart.close > 0) {
        point.benchmarkReturnPct = (benchLast.close / benchStart.close - 1) * 100;
      } else {
        gaps.push({
          field: `${fieldPrefix}.${point.months}mo`,
          reason: `insufficient ${benchmarkSymbol} history for the ${point.months}-month window`,
          severity: "info",
        });
      }
    }
    if (point.symbolReturnPct !== null && point.benchmarkReturnPct !== null) {
      point.differentialPctPoints = point.symbolReturnPct - point.benchmarkReturnPct;
    }
  }
  return { benchmarkSymbol, points, notes, gaps, asOf };
}

// ---------------------------------------------------------------------------
// Volume trend
// ---------------------------------------------------------------------------

export interface VolumeTrend {
  /** Mean volume of the last 20 trading rows */
  avg20d: number | null;
  /** Mean volume of the last 90 trading rows */
  avg90d: number | null;
  /** avg20d / avg90d; null when either side missing or avg90d == 0 */
  ratio: number | null;
  /** House rule: rising ≥ 1.2, falling ≤ 0.8, else flat (annotated in notes) */
  state: "rising" | "falling" | "flat" | null;
  asOf: string | null;
}

/** House thresholds for the volume-trend label (annotated wherever used). */
export const VOLUME_TREND_RISING_RATIO = 1.2;
export const VOLUME_TREND_FALLING_RATIO = 0.8;

function meanVolume(rows: readonly OhlcvRow[], n: number): number | null {
  if (rows.length < n || n <= 0) return null;
  let sum = 0;
  for (let i = rows.length - n; i < rows.length; i++) sum += rows[i].volume;
  return sum / n;
}

/** 20-day vs 90-day average volume. */
export function volumeTrend(rows: readonly OhlcvRow[]): VolumeTrend {
  const asOf = rows.length > 0 ? rows[rows.length - 1].date : null;
  const avg20d = meanVolume(rows, 20);
  const avg90d = meanVolume(rows, 90);
  const ratio = avg20d !== null && avg90d !== null && avg90d > 0 ? avg20d / avg90d : null;
  const state =
    ratio === null
      ? null
      : ratio >= VOLUME_TREND_RISING_RATIO
        ? "rising"
        : ratio <= VOLUME_TREND_FALLING_RATIO
          ? "falling"
          : "flat";
  return { avg20d, avg90d, ratio, state, asOf };
}

// ---------------------------------------------------------------------------
// ATR (Wilder)
// ---------------------------------------------------------------------------

export interface TrueRangePoint {
  date: string;
  tr: number;
}

/** True ranges from the second bar on: max(h−l, |h−prevC|, |l−prevC|). */
export function trueRanges(rows: readonly OhlcvRow[]): TrueRangePoint[] {
  const out: TrueRangePoint[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const prevC = rows[i - 1].close;
    out.push({
      date: r.date,
      tr: Math.max(r.high - r.low, Math.abs(r.high - prevC), Math.abs(r.low - prevC)),
    });
  }
  return out;
}

export interface AtrResult {
  /** Wilder ATR(period), absolute price units */
  atr: number | null;
  /** ATR as % of the last close */
  atrPctOfClose: number | null;
  asOf: string | null;
}

/** Wilder ATR: seed = simple average of first `period` TRs, then Wilder smoothing. */
export function atr14(rows: readonly OhlcvRow[], period = 14): AtrResult {
  const asOf = rows.length > 0 ? rows[rows.length - 1].date : null;
  if (!Number.isInteger(period) || period <= 0) return { atr: null, atrPctOfClose: null, asOf };
  const trs = trueRanges(rows);
  if (trs.length < period) return { atr: null, atrPctOfClose: null, asOf };
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i].tr;
  atr /= period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i].tr) / period;
  }
  const lastClose = rows[rows.length - 1].close;
  return {
    atr,
    atrPctOfClose: lastClose > 0 ? (atr / lastClose) * 100 : null,
    asOf,
  };
}

// ---------------------------------------------------------------------------
// Max drawdown
// ---------------------------------------------------------------------------

export interface DrawdownResult {
  windowYears: number;
  /** Peak-to-trough decline as a POSITIVE percentage (e.g. 40 = −40%); 0 when no decline */
  depthPct: number | null;
  peakDate: string | null;
  troughDate: string | null;
  /** True when a later close regained the peak close; null when depth is 0/unknown */
  recovered: boolean | null;
  /** True when the supplied history does not span the full window */
  insufficientHistory: boolean;
  asOf: string | null;
}

/** Max close-to-close drawdown over the trailing `windowYears` calendar years. */
export function maxDrawdown(rows: readonly OhlcvRow[], windowYears: number): DrawdownResult {
  const empty: DrawdownResult = {
    windowYears,
    depthPct: null,
    peakDate: null,
    troughDate: null,
    recovered: null,
    insufficientHistory: true,
    asOf: null,
  };
  if (rows.length === 0 || windowYears <= 0) return empty;
  const last = rows[rows.length - 1];
  const cutoff = shiftMonths(last.date, -Math.round(windowYears * 12));
  const insufficientHistory = rows[0].date > cutoff;
  const win = rows.filter((r) => r.date >= cutoff);
  if (win.length === 0) return { ...empty, asOf: last.date };
  let peak = Number.NEGATIVE_INFINITY;
  let peakDate: string | null = null;
  let bestDepth = 0;
  let bestPeakClose = 0;
  let bestPeakDate: string | null = null;
  let bestTroughDate: string | null = null;
  let bestTroughIdx = -1;
  for (let i = 0; i < win.length; i++) {
    const r = win[i];
    if (r.close > peak) {
      peak = r.close;
      peakDate = r.date;
    }
    const dd = peak > 0 ? (peak - r.close) / peak : 0;
    if (dd > bestDepth) {
      bestDepth = dd;
      bestPeakClose = peak;
      bestPeakDate = peakDate;
      bestTroughDate = r.date;
      bestTroughIdx = i;
    }
  }
  if (bestDepth === 0) {
    return {
      windowYears,
      depthPct: 0,
      peakDate: null,
      troughDate: null,
      recovered: null,
      insufficientHistory,
      asOf: last.date,
    };
  }
  let recovered = false;
  for (let i = bestTroughIdx + 1; i < win.length; i++) {
    if (win[i].close >= bestPeakClose) {
      recovered = true;
      break;
    }
  }
  return {
    windowYears,
    depthPct: bestDepth * 100,
    peakDate: bestPeakDate,
    troughDate: bestTroughDate,
    recovered,
    insufficientHistory,
    asOf: last.date,
  };
}

// ---------------------------------------------------------------------------
// Overall technicals result
// ---------------------------------------------------------------------------

/** House thresholds for the structured read (annotated in notes). */
export const RSI_OVERBOUGHT = 70;
export const RSI_OVERSOLD = 30;
/** MACD crossover counts as "recent" (flag-worthy) within this many bars. */
export const MACD_RECENT_CROSS_BARS = 10;
/** "Near 52w high/low" flag thresholds, percent. */
export const NEAR_HIGH_PCT = 5;
export const NEAR_LOW_PCT = 10;
/** 1y drawdown depth that earns a flag, percent. */
export const DEEP_DRAWDOWN_FLAG_PCT = 30;

export type TrendRead = "uptrend" | "downtrend" | "sideways" | "insufficient-data";
export type MomentumRead =
  | "overbought"
  | "bullish"
  | "neutral"
  | "bearish"
  | "oversold"
  | "insufficient-data";

export interface TechnicalsRead {
  trend: TrendRead;
  momentum: MomentumRead;
  keyLevels: {
    sma50: number | null;
    sma200: number | null;
    high52w: number | null;
    low52w: number | null;
  };
  /** Plain-English relative-strength summary (or "unavailable") */
  relativeStrength: string;
  /** Plain-English flags, e.g. "Price 8.0% below SMA200 with death cross on 2026-03-14" */
  flags: string[];
}

export interface TechnicalsResult {
  asOf: string | null;
  lastClose: number | null;
  rowsUsed: number;
  smaCross: SmaCrossState;
  rsi14: number | null;
  macd: MacdSnapshot;
  range52w: Range52w;
  relativeStrength: {
    benchmark: RelativeStrengthSet;
    sector: RelativeStrengthSet | null;
  };
  volumeTrend: VolumeTrend;
  atr14: AtrResult;
  drawdowns: DrawdownResult[];
  read: TechnicalsRead;
  /** House-rule annotations + methodology notes (approximations, re-sorts, …) */
  notes: string[];
  /** ManifestEntry-compatible gap disclosures — missing inputs never throw */
  gaps: ManifestEntry[];
}

const fmt1 = (x: number): string => Math.abs(x).toFixed(1);
const signed1 = (x: number): string => `${x >= 0 ? "+" : "−"}${fmt1(x)}`;

function bestRsPoint(set: RelativeStrengthSet): RelativeStrengthPoint | null {
  for (const months of [12, 6, 3] as const) {
    const p = set.points.find((q) => q.months === months);
    if (p && p.differentialPctPoints !== null) return p;
  }
  return null;
}

function trendRead(lastClose: number, cross: SmaCrossState, notes: string[]): TrendRead {
  const { sma50: s50, sma200: s200 } = cross;
  if (s50 !== null && s200 !== null) {
    if (lastClose > s200 && s50 > s200) return "uptrend";
    if (lastClose < s200 && s50 < s200) return "downtrend";
    return "sideways";
  }
  if (s50 !== null) {
    notes.push(
      "Trend label degraded to SMA50-only (±2% band) because SMA200 is unavailable — house rule.",
    );
    if (lastClose > s50 * 1.02) return "uptrend";
    if (lastClose < s50 * 0.98) return "downtrend";
    return "sideways";
  }
  return "insufficient-data";
}

function momentumRead(rsi: number | null, hist: number | null): MomentumRead {
  if (rsi === null && hist === null) return "insufficient-data";
  if (rsi !== null) {
    if (rsi >= RSI_OVERBOUGHT) return "overbought";
    if (rsi <= RSI_OVERSOLD) return "oversold";
  }
  if (hist !== null && hist > 0 && (rsi === null || rsi >= 50)) return "bullish";
  if (hist !== null && hist < 0 && (rsi === null || rsi < 50)) return "bearish";
  return "neutral";
}

/**
 * Compute the full technicals block from EOD OHLCV rows plus SPY and sector-ETF
 * benchmark rows. Pure and total: bad/missing inputs degrade to nulls + gaps.
 *
 * @param rows            symbol EOD rows sorted ASC (FMP historical-price-eod/full)
 * @param spy             SPY EOD rows sorted ASC (market benchmark)
 * @param sectorEtf       sector-ETF EOD rows sorted ASC (may be empty)
 * @param sectorEtfSymbol sector-ETF ticker (e.g. "XLK"), or null when unrouted
 */
export function computeTechnicals(
  rows: readonly OhlcvRow[],
  spy: readonly BenchmarkRow[],
  sectorEtf: readonly BenchmarkRow[],
  sectorEtfSymbol: string | null,
): TechnicalsResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];

  const symbolClean = sanitizeRows(rows, "symbol");
  const spyClean = sanitizeRows(spy, "SPY");
  const sectorClean = sanitizeRows(sectorEtf, sectorEtfSymbol ?? "sector ETF");
  notes.push(...symbolClean.notes, ...spyClean.notes, ...sectorClean.notes);
  const px = symbolClean.rows;

  const emptyRead: TechnicalsRead = {
    trend: "insufficient-data",
    momentum: "insufficient-data",
    keyLevels: { sma50: null, sma200: null, high52w: null, low52w: null },
    relativeStrength: "unavailable",
    flags: [],
  };

  if (px.length === 0) {
    gaps.push({
      field: "technicals",
      reason: "no usable price history supplied",
      severity: "critical",
      attemptedSources: ["fmp historical-price-eod/full"],
    });
    return {
      asOf: null,
      lastClose: null,
      rowsUsed: 0,
      smaCross: { sma50: null, sma200: null, state: "none", lastCrossDate: null, lastCrossType: null },
      rsi14: null,
      macd: macd(px),
      range52w: range52w(px),
      relativeStrength: {
        benchmark: relativeStrength(px, spyClean.rows, "SPY"),
        sector: null,
      },
      volumeTrend: volumeTrend(px),
      atr14: atr14(px),
      drawdowns: [1, 3, 5].map((y) => maxDrawdown(px, y)),
      read: emptyRead,
      notes,
      gaps,
    };
  }

  const last = px[px.length - 1];
  const cross = smaCross(px, 50, 200);
  const rsi = rsi14(px);
  const macdSnap = macd(px);
  const range = range52w(px);
  const vol = volumeTrend(px);
  const atr = atr14(px);
  const drawdowns = [1, 3, 5].map((y) => maxDrawdown(px, y));

  const rsBenchmark = relativeStrength(px, spyClean.rows, "SPY", "technicals.relativeStrength.SPY");
  let rsSector: RelativeStrengthSet | null = null;
  if (sectorEtfSymbol && sectorClean.rows.length > 0) {
    rsSector = relativeStrength(
      px,
      sectorClean.rows,
      sectorEtfSymbol,
      `technicals.relativeStrength.${sectorEtfSymbol}`,
    );
  } else {
    gaps.push({
      field: "technicals.relativeStrength.sector",
      reason: sectorEtfSymbol
        ? `no ${sectorEtfSymbol} history supplied`
        : "no sector ETF resolved for this symbol",
      severity: "info",
    });
  }
  const dedupNotes = new Set<string>();
  for (const set of [rsBenchmark, ...(rsSector ? [rsSector] : [])]) {
    gaps.push(...set.gaps);
    for (const n of set.notes) dedupNotes.add(n);
  }
  notes.push(...dedupNotes);

  // --- degradation gaps ------------------------------------------------------
  if (px.length < 200) {
    gaps.push({
      field: "technicals.sma200",
      reason: `only ${px.length} trading rows available (<200) — SMA200/cross state unavailable (recent-IPO overlay case)`,
      severity: "info",
    });
  }
  if (px.length < 15) {
    gaps.push({
      field: "technicals.rsi14",
      reason: `only ${px.length} rows (<15) — RSI-14 unavailable`,
      severity: "warn",
    });
    gaps.push({
      field: "technicals.atr14",
      reason: `only ${px.length} rows (<15) — ATR-14 unavailable`,
      severity: "warn",
    });
  }
  if (px.length < 35) {
    gaps.push({
      field: "technicals.macd",
      reason: `only ${px.length} rows (<35) — MACD signal line unavailable`,
      severity: "warn",
    });
  }
  for (const dd of drawdowns) {
    if (dd.insufficientHistory && dd.windowYears > 1) {
      gaps.push({
        field: `technicals.drawdown.${dd.windowYears}y`,
        reason: `history does not span the full ${dd.windowYears}-year window — drawdown computed over available rows only`,
        severity: "info",
      });
    }
  }

  // --- house-rule annotations ------------------------------------------------
  notes.push(
    `House rules: trend = close & SMA50 vs SMA200; momentum = RSI-14 (overbought ≥${RSI_OVERBOUGHT}, oversold ≤${RSI_OVERSOLD}) + MACD histogram; volume trend rising/falling at ${VOLUME_TREND_RISING_RATIO}×/${VOLUME_TREND_FALLING_RATIO}× of the 90-day average; “near 52-week high/low” within ${NEAR_HIGH_PCT}%/${NEAR_LOW_PCT}%; deep-drawdown flag at ${DEEP_DRAWDOWN_FLAG_PCT}% (1y).`,
  );

  // --- structured read + flags ----------------------------------------------
  const flags: string[] = [];
  const trend = trendRead(last.close, cross, notes);
  const momentum = momentumRead(rsi.value, macdSnap.histogram);

  if (cross.sma200 !== null && cross.sma200 > 0) {
    const pctVs200 = (last.close / cross.sma200 - 1) * 100;
    const crossSuffix =
      cross.lastCrossDate && cross.lastCrossType
        ? ` with ${cross.lastCrossType} cross on ${cross.lastCrossDate}`
        : "";
    flags.push(
      `Price ${fmt1(pctVs200)}% ${pctVs200 >= 0 ? "above" : "below"} SMA200${crossSuffix}.`,
    );
  } else {
    flags.push(
      `Only ${px.length} sessions of price history — SMA200 and long-window technicals unavailable (recent-IPO overlay).`,
    );
  }
  if (rsi.value !== null && rsi.value >= RSI_OVERBOUGHT) {
    flags.push(`RSI-14 at ${fmt1(rsi.value)} — overbought (house threshold ${RSI_OVERBOUGHT}).`);
  } else if (rsi.value !== null && rsi.value <= RSI_OVERSOLD) {
    flags.push(`RSI-14 at ${fmt1(rsi.value)} — oversold (house threshold ${RSI_OVERSOLD}).`);
  }
  if (
    macdSnap.barsSinceCrossover !== null &&
    macdSnap.barsSinceCrossover <= MACD_RECENT_CROSS_BARS &&
    macdSnap.lastCrossoverType &&
    macdSnap.lastCrossoverDate
  ) {
    flags.push(
      `MACD ${macdSnap.lastCrossoverType} crossover ${macdSnap.barsSinceCrossover} session(s) ago (${macdSnap.lastCrossoverDate}).`,
    );
  }
  if (range.pctFromHigh !== null && range.pctFromHigh >= -NEAR_HIGH_PCT && range.high52w !== null) {
    flags.push(
      `Price within ${fmt1(range.pctFromHigh)}% of the 52-week high (${range.high52w} on ${range.highDate ?? "n/a"}).`,
    );
  }
  if (range.pctFromLow !== null && range.pctFromLow <= NEAR_LOW_PCT && range.low52w !== null) {
    flags.push(
      `Price within ${fmt1(range.pctFromLow)}% of the 52-week low (${range.low52w} on ${range.lowDate ?? "n/a"}).`,
    );
  }
  const rsBest = bestRsPoint(rsBenchmark);
  if (rsBest && rsBest.differentialPctPoints !== null) {
    flags.push(
      `${rsBest.differentialPctPoints >= 0 ? "Outperformed" : "Underperformed"} SPY by ${fmt1(rsBest.differentialPctPoints)} pct pts over ${rsBest.months}mo (close-to-close).`,
    );
  }
  const rsSectorBest = rsSector ? bestRsPoint(rsSector) : null;
  if (rsSector && rsSectorBest && rsSectorBest.differentialPctPoints !== null) {
    flags.push(
      `${rsSectorBest.differentialPctPoints >= 0 ? "Outperformed" : "Underperformed"} ${rsSector.benchmarkSymbol} by ${fmt1(rsSectorBest.differentialPctPoints)} pct pts over ${rsSectorBest.months}mo (close-to-close).`,
    );
  }
  if (vol.state === "rising" && vol.ratio !== null) {
    flags.push(`20-day average volume ${fmt1((vol.ratio - 1) * 100)}% above the 90-day average.`);
  } else if (vol.state === "falling" && vol.ratio !== null) {
    flags.push(`20-day average volume ${fmt1((1 - vol.ratio) * 100)}% below the 90-day average.`);
  }
  const dd1y = drawdowns.find((d) => d.windowYears === 1);
  if (dd1y && dd1y.depthPct !== null && dd1y.depthPct >= DEEP_DRAWDOWN_FLAG_PCT) {
    flags.push(
      `Max 1y drawdown ${fmt1(dd1y.depthPct)}% (peak ${dd1y.peakDate ?? "n/a"} → trough ${dd1y.troughDate ?? "n/a"}), ${dd1y.recovered ? "since recovered" : "not yet recovered"}.`,
    );
  }

  let rsSummary = "unavailable";
  if (rsBest && rsBest.differentialPctPoints !== null) {
    rsSummary = `${signed1(rsBest.differentialPctPoints)} pct pts vs SPY (${rsBest.months}mo)`;
    if (rsSector && rsSectorBest && rsSectorBest.differentialPctPoints !== null) {
      rsSummary += `; ${signed1(rsSectorBest.differentialPctPoints)} vs ${rsSector.benchmarkSymbol} (${rsSectorBest.months}mo)`;
    }
    rsSummary += " — close-to-close, dividends excluded";
  }

  return {
    asOf: last.date,
    lastClose: last.close,
    rowsUsed: px.length,
    smaCross: cross,
    rsi14: rsi.value,
    macd: macdSnap,
    range52w: range,
    relativeStrength: { benchmark: rsBenchmark, sector: rsSector },
    volumeTrend: vol,
    atr14: atr,
    drawdowns,
    read: {
      trend,
      momentum,
      keyLevels: {
        sma50: cross.sma50,
        sma200: cross.sma200,
        high52w: range.high52w,
        low52w: range.low52w,
      },
      relativeStrength: rsSummary,
      flags,
    },
    notes,
    gaps,
  };
}
