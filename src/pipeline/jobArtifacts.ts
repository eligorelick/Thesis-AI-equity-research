import { and, eq } from "drizzle-orm";
import { getDb, type ThesisDb } from "@/db";
import {
  costLog,
  jobPassArtifacts,
  jobs,
  type CostLogRow,
  type JobPassArtifactRow,
} from "@/db/schema";
import {
  ANALYST_CASE_SCHEMA,
  JUDGE_OUTPUT_SCHEMA,
  ReportSchema,
  type AnalystCase,
  type JudgeOutput,
  type Report,
} from "@/report/schema";
import { canonicalizeFetchedUrl } from "@/pipeline/stageC/provenance";
import { mutateJobSnapshotInTransaction } from "@/pipeline/jobState";

export const PASS_ARTIFACT_ENVELOPE_VERSION = 1 as const;

/** Stable execution order for every durable paid-pass boundary. */
export const DURABLE_PASSES = ["bull", "bear", "synthesize", "verify"] as const;
export type DurablePass = (typeof DURABLE_PASSES)[number];

export interface PassTelemetry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  costUsd: number;
  fallbackUsed: boolean;
  billable: boolean;
  fetchedUrls: string[];
}

export interface SerializedPassFailure {
  name: string;
  message: string;
  kind?: string;
  retryable?: boolean;
}

export type PassSettlement<T> =
  | { outcome: "success"; data: T; telemetry: PassTelemetry }
  | { outcome: "failure"; failure: SerializedPassFailure; telemetry: PassTelemetry };

export type PassSettlementHook<T> = (
  settlement: PassSettlement<T>,
) => void | Promise<void>;

export type PassArtifactEnvelope<T> =
  | {
      artifactVersion: typeof PASS_ARTIFACT_ENVELOPE_VERSION;
      outcome: "success";
      data: T;
      payloadFingerprint: string | null;
    }
  | {
      artifactVersion: typeof PASS_ARTIFACT_ENVELOPE_VERSION;
      outcome: "failure";
      failure: SerializedPassFailure;
      payloadFingerprint: string | null;
    };

export interface PassArtifactIdentity {
  jobId: string;
  runGeneration: number;
  attemptId: string;
  pass: DurablePass;
}

export interface PersistPassSettlementInput<T> extends PassArtifactIdentity {
  settlement: PassSettlement<T>;
  payloadFingerprint: string | null;
  settledAt?: string;
}

export interface PersistPassSettlementResult {
  inserted: boolean;
  currentGeneration: boolean;
  telemetry: PassTelemetry;
}

export interface CurrentGenerationPassArtifact<T = unknown>
  extends PassArtifactIdentity {
  envelope: PassArtifactEnvelope<T>;
  telemetry: PassTelemetry;
  cost: PassCostDetails;
  settledAt: string;
}

/** Structural result shared by reusable durable and legacy pass outputs. */
export interface ReusablePassResult<T> {
  data: T;
  model: string;
  costUsd: number;
  fallbackUsed: boolean;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  webSearches?: number;
  fetchedUrls?: string[];
}

export type ReusableAnalystPass = ReusablePassResult<AnalystCase>;
export type ReusableSynthesizePass = ReusablePassResult<JudgeOutput>;
export type ReusableVerifyPass = ReusablePassResult<Report>;

/** One coherent database snapshot used by the sole public resume authority. */
export interface ResumeArtifacts {
  status: string;
  runGeneration: number;
  reportId: number | null;
  reportExists: boolean;
  currentArtifacts: CurrentGenerationPassArtifact[];
  corruptPasses: DurablePass[];
  legacyBullJson: string | null;
  legacyBearJson: string | null;
  legacyPayloadFingerprint: string | null;
}

export interface JobResumeState {
  resumable: boolean;
  reusablePasses: DurablePass[];
  rerunPasses: DurablePass[];
  reason: string;
}

/** Internal typed plan; all public state is projected from this calculation. */
export interface ComputedJobResumePlan {
  state: JobResumeState;
  bull: ReusableAnalystPass | null;
  bear: ReusableAnalystPass | null;
  synthesize: ReusableSynthesizePass | null;
  verify: ReusableVerifyPass | null;
  payloadFingerprint: string | null;
  /**
   * Web-search URLs the analyst passes fetched, carried forward even when the
   * passes themselves are superseded by a reusable synthesize artifact.
   *
   * Verification measures citation coverage against the evidence the run
   * actually gathered. On a synthesize-reuse resume `bull`/`bear` are null by
   * design — synthesize already contains their conclusion — but dropping their
   * URLs shrank the evidence set verify checked against, understating coverage
   * for a report whose analysts had in fact fetched those sources.
   */
  analystFetchedUrls: string[];
}

export interface PassCostDetails {
  billable: boolean;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  costUsd: number;
  fallbackUsed: boolean;
}

/** Storage failures are control-plane failures, never provider/transport failures. */
export class PassSettlementHookError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PassSettlementHookError";
  }
}

export async function invokePassSettlementHook<T>(
  hook: PassSettlementHook<T> | undefined,
  settlement: PassSettlement<T>,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(settlement);
  } catch (error) {
    if (error instanceof PassSettlementHookError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new PassSettlementHookError(`pass settlement persistence failed: ${detail}`, {
      cause: error,
    });
  }
}

