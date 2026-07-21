/**
 * Stage C job runner — orchestrates the full report pipeline (the application contract §5):
 *
 *   fetch → validate → compute → bull → bear → synthesize → verify
 *
 * (PIPELINE_STEPS from @/types/core, deterministic order.) After every step
 * transition it persists jobs.stepsJson (StepProgress[]) and emits a
 * "step-update" over the events bus; every LLM pass writes a cost_log row and
 * emits a "cost-update". On success it validates + persists the Report and
 * sets jobs.reportId + status "done"; on hard failure it records the error and
 * emits "error".
 *
 * Degrades gracefully with NO Anthropic key: runs fetch/validate/compute, marks
 * the four LLM steps "skipped" (reason "ANTHROPIC_API_KEY not configured"), and
 * persists a data-only Report stub (meta + appendix + empty graded sections
 * flagged) so the UI always has something to render. Missing data NEVER throws
 * (the application contract §3, non-negotiable rule #4); a failed LLM step marks that step
 * "error" with detail and the runner still persists what it has.
 *
 * The Stage C passes (bull/bear/judge/verify + payload/report assembly) are
 * injected as a {@link PipelinePasses} bundle so this module does NOT import
 * src/pipeline/stageC/passes.ts at build time (keeps tsc green while a parallel
 * agent builds it; the integrator wires the real implementation in). The
 * interface uses loose/structural types — Report/JudgeOutput/AnalystCase come
 * from @/report/schema (which exists); ContextPayload/PassResult are generic so
 * there is no hard dependency on the passes module's concrete shapes.
 *
 * Server-only (imports @/db, @/config/env, @/providers/anthropic transitively
 * via settings/model resolution). Never import from a client component.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, notInArray } from "drizzle-orm";
import { getDb } from "@/db";
import { costLog, jobs, reports } from "@/db/schema";
import { getConfig } from "@/config/env";
import { resolveModel } from "@/providers/anthropic";
import {
  getAnalysisEffortSetting,
  getAnalysisModelSetting,
  type EffortLevel,
} from "@/settings/settings";
import {
  PIPELINE_STEPS,
  type ManifestEntry,
  type PipelineStep,
  type StepProgress,
} from "@/types/core";
import {
  ANALYST_CASE_SCHEMA,
  DISCLAIMER_TEXT,
  FRED_ATTRIBUTION_TEXT,
  REPORT_SPEC_VERSION,
  ReportSchema,
  type Report,
  type AnalystCase,
  type JudgeOutput,
  type ProvenanceCoverage,
  type ExecutionMetadataEntry,
} from "@/report/schema";
import { buildDataCompleteness } from "@/report/completeness";
import { buildExecutionMetadataEntry } from "@/report/execution";
import { buildDataBundle, type BuildDataBundleOptions } from "@/pipeline/dataBundle";
import { runStageB, type ComputedMetrics } from "@/pipeline/compute";
import { validateBundle, type ValidationReport } from "@/pipeline/stageA/validate";
import type { DataBundle } from "@/pipeline/types";
import { canonicalizeFetchedUrl } from "@/pipeline/stageC/provenance";
import { parseStepsJson, publishJobEvent, type JobEvent } from "@/pipeline/events";

/* ------------------------------------------------------------------------ *
 * PipelinePasses — injected Stage C contract (loose/structural types)
 * ------------------------------------------------------------------------ */

/**
 * Structural view of one LLM pass's result that the runner needs for cost
 * logging + running-total accounting. The real passes module returns a richer
 * object (its own PassResult<T>); this is the subset the runner reads. `data`
 * is the parsed structured output (AnalystCase / JudgeOutput / …). Everything
 * cost-related is optional so a mock or a degraded pass can omit it.
 */
export interface PassResultLike<T> {
  /** The parsed structured output for this pass. */
  data: T;
  /** Model that actually served the response (fallback model when one served). */
  model: string;
  /** Cost of this pass, USD. */
  costUsd: number;
  /** True when a server-side refusal fallback served the response. */
  fallbackUsed: boolean;
  /** Token usage of the pass (drives cost_log token columns; optional). */
  usage?: PassUsageLike;
  /** Number of web searches billed on this pass (cost_log column). */
  webSearches?: number;
  /** Canonical URLs observed in successful web-search result blocks. */
  fetchedUrls?: string[];
}

/** Billed telemetry from a pass attempt that did not produce valid output. */
export interface BilledPassAttempt {
  model: string;
  costUsd: number;
  fallbackUsed: boolean;
  usage?: PassUsageLike;
  webSearches?: number;
}

/** Partial result/error payload for a combined bull+bear run. */
export interface BullBearPassFailureDetails {
  bull?: PassResultLike<AnalystCase>;
  bear?: PassResultLike<AnalystCase>;
  bullError?: string;
  bearError?: string;
  bullBilledAttempt?: BilledPassAttempt;
  bearBilledAttempt?: BilledPassAttempt;
}

/**
 * Thrown by the concrete Stage C adapter when one analyst side succeeded and
 * the other failed. The runner can then log costs and mark bull/bear statuses
 * independently instead of flattening both rows into one generic error.
 */
export class BullBearPassFailure extends Error {
  readonly bull?: PassResultLike<AnalystCase>;
  readonly bear?: PassResultLike<AnalystCase>;
  readonly bullError?: string;
  readonly bearError?: string;
  readonly bullBilledAttempt?: BilledPassAttempt;
  readonly bearBilledAttempt?: BilledPassAttempt;

  constructor(message: string, details: BullBearPassFailureDetails) {
    super(message);
    this.name = "BullBearPassFailure";
    this.bull = details.bull;
    this.bear = details.bear;
    this.bullError = details.bullError;
    this.bearError = details.bearError;
    this.bullBilledAttempt = details.bullBilledAttempt;
    this.bearBilledAttempt = details.bearBilledAttempt;
  }
}

/** Structural subset of the SDK usage object the runner logs to cost_log. */
export interface PassUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Dependencies threaded into every pass: the resolved models + the assembled,
 * deterministic context payload. Kept generic (`TPayload`) so the runner does
 * not depend on the passes module's ContextPayload shape.
 */
export interface PassDeps<TPayload = unknown> {
  analysisModel: string;
  /** One job-scoped cancellation/deadline signal shared by every provider pass. */
  signal?: AbortSignal;
  /**
   * `output_config.effort` for the passes (settings table → ANALYSIS_EFFORT
   * env → "high"). Optional so mocks/older callers omit it; the Stage C
   * adapter defaults to "high" when absent.
   */
  effort?: EffortLevel;
  payload: TPayload;
}

/** Result of the verification pass: a fully-traced Report + the rate + log. */
export interface VerifyPassResult {
  verifiedReport: Report;
  /** Fraction of traceable numbers verified, 0..1 (null when none to trace). */
  verificationRate: number | null;
  /** Explicit numeric/claim/judgment provenance metrics. */
  coverage?: ProvenanceCoverage;
  /** Cost of the verification pass, USD. */
  costUsd?: number;
  model?: string;
  fallbackUsed?: boolean;
  usage?: PassUsageLike;
  webSearches?: number;
  /** Verification-log entries (appendix.verificationLog on the final report). */
  log?: unknown;
}

/**
 * The Stage C pass bundle, dependency-injected into runJob(). A parallel agent
 * implements this in src/pipeline/stageC/passes.ts; the integrator passes an
 * instance in. Loose types by design — see the module JSDoc.
 */
export interface PipelinePasses<TPayload = unknown> {
  /**
   * Assemble the deterministic context payload (Stage B metrics + extracts +
   * transcript + filings + ownership + macro + manifest). No timestamps/UUIDs,
   * sorted keys (cache discipline — the cost model §2).
   */
  assembleContextPayload(
    bundle: DataBundle,
    computed: ComputedMetrics,
    validation: ValidationReport,
  ): TPayload;

  /**
   * Stable hash of the deterministic payload (optional — mocks may omit it).
   * Stored with the bull/bear snapshots so a resume can detect that the
   * underlying data drifted between the original run and the retry.
   */
  fingerprintPayload?(payload: TPayload): string;

  /**
   * Bull pass first, then bear (bull's first streamed token warms the cache
   * before bear fires — the cost model §2). Returns both analyst cases. The optional
   * hooks let the runner stamp REAL per-pass start/finish times — the passes
   * overlap in the streaming path, so timing cannot be inferred from around
   * the combined call.
   */
  runBullThenBear(
    deps: PassDeps<TPayload>,
    hooks?: AnalystPassHooks,
  ): Promise<{ bull: PassResultLike<AnalystCase>; bear: PassResultLike<AnalystCase> }>;

  /**
   * Run ONE analyst side (partial resume: the sibling's persisted snapshot is
   * being reused, so only the missing side is re-billed). No cache-sequencing
   * concern — a lone pass writes its own cache entry. Optional: mocks and the
   * noop facade may omit it; the resume path then requires both snapshots.
   * Throws (with a `billedAttempt` when the attempt billed) on failure, same
   * contract as runJudgePass.
   */
  runAnalystPass?(
    deps: PassDeps<TPayload>,
    side: "bull" | "bear",
  ): Promise<PassResultLike<AnalystCase>>;

  /** Judge/synthesis pass: bull + bear + payload → JudgeOutput (report minus meta/appendix). */
  runJudgePass(
    deps: PassDeps<TPayload>,
    bull: PassResultLike<AnalystCase>,
    bear: PassResultLike<AnalystCase>,
    validationFeedback?: string,
  ): Promise<PassResultLike<JudgeOutput>>;

  /** Verification pass: trace every numeric claim; returns the verified Report + rate. */
  runVerifyPass(
    deps: PassDeps<TPayload>,
    judgeOutput: JudgeOutput,
    evidence?: { fetchedUrls: string[] },
  ): Promise<VerifyPassResult>;

  /**
   * Assemble the final Report from the judge output + meta/appendix inputs. The
   * runner calls this to wrap the judge output when it needs a persistable
   * Report (the verify pass may also return one; the runner prefers the
   * verified report when present).
   */
  assembleReport(input: AssembleReportInput): Report;
}

/** Per-side lifecycle hooks for the combined bull+bear call (real timing). */
export interface AnalystPassHooks {
  onPassStart?: (side: "bull" | "bear") => void;
  onPassFinish?: (side: "bull" | "bear") => void;
}

/** Everything assembleReport() needs to wrap a JudgeOutput into a full Report. */
export interface AssembleReportInput {
  judgeOutput: JudgeOutput;
  bundle: DataBundle;
  computed: ComputedMetrics;
  validation: ValidationReport;
  meta: ReportMetaInput;
  verificationRate: number | null;
  verificationLog?: unknown;
  costBreakdown: { step: string; model: string; costUsd: number }[];
}

/** Meta fields the runner owns (symbol/model/cost/asOfMap) — the application contract §5. */
export interface ReportMetaInput {
  symbol: string;
  companyName: string;
  generatedAt: string;
  model: string;
  costUsd: number;
  verificationRate: number | null;
  asOfMap: Record<string, string>;
  execution?: ExecutionMetadataEntry[];
  runId?: string;
  startedAt?: string;
  completedAt?: string;
}

