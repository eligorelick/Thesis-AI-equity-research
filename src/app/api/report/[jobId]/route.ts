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
import { sweepAbandonedJobs } from "@/pipeline/jobRunner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<JobSnapshot | { error: string }>> {
  const { jobId } = await params;
  // A job orphaned by a process death must poll as a terminal error, not
  // spin as "running" forever.
  sweepAbandonedJobs();
  const snapshot = getJobSnapshot(jobId);
  if (snapshot === null) {
    return NextResponse.json({ error: `no job with id "${jobId}"` }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}
