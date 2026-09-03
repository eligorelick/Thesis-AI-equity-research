import { describe, expect, it } from "vitest";

import { buildExecutionMetadataEntry } from "@/report/execution";
import { ExecutionMetadataEntrySchema } from "@/report/schema";
import { explainAnalysisModel } from "@/settings/contracts";

describe("per-step execution metadata", () => {
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
