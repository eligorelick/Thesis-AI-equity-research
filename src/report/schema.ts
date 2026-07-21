/**
 * The Report Zod schema — THE contract for the entire Thesis Report object.
 *
 * This module is the single source of truth for the shape of a generated
 * report (the application contract §7 sections 1–13). It is consumed by:
 *   - the LLM passes, which request output via Anthropic structured outputs
 *     (`output_config.format`) using {@link reportToJsonSchema} / the pass-level
 *     sub-schemas, and are additionally validated with Zod on the way back;
 *   - the pipeline job runner, which fills `meta`/`appendix` around the judge
 *     output and persists the parsed `Report`;
 *   - the UI, which renders `Report` and diffs two of them (see ./diff.ts).
 *
 * Design principles (non-negotiable analysis rules, the application contract §1):
 *   1. Every LLM-authored claim is a {@link SourcedClaim} carrying its label
 *      (FACT | ESTIMATE | JUDGMENT), a `source` payload-path/citation, and an
 *      `asOf` date. Rule #2 ("every claim is labeled") and #5 ("every figure
 *      carries its as-of date") are structural here, not conventions.
 *   2. Every numeric the LLM emits is a {@link TracedNumber} — value + unit +
 *      source + asOf, plus a `verified` flag the verification pass sets. Rule
 *      #1 ("no figure from model memory") is enforced downstream by the
 *      verification pass tracing each `source`; the schema makes the source
 *      mandatory so an untraceable number cannot even be represented.
 *   3. Per-section grades are {@link GradeBlock}s: grade + one-line why +
 *      reasoning (SourcedClaims) + confidence + the key numbers behind it.
 *   4. NOTHING permits buy/sell/hold *ratings*. Selected pass-level strings and
 *      the complete final Report object are guarded by {@link noBuySellHold}.
 *      See the refine docs below for exactly what is and is not rejected.
 *
 * Strictness: every object is `.strict()` so an LLM emitting an unexpected key
 * fails Zod validation (and the pipeline retries with the error fed back). The
 * JSON-schema emitted for the model likewise closes every object with
 * `additionalProperties: false` (see {@link reportToJsonSchema}).
 *
 * Zod v4: schemas use `import { z } from "zod"` and JSON Schema is produced
 * with the native `z.toJSONSchema(...)`.
 */

import { z } from "zod";

import type { Grade, ClaimLabel, ManifestEntry } from "@/types/core";

/** Bumped whenever the report shape changes in a persistence-visible way. */
export const REPORT_SPEC_VERSION = "1.2.0" as const;

/* ------------------------------------------------------------------------ *
 * Legacy-read leniency
 *
 * The asOf ISO-date format and the rating-language gates are SAVE-time
 * contracts (SPEC §1 rule #3 says "before a report can be saved"). Reports
 * persisted under earlier spec versions contain asOf strings like "2026-06"
 * or "2025-12-31/2026-05-05" and prose the newer regex battery would reject —
 * re-validating them retroactively on READ would make already-paid reports
 * unrenderable (observed 2026-07-20: 12 of 36 stored reports). The stored-
 * report read path (history.parseStoredReport) therefore retries a failed
 * strict parse inside withLenientLegacyRead, which relaxes ONLY these two
 * gates; shape/strictness/enums stay fully enforced, and every save/assembly
 * path keeps using the strict schema directly.
 * ------------------------------------------------------------------------ */

let lenientLegacyRead = false;

/** Run fn with the two save-time-only gates relaxed (legacy stored reports). */
export function withLenientLegacyRead<T>(fn: () => T): T {
  lenientLegacyRead = true;
  try {
    return fn();
  } finally {
    lenientLegacyRead = false;
  }
}

const STRICT_ISO_DATE = z.iso.date();

/** Strict calendar date used by newly generated evidence objects. */
export const IsoDateSchema = z.string().refine(
  (v) => lenientLegacyRead || STRICT_ISO_DATE.safeParse(v).success,
  { message: "Invalid ISO date" },
);

/* ------------------------------------------------------------------------ *
 * Buy/sell/hold guard (the application contract §1 rule #3)
 * ------------------------------------------------------------------------ */

/**
 * Rejects investment *ratings* phrased as buy / sell / hold (SPEC §1 rule #3).
 *
 * A structural tripwire, not a semantic classifier. The key distinction: buy /
 * sell / hold used as a RATING / DIRECTIVE about the security is prohibited; the same
 * words used as ordinary business VERBS about the company are fine. The old
 * implementation matched a bare `\b(buy|sell|hold)\b`, which false-positived on
 * routine analyst language ("Intuit holds ~35% margins", "customers buy the
 * premium tier", "cross-sell drives ARPU") and hard-failed whole reports on a
 * single stray verb. This version matches only rating CONTEXT.
 *
 *   REJECTS (rating / recommendation / directive):
 *     "Buy", "Strong Buy", "Sell rating", "rating: Hold", "we would sell",
 *     "recommend buying", "Sell the position", "buy the dip", "a clear sell",
 *     "Hold and wait for a pullback.", "Sell into strength".
 *   ALLOWS (business verbs / analytic vocabulary):
 *     "holds ~35% margins", "hold margins steady", "hold the line on costs",
 *     "customers buy the tier", "cross-sell / up-sell", "sell more seats",
 *     "buyback", "sell-side", "shareholder", "holding company", "household".
 *
 * Returns `true` when the text is CLEAN — suitable as a
 * `z.string().refine(noBuySellHold, ...)` predicate.
 */
const RATING_PATTERNS: readonly RegExp[] = [
  // "Strong Buy" / "strong sell" / "strong-hold".
  /\bstrong[\s-]+(?:buy|sell|hold)\b/i,
  // buy/sell/hold labelled a rating / recommendation / call (either order).
  /\b(?:buy|sell|hold)(?:\s*\/\s*(?:buy|sell|hold))*[\s-]+(?:rating|recommendation|call)s?\b/i,
  /\b(?:rating|recommendation|call)s?\b[\s:=—–-]+(?:of\s+|to\s+|is\s+|was\s+|remains?\s+|stays?\s+)?(?:a\s+|an\s+)?(?:strong\s+)?(?:buy|sell|hold)\b/i,
  // First-person / analyst recommendation to act on the security.
  /\b(?:we|i|you|they|analysts?)\b[\s\w',]{0,20}\b(?:would|should|'?d)\b[\s\w',]{0,14}\b(?:buy|sell|hold)\b/i,
  /\brecommend(?:s|ed|ing|ation)?\b[\s\w',]{0,14}\b(?:buy(?:ing)?|sell(?:ing)?|hold(?:ing)?)\b/i,
  // Directive about the SECURITY itself: "Sell the position/stock", "buy the
  // dip", "buy/sell into strength" — NOT operational objects (margins, tier…).
  /\b(?:buy|sell|hold)\s+(?:the\s+|this\s+|these\s+|its\s+|your\s+|our\s+)?(?:stock|shares?|position|name|security|equity|dip)\b/i,
  /\b(?:overweight|underweight|accumulate|avoid)\s+(?:the\s+|this\s+|these\s+|your\s+|our\s+)?(?:stock|shares?|position|name|security|equity)\b/i,
  /\b(?:buy|sell)\s+(?:in|into)\s+(?:strength|weakness|the\s+rally|the\s+dip|the\s+print)\b/i,
  // Common rating equivalents, only in explicit rating/label contexts so
  // operational statements such as "the product outperforms" remain valid.
  /\b(?:strong\s+)?(?:outperform|underperform|overweight|underweight|accumulate|avoid)[\s-]+(?:rating|recommendation|call)s?\b/i,
  /^(?:strong\s+)?(?:outperform|underperform|overweight|underweight|accumulate|avoid)[.!]?$/i,
  // Portfolio-allocation directive. Inflected operational prose such as
  // "hedging reduced exposure" does not match the imperative form.
  /(?:^|[.!?;]\s+)(?:please\s+)?reduce\s+(?:your\s+|our\s+|the\s+)?(?:portfolio\s+)?exposure\b/i,
  /\b(?:we|you|investors?|shareholders?)\s+(?:should|must|need\s+to)\s+reduce\s+(?:their\s+|your\s+|our\s+)?(?:portfolio\s+)?exposure\b/i,
  // A bare rating label: "a clear sell", "an outright buy", "it's a Hold".
  /\b(?:a|an)\s+(?:clear\s+|outright\s+|obvious\s+|strong\s+|decisive\s+|near-?\s*)?(?:buy|sell|hold)\b(?!-|\s+(?:on|of|in|over|to|the\s+line|margins?|shares?|steady))/i,
  // Sentence-initial imperative directive — excludes operational verbs like
  // "Hold margins", "Sell more seats", and hyphen compounds ("Sell-side …").
  /(?:^|[.!?;]\s+)(?:strong\s+)?(?:buy|sell|hold)\b(?!-|\s+(?:margins?|the\s+line|market\s+share|shares?\b|steady|off\b|back\b|out\b|up\b|onto\b|through\b|more\b|additional\b|new\b|of\b))/i,
  // The whole trimmed value is nothing but a rating word.
  /^(?:strong\s+)?(?:buy|sell|hold)[.!]?$/i,
];

export function noBuySellHold(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return true;
  return !RATING_PATTERNS.some((re) => re.test(text));
}

const NO_RATING_MESSAGE =
  "buy/sell/hold rating language is prohibited (the application contract §1 rule #3) — use probability-weighted scenarios and 'what would have to be true' framing instead";

/** Attach the buy/sell/hold refine to a string schema (save-time gate). */
function ratingSafeString() {
  return z.string().refine((v) => lenientLegacyRead || noBuySellHold(v), {
    message: NO_RATING_MESSAGE,
  });
}

/** Machine identifiers are not prose and must not be interpreted as ratings. */
const NON_NARRATIVE_STRING_KEYS = new Set([
  "source",
  "symbol",
  "companyName",
  "unit",
  "currency",
  "period",
  "asOf",
  "generatedAt",
  "specVersion",
  "pipelineVersion",
  "model",
  "verifyModel",
  "provider",
  "endpoint",
  "fetchedAt",
  "method",
  "methodVersion",
  "weightsVersion",
  "bandsVersion",
  "step",
  "name",
  "disclaimer",
]);

function enforceRecursiveRatingSafety(value: unknown, ctx: z.RefinementCtx): void {
  if (lenientLegacyRead) return; // save-time gate — see withLenientLegacyRead
  const walk = (
    node: unknown,
    path: PropertyKey[],
    field: string | null,
  ): void => {
    if (typeof node === "string") {
      if (
        (field === null || !NON_NARRATIVE_STRING_KEYS.has(field)) &&
        !noBuySellHold(node)
      ) {
        ctx.addIssue({ code: "custom", path, message: NO_RATING_MESSAGE });
      }
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, index], field));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, [...path, key], key);
    }
  };
  walk(value, [], null);
}