function boundedText(value: unknown, fallback: string, max: number): string {
  const text = typeof value === "string" ? value : fallback;
  const trimmed = text.trim();
  return (trimmed.length > 0 ? trimmed : fallback).slice(0, max);
}

export function serializePassFailure(
  error: unknown,
  details: { kind?: string; retryable?: boolean } = {},
): SerializedPassFailure {
  const candidate = error instanceof Error ? error : null;
  const failure: SerializedPassFailure = {
    name: boundedText(candidate?.name, "Error", 128),
    message: boundedText(candidate?.message ?? error, "unknown pass failure", 2_048),
  };
  if (details.kind !== undefined) failure.kind = boundedText(details.kind, "unknown", 128);
  if (details.retryable !== undefined) failure.retryable = details.retryable;
  return failure;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseFingerprint(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("jobArtifacts: invalid payload fingerprint");
  }
  return value;
}

function parseFailure(value: unknown): SerializedPassFailure {
  if (!isRecord(value)) throw new Error("jobArtifacts: invalid failure envelope");
  const allowed = ["name", "message"];
  if ("kind" in value) allowed.push("kind");
  if ("retryable" in value) allowed.push("retryable");
  if (!hasExactKeys(value, allowed)) throw new Error("jobArtifacts: unexpected failure fields");
  if (
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.length > 128 ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.length > 2_048 ||
    (value.kind !== undefined &&
      (typeof value.kind !== "string" || value.kind.length === 0 || value.kind.length > 128)) ||
    (value.retryable !== undefined && typeof value.retryable !== "boolean")
  ) {
    throw new Error("jobArtifacts: invalid failure fields");
  }
  return {
    name: value.name,
    message: value.message,
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    ...(value.retryable === undefined ? {} : { retryable: value.retryable }),
  };
}

function parseOutput(pass: DurablePass, value: unknown): AnalystCase | JudgeOutput | Report {
  const parsed =
    pass === "bull" || pass === "bear"
      ? ANALYST_CASE_SCHEMA.safeParse(value)
      : pass === "synthesize"
        ? JUDGE_OUTPUT_SCHEMA.safeParse(value)
        : ReportSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`jobArtifacts: schema-invalid ${pass} success artifact`);
  }
  return parsed.data;
}

