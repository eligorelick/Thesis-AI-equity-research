/**
 * The model registry (config/models.json via src/models/registry.ts) is the
 * single source for model ids, request shaping and prices. These tests pin
 * the facts verified on 2026-09-02 and the acceptance rules for
 * ANALYSIS_MODEL. No network.
 */
import { describe, expect, it } from "vitest";

import {
  MODEL_REGISTRY,
  REGISTRY_SNAPSHOT_DATE,
  acceptedModelIds,
  activeModelIds,
  assertRegistryModel,
  autoPreferenceIds,
  cacheWriteMultiplier,
  explainRejectedModelId,
  isHighOrAboveEffort,
  isRegistryDatedSnapshot,
  parseModelRegistry,
  resolveRegistryModel,
} from "@/models/registry";
import {
  FABLE_FALLBACK_MODEL,
  MODEL_REGISTRY_SNAPSHOT_DATE,
  PREFERENCE_ORDER,
  PRICED_MODEL_ALIASES,
  SERVER_SIDE_FALLBACK_BETA,
  WEB_SEARCH_TOOL_TYPE,
  WEB_SEARCH_TOOL_TYPE_BASIC,
} from "@/providers/anthropic";
import { ANALYSIS_MODEL_OPTIONS, explainAnalysisModel, isValidDatedAnalysisModel } from "@/settings/contracts";
import { modelSupportsEffort } from "@/report/execution";

describe("config/models.json", () => {
  it("is stamped with a snapshot date and lists the six active models in preference-aware order", () => {
    expect(REGISTRY_SNAPSHOT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MODEL_REGISTRY_SNAPSHOT_DATE).toBe(REGISTRY_SNAPSHOT_DATE);
    expect(activeModelIds()).toEqual([
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    expect(PRICED_MODEL_ALIASES).toEqual(activeModelIds());
    expect(ANALYSIS_MODEL_OPTIONS).toEqual(["auto", ...activeModelIds()]);
  });

  it("carries the verified prices per MTok, including per-model cache prices", () => {
    const price = (id: string) => assertRegistryModel(id).entry.pricing;
    expect(price("claude-fable-5-1")).toEqual({
      inputPerMTok: 10, outputPerMTok: 50, cacheWrite5mPerMTok: 12.5, cacheWrite1hPerMTok: 20, cacheReadPerMTok: 0.25,
    });
    expect(price("claude-fable-5")).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1 });
    expect(price("claude-opus-5")).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10 });
    expect(price("claude-opus-4-8")).toEqual(price("claude-opus-5"));
    expect(price("claude-sonnet-5")).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 });
    expect(price("claude-haiku-4-5")).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 });
    // 5-minute writes bill 1.25x input and 1-hour writes 2x on every model.
    for (const id of activeModelIds()) {
      expect(cacheWriteMultiplier(assertRegistryModel(id).entry, "5m")).toBeCloseTo(1.25, 10);
      expect(cacheWriteMultiplier(assertRegistryModel(id).entry, "1h")).toBeCloseTo(2, 10);
    }
    expect(MODEL_REGISTRY.webSearchUsdPerThousand).toBe(10);
  });

  it("records context, output, effort, sampling, thinking and tool support per family", () => {
    const entry = (id: string) => assertRegistryModel(id).entry;
    for (const id of ["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-5"]) {
      expect(entry(id).contextWindowTokens).toBe(1_000_000);
      expect(entry(id).maxOutputTokens).toBe(128_000);
      expect(entry(id).effort).toEqual({ supported: true, levels: ["low", "medium", "high", "xhigh", "max"] });
      expect(entry(id).sampling).toEqual({ temperature: false, topP: false, topK: false });
      expect(entry(id).webSearchToolType).toBe(WEB_SEARCH_TOOL_TYPE);
      expect(modelSupportsEffort(id)).toBe(true);
    }
    expect(entry("claude-haiku-4-5")).toMatchObject({
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      effort: { supported: false, levels: [] },
      thinking: { mode: "none", sendParam: false },
      webSearchToolType: WEB_SEARCH_TOOL_TYPE_BASIC,
    });
    expect(modelSupportsEffort("claude-haiku-4-5")).toBe(false);
    expect(modelSupportsEffort("claude-haiku-4-5-20251001")).toBe(false);
    expect(modelSupportsEffort("claude-sonnet-4-5")).toBe(false);
    expect(entry("claude-fable-5-1").thinking).toEqual({ mode: "always-on", sendParam: false });
    expect(entry("claude-fable-5").thinking).toEqual({ mode: "always-on", sendParam: false });
    expect(entry("claude-opus-5").thinking).toEqual({ mode: "adaptive", sendParam: true });
    expect(entry("claude-opus-4-8").thinking).toEqual({ mode: "adaptive", sendParam: true });
    expect(entry("claude-sonnet-5").thinking).toEqual({ mode: "adaptive", sendParam: false });
    for (const id of ["claude-fable-5-1", "claude-fable-5"]) {
      expect(entry(id).serverSideFallback).toEqual({ beta: SERVER_SIDE_FALLBACK_BETA, model: FABLE_FALLBACK_MODEL });
    }
    for (const id of ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]) {
      expect(entry(id).serverSideFallback).toBeNull();
    }
  });

  it("puts claude-fable-5-1 in the auto policy without moving Opus 5 off the top", () => {
    expect(autoPreferenceIds()).toEqual([
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-fable-5-1",
      "claude-fable-5",
    ]);
    expect(PREFERENCE_ORDER).toEqual(autoPreferenceIds());
  });
});

