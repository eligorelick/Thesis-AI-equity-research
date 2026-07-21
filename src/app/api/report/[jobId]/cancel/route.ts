/** POST /api/report/[jobId]/cancel — cancel a queued or locally running job. */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { assertSameOrigin } from "@/app/api/sameOrigin";
import { getDb } from "@/db";
import { jobs } from "@/db/schema";
import { cancelJob } from "@/pipeline/jobRunner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  // CSRF trust boundary: reject provably cross-site browser requests before
  // touching job state.
  const crossSite = assertSameOrigin(request);
  if (crossSite !== null) return crossSite;

  const { jobId } = await params;
  const row = getDb().select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).get();
  if (row === undefined) {
    return NextResponse.json({ error: `no job with id "${jobId}"` }, { status: 404 });
  }
  if (row.status !== "queued" && row.status !== "running") {
    return NextResponse.json({ error: "job is already terminal" }, { status: 409 });
  }
  if (!cancelJob(jobId)) {
    return NextResponse.json(
      { error: "job could not be canceled because its local execution state changed" },
      { status: 409 },
    );
  }
  return NextResponse.json({ jobId, canceled: true }, { status: 202 });
}
