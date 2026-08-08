/** POST /api/report/[jobId]/cancel — durably cancel a queued or running job. */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { assertSameOrigin } from "@/app/api/sameOrigin";
import { getDb } from "@/db";
import { jobs } from "@/db/schema";
import { cancelJob } from "@/pipeline/jobRunner";
import { kickJobScheduler } from "@/pipeline/jobScheduler";
import { noopPasses, resolvePasses } from "../../resolvePasses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resolveRunnablePasses = async () => (await resolvePasses()) ?? noopPasses();

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
      { error: "job could not be canceled because its durable execution state changed" },
      { status: 409 },
    );
  }
  kickJobScheduler(resolveRunnablePasses);
  return NextResponse.json({ jobId, canceled: true }, { status: 202 });
}
