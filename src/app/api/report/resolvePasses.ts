/**
 * Shared Stage C passes resolution for the report routes (POST /api/report and
 * POST /api/report/[jobId]/retry). Not a route file — just a helper module
 * colocated with its consumers.
 *
 * Uses a STATIC-specifier dynamic import so the bundler resolves the
 * "@/pipeline/stageC" alias at build time (a variable specifier + webpackIgnore
 * would hit Node's loader at runtime, which does not understand the "@/" alias,
 * and always resolve to null). The import is still deferred to first use (not a
 * top-level import), and any failure degrades to null → runJob falls back to a
 * data-only report. The adapter (src/pipeline/stageC/index.ts) exports both
 * `pipelinePasses` and a default; we accept either, plus a legacy `passes`
 * name, defensively.
 */

import type { PipelinePasses } from "@/pipeline/jobRunner";

export async function resolvePasses(): Promise<PipelinePasses | null> {
  try {
    const mod: unknown = await import("@/pipeline/stageC").catch(() => null);
    if (mod === null || typeof mod !== "object") return null;
    const candidate =
      (mod as Record<string, unknown>).pipelinePasses ??
      (mod as Record<string, unknown>).passes ??
      (mod as Record<string, unknown>).default;
    if (candidate && typeof candidate === "object") {
      return candidate as PipelinePasses;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A PipelinePasses stub used when no real passes module is wired. Every pass
 * throws, so runJob marks the LLM steps "error" and persists a data-only
 * report — never crashing the app. (In practice the no-key path skips the LLM
 * steps before these are reached; this only matters if a key is present but the
 * passes module is missing.)
 */
export function noopPasses(): PipelinePasses {
  const missing = (): never => {
    throw new Error("Stage C passes module not wired (src/pipeline/stageC/passes.ts)");
  };
  return {
    assembleContextPayload: () => ({}),
    runBullThenBear: async () => missing(),
    runJudgePass: async () => missing(),
    runVerifyPass: async () => missing(),
    assembleReport: () => missing(),
  };
}
