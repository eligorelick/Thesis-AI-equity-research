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

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, type ThesisDb } from "@/db";
import { costLog, jobPassArtifacts, jobs, reports, type JobRow } from "@/db/schema";
import { getConfig } from "@/config/env";
import {
  maximumPassCostUsd,
  resolveModel,
  type VerifyReservationCapability,
} from "@/providers/anthropic";
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
import { sourceManifestEntries, type DataBundle } from "@/pipeline/types";
import { canonicalizeFetchedUrl } from "@/pipeline/stageC/provenance";
import {
  getJobSnapshot,
  publishJobEvent,
  reportJsonIsDataOnly,
  type JobEvent,
} from "@/pipeline/events";
import { mutateJobSnapshotInTransaction } from "@/pipeline/jobState";
import { normalizeLinkedReportRecoverySteps } from "@/pipeline/jobSteps";
import {
  classifyInstrumentSupport,
  type InstrumentSupport,
} from "@/pipeline/stageB/instrumentSupport";
import {
  PassSettlementHookError,
  parseLegacyAnalystSnapshot,
  serializePassFailure,
  type DurablePass,
  type ComputedJobResumePlan,
  type PassSettlement,
  type PassSettlementHook,
  type PassTelemetry,
} from "@/pipeline/jobArtifacts";
import {
  readQueuedSourceJobResumeInTransaction,
  readStoredJobResumeInTransaction,
} from "@/pipeline/jobStore";
import {
  acquirePaidPassLease,
  authorizePaidPassLaunch,
  claimQueuedJobById,
  configuredSchedulerLimits,
  reconcileExpiredJobClaims,
  reconcileExpiredSchedulerStateInTransaction,
  releaseUnbilledPaidPassLease,
  renewJobLease,
  renewPaidPassLease,
  settlePaidPassLease,
  PaidPassOverReservationError,
  type JobClaim,
  type PaidPassLease,
  type SchedulerLimits,
  type SettlePaidPassResult,
} from "@/pipeline/jobScheduler";

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
  /** False only when cache sequencing prevented this provider pass from launching. */
  bullLaunched?: boolean;
  bearLaunched?: boolean;
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
  readonly bullLaunched?: boolean;
  readonly bearLaunched?: boolean;

  constructor(message: string, details: BullBearPassFailureDetails) {
    super(message);
    this.name = "BullBearPassFailure";
    this.bull = details.bull;
    this.bear = details.bear;
    this.bullError = details.bullError;
    this.bearError = details.bearError;
    this.bullBilledAttempt = details.bullBilledAttempt;
    this.bearBilledAttempt = details.bearBilledAttempt;
    this.bullLaunched = details.bullLaunched;
    this.bearLaunched = details.bearLaunched;
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
   * Proves that every adapter method awaits the runner's durable launch-
   * authority callback at its immediate provider/logical execution boundary.
   * Adapters without this capability fail closed before model resolution.
   */
  launchAuthorityCapability?: typeof DURABLE_LAUNCH_AUTHORITY_CAPABILITY;
  /** Verify is provider-free only when this explicit capability says so. */
  verifyCapability?: VerifyReservationCapability;
  /**
   * Validate the exact forthcoming request against the finite provider bounds
   * before the runner acquires a paid lease. Production implements this for
   * every provider-backed pass; deterministic verify is a no-op.
   */
  preflightPass?(
    deps: PassDeps<TPayload>,
    request:
      | { pass: "bull" | "bear" }
      | {
          pass: "synthesize";
          bull: PassResultLike<AnalystCase>;
          bear: PassResultLike<AnalystCase>;
          validationFeedback?: string;
        }
      | {
          pass: "verify";
          judgeOutput: JudgeOutput;
          evidence: { fetchedUrls: string[] };
        },
  ): void | Promise<void>;
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
    settlements?: AnalystSettlementHooks,
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
    settlement?: PassSettlementHook<AnalystCase>,
    beforeProviderLaunch?: () => void | Promise<void>,
  ): Promise<PassResultLike<AnalystCase>>;

  /** Judge/synthesis pass: bull + bear + payload → JudgeOutput (report minus meta/appendix). */
  runJudgePass(
    deps: PassDeps<TPayload>,
    bull: PassResultLike<AnalystCase>,
    bear: PassResultLike<AnalystCase>,
    validationFeedback?: string,
    settlement?: PassSettlementHook<JudgeOutput>,
    beforeProviderLaunch?: () => void | Promise<void>,
  ): Promise<PassResultLike<JudgeOutput>>;

  /** Verification pass: trace every numeric claim; returns the verified Report + rate. */
  runVerifyPass(
    deps: PassDeps<TPayload>,
    judgeOutput: JudgeOutput,
    evidence?: { fetchedUrls: string[] },
    settlement?: PassSettlementHook<Report>,
    beforeProviderLaunch?: () => void | Promise<void>,
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
  /** Awaited paid-permit gate immediately before this provider side launches. */
  beforePass?: (side: "bull" | "bear") => void | Promise<void>;
  /**
   * Awaited, non-swallowed durable authority fence at the immediate provider
   * boundary. Timing/telemetry hooks below remain best-effort by design.
   */
  beforeProviderLaunch?: (side: "bull" | "bear") => void | Promise<void>;
  onPassStart?: (side: "bull" | "bear") => void;
  onPassFinish?: (side: "bull" | "bear") => void;
}

/** Awaited, durable per-side settlement callbacks (trailing/optional compatibility). */
export interface AnalystSettlementHooks {
  bull?: PassSettlementHook<AnalystCase>;
  bear?: PassSettlementHook<AnalystCase>;
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

/** Adapter contract for the non-swallowed immediate pre-provider authority fence. */
export const DURABLE_LAUNCH_AUTHORITY_CAPABILITY = "durable-preprovider-v1" as const;

/** Honest degraded-mode reason for legacy/injected adapters lacking that fence. */
export const LAUNCH_AUTHORITY_SKIP_REASON =
  "Stage C adapter lacks durable pre-provider launch authority" as const;

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
export type JobStatus = "queued" | "running" | "done" | "error" | "unsupported";

/** The durable row moved to another generation/owner while this worker was alive. */
class SupersededRunError extends Error {
  constructor(jobId: string, runGeneration: number) {
    super(`jobRunner: job "${jobId}" generation ${runGeneration} was superseded`);
    this.name = "SupersededRunError";
  }
}

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
  runGeneration: number;
  revision: number;
  claim: JobClaim;
  schedulerLimits: SchedulerLimits;
  steps: StepProgress[];
  totalCostUsd: number;
}

type JobEventPayload = JobEvent extends infer Event
  ? Event extends JobEvent
    ? Omit<Event, "revision">
    : never
  : never;

interface LiveAuthorityRow {
  revision: number;
  stepsJson: string;
}

/**
 * Acquire SQLite write authority before sampling wall time. Every runner-owned
 * mutation uses this primitive so a writer-lock wait can never resurrect an
 * owner whose durable lease expired while blocked.
 */
