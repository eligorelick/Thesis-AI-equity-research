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
  "usd/share": "usd-per-share", "$/share": "usd-per-share",
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

export function formatLargeNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

export function formatMultiple(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "n/m";
  return `${value.toFixed(digits)}×`;
}

export function formatFinancialValue(value: number, unit: string): string {
  const canonical = normalizeFinancialUnit(unit);
  switch (canonical) {
    case "percent": return formatPct(value);
    case "multiple": return formatMultiple(value);
    case "usd": return Math.abs(value) >= 1e6 ? `$${formatLargeNumber(value)}` : formatCurrency(value);
    case "usd-per-share": return formatCurrency(value);
    case "large-count": return formatLargeNumber(value);
    case "basis-points": return `${formatNumber(value, 0)} bps`;
    case "years": return `${formatNumber(value, 1)}y`;
    case "number": return formatNumber(value, Number.isInteger(value) ? 0 : 2);
    default: return `${formatNumber(value)} ${unit}`;
  }
}

export function formatTracedValue(number: TracedNumber): string {
  return formatFinancialValue(number.value, number.unit);
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
