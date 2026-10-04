// src/pipeline/stageB/betaEstimate.ts
/**
 * Levered beta from monthly returns — the keyless replacement for the vendor
 * profile beta.
 *
 * Method: ordinary least squares of the symbol's monthly log return on the
 * benchmark's over the last `maxMonths` (60) calendar months ending at their
 * newest shared month-end. Only consecutive calendar months form a return.
 * This follows a 5-year-monthly window convention. Fewer than
 * `minMonths` (24) shared returns is a disclosed gap, not a number.
 *
 * D-15 additions:
 *  - Returns are built from the DIVIDEND-ADJUSTED close when both series carry
 *    one. A price-only series understates the return of a dividend payer in
 *    every month it goes ex-dividend, which biases the estimate; the adjusted
 *    close is what makes the two series comparable. When either side lacks it
 *    the estimator falls back to the plain close and says so — it never mixes
 *    an adjusted series with an unadjusted one.
 *  - The regression's uncertainty is reported, not only its point estimate:
 *    the OLS standard error of the slope, beside R². A beta of 1.2 ± 0.05 and
 *    a beta of 1.2 ± 0.40 are different facts about a discount rate.
 *  - The Blume mean-reversion adjustment is reported BESIDE the raw estimate,
 *    never instead of it, so a reader sees both and knows which one any
 *    downstream WACC used.
 *
 * Pure and deterministic.
 */
import type { ManifestEntry } from "@/types/core";

export interface ClosePoint {
  date: string;
  close: number;
  /**
   * Dividend-adjusted close for the same session, when the source carries one
   * (Yahoo's chart `adjclose`). Null or absent means the source served a
   * split-adjusted price only.
   */
  adjClose?: number | null;
}

/** Which price series the returns were built from. */
export type BetaPriceBasis = "dividend-adjusted close" | "close";

export interface BetaEstimate {
  beta: number | null;
  months: number;
  windowStart: string | null;
  windowEnd: string | null;
  rSquared: number | null;
  /** OLS standard error of the slope; null when beta is null. */
  standardError: number | null;
  /**
   * The Blume mean-reversion adjustment of the raw slope, reported beside it
   * and never in place of it. Null when beta is null.
   */
  betaBlume: number | null;
  /** Which price series produced the returns. */
  basis: BetaPriceBasis;
  note: string;
  /** The failure gap when no beta could be estimated. */
  gap: ManifestEntry | null;
  /**
   * The methodology disclosure that accompanies a SUCCESSFUL estimate: price
   * basis, window, standard error, R² and the Blume figure. `warn` when the
   * returns are price-only, `info` when they are dividend-adjusted.
   */
  disclosure: ManifestEntry | null;
}

export const BETA_MAX_MONTHS = 60;
export const BETA_MIN_MONTHS = 24;

/**
 * Mean-reversion adjustment: two thirds of the measured slope plus one third
 * of the market beta of 1.
 *
 * This is the BLOOMBERG weighting, which standardises the finding in Blume
 * (1971) that betas revert toward 1 — it is not Blume's own fitted regression,
 * which was `0.371 + 0.635·beta`. Both shrink toward 1 and differ by a few
 * hundredths in practice, but the two are routinely conflated and the field
 * name should not imply a precision the number does not have. Blume's
 * coefficients were fitted on 1960s US data; the 2/3 weighting is a convention,
 * not an estimate for this issuer or period. See docs/RESEARCH.md §7.1.
 *
 * Reported alongside the raw estimate; which one to use is the consumer's
 * choice, and the disclosure names both.
 */
export const BLUME_RAW_WEIGHT = 2 / 3;
export const BLUME_MARKET_WEIGHT = 1 / 3;

