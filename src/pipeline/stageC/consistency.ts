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
 *  - DIRECTION: a direction word ("rose", "fell", "declined") glued to the cited
 *    figure must match the sign of that figure, when the figure is a signed
 *    change rather than a level. Only words whose sign is fixed by the word
 *    itself count; see {@link DIRECTION_WORDS}.
 *  - PERIOD: a period phrase that names a year ("in Q3 2025", "in FY2025") must
 *    name the period the cited record carries, under the SAME fiscal-spelling
 *    tolerance the citation check already uses ({@link periodsAgree}).
 *  - UNIT: the unit token attached to the cited figure ("%", "bps", "billion")
 *    must belong to the family the record's registry unit can express.
 *  - NAMED INDIVIDUAL: a claim that names a person may cite filings, transcripts
 *    or registry figures — never a web-search result, never any other web
 *    citation (news, a press release), and never nothing.
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
 * How a number in the sentence came to match the record's value. Lower is a
 * better match, and only the best rank present in a sentence is kept (see
 * {@link locateRecord}).
 */
const enum LocateRank {
  /** The written scale IS the record's scale: a scale word, a bare number, bps. */
  Written = 0,
  /** A speculative display scale, but the number was written as money ("$5.0"). */
  SpeculativeCurrency = 1,
  /** A speculative display scale on a number that claimed no money at all. */
  Speculative = 2,
}

/**
 * Does this written number name the record's value, and how confidently?
 * Compares MAGNITUDES: a sentence routinely expresses the sign in words ("fell
 * 3.2%"), and the sign is what the direction check exists to test separately.
 * Returns the {@link LocateRank} of the best matching reading, or null.
 *
 * `bps` is read as hundredths of a percentage point, so "up 250 bps" locates a
 * record whose value is 2.5.
 */
function locateRecord(
  parsed: ParsedNumber,
  record: NumericProvenanceRecord,
): LocateRank | null {
  const target = Math.abs(record.value);
  const candidates: { value: number; scale: number; rank: LocateRank }[] = [
    { value: parsed.magnitude * parsed.scale, scale: parsed.scale, rank: LocateRank.Written },
  ];
  if (parsed.unitToken === "bp" || parsed.unitToken === "bps" ||
      parsed.unitToken === "basis point" || parsed.unitToken === "basis points") {
    candidates.push({ value: parsed.magnitude / 100, scale: 1 / 100, rank: LocateRank.Written });
  }
  // A LARGE-MAGNITUDE record (money, share counts) is registered in units and
  // written in billions, so a writer who names the wrong unit — "revenue was
  // 416.2%" for a $416.2bn figure — leaves no scale word to read the scale
  // from. Try the display scales for those records only. Doing it for every
  // record would be unsafe: a 6.4-percent record would then be "located" by an
  // unrelated "$6.4 billion" elsewhere in the sentence and fail its own unit
  // check. These readings are SPECULATIVE — the sentence never wrote that
  // scale — which is why they rank below a written one.
  const scalable = record.unit === "currency" || record.unit === "currency-per-share" ||
    record.unit === "shares";
  if (scalable && parsed.scaleWord === null) {
    const rank = parsed.hadCurrencyPrefix
      ? LocateRank.SpeculativeCurrency
      : LocateRank.Speculative;
    for (const scale of [1e3, 1e6, 1e9, 1e12]) {
      candidates.push({ value: parsed.magnitude * scale, scale, rank });
    }
  }
  let best: LocateRank | null = null;
  for (const { value, scale, rank } of candidates) {
    const tolerance = Math.max(
      0.5 * 10 ** -parsed.decimals * Math.abs(scale),
      Math.abs(target) * 1e-9,
    );
    if (Math.abs(value - target) <= tolerance && (best === null || rank < best)) best = rank;
  }
  return best;
}

/**
 * The numbers in a sentence that name the cited record, keeping only the
 * BEST-SCALE readings.
 *
 * Two numbers can both "locate" one record when a percentage coincides with a
 * scaled currency value: "Revenue of $5.0 billion came with a 5.0% operating
 * margin" against a $5.0e9 record located BOTH the correctly written figure and
 * the unrelated percentage (5.0 × 1e9). The percentage then failed the unit
 * check — one spurious match poisoning an otherwise correct sentence. A reading
 * whose scale the sentence actually wrote (a scale word, a bare number, bps),
 * or failing that one written as money, always wins over a speculative display
 * scale, so the check decides on the figure the sentence really cited.
 */