/* ------------------------------------------------------------------------ *
 * Public constants
 * ------------------------------------------------------------------------ */

/** pipelineVersion stamped into meta (bump when the orchestration changes). */
export const PIPELINE_VERSION = "stage-c-1.0.0" as const;

/** Reason recorded on skipped LLM steps when no Anthropic key is configured. */
export const NO_KEY_SKIP_REASON = "ANTHROPIC_API_KEY not configured" as const;

/** The four LLM steps (skipped as a block in the no-key path). */
export const LLM_STEPS: readonly PipelineStep[] = ["bull", "bear", "synthesize", "verify"] as const;

/**
 * Max judge retries on a report-schema (Zod) validation failure (SPEC §2:
 * "on validation failure, retry with the error fed back (max 2 retries), then
 * fail loudly"). Defined locally so the runner stays decoupled from
 * src/pipeline/stageC/passes.ts at build time (module JSDoc) — it mirrors the
 * passes module's MAX_JUDGE_RETRIES. Total judge attempts = 1 + this.
 */
export const MAX_JUDGE_RETRIES = 2 as const;

/** Reason recorded on skipped LLM steps when model resolution fails (Fix §1). */
export const MODEL_RESOLUTION_SKIP_PREFIX = "model resolution failed" as const;

/** Active jobs older than this are treated as abandoned and no longer block reruns. */
export const ACTIVE_JOB_STALE_MS = 30 * 60 * 1000;

/** Conservative hard limits: bound hangs without truncating normal deep analysis. */
export const DEFAULT_JOB_DEADLINE_MS = 90 * 60 * 1000;
export const DEFAULT_FETCH_DEADLINE_MS = 10 * 60 * 1000;
export const DEFAULT_MODEL_STAGE_DEADLINE_MS = 45 * 60 * 1000;

/** Job lifecycle statuses (owned by this module; jobs.status is free TEXT). */
export type JobStatus = "queued" | "running" | "done" | "error";

/* ------------------------------------------------------------------------ *
 * Step-progress bookkeeping
 * ------------------------------------------------------------------------ */

function nowIso(): string {
  return new Date().toISOString();
}

/** A fresh StepProgress[] with every pipeline step "pending". */
export function initialSteps(): StepProgress[] {
  return PIPELINE_STEPS.map((step) => ({ step, status: "pending" as const }));
}

/**
 * Mutable per-job orchestration state. Holds the live StepProgress[] and the
 * running cost so the runner can persist + publish after every transition
 * without re-reading the DB.
 */
interface RunState {
  jobId: string;
  symbol: string;
  startedAt: string;
  steps: StepProgress[];
  totalCostUsd: number;
}

function findStep(state: RunState, step: PipelineStep): StepProgress {
  const found = state.steps.find((s) => s.step === step);
  if (found === undefined) {
    // Programming error — PIPELINE_STEPS is fixed and initialSteps() covers all.
    throw new Error(`jobRunner: unknown pipeline step "${step}"`);
  }
  return found;
}

/** Persist the current StepProgress[] + updatedAt to the jobs row. */
function persistSteps(state: RunState, status?: JobStatus, error?: string | null): void {
  const set: Record<string, unknown> = {
    stepsJson: JSON.stringify(state.steps),
    updatedAt: nowIso(),
  };
  if (status !== undefined) set.status = status;
  if (error !== undefined) set.error = error;
  getDb().update(jobs).set(set).where(eq(jobs.id, state.jobId)).run();
}

/** Emit a step-update event for the given step's current state. */
function emitStep(state: RunState, step: PipelineStep): void {
  publish(state, {
    type: "step-update",
    jobId: state.jobId,
    step: { ...findStep(state, step) },
    steps: state.steps.map((s) => ({ ...s })),
  });
}

/** Publish an event through the bus (isolated so a bad subscriber can't break the run). */
function publish(_state: RunState, event: JobEvent): void {
  publishJobEvent(event);
}

/** Mark a step "running" (stamp startedAt), persist, and emit. */
function startStep(state: RunState, step: PipelineStep): void {
  const s = findStep(state, step);
  s.status = "running";
  s.startedAt = nowIso();
  delete s.completedAt;
  delete s.finishedAt;
  delete s.detail;
  persistSteps(state);
  emitStep(state, step);
}

/**
 * Mark a step terminal ("done" | "error" | "skipped"), persist, and emit.
 * A finishedAt already stamped by a pass-finish hook is preserved (real pass
 * timing beats bookkeeping timing); startStep clears it, so every fresh run
 * still gets a fresh stamp.
 */
function finishStep(
  state: RunState,
  step: PipelineStep,
  status: "done" | "error" | "skipped",
  detail?: string,
  costUsd?: number,
): void {
  const s = findStep(state, step);
  s.status = status;
  s.finishedAt ??= nowIso();
  s.completedAt = s.finishedAt;
  if (detail !== undefined) s.detail = detail;
  const logged = sumLoggedStepCost(state.jobId, step);
  if (costUsd !== undefined || logged > 0) {
    // A step may contain several billed attempts (judge retries, fallback
    // calls, or a partial-resume side). The cost log is authoritative; retain
    // the passed value only for hook-less callers that did not log a row.
    s.costUsd = logged > 0 ? logged : costUsd;
  }
  persistSteps(state);
  emitStep(state, step);
}

function sumLoggedStepCost(jobId: string, step: PipelineStep): number {
  const rows = getDb()
    .select({ costUsd: costLog.costUsd })
    .from(costLog)
    .where(and(eq(costLog.jobId, jobId), eq(costLog.step, step)))
    .all();
  return rows.reduce((total, row) => total + row.costUsd, 0);
}

/** Stamp a running step's finishedAt (pass-finish hook) without finalizing it. */
function stampStepFinished(state: RunState, step: PipelineStep): void {
  const s = findStep(state, step);
  s.finishedAt = nowIso();
  s.completedAt = s.finishedAt;
  persistSteps(state);
  emitStep(state, step);
}

/** startStep only if the step never started (backfill for hook-less mocks). */
function ensureStepStarted(state: RunState, step: PipelineStep): void {
  if (findStep(state, step).status === "pending") startStep(state, step);
}

/** Update detail on a running step without making it terminal. */
function updateRunningStepDetail(
  state: RunState,
  step: PipelineStep,
  detail: string,
  costUsd?: number,
): void {
  const s = findStep(state, step);
  s.detail = detail;
  if (costUsd !== undefined) s.costUsd = costUsd;
  persistSteps(state);
  emitStep(state, step);
}

/* ------------------------------------------------------------------------ *
 * Cost logging
 * ------------------------------------------------------------------------ */

/**
 * Write one cost_log row for an LLM pass and update the running total. Emits a
 * "cost-update" with the pass cost + running total. Also stamps the step's
 * costUsd (accumulating across multiple passes attributed to one step, e.g. a
 * fallback retry) via finishStep at the caller.
 */
function logPassCost(
  state: RunState,
  step: PipelineStep,
  pass: {
    model: string;
    costUsd: number;
    fallbackUsed: boolean;
    usage?: PassUsageLike;
    webSearches?: number;
  },
): void {
  const u = pass.usage ?? {};
  getDb()
    .insert(costLog)
    .values({
      jobId: state.jobId,
      step,
      model: pass.model,
      inputTokens: numOr0(u.input_tokens),
      outputTokens: numOr0(u.output_tokens),
      cacheReadTokens: numOr0(u.cache_read_input_tokens),
      cacheWriteTokens: numOr0(u.cache_creation_input_tokens),
      webSearches: numOr0(pass.webSearches),
      costUsd: pass.costUsd,
      fallbackUsed: pass.fallbackUsed,
      createdAt: nowIso(),
    })
    .run();

  state.totalCostUsd += pass.costUsd;
  publish(state, {
    type: "cost-update",
    jobId: state.jobId,
    step,
    passCostUsd: pass.costUsd,
    totalCostUsd: state.totalCostUsd,
  });
}