function withLiveRunAuthority<T>(
  state: RunState,
  expectedRevision: number | null,
  work: (db: ThesisDb, row: LiveAuthorityRow, authorityAt: string) => T,
): { authorized: true; value: T } | { authorized: false } {
  return getDb().transaction((tx) => {
    const authorityAt = new Date().toISOString();
    const row = tx.select({
      runGeneration: jobs.runGeneration,
      revision: jobs.revision,
      status: jobs.status,
      leaseOwner: jobs.leaseOwner,
      leaseExpiresAt: jobs.leaseExpiresAt,
      stepsJson: jobs.stepsJson,
    }).from(jobs).where(eq(jobs.id, state.jobId)).get();
    if (
      row === undefined ||
      row.runGeneration !== state.runGeneration ||
      row.status !== "running" ||
      row.leaseOwner !== state.claim.leaseOwner ||
      row.leaseExpiresAt === null ||
      row.leaseExpiresAt <= authorityAt ||
      (expectedRevision !== null && row.revision !== expectedRevision)
    ) {
      return { authorized: false } as const;
    }
    return {
      authorized: true,
      value: work(tx as ThesisDb, row, authorityAt),
    } as const;
  }, { behavior: "immediate" });
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
  const persisted = withLiveRunAuthority(state, null, (db, _row, authorityAt) => {
    const canonicalSteps = status === "error"
      ? state.steps.map((step): StepProgress => {
          if (step.status === "running") {
            return {
              ...step,
              status: "error",
              detail: error ?? "job failed",
              finishedAt: authorityAt,
              completedAt: authorityAt,
            };
          }
          if (step.status === "pending") {
            return {
              ...step,
              status: "skipped",
              detail: `not reached â€” ${error ?? "job failed"}`,
            };
          }
          return step;
        })
      : state.steps;
    const set: Record<string, unknown> = {
      stepsJson: JSON.stringify(canonicalSteps),
    };
    if (status !== undefined) {
      set.status = status;
      if (status === "done" || status === "error" || status === "unsupported") {
        set.leaseOwner = null;
        set.leaseExpiresAt = null;
        set.heartbeatAt = null;
      }
      if (status !== "unsupported") {
        set.unsupportedKind = null;
        set.unsupportedMessage = null;
      }
    }
    if (error !== undefined) set.error = error;
    const result = mutateJobSnapshotInTransaction(db, {
      jobId: state.jobId,
      now: new Date(authorityAt),
      fence: {
        runGeneration: state.runGeneration,
        status: "running",
        leaseOwner: state.claim.leaseOwner,
        leaseValidAfter: authorityAt,
      },
      mutate: () => set,
    });
    if (result === null) {
      // withLiveRunAuthority already proved this exact row/fence while holding
      // BEGIN IMMEDIATE. Null therefore means the canonical patch is an exact
      // no-op, not lost authority.
      return { revision: _row.revision, steps: canonicalSteps };
    }
    return { revision: result.revision, steps: canonicalSteps };
  });
  if (!persisted.authorized) {
    throw new SupersededRunError(state.jobId, state.runGeneration);
  }
  state.revision = persisted.value.revision;
  state.claim.revision = persisted.value.revision;
  state.steps = persisted.value.steps;
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
function publish(_state: RunState, event: JobEventPayload): void {
  const current = getDb()
    .select({
      runGeneration: jobs.runGeneration,
      revision: jobs.revision,
      status: jobs.status,
      leaseOwner: jobs.leaseOwner,
      leaseExpiresAt: jobs.leaseExpiresAt,
    })
    .from(jobs)
    .where(eq(jobs.id, _state.jobId))
    .get();
  const live =
    current?.runGeneration === _state.runGeneration &&
    current.status === "running" &&
    current.leaseOwner === _state.claim.leaseOwner &&
    current.leaseExpiresAt !== null &&
    current.leaseExpiresAt > nowIso();
  const terminal = current?.runGeneration === _state.runGeneration && (
    (event.type === "done" && current.status === "done") ||
    (event.type === "error" && current.status === "error") ||
    (event.type === "unsupported" && current.status === "unsupported")
  );
  if ((live || terminal) && current !== undefined) {
    publishJobEvent({ ...event, revision: current.revision } as JobEvent);
  }
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

function sumLoggedStepCost(jobId: string, step: PipelineStep, db: ThesisDb = getDb()): number {
  const rows = db
    .select({ costUsd: costLog.costUsd })
    .from(costLog)
    .where(and(eq(costLog.jobId, jobId), eq(costLog.step, step)))
    .all();
  return rows.reduce((total, row) => total + row.costUsd, 0);
}

/** Record local timing only; durable completion is published after settlement commit. */
function stampStepFinished(state: RunState, step: PipelineStep): void {
  const s = findStep(state, step);
  s.finishedAt = nowIso();
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

function numOr0(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function canonicalFetchedUrls(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).flatMap((value) => {
        const canonical = canonicalizeFetchedUrl(value);
        return canonical ? [canonical] : [];
      }),
    ),
  ].sort();
}

function telemetryFromPassResult<T>(
  pass: PassResultLike<T>,
  billable = true,
): PassTelemetry {
  return {
    model: pass.model,
    inputTokens: numOr0(pass.usage?.input_tokens),
    outputTokens: numOr0(pass.usage?.output_tokens),
    cacheReadTokens: numOr0(pass.usage?.cache_read_input_tokens),
    cacheWriteTokens: numOr0(pass.usage?.cache_creation_input_tokens),
    webSearches: numOr0(pass.webSearches),
    costUsd: pass.costUsd,
    fallbackUsed: pass.fallbackUsed,
    billable,
    fetchedUrls: canonicalFetchedUrls(pass.fetchedUrls),
  };
}

function telemetryFromAttempt(
  attempt: BilledPassAttempt | null,
  defaultModel: string,
): PassTelemetry {
  return {
    model: attempt?.model ?? defaultModel,
    inputTokens: numOr0(attempt?.usage?.input_tokens),
    outputTokens: numOr0(attempt?.usage?.output_tokens),
    cacheReadTokens: numOr0(attempt?.usage?.cache_read_input_tokens),
    cacheWriteTokens: numOr0(attempt?.usage?.cache_creation_input_tokens),
    webSearches: numOr0(attempt?.webSearches),
    costUsd: attempt?.costUsd ?? 0,
    fallbackUsed: attempt?.fallbackUsed ?? false,
    billable: attempt !== null,
    fetchedUrls: [],
  };
}

function successSettlement<T>(pass: PassResultLike<T>, billable = true): PassSettlement<T> {
  return { outcome: "success", data: pass.data, telemetry: telemetryFromPassResult(pass, billable) };
}

function failureSettlement(
  error: unknown,
  telemetry: PassTelemetry,
  details: { kind?: string; retryable?: boolean } = {},
): PassSettlement<never> {
  return {
    outcome: "failure",
    failure: serializePassFailure(error, details),
    telemetry,
  };
}

function settlementStepDetail<T>(settlement: PassSettlement<T>): string {
  if (settlement.outcome === "failure") return settlement.failure.message;
  return passDetail({
    data: settlement.data,
    model: settlement.telemetry.model,
    costUsd: settlement.telemetry.costUsd,
    fallbackUsed: settlement.telemetry.fallbackUsed,
    usage: {
      input_tokens: settlement.telemetry.inputTokens,
      output_tokens: settlement.telemetry.outputTokens,
      cache_read_input_tokens: settlement.telemetry.cacheReadTokens,
      cache_creation_input_tokens: settlement.telemetry.cacheWriteTokens,
    },
    webSearches: settlement.telemetry.webSearches,
    fetchedUrls: settlement.telemetry.fetchedUrls,
  });
}

/** Adopt the one exact-current settlement snapshot after its outer transaction commits. */
function adoptCommittedSettlement<T>(
  state: RunState,
  pass: DurablePass,
  settlement: PassSettlement<T>,
  persisted: SettlePaidPassResult,
): boolean {
  if (!persisted.currentGeneration) return false;
  if (
    persisted.currentRevision === null ||
    persisted.currentTotalCostUsd === null
  ) {
    if (!persisted.inserted) return true;
    throw new Error("jobRunner: exact-current settlement omitted its canonical snapshot");
  }
  state.revision = persisted.currentRevision;
  state.claim.revision = persisted.currentRevision;
  state.totalCostUsd = persisted.currentTotalCostUsd;
  if (persisted.inserted && settlement.telemetry.billable) {
    publish(state, {
      type: "cost-update",
      jobId: state.jobId,
      step: pass,
      passCostUsd: settlement.telemetry.costUsd,
      totalCostUsd: state.totalCostUsd,
    });
  }
  if (persisted.projectionError !== null) {
    throw new PassSettlementHookError(
      `pass settlement projection failed after immutable commit: ${persisted.projectionError}`,
    );
  }
  if (persisted.currentSteps === null) {
    if (!persisted.inserted) return true;
    throw new Error("jobRunner: exact-current settlement omitted its canonical steps");
  }
  state.steps = persisted.currentSteps;
  if (persisted.inserted) emitStep(state, pass);
  return true;
}

interface SettlementCheckpoint<T> {
  attemptId: string;
  beforeLaunch(): Promise<void>;
  authorizeLaunch(startStepAtBoundary: boolean): void;
  wasLaunched(): boolean;
  releaseIfPrelaunch(): void;
  stopRenewal(): void;
  hasLease(): boolean;
  hook: PassSettlementHook<T>;
  wasCalled(): boolean;
  lastSettlement(): PassSettlement<T> | null;
}

function throwFirstSettlementRejection(outcomes: PromiseSettledResult<unknown>[]): void {
  const rejected = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (rejected) throw rejected.reason;
}

function createSettlementCheckpoint<T>(
  state: RunState,
  pass: DurablePass,
  payloadFingerprint: string | null,
  maximumNextPassUsd: number,
  signal: AbortSignal,
  controller: AbortController,
): SettlementCheckpoint<T> {
  const attemptId = randomUUID();
  let called = false;
  let committed = false;
  let launched = false;
  let last: PassSettlement<T> | null = null;
  let lease: PaidPassLease | null = null;
  let renewal: ReturnType<typeof setInterval> | undefined;
  let permitBackoffMs = 250;

  const stopRenewal = (): void => {
    if (renewal !== undefined) clearInterval(renewal);
    renewal = undefined;
  };
  const beforeLaunch = async (): Promise<void> => {
    if (lease !== null) return;
    while (lease === null) {
      signal.throwIfAborted();
      const acquired = acquirePaidPassLease(
        state.claim,
        pass,
        attemptId,
        maximumNextPassUsd,
        undefined,
        state.schedulerLimits,
      );
      if (acquired.acquired) {
        lease = acquired.lease;
        renewal = setInterval(() => {
          try {
            if (lease !== null && !renewPaidPassLease(lease, undefined, state.schedulerLimits)) {
              stopRenewal();
              controller.abort(new Error(`paid ${pass} lease renewal lost authority`));
            }
          } catch (error) {
            stopRenewal();
            controller.abort(error);
          }
        }, Math.max(1, Math.floor(state.schedulerLimits.paidPassLeaseTtlMs / 4)));
        renewal.unref?.();
        return;
      }
      if (
        acquired.reason !== "capacity" &&
        acquired.reason !== "job-budget-pending" &&
        acquired.reason !== "rolling-budget-pending"
      ) {
        const error = new Error(`paid ${pass} pass blocked by ${acquired.reason}`);
        if (acquired.reason === "revision-headroom" && !controller.signal.aborted) {
          // Near revision exhaustion, degradation cannot safely spend several
          // intermediate revisions. Abort into the runner's one-write terminal
          // path while the reserved terminal slot still exists.
          controller.abort(error);
        }
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => signal.removeEventListener("abort", onAbort);
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, permitBackoffMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          cleanup();
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        timer.unref?.();
      });
      permitBackoffMs = Math.min(1_000, permitBackoffMs * 2);
    }
  };
  const authorizeLaunch = (startStepAtBoundary: boolean): void => {
    signal.throwIfAborted();
    if (lease === null) {
      throw new Error(`paid ${pass} launch authority checked before its durable lease was acquired`);
    }
    const priorSteps = structuredClone(state.steps);
    const authorityNow = new Date();
    if (startStepAtBoundary) {
      const step = findStep(state, pass);
      step.status = "running";
      step.startedAt = authorityNow.toISOString();
      delete step.completedAt;
      delete step.finishedAt;
      delete step.detail;
    }
    let authority: ReturnType<typeof authorizePaidPassLaunch>;
    try {
      authority = authorizePaidPassLaunch(
        lease,
        state.revision,
        JSON.stringify(state.steps),
        undefined,
        state.schedulerLimits,
      );
    } catch (error) {
      // The running transition above is only a candidate snapshot until the
      // exact job + paid-lease fence commits. A database/configuration failure
      // must not leave unpersisted local state that a later degradation path
      // could accidentally publish.
      state.steps = priorSteps;
      if (!controller.signal.aborted) controller.abort(error);
      throw error;
    }
    if (authority === null) {
      state.steps = priorSteps;
      const error = new SupersededRunError(state.jobId, state.runGeneration);
      if (!controller.signal.aborted) controller.abort(error);
      throw error;
    }
    state.revision = authority.revision;
    state.claim.revision = authority.revision;
    state.claim.heartbeatAt = authority.heartbeatAt;
    state.claim.leaseExpiresAt = authority.jobLeaseExpiresAt;
    lease = { ...lease, leaseExpiresAt: authority.paidLeaseExpiresAt };
    launched = true;
    if (startStepAtBoundary) emitStep(state, pass);
  };
  const hook: PassSettlementHook<T> = async (settlement) => {
    if (called) {
      if (committed && JSON.stringify(last) === JSON.stringify(settlement)) return;
      const duplicate = new PassSettlementHookError(
        "conflicting duplicate pass settlement callback",
      );
      if (!controller.signal.aborted) controller.abort(duplicate);
      throw duplicate;
    }
    called = true;
    last = settlement;
    try {
      if (lease === null) {
        throw new Error(`paid ${pass} settlement occurred before its durable lease was acquired`);
      }
      stopRenewal();
      const persisted = settlePaidPassLease(lease, {
        settlement,
        payloadFingerprint,
        step: {
          finishedAt: findStep(state, pass).finishedAt ?? nowIso(),
          detail: settlementStepDetail(settlement),
        },
      });
      // Once settlePaidPassLease returns inserted truth, a later projection
      // error must remain an idempotent committed callback, never a rebill.
      committed = persisted.inserted;
      adoptCommittedSettlement(state, pass, settlement, persisted);
      committed = true;
    } catch (caught) {
      let error = caught;
      if (caught instanceof PaidPassOverReservationError) {
        committed = caught.result.inserted;
        try {
          adoptCommittedSettlement(state, pass, settlement, caught.result);
          committed = true;
        } catch (projectionError) {
          error = projectionError;
        }
      }
      const wrapped = error instanceof PassSettlementHookError
        ? error
        : new PassSettlementHookError(
        `pass settlement persistence failed: ${errMessage(error)}`,
        { cause: error },
      );
      // Settlement persistence is execution authority, not telemetry. Stop a
      // sibling still waiting at its permit gate so it cannot launch after the
      // exact launched result was lost.
      if (!controller.signal.aborted) controller.abort(wrapped);
      throw wrapped;
    }
  };
  return {
    attemptId,
    beforeLaunch,
    authorizeLaunch,
    wasLaunched: () => launched,
    releaseIfPrelaunch: () => {
      if (lease !== null && !launched && !called) {
        stopRenewal();
        releaseUnbilledPaidPassLease(lease);
        lease = null;
      }
    },
    stopRenewal,
    hasLease: () => lease !== null,
    hook,
    wasCalled: () => called,
    lastSettlement: () => last,
  };
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
    candidate.bullBilledAttempt !== undefined ||
    candidate.bullLaunched !== undefined;
  const hasBear =
    candidate.bear !== undefined ||
    candidate.bearError !== undefined ||
    candidate.bearBilledAttempt !== undefined ||
    candidate.bearLaunched !== undefined;
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

/* ------------------------------------------------------------------------ *
 * createJob
 * ------------------------------------------------------------------------ */

/**
 * Insert a fresh "queued" job for a symbol with every step "pending". Returns
 * the generated jobId. Does not start the pipeline; the caller wakes the
 * durable scheduler after the enqueue commits.
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
      queuedAt: now,
      maxCostUsd: getConfig().maxJobCostUsd,
      error: null,
      reportId: null,
      unsupportedKind: null,
      unsupportedMessage: null,
    })
    .run();
  return { jobId };
}

/**
 * Atomically reuse or create the active job for a symbol. The partial unique
 * SQLite index is the final arbiter across processes. BEGIN IMMEDIATE keeps
 * expiry reconciliation, the fresh-active check, and insertion under one
 * writer lock so no expired owner can be returned between phases.
 */
export function getOrCreateJobForSymbol(
  symbol: string,
  options: { now?: () => Date } = {},
):
  | { jobId: string; existing: true; status: "queued" | "running"; updatedAt: string }
  | { jobId: string; existing: false } {
  const sym = symbol.trim().toUpperCase();
  const db = getDb();
  return db.transaction((tx) => {
    const authority = options.now?.() ?? new Date();
    reconcileExpiredSchedulerStateInTransaction(tx as ThesisDb, authority);
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
    const now = authority.toISOString();
    tx.insert(jobs)
      .values({
        id: jobId,
        symbol: sym,
        status: "queued",
        stepsJson: JSON.stringify(initialSteps()),
        createdAt: now,
        updatedAt: now,
        queuedAt: now,
        maxCostUsd: getConfig().maxJobCostUsd,
        error: null,
        reportId: null,
        unsupportedKind: null,
        unsupportedMessage: null,
      })
      .run();
    return { jobId, existing: false };
  }, { behavior: "immediate" });
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
 * Return a reusable active job for a symbol. Queued rows remain durable until a
 * scheduler claims them; running rows are reusable only while their exact job
 * lease is live. This read helper never mutates state or treats updatedAt as
 * liveness authority.
 */
export function getReusableActiveJobForSymbol(
  symbol: string,
  now: Date = new Date(),
  _staleMs = ACTIVE_JOB_STALE_MS,
): ReusableActiveJob | null {
  void _staleMs; // compatibility only; updatedAt age is never liveness authority
  const sym = symbol.trim().toUpperCase();
  const rows = getDb()
    .select({
      id: jobs.id,
      status: jobs.status,
      updatedAt: jobs.updatedAt,
      leaseOwner: jobs.leaseOwner,
      leaseExpiresAt: jobs.leaseExpiresAt,
    })
    .from(jobs)
    .where(eq(jobs.symbol, sym))
    .all()
    .filter((row): row is typeof row & { status: ReusableActiveJob["status"] } =>
      row.status === "queued" ||
      (
        row.status === "running" &&
        row.leaseOwner !== null &&
        row.leaseExpiresAt !== null &&
        row.leaseExpiresAt > now.toISOString()
      ),
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const row = rows[0];
  return row === undefined
    ? null
    : { jobId: row.id, status: row.status, updatedAt: row.updatedAt };
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
/**
 * Read the persisted bull/bear snapshots for a job, per side (an invalid or
 * absent side is null — a resumed judge is never fed a corrupt snapshot).
 * Returns null only when neither side parses. This is a compatibility/readback
 * helper; retry authority lives in jobStore and never depends on this function.
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
  const bull = parseLegacyAnalystSnapshot(row.bullJson);
  const bear = parseLegacyAnalystSnapshot(row.bearJson);
  if (bull === null && bear === null) return null;
  return { bull, bear, payloadFingerprint: row.payloadFingerprint ?? null };
}

export interface PreparedJobResume {
  jobId: string;
  /** Current terminal/queued generation whose row is being advanced. */
  claimGeneration: number;
  /** Immutable artifact/paid-attempt cohort reused by the target generation. */
  sourceGeneration: number;
  targetGeneration: number;
  sourceRevision: number;
  sourceStatus: "done" | "error";
  sourceReportId: number | null;
  sourceReportExists: boolean;
  sourceStepsJson: string;
  sourceBullJson: string | null;
  sourceBearJson: string | null;
  sourcePayloadFingerprint: string | null;
  /** Exact source-generation artifact + paid-attempt ledger cohort captured before claim. */
  sourceArtifactSetDigest: string;
  bull: PassResultLike<AnalystCase> | null;
  bear: PassResultLike<AnalystCase> | null;
  synthesize: PassResultLike<JudgeOutput> | null;
  verify: PassResultLike<Report> | null;
  payloadFingerprint: string | null;
}

const globalWithPreparedResumes = globalThis as typeof globalThis & {
  __thesisPreparedResumeAuthenticity?: WeakMap<PreparedJobResume, string>;
};

function preparedResumeAuthenticity(): WeakMap<PreparedJobResume, string> {
  globalWithPreparedResumes.__thesisPreparedResumeAuthenticity ??= new WeakMap();
  return globalWithPreparedResumes.__thesisPreparedResumeAuthenticity;
}

function preparedResumeDigest(prepared: PreparedJobResume): string {
  return createHash("sha256").update(JSON.stringify(prepared)).digest("hex");
}

function registerPreparedResume(prepared: PreparedJobResume | null): PreparedJobResume | null {
  if (prepared !== null) {
    preparedResumeAuthenticity().set(prepared, preparedResumeDigest(prepared));
  }
  return prepared;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutablePreparedResume(prepared: PreparedJobResume): PreparedJobResume {
  return deepFreeze(structuredClone(prepared));
}

type ResumeStateDb = Pick<ReturnType<typeof getDb>, "select">;

/**
 * Fingerprint the complete durable settlement cohort for an exact prepare/claim
 * fence. Including the paired attempt ledger prevents a half-pair repair or a
 * late billable settlement from slipping through the claim window.
 */
function sourceArtifactSetDigest(
  db: ResumeStateDb,
  jobId: string,
  firstGeneration: number,
  lastGeneration: number,
): string {
  const artifacts = db
    .select()
    .from(jobPassArtifacts)
    .where(and(
      eq(jobPassArtifacts.jobId, jobId),
      gte(jobPassArtifacts.runGeneration, firstGeneration),
      lte(jobPassArtifacts.runGeneration, lastGeneration),
    ))
    .all()
    .sort((left, right) =>
      left.attemptId.localeCompare(right.attemptId) ||
      left.pass.localeCompare(right.pass) ||
      left.settledAt.localeCompare(right.settledAt),
    );
  const ledger = db
    .select()
    .from(costLog)
    .where(and(
      eq(costLog.jobId, jobId),
      gte(costLog.runGeneration, firstGeneration),
      lte(costLog.runGeneration, lastGeneration),
    ))
    .all()
    .filter((row) => row.attemptId !== null)
    .sort((left, right) =>
      (left.attemptId ?? "").localeCompare(right.attemptId ?? "") ||
      left.step.localeCompare(right.step) ||
      left.id - right.id,
    );
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, artifacts, ledger }))
    .digest("hex");
}

/** Build the immutable reusable-pass plan while the terminal source generation is current. */
function buildPreparedJobResume(
  row: JobRow,
  expectedTerminalStatus: "done" | "error",
  sourceGeneration: number,
  plan: ComputedJobResumePlan,
  sourceReportExists: boolean,
  artifactSetDigest: string,
): PreparedJobResume | null {
  if (row.status !== expectedTerminalStatus || !plan.state.resumable) return null;
  return {
    jobId: row.id,
    claimGeneration: row.runGeneration,
    sourceGeneration,
    targetGeneration: row.runGeneration + 1,
    sourceRevision: row.revision,
    sourceStatus: expectedTerminalStatus,
    sourceReportId: row.reportId,
    sourceReportExists,
    sourceStepsJson: row.stepsJson,
    sourceBullJson: row.bullJson,
    sourceBearJson: row.bearJson,
    sourcePayloadFingerprint: row.payloadFingerprint,
    sourceArtifactSetDigest: artifactSetDigest,
    bull: plan.bull,
    bear: plan.bear,
    synthesize: plan.synthesize,
    verify: plan.verify,
    payloadFingerprint: plan.payloadFingerprint,
  };
}

/**
 * Re-derive a queued retry entirely from durable source-generation state. The
 * transaction form is the scheduler seam: a future queue claimant can compose
 * this exact authority read with its own queued-to-running lease transaction.
 */
export function prepareQueuedJobResumeInTransaction(
  db: ResumeStateDb,
  jobId: string,
): PreparedJobResume | null {
  const stored = readQueuedSourceJobResumeInTransaction(db, jobId);
  if (stored === null || !stored.plan.state.resumable) return null;
  const row = stored.row;
  return immutablePreparedResume({
    jobId,
    claimGeneration: row.runGeneration - 1,
    sourceGeneration: stored.artifacts.runGeneration,
    targetGeneration: row.runGeneration,
    sourceRevision: Math.max(0, row.revision - 1),
    sourceStatus: "error",
    sourceReportId: row.reportId,
    sourceReportExists: stored.artifacts.reportExists,
    sourceStepsJson: row.stepsJson,
    sourceBullJson: row.bullJson,
    sourceBearJson: row.bearJson,
    sourcePayloadFingerprint: row.payloadFingerprint,
    sourceArtifactSetDigest: sourceArtifactSetDigest(
      db,
      jobId,
      stored.artifacts.runGeneration,
      row.runGeneration - 1,
    ),
    bull: stored.plan.bull,
    bear: stored.plan.bear,
    synthesize: stored.plan.synthesize,
    verify: stored.plan.verify,
    payloadFingerprint: stored.plan.payloadFingerprint,
  });
}

/** Re-check the immutable source authority after a queued claim-side mutation. */
export function queuedResumeSourceMatchesInTransaction(
  db: ResumeStateDb,
  prepared: PreparedJobResume,
): boolean {
  const current = db
    .select({
      runGeneration: jobs.runGeneration,
      stepsJson: jobs.stepsJson,
      reportId: jobs.reportId,
      bullJson: jobs.bullJson,
      bearJson: jobs.bearJson,
      payloadFingerprint: jobs.payloadFingerprint,
    })
    .from(jobs)
    .where(eq(jobs.id, prepared.jobId))
    .get();
  if (
    current === undefined ||
    current.runGeneration !== prepared.targetGeneration ||
    current.stepsJson !== prepared.sourceStepsJson ||
    current.reportId !== prepared.sourceReportId ||
    current.bullJson !== prepared.sourceBullJson ||
    current.bearJson !== prepared.sourceBearJson ||
    current.payloadFingerprint !== prepared.sourcePayloadFingerprint
  ) {
    return false;
  }
  if (
    sourceArtifactSetDigest(
      db,
      prepared.jobId,
      prepared.sourceGeneration,
      prepared.claimGeneration,
    ) !==
    prepared.sourceArtifactSetDigest
  ) {
    return false;
  }
  const sourceReportExists = prepared.sourceReportId !== null &&
    db
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.id, prepared.sourceReportId))
      .get() !== undefined;
  return sourceReportExists === prepared.sourceReportExists;
}

