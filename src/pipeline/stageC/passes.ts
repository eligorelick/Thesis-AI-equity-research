/**
 * Stage C — the four grounded LLM pass runners plus report assembly (SPEC §5).
 *
 * Every runner takes the anthropic `runPass` fn INJECTED (a {@link RunPassFn})
 * so tests and the keyless dry-run path drive the passes without a live API.
 * The runners never crash the app: a keyless / refusal / max_tokens outcome
 * comes back as a typed failure the orchestrator can branch on and file as a
 * gap (SPEC §3 rule #4).
 *
 * Passes:
 *  - runBullPass / runBearPass: web search on (max ~8 uses), ANALYST_CASE_SCHEMA
 *    structured output. runBullThenBear sequences them per the prompt-cache
 *    rule (fire bull, await its first streamed token so the cache entry becomes
 *    readable, then fire bear — avoids a double 1.25x cache write, the cost model §2).
 *  - runJudgePass: payload + both cases -> JSON-only JUDGE_OUTPUT_SCHEMA,
 *    validated locally with Zod. The full judge schema is NOT sent as
 *    Anthropic strict structured output because the live grammar compiler rejects
 *    it as too large; the schema is included as prompt text instead.
 *  - runVerifyPass: measures CITATION COVERAGE (provenance, NOT correctness).
 *    Every TracedNumber must resolve an exact registry ID and match value, unit,
 *    currency, period, and as-of. Prose citations must resolve an exact payload
 *    source/date or an observed fetched URL. Untraceable evidence is flagged
 *    [unverified] and never silently deleted. The pass does not independently
 *    re-derive formulas or validate whether a cited source itself is correct.
 *  - assembleReport: wraps a JudgeOutput with meta + appendix and validates the
 *    whole thing against ReportSchema (throws a typed error on failure so the
 *    runner can retry the judge with the Zod error — max 2 retries per SPEC §2).
 *
 * SERVER-ONLY in production (the real runPass reads ANTHROPIC_API_KEY), but this
 * module imports NO provider client directly — runPass is injected — so it is
 * unit-testable in a plain node environment.
 */

import type { ManifestEntry } from "@/types/core";
import type { DataBundle } from "@/pipeline/types";
import type { ComputedMetrics } from "@/pipeline/compute";
import { computeDcfDisplay } from "@/pipeline/stageB/fairValue";
import type { MultipleKey } from "@/pipeline/stageB/valuation";
import {
  ANALYST_CASE_SCHEMA,
  JUDGE_OUTPUT_SCHEMA,
  ReportSchema,
  DISCLAIMER_TEXT,
  FRED_ATTRIBUTION_TEXT,
  REPORT_SPEC_VERSION,
  analystCaseToJsonSchema,
  judgeOutputToJsonSchema,
  fillNullableGaps,
  noBuySellHold,
  type AnalystCase,
  type JudgeOutput,
  type Report,
  type ReportMeta,
  type Appendix,
  type SourceEntry,
  type CostBreakdownEntry,
  type VerificationLogEntry,
  type TracedNumber,
  type SourcedClaim,
  type ProvenanceCoverage,
  type ScenarioTargets,
  type FairValue,
} from "@/report/schema";
import {
  assembleContextPayload,
  degradationDisclosures,
  serializePayloadForPrompt,
  payloadFingerprint,
  type ContextPayload,
} from "@/pipeline/stageC/payload";
import {
  calculateCoverage,
  canonicalizeFetchedUrl,
  canonicalizeTracedUnit,
  matchProvenanceRecord,
  type CitationProvenanceRecord,
  type NumericProvenanceRecord,
  type ProvenanceFailureReason,
} from "@/pipeline/stageC/provenance";
import {
  citationAsOf,
  citationSourceId,
  serializeCitationRef,
} from "@/pipeline/stageC/citations";
import {
  getEntityRegistry,
  collectEntityConflicts,
  validateEntityText,
  validateJudgeEntityResolution,
  type EntityIssue,
} from "@/pipeline/stageC/entityValidation";
import { buildDataCompleteness } from "@/report/completeness";
import { buildExecutionMetadataEntry } from "@/report/execution";
import {
  SHARED_RULES_BLOCK,
  buildBullFraming,
  buildBearFraming,
  buildJudgeFraming,
} from "@/pipeline/stageC/prompts";

/* ------------------------------------------------------------------------ *
 * Injected runPass contract — the STRUCTURAL subset of the provider's API this
 * module depends on. The real src/providers/anthropic.ts exports match this;
 * tests pass a mock (see {@link MockRunPass}).
 * ------------------------------------------------------------------------ */

/** Minimal usage shape the cost accounting + verification need. */
export interface PassUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number } | null;
}

/** Minimal message shape: content blocks (text carries the structured JSON). */
export interface PassMessage {
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage: PassUsage;
  model: string;
  stop_reason?: string | null;
}

/** The success branch of the provider's Sourced<PassOutcome>. */
export interface PassOutcomeLike {
  message: PassMessage;
  fetchedUrls?: string[];
  usage: PassUsage;
  costUsd: number;
  fallbackUsed: boolean;
  model: string;
}

/** Structural mirror of the provider's typed PassError (kinds incl. the
 * Stage-C-fabricated parse/schema/transport — see PassErrorKind docs). */
export interface PassErrorLike {
  kind:
    | "no_key"
    | "refusal"
    | "max_tokens"
    | "context_window"
    | "paused"
    | "parse"
    | "schema"
    | "transport";
  message: string;
  maxTokens?: number;
  /** Usage/cost from a failed provider attempt, when the provider billed it. */
  usage?: PassUsage;
  costUsd?: number;
  fallbackUsed?: boolean;
  model?: string;
  webSearches?: number;
}

/** Structural mirror of the provider's RunPassResult. */
export type RunPassOutcome =
  | { ok: true; value: { data: PassOutcomeLike } }
  | { ok: false; gap: ManifestEntry; error: PassErrorLike };

/**
 * Structural mirror of the provider's `BetaTextBlockParam` — kept local (not
 * imported from the SDK) so this module stays provider-agnostic. Used to mark a
 * prompt-cache breakpoint: Anthropic caches everything in the `tools -> system
 * -> messages` prefix up to and including the block carrying `cache_control`
 * (the Anthropic API contract §4).
 */
export interface RunPassContentBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } | null;
}

/** Options mirror of the provider's RunPassOptions (only what we set). */
export interface RunPassArgs {
  model: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string | RunPassContentBlock[] }[];
  tools?: unknown[];
  outputSchema?: Record<string, unknown>;
  maxTokens: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  field?: string;
  signal?: AbortSignal;
}

/** The injected non-streaming runner. */
export type RunPassFn = (args: RunPassArgs) => Promise<RunPassOutcome>;

/** The injected streaming runner (bull-first-then-bear cache sequencing). */
export type FirstStreamEvent = "streamEvent" | "error" | "abort" | "end";
export interface StreamingHandleLike {
  firstToken: Promise<FirstStreamEvent>;
  result: Promise<RunPassOutcome>;
}
export type RunPassStreamingFn = (args: RunPassArgs) => StreamingHandleLike;

/**
 * Web-search tool factory (kept identical across passes for cache discipline).
 * Receives the pass model so the factory can pick a tool variant the model
 * actually accepts (haiku rejects `web_search_20260318`).
 */
export type WebSearchToolFn = (maxUses: number, model?: string) => unknown;