/** Parse a legacy analyst projection without granting authority to step metadata. */
export function parseLegacyAnalystSnapshot(json: string | null): ReusableAnalystPass | null {
  if (json === null || json.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const parsedData = ANALYST_CASE_SCHEMA.safeParse(raw.data);
  if (
    !parsedData.success ||
    typeof raw.model !== "string" ||
    raw.model.trim().length === 0 ||
    typeof raw.costUsd !== "number" ||
    !Number.isFinite(raw.costUsd) ||
    raw.costUsd < 0 ||
    typeof raw.fallbackUsed !== "boolean"
  ) {
    return null;
  }
  const fetchedUrls = Array.isArray(raw.fetchedUrls)
    ? [
        ...new Set(
          raw.fetchedUrls.flatMap((value) => {
            if (typeof value !== "string") return [];
            const canonical = canonicalizeFetchedUrl(value);
            return canonical ? [canonical] : [];
          }),
        ),
      ].sort()
    : [];
  const usage = isRecord(raw.usage)
    ? {
        input_tokens: typeof raw.usage.input_tokens === "number" ? raw.usage.input_tokens : undefined,
        output_tokens: typeof raw.usage.output_tokens === "number" ? raw.usage.output_tokens : undefined,
        cache_read_input_tokens:
          typeof raw.usage.cache_read_input_tokens === "number"
            ? raw.usage.cache_read_input_tokens
            : undefined,
        cache_creation_input_tokens:
          typeof raw.usage.cache_creation_input_tokens === "number"
            ? raw.usage.cache_creation_input_tokens
            : undefined,
      }
    : undefined;
  return {
    data: parsedData.data,
    model: raw.model,
    costUsd: raw.costUsd,
    fallbackUsed: raw.fallbackUsed,
    ...(usage === undefined ? {} : { usage }),
    ...(typeof raw.webSearches === "number" ? { webSearches: raw.webSearches } : {}),
    fetchedUrls,
  };
}

interface AnalystResumeCandidate {
  pass: ReusableAnalystPass;
  fingerprint: string | null;
  source: "artifact" | "legacy";
}

function reusableResultFromArtifact<T>(
  artifact: CurrentGenerationPassArtifact,
): ReusablePassResult<T> {
  if (artifact.envelope.outcome !== "success") {
    throw new Error("jobArtifacts: analyst artifact is not successful");
  }
  return {
    data: artifact.envelope.data as T,
    model: artifact.telemetry.model,
    costUsd: artifact.telemetry.costUsd,
    fallbackUsed: artifact.telemetry.fallbackUsed,
    usage: {
      input_tokens: artifact.telemetry.inputTokens,
      output_tokens: artifact.telemetry.outputTokens,
      cache_read_input_tokens: artifact.telemetry.cacheReadTokens,
      cache_creation_input_tokens: artifact.telemetry.cacheWriteTokens,
    },
    webSearches: artifact.telemetry.webSearches,
    fetchedUrls: artifact.telemetry.fetchedUrls,
  };
}

function hasKnownPayloadFingerprint(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function analystResumeCandidate(
  input: ResumeArtifacts,
  side: "bull" | "bear",
): AnalystResumeCandidate | null {
  if (input.corruptPasses.includes(side)) return null;
  const current = input.currentArtifacts.filter((artifact) => artifact.pass === side);
  if (current.length > 0) {
    const successes = current.filter((artifact) => artifact.envelope.outcome === "success");
    if (successes.length !== 1) return null;
    const success = successes[0]!;
    if (!hasKnownPayloadFingerprint(success.envelope.payloadFingerprint)) return null;
    return {
      pass: reusableResultFromArtifact<AnalystCase>(success),
      fingerprint: success.envelope.payloadFingerprint,
      source: "artifact",
    };
  }
  const fingerprint = input.legacyPayloadFingerprint;
  if (typeof fingerprint !== "string" || fingerprint.trim().length === 0) return null;
  const pass = parseLegacyAnalystSnapshot(
    side === "bull" ? input.legacyBullJson : input.legacyBearJson,
  );
  return pass === null ? null : { pass, fingerprint, source: "legacy" };
}

function notResumable(reason: string): ComputedJobResumePlan {
  return {
    state: { resumable: false, reusablePasses: [], rerunPasses: [], reason },
    bull: null,
    bear: null,
    synthesize: null,
    verify: null,
    payloadFingerprint: null,
    analystFetchedUrls: [],
  };
}

/**
 * Every canonical URL the analyst passes fetched in this generation.
 *
 * Collected from the artifacts directly rather than from the reusable-pass
 * projection, because the synthesize- and verify-reuse plans deliberately null
 * `bull`/`bear` — their analysis is superseded — while verification still needs
 * the evidence those passes gathered.
 */
function analystFetchedUrlsFrom(input: ResumeArtifacts): string[] {
  const urls = new Set<string>();
  for (const artifact of input.currentArtifacts) {
    if (artifact.pass !== "bull" && artifact.pass !== "bear") continue;
    for (const raw of artifact.telemetry.fetchedUrls) {
      const canonical = canonicalizeFetchedUrl(raw);
      if (canonical) urls.add(canonical);
    }
  }
  return [...urls].sort();
}

function singleSuccessfulArtifact(
  input: ResumeArtifacts,
  pass: "synthesize" | "verify",
): CurrentGenerationPassArtifact | null {
  if (input.corruptPasses.includes(pass)) return null;
  const successes = input.currentArtifacts.filter(
    (artifact) => artifact.pass === pass && artifact.envelope.outcome === "success",
  );
  if (successes.length !== 1) return null;
  const success = successes[0]!;
  const fingerprint = success.envelope.payloadFingerprint;
  // Verify is a schema-valid final report, so Task 20's explicit null legacy
  // compatibility remains safe. Every artifact that can feed paid downstream
  // work must instead carry a known, nonblank payload provenance cohort.
  if (pass === "verify") {
    return fingerprint === null || hasKnownPayloadFingerprint(fingerprint) ? success : null;
  }
  return hasKnownPayloadFingerprint(fingerprint) ? success : null;
}

/** Detailed calculation consumed by preparation/execution; never inspect stepsJson. */
export function computeJobResumePlan(input: ResumeArtifacts): ComputedJobResumePlan {
  if (input.status !== "done" && input.status !== "error") {
    return notResumable(`job status ${input.status} is not terminal`);
  }
  if (input.reportId !== null && input.reportExists) {
    return notResumable("linked report already exists");
  }
  const dangling = input.reportId !== null && !input.reportExists;
  const verifyArtifact = singleSuccessfulArtifact(input, "verify");
  if (verifyArtifact !== null) {
    return {
      state: {
        resumable: true,
        reusablePasses: ["verify"],
        rerunPasses: [],
        reason: dangling
          ? "dangling report link; reusable verified report is available"
          : "reusable verified report is available",
      },
      bull: null,
      bear: null,
      synthesize: null,
      verify: reusableResultFromArtifact<Report>(verifyArtifact),
      payloadFingerprint: verifyArtifact.envelope.payloadFingerprint,
      analystFetchedUrls: analystFetchedUrlsFrom(input),
    };
  }
  const synthesizeArtifact = singleSuccessfulArtifact(input, "synthesize");
  if (synthesizeArtifact !== null) {
    return {
      state: {
        resumable: true,
        reusablePasses: ["synthesize"],
        rerunPasses: ["verify"],
        reason: dangling
          ? "dangling report link; reusable synthesize work is available"
          : "reusable synthesize work is available",
      },
      bull: null,
      bear: null,
      synthesize: reusableResultFromArtifact<JudgeOutput>(synthesizeArtifact),
      verify: null,
      payloadFingerprint: synthesizeArtifact.envelope.payloadFingerprint,
      analystFetchedUrls: analystFetchedUrlsFrom(input),
    };
  }

  for (const side of ["bull", "bear"] as const) {
    const successes = input.currentArtifacts.filter(
      (artifact) => artifact.pass === side && artifact.envelope.outcome === "success",
    );
    if (successes.length > 1) {
      return notResumable(`ambiguous current-generation ${side} successes`);
    }
  }

  let bull = analystResumeCandidate(input, "bull");
  let bear = analystResumeCandidate(input, "bear");
  if (bull && bear && bull.fingerprint !== bear.fingerprint) {
    if (bull.source === "artifact" && bear.source === "legacy") bear = null;
    else if (bear.source === "artifact" && bull.source === "legacy") bull = null;
    else return notResumable("reusable analyst artifacts have incompatible fingerprints");
  }
  if (bull === null && bear === null) {
    return notResumable("no reusable successful pass artifact");
  }

  const reusablePasses = DURABLE_PASSES.filter(
    (pass) => (pass === "bull" && bull !== null) || (pass === "bear" && bear !== null),
  );
  const rerunPasses = DURABLE_PASSES.filter(
    (pass) =>
      (pass === "bull" && bull === null) ||
      (pass === "bear" && bear === null) ||
      pass === "synthesize" ||
      pass === "verify",
  );
  return {
    state: {
      resumable: true,
      reusablePasses,
      rerunPasses,
      reason: dangling
        ? "dangling report link; reusable analyst work is available"
        : "reusable analyst work is available",
    },
    bull: bull?.pass ?? null,
    bear: bear?.pass ?? null,
    synthesize: null,
    verify: null,
    payloadFingerprint: bull?.fingerprint ?? bear?.fingerprint ?? null,
    analystFetchedUrls: analystFetchedUrlsFrom(input),
  };
}

export function computeJobResumeState(input: ResumeArtifacts): JobResumeState {
  return computeJobResumePlan(input).state;
}

export function parsePassArtifactEnvelope<T = unknown>(
  pass: DurablePass,
  value: string | unknown,
): PassArtifactEnvelope<T> {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      throw new Error("jobArtifacts: artifact outcome is not valid JSON");
    }
  }
  if (!isRecord(raw) || raw.artifactVersion !== PASS_ARTIFACT_ENVELOPE_VERSION) {
    throw new Error("jobArtifacts: unsupported artifact envelope version");
  }
  const payloadFingerprint = parseFingerprint(raw.payloadFingerprint);
  if (raw.outcome === "success") {
    if (!hasExactKeys(raw, ["artifactVersion", "outcome", "data", "payloadFingerprint"])) {
      throw new Error("jobArtifacts: unexpected success envelope fields");
    }
    return {
      artifactVersion: PASS_ARTIFACT_ENVELOPE_VERSION,
      outcome: "success",
      data: parseOutput(pass, raw.data) as T,
      payloadFingerprint,
    };
  }
  if (raw.outcome === "failure") {
    if (!hasExactKeys(raw, ["artifactVersion", "outcome", "failure", "payloadFingerprint"])) {
      throw new Error("jobArtifacts: unexpected failure envelope fields");
    }
    return {
      artifactVersion: PASS_ARTIFACT_ENVELOPE_VERSION,
      outcome: "failure",
      failure: parseFailure(raw.failure),
      payloadFingerprint,
    };
  }
  throw new Error("jobArtifacts: invalid artifact outcome");
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`jobArtifacts: invalid telemetry ${field}`);
  }
  return value;
}

