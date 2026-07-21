/**
 * Stage C wiring — the concrete {@link PipelinePasses} the job runner injects.
 *
 * The job runner (src/pipeline/jobRunner.ts) speaks a loose, structural
 * `PipelinePasses` facade (assembleContextPayload / runBullThenBear /
 * runJudgePass / runVerifyPass / assembleReport) whose method signatures differ
 * from the direct exports of src/pipeline/stageC/passes.ts. This module is the
 * thin adapter that bridges the two:
 *
 *   - It builds a real {@link PassDeps} (the injected `runPass` /
 *     `runPassStreaming` from the Anthropic provider + the web-search tool
 *     factory + the resolved analysis/verify models) and threads the assembled
 *     {@link ContextPayload} through `deps.payload`.
 *   - It unwraps the passes' discriminated `PassRun<T>` results into the runner's
 *     `PassResultLike<T>` (throwing on a hard pass failure so the runner's
 *     try/catch degrades to a data-only report — exactly the runner's contract).
 *   - Its `runVerifyPass` assembles the verified JudgeOutput into a full Report
 *     (the runner's facade expects `verifiedReport: Report`, whereas passes.ts's
 *     verify returns a JudgeOutput). To do so it needs the bundle/computed/
 *     validation that were available at payload-assembly time; those are stashed
 *     in a WeakMap keyed by the payload object the runner threads through every
 *     pass call, so per-job assembly context is recovered without global state
 *     leaking between concurrent jobs.
 *
 * The POST /api/report route resolves this module at runtime (dynamic import)
 * and passes `pipelinePasses` into runJob(). Server-only: the real `runPass`
 * reads ANTHROPIC_API_KEY. In the no-key path the runner never reaches these
 * methods (it skips the LLM steps), so this module stays keyless-safe by
 * construction.
 */

import type { DataBundle } from "@/pipeline/types";
import type { ComputedMetrics } from "@/pipeline/compute";
import type { ValidationReport } from "@/pipeline/stageA/validate";
import type {
  AnalystCase,
  JudgeOutput,
  Report,
  TracedNumber,
  CostBreakdownEntry,
  VerificationLogEntry,
} from "@/report/schema";
import { ReportSchema } from "@/report/schema";
import {
  runPass as providerRunPass,
  runPassStreaming as providerRunPassStreaming,
  webSearchTool,
  type RunPassOptions,
} from "@/providers/anthropic";
import type {
  PipelinePasses,
  AnalystPassHooks,
  BilledPassAttempt,
  PassDeps as RunnerPassDeps,
  PassResultLike,
  VerifyPassResult,
  AssembleReportInput,
} from "@/pipeline/jobRunner";
import { BullBearPassFailure, PIPELINE_VERSION } from "@/pipeline/jobRunner";
import {
  assembleContextPayload,
  FAIR_VALUE_PROVENANCE_ID,
  payloadFingerprint,
  projectionProvenanceId,
  scenarioTargetProvenanceId,
  type ContextPayload,
} from "@/pipeline/stageC/payload";
import {
  canonicalizeTracedUnit,
  matchProvenanceRecord,
} from "@/pipeline/stageC/provenance";
import {
  runBullPass,
  runBearPass,
  runBullThenBear as runBullThenBearPass,
  runJudgePass as runJudgePass_,
  runVerifyPass as runVerifyPass_,
  assembleReport as assembleReport_,
  type PassDeps,
  type PassResult,
  type PassRun,
  type RunPassArgs,
  type RunPassFn,
  type RunPassStreamingFn,
} from "@/pipeline/stageC/passes";

/* ------------------------------------------------------------------------ *
 * Per-job assembly context (recovered in the verify pass)
 *
 * The runner's `runVerifyPass(deps, judgeOutput)` facade has no bundle/computed/
 * validation, but assembleReport (passes.ts) needs them for the appendix
 * sources + missing-data manifest. We stash them when assembleContextPayload
 * runs, keyed by the payload object identity — the SAME object the runner then
 * threads through `deps.payload` on every subsequent pass. A WeakMap means the
 * entry is collected when the job's payload is; no cross-job leakage.
 * ------------------------------------------------------------------------ */

