/**
 * GET /api/report/[jobId] — JSON job status/snapshot (polling fallback for
 * clients that can't hold an SSE connection). Returns the same snapshot the
 * SSE endpoint replays first: status, the full StepProgress[], timing, error,
 * and reportId once the report is persisted.
 *
 * 404 when the job id is unknown. Server-only (nodejs runtime).
 */

import { NextResponse } from "next/server";
import { getJobSnapshot, type JobSnapshot } from "@/pipeline/events";
import { readJobResumeState } from "@/pipeline/jobStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<(JobSnapshot & { resumable: boolean }) | { error: string }>> {
  const { jobId } = await params;
  // Read-only by design. Scheduler/write surfaces reconcile expired leases;
  // this route never uses updatedAt as liveness or mutates job state.
  const snapshot = getJobSnapshot(jobId);
  if (snapshot === null) {
    return NextResponse.json({ error: `no job with id "${jobId}"` }, { status: 404 });
  }
  const resumeState = readJobResumeState(jobId);
  return NextResponse.json({ ...snapshot, resumable: resumeState?.resumable ?? false });
}
