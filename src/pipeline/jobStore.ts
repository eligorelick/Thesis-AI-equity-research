import { eq } from "drizzle-orm";
import { getDb, type ThesisDb } from "@/db";
import { jobs, reports, type JobRow } from "@/db/schema";
import {
  computeJobResumePlan,
  readGenerationResumeArtifacts,
  type ComputedJobResumePlan,
  type JobResumeState,
  type ResumeArtifacts,
} from "@/pipeline/jobArtifacts";

type JobStoreReadDb = Pick<ThesisDb, "select">;

export interface StoredJobResume {
  row: JobRow;
  artifacts: ResumeArtifacts;
  plan: ComputedJobResumePlan;
}

function buildStoredJobResume(
  db: JobStoreReadDb,
  row: JobRow,
  artifactGeneration: number,
  authorityStatus: string,
): StoredJobResume {
  const reportExists = row.reportId !== null &&
    db
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.id, row.reportId))
      .get() !== undefined;
  const current = readGenerationResumeArtifacts(db, row.id, artifactGeneration);
  const artifacts: ResumeArtifacts = {
    status: authorityStatus,
    runGeneration: artifactGeneration,
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
  return buildStoredJobResume(db, row, row.runGeneration, row.status);
}

/** Re-derive a queued retry from its immutable source generation (N-1). */
export function readQueuedSourceJobResumeInTransaction(
  db: JobStoreReadDb,
  jobId: string,
): StoredJobResume | null {
  const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (row === undefined || row.status !== "queued" || row.runGeneration < 1) return null;
  return buildStoredJobResume(db, row, row.runGeneration - 1, "error");
}

export function readStoredJobResume(jobId: string): StoredJobResume | null {
  return getDb().transaction((tx) => readStoredJobResumeInTransaction(tx, jobId));
}

export function readJobResumeState(jobId: string): JobResumeState | null {
  return readStoredJobResume(jobId)?.plan.state ?? null;
}