function numOr0(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function billedAttemptFromError(err: unknown): BilledPassAttempt | null {
  if (err === null || typeof err !== "object" || !("billedAttempt" in err)) return null;
  const attempt = (err as { billedAttempt?: unknown }).billedAttempt;
  if (attempt === null || typeof attempt !== "object") return null;
  const candidate = attempt as Partial<BilledPassAttempt>;
  return typeof candidate.model === "string" &&
    typeof candidate.costUsd === "number" &&
    Number.isFinite(candidate.costUsd) &&
    typeof candidate.fallbackUsed === "boolean"
    ? {
        model: candidate.model,
        costUsd: candidate.costUsd,
        fallbackUsed: candidate.fallbackUsed,
        usage: candidate.usage,
        webSearches: candidate.webSearches,
      }
    : null;
}

function bullBearFailureFromError(err: unknown): BullBearPassFailureDetails | null {
  if (err === null || typeof err !== "object") return null;
  const candidate = err as Partial<BullBearPassFailureDetails>;
  const hasBull =
    candidate.bull !== undefined ||
    candidate.bullError !== undefined ||
    candidate.bullBilledAttempt !== undefined;
  const hasBear =
    candidate.bear !== undefined ||
    candidate.bearError !== undefined ||
    candidate.bearBilledAttempt !== undefined;
  if (!hasBull && !hasBear) return null;
  return candidate;
}

/**
 * Cap on how much of a failed judge output is echoed back on retry. Sized
 * from MEASURED output — 1.1.0 judge JSON runs ~100–120K chars on sonnet-5;
 * the old 60K cap truncated every realistic echo mid-document, defeating the
 * "repair this JSON in place" instruction. 200K covers observed sizes ~1.7×
 * over while still bounding a true runaway. Mirrors the passes module's
 * JUDGE_RETRY_PREVIOUS_OUTPUT_CAP (same decoupling convention as
 * MAX_JUDGE_RETRIES).
 */
const JUDGE_RETRY_RAW_OUTPUT_CAP = 200_000;

/** Raw text of a received-but-invalid pass output, when the error carries it. */
function rawTextOfError(err: unknown): string {
  if (err === null || typeof err !== "object" || !("rawText" in err)) return "";
  const raw = (err as { rawText?: unknown }).rawText;
  if (typeof raw !== "string") return "";
  return raw.length > JUDGE_RETRY_RAW_OUTPUT_CAP
    ? `${raw.slice(0, JUDGE_RETRY_RAW_OUTPUT_CAP)}\n[...truncated]`
    : raw;
}

function isRetryableJudgeError(err: unknown): boolean {
  if (err !== null && typeof err === "object" && "retryable" in err) {
    return (err as { retryable?: unknown }).retryable === true;
  }
  const message = errMessage(err).toLowerCase();
  return (
    message.includes("schema-invalid") ||
    message.includes("unparseable structured output") ||
    message.includes("not valid json") ||
    message.includes("report-schema") ||
    message.includes("schema validation")
  );
}

function finishAnalystSide(
  state: RunState,
  step: "bull" | "bear",
  result: PassResultLike<AnalystCase> | undefined,
  errorDetail: string | undefined,
  billedAttempt: BilledPassAttempt | undefined,
  fallbackDetail: string,
): void {
  if (result !== undefined) {
    logPassCost(state, step, result);
    finishStep(state, step, "done", passDetail(result), result.costUsd);
    return;
  }

  if (billedAttempt !== undefined) {
    logPassCost(state, step, billedAttempt);
  }
  finishStep(
    state,
    step,
    "error",
    errorDetail ?? fallbackDetail,
    billedAttempt?.costUsd,
  );
}

/* ------------------------------------------------------------------------ *
 * createJob
 * ------------------------------------------------------------------------ */

/**
 * Insert a fresh "queued" job for a symbol with every step "pending". Returns
 * the generated jobId. Does NOT start the pipeline — the caller (POST route)
 * kicks off runJob() in the background afterward.
 */
export function createJob(symbol: string): { jobId: string } {
  const sym = symbol.trim().toUpperCase();
  const jobId = randomUUID();
  const now = nowIso();
  getDb()
    .insert(jobs)
    .values({
      id: jobId,
      symbol: sym,
      status: "queued",
      stepsJson: JSON.stringify(initialSteps()),
      createdAt: now,
      updatedAt: now,
      error: null,
      reportId: null,
    })
    .run();
  return { jobId };
}

/**
 * Atomically reuse or create the active job for a symbol. The partial unique
 * SQLite index is the final arbiter across processes; the transaction keeps
 * the common check+insert path together and converts a concurrent uniqueness
 * race into the already-existing row response.
 */
export function getOrCreateJobForSymbol(symbol: string):
  | { jobId: string; existing: true; status: "queued" | "running"; updatedAt: string }
  | { jobId: string; existing: false } {
  const sym = symbol.trim().toUpperCase();
  const db = getDb();
  try {
    return db.transaction((tx) => {
      const active = tx
        .select({ id: jobs.id, status: jobs.status, updatedAt: jobs.updatedAt })
        .from(jobs)
        .where(and(eq(jobs.symbol, sym), inArray(jobs.status, ["queued", "running"])))
        .orderBy(desc(jobs.updatedAt), desc(jobs.id))
        .get();
      if (active && isReusableStatus(active.status)) {
        return { jobId: active.id, existing: true, status: active.status, updatedAt: active.updatedAt };
      }
      const jobId = randomUUID();
      const now = nowIso();
      tx.insert(jobs)
        .values({
          id: jobId,
          symbol: sym,
          status: "queued",
          stepsJson: JSON.stringify(initialSteps()),
          createdAt: now,
          updatedAt: now,
          error: null,
          reportId: null,
        })
        .run();
      return { jobId, existing: false };
    });
  } catch (err) {
    // Another process may have won the unique active-symbol insert after our
    // snapshot. Read it back and return it; do not bill/start a second run.
    const active = getReusableActiveJobForSymbol(sym);
    if (active !== null) {
      return { ...active, existing: true };
    }
    throw err;
  }
}

export interface ReusableActiveJob {
  jobId: string;
  status: "queued" | "running";
  updatedAt: string;
}

function isReusableStatus(status: string): status is ReusableActiveJob["status"] {
  return status === "queued" || status === "running";
}

/**
 * Return a still-fresh active job for a symbol so clients can resume its stream.
 * Stale queued/running rows are marked error first; otherwise they would block
 * all future runs for that ticker after a dev-server restart or detached task
 * death.
 */
export function getReusableActiveJobForSymbol(
  symbol: string,
  now: Date = new Date(),
  staleMs = ACTIVE_JOB_STALE_MS,
): ReusableActiveJob | null {
  const sym = symbol.trim().toUpperCase();
  const nowMs = now.getTime();
  const nowText = now.toISOString();
  const rows = getDb()
    .select({ id: jobs.id, status: jobs.status, updatedAt: jobs.updatedAt })
    .from(jobs)
    .where(eq(jobs.symbol, sym))
    .all()
    .filter((r): r is { id: string; status: ReusableActiveJob["status"]; updatedAt: string } =>
      isReusableStatus(r.status),
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  let reusable: ReusableActiveJob | null = null;
  for (const row of rows) {
    const updatedMs = Date.parse(row.updatedAt);
    // A job THIS process is still executing is never stale, no matter how long
    // its current pass has been silent (see liveJobIds).
    const stale =
      !isJobLiveInProcess(row.id) &&
      (!Number.isFinite(updatedMs) || nowMs - updatedMs > staleMs);
    if (stale) {
      getDb()
        .update(jobs)
        .set({
          status: "error",
          error: `stale active job expired after ${Math.round(staleMs / 60000)} minutes without progress`,
          updatedAt: nowText,
        })
        .where(eq(jobs.id, row.id))
        .run();
      continue;
    }
    reusable ??= { jobId: row.id, status: row.status, updatedAt: row.updatedAt };
  }
  return reusable;
}

/**
 * True when a job for this symbol is currently queued or running (the POST
 * route rejects a duplicate rather than racing two pipelines for one ticker).
 */
export function isSymbolJobActive(symbol: string): boolean {
  return getReusableActiveJobForSymbol(symbol) !== null;
}

/* ------------------------------------------------------------------------ *
 * Analyst-pass snapshots (stage-level resume — 2026-07 audit item 1)
 * ------------------------------------------------------------------------ */

/**
 * Persisted analyst snapshots plus the fingerprint they were built on.
 * PER-SIDE nullable (2026-07-10): a run where one analyst pass succeeded and
 * the other failed persists the successful side alone, so its paid output is
 * never discarded — resume reuses it and re-bills only the missing side.
 */
export interface PersistedPassSnapshots {
  bull: PassResultLike<AnalystCase> | null;
  bear: PassResultLike<AnalystCase> | null;
  payloadFingerprint: string | null;
}

/**
 * Parse + validate one serialized PassResultLike<AnalystCase>. The AnalystCase
 * payload is re-validated against ANALYST_CASE_SCHEMA — a resumed judge must
 * never be fed a corrupt or hand-edited snapshot.
 */
function parsePassSnapshot(json: string | null): PassResultLike<AnalystCase> | null {
  if (json === null || json.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const c = raw as Partial<PassResultLike<unknown>>;
  if (
    typeof c.model !== "string" ||
    typeof c.costUsd !== "number" ||
    !Number.isFinite(c.costUsd) ||
    typeof c.fallbackUsed !== "boolean"
  ) {
    return null;
  }
  const data = ANALYST_CASE_SCHEMA.safeParse(c.data);
  if (!data.success) return null;
  const fetchedUrls = Array.isArray(c.fetchedUrls)
    ? [
        ...new Set(
          c.fetchedUrls.flatMap((value) => {
            if (typeof value !== "string") return [];
            const canonical = canonicalizeFetchedUrl(value);
            return canonical ? [canonical] : [];
          }),
        ),
      ].sort()
    : [];
  return {
    data: data.data,
    model: c.model,
    costUsd: c.costUsd,
    fallbackUsed: c.fallbackUsed,
    usage: c.usage,
    webSearches: c.webSearches,
    fetchedUrls,
  };
}

/**
 * Read the persisted bull/bear snapshots for a job, per side (an invalid or
 * absent side is null — a resumed judge is never fed a corrupt snapshot).
 * Returns null only when NEITHER side is usable (start a fresh run instead).
 * Used by the retry route (resumability check) and runJob's resume path.
 */
export function readPassSnapshots(jobId: string): PersistedPassSnapshots | null {
  const row = getDb()
    .select({
      bullJson: jobs.bullJson,
      bearJson: jobs.bearJson,
      payloadFingerprint: jobs.payloadFingerprint,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  if (row === undefined) return null;
  const bull = parsePassSnapshot(row.bullJson);
  const bear = parsePassSnapshot(row.bearJson);
  if (bull === null && bear === null) return null;
  return { bull, bear, payloadFingerprint: row.payloadFingerprint ?? null };
}

/** The reusable/re-runnable sides of a resumable failure (see predicate below). */
export interface ResumableFailureShape {
  /** Analyst sides that completed — their persisted snapshots are reusable. */
  doneSides: ("bull" | "bear")[];
  /** Analyst sides that errored — a resume re-runs (re-bills) only these. */
  failedSides: ("bull" | "bear")[];
}

/**
 * The RESUMABLE failure shapes of a job's persisted steps, or null:
 *  - both analysts done + synthesize errored → resume re-runs only the
 *    judge/verify tail (the original 2026-07 audit item 1 shape);
 *  - exactly one analyst done + the other errored (synthesize skipped) →
 *    resume reuses the done side's snapshot and re-runs only the failed side
 *    (2026-07-10: a paid successful side must never be discarded).
 * A job whose synthesize is "done" is NEVER resumable — its report must not
 * be re-billed or overwritten by a degraded retry. Both-analysts-failed is
 * not resumable either: nothing is reusable, a fresh run is strictly equal.
 * Mirrors the UI's canResume predicate; the retry route enforces it
 * server-side.
 */
export function stepsShowResumableFailure(steps: StepProgress[]): ResumableFailureShape | null {
  const by = new Map(steps.map((s) => [s.step, s]));
  if (by.get("synthesize")?.status === "done") return null;
  const sides = ["bull", "bear"] as const;
  const doneSides = sides.filter((s) => by.get(s)?.status === "done");
  const failedSides = sides.filter((s) => by.get(s)?.status === "error");
  if (doneSides.length + failedSides.length !== sides.length) return null;
  if (doneSides.length === sides.length) {
    return by.get("synthesize")?.status === "error" ? { doneSides, failedSides } : null;
  }
  return doneSides.length > 0 ? { doneSides, failedSides } : null;
}

/**
 * Snapshot-level resumability fallback, independent of the step status words.
 *
 * stepsShowResumableFailure keys off the exact bull/bear/synthesize statuses.
 * But a resume that DEGRADES before re-marking the analyst steps — the no-key
 * branch or a transient model-resolution failure — writes bull/bear/synthesize
 * "skipped" and finishes the job "done"; likewise a resumed run swept a SECOND
 * time (process death during fetch/validate/compute) has its steps reset to
 * pending then rewritten "skipped". In both cases the step shape is
 * non-resumable forever, yet BOTH already-paid analyst snapshots are still
 * persisted (bullJson + bearJson). Treat that as resumable: both snapshots
 * present AND synthesize not "done" (a completed synthesis produced the report
 * and must never be re-billed or overwritten). A re-resume reuses both
 * snapshots and re-runs only the judge/verify tail — nothing is re-billed.
 */
export function snapshotsCoverResume(
  snapshots: PersistedPassSnapshots | null,
  steps: StepProgress[],
): boolean {
  if (snapshots === null || snapshots.bull === null || snapshots.bear === null) return false;
  return steps.find((s) => s.step === "synthesize")?.status !== "done";
}

/**
 * Atomically claim a terminal job for a synthesis-only retry. The expected
 * status is part of the UPDATE predicate, so two HTTP requests that read the
 * same terminal row cannot both launch a paid continuation: only the first
 * transition to queued succeeds.
 */
export function claimJobForResume(jobId: string, expectedTerminalStatus: string): boolean {
  const result = getDb()
    .update(jobs)
    .set({ status: "queued", error: null, reportId: null, updatedAt: nowIso() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, expectedTerminalStatus)))
    .run();
  return result.changes === 1;
}

/** Persist one analyst side's result so a failed synthesize can resume later. */
function persistPassSnapshot(
  state: RunState,
  side: "bull" | "bear",
  result: PassResultLike<AnalystCase>,
): void {
  const column = side === "bull" ? { bullJson: JSON.stringify(result) } : { bearJson: JSON.stringify(result) };
  getDb()
    .update(jobs)
    .set({ ...column, updatedAt: nowIso() })
    .where(eq(jobs.id, state.jobId))
    .run();
}

/** Persist the payload fingerprint the analyst passes were built on. */
function persistPayloadFingerprint(state: RunState, fingerprint: string | null): void {
  if (fingerprint === null) return;
  getDb()
    .update(jobs)
    .set({ payloadFingerprint: fingerprint, updatedAt: nowIso() })
    .where(eq(jobs.id, state.jobId))
    .run();
}

/* ------------------------------------------------------------------------ *
 * In-process liveness registry
 *
 * A single LLM pass can silently run >30 minutes (web-search-heavy passes,
 * provider backoff) or a laptop sleep can freeze the clock mid-pass — with no
 * jobs-table write in between. The stale sweep must never reap a job THIS
 * process is still executing: that would flip a live run to "error", let the
 * duplicate-job guard open, and allow a concurrent second pipeline on the
 * same job/symbol. Stashed on globalThis (like the events bus) so Next.js dev
 * hot-reloads share one registry with in-flight runs from older module copies.
 * ------------------------------------------------------------------------ */

class JobCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobCanceledError";
  }
}

class JobDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobDeadlineError";
  }
}