export function prepareQueuedJobResume(jobId: string): PreparedJobResume | null {
  try {
    return getDb().transaction((tx) => prepareQueuedJobResumeInTransaction(tx, jobId));
  } catch {
    return null;
  }
}

/** Prepare and validate an immutable resume plan against the terminal source row. */
export function prepareJobResume(
  jobId: string,
  expectedTerminalStatus: "done" | "error",
): PreparedJobResume | null {
  if (expectedTerminalStatus !== "done" && expectedTerminalStatus !== "error") return null;
  try {
    const prepared = getDb().transaction((tx) => {
      const stored = readStoredJobResumeInTransaction(tx, jobId);
      if (stored === null) return null;
      const digest = sourceArtifactSetDigest(
        tx,
        jobId,
        stored.artifacts.runGeneration,
        stored.row.runGeneration,
      );
      return buildPreparedJobResume(
        stored.row,
        expectedTerminalStatus,
        stored.artifacts.runGeneration,
        stored.plan,
        stored.artifacts.reportExists,
        digest,
      );
    });
    return registerPreparedResume(prepared);
  } catch {
    return null;
  }
}

/** Claim exactly the source state captured by prepareJobResume and retain its reusable plan. */
export function claimPreparedJobResume(prepared: PreparedJobResume): boolean {
  const authenticity = preparedResumeAuthenticity();
  const expectedDigest = authenticity.get(prepared);
  authenticity.delete(prepared);
  if (
    expectedDigest === undefined ||
    preparedResumeDigest(prepared) !== expectedDigest ||
    prepared.jobId.length === 0 ||
    (prepared.sourceStatus !== "done" && prepared.sourceStatus !== "error") ||
    !Number.isSafeInteger(prepared.sourceGeneration) ||
    prepared.sourceGeneration < 0 ||
    !Number.isSafeInteger(prepared.claimGeneration) ||
    prepared.claimGeneration < prepared.sourceGeneration ||
    prepared.targetGeneration !== prepared.claimGeneration + 1 ||
    !Number.isSafeInteger(prepared.sourceRevision) ||
    prepared.sourceRevision < 0 ||
    typeof prepared.sourceReportExists !== "boolean" ||
    !/^[0-9a-f]{64}$/.test(prepared.sourceArtifactSetDigest)
  ) {
    return false;
  }
  let claimed = false;
  try {
    claimed = getDb().transaction((tx) => {
      const authority = new Date();
      if (
        sourceArtifactSetDigest(
          tx,
          prepared.jobId,
          prepared.sourceGeneration,
          prepared.claimGeneration,
        ) !==
        prepared.sourceArtifactSetDigest
      ) {
        return false;
      }
      const sourceReportExists = prepared.sourceReportId !== null &&
        tx
          .select({ id: reports.id })
          .from(reports)
          .where(eq(reports.id, prepared.sourceReportId))
          .get() !== undefined;
      if (sourceReportExists !== prepared.sourceReportExists) return false;
      const result = mutateJobSnapshotInTransaction(tx as ThesisDb, {
        jobId: prepared.jobId,
        now: authority,
        fence: {
          expectedRevision: prepared.sourceRevision,
          status: prepared.sourceStatus,
          runGeneration: prepared.claimGeneration,
        },
        mutate: (row) => {
          if (
            row.stepsJson !== prepared.sourceStepsJson ||
            row.reportId !== prepared.sourceReportId ||
            row.bullJson !== prepared.sourceBullJson ||
            row.bearJson !== prepared.sourceBearJson ||
            row.payloadFingerprint !== prepared.sourcePayloadFingerprint
          ) return null;
          return {
          status: "queued",
          error: null,
          unsupportedKind: null,
          unsupportedMessage: null,
          resumeSourceGeneration: prepared.sourceGeneration,
          runGeneration: prepared.targetGeneration,
          stepsJson: JSON.stringify(initialSteps()),
          queuedAt: authority.toISOString(),
          };
        },
      });
      return result !== null;
    }, { behavior: "immediate" });
  } catch {
    return false;
  }
  return claimed;
}