interface AssemblyContext {
  bundle: DataBundle;
  computed: ComputedMetrics;
  validation: ValidationReport;
}

const assemblyContexts = new WeakMap<ContextPayload, AssemblyContext>();

/* ------------------------------------------------------------------------ *
 * Provider-runner adapters
 *
 * passes.ts declares a loose structural RunPassFn (tools: unknown[], system:
 * string) so it stays provider-agnostic and unit-testable. The real provider
 * runners are strictly typed (BetaToolUnion[] etc.). The runtime values are
 * identical — the passes build tools via the injected webSearchTool, which IS
 * the provider's — so these thin wrappers only bridge the static types. The
 * provider's RunPassResult is structurally a superset of passes' RunPassOutcome
 * (its success `value` is Sourced<PassOutcome> whose `.data` is PassOutcome, a
 * superset of PassOutcomeLike), so the return values map straight through.
 * ------------------------------------------------------------------------ */

/** Provider RunPassOptions built from the passes' loose RunPassArgs. */
function toRunPassOptions(args: RunPassArgs): RunPassOptions {
  return {
    model: args.model,
    system: args.system,
    messages: args.messages,
    tools: args.tools as RunPassOptions["tools"],
    outputSchema: args.outputSchema,
    maxTokens: args.maxTokens,
    effort: args.effort,
    field: args.field,
    signal: args.signal,
  };
}

const runPass: RunPassFn = (args) =>
  providerRunPass(toRunPassOptions(args)) as ReturnType<RunPassFn>;

const runPassStreaming: RunPassStreamingFn = (args) => {
  const handle = providerRunPassStreaming(toRunPassOptions(args));
  return {
    firstToken: handle.firstToken,
    result: handle.result as ReturnType<RunPassStreamingFn>["result"],
  };
};

/* ------------------------------------------------------------------------ *
 * PassDeps construction (real provider wiring)
 * ------------------------------------------------------------------------ */

/**
 * Build the passes-module {@link PassDeps} from the runner-owned models. Wires
 * the real streaming/non-streaming runners + web-search tool factory. Effort
 * comes from the runner (settings table → ANALYSIS_EFFORT env → "high") —
 * thinking tokens are billed as output and dominate per-pass cost, so this is
 * the user's cost/quality knob; the default stays "high".
 */
function toPassDeps(deps: RunnerPassDeps<ContextPayload>): PassDeps {
  return {
    runPass,
    runPassStreaming,
    webSearchTool,
    model: deps.analysisModel,
    effort: deps.effort ?? "high",
    signal: deps.signal,
  };
}

/* ------------------------------------------------------------------------ *
 * PassRun -> PassResultLike unwrapping
 * ------------------------------------------------------------------------ */

/**
 * Turn one pass's `PassResult<T>` into the runner's `PassResultLike<T>` (the
 * cost/usage subset it logs). `webSearches` is carried through so cost_log's
 * web-search column is accurate.
 */
function toPassResultLike<T>(r: PassResult<T>): PassResultLike<T> {
  return {
    data: r.output,
    model: r.model,
    costUsd: r.costUsd,
    fallbackUsed: r.fallbackUsed,
    usage: {
      input_tokens: r.usage.input_tokens,
      output_tokens: r.usage.output_tokens,
      cache_read_input_tokens: r.usage.cache_read_input_tokens,
      cache_creation_input_tokens: r.usage.cache_creation_input_tokens,
    },
    webSearches: r.webSearches,
    fetchedUrls: r.fetchedUrls,
  };
}

