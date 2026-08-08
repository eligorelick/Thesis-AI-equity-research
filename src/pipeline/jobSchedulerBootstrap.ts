import type { SchedulerKickOptions } from "@/pipeline/jobScheduler";

/** Start the process-local pump from durable SQLite state on every Node boot. */
export async function bootstrapReportScheduler(
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
