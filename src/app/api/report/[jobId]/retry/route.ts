/**
 * POST /api/report/[jobId]/retry — resume a terminal job from its validated
 * durable pass artifacts (with generation-fenced legacy analyst fallback).
 *
 * The shared server authority may finish a verified report directly, reuse a
 * synthesize result and rerun verification, or reuse compatible analyst sides
 * and rerun only the missing tail. Nothing already paid for is re-billed.
 *
 * Contract:
 *   202 { jobId, resumed: true }  — resume queued on the SAME job id (costs
 *                                   keep accumulating on its cost_log; the
 *                                   client re-opens the SSE stream).
 *   404 unknown job id.
 *   409 job is still queued/running, another job for the symbol is active, or
 *       there is no compatible reusable durable work (start a fresh run).
 *
 * Server-only route (nodejs runtime).
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { assertSameOrigin } from "@/app/api/sameOrigin";
import { getDb } from "@/db";
import { jobs } from "@/db/schema";
import {
  claimPreparedJobResume,
  isSymbolJobActive,
  prepareJobResume,
} from "@/pipeline/jobRunner";
import { kickJobScheduler, reconcileExpiredJobClaims } from "@/pipeline/jobScheduler";
import { readJobResumeState } from "@/pipeline/jobStore";
import { noopPasses, resolvePasses } from "../../resolvePasses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resolveRunnablePasses = async () => (await resolvePasses()) ?? noopPasses();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  // CSRF trust boundary: a retry re-runs paid LLM passes — reject provably
  // cross-site browser requests before any lookup or claim.
  const crossSite = assertSameOrigin(request);
  if (crossSite !== null) return crossSite;

  const { jobId } = await params;
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
  if (row.status === "unsupported") {
    return NextResponse.json(
      { error: "unsupported instruments cannot enter company-analysis retry" },
      { status: 409 },
    );
  }
  if (row.status !== "done" && row.status !== "error") {
    return NextResponse.json({ error: `job status ${row.status} cannot be retried` }, { status: 409 });
  }
  // This is a mutating admission surface: reconcile physical expired owners
  // before the active-symbol check/unique-index transition. GET/SSE stay
  // read-only, while an expired sibling cannot spuriously force a retry 409.
  reconcileExpiredJobClaims();
  if (isSymbolJobActive(row.symbol)) {
    return NextResponse.json(
      { error: `another job for ${row.symbol} is already active` },
      { status: 409 },
    );
  }

  const prepared = prepareJobResume(jobId, row.status);
  if (prepared === null) {
    const authority = readJobResumeState(jobId);
    return NextResponse.json(
      {
        error: `job is not in a resumable state (${authority?.reason ?? "state unavailable"}) — start a new run instead`,
      },
      { status: 409 },
    );
  }

  // Claim atomically after validation. A dangling report projection remains
  // on the queued row so another process can re-check its existence; a real
  // linked report never reaches this branch. Artifacts and costs stay put.
  if (!claimPreparedJobResume(prepared)) {
    return NextResponse.json(
      { error: "job state changed while retry was being prepared — reload before retrying" },
      { status: 409 },
    );
  }

  kickJobScheduler(resolveRunnablePasses);

  return NextResponse.json({ jobId, resumed: true }, { status: 202 });
}