class PassRunError extends Error {
  constructor(
    message: string,
    readonly billedAttempt?: BilledPassAttempt,
    readonly retryable = false,
    /** Raw text of a received-but-invalid output, for repair-style retries. */
    readonly rawText?: string,
  ) {
    super(message);
    this.name = "PassRunError";
  }
}

function billedAttemptFromRun<T>(run: PassRun<T>): BilledPassAttempt | undefined {
  if (run.ok || run.costUsd === undefined || run.model === undefined) return undefined;
  return {
    model: run.model,
    costUsd: run.costUsd,
    fallbackUsed: run.fallbackUsed ?? false,
    usage: run.usage
      ? {
          input_tokens: run.usage.input_tokens,
          output_tokens: run.usage.output_tokens,
          cache_read_input_tokens: run.usage.cache_read_input_tokens,
          cache_creation_input_tokens: run.usage.cache_creation_input_tokens,
        }
      : undefined,
    webSearches: run.webSearches,
  };
}

function passRunFailureMessage<T>(run: PassRun<T>, label: string): string {
  if (run.ok) {
    throw new Error(`passRunFailureMessage called with successful ${label} pass`);
  }
  const detail = run.validationError
    ? `${run.error.message}: ${run.validationError}`
    : run.error.message;
  return `${label} pass failed (${run.error.kind}): ${detail}`;
}

/**
 * Unwrap a `PassRun<T>` into a `PassResult<T>`, THROWING on the failure branch.
 * The runner wraps every pass call in try/catch and degrades to a data-only
 * report on a throw, so surfacing a keyless/refusal/schema failure as an
 * exception is exactly the contract it expects (it never crashes the app).
 */
function unwrap<T>(run: PassRun<T>, label: string): PassResult<T> {
  if (run.ok) return run.result;
  throw new PassRunError(
    passRunFailureMessage(run, label),
    billedAttemptFromRun(run),
    run.validationError !== undefined,
    run.rawText,
  );
}

/**
 * Replace only pipeline-owned Stage B source tags with their exact registry
 * IDs. The binding is fail-closed: path, original computation source, value,
 * unit, currency, period, and as-of must all match the registered record before
 * anything is rewritten. Judge-authored numbers are deliberately untouched.
 */
function bindDeterministicReportProvenance(
  input: Report,
  payload: ContextPayload,
): Report {
  const report = structuredClone(input);
  const registry = payload.provenanceRegistry ?? [];
  const byId = new Map(registry.map((record) => [record.id, record]));

  const bind = (
    number: TracedNumber | null | undefined,
    id: string,
    period: string | null,
  ): void => {
    if (!number) return;
    const record = byId.get(id);
    if (!record || number.source !== record.origin) return;
    const normalized = canonicalizeTracedUnit(number.unit, number.currency);
    if (normalized === null) return;
    const match = matchProvenanceRecord(
      {
        value: number.value,
        unit: normalized.unit,
        currency: normalized.currency,
        period,
        asOf: number.asOf ?? "",
        source: id,
      },
      registry,
    );
    if (!match.ok) return;

    number.source = id;
    number.currency = record.currency;
    number.period = record.period;
    number.verified = null;
    delete number.verificationNote;
  };

  if (report.projections) {
    const scenarios = ["historical", "bull", "base", "bear", "weighted"] as const;
    for (const series of report.projections.series) {
      for (const scenario of scenarios) {
        for (const point of series[scenario]) {
          bind(
            point.value,
            projectionProvenanceId(series.metric, scenario, point.period),
            point.period,
          );
        }
      }
    }
  }

  if (report.fairValue?.status === "available") {
    bind(report.fairValue.perShare, FAIR_VALUE_PROVENANCE_ID, null);
    bind(report.valuation.dcf.perShare, FAIR_VALUE_PROVENANCE_ID, null);
  }

  if (report.scenarioTargets?.status === "available") {
    for (const target of report.scenarioTargets.targets) {
      bind(target.perShare, scenarioTargetProvenanceId(target.name), null);
    }
    for (const scenario of report.valuation.scenarios) {
      bind(scenario.priceTarget, scenarioTargetProvenanceId(scenario.name), null);
    }
  }

  return report;
}