/**
 * Atomically claim a terminal job for a synthesis-only retry. The expected
 * status is part of the UPDATE predicate, so two HTTP requests that read the
 * same terminal row cannot both launch a paid continuation: only the first
 * transition to queued succeeds.
 */
export function claimJobForResume(
  jobId: string,
  expectedTerminalStatus: "done" | "error",
): boolean {
  const prepared = prepareJobResume(jobId, expectedTerminalStatus);
  return prepared !== null && claimPreparedJobResume(prepared);
}

/* ------------------------------------------------------------------------ *
 * In-process cancellation registry
 *
 * A single LLM pass can silently run >30 minutes (web-search-heavy passes,
 * provider backoff) or a laptop sleep can freeze the clock mid-pass — with no
 * jobs-table write in between. Durable lease/heartbeat fields are the liveness
 * authority; this process-local registry exists only to deliver cancellation
 * promptly and expose a test diagnostic. Stashed on globalThis so Next.js dev
 * hot-reloads share controllers with in-flight runs from older module copies.
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
  if (signal.aborted) {
    // The dependency promise is evaluated before this helper is entered. A
    // synchronous pre-provider fence can abort/reject in that narrow window;
    // observe its rejection before returning the durable cancellation result.
    void promise.catch(() => undefined);
    throw abortReason(signal);
  }
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

function canceledStepsJson(raw: string, at: string): string {
  try {
    const steps = JSON.parse(raw) as StepProgress[];
    if (!Array.isArray(steps)) return raw;
    for (const step of steps) {
      if (step.status === "running") {
        step.status = "error";
        step.detail = JOB_CANCELED_ERROR;
        step.finishedAt = at;
        step.completedAt = at;
      } else if (step.status === "pending") {
        step.status = "skipped";
        step.detail = `not reached — ${JOB_CANCELED_ERROR}`;
      }
    }
    return JSON.stringify(steps);
  } catch {
    return raw;
  }
}

/** Durably cancel an exact queued/running row, then abort any local worker. */
export function cancelJob(jobId: string): boolean {
  const controller = liveJobControllers().get(jobId);
  const canceledRevision = getDb().transaction((tx): number | null => {
    const authority = new Date();
    const at = authority.toISOString();
    const row = tx.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (row === undefined || (row.status !== "queued" && row.status !== "running")) return null;
    const changed = mutateJobSnapshotInTransaction(tx as ThesisDb, {
      jobId,
      now: authority,
      fence: {
        expectedRevision: row.revision,
        runGeneration: row.runGeneration,
        status: ["queued", "running"],
        leaseOwner: row.leaseOwner,
      },
      mutate: () => ({
        status: "error",
        error: JOB_CANCELED_ERROR,
        unsupportedKind: null,
        unsupportedMessage: null,
        stepsJson: canceledStepsJson(row.stepsJson, at),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      }),
    });
    return changed?.revision ?? null;
  }, { behavior: "immediate" });
  const canceled = canceledRevision !== null;
  if (canceled && controller !== undefined && !controller.signal.aborted) {
    controller.abort(new JobCanceledError(JOB_CANCELED_ERROR));
  }
  if (canceledRevision !== null) {
    publishJobEvent({
      type: "error",
      jobId,
      revision: canceledRevision,
      message: JOB_CANCELED_ERROR,
    });
  }
  return canceled;
}

/** TEST hook: true when runJob currently executes the job in this process. */
export function isJobLiveInProcess(jobId: string): boolean {
  return liveJobIds().has(jobId);
}

/** Legacy test export; durable renewal cadence is derived from the lease TTL. */
export const JOB_HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Compatibility seam for older callers. It now reconciles only exact missing
 * or expired durable job leases. Queued age and jobs.updatedAt have no write
 * authority, and read routes do not invoke this function.
 */
export function sweepAbandonedJobs(
  now: Date | undefined = undefined,
  _staleMs = ACTIVE_JOB_STALE_MS,
): number {
  void _staleMs; // compatibility only; durable lease expiry is authoritative
  return reconcileExpiredJobClaims(now);
}

/* ------------------------------------------------------------------------ *
 * runJob
 * ------------------------------------------------------------------------ */

export interface RunJobOptions<TPayload = unknown> {
  /** Durable scheduler claim. Production always supplies this preclaimed path. */
  claim?: JobClaim;
  /** Snapshot used for every job/pass lease decision in this run. */
  schedulerLimits?: SchedulerLimits;
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
   * reductions such as 0 support one-attempt test harnesses, while larger
   * values are clamped to the audited production maximum.
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
   * cache-served) to rebuild the judge payload. A payload-fingerprint mismatch
   * makes the prepared artifacts incompatible and aborts before paid work.
   * When snapshots are missing/corrupt, the runner safely starts fresh.
   */
  resume?: boolean;
  /** Marker so TPayload is inferable from the passes argument. */
  readonly _payload?: TPayload;
}

interface RunJobCommonResult {
  jobId: string;
  reportId: number | null;
  verificationRate: number | null;
  totalCostUsd: number;
  /** True when the LLM steps were skipped (no key) → data-only report. */
  dataOnly: boolean;
}