/** Everything the pass runners need injected. */
export interface PassDeps {
  runPass: RunPassFn;
  /** Optional streaming runner; when absent, runBullThenBear falls back to runPass. */
  runPassStreaming?: RunPassStreamingFn;
  /** Web-search tool factory; when absent, passes run without web search. */
  webSearchTool?: WebSearchToolFn;
  /** Analysis model id (already resolved). */
  model: string;
  /** Effort for analysis passes (default "high"). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** One job-scoped cancellation/deadline signal. */
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------------ *
 * Pass result envelope
 * ------------------------------------------------------------------------ */

/** Successful pass output plus its usage/cost provenance. */
export interface PassResult<T> {
  output: T;
  usage: PassUsage;
  costUsd: number;
  fallbackUsed: boolean;
  model: string;
  /** Web searches this pass consumed (0 for judge/verify). */
  webSearches: number;
  /** Canonical URLs returned by successful web-search result blocks. */
  fetchedUrls: string[];
}

/**
 * A pass runner never throws for an expected LLM outcome — it returns this
 * discriminated result. `ok:false` carries the typed error + gap so the
 * orchestrator can file a ManifestEntry and continue (dry-run / refusal).
 *
 * `validationError` is set ONLY when the failure is a schema-validation failure
 * of otherwise-received structured output (as opposed to no-key/transport). The
 * retry loop feeds it back to the model; a transport/no-key failure (no
 * `validationError`) is not retryable.
 */
export type PassRun<T> =
  | { ok: true; result: PassResult<T> }
  | {
      ok: false;
      gap: ManifestEntry;
      error: PassErrorLike;
      validationError?: string;
      /**
       * Raw text of a received-but-invalid output (set alongside
       * validationError). Fed back on judge retries so the model repairs its
       * previous JSON instead of regenerating from scratch — the difference
       * between converging and re-rolling the dice on weaker models.
       */
      rawText?: string;
      usage?: PassUsage;
      costUsd?: number;
      fallbackUsed?: boolean;
      model?: string;
      webSearches?: number;
    };

/* ------------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------------ */

/** Web-search cap per analyst pass (SPEC §5 design budget ~8). */
export const ANALYST_MAX_WEB_SEARCHES = 8;
/**
 * maxTokens for the analyst passes (adaptive thinking billed as output).
 * 64K, not 32K: live sonnet-5 runs (cost_log, 2026-07-09) averaged ~29K output
 * tokens per bear pass against the old 32K cap — thinking is ~80% of that, the
 * case JSON only ~4–6K. A clipped pass fails typed (`max_tokens`), discarding
 * the pass's full sunk cost (cache write + searches + thinking). max_tokens is
 * a free ceiling: OTPM rate limits count actual generated tokens only, and
 * these passes already stream (> STREAMING_THRESHOLD_TOKENS). 64K is also
 * exactly Haiku 4.5's output ceiling, so the cap stays valid on every model.
 */
export const ANALYST_MAX_TOKENS = 64_000;
/**
 * maxTokens for the judge pass. 96K, not 64K: live sonnet-5 judges emit ~43K
 * output tokens on average (max seen 51.8K — 81% of the old cap), of which
 * ~25–30K is the 1.1.0 report JSON itself; a section-heavy ticker plus a long
 * adjudication would clip 64K and burn the whole pass. Same free-ceiling
 * reasoning as ANALYST_MAX_TOKENS; the judge floor (Sonnet 5) and every other
 * eligible judge model support 128K output.
 */
export const JUDGE_MAX_TOKENS = 96_000;
/** Rounding tolerance for tracing a report number to a payload figure. */
/** Max judge retries on a Zod-validation failure (SPEC §2). */
export const MAX_JUDGE_RETRIES = 2;

/**
 * Cheapest model that reliably emits the judge's ~13KB strict-keyed JSON.
 * The judge schema exceeds the API's compiled-grammar ceiling on EVERY model
 * (no `output_config.format` enforcement possible), so schema fidelity is
 * pure model capability. Haiku 4.5 structurally cannot do it — live runs
 * (2026-07-09) showed misplaced sections, invented keys, and dropped required
 * objects across every repair retry. Bull/bear stay on the selected model
 * (that is where the web-search/token bulk is); only the judge is floored.
 * Per-pass cost logging and the pipeline UI report the ACTUAL serving model,
 * so the substitution is visible, not silent.
 */
export const JUDGE_MODEL_FLOOR = "claude-sonnet-5";

/** Model the judge/synthesis pass should run on for a given analysis model. */
export function judgeModelFor(analysisModel: string): string {
  return analysisModel.startsWith("claude-haiku-") ? JUDGE_MODEL_FLOOR : analysisModel;
}

/**
 * Cap on how much of a failed judge output is echoed back on retry. Sized
 * from MEASURED output: 1.1.0 judge JSON runs ~100–120K chars on sonnet-5
 * (reports table, 2026-07-09) — the previous 60K cap, premised on a stale
 * "~15–25K chars" estimate, truncated every realistic echo mid-document while
 * telling the model to "repair this JSON in place", which forces it to
 * regenerate the missing half from scratch (the exact failure mode the echo
 * exists to avoid). 200K covers observed sizes ~1.7× over and still bounds a
 * genuine runaway; the echo is only ever paid on a retry (~30K input tokens
 * for a full echo — cheap next to re-rolling a judge pass).
 * Keep in sync with jobRunner's JUDGE_RETRY_RAW_OUTPUT_CAP.
 */
export const JUDGE_RETRY_PREVIOUS_OUTPUT_CAP = 200_000;

/**
 * Build the retry feedback message for a judge attempt that failed schema
 * validation. When the failed attempt's raw output is available it is echoed
 * back so the model REPAIRS its previous JSON instead of regenerating the
 * whole document from scratch — regeneration re-rolls the dice and weaker
 * models (haiku) rarely converge that way.
 */
export function judgeRetryFeedback(zodError: string, previousOutput?: string): string {
  const prev =
    previousOutput && previousOutput.length > 0
      ? `\n\nYOUR PREVIOUS OUTPUT (repair this JSON in place — do not start over):\n${
          previousOutput.length > JUDGE_RETRY_PREVIOUS_OUTPUT_CAP
            ? `${previousOutput.slice(0, JUDGE_RETRY_PREVIOUS_OUTPUT_CAP)}\n[...truncated]`
            : previousOutput
        }`
      : "";
  return `Your previous output FAILED report-schema validation with this error. Fix EXACTLY these issues and re-emit the full JUDGE_OUTPUT schema:\n${zodError}${prev}`;
}

/* ------------------------------------------------------------------------ *
 * Structured-output extraction + validation
 * ------------------------------------------------------------------------ */

/** Extract the concatenated text-block content (the structured JSON) from a message. */
export function extractText(message: PassMessage): string {
  return message.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * Parse pass output as JSON, salvaging the first balanced top-level JSON
 * value when the raw text doesn't parse whole. `output_config.format` should
 * guarantee pure JSON, but with web-search tools in the turn some models
 * (observed live on haiku-4-5, 2026-07-08) append prose or a second copy
 * after the JSON — discarding the whole multi-dollar pass over trailing text
 * is worse than salvaging the value and letting Zod validate it as usual.
 * Throws (JSON.parse's error) when no parseable JSON value is found.
 */
export function parseJsonSalvaging(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (wholeError) {
    const start = text.search(/[{[]/);
    if (start === -1) throw wholeError;
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
      } else if (inString) {
        if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === open) {
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0) return JSON.parse(text.slice(start, i + 1));
      }
    }
    throw wholeError;
  }
}

/** Thrown when the report fails ReportSchema validation (caught by the runner to retry). */
export class ReportValidationError extends Error {
  constructor(
    message: string,
    /** The Zod issue string to feed back to the judge on retry. */
    readonly zodError: string,
  ) {
    super(message);
    this.name = "ReportValidationError";
  }
}

/* ------------------------------------------------------------------------ *
 * Web-search counting
 * ------------------------------------------------------------------------ */

function webSearchesOf(usage: PassUsage): number {
  return usage.server_tool_use?.web_search_requests ?? 0;
}

/* ------------------------------------------------------------------------ *
 * Payload -> user turn
 * ------------------------------------------------------------------------ */

/**
 * The user turn carrying the serialized payload. Identical text across all
 * passes so it sits behind the same cache breakpoint. The volatile per-pass
 * framing is NOT appended here — see {@link buildCachedUserMessage}.
 */
export function payloadUserTurn(payload: ContextPayload): string {
  return serializePayloadForPrompt(payload);
}

/**
 * Build the single user message every analyst/judge pass sends: the
 * byte-identical payload as the FIRST content block, carrying the
 * `cache_control` breakpoint (the Anthropic API contract §4 — a cache entry
 * covers everything in the prefix up to and including this block, so `tools`
 * and `system` being identical across passes is what lets bear/subsequent
 * passes read the entry bull's request writes), followed by the pass-specific
 * volatile framing as a SECOND block, positioned after the breakpoint so it
 * never perturbs the cached prefix.
 */
export function buildCachedUserMessage(
  payload: ContextPayload,
  framing: string,
): { role: "user"; content: RunPassContentBlock[] } {
  return {
    role: "user",
    content: [
      { type: "text", text: payloadUserTurn(payload), cache_control: { type: "ephemeral" } },
      { type: "text", text: framing },
    ],
  };
}

/* ------------------------------------------------------------------------ *
 * Generic structured pass runner
 * ------------------------------------------------------------------------ */

interface StructuredPassArgs<T> {
  deps: PassDeps;
  system: string;
  userTurns: { role: "user" | "assistant"; content: string | RunPassContentBlock[] }[];
  outputSchema?: Record<string, unknown>;
  parse: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string };
  maxTokens: number;
  useWebSearch: boolean;
  model: string;
  field: string;
}

/**
 * Shared tool array for the analyst passes — identical shape keeps the cache
 * warm across bull/bear. Judge/verify get NO tools (return undefined) rather
 * than a declared-but-crippled `max_uses:1` web_search tool: that shape (a)
 * still isn't byte-identical to bull/bear's `max_uses:8` tool, so it bought no
 * cache-prefix parity anyway, and (b) permits the judge model to legally issue
 * one live web search on the SAME request as `output_config.format` (structured
 * output) — a combination the Anthropic API contract §8 explicitly flags as
 * PENDING LIVE VERIFICATION, and the judge/verify design intent (the cost model,
 * the Anthropic API contract §7) is "no web search" for these passes. Omitting
 * `tools` entirely enforces that intent instead of merely making it likely.
 */
function toolsFor(deps: PassDeps, useWebSearch: boolean, model: string): unknown[] | undefined {
  if (!deps.webSearchTool || !useWebSearch) return undefined;
  return [deps.webSearchTool(ANALYST_MAX_WEB_SEARCHES, model)];
}

async function runStructuredPass<T>(a: StructuredPassArgs<T>): Promise<PassRun<T>> {
  const outcome = await a.deps.runPass({
    model: a.model,
    system: a.system,
    messages: a.userTurns,
    tools: toolsFor(a.deps, a.useWebSearch, a.model),
    outputSchema: a.outputSchema,
    maxTokens: a.maxTokens,
    effort: a.deps.effort ?? "high",
    field: a.field,
    signal: a.deps.signal,
  });
  return finishStructuredPass(outcome, a.parse, a.field, a.model);
}

function finishStructuredPass<T>(
  outcome: RunPassOutcome,
  parse: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string },
  field: string,
  requestedModel: string,
): PassRun<T> {
  if (!outcome.ok) {
    const usage = outcome.error.usage;
    return {
      ok: false,
      gap: outcome.gap,
      error: outcome.error,
      usage,
      costUsd: outcome.error.costUsd,
      fallbackUsed: outcome.error.fallbackUsed,
      model: outcome.error.model ?? (outcome.error.costUsd !== undefined ? requestedModel : undefined),
      webSearches: outcome.error.webSearches ?? (usage ? webSearchesOf(usage) : undefined),
    };
  }
  const data = outcome.value.data;
  const text = extractText(data.message);
  const billedAttempt = {
    usage: data.usage,
    costUsd: data.costUsd,
    fallbackUsed: data.fallbackUsed,
    model: data.model,
    webSearches: webSearchesOf(data.usage),
  };
  let json: unknown;
  try {
    json = parseJsonSalvaging(text);
  } catch (e) {
    const reason = `pass output was not valid JSON: ${(e as Error).message}`;
    return {
      ok: false,
      gap: { field, reason, severity: "critical", attemptedSources: ["anthropic"] },
      error: { kind: "parse", message: `unparseable structured output for ${field}` },
      validationError: reason,
      rawText: text,
      ...billedAttempt,
    };
  }
  const parsed = parse(json);
  if (!parsed.ok) {
    const reason = `pass output failed schema validation: ${parsed.error}`;
    return {
      ok: false,
      gap: { field, reason, severity: "critical", attemptedSources: ["anthropic"] },
      error: { kind: "schema", message: `schema-invalid structured output for ${field}` },
      validationError: parsed.error,
      rawText: text,
      ...billedAttempt,
    };
  }
  return {
    ok: true,
    result: {
      output: parsed.value,
      usage: data.usage,
      costUsd: data.costUsd,
      fallbackUsed: data.fallbackUsed,
      model: data.model,
      webSearches: webSearchesOf(data.usage),
      fetchedUrls: data.fetchedUrls ?? [],
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Bull / bear passes
 * ------------------------------------------------------------------------ */

const CLAIM_LABEL_VALUES = new Set(["FACT", "ESTIMATE", "JUDGMENT"]);
const GRADE_VALUES = new Set(["A", "B", "C", "D", "F"]);
const SCENARIO_NAME_VALUES = new Set(["bull", "base", "bear"]);
const LOWER_ENUM_VALUES_BY_KEY: Record<string, ReadonlySet<string>> = {
  confidence: new Set(["high", "medium", "low"]),
  severity: new Set(["high", "medium", "low"]),
  significance: new Set(["high", "medium", "low"]),
  probability: new Set(["high", "medium", "low"]),
  direction: new Set(["positive", "negative", "mixed"]),
  strength: new Set(["none", "narrow", "wide"]),
  kind: new Set(["fact", "interpretation"]),
};

function normalizeUpperEnum(value: unknown, allowed: ReadonlySet<string>): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toUpperCase();
  return allowed.has(normalized) ? normalized : value;
}

function normalizeLowerEnum(value: unknown, allowed: ReadonlySet<string>): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : value;
}

function bandLowMedHigh(p: number): "low" | "medium" | "high" {
  if (p < 1 / 3) return "low";
  if (p < 2 / 3) return "medium";
  return "high";
}

/**
 * Coerce a low/med/high-shaped value that isn't already a valid enum member.
 * Models (haiku especially) emit numeric or percent probabilities on risk
 * objects — natural confusion, since the same judge schema uses NUMERIC
 * probabilities for scenarios. Banding is mechanical and order-preserving
 * (<1/3 low, <2/3 medium, else high), so it maps the model's own judgment
 * rather than inventing one. Unrecognized values pass through for Zod to
 * reject as before.
 */
function coerceLowMedHigh(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) {
    return bandLowMedHigh(value > 1 ? value / 100 : value);
  }
  if (typeof value !== "string") return value;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "moderate" || trimmed === "med" || trimmed === "mid" || trimmed === "middle") {
    return "medium";
  }
  const pct = trimmed.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) return bandLowMedHigh(Number(pct[1]) / 100);
  const num = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(num)) return bandLowMedHigh(num > 1 ? num / 100 : num);
  return value;
}