function positiveDeadline(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : fallback;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new JobCanceledError("job canceled");
}

function throwIfJobAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/**
 * Race a stage against the shared signal. The timer aborts the whole job, so
 * compliant providers stop their transport; the race also bounds injected or
 * buggy dependencies that ignore AbortSignal.
 */
async function awaitJobStage<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  controller: AbortController,
  stage: string,
  deadlineMs: number,
): Promise<T> {
  throwIfJobAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onAbort = (): void => finish(() => reject(abortReason(signal)));
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort(
            new JobDeadlineError(`${stage} stage deadline exceeded after ${deadlineMs}ms`),
          );
        }
      }, deadlineMs);
      timer.unref?.();
      promise.then(
        (value) => finish(() => resolve(value)),
        (err: unknown) => finish(() => reject(err)),
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const globalWithLiveJobs = globalThis as typeof globalThis & {
  __thesisLiveJobIds?: Set<string>;
  __thesisLiveJobControllers?: Map<string, AbortController>;
};

function liveJobIds(): Set<string> {
  return (globalWithLiveJobs.__thesisLiveJobIds ??= new Set());
}

function liveJobControllers(): Map<string, AbortController> {
  return (globalWithLiveJobs.__thesisLiveJobControllers ??= new Map());
}

/**
 * Terminal error message written when a job is canceled by the user. Load-
 * bearing: runJob's resume gate refuses to (re-)start a job that carries this
 * marker, so an acknowledged cancel is never silently un-done by a resume that
 * was dispatched in the same window (see runJob).
 */
export const JOB_CANCELED_ERROR = "job canceled by user";

/** Cancel one currently executing local job. Returns false once it is terminal/not local. */
export function cancelJob(jobId: string): boolean {
  const controller = liveJobControllers().get(jobId);
  if (controller !== undefined && !controller.signal.aborted) {
    controller.abort(new JobCanceledError(JOB_CANCELED_ERROR));
    return true;
  }
  // Close the dispatch race: the POST may have created a queued row but the
  // detached runner has not registered its controller yet.
  const result = getDb()
    .update(jobs)
    .set({ status: "error", error: JOB_CANCELED_ERROR, updatedAt: nowIso() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "queued")))
    .run();
  return result.changes === 1;
}

/** TEST hook: true when runJob currently executes the job in this process. */
export function isJobLiveInProcess(jobId: string): boolean {
  return liveJobIds().has(jobId);
}

/** Heartbeat period — bumps jobs.updatedAt during long silent passes. */
export const JOB_HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Global sweep: flip EVERY stale queued/running job — any symbol — to a
 * terminal error. getReusableActiveJobForSymbol only expires rows for the
 * symbol being re-run, so a job whose process died (dev-server restart,
 * crash) for a ticker the user never re-runs would show "running" forever
 * (the PYPL job in the 2026-07 audit sat running for two days). Called
 * lazily from the read/start paths (report POST, SSE stream open, job
 * polling) — one indexed UPDATE, cheap enough to run on every read. Jobs the
 * CURRENT process is still executing are excluded (liveJobIds), and runJob
 * additionally heartbeats jobs.updatedAt every 5 minutes, so neither this
 * process nor any other observer mistakes a long silent pass for a corpse.
 * Publishes no events: the dead process's subscribers are gone, and live
 * readers re-snapshot right after the sweep.
 */
export function sweepAbandonedJobs(
  now: Date = new Date(),
  staleMs = ACTIVE_JOB_STALE_MS,
): number {
  const cutoffIso = new Date(now.getTime() - staleMs).toISOString();
  const live = [...liveJobIds()];
  const stale = and(
    inArray(jobs.status, ["queued", "running"]),
    lt(jobs.updatedAt, cutoffIso),
  );
  const message = `abandoned: no progress for ${Math.round(staleMs / 60000)} minutes (process restart or crash)`;
  const db = getDb();
  const rows = db
    .select({ id: jobs.id, stepsJson: jobs.stepsJson })
    .from(jobs)
    .where(live.length > 0 ? and(stale, notInArray(jobs.id, live)) : stale)
    .all();
  for (const row of rows) {
    // Normalize stepsJson the same way abortRun does for in-process aborts:
    // running → error, pending → skipped. Without this, a job whose process
    // died mid-synthesize keeps synthesize:"running" in stepsJson forever, and
    // stepsShowResumableFailure never recognizes it — stranding both persisted
    // (already-paid) analyst snapshots even though the judge tail is the only
    // thing left to run. Malformed stepsJson is left untouched (status flip
    // alone still un-wedges the job row).
    const set: Record<string, unknown> = {
      status: "error",
      error: message,
      updatedAt: now.toISOString(),
    };
    try {
      const steps = JSON.parse(row.stepsJson ?? "") as StepProgress[];
      if (Array.isArray(steps)) {
        for (const step of steps) {
          if (step.status === "running") {
            step.status = "error";
            step.finishedAt = now.toISOString();
            step.completedAt = step.finishedAt;
            step.detail = message;
          } else if (step.status === "pending") {
            step.status = "skipped";
            step.detail = `not reached — ${message}`;
          }
        }
        set.stepsJson = JSON.stringify(steps);
      }
    } catch {
      /* keep original stepsJson */
    }
    // Re-assert the stale predicate on the write (TOCTOU): a row can flip live
    // (a resume/fresh run claimed it into running with a fresh updatedAt) or
    // terminal between the SELECT above and this UPDATE. Without the WHERE
    // guard the per-row write would clobber that live/terminal state back to
    // error. changes=0 for a row that moved is the correct no-op.
    db.update(jobs)
      .set(set)
      .where(and(eq(jobs.id, row.id), stale))
      .run();
  }
  return rows.length;
}

/* ------------------------------------------------------------------------ *
 * runJob
 * ------------------------------------------------------------------------ */

export interface RunJobOptions<TPayload = unknown> {
  /** Options forwarded to buildDataBundle (injectable clients/clock in tests). */
  bundleOptions?: BuildDataBundleOptions;
  /**
   * Test/override hook: skip live fetch and use this bundle directly. When set,
   * the fetch step is marked done immediately with this bundle.
   */
  bundle?: DataBundle;
  /**
   * Force the no-key degraded path regardless of config (tests). When
   * undefined, the runner reads getConfig().hasAnthropicKey.
   */
  hasAnthropicKey?: boolean;
  /** Injectable clock for meta.generatedAt (tests). Defaults to new Date(). */
  now?: () => Date;
  /**
   * Override the report-schema retry budget. Defaults to MAX_JUDGE_RETRIES;
   * set to 0 for one-attempt live harnesses that must not re-invoke judge.
   */
  maxJudgeRetries?: number;
  /** Optional upstream cancellation (tests/embedding); composed with local cancel/deadline. */
  signal?: AbortSignal;
  /** Overall wall-clock deadline. Default 90 minutes. */
  deadlineMs?: number;
  /** Fetch-stage deadline. Default 10 minutes. */
  fetchDeadlineMs?: number;
  /** Deadline for each external model stage. Default 45 minutes. */
  modelStageDeadlineMs?: number;
  /**
   * Resume from persisted bull/bear snapshots (2026-07 audit item 1): skip the
   * analyst passes entirely — they are the expensive part — and re-run only
   * synthesize/verify/assemble. fetch/validate/compute still re-run (cheap and
   * cache-served) to rebuild the judge payload; a payload-fingerprint mismatch
   * against the snapshot is disclosed as a warn gap, not a failure. When the
   * snapshots are missing/corrupt the runner degrades to a full fresh run.
   */
  resume?: boolean;
  /** Marker so TPayload is inferable from the passes argument. */
  readonly _payload?: TPayload;
}

export interface RunJobResult {
  jobId: string;
  status: JobStatus;
  reportId: number | null;
  verificationRate: number | null;
  totalCostUsd: number;
  /** True when the LLM steps were skipped (no key) → data-only report. */
  dataOnly: boolean;
}

/**
 * Run the full pipeline for an already-created job. Deterministic step order,
 * per-step timing, cost logging, and progress events. Never throws for missing
 * data or a failed LLM pass — those degrade to gaps / "error" steps and the
 * runner still persists what it has. Rejects only on a truly unexpected
 * programming/DB failure (after recording "error" on the job).
 */
