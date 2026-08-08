import { and, eq } from "drizzle-orm";
import { getDb, type ThesisDb } from "@/db";
import {
  costLog,
  jobPassArtifacts,
  jobs,
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

type SettlementDb = Pick<ThesisDb, "select" | "insert" | "update">;

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
  row: typeof costLog.$inferSelect,
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

function legacySnapshot<T>(data: T, telemetry: PassTelemetry): string {
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
      .select({ runGeneration: jobs.runGeneration })
      .from(jobs)
      .where(eq(jobs.id, input.jobId))
      .get();
    return {
      inserted: false,
      currentGeneration: current?.runGeneration === input.runGeneration,
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
        createdAt: input.settledAt ?? new Date().toISOString(),
      })
      .run();
  }

  let currentGeneration = false;
  if (
    input.settlement.outcome === "success" &&
    (input.pass === "bull" || input.pass === "bear")
  ) {
    const current = tx
      .select({
        runGeneration: jobs.runGeneration,
        payloadFingerprint: jobs.payloadFingerprint,
      })
      .from(jobs)
      .where(eq(jobs.id, input.jobId))
      .get();
    currentGeneration = current?.runGeneration === input.runGeneration;
    if (current !== undefined && currentGeneration) {
      const opposite = input.pass === "bull" ? "bearJson" : "bullJson";
      const own = input.pass === "bull" ? "bullJson" : "bearJson";
      const cohortChanged = current.payloadFingerprint !== input.payloadFingerprint;
      const set: Record<string, string | null> = {
        [own]: legacySnapshot(input.settlement.data, prepared.telemetry),
        payloadFingerprint: input.payloadFingerprint,
      };
      if (cohortChanged) set[opposite] = null;
      tx.update(jobs)
        .set({ ...set, updatedAt: input.settledAt ?? new Date().toISOString() })
        .where(and(eq(jobs.id, input.jobId), eq(jobs.runGeneration, input.runGeneration)))
        .run();
    }
  } else {
    const current = tx
      .select({ runGeneration: jobs.runGeneration })
      .from(jobs)
      .where(eq(jobs.id, input.jobId))
      .get();
    currentGeneration = current?.runGeneration === input.runGeneration;
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
    (tx) => persistPassSettlementInTransaction(tx, input, prepared),
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

/** Read and strictly validate only artifacts belonging to the job's current generation. */
export function readCurrentGenerationPassArtifacts(
  jobId: string,
): CurrentGenerationPassArtifact[] {
  const row = getDb()
    .select({ runGeneration: jobs.runGeneration })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  if (!row) return [];
  const rows = getDb()
    .select()
    .from(jobPassArtifacts)
    .where(and(
      eq(jobPassArtifacts.jobId, jobId),
      eq(jobPassArtifacts.runGeneration, row.runGeneration),
    ))
    .all();
  const parsed = rows
    .map(parsePassArtifactRow)
    .sort((left, right) =>
      left.settledAt.localeCompare(right.settledAt) ||
      left.pass.localeCompare(right.pass) ||
      left.attemptId.localeCompare(right.attemptId),
    );
  const ledger = getDb()
    .select()
    .from(costLog)
    .where(and(
      eq(costLog.jobId, jobId),
      eq(costLog.runGeneration, row.runGeneration),
    ))
    .all()
    .filter((cost) => cost.attemptId !== null);
  for (const artifact of parsed) {
    const costs = ledger.filter(
      (cost) => cost.attemptId === artifact.attemptId && cost.step === artifact.pass,
    );
    if (artifact.cost.billable) {
      if (costs.length !== 1 || !matchingCost(costs[0]!, artifact.telemetry)) {
        throw new Error("jobArtifacts: billable artifact has no exact cost pair");
      }
    } else if (costs.length !== 0) {
      throw new Error("jobArtifacts: unbillable artifact unexpectedly has a cost row");
    }
  }
  for (const cost of ledger) {
    if (!parsed.some(
      (artifact) => artifact.attemptId === cost.attemptId && artifact.pass === cost.step,
    )) {
      throw new Error("jobArtifacts: cost row exists without its artifact");
    }
  }
  return parsed;
}