const LOW_MED_HIGH = LOWER_ENUM_VALUES_BY_KEY.severity;

function isSourcedClaimLike(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.text === "string" &&
    typeof obj.label === "string" &&
    typeof obj.source === "string" &&
    Object.prototype.hasOwnProperty.call(obj, "asOf")
  );
}

function normalizeKnownEnumCasing(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  if (Array.isArray(raw)) return raw.map(normalizeKnownEnumCasing);

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    next[key] = normalizeKnownEnumCasing(value);
  }

  if (isSourcedClaimLike(next)) {
    next.label = normalizeUpperEnum(next.label, CLAIM_LABEL_VALUES);
  }
  if ("grade" in next) next.grade = normalizeUpperEnum(next.grade, GRADE_VALUES);
  if ("credibilityGrade" in next) {
    next.credibilityGrade = normalizeUpperEnum(next.credibilityGrade, GRADE_VALUES);
  }

  for (const [key, allowed] of Object.entries(LOWER_ENUM_VALUES_BY_KEY)) {
    if (key in next) next[key] = normalizeLowerEnum(next[key], allowed);
  }

  // Risk-shaped objects only (never scenarios, whose `probability` is
  // legitimately numeric): band numeric/percent probability/severity values
  // the casing pass couldn't fix into the low/med/high enum.
  if (
    typeof next.title === "string" &&
    "probability" in next &&
    "severity" in next &&
    "source" in next
  ) {
    for (const key of ["probability", "severity"] as const) {
      const value = next[key];
      if (typeof value !== "string" || !LOW_MED_HIGH.has(value)) {
        next[key] = coerceLowMedHigh(value);
      }
    }
  }

  return next;
}

function removeUnsafeAnalystAssumptions(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const root = raw as Record<string, unknown>;
  const priceTarget = root.priceTarget;
  if (priceTarget === null || typeof priceTarget !== "object" || Array.isArray(priceTarget)) return raw;
  const target = priceTarget as Record<string, unknown>;
  if (!Array.isArray(target.assumptions)) return raw;
  return {
    ...root,
    priceTarget: {
      ...target,
      assumptions: target.assumptions.filter(
        (item) => typeof item !== "string" || noBuySellHold(item),
      ),
    },
  };
}

const parseAnalystCase = (raw: unknown) => {
  // fillNullableGaps: the request schema lets the model OMIT a nullable field
  // instead of sending null (collapseNullableComplexity, report/schema.ts) —
  // restore the null before validating against the still-strict Zod schema.
  const normalized = normalizeKnownEnumCasing(raw);
  const r = ANALYST_CASE_SCHEMA.safeParse(
    fillNullableGaps(ANALYST_CASE_SCHEMA, removeUnsafeAnalystAssumptions(normalized)),
  );
  return r.success
    ? ({ ok: true, value: r.data } as const)
    : ({ ok: false, error: r.error.message } as const);
};

/** Run the bull pass. Web search on, ANALYST_CASE_SCHEMA structured output. */
export function runBullPass(deps: PassDeps, payload: ContextPayload): Promise<PassRun<AnalystCase>> {
  return runStructuredPass<AnalystCase>({
    deps,
    system: SHARED_RULES_BLOCK,
    userTurns: [buildCachedUserMessage(payload, buildBullFraming())],
    outputSchema: analystCaseToJsonSchema(),
    parse: parseAnalystCase,
    maxTokens: ANALYST_MAX_TOKENS,
    useWebSearch: true,
    model: deps.model,
    field: "llm.bull",
  });
}

/** Run the bear pass. Independent — never receives the bull output. */
export function runBearPass(deps: PassDeps, payload: ContextPayload): Promise<PassRun<AnalystCase>> {
  return runStructuredPass<AnalystCase>({
    deps,
    system: SHARED_RULES_BLOCK,
    userTurns: [buildCachedUserMessage(payload, buildBearFraming())],
    outputSchema: analystCaseToJsonSchema(),
    parse: parseAnalystCase,
    maxTokens: ANALYST_MAX_TOKENS,
    useWebSearch: true,
    model: deps.model,
    field: "llm.bear",
  });
}

export interface BullBearResult {
  bull: PassRun<AnalystCase>;
  bear: PassRun<AnalystCase>;
}

/**
 * Per-side lifecycle hooks so the caller can stamp REAL start/finish times.
 * The two passes overlap in the streaming path (bear fires once bull's first
 * token lands), so the job runner cannot infer per-pass timing from around
 * the combined call. Hook throws are swallowed — telemetry must never break
 * a paid pass.
 */
export interface BullBearHooks {
  onPassStart?: (side: "bull" | "bear") => void;
  onPassFinish?: (side: "bull" | "bear") => void;
}

function safeHook(hook: ((side: "bull" | "bear") => void) | undefined, side: "bull" | "bear"): void {
  try {
    hook?.(side);
  } catch {
    // Telemetry hooks never break a pass.
  }
}

/** Resolve/reject passthrough that fires the finish hook either way. */
function tapFinish<T>(promise: Promise<T>, hooks: BullBearHooks, side: "bull" | "bear"): Promise<T> {
  return promise.then(
    (value) => {
      safeHook(hooks.onPassFinish, side);
      return value;
    },
    (err: unknown) => {
      safeHook(hooks.onPassFinish, side);
      throw err;
    },
  );
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hardFailure(field: string, err: unknown): PassRun<AnalystCase> {
  const reason = failureMessage(err);
  return {
    ok: false,
    gap: { field, reason, severity: "critical", attemptedSources: ["anthropic"] },
    error: { kind: "transport", message: reason },
  };
}

function bearNotLaunched(reason: string): PassRun<AnalystCase> {
  const message = `bear pass not launched because bull stream did not reach a first token (${reason})`;
  return {
    ok: false,
    gap: { field: "llm.bear", reason: message, severity: "critical", attemptedSources: ["anthropic"] },
    error: { kind: "transport", message },
  };
}

/**
 * Sequence bull then bear per the prompt-cache write rule (the cost model §2): fire the
 * bull pass, AWAIT its first streamed token so the payload cache entry becomes
 * readable, then fire bear so it READS the cache bull wrote instead of paying a
 * second 1.25x write. When no streaming runner is injected (tests / dry-run), it
 * degrades to a correct sequential await — bull fully completes before bear
 * starts, which is still cache-correct, just without the concurrency win.
 */
export async function runBullThenBear(
  deps: PassDeps,
  payload: ContextPayload,
  hooks: BullBearHooks = {},
): Promise<BullBearResult> {
  if (deps.runPassStreaming) {
    safeHook(hooks.onPassStart, "bull");
    const bullHandle = deps.runPassStreaming({
      model: deps.model,
      system: SHARED_RULES_BLOCK,
      messages: [buildCachedUserMessage(payload, buildBullFraming())],
      tools: toolsFor(deps, true, deps.model),
      outputSchema: analystCaseToJsonSchema(),
      maxTokens: ANALYST_MAX_TOKENS,
      effort: deps.effort ?? "high",
      field: "llm.bull",
      signal: deps.signal,
    });
    const bullResult = tapFinish(bullHandle.result, hooks, "bull");
    // Cache entry becomes readable only once bull actually emits a stream event.
    const firstEvent = await bullHandle.firstToken;
    if (firstEvent !== "streamEvent") {
      const bullOutcome = await bullResult;
      const bull = finishStructuredPass(bullOutcome, parseAnalystCase, "llm.bull", deps.model);
      if (!bull.ok) return { bull, bear: bearNotLaunched(firstEvent) };

      // Rare but possible: the SDK reached "end" without our streamEvent latch.
      // Run bear sequentially after bull completes rather than racing without a
      // confirmed cache write.
      safeHook(hooks.onPassStart, "bear");
      const bear = await tapFinish(runBearPass(deps, payload), hooks, "bear");
      return { bull, bear };
    }
    safeHook(hooks.onPassStart, "bear");
    const bearHandle = deps.runPassStreaming({
      model: deps.model,
      system: SHARED_RULES_BLOCK,
      messages: [buildCachedUserMessage(payload, buildBearFraming())],
      tools: toolsFor(deps, true, deps.model),
      outputSchema: analystCaseToJsonSchema(),
      maxTokens: ANALYST_MAX_TOKENS,
      effort: deps.effort ?? "high",
      field: "llm.bear",
      signal: deps.signal,
    });
    const [bullOutcome, bearOutcome] = await Promise.allSettled([
      bullResult,
      tapFinish(bearHandle.result, hooks, "bear"),
    ]);
    return {
      bull:
        bullOutcome.status === "fulfilled"
          ? finishStructuredPass(bullOutcome.value, parseAnalystCase, "llm.bull", deps.model)
          : hardFailure("llm.bull", bullOutcome.reason),
      bear:
        bearOutcome.status === "fulfilled"
          ? finishStructuredPass(bearOutcome.value, parseAnalystCase, "llm.bear", deps.model)
          : hardFailure("llm.bear", bearOutcome.reason),
    };
  }

  // Non-streaming fallback: sequential (bull completes, then bear reads cache).
  safeHook(hooks.onPassStart, "bull");
  const bull = await tapFinish(runBullPass(deps, payload), hooks, "bull");
  safeHook(hooks.onPassStart, "bear");
  const bear = await tapFinish(runBearPass(deps, payload), hooks, "bear");
  return { bull, bear };
}

/* ------------------------------------------------------------------------ *
 * Judge pass
 * ------------------------------------------------------------------------ */

/**
 * Build the judge user turn: the payload as the cached first content block
 * (byte-identical to the analyst passes' payload block, so with an identical
 * `tools`+`system` prefix this can in principle share bull/bear's cache entry —
 * subject to the separate, documented `output_config.format` cache-invalidation
 * caveat for structured-output requests, the Anthropic API contract §4 quirk #3),
 * followed by the judge framing + both cases as a second, volatile block.
 * JSON.stringify is COMPACT (no pretty-print indent) — the model's JSON parsing
 * is whitespace-insensitive, so indentation is pure token overhead, repeated on
 * every judge retry attempt.
 */
export function judgeUserTurns(
  payload: ContextPayload,
  bull: AnalystCase,
  bear: AnalystCase,
): { role: "user"; content: RunPassContentBlock[] }[] {
  const entityConflicts = entityConflictsForCases(payload, bull, bear);
  const entityConflictBlock = entityConflicts.length === 0
    ? ""
    : [
        "",
        "DETERMINISTIC ENTITY CONFLICTS (must be resolved explicitly):",
        JSON.stringify(entityConflicts),
        "Add kind=entity disagreements that name the canonical entity and explain the supported resolution. Do not silently choose or rename an entity.",
      ].join("\n");
  return [
    buildCachedUserMessage(
      payload,
      [
        buildJudgeFraming(),
        "",
        "BULL CASE (independent analyst):",
        JSON.stringify(bull),
        "",
        "BEAR CASE (independent analyst):",
        JSON.stringify(bear),
        entityConflictBlock,
        "",
        "JUDGE_OUTPUT JSON Schema reference:",
        JSON.stringify(judgeOutputToJsonSchema()),
        "",
        "Adjudicate on the evidence and emit the JUDGE_OUTPUT schema.",
        "Return ONLY valid JSON matching that schema. Do not wrap it in Markdown and do not add prose before or after the JSON.",
      ].join("\n"),
    ),
  ];
}

function analystClaimTexts(value: unknown): string[] {
  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((value) => walk(value));
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.text === "string" && typeof record.label === "string") {
      texts.push(record.text);
    }
    Object.values(record).forEach(walk);
  };
  walk(value);
  return texts;
}

