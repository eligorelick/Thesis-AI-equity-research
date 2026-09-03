import { resolveRegistryModel } from "@/models/registry";

export type ExecutionEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ExecutionAdjustment =
  | "model-floor"
  | "fallback"
  | "effort-stripped"
  /**
   * The requested model was refused before any request was sent — a stored id
   * the registry does not accept, such as a dated snapshot for a 4.6+ family
   * (DECISIONS D-02). The run degrades to a data-only report; the note names
   * the value and the accepted forms.
   */
  | "model-rejected";

export interface ExecutionMetadataEntry {
  step: string;
  requestedModel: string;
  effectiveModel: string;
  requestedEffort: ExecutionEffort | null;
  effectiveEffort: ExecutionEffort | null;
  fallbackUsed: boolean;
  adjustments: ExecutionAdjustment[];
  /**
   * One sentence per adjustment naming what changed and why (which model ran,
   * which effort applied to it, and why the requested one did not). Absent
   * when nothing was adjusted.
   */
  note?: string;
}

/** Whether the model registry says a model accepts output_config.effort; unknown ids do not. */
export function modelSupportsEffort(model: string): boolean {
  return resolveRegistryModel(model)?.entry.effort.supported === true;
}

export function buildExecutionMetadataEntry(input: {
  step: string;
  requestedModel: string;
  effectiveModel: string;
  requestedEffort: ExecutionEffort | null;
  fallbackUsed: boolean;
  /**
   * Why the requested model was refused before any request was sent (D-02).
   * When present the entry is a `model-rejected` disclosure: no model ran, so
   * no floor, fallback or effort adjustment can apply.
   */
  rejectedReason?: string;
}): ExecutionMetadataEntry {
  if (input.rejectedReason !== undefined) {
    return {
      step: input.step,
      requestedModel: input.requestedModel,
      effectiveModel: input.effectiveModel,
      requestedEffort: input.requestedEffort,
      fallbackUsed: input.fallbackUsed,
      effectiveEffort: null,
      adjustments: ["model-rejected"],
      note: `${input.step}: ${input.rejectedReason}`,
    };
  }
  const effectiveEffort = input.requestedEffort !== null && modelSupportsEffort(input.effectiveModel)
    ? input.requestedEffort
    : null;
  const adjustments: ExecutionAdjustment[] = [];
  const notes: string[] = [];
  const requestedFamily = resolveRegistryModel(input.requestedModel)?.entry.family;
  const effectiveFamily = resolveRegistryModel(input.effectiveModel)?.entry.family;
  if (input.fallbackUsed) {
    adjustments.push("fallback");
    notes.push(
      `${input.step}: served by the server-side fallback model ${input.effectiveModel} after ${input.requestedModel} declined the request.`,
    );
  } else if (requestedFamily === "haiku" && effectiveFamily === "sonnet") {
    adjustments.push("model-floor");
    const requestedAcceptsEffort = modelSupportsEffort(input.requestedModel);
    notes.push(
      `${input.step}: raised from ${input.requestedModel} to ${input.effectiveModel} (model-floor); ` +
        (effectiveEffort !== null
          ? `effort ${effectiveEffort} applied to ${input.effectiveModel}`
          : "no effort setting applied") +
        (requestedAcceptsEffort
          ? "."
          : `; ${input.requestedModel} does not accept an effort setting, so the analyst passes on it ignore ANALYSIS_EFFORT.`),
    );
  }
  if (input.requestedEffort !== null && effectiveEffort === null) {
    adjustments.push("effort-stripped");
    notes.push(
      `${input.step}: ${input.effectiveModel} does not accept output_config.effort; the requested effort ${input.requestedEffort} was not sent.`,
    );
  }
  return {
    step: input.step,
    requestedModel: input.requestedModel,
    effectiveModel: input.effectiveModel,
    requestedEffort: input.requestedEffort,
    fallbackUsed: input.fallbackUsed,
    effectiveEffort,
    adjustments,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}
