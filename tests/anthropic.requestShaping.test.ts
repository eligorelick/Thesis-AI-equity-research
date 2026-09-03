/**
 * One request-shaping contract per model family, driven by the registry so a
 * new entry is covered the moment it is added. Pins, for every active model:
 * no sampling params; effort only where supported; thinking never disabled;
 * max_tokens raised to the registry ceiling at effort high and above; the
 * Fable fallback beta; the web-search tool variant. No network.
 */
import { describe, expect, it } from "vitest";

import { activeModels, type RegistryModel } from "@/models/registry";
import {
  PASS_BILLING_EXPOSURE_MULTIPLIER,
  PASS_MAX_REQUESTS,
  buildPassParams,
  effectiveMaxTokens,
  maximumPassCostUsd,
  maximumRequestCostUsd,
  passWorstCaseCostUsd,
  modelContextTokenLimit,
  modelMaxOutputTokens,
  supportsEffort,
  thinkingConfigFor,
  webSearchTool,
} from "@/providers/anthropic";
import { buildExecutionMetadataEntry } from "@/report/execution";
import { judgeModelFor } from "@/pipeline/stageC/passes";

const baseOpts = {
  system: "system prompt",
  messages: [{ role: "user" as const, content: "hi" }],
  maxTokens: 8_000,
};

const families = new Map<string, RegistryModel>();
for (const entry of activeModels()) {
  if (!families.has(entry.family)) families.set(entry.family, entry);
}

describe.each(activeModels().map((entry) => [entry.id, entry] as const))("request shaping for %s", (id, entry) => {
  it("never sends temperature, top_p or top_k at any effort", () => {
    for (const effort of [undefined, "low", "medium", "high", "xhigh", "max"] as const) {
      const { params } = buildPassParams({ ...baseOpts, model: id, effort });
      expect(params).not.toHaveProperty("temperature");
      expect(params).not.toHaveProperty("top_p");
      expect(params).not.toHaveProperty("top_k");
    }
  });

  it("sends effort only when the registry says the model accepts it", () => {
    const { params } = buildPassParams({ ...baseOpts, model: id, effort: "high" });
    expect(supportsEffort(id)).toBe(entry.effort.supported);
    if (entry.effort.supported) {
      expect(params.output_config).toMatchObject({ effort: "high" });
    } else {
      expect(params).not.toHaveProperty("output_config");
    }
  });

  it("never disables thinking and follows the registry thinking rule", () => {
    const thinking = thinkingConfigFor(id);
    expect(thinking?.type).not.toBe("disabled");
    if (entry.thinking.mode === "adaptive" && entry.thinking.sendParam) {
      expect(thinking).toEqual({ type: "adaptive" });
    } else {
      expect(thinking).toBeUndefined();
    }
    for (const effort of ["xhigh", "max"] as const) {
      const { params } = buildPassParams({ ...baseOpts, model: id, effort });
      expect(params.thinking?.type).not.toBe("disabled");
    }
  });

  it("raises max_tokens to the registry ceiling at effort high and above, keeps the pass value below it", () => {
    expect(modelMaxOutputTokens(id)).toBe(entry.maxOutputTokens);
    expect(modelContextTokenLimit(id)).toBe(entry.contextWindowTokens);
    for (const effort of ["high", "xhigh", "max"] as const) {
      const expected = entry.effort.supported ? entry.maxOutputTokens : baseOpts.maxTokens;
      expect(effectiveMaxTokens({ model: id, maxTokens: baseOpts.maxTokens, effort })).toBe(expected);
      expect(buildPassParams({ ...baseOpts, model: id, effort }).params.max_tokens).toBe(expected);
    }
    for (const effort of [undefined, "low", "medium"] as const) {
      expect(buildPassParams({ ...baseOpts, model: id, effort }).params.max_tokens).toBe(baseOpts.maxTokens);
    }
    expect(() => buildPassParams({ ...baseOpts, model: id, maxTokens: entry.maxOutputTokens + 1 })).toThrow(/max_tokens/);
  });

  it("carries the server-side fallback beta exactly when the registry lists one", () => {
    const { params, usesFallbackBeta } = buildPassParams({ ...baseOpts, model: id });
    if (entry.serverSideFallback === null) {
      expect(usesFallbackBeta).toBe(false);
      expect(params).not.toHaveProperty("betas");
      expect(params).not.toHaveProperty("fallbacks");
    } else {
      expect(usesFallbackBeta).toBe(true);
      expect(params.betas).toEqual([entry.serverSideFallback.beta]);
      expect(params.fallbacks).toEqual([{ model: entry.serverSideFallback.model }]);
    }
  });

  it("uses the web-search tool variant the registry names", () => {
    expect(webSearchTool(4, id)).toMatchObject({ type: entry.webSearchToolType, max_uses: 4 });
  });

  it("bounds one request with the registry output ceiling and the 5-minute cache-write price", () => {
    const perRequestUsd =
      (entry.contextWindowTokens / 1e6) * entry.pricing.cacheWrite5mPerMTok +
      (entry.maxOutputTokens / 1e6) * entry.pricing.outputPerMTok +
      8 * 0.01;
    // What a single request can bill: the amount request-reservation mode
    // admits before sending it (DECISIONS D-10).
    expect(maximumRequestCostUsd(id, "bull")).toBeCloseTo(perRequestUsd, 6);
    // The pass worst case is reported, not reserved: every request the pass
    // could make, at that maximum.
    expect(passWorstCaseCostUsd(id, "bull")).toBeCloseTo(perRequestUsd * PASS_MAX_REQUESTS, 5);
    expect(maximumPassCostUsd(id, "bull")).toBeCloseTo(
      perRequestUsd * PASS_BILLING_EXPOSURE_MULTIPLIER,
      5,
    );
  });
});