function entityConflictsForCases(
  payload: ContextPayload,
  bull: AnalystCase,
  bear: AnalystCase,
): EntityIssue[] {
  const registry = getEntityRegistry(payload.symbol);
  if (registry === null) return [];
  return collectEntityConflicts(
    analystClaimTexts(bull),
    analystClaimTexts(bear),
    registry,
  );
}

function unresolvedJudgeEntityConflicts(
  payload: ContextPayload,
  bull: AnalystCase,
  bear: AnalystCase,
  output: JudgeOutput,
): EntityIssue[] {
  const registry = getEntityRegistry(payload.symbol);
  if (registry === null) return [];
  const unresolved = validateJudgeEntityResolution(
    entityConflictsForCases(payload, bull, bear),
    output.disagreements,
  );
  const reportIssues: EntityIssue[] = [];
  const walk = (node: unknown, structuredSource: string | null = null): void => {
    if (typeof node === "string") {
      reportIssues.push(
        ...validateEntityText(node, registry, structuredSource).issues.filter(
          (issue) => structuredSource !== null || issue.code !== "primary-source-required",
        ),
      );
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((value) => walk(value));
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.text === "string" && typeof record.label === "string") {
      const rawSource = citationSourceId(record);
      const primarySource = rawSource?.startsWith("web:") ? rawSource.slice(4) : rawSource;
      reportIssues.push(...validateEntityText(record.text, registry, primarySource).issues);
      for (const [key, value] of Object.entries(record)) {
        if (key !== "text") walk(value);
      }
      return;
    }
    Object.values(record).forEach((value) => walk(value));
  };
  const reportWithoutExplicitConflictQuotes = { ...output } as Partial<JudgeOutput>;
  delete reportWithoutExplicitConflictQuotes.disagreements;
  walk(reportWithoutExplicitConflictQuotes);
  const deduped = new Map<string, EntityIssue>();
  for (const issue of [...unresolved, ...reportIssues]) {
    deduped.set(`${issue.code}\u0000${issue.recordId}\u0000${issue.observed}`, issue);
  }
  return [...deduped.values()];
}

function entityConflictFailure(
  successful: PassResult<JudgeOutput>,
  unresolved: readonly EntityIssue[],
): PassRun<JudgeOutput> {
  const details = unresolved
    .map((issue) => `${issue.code}: ${issue.text}`)
    .join("; ");
  const reason = `judge left deterministic entity conflicts unresolved: ${details}`;
  return {
    ok: false,
    gap: {
      field: "llm.judge.entities",
      reason,
      severity: "critical",
      attemptedSources: ["canonical-entity-registry", "judge-disagreements"],
    },
    error: { kind: "schema", message: reason },
    validationError: reason,
    rawText: JSON.stringify(successful.output),
    usage: successful.usage,
    costUsd: successful.costUsd,
    fallbackUsed: successful.fallbackUsed,
    model: successful.model,
    webSearches: successful.webSearches,
  };
}

function parseProbabilityLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim().replace(/%$/, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanRatingSafeArray(value: unknown): unknown {
  return Array.isArray(value)
    ? value.filter((item) => typeof item !== "string" || noBuySellHold(item))
    : value;
}

export function normalizeJudgeOutput(raw: unknown): unknown {
  const enumNormalized = normalizeKnownEnumCasing(raw);
  if (enumNormalized === null || typeof enumNormalized !== "object" || Array.isArray(enumNormalized)) {
    return enumNormalized;
  }
  const root = { ...(enumNormalized as Record<string, unknown>) };

  if (root.macro !== null && typeof root.macro === "object" && !Array.isArray(root.macro)) {
    root.macro = {
      ...(root.macro as Record<string, unknown>),
      fredAttribution: FRED_ATTRIBUTION_TEXT,
    };
  }

  if (root.valuation !== null && typeof root.valuation === "object" && !Array.isArray(root.valuation)) {
    const valuation = { ...(root.valuation as Record<string, unknown>) };
    if (Array.isArray(valuation.scenarios)) {
      const scenarios = valuation.scenarios.map((scenario) => {
        if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) return scenario;
        const next = { ...(scenario as Record<string, unknown>) };
        next.name = normalizeLowerEnum(next.name, SCENARIO_NAME_VALUES);
        next.assumptions = cleanRatingSafeArray(next.assumptions);
        next.whatWouldHaveToBeTrue = cleanRatingSafeArray(next.whatWouldHaveToBeTrue);
        // Scenario price targets are DETERMINISTIC (Stage B computeScenarioTargets),
        // injected by assembleReport — the judge/LLM does not author them. Null any
        // number the model emitted anyway so it never reaches the verify pass's
        // citation-coverage count nor the report (2026-07-11 scenario-credibility
        // checkpoint). assembleReport then overwrites this with the computed target
        // or leaves it null when suppressed.
        next.priceTarget = null;
        return next;
      });
      const probabilities = scenarios.map((scenario) =>
        scenario !== null && typeof scenario === "object" && !Array.isArray(scenario)
          ? parseProbabilityLike((scenario as Record<string, unknown>).probability)
          : null,
      );
      if (probabilities.every((p): p is number => p !== null)) {
        const sum = probabilities.reduce((acc, p) => acc + p, 0);
        if (sum >= 99 && sum <= 101 && probabilities.some((p) => p > 1)) {
          for (let i = 0; i < scenarios.length; i++) {
            const scenario = scenarios[i];
            if (scenario !== null && typeof scenario === "object" && !Array.isArray(scenario)) {
              (scenario as Record<string, unknown>).probability = Number((probabilities[i] / 100).toFixed(4));
            }
          }
        }
      }
      valuation.scenarios = scenarios;
    }
    // DCF perShare + upsidePct + assumptions table + sensitivityGrid are ALL
    // DETERMINISTIC (Stage B computeFairValue / computeDcfDisplay), injected by
    // assembleReport — discard any the judge emitted so they never reach the verify
    // pass count nor the report (2026-07-11 DCF-credibility + valuation-consistency
    // checkpoints). assembleReport injects the computed values (or empties off the
    // DCF route). The judge keeps only the reverse-DCF narrative + interpretation.
    if (valuation.dcf !== null && typeof valuation.dcf === "object" && !Array.isArray(valuation.dcf)) {
      valuation.dcf = {
        ...(valuation.dcf as Record<string, unknown>),
        perShare: null,
        upsidePct: null,
        assumptions: [],
        sensitivityGrid: [],
      };
    }
    root.valuation = valuation;
  }

  return root;
}

const parseJudgeOutput = (raw: unknown) => {
  const normalized = normalizeJudgeOutput(raw);
  // See parseAnalystCase — same nullable-omission compensation.
  const r = JUDGE_OUTPUT_SCHEMA.safeParse(fillNullableGaps(JUDGE_OUTPUT_SCHEMA, normalized));
  return r.success
    ? ({ ok: true, value: r.data } as const)
    : ({ ok: false, error: r.error.message } as const);
};

/**
 * Run the judge/synthesis pass: payload + both cases -> JSON-only
 * JUDGE_OUTPUT_SCHEMA. Unlike bull/bear, the judge intentionally omits
 * `output_config.format.schema`: the full report grammar exceeded Anthropic's
 * live compiled-grammar ceiling. We still include the compact JSON Schema as
 * prompt text and enforce the exact Zod schema after parsing, with retry on
 * validation failure.
 */
