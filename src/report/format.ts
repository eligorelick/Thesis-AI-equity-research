import { z } from "zod";

import { collapseDuplicateLegacyCitationDates } from "@/pipeline/stageC/citations";
import type { TracedNumber } from "@/report/schema";

export const CanonicalFinancialUnitSchema = z.enum([
  "percent",
  "multiple",
  "usd",
  "usd-per-share",
  "large-count",
  "basis-points",
  "years",
  "number",
]);
export type CanonicalFinancialUnit = z.infer<typeof CanonicalFinancialUnitSchema>;

const UNIT_ALIASES: Record<string, CanonicalFinancialUnit> = {
  "%": "percent", pct: "percent", percent: "percent",
  x: "multiple", "×": "multiple", multiple: "multiple",
  usd: "usd", "$": "usd", currency: "usd", usd_large: "usd", "usd-large": "usd", "$_large": "usd",
  "usd/share": "usd-per-share", "$/share": "usd-per-share", "currency/share": "usd-per-share",
  large: "large-count", count_large: "large-count",
  bps: "basis-points",
  years: "years", yr: "years", y: "years",
  "": "number", number: "number", count: "number",
};

export function normalizeFinancialUnit(unit: string): CanonicalFinancialUnit | null {
  const normalized = UNIT_ALIASES[unit.trim().toLowerCase()];
  return normalized && CanonicalFinancialUnitSchema.safeParse(normalized).success ? normalized : null;
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatCurrency(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return `$${formatNumber(value, digits)}`;
}

export function formatPct(value: number | null | undefined, digits = 1, signed = false): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return `${signed && value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

const LARGE_NUMBER_SCALES: readonly [scale: number, suffix: string, digits: number][] = [
  [1e12, "T", 2],
  [1e9, "B", 2],
  [1e6, "M", 2],
  [1e3, "K", 1],
];

/**
 * Compact magnitude ("$60.96B"). The scale is chosen on the ROUNDED mantissa,
 * largest first, so it never reaches 1000: 999,996,000,000 prints "1.00T",
 * not "1000.00B", and 999,999.999 prints "1.00M", not "1000.0K".
 */
export function formatLargeNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  for (const [scale, suffix, digits] of LARGE_NUMBER_SCALES) {
    const mantissa = (abs / scale).toFixed(digits);
    if (Number(mantissa) >= 1) return `${sign}${mantissa}${suffix}`;
  }
  return `${sign}${abs.toFixed(2)}`;
}

export function formatMultiple(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "n/m";
  return `${value.toFixed(digits)}×`;
}

/**
 * Render a monetary magnitude in its ACTUAL currency.
 *
 * The canonical unit is named "usd" for historical reasons, but the figure it
 * carries is denominated in the statements' reportedCurrency — TWD for TSM, CHF
 * for Nestlé. Printing those with a "$" is a false statement about the number,
 * not a formatting nit. A non-USD code is appended (ISO-4217) rather than
 * guessed at a symbol, because symbols are ambiguous across currencies ($ alone
 * is used by a dozen of them).
 *
 * A null/absent currency keeps the dollar sign: `TracedNumber.currency` is
 * documented as optional ONLY for legacy reports, so this is the legacy path,
 * not a silent default for current data.
 */
function formatMoney(value: number, currency: string | null | undefined, large: boolean): string {
  const magnitude = large ? formatLargeNumber(value) : formatNumber(value, 2);
  const code = (currency ?? "").trim().toUpperCase();
  if (code === "" || code === "USD") return `$${magnitude}`;
  return `${magnitude} ${code}`;
}

/**
 * A plain money amount at a chosen precision, in its ACTUAL currency — the
 * same rule as {@link formatMoney}, for figures rendered outside a
 * TracedNumber (the DCF sensitivity grid, whose cells are bare numbers in the
 * currency of `valuation.dcf.perShare`).
 */
export function formatMoneyAmount(
  value: number,
  currency: string | null | undefined,
  digits = 2,
): string {
  const magnitude = formatNumber(value, digits);
  const code = (currency ?? "").trim().toUpperCase();
  if (code === "" || code === "USD") return `$${magnitude}`;
  return `${magnitude} ${code}`;
}

/**
 * Units the pipeline's own payload and score drivers emit that are not
 * canonical financial units: share counts, percentage-point deltas, RSI,
 * ranks, days, quarters and fractions. Rendered on their own terms rather
 * than through the generic "two decimals + unit word" fallback, which printed
 * a share count as "15,204,000,000.00 shares" and an RSI as "55.00 rsi".
 */
function formatPipelineUnit(value: number, unit: string): string | null {
  switch (unit.trim().toLowerCase()) {
    case "shares":
      return `${formatLargeNumber(value)} shares`;
    case "pp":
    case "pp/yr":
      return `${formatNumber(value, 1)} ${unit.trim().toLowerCase()}`;
    case "fraction":
    case "frac":
      return formatPct(value * 100);
    case "z":
      return `${formatNumber(value, 2)} z`;
    case "days":
    case "quarters":
    case "rank":
    case "score":
    case "rsi":
    case "pctile":
      return `${formatNumber(value, Number.isInteger(value) ? 0 : 1)} ${unit.trim().toLowerCase()}`;
    default:
      return null;
  }
}

export function formatFinancialValue(
  value: number,
  unit: string,
  currency?: string | null,
): string {
  const canonical = normalizeFinancialUnit(unit);
  switch (canonical) {
    case "percent": return formatPct(value);
    case "multiple": return formatMultiple(value);
    case "usd": return formatMoney(value, currency, Math.abs(value) >= 1e6);
    case "usd-per-share": return formatMoney(value, currency, false);
    case "large-count": return formatLargeNumber(value);
    case "basis-points": return `${formatNumber(value, 0)} bps`;
    case "years": return `${formatNumber(value, 1)}y`;
    case "number": return formatNumber(value, Number.isInteger(value) ? 0 : 2);
    default: return formatPipelineUnit(value, unit) ?? `${formatNumber(value)} ${unit}`;
  }
}

/**
 * Stable column identity for a peer metric.
 *
 * Peer tables were rendered POSITIONALLY ("Metric 1", "Metric 2"), so if one
 * peer reported P/E and EV/EBITDA while another reported only EV/EBITDA, the
 * second peer's EV/EBITDA landed under the first peer's P/E column. Different
 * metrics under one header is a false comparison, which is the entire purpose
 * of a peer table. Keying by the metric's own provenance fixes the alignment.
 */
export function peerMetricKey(metric: TracedNumber): string {
  const tail = metric.source.split(/[.:/]/).filter(Boolean).pop();
  return tail && tail.length > 0 ? tail : metric.unit;
}

/**
 * Collision-safe column keys for ONE peer row, in order.
 *
 * `peerMetricKey` is NOT injective — two metrics from different sources can
 * share a trailing segment. Keying a row's metrics into a Map by that alone
 * silently DROPPED the earlier of any colliding pair (a peer losing a metric
 * entirely) and, across rows, split one logical metric over two columns. That
 * is worse than the positional layout it replaced, because the loss is
 * invisible. Duplicates within a row are disambiguated by occurrence, so every
 * metric keeps a column and no metric overwrites another.
 */
export function peerColumnKeys(metrics: readonly TracedNumber[]): string[] {
  const seen = new Map<string, number>();
  return metrics.map((metric) => {
    const base = peerMetricKey(metric);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base} (${n + 1})`;
  });
}

export function formatTracedValue(number: TracedNumber): string {
  return formatFinancialValue(number.value, number.unit, number.currency);
}

/** Format machine-oriented verification-log claims for human display. */
export function formatVerificationClaim(value: string): string {
  const normalized = collapseDuplicateLegacyCitationDates(value);
  const match = /^(-?\d+(?:\.\d+)?)\s+(USD(?:\/share)?)(\s+\[[\s\S]+\])$/.exec(normalized);
  if (!match) return normalized;
  return `${formatFinancialValue(Number(match[1]), match[2])}${match[3]}`;
}

const COST_DIGITS = 6;
export function roundedDisplayedCost(value: number): number {
  return Number(value.toFixed(COST_DIGITS));
}
export function roundedDisplayedCostTotal(values: readonly number[]): number {
  return roundedDisplayedCost(values.reduce((sum, value) => sum + roundedDisplayedCost(value), 0));
}
export function formatCostUsd(value: number): string {
  return `$${roundedDisplayedCost(value).toFixed(COST_DIGITS)}`;
}
