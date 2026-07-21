/**
 * Display formatters for the company page. Pure, presentational, no rounding of
 * the underlying data — rounding happens only here at the render boundary.
 */

import {
  formatCurrency,
  formatLargeNumber,
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

/** Compact currency scale: 1.23T / 45.6B / 789M / 12.3K. */
export function fmtBig(v: number | null | undefined): string {
  return formatLargeNumber(v);
}

export function fmtMoney(v: number | null | undefined, digits = 2): string {
  return formatCurrency(v, digits);
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
