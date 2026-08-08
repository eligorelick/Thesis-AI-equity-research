/** Next.js process-start hook. Edge and build-time evaluation stay inert. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { bootstrapReportScheduler } = await import("@/pipeline/jobSchedulerBootstrap");
  await bootstrapReportScheduler();
}
