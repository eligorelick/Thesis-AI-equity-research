// src/pipeline/stageB/betaEstimate.ts
/**
 * Levered beta from monthly returns — the keyless replacement for the vendor
 * profile beta.
 *
 * Method: ordinary least squares of the symbol's monthly log return on the
 * benchmark's over the last `maxMonths` (60) month-ends both series share,
 * i.e. the same 5-year-monthly convention vendors publish. Fewer than
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

export function estimateBeta(
  symbolCloses: readonly ClosePoint[],
  benchmarkCloses: readonly ClosePoint[],
  opts: { maxMonths?: number; minMonths?: number } = {},
): BetaEstimate {
  const maxMonths = opts.maxMonths ?? BETA_MAX_MONTHS;
  const minMonths = opts.minMonths ?? BETA_MIN_MONTHS;
  const symbolEnds = monthEndCloses(symbolCloses);
  const benchByMonth = new Map(monthEndCloses(benchmarkCloses).map((p) => [p.date.slice(0, 7), p]));
  // Shared month-ends, newest first, at most maxMonths + 1 levels (→ maxMonths returns).
  const shared = symbolEnds
    .filter((p) => benchByMonth.has(p.date.slice(0, 7)))
    .slice(0, maxMonths + 1)
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
  for (let i = 1; i < shared.length; i++) {
    const s0 = shared[i - 1]!;
    const s1 = shared[i]!;
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
  const fail = (reason: string): BetaEstimate => ({
    beta: null,
    months,
    windowStart,
    windowEnd,
    rSquared: null,
    standardError: null,
    betaBlume: null,
    basis,
    note: `beta not estimated: ${reason}`,
    gap: { field: "profile.beta", reason, severity: "warn", attemptedSources: ["computed:beta(monthly OLS vs SPY)"] },
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
    `(${windowStart} → ${windowEnd}); vendor betas use the same 5-year-monthly convention`;
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
        `${windowStart} to ${windowEnd}, built from ${priceNote}` +
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
