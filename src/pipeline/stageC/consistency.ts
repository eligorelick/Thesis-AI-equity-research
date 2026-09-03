/**
 * Stage C — deterministic, no-model consistency checks on the report's prose.
 *
 * WS7 (DECISIONS D-20). The verification pass measured CITATION COVERAGE only:
 * "does this figure resolve to a registry record?". It never looked at the
 * sentence wrapped around the figure, so a sentence could say a metric "rose"
 * while citing a record whose value is negative, name "Q3" while citing an
 * FY-end record, or say "bps" about a dollar figure, and still count as fully
 * cited. This module adds four checks that need no model call:
 *
 *  - DIRECTION: a direction word ("rose", "fell", "improved", "declined") glued
 *    to the cited figure must match the sign of that figure, when the figure is
 *    a signed change rather than a level.
 *  - PERIOD: a period phrase that names a year ("in Q3 2025", "in FY2025") must
 *    name the period the cited record carries, under the SAME fiscal-spelling
 *    tolerance the citation check already uses ({@link periodsAgree}).
 *  - UNIT: the unit token attached to the cited figure ("%", "bps", "billion")
 *    must belong to the family the record's registry unit can express.
 *  - NAMED INDIVIDUAL: a claim that names a person may cite filings, transcripts
 *    or registry figures — never a web-search result and never nothing.
 *
 * DESIGN RULE — precision over recall. Every check first has to LOCATE the cited
 * figure inside the sentence (a number in the text whose magnitude, after any
 * scale word, matches the record's value within the precision the sentence
 * itself wrote). A sentence that mentions several figures therefore has each
 * check applied to the one it actually cites, and a sentence where the figure
 * cannot be located is reported as NOT CHECKED rather than guessed at. That is
 * why `checked` is published beside `coverage` instead of folded into it: a low
 * `checked` count is a fact about how much could be verified, and hiding it
 * inside a rate would be the same mistake as calling citation coverage accuracy.
 *
 * Pure and deterministic: no clock, no network, no model.
 */

import type {
  CheckRate,
  ConsistencyChecks,
  SourcedClaim,
  VerificationLogEntry,
} from "@/report/schema";
import {
  canonicalizeFetchedUrl,
  periodsAgree,
  type CanonicalUnit,
  type CitationProvenanceRecord,
  type NumericProvenanceRecord,
} from "@/pipeline/stageC/provenance";
import { citationSourceId } from "@/pipeline/stageC/citations";

export type ConsistencyCheckKind = NonNullable<VerificationLogEntry["check"]>;
export type ConsistencyFailureReason = Extract<
  NonNullable<VerificationLogEntry["reason"]>,
  | "direction-mismatch"
  | "period-word-mismatch"
  | "unit-word-mismatch"
  | "named-individual-unsourced"
  | "named-individual-web-source"
  | "credibility-source-restricted"
>;

export interface ConsistencyFinding {
  check: ConsistencyCheckKind;
  reason: ConsistencyFailureReason;
  /** The exact sentence that failed. */
  sentence: string;
  /** The cited figure, rendered "value unit [sourceId]". */
  figure: string;
  sourceId: string | null;
  path: string;
  /** Why it failed, in words a reader can act on. */
  note: string;
}

export interface ConsistencyClaimRef {
  claim: SourcedClaim;
  path: string;
}

export interface ConsistencyInput {
  claims: readonly ConsistencyClaimRef[];
  registry: readonly NumericProvenanceRecord[];
  citationRegistry: readonly CitationProvenanceRecord[];
  fetchedUrls: ReadonlySet<string>;
  /** Person names known from the payload and from the report's own exec cards. */
  personNames: readonly string[];
}

export interface ConsistencyResult {
  findings: ConsistencyFinding[];
  checks: ConsistencyChecks;
  /**
   * Report paths of claims the named-individual restriction rejected. The verify
   * pass counts these as UNSUPPORTED in factual-claim coverage: a claim about a
   * named person sourced to a web search is exactly the kind of claim the
   * restriction exists to keep out of the report, so letting the URL carry it
   * would make the coverage number say the opposite of the finding.
   */
  rejectedClaimPaths: Set<string>;
}

