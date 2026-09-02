// src/pipeline/stageB/betaEstimate.ts
/**
 * Levered beta from monthly log returns — the keyless replacement for the
 * vendor profile beta.
 *
 * Method: ordinary least squares of the symbol's monthly log return on the
 * benchmark's over the last `maxMonths` (60) month-ends both series share,
 * i.e. the same 5-year-monthly convention vendors publish. Fewer than
 * `minMonths` (24) shared returns is a disclosed gap, not a number.
 * Pure and deterministic.
 */
import type { ManifestEntry } from "@/types/core";

export interface ClosePoint {
  date: string;
  close: number;
}

export interface BetaEstimate {
  beta: number | null;
  months: number;
  windowStart: string | null;
  windowEnd: string | null;
  rSquared: number | null;
  note: string;
  gap: ManifestEntry | null;
}

export const BETA_MAX_MONTHS = 60;
export const BETA_MIN_MONTHS = 24;

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
  const returns: { s: number; b: number }[] = [];
  for (let i = 1; i < shared.length; i++) {
    const s0 = shared[i - 1]!;
    const s1 = shared[i]!;
    const b0 = benchByMonth.get(s0.date.slice(0, 7))!;
    const b1 = benchByMonth.get(s1.date.slice(0, 7))!;
    returns.push({ s: Math.log(s1.close / s0.close), b: Math.log(b1.close / b0.close) });
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
    note: `beta not estimated: ${reason}`,
    gap: { field: "profile.beta", reason, severity: "warn", attemptedSources: ["computed:beta(monthly OLS vs SPY)"] },
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
  return {
    beta,
    months,
    windowStart,
    windowEnd,
    rSquared,
    note: `beta ${beta.toFixed(3)} from ${months} monthly log returns vs the benchmark (${windowStart} → ${windowEnd}), OLS slope; vendor betas use the same 5-year-monthly convention`,
    gap: null,
  };
}