describe("Haiku route", () => {
  it("floors the judge to Sonnet 5 and names both models and the effort handling in the disclosure", () => {
    expect(judgeModelFor("claude-haiku-4-5")).toBe("claude-sonnet-5");
    expect(judgeModelFor("claude-haiku-4-5-20251001")).toBe("claude-sonnet-5");
    for (const id of activeModels().filter((m) => m.family !== "haiku").map((m) => m.id)) {
      expect(judgeModelFor(id)).toBe(id);
    }
    const judge = buildExecutionMetadataEntry({
      step: "synthesize",
      requestedModel: "claude-haiku-4-5",
      effectiveModel: "claude-sonnet-5",
      requestedEffort: "xhigh",
      fallbackUsed: false,
    });
    expect(judge.adjustments).toEqual(["model-floor"]);
    expect(judge.effectiveEffort).toBe("xhigh");
    expect(judge.note).toContain("raised from claude-haiku-4-5 to claude-sonnet-5 (model-floor)");
    expect(judge.note).toContain("effort xhigh applied to claude-sonnet-5");
    expect(judge.note).toContain("claude-haiku-4-5 does not accept an effort setting, so the analyst passes on it ignore ANALYSIS_EFFORT");

    const analyst = buildExecutionMetadataEntry({
      step: "bull",
      requestedModel: "claude-haiku-4-5",
      effectiveModel: "claude-haiku-4-5",
      requestedEffort: "xhigh",
      fallbackUsed: false,
    });
    expect(analyst.adjustments).toEqual(["effort-stripped"]);
    expect(analyst.effectiveEffort).toBeNull();
    expect(analyst.note).toContain("does not accept output_config.effort; the requested effort xhigh was not sent");
    expect(buildPassParams({ ...baseOpts, model: "claude-haiku-4-5", effort: "xhigh" }).params).not.toHaveProperty("output_config");
  });

  it("leaves entries without adjustments free of a note", () => {
    const plain = buildExecutionMetadataEntry({
      step: "bull",
      requestedModel: "claude-opus-5",
      effectiveModel: "claude-opus-5",
      requestedEffort: "high",
      fallbackUsed: false,
    });
    expect(plain.adjustments).toEqual([]);
    expect(plain).not.toHaveProperty("note");
  });
});

describe("family coverage", () => {
  it("exercises every family the registry declares", () => {
    expect([...families.keys()].sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
  });
});