/* ------------------------------------------------------------------------ *
 * Counters
 * ------------------------------------------------------------------------ */

class Counter {
  passed = 0;
  failed = 0;
  pass(): void {
    this.passed += 1;
  }
  fail(): void {
    this.failed += 1;
  }
  rate(): CheckRate {
    const checked = this.passed + this.failed;
    return {
      checked,
      passed: this.passed,
      failed: this.failed,
      rate: checked === 0 ? null : this.passed / checked,
    };
  }
}

/* ------------------------------------------------------------------------ *
 * Locating the cited figure inside the sentence
 * ------------------------------------------------------------------------ */

const SCALE_WORDS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  thousands: 1e3,
  mm: 1e6,
  m: 1e6,
  million: 1e6,
  millions: 1e6,
  bn: 1e9,
  billion: 1e9,
  billions: 1e9,
  trillion: 1e12,
  trillions: 1e12,
};

type UnitFamily = "percent" | "money" | "multiple" | "shares";

const PERCENT_TOKENS = new Set([
  "%",
  "percent",
  "percentage",
  "percentage point",
  "percentage points",
  "pp",
  "pps",
  "bp",
  "bps",
  "basis point",
  "basis points",
]);
const MULTIPLE_TOKENS = new Set(["x", "times"]);
const SHARE_TOKENS = new Set(["share", "shares"]);
const MONEY_TOKENS = new Set(["dollar", "dollars", "usd"]);

/** One number found in a sentence, with whatever unit decoration it carried. */
interface ParsedNumber {
  /** Character index of the first digit (or its sign/currency prefix). */
  start: number;
  end: number;
  magnitude: number;
  /** Decimal places actually written, for the match tolerance. */
  decimals: number;
  scale: number;
  scaleWord: string | null;
  unitToken: string | null;
  hadCurrencyPrefix: boolean;
}

// A signed, optionally $-prefixed number with optional thousands separators,
// followed by an optional scale word and an optional unit token.
const NUMBER_PATTERN = new RegExp(
  String.raw`([-+−])?\s*(\$|US\$)?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*` +
    String.raw`(thousands?|millions?|billions?|trillions?|bn|mm|k)?\s*` +
    String.raw`(%|percentage points?|percent|pps?|bps?|basis points?|dollars?|usd|shares?|x|times)?`,
  "gi",
);

export function parseNumbers(sentence: string): ParsedNumber[] {
  const out: ParsedNumber[] = [];
  NUMBER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMBER_PATTERN.exec(sentence)) !== null) {
    const [whole, , currency, digits, fraction, scaleWord, unitToken] = match;
    if (digits === undefined) continue;
    const magnitude = Number(`${digits.replace(/,/g, "")}${fraction ?? ""}`);
    if (!Number.isFinite(magnitude)) continue;
    const normalizedScale = scaleWord?.toLowerCase() ?? null;
    out.push({
      start: match.index,
      end: match.index + whole.length,
      magnitude,
      decimals: fraction === undefined ? 0 : fraction.length - 1,
      scale: normalizedScale === null ? 1 : (SCALE_WORDS[normalizedScale] ?? 1),
      scaleWord: normalizedScale,
      unitToken: unitToken?.toLowerCase() ?? null,
      hadCurrencyPrefix: currency !== undefined,
    });
    if (NUMBER_PATTERN.lastIndex === match.index) NUMBER_PATTERN.lastIndex += 1;
  }
  return out;
}

/**
 * Does this written number name the record's value? Compares MAGNITUDES: a
 * sentence routinely expresses the sign in words ("fell 3.2%"), and the sign is
 * what the direction check exists to test separately.
 *
 * `bps` is read as hundredths of a percentage point, so "up 250 bps" locates a
 * record whose value is 2.5.
 */