export async function runJudgePass(
  deps: PassDeps,
  payload: ContextPayload,
  bull: AnalystCase,
  bear: AnalystCase,
  validationFeedback?: string,
): Promise<PassRun<JudgeOutput>> {
  const userTurns =
    validationFeedback === undefined || validationFeedback.length === 0
      ? judgeUserTurns(payload, bull, bear)
      : [
          ...judgeUserTurns(payload, bull, bear),
          {
            role: "user" as const,
            content: `Your previous output FAILED report-schema validation with this error. Fix EXACTLY these issues and re-emit the full JUDGE_OUTPUT schema:\n${validationFeedback}`,
          },
        ];
  const run = await runStructuredPass<JudgeOutput>({
    deps,
    system: SHARED_RULES_BLOCK,
    userTurns,
    parse: parseJudgeOutput,
    maxTokens: JUDGE_MAX_TOKENS,
    useWebSearch: false,
    model: judgeModelFor(deps.model),
    field: "llm.judge",
  });
  if (!run.ok) return run;
  const unresolved = unresolvedJudgeEntityConflicts(payload, bull, bear, run.result.output);
  return unresolved.length === 0 ? run : entityConflictFailure(run.result, unresolved);
}

/* ------------------------------------------------------------------------ *
 * Verification pass — deterministic tracing (authoritative), model optional
 * ------------------------------------------------------------------------ */

export interface VerificationEvidence {
  fetchedUrls: string[];
}

export interface VerifyResult<T = JudgeOutput> {
  verifiedReport: T;
  /** Legacy DB/API alias for numeric provenance coverage. */
  verificationRate: number | null;
  coverage: ProvenanceCoverage;
  log: VerificationLogEntry[];
  /** Backward-compatible numeric counters. */
  traced: number;
  total: number;
}

/**
 * Collect every TracedNumber in a JudgeOutput with a mutable ref so the verify
 * pass can set `verified`/`verificationNote` in place. We walk the object
 * generically: any object with the TracedNumber shape (value+unit+source+asOf+
 * verified) is a hit. This keeps verification robust to schema growth.
 */
export function collectTracedNumbers(root: unknown): TracedNumber[] {
  return collectTracedNumberRefs(root).map((entry) => entry.number);
}

interface TracedNumberRef {
  number: TracedNumber;
  path: string;
}

function collectTracedNumberRefs(root: unknown): TracedNumberRef[] {
  const out: TracedNumberRef[] = [];
  const isTraced = (o: Record<string, unknown>): boolean =>
    typeof o.value === "number" &&
    typeof o.unit === "string" &&
    (typeof o.sourceId === "string" || typeof o.source === "string") &&
    ("asOf" in o) &&
    ("verified" in o);
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        walk(node[index], `${path}[${index}]`);
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    if (isTraced(obj)) {
      out.push({ number: obj as unknown as TracedNumber, path: path || "$" });
      return; // a TracedNumber has no nested TracedNumbers
    }
    for (const key of Object.keys(obj)) walk(obj[key], path ? `${path}.${key}` : key);
  };
  walk(root, "");
  return out;
}

/** A sourced claim plus its exact report path for citation-coverage accounting. */
interface SourcedClaimRef {
  claim: SourcedClaim;
  path: string;
}

function collectSourcedClaimRefs(root: unknown): SourcedClaimRef[] {
  const out: SourcedClaimRef[] = [];
  const labels = new Set(["FACT", "ESTIMATE", "JUDGMENT"]);
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        walk(node[index], `${path}[${index}]`);
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    if (
      typeof obj.text === "string" &&
      typeof obj.label === "string" &&
      labels.has(obj.label) &&
      (typeof obj.sourceId === "string" || typeof obj.source === "string") &&
      "asOf" in obj
    ) {
      out.push({ claim: obj as unknown as SourcedClaim, path: path || "$" });
      return;
    }
    for (const key of Object.keys(obj)) walk(obj[key], path ? `${path}.${key}` : key);
  };
  walk(root, "");
  return out;
}

function claimSourceMatch(
  claim: SourcedClaim,
  numericRegistry: readonly NumericProvenanceRecord[],
  citationRegistry: readonly CitationProvenanceRecord[],
  fetchedUrls: ReadonlySet<string>,
): { supported: boolean; reason: "supported" | "unknown-source" | "date-mismatch" } {
  const sourceId = citationSourceId(claim);
  if (sourceId === null) return { supported: false, reason: "unknown-source" };
  const asOf = citationAsOf(claim);
  const candidates = [
    ...numericRegistry
      .filter((record) => record.id === sourceId)
      .map((record) => record.asOf),
    ...citationRegistry
      .filter((record) => record.id === sourceId)
      .map((record) => record.asOf),
  ];
  if (candidates.length > 0) {
    // A judgment can be timeless while still citing exact evidence. FACT and
    // ESTIMATE claims must reproduce the source's as-of date exactly.
    const dateMatches =
      claim.label === "JUDGMENT" || candidates.some((candidate) => candidate === asOf);
    return dateMatches
      ? { supported: true, reason: "supported" }
      : { supported: false, reason: "date-mismatch" };
  }
  const canonical = canonicalizeFetchedUrl(sourceId);
  return canonical !== null && fetchedUrls.has(canonical)
    ? { supported: true, reason: "supported" }
    : { supported: false, reason: "unknown-source" };
}

function appendUnverifiedNote(number: TracedNumber, reason: ProvenanceFailureReason): void {
  const note = `[unverified] ${reason}`;
  number.verificationNote = number.verificationNote
    ? `${number.verificationNote}; ${note}`
    : note;
}

/**
 * Deterministic CITATION-COVERAGE pass (the authority for the `verified` flag).
 * This measures PROVENANCE, not correctness. A TracedNumber is supported only
 * when its exact registry ID resolves and value, unit, currency, period, and
 * as-of all match that record within its declared display precision. A claim is
 * supported only by an exact numeric/text registry tag (including its as-of for
 * FACT/ESTIMATE) or a URL actually observed in provider web-search results.
 * Untraceable evidence is never deleted: numbers are marked
 * false with an explicit reason, and claims receive an unverified log entry.
 * Numeric prose embedded in claim text is intentionally not regex-extracted;
 * numeric provenance requires a structured TracedNumber. Rates are null when
 * their denominator is zero, never synthetic perfection.
 *
 * Deterministic-only: an earlier model-side pass (VERIFY_MODEL) was removed
 * because it discarded its output and merely burned tokens — the trace here has
 * always been the sole authority. The verifyModel setting/env/meta plumbing was
 * removed with it; old persisted reports keep their meta.verifyModel label.
 */
export async function runVerifyPass<T extends object = JudgeOutput>(
  deps: PassDeps,
  payload: ContextPayload,
  reportOutput: T,
  evidence: VerificationEvidence = { fetchedUrls: [] },
): Promise<VerifyResult<T>> {
  void deps;
  // Deep-clone so we mutate a copy, never the caller's object.
  const verifiedReport = structuredClone(reportOutput) as T;
  const registry = payload.provenanceRegistry ?? [];
  const citationRegistry = payload.citationRegistry ?? [];
  const fetchedUrls = new Set(
    evidence.fetchedUrls.flatMap((value) => {
      const canonical = canonicalizeFetchedUrl(value);
      return canonical ? [canonical] : [];
    }),
  );
  const numbers = collectTracedNumberRefs(verifiedReport);
  const claims = collectSourcedClaimRefs(verifiedReport);

  const log: VerificationLogEntry[] = [];
  let traced = 0;

  for (const { number, path } of numbers) {
    const sourceId = citationSourceId(number);
    const sourceAsOf = citationAsOf(number);
    if (sourceId !== null) number.sourceId = sourceId;
    const record = sourceId === null
      ? undefined
      : registry.find((entry) => entry.id === sourceId);
    let reason: ProvenanceFailureReason;
    let ok = false;
    if (!record) {
      reason = "unknown-source";
    } else {
      const normalized = canonicalizeTracedUnit(number.unit, number.currency);
      if (normalized === null) {
        reason = "unit-mismatch";
      } else {
        // Tolerate an OMITTED optional dimension the payload never gave the model
        // a way to cite: `period` is derived from a figure LABEL and is never
        // rendered as a citable tag, and most monetary figures render with the
        // generic unit "currency" and NO ISO code in the prompt. When the model
        // drops one, adopt the record's value — the registry id already pins the
        // exact record (and hence its period/currency). A SUPPLIED-but-wrong
        // period or currency still mismatches, so a genuine error is not masked.
        const period = number.period ?? record.period;
        const currency = normalized.currency ?? record.currency;
        const match = matchProvenanceRecord(
          {
            value: number.value,
            unit: normalized.unit,
            currency,
            period,
            asOf: sourceAsOf ?? "",
            source: sourceId ?? "",
          },
          registry,
        );
        ok = match.ok;
        reason = match.ok ? "unknown-source" : match.reason;
      }
    }
    number.verified = ok;
    const traceKind: NonNullable<VerificationLogEntry["traceKind"]> = !ok
      ? "untraced"
      : record?.kind === "computed"
        ? "computed-derived"
        : "payload-match";
    const renderedCitation = sourceId === null
      ? "[unsupported citation]"
      : serializeCitationRef({ sourceId, asOf: sourceAsOf });
    const rendered = `${number.value} ${number.unit} ${renderedCitation}`;
    if (ok) {
      traced += 1;
      log.push({
        claim: rendered,
        outcome: "verified",
        note: "exact provenance record matched",
        traceKind,
        path,
        evidenceKind: "number",
        source: sourceId ?? number.source,
        reason: "supported",
      });
    } else {
      appendUnverifiedNote(number, reason);
      log.push({
        claim: rendered,
        outcome: "unverified",
        note: `[unverified] ${reason}`,
        traceKind,
        path,
        evidenceKind: "number",
        source: sourceId ?? number.source,
        reason,
      });
    }
  }

  let factualSupported = 0;
  let factualTotal = 0;
  let judgmentsCited = 0;
  let judgmentsTotal = 0;
  for (const { claim, path } of claims) {
    const sourceId = citationSourceId(claim);
    if (sourceId !== null) claim.sourceId = sourceId;
    const match = claimSourceMatch(claim, registry, citationRegistry, fetchedUrls);
    const supported = match.supported;
    const judgment = claim.label === "JUDGMENT";
    if (judgment) {
      judgmentsTotal += 1;
      if (supported) judgmentsCited += 1;
    } else {
      factualTotal += 1;
      if (supported) factualSupported += 1;
    }
    const registryRecord = sourceId === null
      ? undefined
      : registry.find((record) => record.id === sourceId);
    log.push({
      claim: claim.text,
      outcome: supported ? "verified" : "unverified",
      note: supported ? "citation observed" : `[unverified] ${match.reason}`,
      traceKind: supported
        ? registryRecord?.kind === "computed"
          ? "computed-derived"
          : registryRecord
            ? "payload-match"
            : "source-cited"
        : "untraced",
      path,
      evidenceKind: judgment ? "judgment" : "factual-claim",
      source: sourceId ?? claim.source,
      reason: match.reason,
    });
  }

  const total = numbers.length;
  const numeric = calculateCoverage(traced, total);
  const factualClaims = calculateCoverage(factualSupported, factualTotal);
  const judgmentRate = calculateCoverage(judgmentsCited, judgmentsTotal);
  const coverage: ProvenanceCoverage = {
    numeric,
    factualClaims,
    judgments: {
      cited: judgmentRate.supported,
      total: judgmentRate.total,
      rate: judgmentRate.rate,
    },
  };

  // NOTE: an optional model-side pass (VERIFY_MODEL) used to run here, but it
  // DISCARDED its output entirely — the deterministic trace above is, and always
  // was, the sole authority for `verified`/the rate — so it only spent tokens
  // (whose cost wasn't even captured, since the runPass return was ignored).
  // Removed as pure waste. A future REAL verification (dereference the payload
  // path or re-fetch the cited number — see the runVerifyPass docstring) would
  // slot in here and actually feed back into the report.

  return {
    verifiedReport,
    verificationRate: numeric.rate,
    coverage,
    log,
    traced,
    total,
  };
}

