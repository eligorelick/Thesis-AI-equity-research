/**
 * Deterministic provenance primitives for Stage C.
 *
 * These helpers deliberately know nothing about provider-prefix conventions or
 * approximate matches across unrelated payload values. A number is supported
 * only by its exact registry record and declared display precision.
 */

export type CanonicalUnit =
  | "currency"
  | "currency-per-share"
  | "percent"
  | "percentage-points"
  | "percentage-points-per-year"
  | "ratio"
  | "shares"
  | "count"
  | "score"
  | "index"
  | "days"
  | "years"
  | "quarters";

export type ProvenanceFailureReason =
  | "unknown-source"
  | "value-mismatch"
  | "unit-mismatch"
  | "currency-mismatch"
  | "period-mismatch"
  | "date-mismatch";

export interface NumericProvenanceRecord {
  id: string;
  kind: "provider" | "computed";
  value: number;
  unit: CanonicalUnit;
  currency: string | null;
  period: string | null;
  asOf: string;
  origin: string;
  formulaVersion: string | null;
  displayPrecision: number;
}

/** Exact non-numeric payload citation shown to the model. */
export interface CitationProvenanceRecord {
  id: string;
  kind: "payload-text";
  asOf: string | null;
  origin: string;
}

export interface ProvenanceCandidate {
  value: number;
  unit: CanonicalUnit;
  currency: string | null;
  period: string | null;
  asOf: string;
  source: string;
}

export type ProvenanceMatch =
  | { ok: true; record: NumericProvenanceRecord }
  | {
      ok: false;
      reason: ProvenanceFailureReason;
      record?: NumericProvenanceRecord;
    };

export interface CoverageRate {
  supported: number;
  total: number;
  rate: number | null;
}

export interface CanonicalizedTracedUnit {
  unit: CanonicalUnit;
  currency: string | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;
const CANONICAL_UNITS = new Set<CanonicalUnit>([
  "currency",
  "currency-per-share",
  "percent",
  "percentage-points",
  "percentage-points-per-year",
  "ratio",
  "shares",
  "count",
  "score",
  "index",
  "days",
  "years",
  "quarters",
]);

/** Convert known report/display unit spellings to the registry vocabulary. */
export function canonicalizeTracedUnit(
  displayUnit: string,
  explicitCurrency: string | null | undefined,
): CanonicalizedTracedUnit | null {
  const raw = displayUnit.trim();
  const normalized = raw.toLowerCase();
  const declaredCurrency = explicitCurrency?.toUpperCase() ?? null;
  if (declaredCurrency !== null && !ISO_CURRENCY.test(declaredCurrency)) return null;

  const currencyPerShare = /^([A-Z]{3})\/share$/.exec(raw);
  if (currencyPerShare) {
    return { unit: "currency-per-share", currency: currencyPerShare[1] };
  }
  if (/^[A-Z]{3}$/.test(raw)) return { unit: "currency", currency: raw };

  if (normalized === "currency" || normalized === "currency mkt cap") {
    return { unit: "currency", currency: declaredCurrency };
  }
  if (normalized === "currency/share") {
    return { unit: "currency-per-share", currency: declaredCurrency };
  }
  if (normalized === "%") return { unit: "percent", currency: null };
  if (normalized === "pp") return { unit: "percentage-points", currency: null };
  if (normalized === "pp/yr") {
    return { unit: "percentage-points-per-year", currency: null };
  }
  if (normalized === "x" || normalized === "fraction" || normalized === "frac") {
    return { unit: "ratio", currency: null };
  }
  if (normalized === "0-100" || normalized.startsWith("0-100 (")) {
    return { unit: "score", currency: null };
  }
  // Stage-B aspect-score SIGNAL unit spellings (grading.ts): dimensionless
  // indicator readings (percentile rank, Altman Z, Beneish M, RSI). These
  // spellings occur ONLY on scores.aspects[*].drivers, so mapping them to the
  // dimensionless `index` bucket cannot collide with any other figure's unit —
  // it just lets a pipeline-computed driver trace to its registered record
  // instead of failing unit canonicalization (which would strand it unverified).
  if (
    normalized === "pctile" ||
    normalized === "z" ||
    normalized === "m" ||
    normalized === "rsi"
  ) {
    return { unit: "index", currency: null };
  }
  if (normalized === "") return { unit: "index", currency: null };
  if (CANONICAL_UNITS.has(normalized as CanonicalUnit)) {
    const unit = normalized as CanonicalUnit;
    const monetary = unit === "currency" || unit === "currency-per-share";
    return { unit, currency: monetary ? declaredCurrency : null };
  }
  return null;
}

function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day)
  );
}