/* ------------------------------------------------------------------------ *
 * Primitive enums (mirror src/types/core.ts as Zod values)
 * ------------------------------------------------------------------------ */

/** A–F, matching {@link Grade} from core.ts. */
export const GradeSchema = z.enum(["A", "B", "C", "D", "F"]);

/** FACT | ESTIMATE | JUDGMENT, matching {@link ClaimLabel} from core.ts. */
export const ClaimLabelSchema = z.enum(["FACT", "ESTIMATE", "JUDGMENT"]);

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);

export const SignificanceSchema = z.enum(["high", "medium", "low"]);

export const SeverityLowMedHighSchema = z.enum(["high", "medium", "low"]);

// Compile-time guarantee the Zod enums stay in lockstep with core.ts. If core
// changes a member, one of these lines fails to typecheck.
type _GradeMatches = z.infer<typeof GradeSchema> extends Grade
  ? Grade extends z.infer<typeof GradeSchema>
    ? true
    : never
  : never;
type _LabelMatches = z.infer<typeof ClaimLabelSchema> extends ClaimLabel
  ? ClaimLabel extends z.infer<typeof ClaimLabelSchema>
    ? true
    : never
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _gradeMatches: _GradeMatches = true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _labelMatches: _LabelMatches = true;

/* ------------------------------------------------------------------------ *
 * Core building blocks: SourcedClaim, TracedNumber, GradeBlock
 * ------------------------------------------------------------------------ */

/**
 * Every LLM-authored claim. `source` is a payload path or citation, e.g.
 *   "computed.growth.revenueCagr5y" | "web:https://…" | "transcript" |
 *   "10-K item1A". `asOf` is the ISO date the claim is as-of, or null when the
 *   claim is a timeless judgment.
 */
export const SourcedClaimSchema = z
  .object({
    text: z.string(),
    label: ClaimLabelSchema,
    /** Canonical structured citation identity (1.2.0+). */
    sourceId: z.string().trim().min(1).optional(),
    /** Legacy display/source field retained for persisted-report compatibility. */
    source: z.string().trim().min(1),
    asOf: IsoDateSchema.nullable(),
  })
  .strict();
export type SourcedClaim = z.infer<typeof SourcedClaimSchema>;

/**
 * Every numeric the LLM emits. `verified` is null until the verification pass
 * runs, then true (traced to a cached payload / cited source) or false
 * (untraceable — flagged `[unverified]` or removed). `verificationNote` is an
 * optional free-text note from that pass.
 */
export const TracedNumberSchema = z
  .object({
    value: z.number().finite(),
    unit: z.string(),
    /** ISO-4217 currency for monetary values; optional only for legacy reports. */
    currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
    /** Fiscal/forecast period; optional only for legacy reports. */
    period: z.string().trim().min(1).nullable().optional(),
    /** Canonical structured citation identity (1.2.0+). */
    sourceId: z.string().trim().min(1).optional(),
    /** Legacy display/source field retained for persisted-report compatibility. */
    source: z.string().trim().min(1),
    asOf: IsoDateSchema.nullable(),
    /** null = not yet verified; set by the verification pass (the application contract §5). */
    verified: z.boolean().nullable(),
    verificationNote: z.string().optional(),
  })
  .strict();
export type TracedNumber = z.infer<typeof TracedNumberSchema>;

/**
 * A graded section: grade + one-line why + full reasoning + confidence + the
 * numbers behind the grade. `oneLineWhy` is rating-safe free text.
 */
export const GradeBlockSchema = z
  .object({
    grade: GradeSchema,
    oneLineWhy: ratingSafeString(),
    reasoning: z.array(SourcedClaimSchema),
    confidence: ConfidenceSchema,
    keyNumbers: z.array(TracedNumberSchema),
    /**
     * Fuller "what this means" interpretation for the aspect (rating-safe).
     * Optional for backward-compat with 1.0.0 reports; the judge is prompted to
     * fill it on 1.1.0+ so each graded section reads like an analyst's note, not
     * a terse one-liner (the application contract §7 "feel interpreted").
     */
    interpretation: ratingSafeString().optional(),
  })
  .strict();
export type GradeBlock = z.infer<typeof GradeBlockSchema>;

