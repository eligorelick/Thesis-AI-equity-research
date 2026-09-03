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
  return resolveRegistryModel(model)?.entry.family ?? null;
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