export function normalizePassTelemetry(value: PassTelemetry): PassTelemetry {
  if (!isRecord(value)) throw new Error("jobArtifacts: invalid pass telemetry");
  if (!hasExactKeys(value, [
    "model",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "webSearches",
    "costUsd",
    "fallbackUsed",
    "billable",
    "fetchedUrls",
  ])) {
    throw new Error("jobArtifacts: unexpected telemetry fields");
  }
  if (typeof value.model !== "string" || value.model.trim().length === 0 || value.model.length > 256) {
    throw new Error("jobArtifacts: invalid telemetry model");
  }
  if (typeof value.costUsd !== "number" || !Number.isFinite(value.costUsd) || value.costUsd < 0) {
    throw new Error("jobArtifacts: invalid telemetry costUsd");
  }
  if (typeof value.fallbackUsed !== "boolean" || typeof value.billable !== "boolean") {
    throw new Error("jobArtifacts: invalid telemetry flags");
  }
  if (!Array.isArray(value.fetchedUrls) || value.fetchedUrls.some((url) => typeof url !== "string")) {
    throw new Error("jobArtifacts: invalid telemetry fetchedUrls");
  }
  const fetchedUrls = [
    ...new Set(
      value.fetchedUrls.map((url) => canonicalizeFetchedUrl(url)).filter((url): url is string => url !== null),
    ),
  ].sort();
  if (fetchedUrls.length !== value.fetchedUrls.length) {
    throw new Error("jobArtifacts: fetchedUrls must be unique canonical URLs");
  }
  return {
    model: value.model,
    inputTokens: nonNegativeInteger(value.inputTokens, "inputTokens"),
    outputTokens: nonNegativeInteger(value.outputTokens, "outputTokens"),
    cacheReadTokens: nonNegativeInteger(value.cacheReadTokens, "cacheReadTokens"),
    cacheWriteTokens: nonNegativeInteger(value.cacheWriteTokens, "cacheWriteTokens"),
    webSearches: nonNegativeInteger(value.webSearches, "webSearches"),
    costUsd: value.costUsd,
    fallbackUsed: value.fallbackUsed,
    billable: value.billable,
    fetchedUrls,
  };
}