export const CoverageRateSchema = z
  .object({
    supported: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    rate: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const JudgmentCoverageSchema = z
  .object({
    cited: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    rate: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const ProvenanceCoverageSchema = z
  .object({
    numeric: CoverageRateSchema,
    factualClaims: CoverageRateSchema,
    judgments: JudgmentCoverageSchema,
  })
  .strict()
  .superRefine((coverage, ctx) => {
    const validate = (
      value: { supported: number; total: number; rate: number | null },
      path: "numeric" | "factualClaims" | "judgments",
      countKey: "supported" | "cited",
    ): void => {
      if (value.supported > value.total) {
        ctx.addIssue({
          code: "custom",
          path: [path, countKey],
          message: `${countKey} cannot exceed total`,
        });
      }
      const expected = value.total === 0 ? null : value.supported / value.total;
      if (
        value.rate !== expected &&
        !(
          value.rate !== null &&
          expected !== null &&
          Math.abs(value.rate - expected) <= 1e-12
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: [path, "rate"],
          message: `rate must equal ${countKey} / total, or null when total is zero`,
        });
      }
    };
    validate(coverage.numeric, "numeric", "supported");
    validate(coverage.factualClaims, "factualClaims", "supported");
    validate(
      {
        supported: coverage.judgments.cited,
        total: coverage.judgments.total,
        rate: coverage.judgments.rate,
      },
      "judgments",
      "cited",
    );
  });
export type ProvenanceCoverage = z.infer<typeof ProvenanceCoverageSchema>;

/* ------------------------------------------------------------------------ *
 * §7.0 meta
 * ------------------------------------------------------------------------ */

export const DISCLAIMER_TEXT =
  "Informational only — not investment advice." as const;

export const DataCompletenessSchema = z
  .object({
    state: z.enum(["complete", "degraded", "blocked"]),
    criticalCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
    edgar: z.enum(["available", "missing"]),
    xbrl: z.enum(["checked", "skipped", "failed"]),
    forensicValidation: z.enum(["complete", "provisional"]),
  })
  .strict();
export type DataCompleteness = z.infer<typeof DataCompletenessSchema>;

export const ExecutionMetadataEntrySchema = z
  .object({
    step: z.string(),
    requestedModel: z.string(),
    effectiveModel: z.string(),
    requestedEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable(),
    effectiveEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable(),
    fallbackUsed: z.boolean(),
    adjustments: z.array(z.enum(["model-floor", "fallback", "effort-stripped"])),
  })
  .strict();
export type ExecutionMetadataEntry = z.infer<typeof ExecutionMetadataEntrySchema>;

export const MetaSchema = z
  .object({
    symbol: z.string(),
    companyName: z.string(),
    generatedAt: z.string(),
    /** Job/report lifecycle identifiers and timestamps (1.2.0+). */
    runId: z.string().optional(),
    reportId: z.number().int().positive().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    persistedAt: z.string().optional(),
    specVersion: z.string(),
    model: z.string(),
    verifyModel: z.string().optional(),
    pipelineVersion: z.string(),
    costUsd: z.number(),
    /**
     * CITATION COVERAGE: fraction of report numbers traced to a citation or a
     * payload value; null until the pass runs. This is a provenance check, NOT
     * a correctness/accuracy check — the field name is kept for backward-compat
     * with persisted reports (see citationOutcomeLabel).
     */
    verificationRate: z.number().nullable(),
    /** Explicit provenance metrics; optional only for reports before 1.2.0. */
    provenanceCoverage: ProvenanceCoverageSchema.optional(),
    /** Provider/critical-section gate; optional for legacy persisted reports. */
    dataCompleteness: DataCompletenessSchema.optional(),
    /** Requested versus effective per-pass execution settings. */
    execution: z.array(ExecutionMetadataEntrySchema).optional(),
    /**
     * DISCLAIMER: stored verbatim from the constant in force at generation time.
     * Parse-side accepts ANY non-empty string so a future edit to DISCLAIMER_TEXT
     * never bricks historical reports (every read path safeParses the whole
     * ReportSchema and degrades to null on failure — see L5 audit). Generation
     * still embeds the CURRENT DISCLAIMER_TEXT (pinned by generation-side tests);
     * renderers display the stored text as written.
     */
    disclaimer: z.string().min(1),
    /** field dot-path -> ISO as-of date (the application contract §1 rule #5). */
    asOfMap: z.record(z.string(), z.string()),
  })
  .strict();
export type ReportMeta = z.infer<typeof MetaSchema>;

/* ------------------------------------------------------------------------ *
 * §7.1 verdict
 * ------------------------------------------------------------------------ */

export const GradeStripSchema = z
  .object({
    fundamentals: GradeBlockSchema,
    valuation: GradeBlockSchema,
    technicals: GradeBlockSchema,
    quality: GradeBlockSchema,
    leadership: GradeBlockSchema,
    moat: GradeBlockSchema,
    /**
     * Balance sheet & capital as a first-class graded aspect (the application contract §7.4 is a
     * section but was ungraded in 1.0.0). Optional so 1.0.0 reports still parse;
     * the judge fills it on 1.1.0+.
     */
    balanceSheet: GradeBlockSchema.optional(),
  })
  .strict();
export type GradeStrip = z.infer<typeof GradeStripSchema>;

export const VerdictSchema = z
  .object({
    /** 3–5 sentence synthesis; rating-safe (the application contract §7.1). */
    synthesis: ratingSafeString(),
    gradeStrip: GradeStripSchema,
    /**
     * Top-of-report analyst note (rating-safe SourcedClaims) that weaves the
     * composite grade, the weighted projections, and the bull/base/bear
     * scenarios into one plain-English thesis + "what would change the view".
     * Optional for backward-compat; the judge fills it on 1.1.0+.
     */
    executiveSummary: z.array(SourcedClaimSchema).optional(),
  })
  .strict();
export type Verdict = z.infer<typeof VerdictSchema>;

/* ------------------------------------------------------------------------ *
 * §7.2 business & segments
 * ------------------------------------------------------------------------ */

export const SegmentRowSchema = z
  .object({
    name: z.string(),
    revenue: TracedNumberSchema,
    sharePct: z.number().nullable(),
  })
  .strict();
export type SegmentRow = z.infer<typeof SegmentRowSchema>;

export const BusinessSchema = z
  .object({
    whatTheySell: z.array(SourcedClaimSchema),
    segments: z
      .object({
        product: z.array(SegmentRowSchema),
        geographic: z.array(SegmentRowSchema),
      })
      .strict(),
    concentrationRisks: z.array(SourcedClaimSchema),
  })
  .strict();
export type Business = z.infer<typeof BusinessSchema>;

/* ------------------------------------------------------------------------ *
 * §7.3 fundamentals
 * ------------------------------------------------------------------------ */

/** A labelled row of period → traced value (growth/margin/returns/fcf). */
export const MetricRowSchema = z
  .object({
    label: z.string(),
    /** period label (e.g. "FY2025", "5yr CAGR") -> traced value */
    values: z.array(
      z
        .object({ period: z.string(), value: TracedNumberSchema })
        .strict(),
    ),
  })
  .strict();
export type MetricRow = z.infer<typeof MetricRowSchema>;

export const FundamentalsSchema = z
  .object({
    graded: GradeBlockSchema,
    growthTable: z.array(MetricRowSchema),
    marginTrend: z.array(MetricRowSchema),
    returns: z.array(MetricRowSchema),
    fcf: z.array(MetricRowSchema),
    commentary: z.array(SourcedClaimSchema),
  })
  .strict();
export type Fundamentals = z.infer<typeof FundamentalsSchema>;

/* ------------------------------------------------------------------------ *
 * §7.4 balance sheet & capital
 * ------------------------------------------------------------------------ */

export const BalanceSheetSchema = z
  .object({
    /**
     * Balance-sheet & capital grade (the application contract §7.4). Optional for backward-compat
     * with 1.0.0 reports; the judge fills it on 1.1.0+, anchored to the
     * deterministic `scores.aspects.balanceSheet` band.
     */
    graded: GradeBlockSchema.optional(),
    debtProfile: z
      .object({
        commentary: z.array(SourcedClaimSchema),
        numbers: z.array(TracedNumberSchema),
      })
      .strict(),
    coverage: z
      .object({
        commentary: z.array(SourcedClaimSchema),
        numbers: z.array(TracedNumberSchema),
      })
      .strict(),
    capexTrajectory: z
      .object({
        commentary: z.array(SourcedClaimSchema),
        numbers: z.array(TracedNumberSchema),
      })
      .strict(),
    capitalAllocation: z.array(SourcedClaimSchema),
  })
  .strict();
export type BalanceSheet = z.infer<typeof BalanceSheetSchema>;

/* ------------------------------------------------------------------------ *
 * §7.5 valuation
 * ------------------------------------------------------------------------ */

export const DcfAssumptionSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    basis: z.string(),
  })
  .strict();
export type DcfAssumption = z.infer<typeof DcfAssumptionSchema>;

/** One cell of the WACC × terminal-growth sensitivity grid. */
export const SensitivityCellSchema = z
  .object({
    waccPct: z.number(),
    gTermPct: z.number(),
    perShare: z.number().nullable(),
  })
  .strict();
export type SensitivityCell = z.infer<typeof SensitivityCellSchema>;

export const DcfSchema = z
  .object({
    /**
     * Intrinsic value per share. NULLABLE (2026-07-11 DCF-credibility checkpoint):
     * the pipeline OVERWRITES this at assembly with the deterministic route-
     * appropriate fair value ({@link FairValueSchema}: FCFF DCF on the general
     * route, the book-value excess-return model for banks/insurers), or sets it
     * null when no per-share model applies / inputs are insufficient. The judge no
     * longer authors it. null = "unavailable", not zero. Persisted pre-checkpoint
     * reports (with a number) still parse (widening).
     */
    perShare: TracedNumberSchema.nullable(),
    assumptions: z.array(DcfAssumptionSchema),
    /** Flat list of cells (5×5 grid flattened; the application contract §4 sensitivity). */
    sensitivityGrid: z.array(SensitivityCellSchema),
    upsidePct: z.number().nullable(),
  })
  .strict();
export type Dcf = z.infer<typeof DcfSchema>;

export const ReverseDcfSchema = z
  .object({
    impliedMetric: z.string(),
    impliedValue: z.number().nullable(),
    narrative: ratingSafeString(),
  })
  .strict();
export type ReverseDcf = z.infer<typeof ReverseDcfSchema>;

export const MultipleRowSchema = z
  .object({
    name: z.string(),
    current: z.number().nullable(),
    peerMedian: z.number().nullable(),
    own5yPercentile: z.number().nullable(),
    sectorAppropriate: z.boolean(),
  })
  .strict();
export type MultipleRow = z.infer<typeof MultipleRowSchema>;

export const ScenarioSchema = z
  .object({
    name: z.enum(["bull", "base", "bear"]),
    /** Null only when no scenario analysis ran (data-only degraded report). */
    probability: z.number().min(0).max(1).nullable(),
    /**
     * Headline scenario price target. NULLABLE (2026-07-11 scenario-credibility
     * checkpoint): the pipeline OVERWRITES this at assembly with the deterministic
     * computed target ({@link ScenarioTargetsSchema}), or sets it null when the
     * DCF route / inputs are insufficient. The judge no longer authors it — a
     * null here means "scenario target unavailable", not "zero". Persisted 1.x
     * reports with a number still parse (widening).
     */
    priceTarget: TracedNumberSchema.nullable(),
    horizon: z.string(),
    assumptions: z.array(ratingSafeString()),
    whatWouldHaveToBeTrue: z.array(ratingSafeString()),
  })
  .strict();
export type Scenario = z.infer<typeof ScenarioSchema>;

/** Numeric probabilities sum to ~1; a data-only report uses three nulls. */
const SCENARIO_PROB_TOLERANCE = 0.01;
function scenariosProbabilitySumsToOne(
  scenarios: { probability: number | null }[],
): boolean {
  if (scenarios.every((scenario) => scenario.probability === null)) return true;
  if (scenarios.some((scenario) => scenario.probability === null)) return false;
  const sum = scenarios.reduce((acc, scenario) => acc + (scenario.probability ?? 0), 0);
  return Math.abs(sum - 1) <= SCENARIO_PROB_TOLERANCE;
}

export const ScenariosSchema = z
  .array(ScenarioSchema)
  .length(3)
  .refine(scenariosProbabilitySumsToOne, {
    message:
      "scenario probabilities must all be null for data-only output or sum to 1 (±0.01)",
  });
export type Scenarios = z.infer<typeof ScenariosSchema>;

export const ValuationSchema = z
  .object({
    graded: GradeBlockSchema,
    dcf: DcfSchema,
    reverseDcf: ReverseDcfSchema,
    multiples: z.array(MultipleRowSchema),
    scenarios: ScenariosSchema,
  })
  .strict();
export type Valuation = z.infer<typeof ValuationSchema>;

/* ------------------------------------------------------------------------ *
 * §7.6 quality & red flags
 * ------------------------------------------------------------------------ */

/**
 * Shared shape for all four forensic-score variants (Altman/Beneish/
 * Piotroski/accruals) — structurally identical, so they're ONE Zod schema
 * instance aliased under each name rather than four separate object literals.
 * This matters beyond DRY: `toStructuredJsonSchema`'s `reused:"ref"` dedupes
 * by schema-object IDENTITY, not structural equality — four distinct literals
 * with the same shape would emit four separate $defs entries (8 nullable
 * fields total) instead of one shared entry (2), needlessly inflating both of
 * Anthropic's schema-complexity counters (optional-parameter count and
 * union-type count) for no semantic benefit. Confirmed live 2026-07-08: this
 * duplication was part of what pushed JUDGE_OUTPUT_SCHEMA's optional-parameter
 * count to 29 against a documented limit of 24.
 */
export const ForensicScoreSchema = z
  .object({
    variant: z.string(),
    score: z.number().nullable(),
    zone: z.string().nullable(),
    notApplicableReason: z.string().optional(),
  })
  .strict();

export const AltmanScoreSchema = ForensicScoreSchema;
export const BeneishScoreSchema = ForensicScoreSchema;
export const PiotroskiScoreSchema = ForensicScoreSchema;
export const AccrualsScoreSchema = ForensicScoreSchema;

export const ForensicScoresSchema = z
  .object({
    altman: AltmanScoreSchema,
    beneish: BeneishScoreSchema,
    piotroski: PiotroskiScoreSchema,
    accruals: AccrualsScoreSchema,
  })
  .strict();
export type ForensicScores = z.infer<typeof ForensicScoresSchema>;

export const QualityFlagSchema = z
  .object({
    severity: SeverityLowMedHighSchema,
    text: ratingSafeString(),
    source: z.string(),
  })
  .strict();
export type QualityFlag = z.infer<typeof QualityFlagSchema>;

export const QualitySchema = z
  .object({
    graded: GradeBlockSchema,
    forensicScores: ForensicScoresSchema,
    flags: z.array(QualityFlagSchema),
  })
  .strict();
export type Quality = z.infer<typeof QualitySchema>;

/* ------------------------------------------------------------------------ *
 * §7.7 technicals
 * ------------------------------------------------------------------------ */

export const TechnicalReadSchema = z
  .object({
    trend: ratingSafeString(),
    momentum: ratingSafeString(),
    keyLevels: ratingSafeString(),
    relativeStrength: ratingSafeString(),
  })
  .strict();
export type TechnicalRead = z.infer<typeof TechnicalReadSchema>;

export const TechnicalsSchema = z
  .object({
    graded: GradeBlockSchema,
    read: TechnicalReadSchema,
    indicators: z.array(TracedNumberSchema),
    flags: z.array(QualityFlagSchema),
  })
  .strict();
export type Technicals = z.infer<typeof TechnicalsSchema>;

/* ------------------------------------------------------------------------ *
 * §7.8 leadership & governance
 * ------------------------------------------------------------------------ */

export const ExecutiveEvidenceSchema = z
  .object({
    guidanceVsActuals: z.array(SourcedClaimSchema).optional(),
    capitalAllocation: z.array(SourcedClaimSchema).optional(),
    insiderActivity: z.array(SourcedClaimSchema).optional(),
    compensation: z.array(SourcedClaimSchema).optional(),
  })
  .strict();
export type ExecutiveEvidence = z.infer<typeof ExecutiveEvidenceSchema>;

export const ExecutiveSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    tenureYears: z.number().nullable(),
    grade: GradeSchema,
    credibilityGrade: GradeSchema,
    reasoning: z.array(SourcedClaimSchema),
    evidence: ExecutiveEvidenceSchema,
  })
  .strict();
