import { describe, expect, it } from "vitest";

import { buildExecutionMetadataEntry } from "@/report/execution";

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
});