function parseTelemetry(value: string | unknown): PassTelemetry {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      throw new Error("jobArtifacts: telemetry is not valid JSON");
    }
  }
  return normalizePassTelemetry(raw as PassTelemetry);
}

function costDetailsFromTelemetry(telemetry: PassTelemetry): PassCostDetails {
  return {
    billable: telemetry.billable,
    model: telemetry.model,
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    cacheReadTokens: telemetry.cacheReadTokens,
    cacheWriteTokens: telemetry.cacheWriteTokens,
    webSearches: telemetry.webSearches,
    costUsd: telemetry.costUsd,
    fallbackUsed: telemetry.fallbackUsed,
  };
}

export function parsePassCostDetails(value: string | unknown): PassCostDetails {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      throw new Error("jobArtifacts: cost details are not valid JSON");
    }
  }
  if (!isRecord(raw) || !hasExactKeys(raw, [
    "billable",
    "model",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "webSearches",
    "costUsd",
    "fallbackUsed",
  ])) {
    throw new Error("jobArtifacts: invalid cost details fields");
  }
  if (typeof raw.model !== "string" || raw.model.trim().length === 0 || raw.model.length > 256) {
    throw new Error("jobArtifacts: invalid cost details model");
  }
  if (typeof raw.costUsd !== "number" || !Number.isFinite(raw.costUsd) || raw.costUsd < 0) {
    throw new Error("jobArtifacts: invalid cost details costUsd");
  }
  if (typeof raw.billable !== "boolean" || typeof raw.fallbackUsed !== "boolean") {
    throw new Error("jobArtifacts: invalid cost details flags");
  }
  return {
    billable: raw.billable,
    model: raw.model,
    inputTokens: nonNegativeInteger(raw.inputTokens, "inputTokens"),
    outputTokens: nonNegativeInteger(raw.outputTokens, "outputTokens"),
    cacheReadTokens: nonNegativeInteger(raw.cacheReadTokens, "cacheReadTokens"),
    cacheWriteTokens: nonNegativeInteger(raw.cacheWriteTokens, "cacheWriteTokens"),
    webSearches: nonNegativeInteger(raw.webSearches, "webSearches"),
    costUsd: raw.costUsd,
    fallbackUsed: raw.fallbackUsed,
  };
}

function assertIdentity(identity: PassArtifactIdentity): void {
  if (identity.jobId.trim().length === 0 || identity.attemptId.trim().length === 0) {
    throw new Error("jobArtifacts: empty settlement identity");
  }
  if (!Number.isSafeInteger(identity.runGeneration) || identity.runGeneration < 0) {
    throw new Error("jobArtifacts: invalid run generation");
  }
  if (!(DURABLE_PASSES as readonly string[]).includes(identity.pass)) {
    throw new Error("jobArtifacts: invalid pass identity");
  }
}

export interface PreparedPassSettlement<T> {
  telemetry: PassTelemetry;
  envelope: PassArtifactEnvelope<T>;
  outcomeJson: string;
  telemetryJson: string;
  costJson: string;
}

/** Validate and normalize all provider-controlled fields before a DB transaction opens. */
export function preparePassSettlement<T>(
  input: PersistPassSettlementInput<T>,
): PreparedPassSettlement<T> {
  assertIdentity(input);
  const telemetry = normalizePassTelemetry(input.settlement.telemetry);
  const payloadFingerprint = parseFingerprint(input.payloadFingerprint);
  const envelope: PassArtifactEnvelope<T> =
    input.settlement.outcome === "success"
      ? {
          artifactVersion: PASS_ARTIFACT_ENVELOPE_VERSION,
          outcome: "success",
          data: parseOutput(input.pass, input.settlement.data) as T,
          payloadFingerprint,
        }
      : {
          artifactVersion: PASS_ARTIFACT_ENVELOPE_VERSION,
          outcome: "failure",
          failure: parseFailure(input.settlement.failure),
          payloadFingerprint,
        };
  return {
    telemetry,
    envelope,
    outcomeJson: JSON.stringify(envelope),
    telemetryJson: JSON.stringify(telemetry),
    costJson: JSON.stringify(costDetailsFromTelemetry(telemetry)),
  };
}

type SettlementDb = Pick<ThesisDb, "select" | "insert" | "delete">;

export interface PassProjectionFence {
  /** Fresh durable job-claim nonce; worker labels alone are never authority. */
  jobLeaseOwner: string;
  /** Exact settlement authority time, captured inside the acquired transaction. */
  authorityAt?: string;
}

function hasCurrentProjectionAuthority(
  current: {
    runGeneration: number;
    status: string;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
  } | undefined,
  inputGeneration: number,
  projectionFence: PassProjectionFence | undefined,
): boolean {
  if (current?.runGeneration !== inputGeneration) return false;
  if (projectionFence === undefined) return true;
  return current.status === "running" &&
    current.leaseOwner === projectionFence.jobLeaseOwner &&
    (
      projectionFence.authorityAt === undefined ||
      (current.leaseExpiresAt !== null && current.leaseExpiresAt > projectionFence.authorityAt)
    );
}