export type Executive = z.infer<typeof ExecutiveSchema>;

export const LeadershipSchema = z
  .object({
    graded: GradeBlockSchema,
    executives: z.array(ExecutiveSchema),
    insiderSummary: z.array(SourcedClaimSchema),
    governanceNotes: z.array(SourcedClaimSchema),
  })
  .strict();
export type Leadership = z.infer<typeof LeadershipSchema>;

/* ------------------------------------------------------------------------ *
 * §7.9 competitive landscape
 * ------------------------------------------------------------------------ */

export const PeerRowSchema = z
  .object({
    name: z.string(),
    symbol: z.string().nullable(),
    metrics: z.array(TracedNumberSchema),
  })
  .strict();
export type PeerRow = z.infer<typeof PeerRowSchema>;

export const MoatSourceSchema = z.enum([
  "switchingCosts",
  "networkEffects",
  "scale",
  "brand",
  "ip",
]);

export const MoatAssessmentSchema = z
  .object({
    source: MoatSourceSchema,
    strength: z.enum(["none", "narrow", "wide"]),
    reasoning: z.array(SourcedClaimSchema),
  })
  .strict();
export type MoatAssessment = z.infer<typeof MoatAssessmentSchema>;

export const CompetitiveSchema = z
  .object({
    moatGraded: GradeBlockSchema,
    peerTable: z.array(PeerRowSchema),
    moatAssessment: z.array(MoatAssessmentSchema),
    marketShareDirection: ratingSafeString(),
  })
  .strict();
export type Competitive = z.infer<typeof CompetitiveSchema>;

/* ------------------------------------------------------------------------ *
 * §7.10 catalysts & risks
 * ------------------------------------------------------------------------ */

export const CatalystSchema = z
  .object({
    title: z.string(),
    expectedDate: z.string().nullable(),
    direction: z.enum(["positive", "negative", "mixed"]),
    significance: SignificanceSchema,
    reasoning: SourcedClaimSchema,
  })
  .strict();
export type Catalyst = z.infer<typeof CatalystSchema>;

export const RiskSchema = z
  .object({
    title: z.string(),
    severity: SeverityLowMedHighSchema,
    probability: SeverityLowMedHighSchema,
    source: z.string(),
    reasoning: SourcedClaimSchema,
  })
  .strict();
export type Risk = z.infer<typeof RiskSchema>;

export const CatalystsRisksSchema = z
  .object({
    catalysts: z.array(CatalystSchema),
    risks: z.array(RiskSchema),
  })
  .strict();
export type CatalystsRisks = z.infer<typeof CatalystsRisksSchema>;

/* ------------------------------------------------------------------------ *
 * §7.11 future outlook
 * ------------------------------------------------------------------------ */

export const ScenarioNarrativesSchema = z
  .object({
    y1: z.array(SourcedClaimSchema),
    y3: z.array(SourcedClaimSchema),
    y5: z.array(SourcedClaimSchema),
  })
  .strict();
export type ScenarioNarratives = z.infer<typeof ScenarioNarrativesSchema>;

export const OutlookSchema = z
  .object({
    segmentTrajectories: z.array(SourcedClaimSchema),
    tam: z.array(SourcedClaimSchema).optional(),
    estimateRevisionTrend: z.array(SourcedClaimSchema),
    guidanceCredibility: z.array(SourcedClaimSchema),
    scenarioNarratives: ScenarioNarrativesSchema,
  })
  .strict();
export type Outlook = z.infer<typeof OutlookSchema>;

/* ------------------------------------------------------------------------ *
 * §7.12 macro context
 * ------------------------------------------------------------------------ */

export const FRED_ATTRIBUTION_TEXT =
  "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis." as const;

export const MacroSeriesRowSchema = z
  .object({
    seriesId: z.string(),
    name: z.string(),
    latest: TracedNumberSchema,
    relevance: ratingSafeString(),
  })
  .strict();
export type MacroSeriesRow = z.infer<typeof MacroSeriesRowSchema>;

export const MacroSchema = z
  .object({
    relevantSeries: z.array(MacroSeriesRowSchema),
    sensitivityNotes: z.array(SourcedClaimSchema),
    /**
     * FRED attribution: stored verbatim from the constant in force at generation
     * time. Parse-side accepts ANY non-empty string so a future edit to
     * FRED_ATTRIBUTION_TEXT never bricks historical reports (same degrade-to-null
     * read path as meta.disclaimer). Generation still embeds the CURRENT
     * FRED_ATTRIBUTION_TEXT (pinned by generation-side tests).
     */
    fredAttribution: z.string().min(1),
  })
  .strict();
export type Macro = z.infer<typeof MacroSchema>;

/* ------------------------------------------------------------------------ *
 * §7.13 appendix
 * ------------------------------------------------------------------------ */

export const SourceEntrySchema = z
  .object({
    provider: z.string(),
    endpoint: z.string(),
    asOf: z.string(),
    fetchedAt: z.string(),
  })
  .strict();