/** Throw on a malformed or ambiguous registry before it can reach a report. */
export function validateProvenanceRegistry(
  registry: readonly NumericProvenanceRecord[],
): void {
  const ids = new Set<string>();
  for (const record of registry) {
    if (ids.has(record.id)) throw new Error(`Duplicate provenance ID: ${record.id}`);
    ids.add(record.id);

    if (!record.id.trim() || !record.origin.trim() || !Number.isFinite(record.value)) {
      throw new Error(`Invalid provenance record: ${record.id}`);
    }
    if (!isIsoDate(record.asOf)) {
      throw new Error(`Invalid provenance date: ${record.id}`);
    }
    if (record.currency !== null && !ISO_CURRENCY.test(record.currency)) {
      throw new Error(`Invalid provenance currency: ${record.id}`);
    }
    if (!Number.isInteger(record.displayPrecision) || record.displayPrecision < 0) {
      throw new Error(`Invalid provenance precision: ${record.id}`);
    }
    if (record.kind === "computed" && !record.formulaVersion?.trim()) {
      throw new Error(`Computed provenance requires a formula version: ${record.id}`);
    }
    if (record.kind === "provider" && record.formulaVersion !== null) {
      throw new Error(`Provider provenance cannot have a formula version: ${record.id}`);
    }
  }
}

/** Throw on malformed or duplicate source/date pairs. */
export function validateCitationRegistry(
  registry: readonly CitationProvenanceRecord[],
): void {
  const keys = new Set<string>();
  for (const record of registry) {
    const key = `${record.id}\u0000${record.asOf ?? ""}`;
    if (keys.has(key)) throw new Error(`Duplicate citation record: ${record.id}`);
    keys.add(key);
    if (!record.id.trim() || !record.origin.trim()) {
      throw new Error(`Invalid citation record: ${record.id}`);
    }
    if (record.asOf !== null && !isIsoDate(record.asOf)) {
      throw new Error(`Invalid citation date: ${record.id}`);
    }
  }
}

/** Match every numeric dimension against the exact named registry record. */
export function matchProvenanceRecord(
  candidate: ProvenanceCandidate,
  registry: readonly NumericProvenanceRecord[],
): ProvenanceMatch {
  const record = registry.find((entry) => entry.id === candidate.source);
  if (!record) return { ok: false, reason: "unknown-source" };
  if (record.unit !== candidate.unit) {
    return { ok: false, reason: "unit-mismatch", record };
  }
  if (record.currency !== candidate.currency) {
    return { ok: false, reason: "currency-mismatch", record };
  }
  if (record.period !== candidate.period) {
    return { ok: false, reason: "period-mismatch", record };
  }
  if (record.asOf !== candidate.asOf) {
    return { ok: false, reason: "date-mismatch", record };
  }

  const tolerance = 0.5 * 10 ** -record.displayPrecision;
  if (Math.abs(record.value - candidate.value) > tolerance) {
    return { ok: false, reason: "value-mismatch", record };
  }
  return { ok: true, record };
}

/** Canonicalize only URLs that could have been returned by web search. */
export function canonicalizeFetchedUrl(value: string): string | null {
  try {
    // Web citations use a `web:<absolute-url>` transport prefix. Normalize it
    // here so model citations and observed fetched URLs compare identically.
    const raw = value.startsWith("web:") ? value.slice(4) : value;
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Calculate provenance coverage without treating no evidence as perfection. */
export function calculateCoverage(supported: number, total: number): CoverageRate {
  return { supported, total, rate: total === 0 ? null : supported / total };
}
