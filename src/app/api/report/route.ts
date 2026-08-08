/**
 * POST /api/report — start an async report-generation job for a symbol.
 *
 * Contract:
 *   POST { symbol: string } -> 202 { jobId }              (new background job)
 *   POST { symbol: string } -> 202 { jobId, existing:true } when a reusable active
 *   job for that symbol is already queued/running.
 *   400 on a malformed body / missing symbol.
 *
 * The job runs the full pipeline (fetch → validate → compute → bull → bear →
 * synthesize → verify) through durable scheduler claims. We do not await the
 * process-local pump — the client then
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
import { getOrCreateJobForSymbol } from "@/pipeline/jobRunner";
import { kickJobScheduler } from "@/pipeline/jobScheduler";
import { noopPasses, resolvePasses } from "./resolvePasses";
import { SYMBOL_MAX_LENGTH, SYMBOL_PATTERN } from "@/symbol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postBody = z.object({
  symbol: z
    .string()
    .trim()
    .min(1, "symbol is required")
    .max(SYMBOL_MAX_LENGTH, "symbol too long")
    .regex(SYMBOL_PATTERN, "symbol must start/end alphanumeric (with . or - inside)"),
});

const resolveRunnablePasses = async () => (await resolvePasses()) ?? noopPasses();

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

  // This write/start surface reconciles expired durable claims before checking
  // for a reusable job. Read routes never infer liveness from updatedAt.
  const job = getOrCreateJobForSymbol(symbol);
  if (job.existing) {
    kickJobScheduler(resolveRunnablePasses);
    return NextResponse.json({ jobId: job.jobId, existing: true }, { status: 202 });
  }
  const { jobId } = job;

  // Wake the process-local pump; correctness and backpressure come from the DB
  // claim transaction. A missing pass module degrades to a data-only report.
  kickJobScheduler(resolveRunnablePasses);

  return NextResponse.json({ jobId }, { status: 202 });
}
