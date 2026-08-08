/** Canonical, revisioned mutations for the complete durable job snapshot. */
import "server-only";

import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, type ThesisDb } from "@/db";
import { jobs } from "@/db/schema";

export type JobStateRow = typeof jobs.$inferSelect;
export type JobStatePatch = Partial<
  Omit<JobStateRow, "id" | "symbol" | "createdAt" | "revision" | "updatedAt">
>;

export interface JobStateFence {
  /** Strict source-state CAS; unlike revision rebasing, callers opt in explicitly. */
  expectedRevision?: number;
  runGeneration?: number;
  status?: string | readonly string[];
  leaseOwner?: string | null;
  /** When set, the stored lease must exist and be strictly later than this instant. */
  leaseValidAfter?: Date | string | "mutation-time";
}

export interface MutateJobSnapshotInput {
  jobId: string;
  /** Deterministic test clock; production omits it so time is sampled after BEGIN IMMEDIATE. */
  now?: Date | (() => Date);
  fence?: JobStateFence;
  /** Explicit invalidation for newly committed snapshot truth outside jobs. */
  forceRevision?: boolean;
  mutate: (row: Readonly<JobStateRow>) => JobStatePatch | null;
}

export interface JobStateMutationResult {
  revision: number;
  row: JobStateRow;
}

function validDate(value: Date, label: string): string {
  if (!Number.isFinite(value.getTime())) throw new Error(`jobState: invalid ${label}`);
  return value.toISOString();
}

function resolveClock(clock: Date | (() => Date) | undefined, label: string): Date {
  const value = typeof clock === "function" ? clock() : (clock ?? new Date());
  validDate(value, label);
  return value;
}

export function assertSafeJobRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("jobState: invalid or unsafe job revision");
  }
}

function leaseFenceIso(value: Date | string): string {
  if (value instanceof Date) return validDate(value, "lease fence time");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("jobState: invalid lease fence time");
  return new Date(parsed).toISOString();
}

function matchesFence(
  row: JobStateRow,
  fence: JobStateFence | undefined,
  leaseValidAfter: string | undefined,
): boolean {
  if (fence === undefined) return true;
  if (fence.expectedRevision !== undefined && row.revision !== fence.expectedRevision) return false;
  if (fence.runGeneration !== undefined && row.runGeneration !== fence.runGeneration) return false;
  if (fence.status !== undefined) {
    const statuses = typeof fence.status === "string" ? [fence.status] : fence.status;
    if (!statuses.includes(row.status)) return false;
  }
  if (fence.leaseOwner !== undefined && row.leaseOwner !== fence.leaseOwner) return false;
  if (leaseValidAfter !== undefined) {
    if (row.leaseExpiresAt === null || row.leaseExpiresAt <= leaseValidAfter) return false;
  }
  return true;
}

function changedPatch(row: JobStateRow, patch: JobStatePatch): JobStatePatch {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && !Object.is(row[key as keyof JobStateRow], value)) changed[key] = value;
  }
  return changed as JobStatePatch;
}

/**
 * Mutate snapshot-visible state inside an already-held writer transaction.
 * Revision is deliberately not an ownership token: the locked row is read and
 * the mutation rebases on its latest revision, while generation/status/lease
 * fences retain execution authority.
 */
