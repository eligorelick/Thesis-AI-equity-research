import type { SchedulerKickOptions } from "@/pipeline/jobScheduler";
import { getConfig } from "@/config/env";

/**
 * Wake the process-local pump from durable SQLite state. Correctness and
 * backpressure come from the claim transaction, not from this call.
 */
export async function resumeReportScheduler(
  options: SchedulerKickOptions = {},
): Promise<void> {
  const [scheduler, passResolver] = await Promise.all([
    import("@/pipeline/jobScheduler"),
    import("@/app/api/report/resolvePasses"),
  ]);
  scheduler.kickJobScheduler(
    async () => (await passResolver.resolvePasses()) ?? passResolver.noopPasses(),
    options,
  );
}

/**
 * Start the pump on every Node boot, unless the operator held it back.
 *
 * With `THESIS_RESUME_ON_START=0` a queued job is PAID work that nobody asked
 * for again — a laptop that reboots mid-run would otherwise spend money before
 * its owner opened the app. Skipping the kick leaves the scheduler with no
 * resolver, so it claims nothing and arms no durable wake timer; the queue
 * waits for `POST /api/jobs/resume`, the Settings page control, or any later
 * report/retry/cancel request. Returns whether the pump was started.
 */
export async function bootstrapReportScheduler(
  options: SchedulerKickOptions = {},
): Promise<boolean> {
  if (!getConfig().resumeOnStart) {
    console.info(
      "[scheduler] THESIS_RESUME_ON_START=0: queued work is held until an operator " +
        "resumes it (POST /api/jobs/resume or the Settings page).",
    );
    return false;
  }
  await resumeReportScheduler(options);
  return true;
}