function locatesRecord(parsed: ParsedNumber, record: NumericProvenanceRecord): boolean {
  const target = Math.abs(record.value);
  const candidates: { value: number; scale: number }[] = [
    { value: parsed.magnitude * parsed.scale, scale: parsed.scale },
  ];
  if (parsed.unitToken === "bp" || parsed.unitToken === "bps" ||
      parsed.unitToken === "basis point" || parsed.unitToken === "basis points") {
    candidates.push({ value: parsed.magnitude / 100, scale: 1 / 100 });
  }
  return candidates.some(({ value, scale }) => {
    const tolerance = Math.max(
      0.5 * 10 ** -parsed.decimals * Math.abs(scale),
      Math.abs(target) * 1e-9,
    );
    return Math.abs(value - target) <= tolerance;
  });
}

function unitFamilyOf(parsed: ParsedNumber): UnitFamily | null {
  const token = parsed.unitToken;
  if (token !== null) {
    if (PERCENT_TOKENS.has(token)) return "percent";
    if (MULTIPLE_TOKENS.has(token)) return "multiple";
    if (SHARE_TOKENS.has(token)) return "shares";
    if (MONEY_TOKENS.has(token)) return "money";
  }
  if (parsed.hadCurrencyPrefix) return "money";
  // A bare scale word ("416.2 billion") names a magnitude, not a unit — it only
  // implies money when nothing else claimed the number.
  if (parsed.scaleWord !== null) return "money";
  return null;
}

/**
 * Which unit families a registry unit can legitimately be written in. An empty
 * set means "this unit has no expected unit word", so the unit check skips it
 * rather than inventing a rule for dimensionless readings (scores, indices,
 * counts, durations).
 */
function admissibleFamilies(unit: CanonicalUnit): ReadonlySet<UnitFamily> {
  switch (unit) {
    case "currency":
    case "currency-per-share":
      return new Set<UnitFamily>(["money"]);
    case "percent":
    case "percentage-points":
    case "percentage-points-per-year":
      return new Set<UnitFamily>(["percent"]);
    case "ratio":
      return new Set<UnitFamily>(["multiple"]);
    case "shares":
      return new Set<UnitFamily>(["shares"]);
    default:
      return new Set<UnitFamily>();
  }
}

/* ------------------------------------------------------------------------ *
 * Direction
 * ------------------------------------------------------------------------ */

/**
 * Direction vocabulary. Deliberately EXCLUDES second-order and ambiguous words:
 * "accelerated"/"slowed"/"moderated" describe a change IN a rate (so "growth
 * slowed to 4%" is consistent with a +4 record and would be a false failure);
 * "widened"/"narrowed"/"reversed"/"recovered" carry the opposite sign depending
 * on whether the metric is a good or a bad thing. Leaving them out costs recall,
 * which `checked` reports honestly, and buys correctness.
 */
const DIRECTION_WORDS: Record<string, 1 | -1> = {
  rose: 1, rise: 1, rises: 1, rising: 1, risen: 1,
  increased: 1, increase: 1, increases: 1, increasing: 1,
  grew: 1, gained: 1, gain: 1, gains: 1,
  improved: 1, improvement: 1, improves: 1, improving: 1,
  expanded: 1, expansion: 1, expanding: 1,
  climbed: 1, jumped: 1, surged: 1, advanced: 1, strengthened: 1,
  higher: 1, up: 1,
  fell: -1, fall: -1, falls: -1, falling: -1, fallen: -1,
  declined: -1, decline: -1, declines: -1, declining: -1,
  decreased: -1, decrease: -1, decreases: -1, decreasing: -1,
  dropped: -1, drop: -1, drops: -1, dropping: -1,
  contracted: -1, contraction: -1, contracting: -1,
  shrank: -1, shrunk: -1, weakened: -1, deteriorated: -1,
  deterioration: -1, worsened: -1, slipped: -1, tumbled: -1, plunged: -1,
  lower: -1, down: -1,
};

/** Words between a direction verb and its number that break the delta reading. */
const DELTA_BREAKERS = /\b(?:to|toward|towards|at|from|versus|vs|than|of|near|around|about)\b/i;

const DIRECTION_WINDOW_CHARS = 40;

interface DirectionHit {
  word: string;
  polarity: 1 | -1;
  start: number;
  end: number;
}

