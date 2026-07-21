/**
 * POST /api/report — start an async report-generation job for a symbol.
 *
 * Contract:
 *   POST { symbol: string } -> 202 { jobId }              (new background job)
 *   POST { symbol: string } -> 202 { jobId, existing:true } when a fresh active
 *   job for that symbol is already queued/running.
 *   400 on a malformed body / missing symbol.
 *
 * The job runs the full pipeline (fetch → validate → compute → bull → bear →
 * synthesize → verify) via runJob(). We do NOT await it — the client then
 * subscribes to GET /api/report/[jobId]/stream (SSE) or polls
 * GET /api/report/[jobId] for progress.
 *
 * The Stage C passes are resolved at RUNTIME via a dynamic import so this route
 * (and the whole build) never hard-depends on src/pipeline/stageC/index.ts.
 * When that module is absent or exportless, the runner still runs
 * fetch/validate/compute and persists a data-only report.
 *
 * Server-only route (nodejs runtime): imports @/db + provider clients.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/app/api/sameOrigin";
import {
  createJob,
  getReusableActiveJobForSymbol,
  runJob,
  sweepAbandonedJobs,
} from "@/pipeline/jobRunner";
import { noopPasses, resolvePasses } from "./resolvePasses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postBody = z.object({
  symbol: z
    .string()
    .trim()
    .min(1, "symbol is required")
    .max(12, "symbol too long")
    .regex(/^[A-Za-z0-9.\-]+$/, "symbol must be alphanumeric (with . or -)"),
});

export async function POST(request: Request): Promise<NextResponse> {
  // CSRF trust boundary: a cross-site browser page must not be able to start
  // a paid report run. Rejects before any parsing or DB work.
  const crossSite = assertSameOrigin(request);
  if (crossSite !== null) return crossSite;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be JSON" }, { status: 400 });
  }

  const parsed = postBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const symbol = parsed.data.symbol.toUpperCase();

  // Terminal-ize any job orphaned by a process death (any symbol) before
  // checking for a reusable one.
  sweepAbandonedJobs();

  const active = getReusableActiveJobForSymbol(symbol);
  if (active !== null) {
    return NextResponse.json({ jobId: active.jobId, existing: true }, { status: 202 });
  }

  const { jobId } = createJob(symbol);

  // Kick off the pipeline in the background — do NOT await. Resolve the passes
  // at runtime; a missing module degrades to a data-only report inside runJob.
  void (async () => {
    const passes = (await resolvePasses()) ?? noopPasses();
    try {
      await runJob(jobId, passes);
    } catch (err) {
      // runJob already recorded "error" on the job + emitted an error event;
      // this catch only prevents an unhandled rejection on the detached task.
      console.error(`runJob(${jobId}) failed:`, err);
    }
  })();

  return NextResponse.json({ jobId }, { status: 202 });
}