function artifactWhere(identity: PassArtifactIdentity) {
  return and(
    eq(jobPassArtifacts.jobId, identity.jobId),
    eq(jobPassArtifacts.runGeneration, identity.runGeneration),
    eq(jobPassArtifacts.attemptId, identity.attemptId),
    eq(jobPassArtifacts.pass, identity.pass),
  );
}

function costWhere(identity: PassArtifactIdentity) {
  return and(
    eq(costLog.jobId, identity.jobId),
    eq(costLog.runGeneration, identity.runGeneration),
    eq(costLog.attemptId, identity.attemptId),
    eq(costLog.step, identity.pass),
  );
}

function matchingCost(
  row: CostLogRow,
  telemetry: PassTelemetry,
): boolean {
  return row.model === telemetry.model &&
    row.inputTokens === telemetry.inputTokens &&
    row.outputTokens === telemetry.outputTokens &&
    row.cacheReadTokens === telemetry.cacheReadTokens &&
    row.cacheWriteTokens === telemetry.cacheWriteTokens &&
    row.webSearches === telemetry.webSearches &&
    row.costUsd === telemetry.costUsd &&
    row.fallbackUsed === telemetry.fallbackUsed;
}

export function passCostMatchesTelemetry(
  row: CostLogRow,
  telemetry: PassTelemetry,
): boolean {
  return matchingCost(row, telemetry);
}

/**
 * Separator between a pass attempt id and the sequence number of one provider
 * request inside it (DECISIONS D-10). A pass attempt id is a UUID, which can
 * never contain this character, so the prefix test below is unambiguous.
 */
export const REQUEST_ATTEMPT_SEPARATOR = "#r";

/**
 * Whether a `cost_log` row belongs to one pass attempt.
 *
 * In request-reservation mode (the default) a pass writes NO cost row of its
 * own: each provider request settles under `<passAttemptId>#rN` while the pass
 * artifact is stored under the bare attempt id with `billable: false`. Pairing
 * on exact attempt-id equality therefore declared every paid pass an orphaned
 * cost row, which discarded its artifacts and made a resume re-run — and
 * re-bill — the whole pass. Pairing is pass-scoped instead: the attempt's own
 * settlement, plus every request settled beneath it.
 */
export function costRowBelongsToAttempt(
  costAttemptId: string | null,
  attemptId: string,
): boolean {
  if (costAttemptId === null) return false;
  return costAttemptId === attemptId ||
    costAttemptId.startsWith(`${attemptId}${REQUEST_ATTEMPT_SEPARATOR}`);
}

/**
 * Drop the presumed row for an attempt whose real settlement just landed
 * (DECISIONS D-07). Always called INSIDE the settlement transaction, so the
 * exact cost replaces the presumed maximum atomically and no admission window
 * ever counts both. It lives beside the pass settlement writer, and the
 * scheduler's per-request settlement calls it too, so the two paths cannot
 * drift apart.
 */
export function reconcilePresumedCostFromSettlement(
  db: Pick<ThesisDb, "delete">,
  identity: { jobId: string; runGeneration: number; attemptId: string; pass: string },
): number {
  return db.delete(costLog)
    .where(and(
      eq(costLog.jobId, identity.jobId),
      eq(costLog.runGeneration, identity.runGeneration),
      eq(costLog.presumedAttemptId, identity.attemptId),
      eq(costLog.step, identity.pass),
    ))
    .run().changes;
}

export function serializeLegacyAnalystProjection<T>(data: T, telemetry: PassTelemetry): string {
  return JSON.stringify({
    data,
    model: telemetry.model,
    costUsd: telemetry.costUsd,
    fallbackUsed: telemetry.fallbackUsed,
    usage: {
      input_tokens: telemetry.inputTokens,
      output_tokens: telemetry.outputTokens,
      cache_read_input_tokens: telemetry.cacheReadTokens,
      cache_creation_input_tokens: telemetry.cacheWriteTokens,
    },
    webSearches: telemetry.webSearches,
    fetchedUrls: telemetry.fetchedUrls,
  });
}

/**
 * Transaction-aware primitive used by later budget/lease work. Callers must
 * validate/prepare outside a transaction when provider-controlled payload size
 * might be material; this function itself performs no network/model work.
 */