function locateNumbers(
  numbers: readonly ParsedNumber[],
  record: NumericProvenanceRecord,
): ParsedNumber[] {
  const hits = numbers.flatMap((parsed) => {
    const rank = locateRecord(parsed, record);
    return rank === null ? [] : [{ parsed, rank }];
  });
  if (hits.length === 0) return [];
  const best = Math.min(...hits.map((hit) => hit.rank));
  return hits.filter((hit) => hit.rank === best).map((hit) => hit.parsed);
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
 * Direction vocabulary. Every entry names the sign of the NUMBER, never a
 * judgement about it. Deliberately EXCLUDES three groups:
 *
 *  - second-order words — "accelerated"/"slowed"/"moderated" describe a change
 *    IN a rate, so "growth slowed to 4%" is consistent with a +4 record;
 *  - sign-by-context words — "widened"/"narrowed"/"reversed"/"recovered" carry
 *    the opposite sign depending on whether the metric is a good or a bad thing;
 *  - EVALUATIVE words, removed 2026-09 for exactly the same reason as the group
 *    above: "improved"/"improvement"/"improves"/"improving"/"strengthened" and
 *    "weakened"/"deteriorated"/"deterioration"/"worsened" say the metric got
 *    better or worse, and for a lower-is-better metric (net leverage, churn,
 *    DSO, net debt, a cost ratio) better IS a negative number. "Net leverage
 *    improved 0.4 points" against a -0.4pp record is correct prose and was
 *    being filed as a direction mismatch.
 *
 * Leaving them out costs recall, which `checked` reports honestly, and buys
 * correctness.
 */
const DIRECTION_WORDS: Record<string, 1 | -1> = {
  rose: 1, rise: 1, rises: 1, rising: 1, risen: 1,
  increased: 1, increase: 1, increases: 1, increasing: 1,
  grew: 1, gained: 1, gain: 1, gains: 1,
  expanded: 1, expansion: 1, expanding: 1,
  climbed: 1, jumped: 1, surged: 1, advanced: 1,
  higher: 1, up: 1,
  fell: -1, fall: -1, falls: -1, falling: -1, fallen: -1,
  declined: -1, decline: -1, declines: -1, declining: -1,
  decreased: -1, decrease: -1, decreases: -1, decreasing: -1,
  dropped: -1, drop: -1, drops: -1, dropping: -1,
  contracted: -1, contraction: -1, contracting: -1,
  shrank: -1, shrunk: -1, slipped: -1, tumbled: -1, plunged: -1,
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

// The quarter pattern REQUIRES the century (2026-09). With it optional the two
// digits swallowed whatever number followed the quarter: "Q1 15% growth was
// reported" matched "Q1 15" and failed against a 2025-12-31 record, claiming the
// sentence named a period it never named. The phrase starts at the Q, so the
// "skip a phrase starting inside a value span" guard below could not help. The
// forms that lose their quarter this way — "Q3 '25", "Q1 25" — could never have
// PASSED anyway: periodsAgree only reads a two-digit year behind an FY prefix,
// so they failed every record. "Q3 FY25" keeps its check through the FY pattern
// on the next line.
const PERIOD_PATTERNS: readonly RegExp[] = [
  /\bQ[1-4]\s*(?:of\s+)?(?:FY\s?)?['’]?(?:19|20)\d{2}\b/gi,
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
export function findPeriodPhrases(
  sentence: string,
  numbers: readonly ParsedNumber[],
  located: readonly ParsedNumber[] = [],
): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();
  // A four-digit number that is really a VALUE is not a year. Two ways to tell:
  // it carried a currency prefix, a scale word or a unit token, or it IS the
  // cited figure's value (a record whose value happens to be 2025 reads as
  // "2025 units", not as a fiscal year).
  const valueSpans = [
    ...numbers.filter((n) => n.hadCurrencyPrefix || n.scaleWord !== null || n.unitToken !== null),
    ...located,
  ].map((n) => [n.start, n.end] as const);
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
// Case-VARIANT rather than case-INSENSITIVE: the `i` flag would also relax the
// capital-letter requirement in NAME_TOKEN, so "The CEO reiterated guidance"
// matched "CEO reiterated guidance" as a person. Roles are spelled both ways;
// names must still start with a capital.
const ROLE_WORDS = String.raw`(?:CEO|CFO|COO|CTO|CIO|CMO|CAO|[Cc]hief\s+[A-Za-z]+\s+[Oo]fficer|[Cc]hair(?:man|woman|person)?|[Pp]resident|[Ff]ounder|[Cc]o-?[Ff]ounder|[Dd]irector|[Tt]reasurer|[Cc]ontroller|[Gg]eneral\s+[Cc]ounsel)`;
const NAME_TOKEN = String.raw`[A-Z][a-zÀ-ɏ'’\-]{1,}`;
const NAME_PAIR = String.raw`${NAME_TOKEN}(?:\s+${NAME_TOKEN}){0,2}`;

const PERSON_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b${HONORIFIC}\s+${NAME_TOKEN}`, "g"),
  new RegExp(String.raw`\b${ROLE_WORDS}\s+${NAME_PAIR}`, "g"),
  new RegExp(String.raw`\b${NAME_PAIR},\s+(?:the\s+)?${ROLE_WORDS}\b`, "g"),
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
      // The filing-or-transcript restriction applies to EVERY claim that names
      // a person, not only to the executive-credibility section (2026-09). It
      // previously ran on the credibility path alone, so an ordinary claim
      // naming a person could cite anything in the citation registry — news, a
      // press release — while the prompt, the module docstring and the reader-
      // facing table all said "filings/transcripts only". Registry figures stay
      // admissible: a traced number is the payload itself, not a source about
      // a person.
      const allowed =
        record !== undefined ||
        (citation !== undefined && isFilingOrTranscriptSource(citation.id));
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
    const located = locateNumbers(numbers, record);

    /* ---- period ---------------------------------------------------------- */
    if (record.period !== null) {
      const phrases = findPeriodPhrases(sentence, numbers, located);
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
      // The NEAREST qualifying direction word owns the figure. "Operating income
      // rose 12.0% while revenue slipped 3.2%" cites the 3.2% decline, and the
      // word attached to it is "slipped", not the "rose" that belongs to the
      // other figure earlier in the sentence.
      const attached = located.flatMap((parsed) => {
        let nearest: DirectionHit | null = null;
        for (const hit of hits) {
          if (hit.end > parsed.start) continue;
          if (parsed.start - hit.end > DIRECTION_WINDOW_CHARS) continue;
          if (DELTA_BREAKERS.test(sentence.slice(hit.end, parsed.start))) continue;
          if (nearest === null || hit.end > nearest.end) nearest = hit;
        }
        return nearest === null ? [] : [nearest];
      });
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

const CHECK_MANIFEST_TEXT: Record<keyof ConsistencyChecks, string> = {
  direction: "sentence(s) whose direction word contradicts the sign of the change they cite",
  period: "sentence(s) naming a period the figure they cite is not registered for",
  unit: "sentence(s) writing a cited figure in a unit the registry does not record it in",
  namedIndividual:
    "claim(s) about a named individual, or in the executive-credibility section, resting on a source outside filings and transcripts",
};

/**
 * Manifest disclosure for the deterministic checks. A failure that lives only in
 * the verification log is easy to miss; the missing-data manifest is where a
 * reader already looks for "what is wrong with this report", so each failing
 * family gets one entry naming the count and pointing at the detailed rows.
 * Families with nothing to report add nothing — the manifest is not a scoreboard.
 */
export function consistencyManifestEntries(
  checks: ConsistencyChecks,
): { field: string; reason: string; severity: "warn"; attemptedSources: string[] }[] {
  return (Object.keys(CHECK_MANIFEST_TEXT) as (keyof ConsistencyChecks)[]).flatMap((family) => {
    const rate = checks[family];
    if (rate.failed === 0) return [];
    return [
      {
        field: `verify.check.${family}`,
        reason: `${rate.failed} of ${rate.checked} checked ${CHECK_MANIFEST_TEXT[family]}. Each one is listed in the verification log with the sentence, the cited figure and the reason.`,
        severity: "warn" as const,
        attemptedSources: ["deterministic-verify"],
      },
    ];
  });
}