export async function runJob<TPayload = unknown>(
  jobId: string,
  passes: PipelinePasses<TPayload>,
  opts: RunJobOptions<TPayload> = {},
): Promise<RunJobResult> {
  const jobRow = getDb().select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (jobRow === undefined) {
    throw new Error(`runJob: no job with id "${jobId}"`);
  }
  if (
    jobRow.status !== "queued" &&
    jobRow.status !== "running" &&
    !(opts.resume === true && (jobRow.status === "done" || jobRow.status === "error"))
  ) {
    throw new Error(`runJob: job "${jobId}" is not active (status ${jobRow.status})`);
  }

  // A cancel acknowledged (202) in the resume-dispatch window flips the claimed
  // row to error "job canceled by user" (cancelJob's dispatch-race close). The
  // retry route then calls runJob(resume) on it; the resume gate above would
  // accept that error status and silently re-run the paid passes, un-doing the
  // cancel. Refuse to start when the job carries the cancel marker. (The window
  // exists only across the route's async gap; between this read and controller
  // registration there is no await, so a later cancel finds the live controller
  // and aborts normally. A FRESH explicit retry clears error via
  // claimJobForResume, so this only blocks an override, never a real retry.)
  if (opts.resume === true && jobRow.status === "error" && jobRow.error === JOB_CANCELED_ERROR) {
    return {
      jobId,
      status: "error",
      reportId: null,
      verificationRate: null,
      totalCostUsd: round4(sumLoggedCost(jobId)),
      dataOnly: false,
    };
  }

  if (opts.resume === true && (jobRow.status === "done" || jobRow.status === "error")) {
    const steps = parseStepsJson(jobRow.stepsJson);
    const snapshots = readPassSnapshots(jobId);
    const resumable =
      stepsShowResumableFailure(steps) !== null || snapshotsCoverResume(snapshots, steps);
    if (!resumable) {
      throw new Error(`runJob: job "${jobId}" is not resumable (already synthesized or no reusable analyst work)`);
    }
  }

  const state: RunState = {
    jobId,
    symbol: jobRow.symbol,
    startedAt: jobRow.createdAt,
    steps: initialSteps(),
    // Rehydrate any cost already logged under this jobId BEFORE any early exit
    // (no-key / model-resolution-failure / compute-throw): a resumed run's
    // degraded report must still carry the job's true all-in cost. A fresh
    // job's cost_log is empty, so this is a no-op there.
    totalCostUsd: sumLoggedCost(jobId),
  };
  const jobController = new AbortController();
  const jobSignal = jobController.signal;
  const externalSignal = opts.signal;
  const onExternalAbort = (): void => {
    if (!jobController.signal.aborted) {
      jobController.abort(externalSignal?.reason ?? new JobCanceledError("job canceled upstream"));
    }
  };
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const deadlineMs = positiveDeadline(opts.deadlineMs, DEFAULT_JOB_DEADLINE_MS);
  const fetchDeadlineMs = positiveDeadline(opts.fetchDeadlineMs, DEFAULT_FETCH_DEADLINE_MS);
  const modelStageDeadlineMs = positiveDeadline(
    opts.modelStageDeadlineMs,
    DEFAULT_MODEL_STAGE_DEADLINE_MS,
  );
  const overallTimer = setTimeout(() => {
    if (!jobController.signal.aborted) {
      jobController.abort(new JobDeadlineError(`overall deadline exceeded after ${deadlineMs}ms`));
    }
  }, deadlineMs);
  overallTimer.unref?.();
  persistSteps(state, "running", null);

  // Liveness registration + heartbeat: a single silent pass can outlast the
  // 30-minute stale threshold; the registry stops THIS process's sweeps from
  // reaping the job, and the heartbeat keeps jobs.updatedAt fresh for any
  // other observer. Both are cleaned up in the finally.
  liveJobIds().add(jobId);
  liveJobControllers().set(jobId, jobController);
  const heartbeat = setInterval(() => {
    try {
      getDb().update(jobs).set({ updatedAt: nowIso() }).where(eq(jobs.id, jobId)).run();
    } catch {
      // A failed heartbeat must never break the run.
    }
  }, JOB_HEARTBEAT_MS);
  heartbeat.unref?.();

  const now = opts.now ?? ((): Date => new Date());
  const hasKey = opts.hasAnthropicKey ?? getConfig().hasAnthropicKey;
  const maxJudgeRetries =
    opts.maxJudgeRetries !== undefined && Number.isFinite(opts.maxJudgeRetries)
      ? Math.max(0, Math.trunc(opts.maxJudgeRetries))
      : MAX_JUDGE_RETRIES;

  try {
    throwIfJobAborted(jobSignal);
    // -- fetch ----------------------------------------------------------------
    startStep(state, "fetch");
    let bundle: DataBundle;
    try {
      bundle =
        opts.bundle ??
        (await awaitJobStage(buildDataBundle(state.symbol, {
          ...opts.bundleOptions,
          signal: jobSignal,
          onProgress: (msg) => {
            if (jobSignal.aborted) return;
            const s = findStep(state, "fetch");
            s.detail = msg;
            // Lightweight progress: persist + emit without changing status.
            persistSteps(state);
            emitStep(state, "fetch");
          },
        }), jobSignal, jobController, "fetch", fetchDeadlineMs));
      throwIfJobAborted(jobSignal);
    } catch (err) {
      throwIfJobAborted(jobSignal);
      // A hard fetch failure is terminal for the whole run — there is nothing
      // downstream can compute from. Record it and finish with error.
      return failRun(state, "fetch", err);
    }
    finishStep(
      state,
      "fetch",
      "done",
      `data bundle for ${state.symbol} (${bundle.gaps.length} gap(s))`,
    );

    // -- validate -------------------------------------------------------------
    startStep(state, "validate");
    let validation: ValidationReport;
    try {
      validation = validateBundle(bundle, { now: now() });
    } catch (err) {
      validation = { checks: [], flags: [], gaps: [gapFor("validate", err)] };
    }
    throwIfJobAborted(jobSignal);
    finishStep(
      state,
      "validate",
      "done",
      `${validation.checks.length} check(s), ${validation.flags.length} flag(s)`,
    );

    // -- compute --------------------------------------------------------------
    startStep(state, "compute");
    let computed: ComputedMetrics;
    try {
      computed = runStageB(bundle);
    } catch (err) {
      // Compute is pure; a throw here is a programming error, but degrade
      // rather than crash the app: finish compute with error and continue to
      // persist a data-only stub.
      finishStep(state, "compute", "error", errMessage(err));
      return persistDataOnly(state, bundle, validation, null, now, hasKey);
    }
    throwIfJobAborted(jobSignal);
    finishStep(
      state,
      "compute",
      "done",
      `route ${computed.route.base}${computed.route.overlays.length > 0 ? ` +${computed.route.overlays.join("/")}` : ""}, ${computed.gaps.length} gap(s)`,
    );

    // -- no-key degraded path -------------------------------------------------
    if (!hasKey) {
      for (const step of LLM_STEPS) {
        startStep(state, step);
        finishStep(state, step, "skipped", NO_KEY_SKIP_REASON);
      }
      return persistDataOnly(state, bundle, validation, computed, now, hasKey);
    }

    // -- resolve models -------------------------------------------------------
    // Model resolution ("auto" hits client.models.list()) can throw on a
    // transient Anthropic transport/auth failure. That is NOT a reason to fail
    // the whole job — degrade like the no-key path: mark the four LLM steps
    // "skipped" with the resolution error and still persist a data-only report
    // (Fix §1, the design rationale hardening backlog). Only genuinely unexpected
    // failures downstream still reach the outer catch and 'error'.
    let analysisModel: string;
    let analysisEffort: EffortLevel;
    try {
      const analysisSetting = getAnalysisModelSetting();
      const analysisResolved = await awaitJobStage(
        resolveModel(analysisSetting),
        jobSignal,
        jobController,
        "model resolution",
        fetchDeadlineMs,
      );
      analysisModel = analysisResolved.model;
      // Effort reads settings/env only (no network); unknown values sanitize
      // to the default inside the getter, so this cannot fail on bad input.
      analysisEffort = getAnalysisEffortSetting();
    } catch (err) {
      throwIfJobAborted(jobSignal);
      const reason = `${MODEL_RESOLUTION_SKIP_PREFIX}: ${errMessage(err)}`;
      for (const step of LLM_STEPS) {
        startStep(state, step);
        finishStep(state, step, "skipped", reason);
      }
      return persistDataOnly(state, bundle, validation, computed, now, hasKey);
    }

    // -- assemble payload (deterministic) -------------------------------------
    const payload = passes.assembleContextPayload(bundle, computed, validation);
    const deps: PassDeps<TPayload> = {
      analysisModel,
      effort: analysisEffort,
      payload,
      signal: jobSignal,
    };
    const fingerprint = passes.fingerprintPayload?.(payload) ?? null;

    // -- synthesize (judge) + verify + assemble, with retry-on-Zod (SPEC §2) --
    // SPEC §2: "on validation failure, retry with the error fed back (max 2
    // retries), then fail loudly." The judge/verify/assemble unit is retried as
    // a whole: a schema-validation failure at the judge pass OR at report
    // assembly (the assembled Report can fail the fuller ReportSchema even when
    // the JudgeOutput passed JUDGE_OUTPUT_SCHEMA) re-invokes the judge, feeding
    // the error back, up to maxJudgeRetries extra attempts. When they are all
    // exhausted we mark synthesize + verify "error" LOUDLY with the validation
    // detail and persist what we have (data-only) rather than crashing.
    // Shared by the fresh path and the resume path (which feeds it persisted
    // snapshots instead of fresh passes). verify is NOT started up front — it
    // starts when it actually runs (after a successful judge attempt) so its
    // timestamps reflect the real pass.
    const runSynthesisAndFinish = async (
      bull: PassResultLike<AnalystCase>,
      bear: PassResultLike<AnalystCase>,
    ): Promise<RunJobResult> => {
      startStep(state, "synthesize");

      const buildMeta = (
        verificationRate: number | null,
        judge: PassResultLike<JudgeOutput>,
      ): ReportMetaInput => ({
        symbol: state.symbol,
        companyName: companyNameOf(bundle, state.symbol),
        // Generation completes after verification data exists; persistence is
        // stamped separately by persistReport.
        generatedAt: now().toISOString(),
        model: analysisModel,
        // Preserve the exact sum in report JSON. Presentation rounds each row
        // and the displayed total to six decimals through the shared formatter.
        costUsd: state.totalCostUsd,
        verificationRate,
        asOfMap: { ...bundle.asOf },
        runId: state.jobId,
        startedAt: state.startedAt,
        execution: [
          buildExecutionMetadataEntry({
            step: "bull",
            requestedModel: analysisModel,
            effectiveModel: bull.model,
            requestedEffort: analysisEffort,
            fallbackUsed: bull.fallbackUsed,
          }),
          buildExecutionMetadataEntry({
            step: "bear",
            requestedModel: analysisModel,
            effectiveModel: bear.model,
            requestedEffort: analysisEffort,
            fallbackUsed: bear.fallbackUsed,
          }),
          buildExecutionMetadataEntry({
            step: "synthesize",
            requestedModel: analysisModel,
            effectiveModel: judge.model,
            requestedEffort: analysisEffort,
            fallbackUsed: judge.fallbackUsed,
          }),
          buildExecutionMetadataEntry({
            step: "verify",
            requestedModel: "deterministic",
            effectiveModel: "deterministic",
            requestedEffort: null,
            fallbackUsed: false,
          }),
        ],
      });

      let assembled: {
        report: Report;
        verificationRate: number | null;
        verifyLog: unknown;
        meta: ReportMetaInput;
        costBreakdown: { step: string; model: string; costUsd: number }[];
      } | null = null;
      let lastValidationDetail = "";
      let lastFailedRawOutput = "";
      let lastJudgeFailureRetryable = true;

      for (let attempt = 0; attempt <= maxJudgeRetries; attempt++) {
        // 1) Judge pass. A throw here is a synthesis failure (schema-invalid
        //    structured output in the real facade, or a mock rejection). It is
        //    retryable per SPEC §2 — feed the error back by re-invoking the judge,
        //    together with the failed raw output so the model repairs its previous
        //    JSON instead of regenerating the whole document from scratch.
        let judge: PassResultLike<JudgeOutput>;
        const feedback =
          lastValidationDetail.length > 0
            ? lastFailedRawOutput.length > 0
              ? `${lastValidationDetail}\n\nYOUR PREVIOUS OUTPUT (repair this JSON in place — do not start over):\n${lastFailedRawOutput}`
              : lastValidationDetail
            : undefined;
        try {
          judge = await awaitJobStage(
            passes.runJudgePass(deps, bull, bear, feedback),
            jobSignal,
            jobController,
            "synthesize",
            modelStageDeadlineMs,
          );
          throwIfJobAborted(jobSignal);
        } catch (err) {
          throwIfJobAborted(jobSignal);
          const billedAttempt = billedAttemptFromError(err);
          if (billedAttempt !== null) logPassCost(state, "synthesize", billedAttempt);
          lastValidationDetail = errMessage(err);
          lastFailedRawOutput = rawTextOfError(err);
          lastJudgeFailureRetryable = isRetryableJudgeError(err);
          const retrying = lastJudgeFailureRetryable && attempt < maxJudgeRetries;
          updateRunningStepDetail(
            state,
            "synthesize",
            `judge attempt ${attempt + 1}/${maxJudgeRetries + 1} failed${retrying ? "; retrying" : ""}: ${lastValidationDetail}`,
          );
          if (retrying) continue;
          break;
        }
        logPassCost(state, "synthesize", judge);
        // The judge is complete before verification begins. Persist this
        // transition now so lifecycle logs cannot imply overlap or inversion.
        finishStep(state, "synthesize", "done", passDetail(judge), judge.costUsd);

        // 2) Verify pass. Verification failing is NOT a schema-validation failure
        //    (the judge output is valid) — do not burn a retry; persist the
        //    unverified judge output. Mark verify "error" with the detail.
        let verificationRate: number | null = null;
        let verifiedReport: Report | null = null;
        let verifyLog: unknown = undefined;
        let verifyError: string | null = null;
        startStep(state, "verify");
        try {
          const fetchedUrls = [
            ...new Set(
              [...(bull.fetchedUrls ?? []), ...(bear.fetchedUrls ?? []), ...(judge.fetchedUrls ?? [])]
                .flatMap((value) => {
                  const canonical = canonicalizeFetchedUrl(value);
                  return canonical ? [canonical] : [];
                }),
            ),
          ].sort();
          const v = await awaitJobStage(
            passes.runVerifyPass(deps, judge.data, { fetchedUrls }),
            jobSignal,
            jobController,
            "verify",
            modelStageDeadlineMs,
          );
          throwIfJobAborted(jobSignal);
          verificationRate = v.verificationRate;
          verifiedReport = v.verifiedReport;
          verifyLog = v.log;
          if (typeof v.costUsd === "number") {
            logPassCost(state, "verify", {
              model: v.model ?? analysisModel,
              costUsd: v.costUsd,
              fallbackUsed: v.fallbackUsed ?? false,
              usage: v.usage,
              webSearches: v.webSearches,
            });
          }
        } catch (err) {
          throwIfJobAborted(jobSignal);
          verifyError = errMessage(err);
          updateRunningStepDetail(
            state,
            "verify",
            `verify failed; assembling unverified report: ${verifyError}`,
          );
        }

        // 3) Assemble the final Report. A throw here is a report-schema (Zod)
        //    validation failure — retryable per SPEC §2 (re-invoke the judge).
        const meta = buildMeta(verificationRate, judge);
        const costBreakdown = buildCostBreakdown(state);
        let report: Report;
        try {
          report =
            verifiedReport ??
            passes.assembleReport({
              judgeOutput: judge.data,
              bundle,
              computed,
              validation,
              meta,
              verificationRate,
              verificationLog: verifyLog,
              costBreakdown,
            });
        } catch (err) {
          lastValidationDetail = errMessage(err);
          // The judge output parsed but failed report-schema validation — echo it
          // back (JSON) so the retry repairs rather than regenerates.
          try {
            lastFailedRawOutput = rawTextOfError(err) || JSON.stringify(judge.data).slice(0, JUDGE_RETRY_RAW_OUTPUT_CAP);
          } catch {
            lastFailedRawOutput = "";
          }
          lastJudgeFailureRetryable = true;
          const retrying = attempt < maxJudgeRetries;
          const detail = `report assembly attempt ${attempt + 1}/${maxJudgeRetries + 1} failed${retrying ? "; retrying judge" : ""}: ${lastValidationDetail}`;
          updateRunningStepDetail(state, "synthesize", detail);
          updateRunningStepDetail(state, "verify", detail);
          if (retrying) {
            finishStep(state, "verify", "error", detail);
            startStep(state, "synthesize");
            continue; // feed the Zod error back
          }
          break;
        }

        // Success for this attempt — synthesis already completed before verify.
        if (verifyError !== null) {
          finishStep(state, "verify", "error", verifyError);
        } else {
          finishStep(
            state,
            "verify",
            "done",
            `citation coverage ${verificationRate === null ? "n/a" : (verificationRate * 100).toFixed(1) + "%"}`,
          );
        }
        assembled = { report, verificationRate, verifyLog, meta, costBreakdown };
        break;
      }

      // Retries exhausted (or judge/assemble never validated) — fail LOUDLY on
      // synthesize with the validation detail and persist data-only. verify is
      // only marked "error" if it actually ran (a judge attempt succeeded);
      // when the judge never produced output, verify never ran and is honestly
      // "skipped" — same convention as the bull/bear-failure path.
      if (assembled === null) {
        const detail = lastJudgeFailureRetryable
          ? `report failed schema validation after ${maxJudgeRetries + 1} attempt(s): ${lastValidationDetail}`
          : `synthesize failed: ${lastValidationDetail}`;
        finishStep(state, "synthesize", "error", detail);
        if (findStep(state, "verify").status === "pending") {
          markSkipped(state, "verify", `upstream synthesize failed: ${lastValidationDetail}`);
        } else {
          finishStep(state, "verify", "error", detail);
        }
        // Same manifest disclosure as the bull/bear path: the data-only report
        // must carry the judge failure itself, not just the transient step UI.
        computed.gaps.push({
          field: "llm.judge",
          reason: detail,
          severity: "critical",
          attemptedSources: ["anthropic"],
        });
        return persistDataOnly(state, bundle, validation, computed, now, hasKey);
      }

      const { report, verificationRate, verifyLog, meta, costBreakdown } = assembled;
      meta.completedAt = findStep(state, "verify").completedAt ?? findStep(state, "verify").finishedAt;

      // Reconcile runner-owned meta onto the assembled report (cost/rate/model
      // are the runner's source of truth; the passes may not know the final cost).
      const finalReport = reconcileMeta(report, meta, costBreakdown, verifyLog);

      const validated = ReportSchema.safeParse(finalReport);
      if (!validated.success) {
        const detail = `final report failed Zod validation after reconciliation: ${validated.error.issues
          .slice(0, 3)
          // Do not echo rejected prose into the data-only manifest: doing so can
          // reproduce the same prohibited content and invalidate the fallback.
          .map((issue) => `${issue.path.join(".") || "$"}: schema constraint violation`)
          .join("; ")}`;
        computed.gaps.push({
          field: "report.finalValidation",
          reason: detail,
          severity: "critical",
        });
        // The durable record of this failure is the critical manifest gap above
        // (it lands in the persisted data-only report). Do NOT also write it to
        // jobs.error: persistDataOnly finishes the job "done" with error:null,
        // so an error write here would be dead within the same tick.
        persistSteps(state);
        return persistDataOnly(state, bundle, validation, computed, now, hasKey);
      }
      const reportId = persistReport(
        state,
        validated.data,
        analysisModel,
        verificationRate,
        "done",
      );

      return finishRun(state, {
        reportId,
        verificationRate,
        dataOnly: false,
      });
    };

    // -- resume: reuse persisted analyst passes --------------------------------
    const resumeSnapshots = opts.resume === true ? readPassSnapshots(jobId) : null;
    const resumeMissingSides = resumeSnapshots
      ? (["bull", "bear"] as const).filter((side) => resumeSnapshots[side] === null)
      : [];
    // A partial snapshot needs the single-side runner; without it (mocks, the
    // noop facade) fall through to a fresh full run — safe, just re-bills.
    const canResume =
      resumeSnapshots !== null &&
      (resumeMissingSides.length === 0 || typeof passes.runAnalystPass === "function");
    if (resumeSnapshots !== null && canResume) {
      // The original bull/bear cost_log rows live under this same jobId; the
      // running total was rehydrated from cost_log at RunState construction,
      // so meta.costUsd stays the job's true all-in cost. The reused passes
      // are NOT re-logged.
      for (const side of ["bull", "bear"] as const) {
        const snapshot = resumeSnapshots[side];
        if (snapshot === null) continue;
        startStep(state, side);
        finishStep(
          state,
          side,
          "done",
          `reused persisted result from previous attempt (resume) — ${passDetail(snapshot)}`,
          snapshot.costUsd,
        );
      }
      if (
        fingerprint !== null &&
        resumeSnapshots.payloadFingerprint !== null &&
        fingerprint !== resumeSnapshots.payloadFingerprint
      ) {
        // Disclose, don't fail: the analyst cases cite the ORIGINAL data
        // snapshot while the judge sees the rebuilt payload (typically a
        // fresher quote/EOD bar). computed.gaps flows into the report's
        // missing-data manifest at assembly time.
        computed.gaps.push({
          field: "analysis.resume",
          reason:
            "resumed from persisted bull/bear analyst passes generated against an earlier data snapshot (payload fingerprint drifted between runs)",
          severity: "warn",
          attemptedSources: ["pipeline"],
        });
      }
      // Re-run ONLY the missing side(s) — the sibling's paid output is reused
      // (2026-07-10: one-sided analyst failures no longer discard the pair).
      let resumedBull = resumeSnapshots.bull;
      let resumedBear = resumeSnapshots.bear;
      for (const side of resumeMissingSides) {
        startStep(state, side);
        try {
          const fresh = await awaitJobStage(
            passes.runAnalystPass!(deps, side),
            jobSignal,
            jobController,
            side,
            modelStageDeadlineMs,
          );
          throwIfJobAborted(jobSignal);
          logPassCost(state, side, fresh);
          finishStep(state, side, "done", passDetail(fresh), fresh.costUsd);
          persistPassSnapshot(state, side, fresh);
          if (side === "bull") resumedBull = fresh;
          else resumedBear = fresh;
        } catch (err) {
          throwIfJobAborted(jobSignal);
          // Same degradation contract as the fresh-run analyst catch: record
          // billed spend, disclose the failure in the manifest, data-only.
          const billedAttempt = billedAttemptFromError(err);
          if (billedAttempt !== null) logPassCost(state, side, billedAttempt);
          finishStep(state, side, "error", errMessage(err), billedAttempt?.costUsd);
          computed.gaps.push({
            field: `llm.${side}`,
            reason: errMessage(err),
            severity: "critical",
            attemptedSources: ["anthropic"],
          });
          markSkipped(state, "synthesize", "upstream bull/bear pass failed");
          markSkipped(state, "verify", "upstream bull/bear pass failed");
          return persistDataOnly(state, bundle, validation, computed, now, hasKey);
        }
      }
      // `await` so a rejection is caught by the outer catch (error recording).
      return await runSynthesisAndFinish(resumedBull!, resumedBear!);
    }

    // -- bull + bear ----------------------------------------------------------
    // Per-pass timing comes from the hooks (the passes overlap in the
    // streaming path); ensureStepStarted backfills for hook-less mocks so a
    // step never jumps pending -> terminal.
    const analystHooks: AnalystPassHooks = {
      onPassStart: (side) => startStep(state, side),
      onPassFinish: (side) => stampStepFinished(state, side),
    };
    let bull: PassResultLike<AnalystCase> | null = null;
    let bear: PassResultLike<AnalystCase> | null = null;
    try {
      const cases = await awaitJobStage(
        passes.runBullThenBear(deps, analystHooks),
        jobSignal,
        jobController,
        "bull/bear",
        modelStageDeadlineMs,
      );
      throwIfJobAborted(jobSignal);
      bull = cases.bull;
      bear = cases.bear;
      ensureStepStarted(state, "bull");
      ensureStepStarted(state, "bear");
      logPassCost(state, "bull", bull);
      logPassCost(state, "bear", bear);
      finishStep(state, "bull", "done", passDetail(bull), bull.costUsd);
      finishStep(state, "bear", "done", passDetail(bear), bear.costUsd);
    } catch (err) {
      throwIfJobAborted(jobSignal);
      // Adversarial passes failed — mark both error and fall through to a
      // data-only stub (we still have fetch/validate/compute).
      ensureStepStarted(state, "bull");
      ensureStepStarted(state, "bear");
      const partial = bullBearFailureFromError(err);
      if (partial !== null) {
        finishAnalystSide(
          state,
          "bull",
          partial.bull,
          partial.bullError,
          partial.bullBilledAttempt,
          errMessage(err),
        );
        finishAnalystSide(
          state,
          "bear",
          partial.bear,
          partial.bearError,
          partial.bearBilledAttempt,
          errMessage(err),
        );
      } else {
        finishStep(state, "bull", "error", errMessage(err));
        finishStep(state, "bear", "error", errMessage(err));
      }
      // Disclose the per-pass failures in the report's missing-data manifest —
      // the report page has no access to step details, so without these the
      // data-only report could not say WHY analysis is absent (2026-07-10:
      // transport failures were only visible on the transient pipeline view).
      // A side that DID succeed is persisted (with the fingerprint) so its
      // paid output survives for a partial resume instead of being discarded.
      for (const side of ["bull", "bear"] as const) {
        const sideResult = side === "bull" ? partial?.bull : partial?.bear;
        if (sideResult !== undefined) {
          persistPassSnapshot(state, side, sideResult);
          persistPayloadFingerprint(state, fingerprint);
          continue; // side succeeded — not a gap
        }
        const sideError = side === "bull" ? partial?.bullError : partial?.bearError;
        computed.gaps.push({
          field: `llm.${side}`,
          reason: sideError ?? errMessage(err),
          severity: "critical",
          attemptedSources: ["anthropic"],
        });
      }
      markSkipped(state, "synthesize", "upstream bull/bear pass failed");
      markSkipped(state, "verify", "upstream bull/bear pass failed");
      return persistDataOnly(state, bundle, validation, computed, now, hasKey);
    }

    // Persist the analyst snapshots + fingerprint BEFORE synthesis: if the
    // judge fails, a later retry resumes from here without re-billing the
    // expensive passes (a partial bull/bear failure is not resumable — the
    // judge needs the full adversarial pair, so only full success persists).
    persistPassSnapshot(state, "bull", bull);
    persistPassSnapshot(state, "bear", bear);
    persistPayloadFingerprint(state, fingerprint);

    return await runSynthesisAndFinish(bull, bear);
  } catch (err) {
    if (jobSignal.aborted) {
      return abortRun(state, abortReason(jobSignal));
    }
    // Unexpected orchestration failure — record and re-surface (the POST route
    // has already returned; this rejects the detached promise).
    persistSteps(state, "error", errMessage(err));
    publish(state, { type: "error", jobId, message: errMessage(err) });
    throw err;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(overallTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    liveJobIds().delete(jobId);
    if (liveJobControllers().get(jobId) === jobController) {
      liveJobControllers().delete(jobId);
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Terminal helpers
 * ------------------------------------------------------------------------ */

function finishRun(
  state: RunState,
  out: { reportId: number | null; verificationRate: number | null; dataOnly: boolean },
): RunJobResult {
  const doneEvent: JobEvent = {
    type: "done",
    jobId: state.jobId,
    reportId: out.reportId,
    verificationRate: out.verificationRate,
    totalCostUsd: round4(state.totalCostUsd),
    dataOnly: out.dataOnly,
  };
  publish(state, doneEvent);
  return {
    jobId: state.jobId,
    status: "done",
    reportId: out.reportId,
    verificationRate: out.verificationRate,
    totalCostUsd: round4(state.totalCostUsd),
    dataOnly: out.dataOnly,
  };
}

/** Terminal failure that leaves nothing to persist (e.g. fetch hard-failed). */
function failRun(state: RunState, step: PipelineStep, err: unknown): RunJobResult {
  finishStep(state, step, "error", errMessage(err));
  // Any steps not yet started become skipped for a clean strip.
  for (const s of state.steps) {
    if (s.status === "pending") {
      s.status = "skipped";
      s.detail = `not reached — ${step} failed`;
    }
  }
  persistSteps(state, "error", errMessage(err));
  publish(state, { type: "error", jobId: state.jobId, message: errMessage(err) });
  return {
    jobId: state.jobId,
    status: "error",
    reportId: null,
    verificationRate: null,
    totalCostUsd: round4(state.totalCostUsd),
    dataOnly: false,
  };
}

/** Terminal cancellation/deadline: never persists a partial or misleading report. */
function abortRun(state: RunState, reason: unknown): RunJobResult {
  const message = errMessage(reason);
  for (const step of state.steps) {
    if (step.status === "running") {
      step.status = "error";
      step.finishedAt = nowIso();
      step.completedAt = step.finishedAt;
      step.detail = message;
      emitStep(state, step.step);
    } else if (step.status === "pending") {
      step.status = "skipped";
      step.detail = `not reached — ${message}`;
    }
  }
  persistSteps(state, "error", message);
  publish(state, { type: "error", jobId: state.jobId, message });
  return {
    jobId: state.jobId,
    status: "error",
    reportId: null,
    verificationRate: null,
    totalCostUsd: round4(state.totalCostUsd),
    dataOnly: false,
  };
}

/**
 * Persist a data-only Report stub (meta + appendix + empty graded sections
 * flagged) and finish the job "done". Used for the no-key path and for
 * degraded LLM-failure paths so the UI always gets a renderable report.
 */
function persistDataOnly(
  state: RunState,
  bundle: DataBundle,
  validation: ValidationReport,
  computed: ComputedMetrics | null,
  now: () => Date,
  hasKey: boolean,
): RunJobResult {
  const generatedAt = now().toISOString();
  const model = hasKey ? "unavailable" : "none (no ANTHROPIC_API_KEY)";
  const dataOnlyInput: DataOnlyInput = {
    symbol: state.symbol,
    companyName: companyNameOf(bundle, state.symbol),
    generatedAt,
    model,
    costUsd: state.totalCostUsd,
    bundle,
    validation,
    computed,
    costBreakdown: buildCostBreakdown(state),
    reason: hasKey
      ? "LLM analysis could not complete — the failed pass errors are disclosed in the missing-data manifest; this is a data-only report."
      : NO_KEY_SKIP_REASON,
  };
  const report = buildDataOnlyReport(dataOnlyInput);
  const validated = ReportSchema.safeParse(report);
  let validatedReport: Report;
  if (validated.success) {
    validatedReport = validated.data;
  } else {
    // Provider/model error strings and source metadata are untrusted. Never use
    // a failed parse as permission to persist an invalid report. Rebuild one
    // sterile, fully disclosed data-only shell without the rejected metadata.
    const fallback = buildDataOnlyReport({
      ...dataOnlyInput,
      companyName: state.symbol,
      reason:
        "Analysis and unsafe degraded-path metadata were withheld because the final report safety schema rejected them.",
    });
    fallback.meta.asOfMap = {};
    fallback.appendix.sources = [];
    fallback.appendix.missingData = [
      {
        field: "analysis.llm",
        reason:
          "Analysis unavailable; degraded-path metadata failed the final report safety schema and was withheld.",
        severity: "critical",
        attemptedSources: ["pipeline"],
      },
    ];
    validatedReport = ReportSchema.parse(fallback);
  }
  const reportId = persistReport(
    state,
    validatedReport,
    model,
    null,
    "done",
  );
  return finishRun(state, { reportId, verificationRate: null, dataOnly: true });
}

function markSkipped(state: RunState, step: PipelineStep, reason: string): void {
  const s = findStep(state, step);
  if (s.status === "pending") {
    s.status = "skipped";
    s.startedAt ??= nowIso();
    s.finishedAt = nowIso();
    s.completedAt = s.finishedAt;
    s.detail = reason;
    persistSteps(state);
    emitStep(state, step);
  }
}

/* ------------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------------ */

/** Insert a reports row, link jobs.reportId, return the new report id. */
function persistReport(
  state: RunState,
  report: Report | unknown,
  model: string,
  verificationRate: number | null,
  status: string,
): number {
  const createdAt = nowIso();
  return getDb().transaction((tx) => {
    const inserted = tx
      .insert(reports)
      .values({
        symbol: state.symbol,
        createdAt,
        model,
        status,
        reportJson: JSON.stringify(report),
        verificationRate,
        costUsd: state.totalCostUsd,
        specVersion: REPORT_SPEC_VERSION,
      })
      .returning({ id: reports.id })
      .get();
    const parsed = ReportSchema.safeParse(report);
    if (parsed.success) {
      const persistedReport: Report = {
        ...parsed.data,
        meta: {
          ...parsed.data.meta,
          runId: state.jobId,
          reportId: inserted.id,
          persistedAt: nowIso(),
        },
      };
      tx
        .update(reports)
        .set({ reportJson: JSON.stringify(persistedReport) })
        .where(eq(reports.id, inserted.id))
        .run();
    }
    const completedAt = nowIso();
    tx
      .update(jobs)
      .set({
        reportId: inserted.id,
        status: "done",
        error: null,
        stepsJson: JSON.stringify(state.steps),
        updatedAt: completedAt,
      })
      .where(eq(jobs.id, state.jobId))
      .run();
    return inserted.id;
  });
}

/* ------------------------------------------------------------------------ *
 * Report assembly helpers (data-only stub + meta reconciliation)
 * ------------------------------------------------------------------------ */

function buildCostBreakdown(state: RunState): { step: string; model: string; costUsd: number }[] {
  const rows = getDb()
    .select({ step: costLog.step, model: costLog.model, costUsd: costLog.costUsd })
    .from(costLog)
    .where(eq(costLog.jobId, state.jobId))
    .all();
  return rows.map((r) => ({ step: r.step, model: r.model, costUsd: r.costUsd }));
}

/** Sum of every cost_log row already recorded for a job (resume rehydration). */
function sumLoggedCost(jobId: string): number {
  const rows = getDb()
    .select({ costUsd: costLog.costUsd })
    .from(costLog)
    .where(eq(costLog.jobId, jobId))
    .all();
  return rows.reduce((acc, r) => acc + r.costUsd, 0);
}

/**
 * Reconcile the runner-owned meta + appendix cost/verification fields onto a
 * Report the passes assembled (the passes may not know the final cost or the
 * complete cost breakdown). Non-destructive: only overwrites meta and the
 * cost/verification appendix fields, leaving section content untouched.
 */
function reconcileMeta(
  report: Report,
  meta: ReportMetaInput,
  costBreakdown: { step: string; model: string; costUsd: number }[],
  verifyLog: unknown,
): Report {
  const next: Report = {
    ...report,
    meta: {
      ...report.meta,
      symbol: meta.symbol,
      companyName: meta.companyName || report.meta.companyName,
      generatedAt: meta.generatedAt,
      specVersion: REPORT_SPEC_VERSION,
      model: meta.model,
      pipelineVersion: PIPELINE_VERSION,
      costUsd: meta.costUsd,
      verificationRate: meta.verificationRate,
      disclaimer: DISCLAIMER_TEXT,
      asOfMap: { ...meta.asOfMap, ...report.meta.asOfMap },
      execution: meta.execution ?? report.meta.execution,
      dataCompleteness: report.meta.dataCompleteness,
      runId: meta.runId ?? report.meta.runId,
      startedAt: meta.startedAt ?? report.meta.startedAt,
      completedAt: meta.completedAt ?? report.meta.completedAt,
    },
    appendix: {
      ...report.appendix,
      verificationRate: meta.verificationRate,
      costBreakdown: costBreakdown.length > 0
        ? costBreakdown.map((entry) => {
            const execution = meta.execution?.find((item) => item.step === entry.step);
            return execution
              ? {
                  ...entry,
                  requestedModel: execution.requestedModel,
                  requestedEffort: execution.requestedEffort,
                  effectiveEffort: execution.effectiveEffort,
                  fallbackUsed: execution.fallbackUsed,
                  adjustments: execution.adjustments,
                }
              : entry;
          })
        : report.appendix.costBreakdown,
    },
  };
  if (verifyLog !== undefined && Array.isArray(verifyLog)) {
    next.appendix.verificationLog = verifyLog as Report["appendix"]["verificationLog"];
  }
  return next;
}

/** Best-effort company name from the profile row; falls back to the symbol. */
function companyNameOf(bundle: DataBundle, symbol: string): string {
  if (bundle.profile.ok) {
    const row = bundle.profile.value.data.rows[0];
    const name = row?.companyName;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return symbol;
}

/** Convert bundle + validation gaps into report ManifestEntry appendix rows. */
function collectMissingData(
  bundle: DataBundle,
  validation: ValidationReport,
  computed: ComputedMetrics | null,
): ManifestEntry[] {
  const all: ManifestEntry[] = [...bundle.gaps, ...validation.gaps];
  if (computed !== null) all.push(...computed.gaps);
  // Dedup by field+reason, keep the highest severity first.
  const seen = new Set<string>();
  const order: Record<ManifestEntry["severity"], number> = { critical: 0, warn: 1, info: 2 };
  return all
    .filter((g) => {
      const key = `${g.field}::${g.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Source-entry appendix rows from the bundle's asOf map (provider/endpoint best-effort). */
function collectSources(bundle: DataBundle): Report["appendix"]["sources"] {
  const out: Report["appendix"]["sources"] = [];
  for (const [field, asOf] of Object.entries(bundle.asOf)) {
    out.push({
      provider: field.split(".")[0] ?? field,
      endpoint: field,
      asOf,
      fetchedAt: bundle.builtAt,
    });
  }
  return out.sort((a, b) => (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0));
}

interface DataOnlyInput {
  symbol: string;
  companyName: string;
  generatedAt: string;
  model: string;
  costUsd: number;
  bundle: DataBundle;
  validation: ValidationReport;
  computed: ComputedMetrics | null;
  costBreakdown: { step: string; model: string; costUsd: number }[];
  reason: string;
}

/**
 * Build a data-only Report: real meta + appendix (sources/manifest/cost), and
 * every graded section carrying a single "F" GradeBlock whose reasoning is the
 * data-only disclaimer. This is a valid Report per the Zod schema so the UI can
 * render + persist it; every section is explicitly flagged as ungraded because
 * the LLM analysis did not run.
 */
export function buildDataOnlyReport(input: DataOnlyInput): Report {
  const { symbol, bundle, validation, computed } = input;
  const asOfMap = { ...bundle.asOf };
  const flagClaim = {
    text: `LLM analysis did not run — ${input.reason}. This section is data-only and ungraded.`,
    label: "JUDGMENT" as const,
    source: "pipeline",
    asOf: null,
  };
  const grade = (): Report["verdict"]["gradeStrip"]["fundamentals"] => ({
    grade: "F",
    oneLineWhy: "Ungraded — data-only report (LLM analysis did not run).",
    reasoning: [flagClaim],
    confidence: "low",
    keyNumbers: [],
  });

  const missingData = collectMissingData(bundle, validation, computed);
  const emptyCoverage: ProvenanceCoverage = {
    numeric: { supported: 0, total: 0, rate: null },
    factualClaims: { supported: 0, total: 0, rate: null },
    judgments: { cited: 0, total: 0, rate: null },
  };
  // Record the data-only condition itself as a critical manifest entry.
  missingData.unshift({
    field: "analysis.llm",
    reason: input.reason,
    severity: "critical",
    attemptedSources: ["anthropic"],
  });

  const report: Report = {
    meta: {
      symbol,
      companyName: input.companyName,
      generatedAt: input.generatedAt,
      specVersion: REPORT_SPEC_VERSION,
      model: input.model,
      pipelineVersion: PIPELINE_VERSION,
      costUsd: input.costUsd,
      verificationRate: null,
      provenanceCoverage: emptyCoverage,
      dataCompleteness: buildDataCompleteness(missingData),
      disclaimer: DISCLAIMER_TEXT,
      asOfMap,
    },
    verdict: {
      synthesis:
        "Data-only report: the grounded LLM analysis passes did not run, so no synthesis, grades, or scenarios are available. The appendix lists the fetched sources and every disclosed data gap.",
      gradeStrip: {
        fundamentals: grade(),
        valuation: grade(),
        technicals: grade(),
        quality: grade(),
        leadership: grade(),
        moat: grade(),
      },
    },
    business: {
      whatTheySell: [flagClaim],
      segments: { product: [], geographic: [] },
      concentrationRisks: [],
    },
    fundamentals: {
      graded: grade(),
      growthTable: [],
      marginTrend: [],
      returns: [],
      fcf: [],
      commentary: [flagClaim],
    },
    balanceSheet: {
      debtProfile: { commentary: [flagClaim], numbers: [] },
      coverage: { commentary: [], numbers: [] },
      capexTrajectory: { commentary: [], numbers: [] },
      capitalAllocation: [],
    },
    valuation: {
      graded: grade(),
      dcf: {
        perShare: null,
        assumptions: [],
        sensitivityGrid: [],
        upsidePct: null,
      },
      reverseDcf: {
        impliedMetric: "n/a",
        impliedValue: null,
        narrative: "Data-only report — no reverse-DCF computed.",
      },
      multiples: [],
      scenarios: [
        {
          name: "bull",
          probability: null,
          priceTarget: null,
          horizon: "n/a",
          assumptions: ["Data-only report — no scenario modeling performed."],
          whatWouldHaveToBeTrue: ["LLM analysis would have to run."],
        },
        {
          name: "base",
          probability: null,
          priceTarget: null,
          horizon: "n/a",
          assumptions: ["Data-only report — no scenario modeling performed."],
          whatWouldHaveToBeTrue: ["LLM analysis would have to run."],
        },
        {
          name: "bear",
          probability: null,
          priceTarget: null,
          horizon: "n/a",
          assumptions: ["Data-only report — no scenario modeling performed."],
          whatWouldHaveToBeTrue: ["LLM analysis would have to run."],
        },
      ],
    },
    quality: {
      graded: grade(),
      forensicScores: {
        altman: naScore(),
        beneish: naScore(),
        piotroski: naScore(),
        accruals: naScore(),
      },
      flags: [],
    },
    technicals: {
      graded: grade(),
      read: {
        trend: "Data-only report — no technical read.",
        momentum: "Data-only report — no technical read.",
        keyLevels: "Data-only report — no technical read.",
        relativeStrength: "Data-only report — no technical read.",
      },
      indicators: [],
      flags: [],
    },
    leadership: {
      graded: grade(),
      executives: [],
      insiderSummary: [],
      governanceNotes: [flagClaim],
    },
    competitive: {
      moatGraded: grade(),
      peerTable: [],
      moatAssessment: [],
      marketShareDirection: "Data-only report — no competitive assessment.",
    },
    catalystsRisks: { catalysts: [], risks: [] },
    outlook: {
      segmentTrajectories: [],
      estimateRevisionTrend: [],
      guidanceCredibility: [],
      scenarioNarratives: { y1: [flagClaim], y3: [], y5: [] },
    },
    macro: {
      relevantSeries: [],
      sensitivityNotes: [],
      fredAttribution: FRED_ATTRIBUTION_TEXT,
    },
    appendix: {
      sources: collectSources(bundle),
      missingData,
      verificationRate: null,
      provenanceCoverage: emptyCoverage,
      costBreakdown: input.costBreakdown,
    },
    disagreements: [],
  };
  return report;
}

function naScore(): Report["quality"]["forensicScores"]["altman"] {
  return {
    variant: "n/a",
    score: null,
    zone: null,
    notApplicableReason: "Data-only report — forensic scores not computed by this path.",
  };
}

/* ------------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------------ */

function passDetail(pass: PassResultLike<unknown>): string {
  const parts = [`model ${pass.model}`, `$${pass.costUsd.toFixed(4)}`];
  if (pass.fallbackUsed) parts.push("fallback served");
  return parts.join(", ");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function gapFor(field: string, err: unknown): ManifestEntry {
  return { field: `pipeline.${field}`, reason: errMessage(err), severity: "warn" };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
