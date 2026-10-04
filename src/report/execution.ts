import { judgeFloorModelId, resolveRegistryModel } from "@/models/registry";
import { parseSubscriptionModel, subscriptionModel, validModelId } from "@/ai/contracts";

export type ExecutionEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** Provider evidence, retained on durable artifacts independently of API charges. */
export interface ProviderExecution {
  requestedModel?: string;
  requestedEffort?: ExecutionEffort | null;
  effectiveEffort?: ExecutionEffort | null;
  requestedServiceTier?: "default" | "fast";
  effectiveServiceTier?: string | null;
  observedModels?: string[];
  /** False means a request id must not be represented as an observed model. */
  modelObserved?: boolean;
  /** False distinguishes unavailable usage from legacy telemetry's zero placeholders. */
  usageReported?: boolean;
}
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
  requestedServiceTier?: "default" | "fast";
  effectiveServiceTier?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  observedModels?: string[];
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
  execution?: ProviderExecution;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
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
  const requestedEffort = input.execution?.requestedEffort !== undefined
    ? input.execution.requestedEffort : input.requestedEffort;
  const effectiveModel = input.execution?.modelObserved === false ? "unknown" : input.effectiveModel;
  const requestedModel = input.execution?.requestedModel ?? input.requestedModel;
  const usage = input.execution?.usageReported === false ? undefined : input.usage;
  const effectiveEffort = input.execution?.effectiveEffort !== undefined
    ? input.execution.effectiveEffort
    : requestedEffort !== null && modelSupportsEffort(effectiveModel)
    ? requestedEffort
    : null;
  const adjustments: ExecutionAdjustment[] = [];
  const notes: string[] = [];
  const subscription = parseSubscriptionModel(effectiveModel) ?? parseSubscriptionModel(requestedModel);
  if (subscription) {
    const provider = subscription.provider === "chatgpt" ? "ChatGPT plan" : "Google Gemini CLI";
    notes.push(input.execution?.usageReported === false
      ? `${input.step}: the request was configured for ${provider} usage. Provider usage was not reported, so allowance consumption is unknown. $0 records API charges only, not free or unlimited usage. Provider limits and account credit settings apply. No additional web search was configured.`
      : `${input.step}: ${provider} allowance was used. $0 records API charges only, not free or unlimited usage. Provider limits and account credit settings apply. This pass used the supplied evidence without additional web search.`);
  }
  if (input.execution?.modelObserved === false) notes.push(`${input.step}: the provider did not report which model executed the request.`);
  if (subscription && input.execution?.modelObserved !== false && input.execution?.observedModels && input.execution.observedModels.length > 1) {
    notes.push(`${input.step}: provider reported usage for ${input.execution.observedModels.join(", ")}; the combined usage is not attributed to a single model.`);
  }
  const requestedFamily = resolveRegistryModel(input.requestedModel)?.entry.family;
  const effectiveFamily = resolveRegistryModel(effectiveModel)?.entry.family;
  // The floor is applied by the provider to the synthesize pass only, and to
  // the registry's `judgeFloorModelId` — the disclosure follows the same rule
  // rather than a hard-coded haiku→sonnet family pair, so moving the floor in
  // config/models.json cannot leave it undisclosed and an analyst pass can
  // never be labelled with the judge's adjustment.
  const floored =
    input.step === "synthesize" &&
    effectiveModel === judgeFloorModelId() &&
    input.requestedModel !== effectiveModel &&
    requestedFamily !== effectiveFamily;
  if (input.fallbackUsed) {
    adjustments.push("fallback");
    notes.push(
      `${input.step}: served by the server-side fallback model ${input.effectiveModel} after ${input.requestedModel} declined the request.`,
    );
  } else if (floored) {
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
  if (input.execution !== undefined && subscription) {
    if (requestedEffort !== null) notes.push(`${input.step}: requested reasoning ${requestedEffort}; ${effectiveEffort === null ? "the applied reasoning effort could not be established for the whole pass" : `provider reported ${effectiveEffort}`}.`);
    if (input.execution.requestedServiceTier !== undefined) notes.push(`${input.step}: requested ${input.execution.requestedServiceTier} speed; ${input.execution.effectiveServiceTier == null ? "the applied service tier could not be established for the whole pass" : `provider reported service tier ${input.execution.effectiveServiceTier}`}.`);
  } else if (requestedEffort !== null && effectiveEffort === null) {
    adjustments.push("effort-stripped");
    notes.push(
      subscription
        ? `${input.step}: ${input.effectiveModel} does not use the Claude API effort control; the requested effort ${input.requestedEffort} was not sent.`
        : `${input.step}: ${input.effectiveModel} does not accept output_config.effort; the requested effort ${input.requestedEffort} was not sent.`,
    );
  }
  return {
    step: input.step,
    requestedModel,
    effectiveModel,
    requestedEffort,
    fallbackUsed: input.fallbackUsed,
    effectiveEffort,
    ...(input.execution?.requestedServiceTier === undefined ? {} : { requestedServiceTier: input.execution.requestedServiceTier }),
    ...(input.execution?.effectiveServiceTier === undefined ? {} : { effectiveServiceTier: input.execution.effectiveServiceTier }),
    ...(usage?.input_tokens == null ? {} : { inputTokens: usage.input_tokens }),
    ...(usage?.output_tokens == null ? {} : { outputTokens: usage.output_tokens }),
    ...(input.execution?.observedModels === undefined || input.execution.modelObserved === false ? {} : { observedModels: input.execution.observedModels }),
    adjustments,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

/** Shared display text for the live report and both export formats. */
export function formatExecutionMetadata(entry: ExecutionMetadataEntry): string {
  const speed = entry.requestedServiceTier === undefined ? ""
    : `; speed requested ${entry.requestedServiceTier}, provider ${entry.effectiveServiceTier ?? "unknown"}`;
  const usage = entry.inputTokens === undefined && entry.outputTokens === undefined ? ""
    : `; tokens ${entry.inputTokens ?? "unknown"} input, ${entry.outputTokens ?? "unknown"} output`;
  return `${entry.step}: requested ${entry.requestedModel}/${entry.requestedEffort ?? "n/a"}; effective ${entry.effectiveModel}/${entry.effectiveEffort ?? "n/a"}${speed}${usage}${entry.adjustments.length ? ` (${entry.adjustments.join(", ")})` : ""}${entry.note ? `. ${entry.note}` : ""}`;
}

/** Actual subscription models, including a Gemini automatic selection's resolved model. */
export function subscriptionExecutionModels(entries: readonly ExecutionMetadataEntry[] | undefined): string[] {
  return [...new Set((entries ?? []).flatMap((entry) => {
    const subscription = parseSubscriptionModel(entry.effectiveModel);
    if (!subscription) return [];
    const observed = entry.observedModels?.filter(validModelId) ?? [];
    return subscription.model === "multiple-models" && observed.length
      ? observed.map((model) => subscriptionModel(subscription.provider, model))
      : [entry.effectiveModel];
  }))];
}

/* ------------------------------------------------------------------------ *
 * WS7 (D-20) — shared-model-family disclosure
 *
 * The judge grades two cases. When it runs on the SAME model family that wrote
 * them, the adjudication is not independent of the thing being adjudicated —
 * the same family's habits, blind spots and phrasing preferences sit on both
 * sides of the desk. That is not a defect to fix here (which model judges is a
 * cost/quality decision the operator makes), but it IS a fact the report has to
 * state, because a reader would otherwise take the judge for a second opinion.
 *
 * The family comes from the model registry, never from an id prefix: the
 * registry is the only authority on which family an id belongs to.
 * ------------------------------------------------------------------------ */

const ANALYST_STEPS = new Set(["bull", "bear"]);
const JUDGE_STEP = "synthesize";

function familyOf(model: string): string | null {
  const subscription = parseSubscriptionModel(model);
  if (subscription?.model === "multiple-models") return null;
  return resolveRegistryModel(model)?.entry.family ?? (subscription ? model : null);
}

export interface SharedModelFamily {
  shared: boolean;
  analystFamily: string | null;
  judgeFamily: string | null;
}

/**
 * Compare the family that actually SERVED the analyst passes with the one that
 * served the judge. `shared` is true only when both are known and equal, and
 * only when the two analyst sides agree with each other — a run whose sides were
 * served by different families (a server-side refusal fallback on one side) is
 * not a clean "the same family judged itself", so the claim is not made.
 */
export function sharedModelFamilyOf(
  entries: readonly { step: string; effectiveModel: string }[],
): SharedModelFamily {
  const analystFamilies = new Set(
    entries
      .filter((entry) => ANALYST_STEPS.has(entry.step))
      .map((entry) => familyOf(entry.effectiveModel)),
  );
  const judgeModel = entries.find((entry) => entry.step === JUDGE_STEP)?.effectiveModel;
  const judge = judgeModel === undefined ? null : familyOf(judgeModel);
  const analyst = analystFamilies.size === 1 ? ([...analystFamilies][0] ?? null) : null;
  return {
    shared: analyst !== null && judge !== null && analyst === judge,
    analystFamily: analyst,
    judgeFamily: judge,
  };
}

/**
 * Append the shared-family sentence to the judge step's execution note. Returns
 * a NEW array; the input entries are never mutated. A run with no judge step, or
 * one whose judge is a different family, comes back unchanged.
 */
export function annotateSharedModelFamily(
  entries: readonly ExecutionMetadataEntry[],
): ExecutionMetadataEntry[] {
  const shared = sharedModelFamilyOf(entries);
  if (!shared.shared) return entries.map((entry) => ({ ...entry }));
  const sentence =
    `${JUDGE_STEP}: the judge ran on ${shared.judgeFamily}, the same model family that wrote both ` +
    "analyst cases, so it graded output from its own family rather than acting as an independent second opinion.";
  return entries.map((entry) =>
    entry.step === JUDGE_STEP
      ? { ...entry, note: entry.note === undefined ? sentence : `${entry.note} ${sentence}` }
      : { ...entry },
  );
}
