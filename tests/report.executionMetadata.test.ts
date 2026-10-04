import { describe, expect, it } from "vitest";

import { buildExecutionMetadataEntry, formatExecutionMetadata, sharedModelFamilyOf, subscriptionExecutionModels } from "@/report/execution";
import { ExecutionMetadataEntrySchema } from "@/report/schema";
import { explainAnalysisModel } from "@/settings/contracts";

describe("per-step execution metadata", () => {
  it("retains ChatGPT requested and reported reasoning, speed, and usage through stored report validation", () => {
    const entry = buildExecutionMetadataEntry({
      step: "bull", requestedModel: "chatgpt/gpt-6.1-sol", effectiveModel: "chatgpt/gpt-6.1-sol",
      requestedEffort: "low", fallbackUsed: false,
      execution: { requestedEffort: "xhigh", effectiveEffort: "high", requestedServiceTier: "fast", effectiveServiceTier: "priority" },
      usage: { input_tokens: 123, output_tokens: 456 },
    });
    const persisted = ExecutionMetadataEntrySchema.parse(JSON.parse(JSON.stringify(entry)));
    expect(persisted).toMatchObject({ requestedEffort: "xhigh", effectiveEffort: "high", requestedServiceTier: "fast", effectiveServiceTier: "priority", inputTokens: 123, outputTokens: 456, adjustments: [] });
    expect(formatExecutionMetadata(persisted)).toContain("speed requested fast, provider priority");
  });

  it("does not infer an applied OAuth setting when the provider omitted it", () => {
    const entry = buildExecutionMetadataEntry({
      step: "synthesize", requestedModel: "chatgpt/gpt-6.1-sol", effectiveModel: "chatgpt/gpt-6.1-sol",
      requestedEffort: "low", fallbackUsed: false,
      execution: { requestedEffort: "high", effectiveEffort: null, requestedServiceTier: "fast", effectiveServiceTier: null },
    });
    expect(entry.effectiveEffort).toBeNull();
    expect(entry.effectiveServiceTier).toBeNull();
    expect(entry.adjustments).not.toContain("effort-stripped");
    expect(formatExecutionMetadata(entry)).toContain("provider unknown");
  });

  it("discloses Gemini's observed models without treating an aggregate as the final-response model", () => {
    const entry = buildExecutionMetadataEntry({
      step: "bull", requestedModel: "gemini/auto", effectiveModel: "gemini/multiple-models",
      requestedEffort: "high", fallbackUsed: false,
      execution: { requestedEffort: null, effectiveEffort: null, observedModels: ["gemini-fast", "gemini-pro"] },
    });
    expect(ExecutionMetadataEntrySchema.parse(entry).observedModels).toEqual(["gemini-fast", "gemini-pro"]);
    expect(entry.note).toContain("combined usage is not attributed to a single model");
    expect(subscriptionExecutionModels([entry])).toEqual(["gemini/gemini-fast", "gemini/gemini-pro"]);
    expect(entry.requestedEffort).toBeNull();
    expect(sharedModelFamilyOf(["bull", "bear", "synthesize"].map((step) => ({ step, effectiveModel: "gemini/multiple-models" }))).shared).toBe(false);
  });

  it("records Haiku effort stripping instead of claiming the requested effort ran", () => {
    expect(
      buildExecutionMetadataEntry({
        step: "bull",
        requestedModel: "claude-haiku-4-5",
        effectiveModel: "claude-haiku-4-5",
        requestedEffort: "low",
        fallbackUsed: false,
      }),
    ).toMatchObject({
      requestedEffort: "low",
      effectiveEffort: null,
      adjustments: ["effort-stripped"],
    });
  });

  it("records the Sonnet judge floor separately from Haiku analyst passes", () => {
    expect(
      buildExecutionMetadataEntry({
        step: "synthesize",
        requestedModel: "claude-haiku-4-5",
        effectiveModel: "claude-sonnet-5",
        requestedEffort: "low",
        fallbackUsed: false,
      }),
    ).toMatchObject({
      requestedModel: "claude-haiku-4-5",
      effectiveModel: "claude-sonnet-5",
      requestedEffort: "low",
      effectiveEffort: "low",
      adjustments: ["model-floor"],
    });
  });

  /**
   * The floor is a synthesize-only rule keyed on the registry's
   * judgeFloorModelId; an analyst pass that somehow ran on Sonnet is not
   * "floored", and must not carry the judge's adjustment and note.
   */
  it("does not label an analyst pass with the judge floor", () => {
    expect(
      buildExecutionMetadataEntry({
        step: "bull",
        requestedModel: "claude-haiku-4-5",
        effectiveModel: "claude-sonnet-5",
        requestedEffort: null,
        fallbackUsed: false,
      }),
    ).toMatchObject({ adjustments: [] });
  });

  /**
   * D-02's disclosure clause: a stored model id the registry refuses degrades
   * the run to a data-only report, and the reason is named here rather than
   * living only in a transient step detail.
   */
  it("records a rejected model as its own adjustment, with the message", () => {
    const rejected = buildExecutionMetadataEntry({
      step: "bull",
      requestedModel: "claude-opus-5-20260115",
      effectiveModel: "none",
      requestedEffort: "high",
      fallbackUsed: false,
      rejectedReason: explainAnalysisModel("claude-opus-5-20260115") ?? "",
    });
    expect(rejected).toMatchObject({
      requestedModel: "claude-opus-5-20260115",
      effectiveModel: "none",
      requestedEffort: "high",
      effectiveEffort: null,
      adjustments: ["model-rejected"],
    });
    expect(rejected.note).toContain("dated snapshot ids do not exist");
    expect(rejected.note).toContain("claude-opus-5");
    // A rejection is not also an effort-stripping or a model floor.
    expect(rejected.adjustments).toHaveLength(1);
    // The report schema accepts the new adjustment.
    expect(ExecutionMetadataEntrySchema.parse(rejected)).toEqual(rejected);
  });
});
