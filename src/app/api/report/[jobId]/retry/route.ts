/**
 * POST /api/report/[jobId]/retry — resume a failed job from its persisted
 * bull/bear analyst snapshots (2026-07 audit item 1; partial shape 2026-07-10).
 *
 * The analyst passes are the expensive part of a run (web searches + large
 * streamed outputs). Two resumable shapes:
 *  - synthesize failed after both analysts → re-run ONLY the judge/verify/
 *    assemble tail against the persisted AnalystCase pair;
 *  - exactly one analyst failed → reuse the successful side's persisted
 *    snapshot and re-run ONLY the failed side, then synthesize.
 * Either way, nothing already paid for is re-billed.
 *
 * Contract:
 *   202 { jobId, resumed: true }  — resume started on the SAME job id (costs
 *                                   keep accumulating on its cost_log; the
 *                                   client re-opens the SSE stream).
 *   404 unknown job id.
 *   409 job is still queued/running, another job for the symbol is active, or
 *       there are no valid persisted snapshots to resume from (start a fresh
 *       run instead).
 *
 * Server-only route (nodejs runtime).
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { assertSameOrigin } from "@/app/api/sameOrigin";
import { getDb } from "@/db";
import { jobs } from "@/db/schema";
import {
  claimJobForResume,
  isSymbolJobActive,
  readPassSnapshots,
  runJob,
  snapshotsCoverResume,
  stepsShowResumableFailure,
  sweepAbandonedJobs,
} from "@/pipeline/jobRunner";
import { parseStepsJson } from "@/pipeline/events";
import { noopPasses, resolvePasses } from "../../resolvePasses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  // CSRF trust boundary: a retry re-runs paid LLM passes — reject provably
  // cross-site browser requests before any lookup or claim.
  const crossSite = assertSameOrigin(request);
  if (crossSite !== null) return crossSite;

  const { jobId } = await params;
  sweepAbandonedJobs();

  const row = getDb().select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (row === undefined) {
    return NextResponse.json({ error: `no job with id "${jobId}"` }, { status: 404 });
  }
  if (row.status === "queued" || row.status === "running") {
    return NextResponse.json(
      { error: "job is still active — nothing to retry yet" },
      { status: 409 },
    );
  }
  if (isSymbolJobActive(row.symbol)) {
    return NextResponse.json(
      { error: `another job for ${row.symbol} is already active` },
      { status: 409 },
    );
  }

  // Two resumable failure shapes (see stepsShowResumableFailure): synthesis
  // failed after both analysts, or exactly one analyst failed (the other's
  // paid output is persisted; only the failed side is re-billed). A job whose
  // synthesis already succeeded must never be re-billed (a degraded resume
  // could even overwrite its report link with a data-only stub).
  const steps = parseStepsJson(row.stepsJson);
  const snapshots = readPassSnapshots(jobId);
  // Resumable when the step shape shows a resumable failure OR — for a job
  // whose steps were rewritten to "skipped" by a degraded/second-swept resume
  // (snapshotsCoverResume) — when both paid analyst snapshots survive and
  // synthesize has not completed. The second arm keeps a re-resume from
  // stranding both already-paid snapshots behind a stale step shape.
  if (stepsShowResumableFailure(steps) === null && !snapshotsCoverResume(snapshots, steps)) {
    return NextResponse.json(
      { error: "job is not in a resumable state (no reusable analyst work, or the report already synthesized) — start a new run instead" },
      { status: 409 },
    );
  }

  // At least one persisted, schema-valid analyst snapshot must exist; the
  // runner's resume path reuses every valid side and re-runs the rest.
  if (snapshots === null) {
    return NextResponse.json(
      { error: "no persisted analyst passes to resume from — start a new run instead" },
      { status: 409 },
    );
  }

  // Claim atomically after validation. reportId is cleared so the snapshot
  // never serves the previous attempt's data-only report as if it were the
  // current result mid-run; the old reports row itself stays in history.
  // Persisted snapshots + cost_log rows stay attached to this job id.
  if (!claimJobForResume(jobId, row.status)) {
    return NextResponse.json(
      { error: "job state changed while retry was being prepared — reload before retrying" },
      { status: 409 },
    );
  }

  void (async () => {
    const passes = (await resolvePasses()) ?? noopPasses();
    try {
      await runJob(jobId, passes, { resume: true });
    } catch (err) {
      // runJob already recorded "error" on the job + emitted an error event;
      // this catch only prevents an unhandled rejection on the detached task.
      console.error(`runJob(${jobId}, resume) failed:`, err);
    }
  })();

  return NextResponse.json({ jobId, resumed: true }, { status: 202 });
}
