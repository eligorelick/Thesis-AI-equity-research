export type ExecutionEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ExecutionAdjustment = "model-floor" | "fallback" | "effort-stripped";

export interface ExecutionMetadataEntry {
  step: string;
  requestedModel: string;
  effectiveModel: string;
  requestedEffort: ExecutionEffort | null;
  effectiveEffort: ExecutionEffort | null;
  fallbackUsed: boolean;
  adjustments: ExecutionAdjustment[];
}

/** Models known to reject Anthropic's output_config.effort parameter. */
export function modelSupportsEffort(model: string): boolean {
  if (model.startsWith("claude-haiku-")) return false;
  if (model === "claude-sonnet-4-5" || model.startsWith("claude-sonnet-4-5-")) return false;
  return true;
}

export function buildExecutionMetadataEntry(input: {
  step: string;
  requestedModel: string;
  effectiveModel: string;
  requestedEffort: ExecutionEffort | null;
  fallbackUsed: boolean;
}): ExecutionMetadataEntry {
  const effectiveEffort = input.requestedEffort !== null && modelSupportsEffort(input.effectiveModel)
    ? input.requestedEffort
    : null;
  const adjustments: ExecutionAdjustment[] = [];
  if (input.fallbackUsed) {
    adjustments.push("fallback");
  } else if (
    input.requestedModel.startsWith("claude-haiku-") &&
    input.effectiveModel.startsWith("claude-sonnet-")
  ) {
    adjustments.push("model-floor");
  }
  if (input.requestedEffort !== null && effectiveEffort === null) {
    adjustments.push("effort-stripped");
  }
  return { ...input, effectiveEffort, adjustments };
}
