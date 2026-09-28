/**
 * Display formatters for the company page. Pure, presentational, no rounding of
 * the underlying data — rounding happens only here at the render boundary.
 */

import {
  formatLargeNumber,
  formatMoneyAmount,
  formatMultiple,
  formatNumber,
  formatPct,
} from "@/report/format";

export function fmtNum(v: number | null | undefined, digits = 2): string {
  return formatNumber(v, digits);
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  return formatPct(v, digits);
}

export function fmtSignedPct(v: number | null | undefined, digits = 1): string {
  return formatPct(v, digits, true);
}

/** Format a fractional ratio (0.25 = 25%) without coercing missing values to zero. */
export function fmtFractionPct(
  value: number | null | undefined,
  digits = 1,
): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return formatPct(value * 100, digits);
}

/** Compact currency scale: 1.23T / 45.6B / 789M / 12.3K. */
export function fmtBig(v: number | null | undefined): string {
  return formatLargeNumber(v);
}

/**
 * Money in its ESTABLISHED currency: the trading currency for the quote and
 * price history, the model's currency for per-share values. Null prints
 * "(currency unknown)"; there is no dollar default.
 */
export function fmtMoney(v: number | null | undefined, currency: string | null, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return formatMoneyAmount(v, currency, digits);
}

export function fmtX(v: number | null | undefined, digits = 1): string {
  return formatMultiple(v, digits);
}

/** upside/downside vs price, given per-share intrinsic value. */
export function upsidePct(perShare: number | null, price: number | null): number | null {
  if (perShare === null || price === null || price === 0 || !Number.isFinite(perShare) || !Number.isFinite(price)) {
    return null;
  }
  return ((perShare - price) / price) * 100;
}
