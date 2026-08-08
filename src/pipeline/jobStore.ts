import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import { getDb, type ThesisDb } from "@/db";
import {
  costLog,
  jobPassArtifacts,
  jobs,
  reports,
  type JobRow,
} from "@/db/schema";
import {
  DURABLE_PASSES,
  computeJobResumePlan,
  readGenerationResumeArtifacts,
  type ComputedJobResumePlan,
  type CurrentGenerationPassArtifact,
  type DurablePass,
  type JobResumeState,
  type ResumeArtifacts,
} from "@/pipeline/jobArtifacts";

type JobStoreReadDb = Pick<ThesisDb, "select">;

export interface StoredJobResume {
  row: JobRow;
  artifacts: ResumeArtifacts;
  plan: ComputedJobResumePlan;
}

/**
 * Resolve the root of the immutable paid-artifact lineage represented by a
 * row. New retries persist it explicitly. A pre-column generation can only
 * have been produced by earlier retry machinery, so its deterministic legacy
 * fallback is generation zero rather than silently discarding ancestors.
 */
function resumeLineageRoot(row: JobRow): number {
  const explicit = row.resumeSourceGeneration;
  if (
    explicit !== null &&
    Number.isSafeInteger(explicit) &&
    explicit >= 0 &&
    explicit <= row.runGeneration
  ) {
    return explicit;
  }
  return 0;
}

interface FoldedLineageArtifacts {
  artifacts: CurrentGenerationPassArtifact[];
  corruptPasses: DurablePass[];
}

/**
 * Fold a retry lineage into one authoritative cohort. The newest generation
 * that mentions a pass (including a corrupt/failed attempt) supersedes older
 * attempts for that pass. A newer analyst invalidates older downstream work;
 * a newer synthesize attempt invalidates older verify work. Same-generation
 * downstream artifacts remain eligible because they were settled after their
 * upstream inputs in the same exact run.
 */
function foldLineageArtifacts(
  db: JobStoreReadDb,
  jobId: string,
  rootGeneration: number,
  throughGeneration: number,
): FoldedLineageArtifacts {
  const range = (column: typeof jobPassArtifacts.runGeneration | typeof costLog.runGeneration) =>
    and(gte(column, rootGeneration), lte(column, throughGeneration));
  const generations = new Set<number>();
  for (const row of db
    .select({ runGeneration: jobPassArtifacts.runGeneration })
    .from(jobPassArtifacts)
    .where(and(eq(jobPassArtifacts.jobId, jobId), range(jobPassArtifacts.runGeneration)))
    .all()) {
    generations.add(row.runGeneration);
  }
  for (const row of db
    .select({ runGeneration: costLog.runGeneration })
    .from(costLog)
    .where(and(
      eq(costLog.jobId, jobId),
      isNotNull(costLog.attemptId),
      range(costLog.runGeneration),
    ))
    .all()) {
    generations.add(row.runGeneration);
  }

  const selected = new Map<DurablePass, {
    artifacts: CurrentGenerationPassArtifact[];
    corrupt: boolean;
  }>();
  for (const generation of [...generations].sort((left, right) => left - right)) {
    const read = readGenerationResumeArtifacts(db, jobId, generation);
    const mentioned = new Set<DurablePass>([
      ...read.corruptPasses,
      ...read.artifacts.map((artifact) => artifact.pass),
    ]);
    if (mentioned.has("bull") || mentioned.has("bear")) {
      selected.delete("synthesize");
      selected.delete("verify");
    }
    if (mentioned.has("synthesize")) selected.delete("verify");
    for (const pass of DURABLE_PASSES) {
      if (!mentioned.has(pass)) continue;
      selected.set(pass, {
        artifacts: read.artifacts.filter((artifact) => artifact.pass === pass),
        corrupt: read.corruptPasses.includes(pass),
      });
    }
  }
  return {
    artifacts: DURABLE_PASSES.flatMap((pass) => selected.get(pass)?.artifacts ?? []),
    corruptPasses: DURABLE_PASSES.filter((pass) => selected.get(pass)?.corrupt === true),
  };
}

function buildStoredJobResume(
  db: JobStoreReadDb,
  row: JobRow,
  lineageRootGeneration: number,
  throughGeneration: number,
  authorityStatus: string,
): StoredJobResume {
  const reportExists = row.reportId !== null &&
    db
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.id, row.reportId))
      .get() !== undefined;
  const current = foldLineageArtifacts(
    db,
    row.id,
    lineageRootGeneration,
    throughGeneration,
  );
  const artifacts: ResumeArtifacts = {
    status: authorityStatus,
    runGeneration: lineageRootGeneration,
    reportId: row.reportId,
    reportExists,
    currentArtifacts: current.artifacts,
    corruptPasses: current.corruptPasses,
    legacyBullJson: row.bullJson,
    legacyBearJson: row.bearJson,
    legacyPayloadFingerprint: row.payloadFingerprint,
  };
  return { row, artifacts, plan: computeJobResumePlan(artifacts) };
}

/** Read every input to resume authority from one synchronous SQLite snapshot. */
export function readStoredJobResumeInTransaction(
  db: JobStoreReadDb,
  jobId: string,
): StoredJobResume | null {
  const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (row === undefined) return null;
  return buildStoredJobResume(
    db,
    row,
    resumeLineageRoot(row),
    row.runGeneration,
    row.status,
  );
}

/** Re-derive a queued retry from its durable immutable source cohort. */
export function readQueuedSourceJobResumeInTransaction(
  db: JobStoreReadDb,
  jobId: string,
): StoredJobResume | null {
  const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (row === undefined || row.status !== "queued" || row.runGeneration < 1) return null;
  return buildStoredJobResume(
    db,
    row,
    resumeLineageRoot(row),
    row.runGeneration - 1,
    "error",
  );
}

export function readStoredJobResume(jobId: string): StoredJobResume | null {
  return getDb().transaction((tx) => readStoredJobResumeInTransaction(tx, jobId));
}

export function readJobResumeState(jobId: string): JobResumeState | null {
  return readStoredJobResume(jobId)?.plan.state ?? null;
}
