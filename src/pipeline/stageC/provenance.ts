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
  /** The id names a registered text source (a filing section, a transcript); numbers trace only against numeric records. */
  | "text-source"
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
  /**
   * The issuer's own fiscal label for `period` ("FY2025", "Q1 FY2026"), taken
   * from the source statement row's `fiscalYear`/`period`. Absent when the row
   * carried none; without it no fiscal spelling can be read as this period.
   */
  fiscalPeriod?: string;
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
  // A trailing parenthetical is a qualifier, not a unit: the payload renders
  // aspect scores as "0-100 (grade B, completeness 0.9)" and a live haiku run
  // (2026-09-02) echoed RSI as "index (0-100)" and scores as "0-100 score",
  // failing every grade-strip key number as unit-mismatch while id, value and
  // as-of matched exactly. A qualifier that names a scale ("USD (millions)")
  // is still caught, by the value match.
  const raw = displayUnit.trim().replace(/\s*\(.*\)$/, "");
  const normalized = raw.toLowerCase();
  const declaredCurrency = explicitCurrency?.toUpperCase() ?? null;
  if (declaredCurrency !== null && !ISO_CURRENCY.test(declaredCurrency)) return null;

  // A bare ISO code in the unit ("EUR", "EUR/share") names the currency
  // itself; when the number ALSO declares a currency, the two must agree — a
  // figure labelled EUR with currency USD is a conflict, not a USD figure, and
  // fails closed like any other unreadable unit (audit 2026-09-06, F181).
  const currencyPerShare = /^([A-Z]{3})\/share$/.exec(raw);
  if (currencyPerShare) {
    if (declaredCurrency !== null && declaredCurrency !== currencyPerShare[1]) return null;
    return { unit: "currency-per-share", currency: currencyPerShare[1] };
  }
  if (/^[A-Z]{3}$/.test(raw)) {
    if (declaredCurrency !== null && declaredCurrency !== raw) return null;
    return { unit: "currency", currency: raw };
  }

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
  if (/^0-100\b/.test(normalized)) {
    return { unit: "score", currency: null };
  }
  // Stage-B aspect-score SIGNAL unit spellings (grading.ts): dimensionless
  // indicator readings (percentile rank, Altman Z, Beneish M, RSI). These
  // spellings occur ONLY on scores.aspects[*].drivers, so mapping them to the
  // dimensionless `index` bucket cannot collide with any other figure's unit —
  // it just lets a pipeline-computed driver trace to its registered record
  // instead of failing unit canonicalization (which would strand it unverified).
  if (
    // "pctile" is the retired spelling, kept so persisted reports still trace;
    // "rank" is what grading emits now (WS6 review, SHOULD-FIX 3).
    normalized === "rank" ||
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

/** Exact calendar-valid YYYY-MM-DD. Exported so producers can normalize a
 * provider date BEFORE it reaches the registry, keeping the validators below
 * free to stay fail-loud. */
export function isIsoDate(value: string): boolean {
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

/**
 * One period named in a period string. `fiscal` is a fiscal year, or a quarter
 * of one; `explicit` is false when the spelling could equally be a calendar
 * period ("Q1 2025", a bare "2025") and true when it says fiscal ("FY2025",
 * "Q1 FY2026", "fiscal 2025").
 */
type PeriodIdentity =
  | { kind: "date"; iso: string }
  | { kind: "fiscal"; year: number; quarter: number | null; explicit: boolean }
  | { kind: "other"; text: string };

const QUARTER_WORDS: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4 };

function fullYear(digits: string): number {
  return digits.length === 2 ? 2000 + Number(digits) : Number(digits);
}

/**
 * Every period a string names, label words ignored. Matched spans are blanked
 * as they are read so "Q1 FY2026" is one quarter, not a quarter and a year.
 */
function periodIdentities(text: string): PeriodIdentity[] {
  let rest = text.trim().toLowerCase();
  const found: PeriodIdentity[] = [];
  const take = (pattern: RegExp, read: (match: RegExpMatchArray) => PeriodIdentity): void => {
    rest = rest.replace(pattern, (...args: unknown[]) => {
      found.push(read(args as unknown as RegExpMatchArray));
      return " ";
    });
  };
  take(/(?<![0-9])(\d{4}-\d{2}-\d{2})(?![0-9])/g, (m) => ({ kind: "date", iso: m[1] }));
  // A quarter: "q1 2025", "q1 fy2026", "fiscal q1 2026", "q1 fy'26",
  // "first quarter of fiscal 2026". A two-digit year needs an FY marker or an
  // apostrophe, so "q1 15% growth" is never read as a period.
  take(
    /(?<![a-z0-9])(fiscal\s+)?(?:q([1-4])|(first|second|third|fourth)\s+quarter)\s*(?:of\s+)?(?:(fiscal\s+(?:year\s+)?|fy\s?)?['’]?((?:19|20)\d{2})|(fiscal\s+(?:year\s+)?|fy\s?)['’]?(\d{2})|['’](\d{2}))(?![0-9])/g,
    (m) => ({
      kind: "fiscal",
      year: fullYear(m[5] ?? m[7] ?? m[8]),
      quarter: m[2] !== undefined ? Number(m[2]) : QUARTER_WORDS[m[3]],
      explicit: m[1] !== undefined || m[4] !== undefined || m[6] !== undefined,
    }),
  );
  take(/(?<![a-z0-9])(?:fiscal\s+(?:year\s+)?|fy\s?)['’]?((?:19|20)\d{2}|\d{2})(?![0-9])e?/g, (m) => ({
    kind: "fiscal",
    year: fullYear(m[1]),
    quarter: null,
    explicit: true,
  }));
  // Anything else that bounds a period is a period of its own, and never the
  // registered one: trailing/half-year/year-to-date windows.
  take(
    /(?<![a-z0-9])(ttm|ltm|trailing\s+twelve\s+months|last\s+twelve\s+months|ytd|year[\s-]to[\s-]date|[hq][1-4]|[1-4][hq]|(?:six|nine)\s+months|[69]m)(?![a-z0-9])/g,
    (m) => ({ kind: "other", text: m[1] }),
  );
  take(/(?<![0-9])((?:19|20)\d{2})(?![0-9])/g, (m) => ({
    kind: "fiscal",
    year: Number(m[1]),
    quarter: null,
    explicit: false,
  }));
  return found;
}

function sameIdentity(a: PeriodIdentity, b: PeriodIdentity): boolean {
  if (a.kind === "date" && b.kind === "date") return a.iso === b.iso;
  if (a.kind === "fiscal" && b.kind === "fiscal") return a.year === b.year && a.quarter === b.quarter;
  if (a.kind === "other" && b.kind === "other") return a.text === b.text;
  return false;
}

/**
 * Whether the calendar reading of `period` ("Q1 2025" as January-March 2025, a
 * bare "2025" as the calendar year) closes where the registered period ends.
 * A 52/53-week calendar ends near, not on, the month end, so the end date is
 * read a week earlier: 2026-01-03 still closes December 2025.
 */
function closesCalendarPeriod(endIso: string, period: { year: number; quarter: number | null }): boolean {
  const end = Date.parse(`${endIso}T00:00:00Z`);
  if (!Number.isFinite(end)) return false;
  const shifted = new Date(end - 7 * 86_400_000);
  return (
    shifted.getUTCFullYear() === period.year &&
    shifted.getUTCMonth() + 1 === (period.quarter === null ? 12 : period.quarter * 3)
  );
}

/**
 * Whether a model-supplied `period` names the period the registry recorded.
 * Registry ids are unique, so the id already pins the exact record and the
 * period is a cross-check on the model's reading, not a lookup key — but an
 * agreement here rewrites the model's period to the record's and lets the
 * number verify, so it has to mean the SAME period, not merely the same year.
 *
 * A statement cell registers its ISO period end (2025-12-31) and, from the
 * source row, the issuer's own fiscal label (`fiscalPeriod`, "FY2025" or
 * "Q1 FY2026"). The supplied string must name exactly one period, label
 * words aside ("total debt FY2025"), and that period must be:
 *  - the registered ISO date itself, when it names a date; or
 *  - the issuer's fiscal label, when it names a fiscal year or quarter. A
 *    spelling that could equally be a calendar period ("Q1 2025", "2025")
 *    must also close where the record ends, so a September-year issuer's
 *    Q1 FY2025 (ended 2024-12-28) is not "Q1 2025"; or
 *  - the same fiscal year/quarter as a registered fiscal label ("fy27"
 *    against "FY2027E").
 * Without the issuer's label no fiscal spelling can be matched to an ISO
 * date: "Q4 2025" is the quarter ended 2025-03-31 on a March fiscal year and
 * the one ended 2025-12-31 on a calendar year, and nothing else here says
 * which. Such a citation stays period-mismatch — the prompt asks for the ISO
 * period end as rendered.
 */
export function periodsAgree(
  supplied: string | null | undefined,
  registered: string | null,
  issuerFiscalPeriod: string | null = null,
): boolean {
  if (supplied == null || registered === null) return true;
  if (supplied.trim().toLowerCase() === registered.trim().toLowerCase()) return true;
  const named = periodIdentities(supplied);
  if (named.length === 0) return false;
  const [first] = named;
  if (!named.every((identity) => sameIdentity(identity, first))) return false;

  const recorded = periodIdentities(registered);
  if (recorded.length !== 1) return false;
  const [record] = recorded;
  if (record.kind !== "date") return sameIdentity(first, record);

  if (first.kind === "date") return first.iso === record.iso;
  if (first.kind !== "fiscal" || issuerFiscalPeriod === null) return false;
  const issuer = periodIdentities(issuerFiscalPeriod);
  if (issuer.length !== 1 || !sameIdentity(first, issuer[0])) return false;
  return first.explicit || closesCalendarPeriod(record.iso, first);
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

  // Half a unit of the last displayed decimal — the largest error a faithful
  // rounding can carry. A tie (a fifth decimal of exactly 5 against a 4-dp
  // rendering) sits ON the bound, and binary float noise in the subtraction
  // used to push it a few ulps over (audit 2026-09-06, F180/F196); the slack
  // is relative and ~1e-9, far below any display precision the registry uses.
  const tolerance = 0.5 * 10 ** -record.displayPrecision;
  const slack = 1e-9 * Math.max(1, Math.abs(record.value), Math.abs(candidate.value));
  if (Math.abs(record.value - candidate.value) > tolerance + slack) {
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