/* ------------------------------------------------------------------------ *
 * assembleReport — wrap JudgeOutput with meta + appendix, validate
 * ------------------------------------------------------------------------ */

export interface AssembleReportArgs {
  symbol: string;
  bundle: DataBundle;
  computed: ComputedMetrics;
  judgeOutput: JudgeOutput;
  verify: {
    verificationRate: number | null;
    /** Omitted only by legacy/test callers; generation passes explicit coverage. */
    coverage?: ProvenanceCoverage;
    log: VerificationLogEntry[];
  };
  costEntries: CostBreakdownEntry[];
  model: string;
  /** Pipeline version stamped into meta (SPEC §2). Defaults to REPORT_SPEC_VERSION. */
  pipelineVersion?: string;
  /**
   * Stage A validation gaps (balance-sheet identity breaks, FMP↔XBRL
   * disagreements, stale-fundamentals flags). Merged into the appendix
   * missing-data manifest so the rendered report discloses exactly what the
   * prompt was told (H4) — the prompt already merges these via
   * assembleContextPayload. Optional so stand-in callers (verify stand-in) omit.
   */
  validationGaps?: ManifestEntry[];
}

/** Sum a cost-breakdown into a single total. */
export function totalCost(entries: CostBreakdownEntry[]): number {
  return entries.reduce((acc, e) => acc + e.costUsd, 0);
}

/**
 * Build the appendix source list from the bundle's asOf map — one entry per
 * provider dot-path with its as-of. Deterministically ordered (by field).
 */
export function buildSources(bundle: DataBundle): SourceEntry[] {
  const out: SourceEntry[] = [];
  for (const field of Object.keys(bundle.asOf).sort()) {
    const asOf = bundle.asOf[field];
    // provider = first dot-path segment mapped to a coarse provider label.
    const provider = providerOf(field);
    out.push({ provider, endpoint: field, asOf, fetchedAt: asOf });
  }
  return out;
}

/** Map a bundle dot-path to a coarse provider label for the appendix. */
function providerOf(field: string): string {
  if (field.startsWith("edgar") || field.includes("edgar")) return "edgar";
  if (field.startsWith("macro") || field.includes("fred") || field.includes("treasury")) return "fred";
  if (field.startsWith("shortInterest")) return "finra";
  if (field.startsWith("insiderSentiment")) return "finnhub";
  return "fmp";
}

/**
 * The as-of map for meta: bundle asOf plus the report generation stamp. NOTE:
 * `generatedAt` on meta is a wall-clock time — assembleReport is the ONE place a
 * timestamp is allowed, because the report object is persisted, not cached. The
 * PAYLOAD stays clock-free; only the final Report meta carries generation time.
 */
function buildAsOfMap(bundle: DataBundle): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(bundle.asOf).sort()) out[k] = bundle.asOf[k];
  return out;
}

/**
 * Wrap a JudgeOutput with meta + appendix into a full Report, then validate the
 * whole thing against ReportSchema. Throws {@link ReportValidationError} (with
 * the Zod error) on failure so the runner can retry the judge with the error fed
 * back (max 2 retries, SPEC §2).
 *
 * `generatedAt` is provided injectably for deterministic tests; production omits
 * it and gets the current time (the only clock read in Stage C, on the persisted
 * report — never on the cached payload).
 */
/**
 * Overwrite each scenario's priceTarget with the DETERMINISTIC computed target
 * (Stage B {@link computeScenarioTargets}; 2026-07-11 scenario-credibility
 * checkpoint), so the judge/LLM number can never control the headline. A scenario
 * with no available computed target — the block is `suppressed`/absent, or that
 * scenario's per-share is null — gets `priceTarget: null` (a target is SUPPRESSED,
 * never fabricated). The judge's scenario NARRATIVE (probability, assumptions,
 * whatWouldHaveToBeTrue) is preserved verbatim. Pure; returns a new valuation.
 */
export function applyScenarioTargets(
  valuation: JudgeOutput["valuation"],
  scenarioTargets: ScenarioTargets | undefined,
): JudgeOutput["valuation"] {
  const byName = new Map<string, TracedNumber | null>();
  if (scenarioTargets && scenarioTargets.status === "available") {
    for (const t of scenarioTargets.targets) byName.set(t.name, t.perShare);
  }
  return {
    ...valuation,
    scenarios: valuation.scenarios.map((s) => ({
      ...s,
      priceTarget: byName.get(s.name) ?? null,
    })),
  };
}

/**
 * Overwrite valuation.dcf.perShare + upsidePct with the DETERMINISTIC fair value
 * (Stage B {@link computeFairValue}; 2026-07-11 DCF-credibility checkpoint) so the
 * judge/LLM cannot author the headline intrinsic value. When the block is absent /
 * suppressed, both are nulled — a fair value is SUPPRESSED, never fabricated. The
 * judge's dcf.assumptions display list + sensitivityGrid + reverse-DCF narrative
 * are preserved verbatim. Pure; returns a new valuation.
 */
export function applyFairValue(
  valuation: JudgeOutput["valuation"],
  fairValue: FairValue | undefined,
): JudgeOutput["valuation"] {
  const available = fairValue !== undefined && fairValue.status === "available";
  return {
    ...valuation,
    dcf: {
      ...valuation.dcf,
      perShare: available ? fairValue.perShare : null,
      upsidePct: available ? fairValue.upsidePct : null,
    },
  };
}

/**
 * Overwrite valuation.dcf.assumptions + sensitivityGrid with the DETERMINISTIC
 * Stage B display (computeDcfDisplay; 2026-07-11 valuation-consistency checkpoint)
 * so the valuation card shows the real computed inputs, never judge-transcribed
 * ones. Empty for routes with no FCFF DCF (excess-return / REIT / pre-revenue /
 * suppressed) — nothing is fabricated. The judge keeps the reverse-DCF narrative
 * and the section interpretation. Pure; returns a new valuation. If the computed
 * valuation is absent (verify stand-in path), leaves the judge's values untouched.
 */
export function applyDcfDisplay(
  valuation: JudgeOutput["valuation"],
  computedValuation: ComputedMetrics["valuation"] | undefined,
): JudgeOutput["valuation"] {
  if (computedValuation === undefined) return valuation;
  const display = computeDcfDisplay(computedValuation);
  return {
    ...valuation,
    dcf: {
      ...valuation.dcf,
      assumptions: display.assumptions,
      sensitivityGrid: display.sensitivityGrid,
    },
  };
}

/**
 * Fixed human labels for the multiples table, one per Stage B {@link MultipleKey}
 * (matches the P/E · EV/EBITDA · P/FFO naming used across sectorRouting notes
 * and the UI). Exported so tests and renderers can rely on the exact strings.
 */
export const MULTIPLE_LABELS: Record<MultipleKey, string> = {
  peTtm: "P/E (TTM)",
  evToEbitda: "EV/EBITDA",
  evToSales: "EV/Sales",
  priceToFcf: "P/FCF",
  priceToBook: "P/B",
  priceToTbv: "P/TBV",
  priceToFfo: "P/FFO",
  priceToAffo: "P/AFFO",
};

/**
 * Replace the judge's valuation.multiples rows WHOLESALE with rows derived from
 * the DETERMINISTIC Stage B multiples framework (2026-07 invariant-1 hardening):
 * current / peer median / own-5y percentile / sector-appropriate flag all come
 * from computed numbers, never from LLM transcription. Pre-revenue routes
 * (multiples === null) or an absent computed valuation (verify stand-in) yield
 * an EMPTY table — rows are never fabricated and judge rows never survive.
 * Pure; returns a new valuation.
 */
export function applyMultiples(
  valuation: JudgeOutput["valuation"],
  computedValuation: ComputedMetrics["valuation"] | undefined,
): JudgeOutput["valuation"] {
  const mr = computedValuation?.multiples ?? null;
  const rows =
    mr === null
      ? []
      : mr.multiples.map((stat) => ({
          name: MULTIPLE_LABELS[stat.key],
          current: stat.current,
          peerMedian: stat.peers?.median ?? null,
          own5yPercentile: stat.ownHistory?.percentileRank ?? null,
          sectorAppropriate: mr.sectorAppropriate.includes(stat.key),
        }));
  return { ...valuation, multiples: rows };
}

/**
 * Overwrite reverseDcf.impliedMetric + impliedValue with the DETERMINISTIC
 * Stage B reverse-DCF solve (2026-07 invariant-1 hardening). The metric label
 * names exactly what the solver inverted: method "growth" solved the constant
 * explicit-horizon revenue growth that justifies the price; method "margin"
 * solved the terminal EBIT margin (fallback mode). Method "none", a non-DCF
 * route, or an absent computed valuation → "n/a" + null (suppressed, never
 * fabricated). The judge's `narrative` prose is ALWAYS preserved verbatim.
 * Pure; returns a new valuation.
 */