export type SourceEntry = z.infer<typeof SourceEntrySchema>;

/** ManifestEntry-shaped (mirrors src/types/core.ts ManifestEntry). */
export const ManifestEntrySchema = z
  .object({
    field: z.string(),
    reason: z.string(),
    severity: z.enum(["info", "warn", "critical"]),
    attemptedSources: z.array(z.string()).optional(),
    /** Known structural gap (issuer doesn't report this) — counted separately. */
    expected: z.boolean().optional(),
  })
  .strict();
type _ManifestMatches = z.infer<typeof ManifestEntrySchema> extends ManifestEntry
  ? true
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _manifestMatches: _ManifestMatches = true;

export const VerificationLogEntrySchema = z
  .object({
    claim: z.string(),
    outcome: z.enum(["verified", "unverified", "removed"]),
    note: z.string().optional(),
    /** Exact report path and evidence identity for 1.2.0+ logs. */
    path: z.string().optional(),
    evidenceKind: z.enum(["number", "factual-claim", "judgment"]).optional(),
    source: z.string().optional(),
    reason: z
      .enum([
        "supported",
        "unknown-source",
        "value-mismatch",
        "unit-mismatch",
        "currency-mismatch",
        "period-mismatch",
        "date-mismatch",
      ])
      .optional(),
    /**
     * How the number traced — separates the CITATION-COVERAGE modes the audit
     * asks to keep distinct (2026-07-11 finding #2). Optional for backward-compat
     * with reports written before this field existed:
     *  - "payload-match": exact provider registry ID plus numeric dimensions.
     *  - "source-cited": exact payload text source/date or observed fetched URL.
     *  - "computed-derived": exact computed registry ID plus numeric dimensions
     *    and a versioned formula identity — traceability, not independent audit.
     *  - "untraced": neither — flagged, never counted as traced.
     * NONE of these is factual verification; the value is not re-derived or
     * re-fetched (see runVerifyPass docstring).
     */
    traceKind: z
      .enum(["payload-match", "source-cited", "computed-derived", "untraced"])
      .optional(),
  })
  .strict();
export type VerificationLogEntry = z.infer<typeof VerificationLogEntrySchema>;

/** Short human label for a {@link VerificationLogEntry.traceKind}. */
export function traceKindLabel(
  kind: NonNullable<VerificationLogEntry["traceKind"]>,
): string {
  switch (kind) {
    case "payload-match":
      return "payload value match";
    case "source-cited":
      return "source cited";
    case "computed-derived":
      return "computed";
    case "untraced":
      return "untraced";
  }
}

/**
 * Human-facing label for a log outcome. The stored enum values ("verified" /
 * "unverified") are RETAINED for backward-compatibility with persisted reports,
 * but they describe CITATION-COVERAGE (was the number traced to a citation or a
 * payload value), NOT correctness. The display wording says so.
 */
export function citationOutcomeLabel(
  outcome: VerificationLogEntry["outcome"],
): string {
  switch (outcome) {
    case "verified":
      return "cited";
    case "unverified":
      return "uncited";
    case "removed":
      return "removed";
  }
}

export const CostBreakdownEntrySchema = z
  .object({
    step: z.string(),
    model: z.string(),
    costUsd: z.number(),
    requestedModel: z.string().optional(),
    requestedEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
    effectiveEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
    fallbackUsed: z.boolean().optional(),
    adjustments: z.array(z.enum(["model-floor", "fallback", "effort-stripped"])).optional(),
  })
  .strict();
export type CostBreakdownEntry = z.infer<typeof CostBreakdownEntrySchema>;

export const AppendixSchema = z
  .object({
    sources: z.array(SourceEntrySchema),
    missingData: z.array(ManifestEntrySchema),
    /** Citation coverage (provenance, not correctness) — see MetaSchema. */
    verificationRate: z.number().nullable(),
    provenanceCoverage: ProvenanceCoverageSchema.optional(),
    verificationLog: z.array(VerificationLogEntrySchema).optional(),
    costBreakdown: z.array(CostBreakdownEntrySchema),
  })
  .strict();
export type Appendix = z.infer<typeof AppendixSchema>;

/* ------------------------------------------------------------------------ *
 * Judge disagreements (the application contract §5)
 * ------------------------------------------------------------------------ */

export const DisagreementSchema = z
  .object({
    topic: z.string(),
    bullView: ratingSafeString(),
    bearView: ratingSafeString(),
    kind: z.enum(["fact", "interpretation", "entity"]),
    judgeResolution: ratingSafeString(),
  })
  .strict();
export type Disagreement = z.infer<typeof DisagreementSchema>;

/* ------------------------------------------------------------------------ *
 * §7.1b Deterministic aspect scoring (pipeline-filled, NOT LLM-authored)
 *
 * A 0–100 sub-score per aspect + a weighted composite, computed in Stage B
 * (src/pipeline/stageB/grading.ts) from the deterministic metrics and mapped
 * into the report by assembleReport. This is the reproducible numeric anchor
 * beneath the LLM's A–F letter grades: the judge is prompted to align each
 * letter to `scores.aspects[x].band` or justify a deviation.
 *
 * `drivers` are the sub-signals behind the score as TracedNumbers (source
 * "computed.scores.<aspect>.<signal>"), so they flow through the verify pass.
 * `dataCompleteness` (0–1) is the fraction of intended signal weight actually
 * available — an aspect scored on half its inputs is disclosed, not silently
 * defaulted (the application contract §1 rule #4).
 * ------------------------------------------------------------------------ */

export const ScoreAspectSchema = z.enum([
  "fundamentals",
  "valuation",
  "quality",
  "balanceSheet",
  "moat",
  "leadership",
  "technicals",
]);
export type ScoreAspect = z.infer<typeof ScoreAspectSchema>;

export const AspectScoreSchema = z
  .object({
    /** 0–100; null when the aspect is not applicable for the route. */
    score: z.number().min(0).max(100).nullable(),
    /** A–F mapped from `score` via documented bands; null when notApplicable. */
    band: GradeSchema.nullable(),
    /** This aspect's weight in the composite (percent). */
    weightPct: z.number(),
    /** Fraction (0–1) of intended signal weight actually available. */
    dataCompleteness: z.number().min(0).max(1),
    /** The sub-signals behind the score, as traced numbers. */
    drivers: z.array(TracedNumberSchema),
    /** Non-null when the aspect cannot be scored for this route/data. */
    notApplicableReason: z.string().nullable(),
    /** One-line methodology / caveat (rating-safe). */
    note: ratingSafeString(),
  })
  .strict();
export type AspectScore = z.infer<typeof AspectScoreSchema>;

export const CompositeScoreSchema = z
  .object({
    score: z.number().min(0).max(100).nullable(),
    band: GradeSchema.nullable(),
    /** The weight vector actually used (route-adjusted), for audit. */
    weights: z
      .object({
        fundamentals: z.number(),
        valuation: z.number(),
        quality: z.number(),
        balanceSheet: z.number(),
        moat: z.number(),
        leadership: z.number(),
        technicals: z.number(),
      })
      .strict(),
    methodology: ratingSafeString(),
  })
  .strict();
export type CompositeScore = z.infer<typeof CompositeScoreSchema>;

export const ScoringSchema = z
  .object({
    aspects: z
      .object({
        fundamentals: AspectScoreSchema,
        valuation: AspectScoreSchema,
        quality: AspectScoreSchema,
        balanceSheet: AspectScoreSchema,
        moat: AspectScoreSchema,
        leadership: AspectScoreSchema,
        technicals: AspectScoreSchema,
      })
      .strict(),
    composite: CompositeScoreSchema,
    /** Versioned band table id (e.g. "SCORE_BANDS_2026_01"). */
    bandsVersion: z.string(),
  })
  .strict();
export type Scoring = z.infer<typeof ScoringSchema>;

/* ------------------------------------------------------------------------ *
 * §7.11b Weighted projections (pipeline-filled, NOT LLM-authored)
 *
 * Forward financial model computed in Stage B (src/pipeline/stageB/
 * projections.ts) by reusing the DCF's own DcfAssumptions + forward path, then
 * perturbing growth/margin for bull/bear and probability-weighting to an
 * expected path. Every forward number is an ESTIMATE TracedNumber sourced
 * "computed.projections.<metric>.<scenario>" so it traces through the verify
 * pass. The LLM interprets these numbers (outlook / interpretation); it never
 * invents them.
 * ------------------------------------------------------------------------ */

export const ProjectionMetricSchema = z.enum([
  "revenue",
  "operatingMargin",
  "fcf",
  "epsDiluted",
]);
export type ProjectionMetric = z.infer<typeof ProjectionMetricSchema>;

export const ProjectionPointSchema = z
  .object({ period: z.string(), value: TracedNumberSchema })
  .strict();
export type ProjectionPoint = z.infer<typeof ProjectionPointSchema>;