/* ------------------------------------------------------------------------ *
 * The concrete PipelinePasses
 * ------------------------------------------------------------------------ */

export const pipelinePasses: PipelinePasses<ContextPayload> = {
  assembleContextPayload(
    bundle: DataBundle,
    computed: ComputedMetrics,
    validation: ValidationReport,
  ): ContextPayload {
    const payload = assembleContextPayload(bundle, computed, validation);
    assemblyContexts.set(payload, { bundle, computed, validation });
    return payload;
  },

  fingerprintPayload(payload: ContextPayload): string {
    return payloadFingerprint(payload);
  },

  async runBullThenBear(
    deps: RunnerPassDeps<ContextPayload>,
    hooks?: AnalystPassHooks,
  ): Promise<{ bull: PassResultLike<AnalystCase>; bear: PassResultLike<AnalystCase> }> {
    const passDeps = toPassDeps(deps);
    const { bull, bear } = await runBullThenBearPass(passDeps, deps.payload, hooks);
    const bullResult = bull.ok ? toPassResultLike(bull.result) : undefined;
    const bearResult = bear.ok ? toPassResultLike(bear.result) : undefined;
    if (bullResult === undefined || bearResult === undefined) {
      const failures = [
        bull.ok ? null : passRunFailureMessage(bull, "bull"),
        bear.ok ? null : passRunFailureMessage(bear, "bear"),
      ].filter((message): message is string => message !== null);
      throw new BullBearPassFailure(failures.join("; "), {
        bull: bullResult,
        bear: bearResult,
        bullError: bull.ok ? undefined : passRunFailureMessage(bull, "bull"),
        bearError: bear.ok ? undefined : passRunFailureMessage(bear, "bear"),
        bullBilledAttempt: bull.ok ? undefined : billedAttemptFromRun(bull),
        bearBilledAttempt: bear.ok ? undefined : billedAttemptFromRun(bear),
      });
    }
    return {
      bull: bullResult,
      bear: bearResult,
    };
  },

  async runAnalystPass(
    deps: RunnerPassDeps<ContextPayload>,
    side: "bull" | "bear",
  ): Promise<PassResultLike<AnalystCase>> {
    // Partial resume: the sibling's persisted snapshot is being reused, so a
    // lone pass simply writes (or re-reads) its own payload cache entry — no
    // bull-first sequencing applies. runPass auto-streams above 16K tokens,
    // so this path gets the provider's transport retries too.
    const passDeps = toPassDeps(deps);
    const run =
      side === "bull"
        ? await runBullPass(passDeps, deps.payload)
        : await runBearPass(passDeps, deps.payload);
    return toPassResultLike(unwrap(run, side));
  },

  async runJudgePass(
    deps: RunnerPassDeps<ContextPayload>,
    bull: PassResultLike<AnalystCase>,
    bear: PassResultLike<AnalystCase>,
    validationFeedback?: string,
  ): Promise<PassResultLike<JudgeOutput>> {
    const passDeps = toPassDeps(deps);
    const run = await runJudgePass_(passDeps, deps.payload, bull.data, bear.data, validationFeedback);
    return toPassResultLike(unwrap(run, "judge"));
  },

  async runVerifyPass(
    deps: RunnerPassDeps<ContextPayload>,
    judgeOutput: JudgeOutput,
    evidence: { fetchedUrls: string[] } = { fetchedUrls: [] },
  ): Promise<VerifyPassResult> {
    const passDeps = toPassDeps(deps);
    const ctx = assemblyContexts.get(deps.payload);
    const emptyCoverage = {
      numeric: { supported: 0, total: 0, rate: null },
      factualClaims: { supported: 0, total: 0, rate: null },
      judgments: { cited: 0, total: 0, rate: null },
    } as const;

    // Assemble FIRST so verification covers the actual persisted object,
    // including deterministic scores/projections/fair-value/scenario targets
    // injected after the judge pass. The provisional metrics are replaced below.
    const assembled = assembleReport_(
      {
        symbol: ctx?.bundle.symbol ?? "",
        bundle: ctx?.bundle ?? MINIMAL_BUNDLE,
        computed: ctx?.computed ?? MINIMAL_COMPUTED,
        judgeOutput,
        verify: {
          verificationRate: null,
          coverage: emptyCoverage,
          log: [],
        },
        costEntries: [],
        model: deps.analysisModel,
        pipelineVersion: PIPELINE_VERSION,
        // Forward the Stage A validation gaps recovered from the WeakMap so the
        // verified report's appendix discloses them (H4). reconcileMeta in the
        // runner preserves appendix.missingData, so this is the manifest the
        // user ultimately sees on the primary (verify-succeeded) path.
        validationGaps: ctx?.validation.gaps ?? [],
      },
    );
    const bound = bindDeterministicReportProvenance(assembled, deps.payload);
    const verify = await runVerifyPass_(passDeps, deps.payload, bound, evidence);

    // Stamp the metrics produced from that full object, then parse the final
    // persisted shape once more so no post-verification mutation can bypass the
    // report contract.
    const verifiedReport = ReportSchema.parse({
      ...verify.verifiedReport,
      meta: {
        ...verify.verifiedReport.meta,
        verificationRate: verify.verificationRate,
        provenanceCoverage: verify.coverage,
      },
      appendix: {
        ...verify.verifiedReport.appendix,
        verificationRate: verify.verificationRate,
        provenanceCoverage: verify.coverage,
        verificationLog: verify.log,
      },
    });

    return {
      verifiedReport,
      verificationRate: verify.verificationRate,
      coverage: verify.coverage,
      log: verify.log,
    };
  },

  assembleReport(input: AssembleReportInput): Report {
    const costEntries: CostBreakdownEntry[] = input.costBreakdown.map((c) => ({
      step: c.step,
      model: c.model,
      costUsd: c.costUsd,
    }));
    const verificationLog: VerificationLogEntry[] = Array.isArray(input.verificationLog)
      ? (input.verificationLog as VerificationLogEntry[])
      : [];
    return assembleReport_(
      {
        symbol: input.meta.symbol,
        bundle: input.bundle,
        computed: input.computed,
        judgeOutput: input.judgeOutput,
        // A missing rate means verification did NOT run/measure — default to null
        // (honest "not measured"), never 1 (synthetic perfection on a report whose
        // verify pass failed). assembleReport_ then leaves provenanceCoverage at
        // the zero/null triplet, which reconcileMeta preserves.
        verify: { verificationRate: input.verificationRate ?? null, log: verificationLog },
        costEntries,
        model: input.meta.model,
        pipelineVersion: PIPELINE_VERSION,
        // Forward Stage A validation gaps into the appendix manifest (H4). The
        // runner passes `input.validation`; dropping it here is what made an
        // analyzed report strictly less transparent than a data-only one.
        validationGaps: input.validation.gaps,
      },
      input.meta.generatedAt,
    );
  },
};

/* ------------------------------------------------------------------------ *
 * Minimal stand-ins (only reached if the WeakMap context was collected — e.g.
 * a payload object the runner did not obtain from assembleContextPayload). In
 * the normal runner flow the real context is always present.
 * ------------------------------------------------------------------------ */

const MINIMAL_BUNDLE = {
  symbol: "",
  builtAt: new Date(0).toISOString(),
  profile: {
    ok: false as const,
    gap: { field: "profile", reason: "verify stand-in", severity: "info" as const },
  },
  asOf: {},
  gaps: [],
} as unknown as DataBundle;

const MINIMAL_COMPUTED = { gaps: [] } as unknown as ComputedMetrics;

export default pipelinePasses;