export function blumeAdjust(beta: number): number {
  return BLUME_RAW_WEIGHT * beta + BLUME_MARKET_WEIGHT;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Gregorian Easter; Good Friday is two calendar days before this Sunday. */
function easterUtc(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = (h + l - 7 * m + 114) % 31 + 1;
  return new Date(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00Z`);
}

/**
 * Regular NYSE month-end session: weekends, Memorial Day and Good Friday
 * are the only regular closures that can move the last weekday of a month.
 * Early closes remain sessions. NYSE does not observe a Saturday January 1
 * on December 31. Exceptional closures and other exchanges are not modelled.
 * https://www.nyse.com/trade/hours-calendars
 */
export function isMonthComplete(isoDate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false;
  const observed = new Date(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(observed.getTime()) || observed.toISOString().slice(0, 10) !== isoDate) return false;
  const year = observed.getUTCFullYear();
  const month = observed.getUTCMonth();
  const end = new Date(observed);
  end.setUTCMonth(month + 1, 0);
  const goodFriday = easterUtc(year);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  for (;;) {
    const weekday = end.getUTCDay();
    const memorialDay = month === 4 && weekday === 1 && end.getUTCDate() >= 25;
    if (weekday !== 0 && weekday !== 6 && !memorialDay && end.getTime() !== goodFriday.getTime()) break;
    end.setUTCDate(end.getUTCDate() - 1);
  }
  return observed.getTime() === end.getTime();
}

/** Last observation of each calendar month, newest first. */
export function monthEndCloses(points: readonly ClosePoint[]): ClosePoint[] {
  const byMonth = new Map<string, ClosePoint>();
  for (const point of points) {
    if (!isFiniteNumber(point.close) || point.close <= 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date)) continue;
    const key = point.date.slice(0, 7);
    const current = byMonth.get(key);
    if (current === undefined || point.date > current.date) byMonth.set(key, point);
  }
  return [...byMonth.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** A usable dividend-adjusted price, or null when the source served none. */
function adjustedOf(point: ClosePoint): number | null {
  return isFiniteNumber(point.adjClose) && point.adjClose > 0 ? point.adjClose : null;
}

function calendarMonth(isoDate: string): number {
  return Number(isoDate.slice(0, 4)) * 12 + Number(isoDate.slice(5, 7)) - 1;
}

export function estimateBeta(
  symbolCloses: readonly ClosePoint[],
  benchmarkCloses: readonly ClosePoint[],
  opts: { maxMonths?: number; minMonths?: number } = {},
): BetaEstimate {
  const maxMonths = opts.maxMonths ?? BETA_MAX_MONTHS;
  const minMonths = opts.minMonths ?? BETA_MIN_MONTHS;
  const symbolEndsAll = monthEndCloses(symbolCloses);
  const benchEndsAll = monthEndCloses(benchmarkCloses);
  // Neither a partial current month nor an older month missing its final
  // session is a completed monthly observation. Require the actual same
  // regular US month-end session on both sides; never fill missing closes.
  const partialMonths = new Set<string>();
  for (const point of [...symbolEndsAll, ...benchEndsAll]) {
    if (!isMonthComplete(point.date)) partialMonths.add(point.date.slice(0, 7));
  }
  const symbolEnds = symbolEndsAll.filter((p) => !partialMonths.has(p.date.slice(0, 7)));
  const benchByMonth = new Map(
    benchEndsAll.filter((p) => !partialMonths.has(p.date.slice(0, 7))).map((p) => [p.date.slice(0, 7), p]),
  );
  const partialMonthNote =
    partialMonths.size === 0
      ? ""
      : `; partial or incomplete month ${[...partialMonths].sort().join(", ")} excluded (regular NYSE final-session close required)`;
  const calendarNote = "; regular NYSE month-end session calendar (exceptional closures and other exchanges not modelled)";
  // A missing level must neither extend the calendar window nor turn a
  // multi-month change into a monthly observation.
  const sharedEnds = symbolEnds.filter((p) => benchByMonth.has(p.date.slice(0, 7)));
  const newestMonth = sharedEnds[0] === undefined ? null : calendarMonth(sharedEnds[0].date);
  const shared = sharedEnds
    .filter((p) => newestMonth !== null && newestMonth - calendarMonth(p.date) <= maxMonths)
    .reverse(); // oldest → newest for return construction

  // The adjusted series is used only when EVERY level of BOTH series in the
  // window carries one. A window that changed basis part-way through, or a
  // stock regressed against an unadjusted benchmark, would produce a number
  // that is neither one thing nor the other.
  const adjustedThroughout =
    shared.length > 0 &&
    shared.every((p) => adjustedOf(p) !== null && adjustedOf(benchByMonth.get(p.date.slice(0, 7))!) !== null);
  const basis: BetaPriceBasis = adjustedThroughout ? "dividend-adjusted close" : "close";
  const priceOf = (p: ClosePoint): number => (adjustedThroughout ? adjustedOf(p)! : p.close);

  const returns: { s: number; b: number }[] = [];
  let skippedIntervals = 0;
  for (let i = 1; i < shared.length; i++) {
    const s0 = shared[i - 1]!;
    const s1 = shared[i]!;
    if (calendarMonth(s1.date) - calendarMonth(s0.date) !== 1) {
      skippedIntervals++;
      continue;
    }
    const b0 = benchByMonth.get(s0.date.slice(0, 7))!;
    const b1 = benchByMonth.get(s1.date.slice(0, 7))!;
    returns.push({
      s: Math.log(priceOf(s1) / priceOf(s0)),
      b: Math.log(priceOf(b1) / priceOf(b0)),
    });
  }
  const months = returns.length;
  const windowStart = shared[0]?.date ?? null;
  const windowEnd = shared[shared.length - 1]?.date ?? null;
  const missingMonthNote = skippedIntervals === 0
    ? ""
    : `; ${skippedIntervals} non-monthly interval${skippedIntervals === 1 ? "" : "s"} across missing shared month-ends excluded`;
  const fail = (reason: string): BetaEstimate => ({
    beta: null,
    months,
    windowStart,
    windowEnd,
    rSquared: null,
    standardError: null,
    betaBlume: null,
    basis,
    note: `beta not estimated: ${reason}${missingMonthNote}${partialMonthNote}${calendarNote}`,
    gap: { field: "profile.beta", reason: `${reason}${missingMonthNote}`, severity: "warn", attemptedSources: ["computed:beta(monthly OLS vs SPY)"] },
    disclosure: null,
  });
  if (months < minMonths) {
    return fail(`only ${months} monthly returns shared with the benchmark; ${minMonths} required for a beta estimate`);
  }
  const meanS = returns.reduce((a, r) => a + r.s, 0) / months;
  const meanB = returns.reduce((a, r) => a + r.b, 0) / months;
  let cov = 0;
  let varB = 0;
  let varS = 0;
  for (const r of returns) {
    cov += (r.s - meanS) * (r.b - meanB);
    varB += (r.b - meanB) ** 2;
    varS += (r.s - meanS) ** 2;
  }
  if (varB <= 0) return fail("benchmark returns have zero variance over the window");
  const beta = cov / varB;
  const rSquared = varS > 0 ? (cov * cov) / (varB * varS) : null;
  // se(beta) = sqrt( SSE / (n − 2) / Sxx ), where SSE = Syy − beta·Sxy. The
  // clamp at zero is for floating point: a perfect fit can land a hair below.
  const sse = Math.max(0, varS - beta * cov);
  const standardError = months > 2 ? Math.sqrt(sse / (months - 2) / varB) : null;
  const betaBlume = blumeAdjust(beta);
  const priceNote =
    basis === "dividend-adjusted close"
      ? "dividend-adjusted closes"
      : "closing prices (no dividend-adjusted series was available for both the symbol and the benchmark, so a month with an ex-dividend date understates the return)";
  const note =
    `beta ${beta.toFixed(3)}` +
    (standardError === null ? "" : ` ± ${standardError.toFixed(3)} (OLS standard error)`) +
    `, Blume-adjusted ${betaBlume.toFixed(3)}, from ${months} monthly log returns of ${priceNote} vs the benchmark ` +
    `(${windowStart} → ${windowEnd}); a ${maxMonths}-calendar-month window convention${missingMonthNote}${partialMonthNote}${calendarNote}`;
  return {
    beta,
    months,
    windowStart,
    windowEnd,
    rSquared,
    standardError,
    betaBlume,
    basis,
    note,
    gap: null,
    disclosure: {
      field: "profile.beta.method",
      reason:
        `beta ${beta.toFixed(3)} is the OLS slope of ${months} monthly log returns on the benchmark's, ` +
        `${windowStart} to ${windowEnd}, built from ${priceNote}${missingMonthNote}` +
        (standardError === null ? "" : `; standard error ${standardError.toFixed(3)}`) +
        (rSquared === null ? "" : `, R² ${rSquared.toFixed(3)}`) +
        `; the Blume mean-reversion adjustment (${BLUME_RAW_WEIGHT.toFixed(3)}×raw + ${BLUME_MARKET_WEIGHT.toFixed(3)}) gives ` +
        `${betaBlume.toFixed(3)} and is reported beside the raw slope, not in place of it`,
      severity: basis === "dividend-adjusted close" ? "info" : "warn",
      attemptedSources: ["computed:beta(monthly OLS vs SPY)"],
      ...(basis === "dividend-adjusted close" ? { expected: true } : {}),
    },
  };
}