export const ProjectionSeriesSchema = z
  .object({
    metric: ProjectionMetricSchema,
    unit: z.string(),
    /** Historical actuals feeding the left half of the fan. */
    historical: z.array(ProjectionPointSchema),
    bull: z.array(ProjectionPointSchema),
    base: z.array(ProjectionPointSchema),
    bear: z.array(ProjectionPointSchema),
    /** Probability-weighted expected path (the headline projection). */
    weighted: z.array(ProjectionPointSchema),
    /** Human-readable basis lines (from DcfAssumptions.notes + dispersion). */
    assumptions: z.array(ratingSafeString()),
    disclosures: z.array(ManifestEntrySchema),
  })
  .strict();
export type ProjectionSeries = z.infer<typeof ProjectionSeriesSchema>;

export const ProjectionsSchema = z
  .object({
    horizonYears: z.number(),
    scenarioWeights: z
      .object({ bull: z.number(), base: z.number(), bear: z.number() })
      .strict(),
    /** Versioned scenario-weight prior id (e.g. "PROJECTION_WEIGHTS_2026_01"). */
    weightsVersion: z.string(),
    series: z.array(ProjectionSeriesSchema),
    /** Non-null when projections are suppressed for the route / thin data. */
    notApplicableReason: z.string().nullable(),
  })
  .strict();
export type Projections = z.infer<typeof ProjectionsSchema>;

/* ------------------------------------------------------------------------ *
 * §7.5b deterministic scenario price targets (Stage B; computed-derived)
 *
 * The headline bull/base/bear price targets are COMPUTED, not judge-authored
 * (2026-07-11 scenario-credibility checkpoint). base IS the deterministic DCF
 * fair value; bull/bear re-run the SAME DCF with the growth + operating-margin
 * paths shifted ±1σ of the company's OWN historical dispersion — the identical
 * construction as the projection fan (scenarioTargets.ts reuses projections.ts's
 * scenarioDispersion + perturbScenarioAssumptions). Each target is
 * `computed-derived` PROVENANCE (source "computed.scenarioTargets.<scenario>"),
 * NOT a factual-correctness claim. When the DCF route or inputs are insufficient
 * the whole block is `status:"suppressed"` with empty targets + missingReasons —
 * never a fabricated number. Optional on the report for backward-compat; every
 * 1.1.0+ report on the general DCF route carries it.
 * ------------------------------------------------------------------------ */

export const ScenarioTargetSchema = z
  .object({
    name: z.enum(["bull", "base", "bear"]),
    /** Per-share intrinsic value for this scenario; null when not computable. */
    perShare: TracedNumberSchema.nullable(),
    /** (perShare / current price − 1)·100; null when price or perShare missing. */
    upsidePct: z.number().nullable(),
    /** Growth-path shift vs base, percentage points (0 for base). */
    growthDeltaPp: z.number(),
    /** Operating-margin-path shift vs base, percentage points (0 for base). */
    marginDeltaPp: z.number(),
  })
  .strict();
export type ScenarioTarget = z.infer<typeof ScenarioTargetSchema>;

export const ScenarioTargetsSchema = z
  .object({
    status: z.enum(["available", "suppressed"]),
    /** Method id — currently "dcf-dispersion". */
    method: z.string(),
    /** Versioned method prior (e.g. "SCENARIO_TARGETS_2026_07"). */
    methodVersion: z.string(),
    /** Human formula/dependency + assumption-delta disclosure lines. */
    basis: z.array(z.string()),
    /** The ±σ band actually used; null when suppressed. */
    dispersion: z
      .object({
        growthSigmaPp: z.number(),
        marginSigmaPp: z.number(),
        /** "own-history" = measured; "house-default" = heuristic fallback (thin history). */
        sigmaSource: z.enum(["own-history", "house-default"]),
        /** Empirical growth/margin correlation used to scale the joint shock. */
        growthMarginCorrelation: z.number().min(-1).max(1).nullable().optional(),
      })
      .strict()
      .nullable(),
    /** bull/base/bear targets; empty when suppressed. */
    targets: z.array(ScenarioTargetSchema),
    /** Why suppressed / partially unavailable (ManifestEntry gaps). */
    missingReasons: z.array(ManifestEntrySchema),
  })
  .strict();
export type ScenarioTargets = z.infer<typeof ScenarioTargetsSchema>;

/* ------------------------------------------------------------------------ *
 * §7.5c deterministic intrinsic per-share fair value (Stage B; computed-derived)
 *
 * The headline DCF fair value (valuation.dcf.perShare + upsidePct) is COMPUTED,
 * not judge-authored (2026-07-11 DCF-credibility checkpoint). The route-
 * appropriate deterministic per-share — the FCFF DCF on the general route, the
 * book-value excess-return model for banks/insurers — is injected into
 * valuation.dcf at assembly (assembleReport.applyFairValue), or nulled when no
 * per-share model applies (REIT / pre-revenue / dcf-suppressed) or inputs are
 * insufficient. `computed-derived` PROVENANCE (source "computed.valuation.*"),
 * NOT a factual-correctness claim. Optional for backward-compat.
 * ------------------------------------------------------------------------ */

export const FairValueSchema = z
  .object({
    status: z.enum(["available", "suppressed"]),
    /** "fcff-dcf" (general route) | "excess-return" (banks/insurers) | null when suppressed. */
    method: z.enum(["fcff-dcf", "excess-return"]).nullable(),
    /** Versioned method prior (e.g. "FAIR_VALUE_2026_07"). */
    methodVersion: z.string(),
    /** The deterministic intrinsic per-share (mirrors valuation.dcf.perShare); null when suppressed. */
    perShare: TracedNumberSchema.nullable(),
    /** (perShare / current price − 1)·100; null when price or perShare missing. */
    upsidePct: z.number().nullable(),
    /** Human formula/method disclosure lines. */
    basis: z.array(z.string()),
    /** Why suppressed (ManifestEntry gaps). */
    reasons: z.array(ManifestEntrySchema),
  })
  .strict();
export type FairValue = z.infer<typeof FairValueSchema>;

/* ------------------------------------------------------------------------ *
 * The judge output — everything the judge/synthesis pass must emit.
 *
 * This is the full report MINUS `meta` and `appendix`, which the pipeline
 * fills (the application contract §5). The judge emits section content + disagreements; the job
 * runner wraps it with meta (symbol/model/cost/asOfMap) and appendix (sources
 * /manifest/verification log/cost breakdown). `.strict()` so any extra key the
 * model invents fails validation.
 * ------------------------------------------------------------------------ */

const JudgeOutputObjectSchema = z
  .object({
    verdict: VerdictSchema,
    business: BusinessSchema,
    fundamentals: FundamentalsSchema,
    balanceSheet: BalanceSheetSchema,
    valuation: ValuationSchema,
    quality: QualitySchema,
    technicals: TechnicalsSchema,
    leadership: LeadershipSchema,
    competitive: CompetitiveSchema,
    catalystsRisks: CatalystsRisksSchema,
    outlook: OutlookSchema,
    macro: MacroSchema,
    disagreements: z.array(DisagreementSchema),
  })
  .strict();
export const JUDGE_OUTPUT_SCHEMA = JudgeOutputObjectSchema.superRefine((value, ctx) => {
  enforceRecursiveRatingSafety(value, ctx);
  value.valuation.scenarios.forEach((scenario, index) => {
    if (scenario.probability === null) {
      ctx.addIssue({
        code: "custom",
        path: ["valuation", "scenarios", index, "probability"],
        message: "judge scenario probability is required; null is reserved for data-only reports",
      });
    }
  });
});
export type JudgeOutput = z.infer<typeof JUDGE_OUTPUT_SCHEMA>;

/* ------------------------------------------------------------------------ *
 * The root Report — judge output + meta + appendix
 * ------------------------------------------------------------------------ */

const ReportObjectSchema = z
  .object({
    meta: MetaSchema,
    verdict: VerdictSchema,
    business: BusinessSchema,
    fundamentals: FundamentalsSchema,
    balanceSheet: BalanceSheetSchema,
    valuation: ValuationSchema,
    quality: QualitySchema,
    technicals: TechnicalsSchema,
    leadership: LeadershipSchema,
    competitive: CompetitiveSchema,
    catalystsRisks: CatalystsRisksSchema,
    outlook: OutlookSchema,
    macro: MacroSchema,
    appendix: AppendixSchema,
    disagreements: z.array(DisagreementSchema),
    /**
     * Deterministic aspect scores + weighted composite (pipeline-filled by
     * assembleReport from Stage B). Optional so persisted 1.0.0 reports still
     * parse; every 1.1.0+ report carries it.
     */
    scores: ScoringSchema.optional(),
    /**
     * Weighted forward projections (pipeline-filled by assembleReport from
     * Stage B). Optional for the same backward-compat reason.
     */
    projections: ProjectionsSchema.optional(),
    /**
     * Deterministic bull/base/bear price targets + their trace/suppression state
     * (pipeline-filled by assembleReport from Stage B; 2026-07-11 scenario-
     * credibility checkpoint). Optional so persisted pre-checkpoint reports parse.
     * When present and available, assembleReport also overwrites
     * valuation.scenarios[].priceTarget from it so the two never diverge.
     */
    scenarioTargets: ScenarioTargetsSchema.optional(),
    /**
     * Deterministic intrinsic per-share fair value + its trace/suppression state
     * (pipeline-filled by assembleReport from Stage B; 2026-07-11 DCF-credibility
     * checkpoint). Optional so persisted pre-checkpoint reports parse. When present
     * and available, assembleReport also overwrites valuation.dcf.perShare +
     * upsidePct from it so the two never diverge.
     */
    fairValue: FairValueSchema.optional(),
  })
  .strict();