export type RunJobResult =
  | (RunJobCommonResult & { status: "done" | "error" })
  | (RunJobCommonResult & {
      status: "unsupported";
      reportId: null;
      verificationRate: null;
      dataOnly: false;
      kind: Extract<InstrumentSupport, { supported: false }>["kind"];
      message: string;
    });

type QueuedResumeSettlement =
  | {
      kind: "done";
      reportId: number;
      verificationRate: number | null;
      totalCostUsd: number;
      dataOnly: boolean;
      revision: number;
    }
  | { kind: "error"; message: string; revision: number }
  | { kind: "unchanged" };

function safeQueuedResumeFailure(err: unknown): string {
  const message = errMessage(err).toLowerCase();
  if (message.includes("source artifact") || message.includes("digest")) {
    return "runJob: queued retry source artifact digest changed before dispatch";
  }
  if (message.includes("source report") || message.includes("report existence")) {
    return "runJob: queued retry source report existence changed before dispatch";
  }
  if (message.includes("durable source plan")) {
    return "runJob: queued retry has no valid durable source plan";
  }
  return "runJob: queued retry dispatch failed before execution";
}

function normalizeQueuedDispatchFailureSteps(raw: string, message: string, at: string): string {
  try {
    const steps = JSON.parse(raw) as StepProgress[];
    if (!Array.isArray(steps)) return raw;
    return JSON.stringify(steps.map((step): StepProgress => {
      if (step.status === "running") {
        return {
          ...step,
          status: "error",
          detail: message,
          finishedAt: at,
          completedAt: at,
        };
      }
      if (step.status === "pending") {
        return { ...step, status: "skipped", detail: message };
      }
      return step;
    }));
  } catch {
    return raw;
  }
}

/**
 * Finish an accepted queued retry without launching paid work. The exact
 * generation and queued status fence every write. A linked report is checked
 * first under the same immediate transaction and always wins over an error.
 */
function settleQueuedResumeWithoutExecution(
  jobId: string,
  expectedGeneration: number,
  expectedRevision: number,
  failure: unknown,
): QueuedResumeSettlement {
  const message = safeQueuedResumeFailure(failure);
  const settled = getDb().transaction((tx): QueuedResumeSettlement => {
    const authority = new Date();
    const row = tx.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (
      row === undefined ||
      row.status !== "queued" ||
      row.runGeneration !== expectedGeneration ||
      row.revision !== expectedRevision
    ) {
      return { kind: "unchanged" };
    }
    const linkedReport = row.reportId === null
      ? undefined
      : tx
          .select({
            id: reports.id,
            verificationRate: reports.verificationRate,
            costUsd: reports.costUsd,
            reportJson: reports.reportJson,
          })
          .from(reports)
          .where(eq(reports.id, row.reportId))
          .get();
    if (linkedReport !== undefined) {
      const stepsJson = normalizeLinkedReportRecoverySteps(
        row.stepsJson,
        authority.toISOString(),
        "covered by linked persisted report recovered after queued dispatch failure",
      );
      const update = mutateJobSnapshotInTransaction(tx as ThesisDb, {
        jobId,
        now: authority,
        fence: {
          expectedRevision,
          status: "queued",
          runGeneration: expectedGeneration,
        },
        mutate: (current) => current.reportId === linkedReport.id ? ({
          status: "done",
          error: null,
          stepsJson,
        }) : null,
      });
      const ledger = tx.select({ costUsd: costLog.costUsd }).from(costLog)
        .where(eq(costLog.jobId, jobId)).all();
      return update !== null
        ? {
            kind: "done",
            reportId: linkedReport.id,
            verificationRate: linkedReport.verificationRate,
            totalCostUsd: round4(ledger.length > 0
              ? ledger.reduce((total, cost) => total + cost.costUsd, 0)
              : (linkedReport.costUsd ?? 0)),
            dataOnly: reportJsonIsDataOnly(linkedReport.reportJson),
            revision: update.revision,
          }
        : { kind: "unchanged" };
    }
    const update = mutateJobSnapshotInTransaction(tx as ThesisDb, {
      jobId,
      now: authority,
      fence: {
        expectedRevision,
        status: "queued",
        runGeneration: expectedGeneration,
      },
      mutate: () => ({
        status: "error",
        error: message,
        stepsJson: normalizeQueuedDispatchFailureSteps(
          row.stepsJson,
          message,
          authority.toISOString(),
        ),
      }),
    });
    return update !== null
      ? { kind: "error", message, revision: update.revision }
      : { kind: "unchanged" };
  }, { behavior: "immediate" });

  if (settled.kind === "done") {
    publishJobEvent({
      type: "done",
      jobId,
      revision: settled.revision,
      reportId: settled.reportId,
      verificationRate: settled.verificationRate,
      totalCostUsd: settled.totalCostUsd,
      dataOnly: settled.dataOnly,
    });
  } else if (settled.kind === "error") {
    publishJobEvent({
      type: "error",
      jobId,
      revision: settled.revision,
      message: settled.message,
    });
  }
  return settled;
}