export function applyReverseDcf(
  valuation: JudgeOutput["valuation"],
  computedValuation: ComputedMetrics["valuation"] | undefined,
): JudgeOutput["valuation"] {
  let impliedMetric = "n/a";
  let impliedValue: number | null = null;
  if (
    computedValuation !== undefined &&
    computedValuation.kind === "dcf" &&
    computedValuation.reverseDcf !== null
  ) {
    const r = computedValuation.reverseDcf;
    if (r.method === "growth") {
      impliedMetric = "constant revenue growth (explicit horizon)";
      impliedValue = r.impliedRevenueGrowthPct;
    } else if (r.method === "margin") {
      impliedMetric = "terminal EBIT margin";
      impliedValue = r.impliedTerminalMarginPct;
    }
  }
  return {
    ...valuation,
    reverseDcf: { ...valuation.reverseDcf, impliedMetric, impliedValue },
  };
}

/**
 * Overwrite the four quality.forensicScores blocks with the DETERMINISTIC Stage
 * B forensics (2026-07 invariant-1 hardening): Altman variant/score/zone,
 * Beneish M + verdict, Piotroski F out-of-N, and the cash-flow accruals ratio +
 * house-rule band. The judge's `notApplicableReason` prose is PRESERVED exactly
 * when the computed counterpart is null (it explains why the score is missing/
 * suppressed) and DROPPED when a computed score exists. Altman's variant falls
 * back selection → judge string only when the computed layer is truly absent.
 * Pure; returns a new quality section (flags/graded untouched).
 */
export function applyForensicScores(
  quality: JudgeOutput["quality"],
  forensics: ComputedMetrics["forensics"] | undefined,
): JudgeOutput["quality"] {
  const j = quality.forensicScores;
  const keepReason = (
    judgeReason: string | undefined,
    computedScore: number | null,
  ): { notApplicableReason?: string } =>
    computedScore === null && judgeReason !== undefined
      ? { notApplicableReason: judgeReason }
      : {};

  const altmanScore = forensics?.altman?.score ?? null;
  const altman = {
    variant:
      forensics?.altman?.variant ?? forensics?.altmanSelection.variant ?? j.altman.variant,
    score: altmanScore,
    zone: forensics?.altman?.zone ?? null,
    ...keepReason(j.altman.notApplicableReason, altmanScore),
  };

  const beneishScore = forensics?.beneish?.score ?? null;
  const beneish = {
    variant: "m-score",
    score: beneishScore,
    zone: forensics?.beneish?.verdict ?? null,
    ...keepReason(j.beneish.notApplicableReason, beneishScore),
  };

  const piotroskiScore = forensics?.piotroski?.score ?? null;
  const piotroski = {
    variant: "f-score",
    score: piotroskiScore,
    zone:
      forensics?.piotroski && piotroskiScore !== null
        ? `${piotroskiScore}/${forensics.piotroski.outOf}`
        : null,
    ...keepReason(j.piotroski.notApplicableReason, piotroskiScore),
  };

  // PRIMARY accruals construction (Hribar–Collins cash-flow ratio) + its
  // house-rule band — the same pair Stage B leads with.
  const accrualsScore = forensics?.accruals?.cashFlowAccrualRatio ?? null;
  const accruals = {
    variant: "cash-flow",
    score: accrualsScore,
    zone: forensics?.accruals?.band ?? null,
    ...keepReason(j.accruals.notApplicableReason, accrualsScore),
  };

  return { ...quality, forensicScores: { altman, beneish, piotroski, accruals } };
}

/**
 * Sum the LATEST period's as-reported segment values from one bundle
 * segmentation feed (rows arrive newest-first; mirrors payload.ts
 * segmentsSection, which renders exactly rows[0] to the LLM — numerator and
 * denominator therefore come from the same period the judge saw). Returns null
 * when the feed is a gap, empty, or sums to a non-positive total.
 */
function latestSegmentationTotal(
  res: DataBundle["segmentation"]["product"] | undefined,
): number | null {
  if (res === undefined || !res.ok || !res.value) return null;
  const data = res.value.data.rows[0]?.data;
  if (data === undefined || data === null || typeof data !== "object") return null;
  let total = 0;
  let counted = 0;
  for (const key of Object.keys(data)) {
    const v = data[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      total += v;
      counted++;
    }
  }
  return counted > 0 && total > 0 ? total : null;
}

/**
 * Overwrite every business.segments row's sharePct DETERMINISTICALLY (2026-07
 * invariant-1 hardening): sharePct = segment traced revenue ÷ the sum of the
 * latest-period bundle segmentation values × 100, rounded to 1 decimal —
 * product rows divide by the product-segmentation total, geographic rows by
 * the geographic total. When the bundle feed is unavailable the share is null
 * (disclosed as n/a, never fabricated). The judge-emitted sharePct is ALWAYS
 * discarded; the row's name + traced revenue stay judge-authored (and the
 * revenue TracedNumber remains subject to the verify pass). Pure; returns a
 * new business section.
 */
export function applySegmentShares(
  business: JudgeOutput["business"],
  bundle: DataBundle | undefined,
): JudgeOutput["business"] {
  const share = (revenueValue: number, total: number | null): number | null => {
    if (total === null) return null;
    const pct = (revenueValue / total) * 100;
    return Number.isFinite(pct) ? Math.round(pct * 10) / 10 : null;
  };
  const productTotal = latestSegmentationTotal(bundle?.segmentation?.product);
  const geographicTotal = latestSegmentationTotal(bundle?.segmentation?.geographic);
  return {
    ...business,
    segments: {
      product: business.segments.product.map((row) => ({
        ...row,
        sharePct: share(row.revenue.value, productTotal),
      })),
      geographic: business.segments.geographic.map((row) => ({
        ...row,
        sharePct: share(row.revenue.value, geographicTotal),
      })),
    },
  };
}

export function assembleReport(args: AssembleReportArgs, generatedAt?: string): Report {
  const companyName = firstProfileName(args.bundle) ?? args.symbol;
  const coverage: ProvenanceCoverage = args.verify.coverage ?? {
    numeric: { supported: 0, total: 0, rate: null },
    factualClaims: { supported: 0, total: 0, rate: null },
    judgments: { cited: 0, total: 0, rate: null },
  };

  const missingData = dedupManifest([
    ...args.bundle.gaps,
    ...args.computed.gaps,
    ...(args.validationGaps ?? []),
    ...degradationDisclosures(args.computed.degradation),
  ]);

  const meta: ReportMeta = {
    symbol: args.symbol,
    companyName,
    generatedAt: generatedAt ?? new Date().toISOString(),
    specVersion: REPORT_SPEC_VERSION,
    model: args.model,
    pipelineVersion: args.pipelineVersion ?? REPORT_SPEC_VERSION,
    costUsd: totalCost(args.costEntries),
    verificationRate: args.verify.verificationRate,
    provenanceCoverage: coverage,
    dataCompleteness: buildDataCompleteness(missingData),
    execution: args.costEntries.map((entry) =>
      buildExecutionMetadataEntry({
        step: entry.step,
        requestedModel: entry.requestedModel ?? entry.model,
        effectiveModel: entry.model,
        requestedEffort: entry.requestedEffort ?? null,
        fallbackUsed: entry.fallbackUsed ?? false,
      }),
    ),
    disclaimer: DISCLAIMER_TEXT,
    asOfMap: buildAsOfMap(args.bundle),
  };

  // Missing-data manifest = computed gaps + Stage A validation gaps + Stage B
  // degradation disclosures. dedupManifest flattens+dedups by field|reason and
  // applies the same severity ordering as the payload's mergeManifest, so this
  // is a superset-equal of what the prompt disclosed (H4/L7): the rendered
  // report can never be less transparent than the LLM's own input.
  const appendix: Appendix = {
    sources: buildSources(args.bundle),
    missingData,
    verificationRate: args.verify.verificationRate,
    provenanceCoverage: coverage,
    verificationLog: args.verify.log,
    costBreakdown: args.costEntries,
  };

  // Deterministic scenario price targets + DCF fair value overwrite the judge's
  // (or null them when suppressed) so the LLM never authors the headline numbers
  // (2026-07-11 checkpoints). The blocks are attached for their trace/basis/reasons.
  // 2026-07 invariant-1 hardening extends the same pattern to the remaining
  // judge-path numerics: multiples rows, the reverse-DCF implied value, forensic
  // scores, and segment revenue shares are all computed-injected below. The one
  // remaining LLM-authored bare numeric is leadership.executives[].tenureYears —
  // biographical (not financial) and grounded in the payload's titleSince dates.
  const scenarioTargets = args.computed.scenarioTargets;
  const fairValue = args.computed.fairValue;
  const valuation = applyReverseDcf(
    applyMultiples(
      applyDcfDisplay(
        applyFairValue(
          applyScenarioTargets(args.judgeOutput.valuation, scenarioTargets),
          fairValue,
        ),
        args.computed.valuation,
      ),
      args.computed.valuation,
    ),
    args.computed.valuation,
  );
  const quality = applyForensicScores(args.judgeOutput.quality, args.computed.forensics);
  const business = applySegmentShares(args.judgeOutput.business, args.bundle);

  const candidate: Report = {
    meta,
    verdict: args.judgeOutput.verdict,
    business,
    fundamentals: args.judgeOutput.fundamentals,
    balanceSheet: args.judgeOutput.balanceSheet,
    valuation,
    quality,
    technicals: args.judgeOutput.technicals,
    leadership: args.judgeOutput.leadership,
    competitive: args.judgeOutput.competitive,
    catalystsRisks: args.judgeOutput.catalystsRisks,
    outlook: args.judgeOutput.outlook,
    macro: args.judgeOutput.macro,
    appendix,
    disagreements: args.judgeOutput.disagreements,
    // Deterministic scores + projections + scenario targets (pipeline-filled from
    // Stage B). Optional in the schema, so a MINIMAL_COMPUTED stand-in (undefined)
    // parses cleanly.
    ...(args.computed.scores ? { scores: args.computed.scores } : {}),
    ...(args.computed.projections ? { projections: args.computed.projections } : {}),
    ...(scenarioTargets ? { scenarioTargets } : {}),
    ...(fairValue ? { fairValue } : {}),
  };

  const parsed = ReportSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ReportValidationError(
      `assembled report failed ReportSchema validation`,
      parsed.error.message,
    );
  }
  return parsed.data;
}

