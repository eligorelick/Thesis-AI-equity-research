/**
 * POST /api/jobs/resume — start the durable scheduler after a held startup.
 *
 * With `THESIS_RESUME_ON_START=0` the process boots without kicking the
 * scheduler, so queued PAID work waits for an explicit instruction. This route
 * is that instruction. It is same-origin guarded like every other mutating
 * route, and it is idempotent: kicking an already-running pump is a no-op,
 * because the claim transaction in SQLite is what actually decides who runs.
 *
 * Contract:
 *   POST -> 202 { resumed: true, queued: n }   n = jobs currently queued.
 *
 * Server-only route (nodejs runtime).
 */

import { NextResponse } from "next/server";
import { count, eq } from "drizzle-orm";
import { assertSameOrigin } from "@/app/api/sameOrigin";
import { getDb } from "@/db";
import { jobs } from "@/db/schema";
import { resumeReportScheduler } from "@/pipeline/jobSchedulerBootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  // Resuming releases paid work, so it carries the same trust boundary as
  // starting a report. Rejects before the scheduler is touched.
  const crossSite = assertSameOrigin(request);
  if (crossSite !== null) return crossSite;

  const queued = getDb()
    .select({ value: count() })
    .from(jobs)
    .where(eq(jobs.status, "queued"))
    .get()?.value ?? 0;

  await resumeReportScheduler();

  return NextResponse.json(
    { resumed: true, queued },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