export const ReportSchema = ReportObjectSchema.superRefine(
  enforceRecursiveRatingSafety,
);
export type Report = z.infer<typeof ReportSchema>;

/* ------------------------------------------------------------------------ *
 * Analyst-case schema — bull & bear passes (the application contract §5 passes 1–2)
 * ------------------------------------------------------------------------ */

export const AnalystPriceTargetSchema = z
  .object({
    value: z.number(),
    horizon: z.string(),
    assumptions: z.array(ratingSafeString()),
  })
  .strict();
export type AnalystPriceTarget = z.infer<typeof AnalystPriceTargetSchema>;

/**
 * One side of the case (bull or bear). Both passes emit this shape; the judge
 * receives both plus the payload. `.strict()` so extra keys fail.
 */
const AnalystCaseObjectSchema = z
  .object({
    thesis: z.array(SourcedClaimSchema),
    keyDrivers: z.array(SourcedClaimSchema),
    risksToCase: z.array(SourcedClaimSchema),
    catalysts: z.array(SourcedClaimSchema),
    priceTarget: AnalystPriceTargetSchema,
    evidence: z.array(TracedNumberSchema),
  })
  .strict();
export const ANALYST_CASE_SCHEMA = AnalystCaseObjectSchema.superRefine(
  enforceRecursiveRatingSafety,
);
export type AnalystCase = z.infer<typeof ANALYST_CASE_SCHEMA>;

/* ------------------------------------------------------------------------ *
 * JSON Schema emission for Anthropic structured outputs
 * ------------------------------------------------------------------------ */

/**
 * Recursively force `additionalProperties: false` on every JSON-schema object
 * node that declares `properties`, so Anthropic structured outputs treats the
 * schema as closed (extra keys rejected — the application contract §2, matching our `.strict()`
 * Zod schemas).
 *
 * z.toJSONSchema already emits `additionalProperties: false` for `.strict()`
 * (and even plain) object schemas in Zod v4, so this is a defensive pass — it
 * guarantees the invariant regardless of future Zod default changes and covers
 * any node produced without it.
 *
 * `z.record(...)` fields (e.g. meta.asOfMap) are intentionally LEFT as open
 * maps: their JSON-schema form is `{type:"object", propertyNames, additional
 * Properties: <valueSchema>}` with NO `properties` key. Those are legitimately
 * open-ended string→string maps, so we only close nodes that have an explicit
 * `properties` object. This is documented behavior — a record is the ONE place
 * a report object is not `additionalProperties:false`.
 */
export function closeAdditionalProperties<T>(schema: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    // Only close object-schema nodes that enumerate their properties. Record
    // nodes carry `additionalProperties` as a schema (not a boolean) and have
    // no `properties` key — leave those untouched.
    if (
      obj.type === "object" &&
      obj.properties !== undefined &&
      typeof obj.properties === "object"
    ) {
      obj.additionalProperties = false;
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  };
  walk(schema);
  return schema;
}

/**
 * Anthropic's `output_config.format.schema` (structured outputs) supports only
 * a SUBSET of JSON Schema (the Anthropic API contract §3, verified live). Two
 * violations have already 400'd real requests before the model ever ran:
 *
 *  - array `minItems` other than 0 or 1 ("other array constraints" — i.e.
 *    `maxItems` too — are unsupported outright regardless of value). Observed
 *    2026-07-07: `.length(3)` on {@link ScenariosSchema} (bull/base/bear)
 *    emits `minItems:3,maxItems:3` → "For 'array' type, 'minItems' values
 *    other than 0 or 1 are not supported".
 *  - numeric `minimum`/`maximum`/`multipleOf`. Observed 2026-07-08 (AFTER the
 *    array fix above unmasked it — Anthropic reports one violation class per
 *    request, so fixing the first surfaces the next): `probability:
 *    z.number().min(0).max(1)` on the same ScenarioSchema → "For 'number'
 *    type, properties maximum, minimum are not supported".
 *
 * The full disallowed list per the docs also includes string `minLength`/
 * `maxLength` — stripped here too, defensively, even though nothing in this
 * module currently emits them, so a future field addition doesn't reopen this
 * exact bug class one live 400 at a time.
 *
 * Strips all of the above from the REQUEST schema only — the original Zod
 * schema still enforces every bound when the response is parsed
 * (`.safeParse()`); a model that violates a stripped constraint is caught
 * there and fed back through the existing judge retry loop
 * (MAX_JUDGE_RETRIES) rather than the request never reaching the model at all.
 *
 * A stripped constraint is NOT silently lost, though: it's appended to the
 * node's `description` in plain English before deletion (creating the field
 * if absent), mirroring what Anthropic's own SDK helper does for this exact
 * situation ("The SDK auto-transforms unsupported constraints... strips them
 * from the wire schema, appends them to descriptions, and validates
 * client-side against the original" — the Anthropic API contract line ~156).
 * This codebase hand-builds the request schema instead of using that helper
 * (`zodOutputFormat`/`client.messages.parse()`), so this function is the
 * substitute: without it, e.g. `probability: z.number().min(0).max(1)` would
 * reach the model as a bare, unconstrained number with no indication anywhere
 * in the schema that it must be within [0,1].
 */
function describeStrippedBound(obj: Record<string, unknown>): string | null {
  if (obj.type === "array") {
    const min = typeof obj.minItems === "number" && obj.minItems > 1 ? obj.minItems : undefined;
    const max = typeof obj.maxItems === "number" ? obj.maxItems : undefined;
    if (min === undefined && max === undefined) return null;
    if (min !== undefined && min === max) return `must contain exactly ${min} items`;
    if (min !== undefined && max !== undefined) return `must contain between ${min} and ${max} items`;
    if (min !== undefined) return `must contain at least ${min} items`;
    return `must contain at most ${max} items`;
  }
  if (obj.type === "number" || obj.type === "integer") {
    const parts: string[] = [];
    if (typeof obj.minimum === "number") parts.push(`>= ${obj.minimum}`);
    if (typeof obj.maximum === "number") parts.push(`<= ${obj.maximum}`);
    if (typeof obj.multipleOf === "number") parts.push(`a multiple of ${obj.multipleOf}`);
    return parts.length > 0 ? `value must be ${parts.join(" and ")}` : null;
  }
  if (obj.type === "string") {
    const min = typeof obj.minLength === "number" ? obj.minLength : undefined;
    const max = typeof obj.maxLength === "number" ? obj.maxLength : undefined;
    if (min === undefined && max === undefined) return null;
    if (min !== undefined && max !== undefined) return `length must be between ${min} and ${max}`;
    if (min !== undefined) return `length must be at least ${min}`;
    return `length must be at most ${max}`;
  }
  return null;
}

export function relaxUnsupportedConstraints<T>(schema: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const note = describeStrippedBound(obj);
    if (note) {
      obj.description = typeof obj.description === "string" && obj.description.length > 0
        ? `${obj.description} (${note})`
        : note;
    }
    if (obj.type === "array") {
      if (typeof obj.minItems === "number" && obj.minItems > 1) delete obj.minItems;
      delete obj.maxItems;
    }
    if (obj.type === "number" || obj.type === "integer") {
      delete obj.minimum;
      delete obj.maximum;
      delete obj.multipleOf;
    }
    if (obj.type === "string") {
      delete obj.minLength;
      delete obj.maxLength;
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  };
  walk(schema);
  return schema;
}

/**
 * Anthropic additionally caps schema COMPLEXITY, separate from the supported-
 * keyword list above: "Schemas contains too many parameters with union types
 * (N parameters with type arrays or anyOf)... limit: 16 parameters with
 * unions" (400, observed live 2026-07-08 on JUDGE_OUTPUT_SCHEMA at 17 — every
 * `.nullable()` field in this codebase compiles to a 2-branch `anyOf:
 * [T, {type:"null"}]`, and JUDGE_OUTPUT_SCHEMA has 21 of them once `reused:
 * "ref"` (toStructuredJsonSchema) collapsed the duplicate-shape inlining that
 * used to inflate the count to 115). the Anthropic API contract §3 anticipated
 * exactly this: "mark as many fields required as possible and avoid nullable
 * unions."
 *
 * Collapses every such 2-branch `[T, null]` union down to plain `T` in the
 * REQUEST schema, and removes that property from its object's `required` list
 * (a model that has "no value" now omits the key instead of sending explicit
 * `null` — semantically equivalent, but expressed via JSON Schema's `required`
 * mechanism instead of a value union, which is what actually counts against
 * the complexity limit). This does NOT touch the underlying Zod schema, which
 * still types the field `T | null` — {@link fillNullableGaps} restores an
 * explicit `null` for any omitted-but-nullable key in the parsed response
 * before Zod validation runs, so parsing behaves identically to before this
 * function existed.
 */