/** Route/scheduler safety net for failures before runJob owns a running row. */
export function recordQueuedResumeDispatchFailure(
  jobId: string,
  expectedGeneration: number,
  expectedRevision: number,
  failure: unknown,
): boolean {
  return settleQueuedResumeWithoutExecution(
    jobId,
    expectedGeneration,
    expectedRevision,
    failure,
  ).kind !== "unchanged";
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
  let jobRow = getDb().select().from(jobs).where(eq(jobs.id, jobId)).get();
  let schedulerClaim = opts.claim;
  const schedulerLimits = opts.schedulerLimits ?? configuredSchedulerLimits();
  if (jobRow === undefined) {
    throw new Error(`runJob: no job with id "${jobId}"`);
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
    if (!claimJobForResume(jobId, jobRow.status)) {
      throw new Error(`runJob: job "${jobId}" is not resumable (already synthesized or no reusable analyst work)`);
    }
    jobRow = getDb().select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!jobRow) throw new Error(`runJob: job "${jobId}" disappeared after resume claim`);
  }
  if (schedulerClaim === undefined) {
    schedulerClaim = claimQueuedJobById(
      jobId,
      `direct-${process.pid}`,
      undefined,
      schedulerLimits,
    ) ?? undefined;
    if (schedulerClaim === undefined) {
      const afterClaim = getJobSnapshot(jobId);
      const linkedReportExists = afterClaim?.reportId !== null && afterClaim?.reportId !== undefined &&
        getDb().select({ id: reports.id }).from(reports)
          .where(eq(reports.id, afterClaim.reportId)).get() !== undefined;
      if (afterClaim?.status === "done" && afterClaim.reportId !== null && linkedReportExists) {
        const result: RunJobResult = {
          jobId,
          status: "done",
          reportId: afterClaim.reportId,
          verificationRate: afterClaim.verificationRate,
          totalCostUsd: round4(afterClaim.totalCostUsd),
          dataOnly: afterClaim.dataOnly,
        };
        publishJobEvent({ type: "done", revision: afterClaim.revision, ...result });
        return result;
      }
      if (afterClaim?.status === "error" && afterClaim.error !== null) {
        throw new Error(afterClaim.error);
      }
      throw new Error(
        `runJob: job "${jobId}" was already dispatched, already claimed, or blocked by scheduler capacity`,
      );
    }
    jobRow = getDb().select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (jobRow === undefined) throw new Error(`runJob: job "${jobId}" disappeared after durable claim`);
  }

  if (
    jobRow.status !== "running" ||
    jobRow.runGeneration !== schedulerClaim.runGeneration ||
    jobRow.leaseOwner !== schedulerClaim.leaseOwner ||
    jobRow.leaseExpiresAt === null ||
    jobRow.leaseExpiresAt <= new Date().toISOString()
  ) {
    const reason =
      jobRow.status === "running" && jobRow.leaseOwner === schedulerClaim.leaseOwner
        ? "expired live preclaim"
        : jobRow.status === "running"
          ? "already dispatched"
          : `not active (status ${jobRow.status})`;
    throw new Error(`runJob: job "${jobId}" has no exact preclaimed authority (${reason})`);
  }
  const preparedResume = schedulerClaim.preparedResume;

  const state: RunState = {
    jobId,
    symbol: jobRow.symbol,
    startedAt: jobRow.createdAt,
    runGeneration: jobRow.runGeneration,
    revision: jobRow.revision,
    claim: schedulerClaim,
    schedulerLimits,
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
  try {
    persistSteps(state);
  } catch (error) {
    clearTimeout(overallTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    throw error;
  }

  // Process-local cancellation registration plus durable exact-claim renewal.
  liveJobIds().add(jobId);
  liveJobControllers().set(jobId, jobController);
  const heartbeat = setInterval(() => {
    try {
      if (!renewJobLease(state.claim, undefined, state.schedulerLimits)) {
        jobController.abort(new SupersededRunError(state.jobId, state.runGeneration));
      }
    } catch (error) {
      jobController.abort(error);
    }
  }, Math.max(1, Math.floor(state.schedulerLimits.jobLeaseTtlMs / 4)));
  heartbeat.unref?.();

  const now = opts.now ?? ((): Date => new Date());
  const maxJudgeRetries =
    opts.maxJudgeRetries !== undefined && Number.isFinite(opts.maxJudgeRetries)
      ? Math.min(MAX_JUDGE_RETRIES, Math.max(0, Math.trunc(opts.maxJudgeRetries)))
      : MAX_JUDGE_RETRIES;

  try {
    throwIfJobAborted(jobSignal);

    // A durable verify artifact is already the schema-valid final output. It
    // needs no live data, key, model lookup, or rebuilt payload: link that exact
    // report before any prerequisite can turn a completed result into failure.
    if (opts.resume === true && preparedResume?.verify !== null && preparedResume?.verify !== undefined) {
      for (const step of ["fetch", "validate", "compute", "bull", "bear", "synthesize"] as const) {
        markSkipped(state, step, "covered by reused durable verify artifact");
      }
      startStep(state, "verify");
      finishStep(
        state,
        "verify",
        "done",
        `reused durable verify from retry lineage rooted at generation ${preparedResume.sourceGeneration}`,
        preparedResume.verify.costUsd,
      );
      const recoveredReport = reconcileRecoveredVerifyReport(state, preparedResume.verify);
      const verificationRate = recoveredReport.meta.verificationRate;
      const reportId = persistReport(
        state,
        recoveredReport,
        recoveredReport.meta.model,
        verificationRate,
        "done",
      );
      return finishRun(state, { reportId, verificationRate, dataOnly: false });
    }
    const hasKey = opts.hasAnthropicKey ?? getConfig().hasAnthropicKey;

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

    const validatedSupport = classifyInstrumentSupport(
      bundle.profile.ok ? (bundle.profile.value.data.rows[0] ?? null) : null,
    );
    if (!validatedSupport.supported) return finishUnsupported(state, validatedSupport);

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

    // Defense in depth at the Stage C boundary: no payload assembly, model
    // resolution, or paid dispatch may proceed if a future caller bypasses the
    // post-validation gate above.
    const stageCSupport = classifyInstrumentSupport(
      bundle.profile.ok ? (bundle.profile.value.data.rows[0] ?? null) : null,
    );
    if (!stageCSupport.supported) return finishUnsupported(state, stageCSupport);

    const reusableSynthesize = opts.resume === true
      ? (preparedResume?.synthesize ?? null)
      : null;

    // -- no-key degraded path -------------------------------------------------
    // A reusable synthesize artifact has already completed every key-dependent
    // pass. Its remaining verification/report assembly is deterministic and
    // must not depend on a currently configured provider key.
    if (!hasKey && reusableSynthesize === null) {
      for (const step of LLM_STEPS) {
        startStep(state, step);
        finishStep(state, step, "skipped", NO_KEY_SKIP_REASON);
      }
      return persistDataOnly(state, bundle, validation, computed, now, hasKey);
    }

    // Legacy or injected Stage C adapters must not be trusted to launch paid
    // work after a durable cancel/owner change. This capability is explicit so
    // the runner fails closed before even an "auto" model-resolution request.
    if (passes.launchAuthorityCapability !== DURABLE_LAUNCH_AUTHORITY_CAPABILITY) {
      for (const step of LLM_STEPS) {
        startStep(state, step);
        finishStep(state, step, "skipped", LAUNCH_AUTHORITY_SKIP_REASON);
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
    if (reusableSynthesize !== null) {
      analysisModel = reusableSynthesize.model;
      analysisEffort = getAnalysisEffortSetting();
    } else {
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
    if (preparedResume !== null && fingerprint !== preparedResume.payloadFingerprint) {
      throw new Error(
        "runJob: resume payload fingerprint mismatch; stored pass artifacts are incompatible — start a fresh job",
      );
    }

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
      bull: PassResultLike<AnalystCase> | null,
      bear: PassResultLike<AnalystCase> | null,
      reusableJudge: PassResultLike<JudgeOutput> | null = null,
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
          ...(bull === null
            ? []
            : [buildExecutionMetadataEntry({
                step: "bull",
                requestedModel: analysisModel,
                effectiveModel: bull.model,
                requestedEffort: analysisEffort,
                fallbackUsed: bull.fallbackUsed,
              })]),
          ...(bear === null
            ? []
            : [buildExecutionMetadataEntry({
                step: "bear",
                requestedModel: analysisModel,
                effectiveModel: bear.model,
                requestedEffort: analysisEffort,
                fallbackUsed: bear.fallbackUsed,
              })]),
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
      let judgeProviderAttempted = false;
      let pendingReusableJudge = reusableJudge;

      for (let attempt = 0; attempt <= maxJudgeRetries; attempt++) {
        // 1) Judge pass. A throw here is a synthesis failure (schema-invalid
        //    structured output in the real facade, or a mock rejection). It is
        //    retryable per SPEC §2 — feed the error back by re-invoking the judge,
        //    together with the failed raw output so the model repairs its previous
        //    JSON instead of regenerating the whole document from scratch.
        let judge: PassResultLike<JudgeOutput>;
        if (pendingReusableJudge !== null) {
          judge = pendingReusableJudge;
          pendingReusableJudge = null;
          finishStep(
            state,
            "synthesize",
            "done",
            `reused durable synthesize from retry lineage rooted at generation ${preparedResume?.sourceGeneration ?? "unknown"}`,
            judge.costUsd,
          );
        } else {
          if (bull === null || bear === null) {
            lastValidationDetail = "durable synthesize artifact could not be assembled without rerunning upstream paid work";
            lastJudgeFailureRetryable = false;
            break;
          }
          const feedback =
            lastValidationDetail.length > 0
              ? lastFailedRawOutput.length > 0
                ? `${lastValidationDetail}\n\nYOUR PREVIOUS OUTPUT (repair this JSON in place — do not start over):\n${lastFailedRawOutput}`
                : lastValidationDetail
              : undefined;
          const judgeCheckpoint = createSettlementCheckpoint<JudgeOutput>(
            state,
            "synthesize",
            fingerprint,
            maximumPassCostUsd(analysisModel, "synthesize"),
            jobSignal,
            jobController,
          );
          try {
            await passes.preflightPass?.(deps, {
              pass: "synthesize",
              bull,
              bear,
              validationFeedback: feedback,
            });
            await judgeCheckpoint.beforeLaunch();
            judge = await awaitJobStage(
              passes.runJudgePass(
                deps,
                bull,
                bear,
                feedback,
                judgeCheckpoint.hook,
                () => {
                  judgeCheckpoint.authorizeLaunch(false);
                },
              ),
              jobSignal,
              jobController,
              "synthesize",
              modelStageDeadlineMs,
            );
            throwIfJobAborted(jobSignal);
            judgeProviderAttempted = true;
            if (!judgeCheckpoint.wasCalled() && judgeCheckpoint.hasLease()) {
              await judgeCheckpoint.hook(successSettlement(judge));
            }
          } catch (err) {
            throwIfJobAborted(jobSignal);
            if (err instanceof PassSettlementHookError) throw err;
            const billedAttempt = billedAttemptFromError(err);
            judgeProviderAttempted ||= judgeCheckpoint.wasLaunched() || billedAttempt !== null;
            lastValidationDetail = errMessage(err);
            lastFailedRawOutput = rawTextOfError(err);
            lastJudgeFailureRetryable = isRetryableJudgeError(err);
            if (
              !judgeCheckpoint.wasCalled() &&
              (judgeCheckpoint.wasLaunched() || billedAttempt !== null)
            ) {
              await judgeCheckpoint.hook(
                failureSettlement(
                  err,
                  telemetryFromAttempt(billedAttempt, analysisModel),
                  { retryable: lastJudgeFailureRetryable },
                ),
              );
            }
            const retrying = lastJudgeFailureRetryable && attempt < maxJudgeRetries;
            const detail = `judge attempt ${attempt + 1}/${maxJudgeRetries + 1} failed${retrying ? "; retrying" : ""}: ${lastValidationDetail}`;
            if (retrying) {
              startStep(state, "synthesize");
              updateRunningStepDetail(state, "synthesize", detail);
              continue;
            }
            updateRunningStepDetail(state, "synthesize", detail);
            break;
          } finally {
            // A launched/canceled call keeps its durable reservation, but the
            // exited worker must not retain a process-local renewal interval.
            judgeCheckpoint.releaseIfPrelaunch();
            judgeCheckpoint.stopRenewal();
          }
        }

        // 2) Verify pass. Verification failing is NOT a schema-validation failure
        //    (the judge output is valid) — do not burn a retry; persist the
        //    unverified judge output. Mark verify "error" with the detail.
        let verificationRate: number | null = null;
        let verifiedReport: Report | null = null;
        let verifyLog: unknown = undefined;
        let verifyError: string | null = null;
        startStep(state, "verify");
        const verifyCheckpoint = createSettlementCheckpoint<Report>(
          state,
          "verify",
          fingerprint,
          maximumPassCostUsd(analysisModel, "verify", passes.verifyCapability),
          jobSignal,
          jobController,
        );
        const fetchedUrls = [
          ...new Set(
            [...(bull?.fetchedUrls ?? []), ...(bear?.fetchedUrls ?? []), ...(judge.fetchedUrls ?? [])]
              .flatMap((value) => {
                const canonical = canonicalizeFetchedUrl(value);
                return canonical ? [canonical] : [];
              }),
          ),
        ].sort();
        try {
          if (passes.verifyCapability?.billable === true && passes.preflightPass === undefined) {
            throw new Error("billable verify requires finite provider preflight capability");
          }
          await passes.preflightPass?.(deps, {
            pass: "verify",
            judgeOutput: judge.data,
            evidence: { fetchedUrls },
          });
          await verifyCheckpoint.beforeLaunch();
          const v = await awaitJobStage(
            passes.runVerifyPass(
              deps,
              judge.data,
              { fetchedUrls },
              verifyCheckpoint.hook,
              () => {
                // Verify was already moved to running above. The atomic launch
                // transaction still renews/fences both exact leases and the
                // current revision at its logical execution boundary.
                verifyCheckpoint.authorizeLaunch(false);
              },
            ),
            jobSignal,
            jobController,
            "verify",
            modelStageDeadlineMs,
          );
          throwIfJobAborted(jobSignal);
          verificationRate = v.verificationRate;
          verifyLog = v.log;
          const parsedVerifiedReport = ReportSchema.safeParse(v.verifiedReport);
          const billable = typeof v.costUsd === "number";
          const verifyTelemetry: PassTelemetry = {
            model: v.model ?? (billable ? analysisModel : "deterministic"),
            inputTokens: numOr0(v.usage?.input_tokens),
            outputTokens: numOr0(v.usage?.output_tokens),
            cacheReadTokens: numOr0(v.usage?.cache_read_input_tokens),
            cacheWriteTokens: numOr0(v.usage?.cache_creation_input_tokens),
            webSearches: numOr0(v.webSearches),
            costUsd: v.costUsd ?? 0,
            fallbackUsed: v.fallbackUsed ?? false,
            billable,
            fetchedUrls: [],
          };
          if (!verifyCheckpoint.wasCalled() && verifyCheckpoint.hasLease()) {
            await verifyCheckpoint.hook(
              parsedVerifiedReport.success
                ? { outcome: "success", data: parsedVerifiedReport.data, telemetry: verifyTelemetry }
                : failureSettlement(
                    new Error("verify returned no schema-valid report"),
                    verifyTelemetry,
                    { kind: "schema" },
                  ),
            );
          }
          if (parsedVerifiedReport.success) {
            verifiedReport = parsedVerifiedReport.data;
          } else {
            verifyError = "verify returned no schema-valid report";
          }
        } catch (err) {
          throwIfJobAborted(jobSignal);
          if (err instanceof PassSettlementHookError) throw err;
          verifyError = errMessage(err);
          const billedAttempt = billedAttemptFromError(err);
          if (
            !verifyCheckpoint.wasCalled() &&
            (verifyCheckpoint.wasLaunched() || billedAttempt !== null)
          ) {
            await verifyCheckpoint.hook(
              failureSettlement(
                err,
                telemetryFromAttempt(billedAttempt, billedAttempt ? analysisModel : "deterministic"),
              ),
            );
          }
          const detail = `verify failed; assembling unverified report: ${verifyError}`;
          const verifyStatus = findStep(state, "verify").status;
          if (verifyStatus === "running") {
            // A prelaunch adapter exit has no artifact to merge, but the
            // user-visible step must still become terminal before the
            // unverified report commits. This does not fabricate billing.
            finishStep(state, "verify", "error", detail);
          } else if (verifyStatus === "error") {
            // A launched failure was already settled atomically. Preserve that
            // durable outcome while attaching the runner's degradation detail.
            updateRunningStepDetail(state, "verify", detail);
          }
        } finally {
          verifyCheckpoint.releaseIfPrelaunch();
          verifyCheckpoint.stopRenewal();
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
          const retrying = bull !== null && bear !== null && attempt < maxJudgeRetries;
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
        void verifyError;
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
          attemptedSources: judgeProviderAttempted ? ["anthropic"] : [],
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

    // A durable synthesize artifact contains the complete analyst conclusion.
    // Only deterministic/report verification remains; analysts and judge must
    // not be called merely because the retry moved to another process.
    if (reusableSynthesize !== null) {
      markSkipped(state, "bull", "covered by reused durable synthesize artifact");
      markSkipped(state, "bear", "covered by reused durable synthesize artifact");
      return await runSynthesisAndFinish(null, null, reusableSynthesize);
    }

    // -- resume: reuse persisted analyst passes --------------------------------
    const resumeSnapshots = opts.resume === true && preparedResume !== null
      ? {
          bull: preparedResume.bull,
          bear: preparedResume.bear,
          payloadFingerprint: preparedResume.payloadFingerprint,
        }
      : null;
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
      // Re-run ONLY the missing side(s) — the sibling's paid output is reused
      // (2026-07-10: one-sided analyst failures no longer discard the pair).
      let resumedBull = resumeSnapshots.bull;
      let resumedBear = resumeSnapshots.bear;
      for (const side of resumeMissingSides) {
        startStep(state, side);
        const analystCheckpoint = createSettlementCheckpoint<AnalystCase>(
          state,
          side,
          fingerprint,
          maximumPassCostUsd(analysisModel, side),
          jobSignal,
          jobController,
        );
        try {
          await passes.preflightPass?.(deps, { pass: side });
          await analystCheckpoint.beforeLaunch();
          const fresh = await awaitJobStage(
            passes.runAnalystPass!(
              deps,
              side,
              analystCheckpoint.hook,
              () => {
                analystCheckpoint.authorizeLaunch(false);
              },
            ),
            jobSignal,
            jobController,
            side,
            modelStageDeadlineMs,
          );
          throwIfJobAborted(jobSignal);
          if (!analystCheckpoint.wasCalled() && analystCheckpoint.hasLease()) {
            await analystCheckpoint.hook(successSettlement(fresh));
          }
          if (side === "bull") resumedBull = fresh;
          else resumedBear = fresh;
        } catch (err) {
          throwIfJobAborted(jobSignal);
          if (err instanceof PassSettlementHookError) throw err;
          // Same degradation contract as the fresh-run analyst catch: record
          // billed spend, disclose the failure in the manifest, data-only.
          const billedAttempt = billedAttemptFromError(err);
          if (
            !analystCheckpoint.wasCalled() &&
            (analystCheckpoint.wasLaunched() || billedAttempt !== null)
          ) {
            await analystCheckpoint.hook(
              failureSettlement(err, telemetryFromAttempt(billedAttempt, analysisModel)),
            );
          }
          computed.gaps.push({
            field: `llm.${side}`,
            reason: errMessage(err),
            severity: "critical",
            attemptedSources:
              analystCheckpoint.wasLaunched() || billedAttempt !== null ? ["anthropic"] : [],
          });
          markSkipped(state, "synthesize", "upstream bull/bear pass failed");
          markSkipped(state, "verify", "upstream bull/bear pass failed");
          return persistDataOnly(state, bundle, validation, computed, now, hasKey);
        } finally {
          analystCheckpoint.releaseIfPrelaunch();
          analystCheckpoint.stopRenewal();
        }
      }
      // `await` so a rejection is caught by the outer catch (error recording).
      return await runSynthesisAndFinish(resumedBull!, resumedBear!);
    }

    // -- bull + bear ----------------------------------------------------------
    // Per-pass timing comes from the hooks (the passes overlap in the
    // streaming path); ensureStepStarted backfills for hook-less mocks so a
    // step never jumps pending -> terminal.
    const analystLaunched = { bull: false, bear: false };
    const bullCheckpoint = createSettlementCheckpoint<AnalystCase>(
      state,
      "bull",
      fingerprint,
      maximumPassCostUsd(analysisModel, "bull"),
      jobSignal,
      jobController,
    );
    const bearCheckpoint = createSettlementCheckpoint<AnalystCase>(
      state,
      "bear",
      fingerprint,
      maximumPassCostUsd(analysisModel, "bear"),
      jobSignal,
      jobController,
    );
    const analystHooks: AnalystPassHooks = {
      beforePass: async (side) => {
        const checkpoint = side === "bull" ? bullCheckpoint : bearCheckpoint;
        await checkpoint.beforeLaunch();
      },
      onPassStart: (side) => {
        // Best-effort timing only. Durable authority must never pass through a
        // hook Stage C intentionally swallows.
        void side;
      },
      beforeProviderLaunch: (side) => {
        const checkpoint = side === "bull" ? bullCheckpoint : bearCheckpoint;
        checkpoint.authorizeLaunch(true);
        analystLaunched[side] = true;
      },
      onPassFinish: (side) => stampStepFinished(state, side),
    };
    let bull: PassResultLike<AnalystCase> | null = null;
    let bear: PassResultLike<AnalystCase> | null = null;
    try {
      await passes.preflightPass?.(deps, { pass: "bull" });
      await passes.preflightPass?.(deps, { pass: "bear" });
      const cases = await awaitJobStage(
        passes.runBullThenBear(deps, analystHooks, {
          bull: bullCheckpoint.hook,
          bear: bearCheckpoint.hook,
        }),
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
      const fallbackSettlements = await Promise.allSettled([
        bullCheckpoint.wasCalled()
          ? Promise.resolve()
          : bullCheckpoint.hook(successSettlement(bull)),
        bearCheckpoint.wasCalled()
          ? Promise.resolve()
          : bearCheckpoint.hook(successSettlement(bear)),
      ]);
      throwFirstSettlementRejection(fallbackSettlements);
    } catch (err) {
      if (!analystLaunched.bull) bullCheckpoint.releaseIfPrelaunch();
      if (!analystLaunched.bear) bearCheckpoint.releaseIfPrelaunch();
      throwIfJobAborted(jobSignal);
      if (err instanceof PassSettlementHookError) throw err;
      // Adversarial passes failed — mark both error and fall through to a
      // data-only stub (we still have fetch/validate/compute).
      const partial = bullBearFailureFromError(err);
      const bullLaunched = analystLaunched.bull ||
        partial?.bullLaunched === true ||
        partial?.bull !== undefined ||
        partial?.bullBilledAttempt !== undefined ||
        bullCheckpoint.wasCalled();
      const bearLaunched = analystLaunched.bear ||
        partial?.bearLaunched === true ||
        partial?.bear !== undefined ||
        partial?.bearBilledAttempt !== undefined ||
        bearCheckpoint.wasCalled();
      if (!bullLaunched) {
        bullCheckpoint.releaseIfPrelaunch();
        markSkipped(state, "bull", "provider pass was not launched");
      } else {
        ensureStepStarted(state, "bull");
      }
      if (!bearLaunched) {
        bearCheckpoint.releaseIfPrelaunch();
        markSkipped(state, "bear", "provider pass was not launched");
      } else {
        ensureStepStarted(state, "bear");
      }
      const settleMissingSide = async (
        checkpoint: SettlementCheckpoint<AnalystCase>,
        result: PassResultLike<AnalystCase> | undefined,
        sideError: string | undefined,
        billed: BilledPassAttempt | undefined,
        launched: boolean | undefined,
      ): Promise<void> => {
        if (checkpoint.wasCalled()) return;
        if (launched === false) return;
        if (result !== undefined) {
          await checkpoint.hook(successSettlement(result));
          return;
        }
        await checkpoint.hook(
          failureSettlement(
            new Error(sideError ?? errMessage(err)),
            telemetryFromAttempt(billed ?? null, analysisModel),
          ),
        );
      };
      const fallbackSettlements = await Promise.allSettled([
        settleMissingSide(
          bullCheckpoint,
          partial?.bull,
          partial?.bullError,
          partial?.bullBilledAttempt,
          bullLaunched,
        ),
        settleMissingSide(
          bearCheckpoint,
          partial?.bear,
          partial?.bearError,
          partial?.bearBilledAttempt,
          bearLaunched,
        ),
      ]);
      throwFirstSettlementRejection(fallbackSettlements);
      // Disclose the per-pass failures in the report's missing-data manifest —
      // the report page has no access to step details, so without these the
      // data-only report could not say WHY analysis is absent (2026-07-10:
      // transport failures were only visible on the transient pipeline view).
      // A side that DID succeed is persisted (with the fingerprint) so its
      // paid output survives for a partial resume instead of being discarded.
      for (const side of ["bull", "bear"] as const) {
        const checkpoint = side === "bull" ? bullCheckpoint : bearCheckpoint;
        if (checkpoint.lastSettlement()?.outcome === "success") continue;
        const sideError = side === "bull" ? partial?.bullError : partial?.bearError;
        const launched = side === "bull" ? bullLaunched : bearLaunched;
        computed.gaps.push({
          field: `llm.${side}`,
          reason: sideError ?? errMessage(err),
          severity: "critical",
          attemptedSources: launched ? ["anthropic"] : [],
        });
      }
      markSkipped(state, "synthesize", "upstream bull/bear pass failed");
      markSkipped(state, "verify", "upstream bull/bear pass failed");
      return persistDataOnly(state, bundle, validation, computed, now, hasKey);
    } finally {
      bullCheckpoint.releaseIfPrelaunch();
      bearCheckpoint.releaseIfPrelaunch();
      bullCheckpoint.stopRenewal();
      bearCheckpoint.stopRenewal();
    }

    return await runSynthesisAndFinish(bull, bear);
  } catch (err) {
    if (err instanceof SupersededRunError) {
      return supersededRunResult(state);
    }
    const jobAbortReason = jobSignal.aborted ? abortReason(jobSignal) : null;
    if (jobSignal.aborted && !(jobAbortReason instanceof PassSettlementHookError)) {
      try {
        return abortRun(state, jobAbortReason);
      } catch (abortError) {
        if (abortError instanceof SupersededRunError) {
          return supersededRunResult(state);
        }
        throw abortError;
      }
    }
    // Unexpected orchestration failure: record and re-surface to the scheduler,
    // whose terminal/finally path wakes the next durable claim.
    const surfacedError = jobAbortReason instanceof PassSettlementHookError
      ? jobAbortReason
      : err;
    try {
      persistSteps(state, "error", errMessage(surfacedError));
    } catch (persistError) {
      if (persistError instanceof SupersededRunError) {
        return supersededRunResult(state);
      }
      throw persistError;
    }
    publish(state, { type: "error", jobId, message: errMessage(surfacedError) });
    throw surfacedError;
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
  const doneEvent: JobEventPayload = {
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

/** Return to a stale caller without changing or announcing the current owner. */
function supersededRunResult(state: RunState): RunJobResult {
  return {
    jobId: state.jobId,
    status: "error",
    reportId: null,
    verificationRate: null,
    totalCostUsd: round4(sumLoggedCost(state.jobId)),
    dataOnly: false,
  };
}

function finishUnsupported(
  state: RunState,
  support: Extract<InstrumentSupport, { supported: false }>,
): RunJobResult {
  for (const step of state.steps) markSkipped(state, step.step, support.reason);

  const terminal = withLiveRunAuthority(state, null, (db, _row, authorityAt) => {
    const update = mutateJobSnapshotInTransaction(db, {
      jobId: state.jobId,
      now: new Date(authorityAt),
      fence: {
        runGeneration: state.runGeneration,
        status: "running",
        leaseOwner: state.claim.leaseOwner,
        leaseValidAfter: authorityAt,
      },
      mutate: () => ({
        status: "unsupported",
        error: null,
        reportId: null,
        unsupportedKind: support.kind,
        unsupportedMessage: support.reason,
        stepsJson: JSON.stringify(state.steps),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      }),
    });
    if (update === null) {
      throw new SupersededRunError(state.jobId, state.runGeneration);
    }
    return update.revision;
  });
  if (!terminal.authorized) {
    throw new SupersededRunError(state.jobId, state.runGeneration);
  }
  state.revision = terminal.value;

  const totalCostUsd = round4(state.totalCostUsd);
  publish(state, {
    type: "unsupported",
    jobId: state.jobId,
    kind: support.kind,
    message: support.reason,
    totalCostUsd,
  });
  return {
    jobId: state.jobId,
    status: "unsupported",
    reportId: null,
    verificationRate: null,
    totalCostUsd,
    dataOnly: false,
    kind: support.kind,
    message: support.reason,
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

function reconcilePersistedCostBreakdown(
  existing: Report["appendix"]["costBreakdown"],
  ledger: CostLedgerRow[],
): Report["appendix"]["costBreakdown"] {
  let matchingPrefix = true;
  return ledger.map((entry, index) => {
    const previous = existing[index];
    const matches = matchingPrefix && previous !== undefined &&
      previous.step === entry.step &&
      previous.model === entry.model &&
      Object.is(previous.costUsd, entry.costUsd);
    if (matches) {
      return {
        ...previous,
        // cost_log is the durable per-attempt fallback source of truth.
        fallbackUsed: entry.fallbackUsed,
      };
    }
    matchingPrefix = false;
    return {
      step: entry.step,
      model: entry.model,
      costUsd: entry.costUsd,
      fallbackUsed: entry.fallbackUsed,
    };
  });
}

/** Insert a reports row, link jobs.reportId, return the new report id. */
function persistReport(
  state: RunState,
  report: Report | unknown,
  model: string,
  verificationRate: number | null,
  status: string,
): number {
  const persisted = withLiveRunAuthority(state, null, (db, _row, authorityAt) => {
    const ledger = db.select({
      step: costLog.step,
      model: costLog.model,
      costUsd: costLog.costUsd,
      fallbackUsed: costLog.fallbackUsed,
    }).from(costLog)
      .where(eq(costLog.jobId, state.jobId))
      .orderBy(costLog.id)
      .all();
    const authoritativeCostUsd = ledger.reduce((total, entry) => total + entry.costUsd, 0);
    const parsed = ReportSchema.safeParse(report);
    const reportForPersistence: Report | unknown = parsed.success
      ? {
          ...parsed.data,
          meta: {
            ...parsed.data.meta,
            costUsd: authoritativeCostUsd,
          },
          appendix: {
            ...parsed.data.appendix,
            costBreakdown: reconcilePersistedCostBreakdown(
              parsed.data.appendix.costBreakdown,
              ledger,
            ),
          },
        }
      : report;
    const inserted = db
      .insert(reports)
      .values({
        symbol: state.symbol,
        createdAt: authorityAt,
        model,
        status,
        reportJson: JSON.stringify(reportForPersistence),
        verificationRate,
        costUsd: authoritativeCostUsd,
        specVersion: REPORT_SPEC_VERSION,
      })
      .returning({ id: reports.id })
      .get();
    if (parsed.success) {
      const canonical = reportForPersistence as Report;
      const persistedReport: Report = {
        ...canonical,
        meta: {
          ...canonical.meta,
          runId: state.jobId,
          reportId: inserted.id,
          persistedAt: authorityAt,
        },
      };
      db
        .update(reports)
        .set({ reportJson: JSON.stringify(persistedReport) })
        .where(eq(reports.id, inserted.id))
        .run();
    }
    const link = mutateJobSnapshotInTransaction(db, {
      jobId: state.jobId,
      now: new Date(authorityAt),
      fence: {
        runGeneration: state.runGeneration,
        status: "running",
        leaseOwner: state.claim.leaseOwner,
        leaseValidAfter: authorityAt,
      },
      mutate: () => ({
        reportId: inserted.id,
        status: "done",
        error: null,
        unsupportedKind: null,
        unsupportedMessage: null,
        stepsJson: JSON.stringify(state.steps),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      }),
    });
    if (link === null) {
      throw new SupersededRunError(state.jobId, state.runGeneration);
    }
    return {
      reportId: inserted.id,
      revision: link.revision,
      totalCostUsd: authoritativeCostUsd,
    };
  });
  if (!persisted.authorized) {
    throw new SupersededRunError(state.jobId, state.runGeneration);
  }
  state.revision = persisted.value.revision;
  state.claim.revision = persisted.value.revision;
  state.totalCostUsd = persisted.value.totalCostUsd;
  return persisted.value.reportId;
}

/* ------------------------------------------------------------------------ *
 * Report assembly helpers (data-only stub + meta reconciliation)
 * ------------------------------------------------------------------------ */

function buildCostBreakdown(state: RunState): { step: string; model: string; costUsd: number }[] {
  return readCostLedger(state.jobId).map((row) => ({
    step: row.step,
    model: row.model,
    costUsd: row.costUsd,
  }));
}

interface CostLedgerRow {
  step: string;
  model: string;
  costUsd: number;
  fallbackUsed: boolean;
}

/** Ordered immutable accounting rows used to rebuild persisted report metadata. */
function readCostLedger(jobId: string): CostLedgerRow[] {
  return getDb()
    .select({
      step: costLog.step,
      model: costLog.model,
      costUsd: costLog.costUsd,
      fallbackUsed: costLog.fallbackUsed,
    })
    .from(costLog)
    .where(eq(costLog.jobId, jobId))
    .orderBy(costLog.id)
    .all();
}

/** Sum of every cost_log row already recorded for a job (resume rehydration). */
function sumLoggedCost(jobId: string, db: ThesisDb = getDb()): number {
  const rows = db
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

/**
 * Repair runner-owned metadata on a recovered final verify artifact before it
 * is linked. Stage C settles verification before the runner knows the complete
 * ledger, so its durable report intentionally contains provisional zero/empty
 * accounting fields. Recovery has no live pipeline context; the local ledger
 * and durable verify telemetry are the complete authority available here.
 */
function reconcileRecoveredVerifyReport(
  state: RunState,
  verify: PassResultLike<Report>,
): Report {
  const ledger = readCostLedger(state.jobId);
  state.totalCostUsd = ledger.reduce((total, row) => total + row.costUsd, 0);
  const requestedModel = verify.data.meta.model;
  const effectiveByStep = new Map<string, CostLedgerRow>();
  for (const row of ledger) {
    if (row.step === "bull" || row.step === "bear" || row.step === "synthesize") {
      // Ordered by cost_log.id: the last result attempt is the effective pass,
      // while every earlier billed attempt remains visible in the appendix.
      effectiveByStep.set(row.step, row);
    }
  }
  const execution: ExecutionMetadataEntry[] = [];
  for (const step of ["bull", "bear", "synthesize"] as const) {
    const row = effectiveByStep.get(step);
    if (row === undefined) continue;
    execution.push(buildExecutionMetadataEntry({
      step,
      requestedModel,
      effectiveModel: row.model,
      // Requested effort is not persisted in cost_log; never infer historical
      // execution from the current process setting.
      requestedEffort: null,
      fallbackUsed: row.fallbackUsed,
    }));
  }
  // A recovered schema-valid report is finalized by this durable verify
  // artifact. Historical paid verify attempts remain costs, not the effective
  // final verification execution.
  execution.push(buildExecutionMetadataEntry({
    step: "verify",
    requestedModel: "deterministic",
    effectiveModel: verify.model,
    requestedEffort: null,
    fallbackUsed: verify.fallbackUsed,
  }));
  const costBreakdown = ledger.map((row) => ({
    step: row.step,
    model: row.model,
    costUsd: row.costUsd,
    // This is the only execution option cost_log persists per attempt. Do not
    // infer requested model/effort or derived adjustments for appendix rows.
    fallbackUsed: row.fallbackUsed,
  }));
  const report = costBreakdown.length === 0
    ? {
        ...verify.data,
        appendix: { ...verify.data.appendix, costBreakdown: [] },
      }
    : verify.data;
  const reconciled = reconcileMeta(
    report,
    {
      symbol: state.symbol,
      companyName: report.meta.companyName,
      generatedAt: report.meta.generatedAt,
      model: report.meta.model,
      costUsd: state.totalCostUsd,
      verificationRate: report.meta.verificationRate,
      asOfMap: { ...report.meta.asOfMap },
      execution,
      runId: state.jobId,
      startedAt: state.startedAt,
      completedAt: findStep(state, "verify").completedAt ?? findStep(state, "verify").finishedAt,
    },
    costBreakdown,
    report.appendix.verificationLog,
  );
  return ReportSchema.parse({
    ...reconciled,
    appendix: {
      ...reconciled.appendix,
      // reconcileMeta's normal path enriches one row per pass. Recovery instead
      // has an attempt ledger, so preserve every row and its own persisted flag.
      costBreakdown,
    },
  });
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

/** Source-entry appendix rows copied from exact bundle provider envelopes. */
function collectSources(bundle: DataBundle): Report["appendix"]["sources"] {
  return sourceManifestEntries(bundle.sourceManifest).map((entry) => ({ ...entry }));
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
  const attemptedAnalysisSources = [
    ...new Set(
      missingData
        .filter((gap) => gap.field.startsWith("llm."))
        .flatMap((gap) => gap.attemptedSources ?? []),
    ),
  ].sort();
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
    attemptedSources: attemptedAnalysisSources,
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
