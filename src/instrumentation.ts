/** Next.js process-start hook. Edge and build-time evaluation stay inert. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // Mint the per-process X-Thesis-Token before any route is served so a
  // non-browser client can read it from the data directory (docs/PRIVACY.md).
  // The token itself is never logged.
  const { ensureRequestToken } = await import("@/app/api/sameOrigin");
  const token = ensureRequestToken();
  if (token.persisted) {
    console.info(`[security] X-Thesis-Token for non-browser clients written to ${token.path}`);
  }
  const { bootstrapReportScheduler } = await import("@/pipeline/jobSchedulerBootstrap");
  await bootstrapReportScheduler();
}