function collapseNullableUnion(node: Record<string, unknown>): boolean {
  if (!Array.isArray(node.anyOf) || node.anyOf.length !== 2) return false;
  const branches = node.anyOf as unknown[];
  const isNullBranch = (b: unknown): boolean =>
    b !== null && typeof b === "object" && !Array.isArray(b) &&
    Object.keys(b as object).length === 1 && (b as Record<string, unknown>).type === "null";
  const [a, b] = branches;
  const nonNull = isNullBranch(a) ? b : isNullBranch(b) ? a : null;
  if (nonNull === null || !(isNullBranch(a) || isNullBranch(b))) return false;
  delete node.anyOf;
  for (const [key, value] of Object.entries(nonNull as Record<string, unknown>)) {
    if (!(key in node)) node[key] = value;
  }
  return true;
}

/**
 * Parse-time counterpart to {@link collapseNullableComplexity}: walks a Zod
 * schema alongside a raw (just-`JSON.parse`d) value and, for every field the
 * schema types as `.nullable()` (not `.optional()`) whose key is ABSENT from
 * the data, injects an explicit `null` before validation. Needed because the
 * REQUEST schema now lets the model omit a "no value" field entirely instead
 * of sending `null` — without this, `.safeParse()` would reject an omitted
 * nullable field (Zod's `.nullable()` accepts `T | null`, not `T | undefined`).
 * Non-destructive: returns a new value, never mutates the input.
 */
export function fillNullableGaps(schema: z.ZodType, data: unknown): unknown {
  const def = (schema as unknown as { def: { type: string; innerType?: z.ZodType; shape?: Record<string, z.ZodType>; element?: z.ZodType } }).def;
  switch (def.type) {
    case "nullable":
      return data === undefined ? null : fillNullableGaps(def.innerType as z.ZodType, data);
    case "optional":
      return data === undefined ? undefined : fillNullableGaps(def.innerType as z.ZodType, data);
    case "object": {
      if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
      const shape = def.shape as Record<string, z.ZodType>;
      const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
      for (const key of Object.keys(shape)) {
        out[key] = fillNullableGaps(shape[key], out[key]);
      }
      return out;
    }
    case "array": {
      if (!Array.isArray(data)) return data;
      return data.map((item) => fillNullableGaps(def.element as z.ZodType, item));
    }
    default:
      return data;
  }
}

export function collapseNullableComplexity<T>(schema: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
      const props = obj.properties as Record<string, unknown>;
      const required = Array.isArray(obj.required) ? (obj.required as string[]) : undefined;
      for (const key of Object.keys(props)) {
        const prop = props[key];
        if (prop === null || typeof prop !== "object") continue;
        const collapsed = collapseNullableUnion(prop as Record<string, unknown>);
        if (collapsed && required) {
          const idx = required.indexOf(key);
          if (idx !== -1) required.splice(idx, 1);
        }
      }
    }
    if (obj.type === "array" && obj.items && typeof obj.items === "object") {
      collapseNullableUnion(obj.items as Record<string, unknown>);
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  };
  walk(schema);
  return schema;
}

/**
 * Anthropic's "too many optional parameters" cap (400: "Schemas contains too
 * many optional parameters (N)... limit: 24", observed live 2026-07-08 at 26
 * even after {@link collapseNullableComplexity} and consolidating the four
 * forensic-score schemas into one shared $ref) is a SEPARATE complexity budget
 * from the union-type one. A few remaining optional fields are optional on the
 * shared Zod schema ONLY so `ReportSchema.safeParse()` can still parse older
 * PERSISTED reports that predate the field (spec 1.0.0 → 1.1.0) — a freshly
 * generated judge output always includes them (each field's own docstring
 * says so: "the judge is prompted to..." / "the judge fills it on 1.1.0+").
 * Forcing them into the REQUEST schema's `required` list costs nothing
 * semantically (the judge was always going to provide them) and buys back
 * complexity budget without touching `ReportSchema`'s parsing leniency for
 * historical data. Matched by property name, scoped to names that are
 * unambiguous among the currently-OPTIONAL set (verified — see the call site).
 *
 * Also includes `ExecutiveEvidenceSchema`'s four array fields and `outlook.tam`
 * (all `z.array(SourcedClaimSchema).optional()`, no backward-compat docstring):
 * safe to force required for a DIFFERENT reason — an array has a genuine,
 * non-fabricated "nothing here" representation (`[]`) that a bare scalar
 * doesn't, so requiring the key costs nothing even when the judge has no
 * evidence for that category (it just emits an empty array, exactly as
 * honest as omitting the key).
 */
const ALWAYS_FILLED_BY_GENERATION = new Set([
  "executiveSummary",
  "interpretation",
  "graded",
  "guidanceVsActuals",
  "capitalAllocation",
  "insiderActivity",
  "compensation",
  "tam",
  // Fresh model output must carry the canonical source identity separately
  // from the legacy display field. The Zod field stays optional only so old
  // persisted reports remain readable.
  "sourceId",
]);

export function requireAlwaysFilledFields<T>(schema: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
      const props = obj.properties as Record<string, unknown>;
      if (!Array.isArray(obj.required)) obj.required = [];
      const required = obj.required as string[];
      for (const key of Object.keys(props)) {
        if (ALWAYS_FILLED_BY_GENERATION.has(key) && !required.includes(key)) {
          required.push(key);
        }
      }
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  };
  walk(schema);
  return schema;
}

/**
 * Model output never owns verification state. Remove these fields from every
 * TracedNumber in the wire schema; fillNullableGaps restores `verified:null`
 * before runtime validation and the deterministic verifier fills the result.
 */
export function removeVerifierOwnedRequestFields<T>(schema: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
      const props = obj.properties as Record<string, unknown>;
      if (
        "value" in props &&
        "unit" in props &&
        "source" in props &&
        "asOf" in props &&
        "verified" in props
      ) {
        delete props.verified;
        delete props.verificationNote;
        if (Array.isArray(obj.required)) {
          obj.required = (obj.required as string[]).filter(
            (key) => key !== "verified" && key !== "verificationNote",
          );
        }
      }
    }
    for (const child of Object.values(obj)) walk(child);
  };
  walk(schema);
  return schema;
}

/** Data-only reports may store null odds; judge requests must always emit odds. */
function requireJudgeScenarioProbabilities<T>(schema: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const obj = node as Record<string, unknown>;
    const props = obj.properties;
    if (props && typeof props === "object") {
      const properties = props as Record<string, unknown>;
      const name = properties.name as { enum?: unknown } | undefined;
      if (
        Array.isArray(name?.enum) &&
        name.enum.join(",") === "bull,base,bear" &&
        "probability" in properties
      ) {
        const required = Array.isArray(obj.required) ? (obj.required as string[]) : [];
        if (!required.includes("probability")) obj.required = [...required, "probability"];
      }
    }
    Object.values(obj).forEach(walk);
  };
  walk(schema);
  return schema;
}

/**
 * Produce an Anthropic-structured-outputs-compatible JSON Schema for any Zod
 * schema in this module. Uses Zod v4's native `z.toJSONSchema`, then runs
 * {@link closeAdditionalProperties}, {@link relaxUnsupportedConstraints},
 * {@link collapseNullableComplexity}, and {@link requireAlwaysFilledFields}
 * defensively.
 *
 * `io: "input"` — we want the schema the model must PRODUCE (i.e. before any
 * transforms). None of our schemas use transforms, but "input" is the correct
 * contract for a model that generates the value.
 */
export function toStructuredJsonSchema(
  schema: z.ZodType,
): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io: "input",
    // Use internal $ref/$defs for repeated pieces (SourcedClaim, TracedNumber
    // appear dozens of times) rather than inlining every occurrence.
    // the Anthropic API contract §3 explicitly lists internal $ref/$def/
    // definitions as SUPPORTED, and structured-output requests are also
    // subject to documented complexity limits (<=24 total optional
    // parameters, <=16 anyOf/type-array parameters across the schema) — for
    // JUDGE_OUTPUT_SCHEMA specifically, inlining measured at 54 optional /
    // 115 anyOf fields (well past both limits) vs. 14 / 21 with $ref, a ~64%
    // smaller wire schema for byte-identical semantic content. (An earlier
    // version of this comment claimed Anthropic wants inlining — that claim
    // was never verified live and contradicts the doc's own supported list.)
    reused: "ref",
  }) as Record<string, unknown>;
  return requireAlwaysFilledFields(
    removeVerifierOwnedRequestFields(
      collapseNullableComplexity(relaxUnsupportedConstraints(closeAdditionalProperties(json))),
    ),
  );
}

/** JSON Schema for the FULL report (rarely sent to the model directly). */
export function reportToJsonSchema(): Record<string, unknown> {
  return toStructuredJsonSchema(ReportObjectSchema);
}

/** JSON Schema the judge/synthesis pass requests (report minus meta/appendix). */
export function judgeOutputToJsonSchema(): Record<string, unknown> {
  return requireJudgeScenarioProbabilities(
    toStructuredJsonSchema(JudgeOutputObjectSchema),
  );
}

/** JSON Schema the bull/bear passes request. */
export function analystCaseToJsonSchema(): Record<string, unknown> {
  return toStructuredJsonSchema(AnalystCaseObjectSchema);
}
