import { PIPELINE_STEPS, type PipelineStep, type StepProgress } from "@/types/core";

const STEP_STATUSES = new Set<StepProgress["status"]>([
  "pending",
  "running",
  "done",
  "error",
  "skipped",
]);

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isValidJobStep(value: unknown): value is StepProgress {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const step = value as Partial<StepProgress>;
  if (!PIPELINE_STEPS.includes(step.step as PipelineStep)) return false;
  if (!STEP_STATUSES.has(step.status as StepProgress["status"])) return false;
  for (const timestamp of [step.startedAt, step.finishedAt, step.completedAt]) {
    if (timestamp !== undefined && !validTimestamp(timestamp)) return false;
  }
  if (step.detail !== undefined && typeof step.detail !== "string") return false;
  if (step.costUsd !== undefined && (
    typeof step.costUsd !== "number" || !Number.isFinite(step.costUsd) || step.costUsd < 0
  )) return false;
  return true;
}

/** Parse a canonical full pipeline snapshot, or a terminal-only ordered subset. */
export function parseCanonicalJobSteps(
  raw: string,
  options: { allowTerminalSubset?: boolean } = {},
): StepProgress[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(value) || !value.every(isValidJobStep)) return null;
  const positions = value.map((step) => PIPELINE_STEPS.indexOf(step.step));
  const uniqueCanonicalOrder = new Set(positions).size === positions.length &&
    positions.every((position, index) => index === 0 || position > positions[index - 1]!);
  if (!uniqueCanonicalOrder) return null;
  if (!options.allowTerminalSubset && (
    value.length !== PIPELINE_STEPS.length ||
    !PIPELINE_STEPS.every((step, index) => value[index]?.step === step)
  )) return null;
  return value;
}

/**
 * A durable report is stronger terminal truth than stale in-flight progress.
 * Preserve every already-terminal legacy step, but make pending/running rows
 * coherently terminal without attributing a failure that never occurred.
 */
export function normalizeLinkedReportRecoverySteps(
  raw: string,
  at: string,
  detail: string,
): string {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
  if (!Array.isArray(value)) return raw;
  const steps = value.map((candidate): unknown => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return candidate;
    }
    const step = candidate as Record<string, unknown>;
    if (step.status !== "pending" && step.status !== "running") return step;
    const wasRunning = step.status === "running";
    return {
      ...step,
      status: "skipped",
      detail,
      ...(wasRunning ? { finishedAt: at, completedAt: at } : {}),
    };
  });
  return JSON.stringify(steps);
}