function firstProfileName(bundle: DataBundle): string | null {
  if (!bundle.profile.ok) return null;
  const row = bundle.profile.value.data.rows[0];
  const name = row?.companyName;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** Dedup + severity-order manifest entries for the appendix (stable). */
function dedupManifest(entries: ManifestEntry[]): ManifestEntry[] {
  const seen = new Map<string, ManifestEntry>();
  for (const e of entries) {
    const key = `${e.field}|${e.reason}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  const order: Record<ManifestEntry["severity"], number> = { critical: 0, warn: 1, info: 2 };
  return [...seen.values()].sort((a, b) => {
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    if (a.field !== b.field) return a.field < b.field ? -1 : 1;
    return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
  });
}

/**
 * Run the judge pass with automatic retry on ReportSchemaZod failure (SPEC §2).
 * On a validation failure, re-runs the judge with the Zod error appended to the
 * user turn (max {@link MAX_JUDGE_RETRIES} extra attempts), then fails loudly.
 *
 * Returns the assembled Report on success, or a gap on hard failure (keyless /
 * refusal / retries exhausted) so the orchestrator never crashes.
 */
export interface JudgeAndAssembleResult {
  ok: boolean;
  report?: Report;
  judgePass?: PassResult<JudgeOutput>;
  verify?: VerifyResult;
  gap?: ManifestEntry;
  error?: PassErrorLike | { kind: "validation"; message: string };
  attempts: number;
}

export async function runJudgeVerifyAssemble(
  deps: PassDeps,
  payload: ContextPayload,
  bull: AnalystCase,
  bear: AnalystCase,
  assemble: Omit<AssembleReportArgs, "judgeOutput" | "verify" | "model" | "costEntries"> & {
    /** Cost entries for bull/bear so far; judge/verify costs are appended. */
    priorCostEntries: CostBreakdownEntry[];
  },
  generatedAt?: string,
): Promise<JudgeAndAssembleResult> {
  let lastZodError: string | null = null;
  let lastRawOutput: string | null = null;

  for (let attempt = 0; attempt <= MAX_JUDGE_RETRIES; attempt++) {
    const baseTurns = judgeUserTurns(payload, bull, bear);
    const userTurns: { role: "user" | "assistant"; content: string | RunPassContentBlock[] }[] =
      lastZodError === null
        ? baseTurns
        : [
            ...baseTurns,
            {
              role: "user" as const,
              content: judgeRetryFeedback(lastZodError, lastRawOutput ?? undefined),
            },
          ];

    const judgeRun = await runStructuredPass<JudgeOutput>({
      deps,
      system: SHARED_RULES_BLOCK,
      userTurns,
      parse: parseJudgeOutput,
      maxTokens: JUDGE_MAX_TOKENS,
      useWebSearch: false,
      model: judgeModelFor(deps.model),
      field: "llm.judge",
    });

    if (!judgeRun.ok) {
      // A schema-validation failure of received output is RETRYABLE (feed the
      // error back). A transport/no-key failure is not — short-circuit.
      if (judgeRun.validationError !== undefined) {
        lastZodError = judgeRun.validationError;
        lastRawOutput = judgeRun.rawText ?? null;
        if (attempt < MAX_JUDGE_RETRIES) continue;
        break;
      }
      return { ok: false, gap: judgeRun.gap, error: judgeRun.error, attempts: attempt + 1 };
    }

    const unresolvedEntities = unresolvedJudgeEntityConflicts(
      payload,
      bull,
      bear,
      judgeRun.result.output,
    );
    if (unresolvedEntities.length > 0) {
      const entityFailure = entityConflictFailure(judgeRun.result, unresolvedEntities);
      if (!entityFailure.ok) {
        lastZodError = entityFailure.validationError ?? entityFailure.error.message;
        lastRawOutput = entityFailure.rawText ?? null;
        if (attempt < MAX_JUDGE_RETRIES) continue;
        break;
      }
    }

    const verify = await runVerifyPass(deps, payload, judgeRun.result.output);

    const costEntries: CostBreakdownEntry[] = [
      ...assemble.priorCostEntries,
      {
        step: "synthesize",
        model: judgeRun.result.model,
        costUsd: judgeRun.result.costUsd,
        requestedModel: deps.model,
        requestedEffort: deps.effort ?? "high",
        effectiveEffort: buildExecutionMetadataEntry({
          step: "synthesize",
          requestedModel: deps.model,
          effectiveModel: judgeRun.result.model,
          requestedEffort: deps.effort ?? "high",
          fallbackUsed: judgeRun.result.fallbackUsed,
        }).effectiveEffort,
        fallbackUsed: judgeRun.result.fallbackUsed,
        adjustments: buildExecutionMetadataEntry({
          step: "synthesize",
          requestedModel: deps.model,
          effectiveModel: judgeRun.result.model,
          requestedEffort: deps.effort ?? "high",
          fallbackUsed: judgeRun.result.fallbackUsed,
        }).adjustments,
      },
    ];

    try {
      const report = assembleReport(
        {
          symbol: assemble.symbol,
          bundle: assemble.bundle,
          computed: assemble.computed,
          judgeOutput: verify.verifiedReport,
          // Thread the coverage triplet through so meta/appendix.provenanceCoverage
          // reflect the real measured provenance instead of being zeroed next to a
          // genuine verificationRate.
          verify: { verificationRate: verify.verificationRate, coverage: verify.coverage, log: verify.log },
          costEntries,
          model: deps.model,
          pipelineVersion: assemble.pipelineVersion,
          validationGaps: assemble.validationGaps,
        },
        generatedAt,
      );
      return { ok: true, report, judgePass: judgeRun.result, verify, attempts: attempt + 1 };
    } catch (e) {
      if (e instanceof ReportValidationError) {
        lastZodError = e.zodError;
        lastRawOutput = JSON.stringify(judgeRun.result.output);
        continue; // retry the judge with the error + previous output fed back
      }
      throw e; // programming error — surface it
    }
  }

  return {
    ok: false,
    gap: {
      field: "llm.judge",
      reason: `judge output failed report-schema validation after ${MAX_JUDGE_RETRIES + 1} attempts: ${lastZodError ?? "unknown"}`,
      severity: "critical",
      attemptedSources: ["anthropic"],
    },
    error: { kind: "validation", message: lastZodError ?? "validation failed" },
    attempts: MAX_JUDGE_RETRIES + 1,
  };
}

/* ------------------------------------------------------------------------ *
 * assembleContextPayload re-export convenience (Stage C entrypoint helpers)
 * ------------------------------------------------------------------------ */

export { assembleContextPayload, serializePayloadForPrompt, payloadFingerprint };

/* ------------------------------------------------------------------------ *
 * MockRunPass — drive the passes in tests + the keyless dry-run path
 * ------------------------------------------------------------------------ */

/** A queued mock response: a structured JSON output, RAW text, or a typed failure. */
export type MockResponse =
  | { kind: "json"; value: unknown; costUsd?: number; webSearches?: number; fetchedUrls?: string[]; model?: string; fallbackUsed?: boolean }
  | { kind: "text"; text: string; costUsd?: number; webSearches?: number; fetchedUrls?: string[]; model?: string; fallbackUsed?: boolean }
  | { kind: "error"; error: PassErrorLike; gap?: ManifestEntry };

/**
 * A MockRunPass drives {@link RunPassFn} without a live API. Responses are
 * matched by the request's `field` (so bull/bear/judge/verify get the right
 * output) with a FIFO fallback queue for unmatched fields. Records every call
 * for assertions.
 */
export class MockRunPass {
  readonly calls: RunPassArgs[] = [];
  private readonly byField = new Map<string, MockResponse[]>();
  private readonly queue: MockResponse[] = [];

  /** Queue a response for a specific pass field (e.g. "llm.bull"). */
  on(field: string, resp: MockResponse): this {
    const list = this.byField.get(field) ?? [];
    list.push(resp);
    this.byField.set(field, list);
    return this;
  }

  /** Queue a fallback response (used when no field-specific response remains). */
  enqueue(resp: MockResponse): this {
    this.queue.push(resp);
    return this;
  }

  /** Convenience: queue a JSON output for a field. */
  onJson(field: string, value: unknown, over: Partial<Extract<MockResponse, { kind: "json" }>> = {}): this {
    return this.on(field, { kind: "json", value, ...over });
  }

  /** Convenience: queue RAW response text (unparseable/malformed-output cases). */
  onText(field: string, text: string, over: Partial<Extract<MockResponse, { kind: "text" }>> = {}): this {
    return this.on(field, { kind: "text", text, ...over });
  }

  /** The injectable RunPassFn. */
  readonly runPass: RunPassFn = async (args) => {
    this.calls.push(args);
    const field = args.field ?? "";
    const list = this.byField.get(field);
    const resp = (list && list.shift()) ?? this.queue.shift();
    if (!resp) {
      return {
        ok: false,
        gap: { field, reason: `MockRunPass: no response queued for ${field}`, severity: "critical" },
        error: { kind: "refusal", message: `no mock response for ${field}` },
      };
    }
    if (resp.kind === "error") {
      return {
        ok: false,
        gap: resp.gap ?? { field, reason: resp.error.message, severity: "critical" },
        error: resp.error,
      };
    }
    const usage: PassUsage = {
      input_tokens: 1000,
      output_tokens: 1000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: resp.webSearches ? { web_search_requests: resp.webSearches } : null,
    };
    const message: PassMessage = {
      content: [
        { type: "text", text: resp.kind === "text" ? resp.text : JSON.stringify(resp.value) },
      ],
      usage,
      model: resp.model ?? args.model,
      stop_reason: "end_turn",
    };
    return {
      ok: true,
      value: {
        data: {
          message,
          fetchedUrls: resp.fetchedUrls ?? [],
          usage,
          costUsd: resp.costUsd ?? 0,
          fallbackUsed: resp.fallbackUsed ?? false,
          model: resp.model ?? args.model,
        },
      },
    };
  };

  /** A streaming runner backed by the same queue (firstToken resolves immediately). */
  readonly runPassStreaming: RunPassStreamingFn = (args) => {
    const result = this.runPass(args);
    return { firstToken: Promise.resolve("streamEvent"), result };
  };
}