export function persistPassSettlementInTransaction<T>(
  tx: SettlementDb,
  input: PersistPassSettlementInput<T>,
  prepared: PreparedPassSettlement<T>,
  projectionFence?: PassProjectionFence,
): PersistPassSettlementResult {
  const existingArtifact = tx
    .select()
    .from(jobPassArtifacts)
    .where(artifactWhere(input))
    .get();
  const existingCost = tx.select().from(costLog).where(costWhere(input)).get();

  if (existingArtifact !== undefined) {
    const artifactMatches =
      existingArtifact.outcomeJson === prepared.outcomeJson &&
      existingArtifact.telemetryJson === prepared.telemetryJson &&
      existingArtifact.costJson === prepared.costJson;
    const costMatches = prepared.telemetry.billable
      ? existingCost !== undefined && matchingCost(existingCost, prepared.telemetry)
      : existingCost === undefined;
    if (!artifactMatches || !costMatches) {
      throw new Error("jobArtifacts: conflicting duplicate settlement or corrupt artifact/cost pair");
    }
    const current = tx
      .select({
        runGeneration: jobs.runGeneration,
        status: jobs.status,
        leaseOwner: jobs.leaseOwner,
        leaseExpiresAt: jobs.leaseExpiresAt,
      })
      .from(jobs)
      .where(eq(jobs.id, input.jobId))
      .get();
    return {
      inserted: false,
      currentGeneration: hasCurrentProjectionAuthority(
        current,
        input.runGeneration,
        projectionFence,
      ),
      telemetry: prepared.telemetry,
    };
  }
  if (existingCost !== undefined) {
    throw new Error("jobArtifacts: cost exists without its settlement artifact");
  }

  tx.insert(jobPassArtifacts)
    .values({
      jobId: input.jobId,
      runGeneration: input.runGeneration,
      attemptId: input.attemptId,
      pass: input.pass,
      outcomeJson: prepared.outcomeJson,
      telemetryJson: prepared.telemetryJson,
      costJson: prepared.costJson,
      settledAt: input.settledAt ?? new Date().toISOString(),
    })
    .run();

  if (prepared.telemetry.billable) {
    tx.insert(costLog)
      .values({
        jobId: input.jobId,
        runGeneration: input.runGeneration,
        attemptId: input.attemptId,
        step: input.pass,
        model: prepared.telemetry.model,
        inputTokens: prepared.telemetry.inputTokens,
        outputTokens: prepared.telemetry.outputTokens,
        cacheReadTokens: prepared.telemetry.cacheReadTokens,
        cacheWriteTokens: prepared.telemetry.cacheWriteTokens,
        webSearches: prepared.telemetry.webSearches,
        costUsd: prepared.telemetry.costUsd,
        fallbackUsed: prepared.telemetry.fallbackUsed,
        settlementKind: "actual",
        presumedAttemptId: null,
        reconciledAt: null,
        createdAt: input.settledAt ?? new Date().toISOString(),
      })
      .run();
  }

  // A settlement is evidence, so it supersedes any presumed maximum written
  // for this attempt when its lease expired (DECISIONS D-07). Deleting inside
  // the same transaction means no admission window ever counts both, and an
  // unbillable settlement still clears the presumption it replaces.
  reconcilePresumedCostFromSettlement(tx, {
    jobId: input.jobId,
    runGeneration: input.runGeneration,
    attemptId: input.attemptId,
    pass: input.pass,
  });

  let currentGeneration = false;
  if (
    input.settlement.outcome === "success" &&
    (input.pass === "bull" || input.pass === "bear")
  ) {
    const current = tx
      .select({
        runGeneration: jobs.runGeneration,
        status: jobs.status,
        leaseOwner: jobs.leaseOwner,
        leaseExpiresAt: jobs.leaseExpiresAt,
      })
      .from(jobs)
      .where(eq(jobs.id, input.jobId))
      .get();
    currentGeneration = hasCurrentProjectionAuthority(
      current,
      input.runGeneration,
      projectionFence,
    );
  } else {
    const current = tx
      .select({
        runGeneration: jobs.runGeneration,
        status: jobs.status,
        leaseOwner: jobs.leaseOwner,
        leaseExpiresAt: jobs.leaseExpiresAt,
      })
      .from(jobs)
      .where(eq(jobs.id, input.jobId))
      .get();
    currentGeneration = hasCurrentProjectionAuthority(
      current,
      input.runGeneration,
      projectionFence,
    );
  }

  return { inserted: true, currentGeneration, telemetry: prepared.telemetry };
}

export function persistPassSettlement<T>(
  input: PersistPassSettlementInput<T>,
): PersistPassSettlementResult {
  // Validate provider/model identity and output before acquiring the SQLite
  // write transaction. The transaction contains only bounded local work.
  const prepared = preparePassSettlement(input);
  return getDb().transaction(
    (tx) => {
      const result = persistPassSettlementInTransaction(tx, input, prepared);
      if (result.inserted) {
        const invalidation = mutateJobSnapshotInTransaction(tx as ThesisDb, {
          jobId: input.jobId,
          forceRevision: true,
          mutate: () => ({}),
        });
        if (invalidation === null) {
          throw new Error("jobArtifacts: settlement parent disappeared before revision invalidation");
        }
      }
      return result;
    },
    { behavior: "immediate" },
  );
}

function durablePass(value: string): DurablePass {
  if ((DURABLE_PASSES as readonly string[]).includes(value)) {
    return value as DurablePass;
  }
  throw new Error(`jobArtifacts: unknown stored pass ${value}`);
}