describe("ANALYSIS_MODEL acceptance", () => {
  it("accepts every active registry id and both Haiku 4.5 forms", () => {
    for (const id of activeModelIds()) {
      expect(resolveRegistryModel(id)?.entry.id).toBe(id);
      expect(explainAnalysisModel(id)).toBeNull();
    }
    expect(resolveRegistryModel("claude-haiku-4-5-20251001")).toMatchObject({
      entry: { id: "claude-haiku-4-5" },
      viaDatedSnapshot: true,
    });
    expect(isRegistryDatedSnapshot("claude-haiku-4-5-20251001")).toBe(true);
    expect(isValidDatedAnalysisModel("claude-haiku-4-5-20251001")).toBe(true);
    expect(acceptedModelIds()).toEqual([...activeModelIds().slice(0, 5), "claude-haiku-4-5", "claude-haiku-4-5-20251001"]);
    expect(explainAnalysisModel("auto")).toBeNull();
  });

  it("rejects dated ids for the 4.6+ families with a message naming the pinned id", () => {
    for (const [dated, base] of [
      ["claude-opus-5-20260115", "claude-opus-5"],
      ["claude-opus-4-8-20260601", "claude-opus-4-8"],
      ["claude-sonnet-5-20260808", "claude-sonnet-5"],
      ["claude-fable-5-1-20260901", "claude-fable-5-1"],
      ["claude-fable-5-20260901", "claude-fable-5"],
    ] as const) {
      expect(resolveRegistryModel(dated)).toBeNull();
      expect(isValidDatedAnalysisModel(dated)).toBe(false);
      const message = explainRejectedModelId(dated);
      expect(message).toMatch(/dated snapshot ids do not exist/);
      expect(message).toContain(`use "${base}"`);
      expect(explainAnalysisModel(dated)).toBe(message);
      expect(() => assertRegistryModel(dated)).toThrow(/unsupported model/);
    }
    // A dated Haiku id the registry does not list is also rejected: acceptance
    // is by listing, never by shape.
    expect(resolveRegistryModel("claude-haiku-4-5-20260101")).toBeNull();
  });

  it("rejects -latest aliases and unknown ids with the accepted list", () => {
    expect(explainRejectedModelId("claude-opus-5-latest")).toMatch(/"-latest" aliases are not accepted; use "claude-opus-5"/);
    const unknown = explainRejectedModelId("claude-mystery-9");
    expect(unknown).toMatch(/not in the model registry/);
    expect(unknown).toContain(REGISTRY_SNAPSHOT_DATE);
    for (const id of acceptedModelIds()) expect(unknown).toContain(id);
  });

  it("treats high, xhigh and max as the effort tier that raises max_tokens", () => {
    expect(isHighOrAboveEffort("low")).toBe(false);
    expect(isHighOrAboveEffort("medium")).toBe(false);
    expect(isHighOrAboveEffort(undefined)).toBe(false);
    for (const level of ["high", "xhigh", "max"] as const) expect(isHighOrAboveEffort(level)).toBe(true);
  });
});

describe("registry validation", () => {
  const valid = () => JSON.parse(JSON.stringify(MODEL_REGISTRY)) as typeof MODEL_REGISTRY;

  it("round-trips the checked-in document", () => {
    expect(parseModelRegistry(valid())).toEqual(MODEL_REGISTRY);
  });

  it("fails fast on duplicate ids, malformed dated ids, unknown auto entries and inconsistent effort", () => {
    const dup = valid();
    dup.models.push({ ...dup.models[0]! });
    expect(() => parseModelRegistry(dup)).toThrow(/duplicate model id/);

    const badDated = valid();
    badDated.models[0]!.datedSnapshotIds = ["claude-other-20260101"];
    expect(() => parseModelRegistry(badDated)).toThrow(/is not claude-fable-5-1-YYYYMMDD/);

    const badAuto = valid();
    badAuto.autoPreference = ["claude-nope"];
    expect(() => parseModelRegistry(badAuto)).toThrow(/autoPreference names unknown model/);

    const badEffort = valid();
    badEffort.models[0]!.effort = { supported: true, levels: [] };
    expect(() => parseModelRegistry(badEffort)).toThrow(/effort.levels/);

    const badFallback = valid();
    badFallback.models[0]!.serverSideFallback = { beta: "x", model: "claude-nope" };
    expect(() => parseModelRegistry(badFallback)).toThrow(/fallback model claude-nope/);

    const badThinking = valid();
    badThinking.models[5]!.thinking = { mode: "none", sendParam: true };
    expect(() => parseModelRegistry(badThinking)).toThrow(/only adaptive thinking may send a param/);
  });
});