export function mutateJobSnapshotInTransaction(
  tx: ThesisDb,
  input: MutateJobSnapshotInput,
): JobStateMutationResult | null {
  const nowIso = validDate(resolveClock(input.now, "mutation time"), "mutation time");
  const validLeaseAfter = input.fence?.leaseValidAfter === "mutation-time"
    ? nowIso
    : input.fence?.leaseValidAfter === undefined
      ? undefined
      : leaseFenceIso(input.fence.leaseValidAfter);
  const row = tx.select().from(jobs).where(eq(jobs.id, input.jobId)).get();
  if (row === undefined) return null;
  assertSafeJobRevision(row.revision);
  if (input.fence?.expectedRevision !== undefined) {
    assertSafeJobRevision(input.fence.expectedRevision);
  }
  if (!matchesFence(row, input.fence, validLeaseAfter)) return null;

  const proposed = input.mutate(Object.freeze({ ...row }));
  if (proposed === null) return null;
  const patch = changedPatch(row, proposed);
  if (Object.keys(patch).length === 0 && input.forceRevision !== true) return null;
  if (row.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error("jobState: safe job revision overflow");
  }

  const previousUpdatedAtMs = Date.parse(row.updatedAt);
  if (!Number.isFinite(previousUpdatedAtMs)) {
    throw new Error("jobState: invalid stored updatedAt");
  }
  const updatedAtMs = Math.max(previousUpdatedAtMs, Date.parse(nowIso));
  const updatedAt = new Date(updatedAtMs).toISOString();
  const predicates = [eq(jobs.id, input.jobId), eq(jobs.revision, row.revision)];
  if (input.fence?.expectedRevision !== undefined) {
    predicates.push(eq(jobs.revision, input.fence.expectedRevision));
  }
  if (input.fence?.runGeneration !== undefined) {
    predicates.push(eq(jobs.runGeneration, input.fence.runGeneration));
  }
  if (typeof input.fence?.status === "string") predicates.push(eq(jobs.status, input.fence.status));
  if (input.fence?.leaseOwner !== undefined) {
    predicates.push(input.fence.leaseOwner === null
      ? isNull(jobs.leaseOwner)
      : eq(jobs.leaseOwner, input.fence.leaseOwner));
  }
  if (validLeaseAfter !== undefined) {
    predicates.push(gt(jobs.leaseExpiresAt, validLeaseAfter));
  }
  const revision = row.revision + 1;
  const update = tx.update(jobs).set({
    ...patch,
    updatedAt,
    revision,
  }).where(and(...predicates)).run();
  if (update.changes !== 1) {
    throw new Error("jobState: canonical mutation fence changed inside writer transaction");
  }
  return {
    revision,
    row: { ...row, ...patch, updatedAt, revision },
  };
}

export function mutateJobSnapshot(
  input: MutateJobSnapshotInput,
  db: ThesisDb = getDb(),
): JobStateMutationResult | null {
  return db.transaction(
    (tx) => mutateJobSnapshotInTransaction(tx as ThesisDb, input),
    { behavior: "immediate" },
  );
}

export interface RenewInvisibleJobLeaseInput {
  jobId: string;
  runGeneration: number;
  leaseOwner: string;
  leaseTtlMs: number;
  /** Deterministic test clock; production omits it so time is sampled after BEGIN IMMEDIATE. */
  now?: Date | (() => Date);
}

/** Lease-only bookkeeping is intentionally invisible to snapshot revision/updatedAt. */
export function renewInvisibleJobLeaseInTransaction(
  input: RenewInvisibleJobLeaseInput,
  tx: ThesisDb,
): boolean {
  if (!Number.isSafeInteger(input.leaseTtlMs) || input.leaseTtlMs <= 0) {
    throw new Error("jobState: invalid lease TTL");
  }
  const authority = resolveClock(input.now, "lease renewal authority time");
  const authorityAt = authority.toISOString();
  const leaseExpiresAt = new Date(authority.getTime() + input.leaseTtlMs).toISOString();
  return tx.update(jobs).set({
    heartbeatAt: authorityAt,
    leaseExpiresAt,
  }).where(and(
    eq(jobs.id, input.jobId),
    eq(jobs.runGeneration, input.runGeneration),
    eq(jobs.status, "running"),
    eq(jobs.leaseOwner, input.leaseOwner),
    gt(jobs.leaseExpiresAt, authorityAt),
  )).run().changes === 1;
}

export function renewInvisibleJobLease(
  input: RenewInvisibleJobLeaseInput,
  db: ThesisDb = getDb(),
): boolean {
  return db.transaction(
    (tx) => renewInvisibleJobLeaseInTransaction(input, tx as ThesisDb),
    { behavior: "immediate" },
  );
}