/** Strictly parse one stored row, including outcome, telemetry, and cost metadata. */
export function parsePassArtifactRow(row: JobPassArtifactRow): CurrentGenerationPassArtifact {
  const pass = durablePass(row.pass);
  const telemetry = parseTelemetry(row.telemetryJson);
  const cost = parsePassCostDetails(row.costJson);
  if (JSON.stringify(cost) !== JSON.stringify(costDetailsFromTelemetry(telemetry))) {
    throw new Error("jobArtifacts: telemetry/cost details mismatch");
  }
  return {
    jobId: row.jobId,
    runGeneration: row.runGeneration,
    attemptId: row.attemptId,
    pass,
    envelope: parsePassArtifactEnvelope(pass, row.outcomeJson),
    telemetry,
    cost,
    settledAt: row.settledAt,
  };
}

type ArtifactReadDb = Pick<ThesisDb, "select">;

export interface GenerationPassArtifactRead {
  artifacts: CurrentGenerationPassArtifact[];
  corruptPasses: DurablePass[];
  /** Parser/pairing detail retained so the legacy strict reader stays exact. */
  corruptionReasons: Partial<Record<DurablePass, string>>;
}

/** Resume-safe reader: corruption suppresses only the affected durable pass. */
export function readGenerationResumeArtifacts(
  db: ArtifactReadDb,
  jobId: string,
  runGeneration: number,
): GenerationPassArtifactRead {
  const rows = db
    .select()
    .from(jobPassArtifacts)
    .where(and(
      eq(jobPassArtifacts.jobId, jobId),
      eq(jobPassArtifacts.runGeneration, runGeneration),
    ))
    .all();
  const ledger = db
    .select()
    .from(costLog)
    .where(and(
      eq(costLog.jobId, jobId),
      eq(costLog.runGeneration, runGeneration),
    ))
    .all()
    .filter((cost) => cost.attemptId !== null);
  const artifacts: CurrentGenerationPassArtifact[] = [];
  const corrupt = new Set<DurablePass>();
  const corruptionReasons: Partial<Record<DurablePass, string>> = {};
  const hasUnknownPass = rows.some(
    (row) => !(DURABLE_PASSES as readonly string[]).includes(row.pass),
  ) || ledger.some(
    (row) => !(DURABLE_PASSES as readonly string[]).includes(row.step),
  );
  if (hasUnknownPass) {
    for (const pass of DURABLE_PASSES) {
      corruptionReasons[pass] = "jobArtifacts: invalid pass identity";
    }
    return {
      artifacts: [],
      corruptPasses: [...DURABLE_PASSES],
      corruptionReasons,
    };
  }

  for (const pass of DURABLE_PASSES) {
    const passRows = rows.filter((row) => row.pass === pass);
    const passLedger = ledger.filter((row) => row.step === pass);
    const parsed: CurrentGenerationPassArtifact[] = [];
    try {
      for (const row of passRows) parsed.push(parsePassArtifactRow(row));
      for (const artifact of parsed) {
        const costs = passLedger.filter(
          (cost) => costRowBelongsToAttempt(cost.attemptId, artifact.attemptId),
        );
        // Only the attempt's OWN row is the pass settlement; the `#rN` rows
        // beside it are the individual provider requests, which an unbillable
        // pass artifact is expected to have (D-10).
        const settlement = costs.filter((cost) => cost.attemptId === artifact.attemptId);
        if (artifact.cost.billable) {
          if (settlement.length !== 1 || !matchingCost(settlement[0]!, artifact.telemetry)) {
            throw new Error("jobArtifacts: billable artifact has no exact cost pair");
          }
        } else if (settlement.length !== 0) {
          throw new Error("jobArtifacts: unbillable artifact unexpectedly has a cost row");
        }
      }
      for (const cost of passLedger) {
        if (
          !parsed.some((artifact) => costRowBelongsToAttempt(cost.attemptId, artifact.attemptId))
        ) {
          throw new Error("jobArtifacts: cost row exists without its artifact");
        }
      }
      artifacts.push(...parsed);
    } catch (error) {
      corrupt.add(pass);
      corruptionReasons[pass] = error instanceof Error ? error.message : String(error);
    }
  }
  artifacts.sort((left, right) =>
    left.settledAt.localeCompare(right.settledAt) ||
    left.pass.localeCompare(right.pass) ||
    left.attemptId.localeCompare(right.attemptId),
  );
  return {
    artifacts,
    corruptPasses: DURABLE_PASSES.filter((pass) => corrupt.has(pass)),
    corruptionReasons,
  };
}

/** Strictly read one explicit generation, including every artifact/cost pairing. */
export function readGenerationPassArtifacts(
  db: ArtifactReadDb,
  jobId: string,
  runGeneration: number,
): CurrentGenerationPassArtifact[] {
  const result = readGenerationResumeArtifacts(db, jobId, runGeneration);
  if (result.corruptPasses.length > 0) {
    const first = result.corruptPasses[0]!;
    throw new Error(
      result.corruptionReasons[first] ??
        `jobArtifacts: corrupt artifact/cost pair for ${result.corruptPasses.join(", ")}`,
    );
  }
  return result.artifacts;
}

/** Read and strictly validate only artifacts belonging to the job's current generation. */
export function readCurrentGenerationPassArtifacts(
  jobId: string,
): CurrentGenerationPassArtifact[] {
  const db = getDb();
  const row = db
    .select({ runGeneration: jobs.runGeneration })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  return row === undefined ? [] : readGenerationPassArtifacts(db, jobId, row.runGeneration);
}