function findDirectionWords(sentence: string): DirectionHit[] {
  const hits: DirectionHit[] = [];
  for (const match of sentence.matchAll(/[A-Za-z]+/g)) {
    const word = match[0].toLowerCase();
    const polarity = DIRECTION_WORDS[word];
    if (polarity === undefined) continue;
    hits.push({
      word,
      polarity,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return hits;
}

/**
 * A registry record is a SIGNED DELTA when its unit is a change in a percentage,
 * or when its identity names a change series. Level records (a revenue, a
 * margin, an ROIC) are excluded on purpose: "margin rose to 30%" says nothing
 * about the sign of 30, so there is no delta to disagree with.
 *
 * `return`/`momentum` are NOT treated as deltas even though they can be
 * negative: `computed.returns.*` in this pipeline is ROIC/ROE (levels), and
 * misreading those as deltas would fail correct sentences.
 */
export function isDeltaRecord(record: NumericProvenanceRecord): boolean {
  if (
    record.unit === "percentage-points" ||
    record.unit === "percentage-points-per-year"
  ) {
    return true;
  }
  const identity = `${record.id} ${record.origin}`.toLowerCase();
  return /(?:^|[.\-_ /])(growth|cagr|change|delta|chg|yoy|qoq|expansion|contraction|revision)/.test(
    identity,
  );
}

/* ------------------------------------------------------------------------ *
 * Period phrases
 * ------------------------------------------------------------------------ */

const PERIOD_PATTERNS: readonly RegExp[] = [
  /\bQ[1-4]\s*(?:of\s+)?(?:FY\s?)?['’]?(?:19|20)?\d{2}\b/gi,
  /\bFY\s?['’]?(?:19|20)?\d{2}\b/gi,
  /\b(?:first|second|third|fourth)\s+quarter\s+(?:of\s+)?(?:FY\s?)?(?:19|20)\d{2}\b/gi,
  /\b(?:19|20)\d{2}\b/g,
];

/**
 * Period phrases that NAME A YEAR. A bare "Q3" is skipped on purpose: without
 * the issuer's fiscal calendar there is no way to decide whether Q3 is the
 * record's ISO period end, and guessing would fail correct sentences (Apple's
 * Q3 FY2025 ends in June). Skipped means "not checked", and `checked` says so.
 */
export function findPeriodPhrases(sentence: string, numbers: readonly ParsedNumber[]): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();
  // A four-digit number that is really a VALUE (it carried a currency prefix, a
  // scale word or a unit) is not a year.
  const valueSpans = numbers
    .filter((n) => n.hadCurrencyPrefix || n.scaleWord !== null || n.unitToken !== null)
    .map((n) => [n.start, n.end] as const);
  for (const pattern of PERIOD_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of sentence.matchAll(pattern)) {
      const index = match.index ?? 0;
      const insideValue = valueSpans.some(([start, end]) => index >= start && index < end);
      if (insideValue) continue;
      const phrase = match[0].trim();
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      phrases.push(phrase);
    }
  }
  return phrases;
}

/* ------------------------------------------------------------------------ *
 * Named individuals
 * ------------------------------------------------------------------------ */

const HONORIFIC = String.raw`(?:Mr|Mrs|Ms|Miss|Dr|Sir|Prof)\.?`;
const ROLE_WORDS = String.raw`(?:CEO|CFO|COO|CTO|CIO|CMO|CAO|chief\s+(?:executive|financial|operating|technology|information|marketing|accounting)\s+officer|chairman|chairwoman|chairperson|chair|president|founder|co-founder|director|treasurer|controller|general\s+counsel)`;
const NAME_TOKEN = String.raw`[A-Z][a-zÀ-ɏ'’\-]{1,}`;
const NAME_PAIR = String.raw`${NAME_TOKEN}(?:\s+${NAME_TOKEN}){0,2}`;

const PERSON_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b${HONORIFIC}\s+${NAME_TOKEN}`, "g"),
  new RegExp(String.raw`\b${ROLE_WORDS}\s+${NAME_PAIR}`, "gi"),
  new RegExp(String.raw`\b${NAME_PAIR},\s+(?:the\s+)?${ROLE_WORDS}\b`, "gi"),
];

/**
 * Names of people this report may talk about, gathered from evidence rather
 * than guessed: the payload's key-executive and insider-trade notes, plus the
 * report's own executive cards. Used for exact-name detection; the patterns
 * above catch a person the payload never listed.
 */
export function collectPersonNames(sources: {
  leadershipNotes?: readonly string[];
  insiderNotes?: readonly string[];
  executiveNames?: readonly string[];
}): string[] {
  const names = new Set<string>();
  const add = (value: string | undefined): void => {
    const trimmed = value?.trim();
    // One word is a title or an initial, not an identifiable person.
    if (trimmed !== undefined && /\s/.test(trimmed) && trimmed.length >= 5) {
      names.add(trimmed);
    }
  };
  for (const note of sources.leadershipNotes ?? []) {
    add(note.split("—", 1)[0]);
  }
  for (const note of sources.insiderNotes ?? []) {
    // "2026-01-02 Jane Roe (officer): ..." — the name sits between the date and
    // the parenthesised owner type.
    add(/^\S+\s+([^(]+)\(/.exec(note)?.[1]);
  }
  for (const name of sources.executiveNames ?? []) add(name);
  return [...names];
}

/** Does this sentence name an identifiable person? */
export function namesIndividual(sentence: string, knownNames: readonly string[]): string | null {
  for (const name of knownNames) {
    if (sentence.includes(name)) return name;
  }
  for (const pattern of PERSON_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(sentence);
    if (match) return match[0].trim();
  }
  return null;
}

/**
 * Report paths whose claims are the EXECUTIVE CREDIBILITY record. These may cite
 * a registry figure or a filing/transcript text source, and nothing else — a
 * credibility grade built on a news summary or a search result is exactly the
 * kind of claim the payload was assembled to replace.
 */
export function isCredibilityPath(path: string): boolean {
  return (
    /^leadership\.executives\[\d+\]\.(?:reasoning|evidence\.guidanceVsActuals)\b/.test(path) ||
    path.startsWith("outlook.guidanceCredibility")
  );
}

/** A citation-registry id that is a filing or an earnings-call transcript. */
export function isFilingOrTranscriptSource(id: string): boolean {
  return /^edgar:/i.test(id) || /transcript/i.test(id);
}

/* ------------------------------------------------------------------------ *
 * The pass
 * ------------------------------------------------------------------------ */

function renderFigure(record: NumericProvenanceRecord | undefined, sourceId: string | null): string {
  if (record === undefined) return sourceId === null ? "[no cited figure]" : `[${sourceId}]`;
  const currency = record.currency === null ? "" : ` ${record.currency}`;
  return `${record.value} ${record.unit}${currency} [${record.id} · ${record.asOf}]`;
}

/**
 * Run every deterministic consistency check. Returns the failures (each naming
 * the sentence, the cited figure and the reason) plus how many pairs each check
 * was actually able to evaluate.
 */
export function runConsistencyChecks(input: ConsistencyInput): ConsistencyResult {
  const direction = new Counter();
  const period = new Counter();
  const unit = new Counter();
  const namedIndividual = new Counter();
  const findings: ConsistencyFinding[] = [];
  const rejectedClaimPaths = new Set<string>();

  for (const { claim, path } of input.claims) {
    const sourceId = citationSourceId(claim);
    const record = sourceId === null
      ? undefined
      : input.registry.find((entry) => entry.id === sourceId);
    const sentence = claim.text;
    const figure = renderFigure(record, sourceId);

    const fail = (
      check: ConsistencyCheckKind,
      reason: ConsistencyFailureReason,
      note: string,
    ): void => {
      findings.push({ check, reason, sentence, figure, sourceId, path, note });
    };

    /* ---- named individuals (applies to every claim, cited or not) -------- */
    const person = namesIndividual(sentence, input.personNames);
    const credibility = isCredibilityPath(path);
    if (person !== null || credibility) {
      const citation = sourceId === null
        ? undefined
        : input.citationRegistry.find((entry) => entry.id === sourceId);
      const canonicalUrl = sourceId === null ? null : canonicalizeFetchedUrl(sourceId);
      const isWeb = canonicalUrl !== null;
      const allowed =
        record !== undefined ||
        (citation !== undefined &&
          (!credibility || isFilingOrTranscriptSource(citation.id)));
      if (allowed) {
        namedIndividual.pass();
      } else {
        namedIndividual.fail();
        rejectedClaimPaths.add(path);
        if (credibility && person === null) {
          fail(
            "named-individual",
            "credibility-source-restricted",
            `An executive-credibility claim may cite only a registry figure or a filing/transcript text source; this one cites ${sourceId === null ? "nothing" : `"${sourceId}"`}.`,
          );
        } else if (isWeb && input.fetchedUrls.has(canonicalUrl)) {
          fail(
            "named-individual",
            "named-individual-web-source",
            `The claim names ${person ?? "an individual"} but rests on a web-search result (${sourceId}); claims about named people are restricted to filings and transcripts.`,
          );
        } else {
          fail(
            "named-individual",
            "named-individual-unsourced",
            `The claim names ${person ?? "an individual"} but cites ${sourceId === null ? "nothing" : `"${sourceId}"`}, which is neither a registry figure nor a filing or transcript.`,
          );
        }
      }
    }

    /* ---- the numeric checks need a located registry figure --------------- */
    if (record === undefined) continue;
    const numbers = parseNumbers(sentence);
    const located = numbers.filter((parsed) => locatesRecord(parsed, record));

    /* ---- period ---------------------------------------------------------- */
    if (record.period !== null) {
      const phrases = findPeriodPhrases(sentence, numbers);
      if (phrases.length > 0) {
        if (phrases.some((phrase) => periodsAgree(phrase, record.period))) {
          period.pass();
        } else {
          period.fail();
          fail(
            "period",
            "period-word-mismatch",
            `The sentence names ${phrases.map((p) => `"${p}"`).join(", ")} but the cited figure is registered for period ${record.period}.`,
          );
        }
      }
    }

    if (located.length === 0) continue;

    /* ---- unit ------------------------------------------------------------ */
    const admissible = admissibleFamilies(record.unit);
    if (admissible.size > 0) {
      const families = located
        .map((parsed) => unitFamilyOf(parsed))
        .filter((family): family is UnitFamily => family !== null);
      if (families.length > 0) {
        const wrong = families.filter((family) => !admissible.has(family));
        if (wrong.length === 0) {
          unit.pass();
        } else {
          unit.fail();
          fail(
            "unit",
            "unit-word-mismatch",
            `The sentence writes the cited figure in ${[...new Set(wrong)].join("/")} units, but the registry records it as ${record.unit}${record.currency === null ? "" : ` (${record.currency})`}.`,
          );
        }
      }
    }

    /* ---- direction ------------------------------------------------------- */
    if (isDeltaRecord(record) && record.value !== 0) {
      const hits = findDirectionWords(sentence);
      const attached = hits.filter((hit) =>
        located.some((parsed) => {
          if (hit.end > parsed.start) return false;
          if (parsed.start - hit.end > DIRECTION_WINDOW_CHARS) return false;
          return !DELTA_BREAKERS.test(sentence.slice(hit.end, parsed.start));
        }),
      );
      if (attached.length > 0) {
        const expected = record.value > 0 ? 1 : -1;
        const wrong = attached.filter((hit) => hit.polarity !== expected);
        if (wrong.length === 0) {
          direction.pass();
        } else {
          direction.fail();
          fail(
            "direction",
            "direction-mismatch",
            `The sentence says "${wrong[0].word}" about the cited change, but the registry records it as ${record.value > 0 ? "positive" : "negative"} (${record.value} ${record.unit}).`,
          );
        }
      }
    }
  }

  return {
    findings,
    checks: {
      direction: direction.rate(),
      period: period.rate(),
      unit: unit.rate(),
      namedIndividual: namedIndividual.rate(),
    },
    rejectedClaimPaths,
  };
}

/** Every check family reported zero-checked (no claims, or verification skipped). */
export function emptyConsistencyChecks(): ConsistencyChecks {
  const zero: CheckRate = { checked: 0, passed: 0, failed: 0, rate: null };
  return { direction: zero, period: zero, unit: zero, namedIndividual: { ...zero } };
}
