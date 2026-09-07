/**
 * Pure unit tests for the Anthropic provider client. NO network calls:
 * model resolution runs against an injected fake client, cost math and
 * fallback detection run against synthetic payloads.
 */
import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicError,
  APIConnectionError,
  APIError,
  APIUserAbortError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type { BetaMessage, BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { resetConfigCache } from "@/config/env";
import { MODEL_STAGE_DEADLINE_MS } from "@/pipeline/leaseTiming";
import {
  CLIENT_MAX_RETRIES,
  MAX_PROVIDER_WEB_SEARCHES,
  PASS_TRANSPORT_MAX_ATTEMPTS,
  PASS_BILLING_EXPOSURE_MULTIPLIER,
  PASS_MAX_REQUESTS,
  PASS_MID_STREAM_RETRY_DELAYS_MS,
  PASS_TRANSPORT_RETRY_DELAYS_MS,
  PREFERENCE_ORDER,
  PRICING,
  WEB_SEARCH_TOOL_TYPE,
  WEB_SEARCH_USD_PER_SEARCH,
  MAX_PAUSE_RESUMPTIONS,
  _resetAnthropicForTests,
  _setTransportRetrySleepForTests,
  buildPassParams,
  collectFetchedUrls,
  computeCostUsd,
  connectionFailureCode,
  detectFallbackUsed,
  effectiveMaxTokens,
  findPricing,
  interpretPassMessage,
  isRetryableTransportError,
  isStreamConnectionFailure,
  modelContextTokenLimit,
  pickPreferredModel,
  pricedModelAlias,
  registryEntryFor,
  resolveModel,
  resumeIfPaused,
  runPass,
  runPassStreaming,
  streamIdleTimeoutMs,
  streamIdleTimeoutMsFor,
  requestInputTokenUpperBound,
  supportsEffort,
  thinkingConfigFor,
  webSearchTool,
} from "@/providers/anthropic";

afterEach(() => {
  _resetAnthropicForTests();
});

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

function fakeClient(modelIds: string[], counter?: { calls: number }): Anthropic {
  const page = {
    async *[Symbol.asyncIterator]() {
      for (const id of modelIds) yield { id };
    },
  };
  return {
    models: {
      list: () => {
        if (counter) counter.calls += 1;
        return page;
      },
    },
  } as unknown as Anthropic;
}

function syntheticUsage(over: Partial<BetaUsage> = {}): BetaUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    iterations: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
    ...over,
  } as BetaUsage;
}

function syntheticMessage(over: Record<string, unknown> = {}): BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content: [{ type: "text", text: "hello", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: syntheticUsage(),
    ...over,
  } as unknown as BetaMessage;
}

const baseOpts = {
  model: "claude-opus-4-8",
  system: "system prompt",
  messages: [{ role: "user" as const, content: "hi" }],
  maxTokens: 8000,
};

/* ------------------------------------------------------------------------ *
 * Model resolution
 * ------------------------------------------------------------------------ */

describe("pickPreferredModel", () => {
  it("picks claude-opus-4-8 first (research-recommended default) even when fable-5 is available", () => {
    expect(
      pickPreferredModel(["claude-haiku-4-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8"]),
    ).toBe("claude-opus-4-8");
  });

  it("falls to claude-sonnet-5 when opus 4.8 is absent (cheaper, no refusal-classifier risk)", () => {
    expect(pickPreferredModel(["claude-sonnet-5", "claude-fable-5", "claude-haiku-4-5"])).toBe(
      "claude-sonnet-5",
    );
  });

  it("falls to claude-fable-5 only when opus 4.8 and sonnet 5 are both absent", () => {
    expect(pickPreferredModel(["claude-haiku-4-5", "claude-fable-5", "claude-opus-4-7"])).toBe(
      "claude-fable-5",
    );
  });

  // A dated id the registry does not list is not a model that exists, so it
  // can never be auto-selected — even when its dateless family is preferred.
  it("ignores dated ids the registry does not list", () => {
    expect(() => pickPreferredModel(["claude-opus-4-8-20260601", "claude-haiku-4-5"])).toThrow(
      /supported|registry/i,
    );
    expect(pickPreferredModel(["claude-opus-4-8-20260601", "claude-sonnet-5"])).toBe("claude-sonnet-5");
  });

  it("prefers Opus 5 over Fable 5.1 and picks Fable 5.1 ahead of Fable 5", () => {
    expect(pickPreferredModel(["claude-fable-5-1", "claude-opus-5"])).toBe("claude-opus-5");
    expect(pickPreferredModel(["claude-fable-5", "claude-fable-5-1"])).toBe("claude-fable-5-1");
  });

  it("fails closed when the Models API lists no supported priced model", () => {
    expect(() => pickPreferredModel(["claude-something-else", "claude-older"])).toThrow(
      /supported|priced/i,
    );
  });

  it("throws on an empty model list", () => {
    expect(() => pickPreferredModel([])).toThrow(/no models/);
  });
});

describe("resolveModel", () => {
  it("passes explicit ids through untouched without touching the API", async () => {
    _resetAnthropicForTests(null); // keyless — must still work
    const resolved = await resolveModel("claude-sonnet-5");
    expect(resolved).toEqual({ model: "claude-sonnet-5", resolvedFrom: "explicit" });
  });

  it("rejects an explicit model that has no strict priced alias or dated snapshot", async () => {
    _resetAnthropicForTests(null);
    await expect(resolveModel("claude-mystery-9")).rejects.toThrow(/supported|priced/i);
  });

  it('resolves "auto" against models.list() in preference order', async () => {
    _resetAnthropicForTests(fakeClient(["claude-sonnet-5", "claude-opus-4-8"]));
    const resolved = await resolveModel("auto");
    expect(resolved).toEqual({ model: "claude-opus-4-8", resolvedFrom: "auto" });
  });

  it('prefers claude-opus-4-8 for "auto" even when fable-5 is available (research-recommended default)', async () => {
    _resetAnthropicForTests(fakeClient(["claude-fable-5", "claude-opus-4-8"]));
    const resolved = await resolveModel("auto");
    expect(resolved.model).toBe("claude-opus-4-8");
  });

  it("caches the auto resolution (models.list called once)", async () => {
    const counter = { calls: 0 };
    _resetAnthropicForTests(fakeClient(["claude-opus-4-8"], counter));
    await resolveModel("auto");
    await resolveModel("auto");
    expect(counter.calls).toBe(1);
  });

  it('resolves "auto" deterministically without a key (dry-run)', async () => {
    _resetAnthropicForTests(null);
    const resolved = await resolveModel("auto");
    expect(resolved).toEqual({ model: PREFERENCE_ORDER[0], resolvedFrom: "auto" });
  });
});

/* ------------------------------------------------------------------------ *
 * Cost accounting
 * ------------------------------------------------------------------------ */

describe("computeCostUsd", () => {
  it("prices plain input/output tokens (opus-4-8: $5/$25 per MTok)", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(computeCostUsd(usage, "claude-opus-4-8")).toBeCloseTo(30, 10);
  });

  it("bills a cache write at the registry 5-minute cache-write price (1.25x input)", () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 0,
    };
    const expected = PRICING["claude-opus-4-8"]!.cacheWrite5mPerMTok;
    expect(expected).toBeCloseTo(6.25, 10);
    expect(computeCostUsd(usage, "claude-opus-4-8")).toBeCloseTo(expected, 10);
  });

  // Cache reads are priced per model, not by one flat ratio: every model
  // reads at 0.1x input except Fable 5.1, which reads at $0.25/MTok (0.025x).
  it("bills a cache read at the registry per-model cache-read price", () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    };
    expect(PRICING["claude-opus-4-8"]!.cacheReadPerMTok).toBeCloseTo(0.5, 10);
    expect(computeCostUsd(usage, "claude-opus-4-8")).toBeCloseTo(0.5, 10);
    expect(PRICING["claude-fable-5-1"]!.cacheReadPerMTok).toBeCloseTo(0.25, 10);
    expect(computeCostUsd(usage, "claude-fable-5-1")).toBeCloseTo(0.25, 10);
    expect(computeCostUsd(usage, "claude-fable-5")).toBeCloseTo(1, 10);
  });

  it("bills web searches at $10 per 1,000", () => {
    const usage = { input_tokens: 0, output_tokens: 0 };
    expect(computeCostUsd(usage, "claude-opus-4-8", 100)).toBeCloseTo(1.0, 10);
    expect(WEB_SEARCH_USD_PER_SEARCH).toBeCloseTo(0.01, 10);
  });

  it("treats null cache fields as zero", () => {
    const usage = {
      input_tokens: 500_000,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    };
    expect(computeCostUsd(usage, "claude-haiku-4-5")).toBeCloseTo(0.5, 10);
  });

  it("reproduces the cost-model bull-pass mid-case (~$0.90 on opus-4-8)", () => {
    // 75K cache write + 3x85K cache reads + 15K fresh in + 6K out + 7 searches
    const usage = {
      input_tokens: 15_000,
      output_tokens: 6_000,
      cache_creation_input_tokens: 75_000,
      cache_read_input_tokens: 255_000,
    };
    expect(computeCostUsd(usage, "claude-opus-4-8", 7)).toBeCloseTo(0.89125, 5);
  });

  it("prices fable-5 and fable-5-1 at $10/$50 and sonnet-5 at $2/$10", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(computeCostUsd(usage, "claude-fable-5")).toBeCloseTo(60, 10);
    expect(computeCostUsd(usage, "claude-fable-5-1")).toBeCloseTo(60, 10);
    expect(computeCostUsd(usage, "claude-sonnet-5", 0, new Date("2026-07-09T12:00:00.000Z"))).toBeCloseTo(12, 10);
    expect(computeCostUsd(usage, "claude-haiku-4-5")).toBeCloseTo(6, 10);
  });

  // Anthropic cancelled the 2026-09-01 increase to $3/$15 and made $2/$10 the
  // standard price. Sonnet 5 cost must NOT change across that former boundary.
  it("keeps sonnet-5 at $2/$10 across the cancelled 2026-09-01 price increase", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(computeCostUsd(usage, "claude-sonnet-5", 0, new Date("2026-08-31T23:59:59.999Z"))).toBeCloseTo(12, 10);
    expect(computeCostUsd(usage, "claude-sonnet-5", 0, new Date("2026-09-01T00:00:00.000Z"))).toBeCloseTo(12, 10);
    expect(computeCostUsd(usage, "claude-sonnet-5", 0, new Date("2027-06-01T00:00:00.000Z"))).toBeCloseTo(12, 10);
  });

  // Dated ids are accepted only when the registry LISTS them. Haiku 4.5 has
  // one; from the 4.6 generation on the dateless id is the pinned snapshot and
  // dated variants do not exist, so pricing them would price a model that
  // cannot be called.
  it("prices a listed dated snapshot and refuses an unlisted one", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    expect(computeCostUsd(usage, "claude-haiku-4-5-20251001")).toBeCloseTo(1, 10);
    expect(findPricing("claude-haiku-4-5-20251001")).toEqual(PRICING["claude-haiku-4-5"]);
    expect(findPricing("claude-opus-4-8-20260601")).toBeUndefined();
    expect(() => computeCostUsd(usage, "claude-opus-4-8-20260601")).toThrow(/no pricing entry/);
  });

  it("throws for a model with no pricing entry", () => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    expect(() => computeCostUsd(usage, "claude-mystery-9")).toThrow(/no pricing entry/);
  });
});

/* ------------------------------------------------------------------------ *
 * Request construction
 * ------------------------------------------------------------------------ */

describe("buildPassParams", () => {
  it("fails closed for unpriced models before constructing a provider request", () => {
    expect(() => buildPassParams({ ...baseOpts, model: "claude-opus-4-8-beta" })).toThrow(
      /unsupported|priced/i,
    );
    expect(() => buildPassParams({ ...baseOpts, model: "claude-sonnet-4-5" })).toThrow(
      /unsupported|priced/i,
    );
  });

  // The output ceiling is now the model registry max output rather than a
  // per-pass constant: at effort high and above buildPassParams raises
  // max_tokens to that ceiling (DECISIONS D-05), and the pass reservation
  // bounds the same ceiling, so validating below it would reject requests the
  // reservation already covers.
  it("enforces the registry output ceiling and positive integer max_tokens", () => {
    expect(() => buildPassParams({ ...baseOpts, field: "llm.bull", maxTokens: 128_000 })).not.toThrow();
    expect(() => buildPassParams({ ...baseOpts, field: "llm.bear", maxTokens: 128_001 })).toThrow(
      /max_tokens.*128,?000/i,
    );
    expect(() => buildPassParams({ ...baseOpts, model: "claude-haiku-4-5", field: "llm.bull", maxTokens: 64_000 })).not.toThrow();
    expect(() => buildPassParams({ ...baseOpts, model: "claude-haiku-4-5", field: "llm.bull", maxTokens: 64_001 })).toThrow(
      /max_tokens.*64,?000/i,
    );
    for (const maxTokens of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildPassParams({ ...baseOpts, maxTokens })).toThrow(/max_tokens/i);
    }
  });

  it("rejects requests whose conservative serialized-input bound exceeds the model context cap", () => {
    const atCap = {
      ...baseOpts,
      model: "claude-haiku-4-5",
      system: "x".repeat(199_800),
      field: "llm.bull",
      maxTokens: 64_000,
    };
    expect(requestInputTokenUpperBound(atCap)).toBeLessThanOrEqual(200_000);
    expect(() => buildPassParams(atCap)).not.toThrow();

    const overCap = { ...atCap, system: "x".repeat(200_001) };
    expect(requestInputTokenUpperBound(overCap)).toBeGreaterThan(200_000);
    expect(() => buildPassParams(overCap)).toThrow(/input.*200,?000|context/i);
  });

  it("rejects raw web-search tools that bypass the bounded factory", () => {
    const overCapTool = {
      type: WEB_SEARCH_TOOL_TYPE,
      name: "web_search",
      max_uses: MAX_PROVIDER_WEB_SEARCHES + 1,
      response_inclusion: "full",
    };
    expect(() => buildPassParams({ ...baseOpts, tools: [overCapTool] as never })).toThrow(
      /web.search.*8/i,
    );
    expect(() => buildPassParams({
      ...baseOpts,
      field: "llm.judge",
      tools: [webSearchTool(1, "claude-opus-4-8")] as never,
    })).toThrow(/judge.*web.search|web.search.*judge/i);
  });

  it("adds the server-side fallback beta + fallbacks for claude-fable-5", () => {
    const { params, usesFallbackBeta } = buildPassParams({ ...baseOpts, model: "claude-fable-5" });
    expect(usesFallbackBeta).toBe(true);
    // Both come from the registry entry, not from a literal beside it.
    const fallback = registryEntryFor("claude-fable-5").serverSideFallback!;
    expect(params.betas).toEqual([fallback.beta]);
    expect(params.fallbacks).toEqual([{ model: fallback.model }]);
    // fable-5: thinking is always-on — the param must NOT be sent (400).
    expect(params).not.toHaveProperty("thinking");
  });

  it("sends adaptive thinking for opus-4-8 and no betas/fallbacks", () => {
    const { params, usesFallbackBeta } = buildPassParams(baseOpts);
    expect(usesFallbackBeta).toBe(false);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params).not.toHaveProperty("betas");
    expect(params).not.toHaveProperty("fallbacks");
  });

  it("omits the thinking param for sonnet-5 (adaptive by default)", () => {
    const { params } = buildPassParams({ ...baseOpts, model: "claude-sonnet-5" });
    expect(params).not.toHaveProperty("thinking");
    expect(thinkingConfigFor("claude-sonnet-5")).toBeUndefined();
    expect(thinkingConfigFor("claude-fable-5")).toBeUndefined();
    expect(thinkingConfigFor("claude-opus-4-8")).toEqual({ type: "adaptive" });
    expect(thinkingConfigFor("claude-opus-5")).toEqual({ type: "adaptive" });
    expect(thinkingConfigFor("claude-fable-5-1")).toBeUndefined();
    // An id outside the registry has no thinking rule to apply.
    expect(() => thinkingConfigFor("claude-opus-5-20260601")).toThrow(/unsupported model/);
  });

  it("prices, sizes and equips opus-5 like the rest of the Opus tier", () => {
    // Opus 5 is the "auto" first choice; regressions here silently reroute or
    // mis-bill every default run.
    expect(PREFERENCE_ORDER[0]).toBe("claude-opus-5");
    expect(pricedModelAlias("claude-opus-5")).toBe("claude-opus-5");
    expect(pricedModelAlias("claude-opus-5-20260601")).toBeNull();
    expect(pricedModelAlias("claude-opus-5-latest")).toBeNull();
    expect(findPricing("claude-opus-5")).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25, cacheWrite5mPerMTok: 6.25, cacheReadPerMTok: 0.5 });
    expect(modelContextTokenLimit("claude-opus-5")).toBe(1_000_000);
    // Dynamic-filtering web search, not haiku's basic variant.
    expect(webSearchTool(4, "claude-opus-5")).toMatchObject({
      type: "web_search_20260318",
      max_uses: 4,
    });
    // Opus 5 accepts output_config.effort; it must not be stripped.
    const { params } = buildPassParams({
      ...baseOpts,
      model: "claude-opus-5",
      effort: "high",
    });
    expect(params.output_config).toMatchObject({ effort: "high" });
    expect(params.model).toBe("claude-opus-5");
    // Only fable-5 carries the server-side fallback beta.
    expect(params).not.toHaveProperty("fallbacks");
  });

  it("wires outputSchema into output_config.format (json_schema)", () => {
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false,
    };
    const { params } = buildPassParams({ ...baseOpts, outputSchema: schema, effort: "high" });
    expect(params.output_config).toEqual({
      effort: "high",
      format: { type: "json_schema", schema },
    });
  });

  it("omits output_config entirely when neither effort nor schema is set", () => {
    const { params } = buildPassParams(baseOpts);
    expect(params).not.toHaveProperty("output_config");
  });

  it("drops effort for models that reject it (haiku-4-5 400s on effort)", () => {
    for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]) {
      const { params } = buildPassParams({ ...baseOpts, model, effort: "high" });
      expect(params).not.toHaveProperty("output_config");
      expect(supportsEffort(model)).toBe(false);
    }
    // outputSchema still goes through even when effort is dropped
    const schema = { type: "object", properties: {}, additionalProperties: false };
    const { params } = buildPassParams({
      ...baseOpts,
      model: "claude-haiku-4-5",
      effort: "high",
      outputSchema: schema,
    });
    expect(params.output_config).toEqual({ format: { type: "json_schema", schema } });
    for (const model of ["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-5"]) {
      expect(supportsEffort(model)).toBe(true);
    }
  });

  it("never sends sampling parameters", () => {
    for (const model of ["claude-fable-5-1", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-5"]) {
      const { params } = buildPassParams({ ...baseOpts, model });
      expect(params).not.toHaveProperty("temperature");
      expect(params).not.toHaveProperty("top_p");
      expect(params).not.toHaveProperty("top_k");
    }
  });

  it("passes tools through unchanged", () => {
    const tools = [webSearchTool(MAX_PROVIDER_WEB_SEARCHES, "claude-opus-4-8")];
    const { params } = buildPassParams({ ...baseOpts, tools });
    expect(params.tools).toBe(tools);
  });
});

describe("webSearchTool", () => {
  it("returns the switchable tool type with name and max_uses", () => {
    expect(webSearchTool(MAX_PROVIDER_WEB_SEARCHES, "claude-opus-4-8")).toEqual({
      type: WEB_SEARCH_TOOL_TYPE,
      name: "web_search",
      max_uses: MAX_PROVIDER_WEB_SEARCHES,
      response_inclusion: "full",
    });
    expect(WEB_SEARCH_TOOL_TYPE).toBe("web_search_20260318");
  });

  it("downgrades to the basic variant for haiku (20260318 400s there)", () => {
    expect(webSearchTool(MAX_PROVIDER_WEB_SEARCHES, "claude-haiku-4-5")).toEqual({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: MAX_PROVIDER_WEB_SEARCHES,
    });
    expect(webSearchTool(MAX_PROVIDER_WEB_SEARCHES, "claude-haiku-4-5-20251001").type).toBe("web_search_20250305");
    // non-haiku models keep the dynamic-filtering variant
    for (const model of ["claude-opus-4-8", "claude-sonnet-5", "claude-fable-5"]) {
      expect(webSearchTool(MAX_PROVIDER_WEB_SEARCHES, model).type).toBe(WEB_SEARCH_TOOL_TYPE);
    }
  });

  it("enforces a positive integer search cap and a priced target model", () => {
    expect(() => webSearchTool(MAX_PROVIDER_WEB_SEARCHES + 1, "claude-opus-4-8")).toThrow(/max_uses.*8/i);
    for (const maxUses of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => webSearchTool(maxUses, "claude-opus-4-8")).toThrow(/max_uses/i);
    }
    expect(() => webSearchTool(1, "claude-mystery-9")).toThrow(/unsupported|priced/i);
  });

  it("keeps the literal retry exposure multiplier executable", () => {
    expect(PASS_BILLING_EXPOSURE_MULTIPLIER).toBe(
      (CLIENT_MAX_RETRIES + 1) * PASS_TRANSPORT_MAX_ATTEMPTS * (MAX_PAUSE_RESUMPTIONS + 1),
    );
    // 36, not the former 108: the SDK's own retry budget is now zero, because
    // an SDK retry is a billable request the scheduler never saw. Every retry
    // is a pass-level attempt that reserves for itself (DECISIONS D-10).
    expect(CLIENT_MAX_RETRIES).toBe(0);
    expect(PASS_BILLING_EXPOSURE_MULTIPLIER).toBe(36);
    expect(PASS_MAX_REQUESTS).toBe(36);
  });
});

describe("collectFetchedUrls", () => {
  it("collects only successful web-search results and canonicalizes them", () => {
    const message = syntheticMessage({
      content: [
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [
            {
              type: "web_search_result",
              title: "A",
              url: "HTTPS://Example.COM/article?q=1#section",
              encrypted_content: "ciphertext",
              page_age: null,
            },
            {
              type: "web_search_result",
              title: "duplicate",
              url: "https://example.com/article?q=1",
              encrypted_content: "ciphertext",
              page_age: null,
            },
            {
              type: "web_search_result",
              title: "B",
              url: "https://another.example/report",
              encrypted_content: "ciphertext",
              page_age: null,
            },
          ],
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_2",
          content: { type: "web_search_tool_result_error", error_code: "unavailable" },
        },
        {
          type: "text",
          text: "A model-authored URL is not fetched evidence: https://invented.example/",
          citations: null,
        },
      ],
    });

    expect(collectFetchedUrls(message)).toEqual([
      "https://another.example/report",
      "https://example.com/article?q=1",
    ]);
  });

  it("rejects malformed and non-HTTP result URLs", () => {
    const message = syntheticMessage({
      content: [
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [
            { type: "web_search_result", title: "bad", url: "not a url" },
            { type: "web_search_result", title: "bad", url: "ftp://example.com/a" },
          ],
        },
      ],
    });
    expect(collectFetchedUrls(message)).toEqual([]);
  });

  it("stores fetched URLs on successful pass outcomes", () => {
    const message = syntheticMessage({
      content: [
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [{ type: "web_search_result", title: "A", url: "https://example.com/a" }],
        },
        { type: "text", text: "{}", citations: null },
      ],
    });
    const result = interpretPassMessage(message, baseOpts);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.fetchedUrls).toEqual(["https://example.com/a"]);
  });
});

/* ------------------------------------------------------------------------ *
 * Fallback detection
 * ------------------------------------------------------------------------ */

describe("detectFallbackUsed", () => {
  it("returns false for a plain response", () => {
    expect(
      detectFallbackUsed({
        content: [{ type: "text" }],
        usage: { iterations: null },
      }),
    ).toBe(false);
  });

  it("detects a fallback content block (switch point)", () => {
    expect(
      detectFallbackUsed({
        content: [{ type: "fallback" }, { type: "text" }],
        usage: { iterations: null },
      }),
    ).toBe(true);
  });

  it("detects a fallback_message iteration entry (sticky-served turns)", () => {
    expect(
      detectFallbackUsed({
        content: [{ type: "text" }],
        usage: { iterations: [{ type: "message" }, { type: "fallback_message" }] },
      }),
    ).toBe(true);
  });

  it("tolerates missing content/usage/iterations", () => {
    expect(detectFallbackUsed({})).toBe(false);
    expect(detectFallbackUsed({ content: undefined, usage: undefined })).toBe(false);
    expect(detectFallbackUsed({ usage: { iterations: undefined } })).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * Response interpretation (synthetic response shapes)
 * ------------------------------------------------------------------------ */

describe("interpretPassMessage", () => {
  it("wraps a successful pass in Sourced with cost and served model", () => {
    const message = syntheticMessage({
      model: "claude-opus-4-8",
      usage: syntheticUsage({
        input_tokens: 15_000,
        output_tokens: 6_000,
        cache_creation_input_tokens: 75_000,
        cache_read_input_tokens: 255_000,
        server_tool_use: { web_search_requests: 7, web_fetch_requests: 0 },
      }),
    });
    const result = interpretPassMessage(message, baseOpts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe("anthropic");
    expect(result.value.endpoint).toBe("/v1/messages");
    expect(result.value.data.model).toBe("claude-opus-4-8");
    expect(result.value.data.fallbackUsed).toBe(false);
    expect(result.value.data.costUsd).toBeCloseTo(0.89125, 5);
  });

  it("flags fallbackUsed on a fallback-served success and prices the serving model", () => {
    const message = syntheticMessage({
      model: "claude-opus-4-8", // fallback model served the fable request
      content: [
        { type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
        { type: "text", text: "case", citations: null },
      ],
      usage: syntheticUsage({
        input_tokens: 1_000_000,
        iterations: [{ type: "message" }, { type: "fallback_message" }] as never,
      }),
    });
    const result = interpretPassMessage(message, { ...baseOpts, model: "claude-fable-5" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fallbackUsed).toBe(true);
    // Without per-hop usage the only price available is the SERVING model's
    // rate ($5/MTok), not fable's $10.
    expect(result.value.data.costUsd).toBeCloseTo(5, 10);
  });

  /**
   * A server-side fallback bills the declining hop at the declining model's
   * rate (Fable $10/$50) and the rescue at the fallback model's (Opus 4.8
   * $5/$25). `usage.iterations` carries each hop's model and tokens, so a
   * response served by two models is priced hop by hop — only when the hops
   * account for exactly the message's totals.
   */
  it("prices a two-model response hop by hop from usage.iterations", () => {
    const message = syntheticMessage({
      model: "claude-opus-4-8",
      content: [
        { type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
        { type: "text", text: "case", citations: null },
      ],
      usage: syntheticUsage({
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        iterations: [
          {
            type: "message",
            model: "claude-fable-5",
            input_tokens: 600_000,
            output_tokens: 20_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation: null,
          },
          {
            type: "fallback_message",
            model: "claude-opus-4-8",
            input_tokens: 400_000,
            output_tokens: 80_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation: null,
          },
        ] as never,
      }),
    });
    const result = interpretPassMessage(message, { ...baseOpts, model: "claude-fable-5" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Fable hop: 0.6M × $10 + 0.02M × $50 = $7; Opus hop: 0.4M × $5 + 0.08M × $25 = $4.
    expect(result.value.data.costUsd).toBeCloseTo(11, 10);

    // Hops that do not add up to the message total fall back to one rate.
    const inconsistent = syntheticMessage({
      model: "claude-opus-4-8",
      usage: syntheticUsage({
        input_tokens: 1_000_000,
        output_tokens: 0,
        iterations: [
          { type: "message", model: "claude-fable-5", input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        ] as never,
      }),
    });
    const fallback = interpretPassMessage(inconsistent, { ...baseOpts, model: "claude-fable-5" });
    expect(fallback.ok).toBe(true);
    if (!fallback.ok) return;
    expect(fallback.value.data.costUsd).toBeCloseTo(5, 10);
  });

  it('returns a typed "refusal" error with category and files a gap', () => {
    const message = syntheticMessage({
      stop_reason: "refusal",
      stop_details: { category: "cyber", explanation: "declined" },
      content: [],
    });
    const result = interpretPassMessage(message, { ...baseOpts, field: "llm.bull" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("refusal");
    expect(result.error.refusalCategory).toBe("cyber");
    expect(result.gap.field).toBe("llm.bull");
    expect(result.gap.severity).toBe("critical");
    expect(result.gap.reason).toContain("refusal");
  });

  it('returns a typed "max_tokens" error suggesting a higher limit', () => {
    const message = syntheticMessage({
      stop_reason: "max_tokens",
      usage: syntheticUsage({ input_tokens: 1000, output_tokens: 8000 }),
    });
    const result = interpretPassMessage(message, baseOpts);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("max_tokens");
    expect(result.error.maxTokens).toBe(baseOpts.maxTokens);
    expect(result.error.message).toMatch(/higher effort/i);
    // failed attempts still carry billed usage/cost for the cost log
    expect(result.error.costUsd).toBeGreaterThan(0);
  });

  /**
   * At effort `high` and above the request is sent at the model's registry
   * ceiling, not the pass constant. The gap used to quote the constant and
   * tell the reader to "retry with a higher limit" when none existed.
   */
  it('reports the max_tokens actually SENT at effort high, and says the ceiling was reached', () => {
    const message = syntheticMessage({
      stop_reason: "max_tokens",
      usage: syntheticUsage({ input_tokens: 1000, output_tokens: 128_000 }),
    });
    const opts = { ...baseOpts, effort: "high" as const };
    const result = interpretPassMessage(message, opts);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(effectiveMaxTokens(opts)).toBe(registryEntryFor(baseOpts.model).maxOutputTokens);
    expect(result.error.maxTokens).toBe(effectiveMaxTokens(opts));
    expect(result.gap.reason).toContain(`max_tokens=${effectiveMaxTokens(opts)}`);
    expect(result.gap.reason).toMatch(/registry ceiling/);
    expect(result.error.message).not.toMatch(/higher effort/i);
  });

  it('returns a typed "context_window" error when Sonnet 5 stops for the model context window', () => {
    const message = syntheticMessage({
      stop_reason: "model_context_window_exceeded",
      usage: syntheticUsage({ input_tokens: 900_000, output_tokens: 64_000 }),
    });
    const result = interpretPassMessage(message, { ...baseOpts, model: "claude-sonnet-5" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("context_window");
    expect(result.error.message).toMatch(/context window/i);
    expect(result.gap.reason).toContain("model_context_window_exceeded");
    expect(result.error.costUsd).toBeGreaterThan(0);
  });

  it('returns a typed "paused" error for a message still stop_reason "pause_turn" (resumption budget exhausted)', () => {
    const message = syntheticMessage({ stop_reason: "pause_turn" });
    const result = interpretPassMessage(message, baseOpts);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("paused");
    expect(result.gap.reason).toContain("pause_turn");
    expect(result.gap.reason).toContain(String(MAX_PAUSE_RESUMPTIONS));
  });
});

/* ------------------------------------------------------------------------ *
 * pause_turn resumption (long search turns can
 * pause mid-turn — resend the assistant's content UNCHANGED to resume).
 * ------------------------------------------------------------------------ */

/**
 * A client whose initial request STREAMS (every paid pass streams now) and
 * whose pause resumptions stream too: `streamFinal` is what the first
 * stream's finalMessage() resolves with; `resumeResponses` answers each
 * resumption stream in order. A non-streaming create() is a contract
 * violation and throws.
 */
function fakeStreamingResumeClient(
  streamFinal: BetaMessage,
  resumeResponses: BetaMessage[],
): { client: Anthropic; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          calls.push(params);
          const msg = i === 0 ? streamFinal : resumeResponses[Math.min(i - 1, resumeResponses.length - 1)];
          i++;
          return makeFakeStream({ events: [{ type: "message_start", message: msg }], final: msg });
        },
        create: async () => {
          throw new Error("unexpected non-streaming create() call");
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

/** Every request streams; each stream() call resolves with the next response. */
function fakeCreateClient(responses: BetaMessage[]): { client: Anthropic; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          calls.push(params);
          const msg = responses[Math.min(i, responses.length - 1)];
          i++;
          return makeFakeStream({ events: [{ type: "message_start", message: msg }], final: msg });
        },
        create: async () => {
          throw new Error("unexpected non-streaming create() call");
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("resumeIfPaused", () => {
  it("returns the message unchanged and makes no calls when it never paused", async () => {
    const { client, calls } = fakeCreateClient([]);
    const message = syntheticMessage({ stop_reason: "end_turn" });
    const result = await resumeIfPaused(client, baseOpts as never, message);
    expect(result).toBe(message);
    expect(calls.length).toBe(0);
  });

  it("resumes once and returns the final message when the first attempt pauses", async () => {
    const finalMsg = syntheticMessage({ stop_reason: "end_turn", content: [{ type: "text", text: "done", citations: null }] });
    const { client, calls } = fakeCreateClient([finalMsg]);
    const pausedMsg = syntheticMessage({
      stop_reason: "pause_turn",
      content: [{ type: "server_tool_use", id: "x" }],
    });
    const result = await resumeIfPaused(client, { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] } as never, pausedMsg);
    expect(result).toBe(finalMsg);
    expect(calls.length).toBe(1);
    // The resumed request appends the PAUSED assistant content unchanged —
    // not a new "continue" user message.
    const sentMessages = calls[0].messages as { role: string; content: unknown }[];
    expect(sentMessages[sentMessages.length - 1]).toEqual({
      role: "assistant",
      content: pausedMsg.content,
    });
  });

  it("stops after MAX_PAUSE_RESUMPTIONS and returns the still-paused message rather than looping forever", async () => {
    const pausedMsg = syntheticMessage({ stop_reason: "pause_turn" });
    const { client, calls } = fakeCreateClient([pausedMsg]); // always pauses
    const result = await resumeIfPaused(client, { model: "claude-opus-4-8", messages: [] } as never, pausedMsg);
    expect(result.stop_reason).toBe("pause_turn");
    expect(calls.length).toBe(MAX_PAUSE_RESUMPTIONS);
  });
});

describe("runPass resumes a paused turn end-to-end", () => {
  it("stitches a pause_turn + resumption into a single successful RunPassResult", async () => {
    const finalMsg = syntheticMessage({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"ok":true}', citations: null }],
    });
    const pausedMsg = syntheticMessage({ stop_reason: "pause_turn" });
    // The initial request streams and pauses; the resumption STREAMS too
    // (DECISIONS D-09) and returns the final message.
    const { client, calls } = fakeStreamingResumeClient(pausedMsg, [finalMsg]);
    _resetAnthropicForTests(client);
    const result = await runPass(baseOpts);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  /**
   * The resumed turn is itself a full generation, up to the registry output
   * ceiling at high effort. As a non-streaming create() with the 600 s client
   * timeout it was cut off client-side past ten minutes while the server kept
   * generating and billing, then presumed at the request maximum and retried
   * from scratch. Streaming puts it under the same idle guard as the first
   * request, and a resumption that goes silent is abandoned with a presumed
   * remainder rather than retried.
   */
  it("abandons a resumption that goes silent under the idle guard instead of retrying it", async () => {
    process.env.THESIS_STREAM_IDLE_SECONDS = "1";
    resetConfigCache();
    try {
      const pausedMsg = syntheticMessage({
        stop_reason: "pause_turn",
        usage: syntheticUsage({ input_tokens: 1_000, output_tokens: 100 }),
      });
      const aborts: number[] = [];
      let streamCalls = 0;
      const client = {
        beta: {
          messages: {
            stream: () => {
              streamCalls += 1;
              if (streamCalls === 1) {
                return makeFakeStream({ events: [{ type: "message_start", message: pausedMsg }], final: pausedMsg });
              }
              // The resumption accepts the request and goes quiet.
              const stalled = makeFakeStream({
                events: [messageStartEvent({ input_tokens: 2_000, output_tokens: 1 })],
              }) as Record<string, unknown>;
              stalled.abort = (): void => {
                aborts.push(1);
              };
              return stalled;
            },
            create: async () => {
              throw new Error("unexpected non-streaming create() call");
            },
          },
        },
      } as unknown as Anthropic;
      _resetAnthropicForTests(client);

      const result = await runPass({ ...baseOpts, effort: "low" });

      expect(streamCalls).toBe(2);
      expect(aborts).toHaveLength(1);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("transport");
      expect(result.error.message).toMatch(/stream idle timeout/);
      expect(result.error.message).toMatch(/presumed .* remaining output tokens/);
      // The paused first message (1K in, 100 out) and the resumption's own
      // message_start (2K in) are both in the usage; the remainder is presumed.
      expect(result.error.usage).toMatchObject({ input_tokens: 3_000 });
    } finally {
      delete process.env.THESIS_STREAM_IDLE_SECONDS;
      resetConfigCache();
    }
  }, 15_000);

  it("accounts for billed usage and web-search cost from both the paused attempt and the resumption", async () => {
    const pausedUsage = syntheticUsage({
      input_tokens: 1_000,
      output_tokens: 100,
      server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
    });
    const finalUsage = syntheticUsage({
      input_tokens: 2_000,
      output_tokens: 300,
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
    });
    const pausedMsg = syntheticMessage({
      stop_reason: "pause_turn",
      usage: pausedUsage,
    });
    const finalMsg = syntheticMessage({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"ok":true}', citations: null }],
      usage: finalUsage,
    });
    const { client } = fakeStreamingResumeClient(pausedMsg, [finalMsg]);
    _resetAnthropicForTests(client);

    const result = await runPass(baseOpts);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.usage.input_tokens).toBe(3_000);
    expect(result.value.data.usage.output_tokens).toBe(400);
    expect(result.value.data.usage.server_tool_use?.web_search_requests).toBe(3);
    expect(result.value.data.costUsd).toBeCloseTo(
      computeCostUsd(pausedUsage, "claude-opus-4-8", 2) +
        computeCostUsd(finalUsage, "claude-opus-4-8", 1),
      10,
    );
  });
});

/* ------------------------------------------------------------------------ *
 * Keyless dry-run behavior
 * ------------------------------------------------------------------------ */

describe("runPass without a key", () => {
  it('returns the "no Anthropic key" gap instead of throwing', async () => {
    _resetAnthropicForTests(null);
    const result = await runPass({ ...baseOpts, field: "llm.judge" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.gap.reason).toBe("no Anthropic key");
    expect(result.gap.field).toBe("llm.judge");
    expect(result.error.kind).toBe("no_key");
  });

  it("gaps on the streaming path too, with firstToken resolving immediately", async () => {
    _resetAnthropicForTests(null);
    const handle = runPassStreaming({ ...baseOpts, maxTokens: 16_001 });
    await expect(handle.firstToken).resolves.toBe("end");
    const result = await handle.result;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.gap.reason).toBe("no Anthropic key");
  });
});

/* ------------------------------------------------------------------------ *
 * Streaming transport retry + billed-usage capture (2026-07-10 incident:
 * a mid-stream `overloaded_error` SSE event is NOT retried by the SDK —
 * maxRetries only covers the initial HTTP response — so one capacity blip
 * killed both analyst passes after ~8 minutes of billed generation each,
 * and the rejection carried no usage, so cost_log recorded $0.)
 * ------------------------------------------------------------------------ */

interface StreamScript {
  /** streamEvents to emit, in order, before the terminal outcome. */
  events?: unknown[];
  /** Terminal success: finalMessage() resolves with this. */
  final?: BetaMessage;
  /** Terminal failure: emit "error" and reject finalMessage() with this. */
  failWith?: unknown;
}

function makeFakeStream(script: StreamScript) {
  const listeners = new Map<string, Array<{ fn: (...args: unknown[]) => void; once: boolean }>>();
  const add = (name: string, fn: (...args: unknown[]) => void, once: boolean) => {
    const arr = listeners.get(name) ?? [];
    arr.push({ fn, once });
    listeners.set(name, arr);
  };
  const emit = (name: string, ...args: unknown[]) => {
    const arr = listeners.get(name) ?? [];
    listeners.set(
      name,
      arr.filter((l) => !l.once),
    );
    for (const l of arr) l.fn(...args);
  };
  let settleFinal!: { resolve: (m: BetaMessage) => void; reject: (e: unknown) => void };
  const finalPromise = new Promise<BetaMessage>((resolve, reject) => {
    settleFinal = { resolve, reject };
  });
  finalPromise.catch(() => {}); // consumed via finalMessage(); avoid unhandled rejection noise
  queueMicrotask(() => {
    for (const event of script.events ?? []) emit("streamEvent", event);
    if (script.failWith !== undefined) {
      emit("error", script.failWith);
      settleFinal.reject(script.failWith);
    } else if (script.final !== undefined) {
      emit("end");
      settleFinal.resolve(script.final);
    }
  });
  return {
    on: (name: string, fn: (...args: unknown[]) => void) => add(name, fn, false),
    once: (name: string, fn: (...args: unknown[]) => void) => add(name, fn, true),
    finalMessage: () => finalPromise,
  };
}

/** Scripts are consumed one per stream() call; the last script repeats. */
function fakeStreamingClient(scripts: StreamScript[]): {
  client: Anthropic;
  streamCalls: Record<string, unknown>[];
} {
  const streamCalls: Record<string, unknown>[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          streamCalls.push(params);
          const script = scripts[Math.min(i, scripts.length - 1)];
          i++;
          return makeFakeStream(script);
        },
        create: async () => {
          throw new Error("unexpected non-streaming create() call");
        },
      },
    },
  } as unknown as Anthropic;
  return { client, streamCalls };
}

/** Records retry sleeps instead of waiting; returns the recorded delays. */
function instantSleep(): number[] {
  const delays: number[] = [];
  _setTransportRetrySleepForTests(async (ms: number) => {
    delays.push(ms);
  });
  return delays;
}

/** The exact error shape the SDK throws for a mid-stream SSE `error` event
 * (core/streaming.js): APIError with NO status, body as `error`, type set. */
function midStreamOverloadedError(): APIError {
  const body = {
    type: "error",
    error: { details: null, type: "overloaded_error", message: "Overloaded" },
    request_id: "req_test_overload",
  };
  return new APIError(undefined, body as never, undefined, undefined, "overloaded_error");
}

function messageStartEvent(over: Partial<BetaUsage> = {}, model = "claude-opus-4-8") {
  return {
    type: "message_start",
    message: syntheticMessage({ model, usage: syntheticUsage(over) }),
  };
}

function messageDeltaEvent(usage: Record<string, unknown>) {
  return { type: "message_delta", delta: {}, usage };
}

const streamingOpts = {
  ...baseOpts,
  maxTokens: 16_001,
  field: "llm.bull",
};

/** Usage snapshot a failed attempt should be billed at (start + last delta). */
const attemptStartUsage = { input_tokens: 5_000, cache_creation_input_tokens: 40_000, output_tokens: 1 };
const attemptDeltaUsage = {
  output_tokens: 8_000,
  server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
};
const attemptBilledUsage = syntheticUsage({
  input_tokens: 5_000,
  cache_creation_input_tokens: 40_000,
  output_tokens: 8_000,
  server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
});
const failingAttemptScript: StreamScript = {
  events: [messageStartEvent(attemptStartUsage), messageDeltaEvent(attemptDeltaUsage)],
  failWith: midStreamOverloadedError(),
};

describe("isRetryableTransportError", () => {
  it("retries mid-stream SSE errors for transient types (no HTTP status)", () => {
    expect(isRetryableTransportError(midStreamOverloadedError())).toBe(true);
    const apiErr = new APIError(
      undefined,
      { type: "error", error: { type: "api_error", message: "Internal server error" } } as never,
      undefined,
      undefined,
      "api_error",
    );
    expect(isRetryableTransportError(apiErr)).toBe(true);
  });

  it("retries connection failures and retryable HTTP statuses", () => {
    expect(isRetryableTransportError(new APIConnectionError({ message: "socket hang up" }))).toBe(true);
    expect(
      isRetryableTransportError(new InternalServerError(529, {} as never, "Overloaded", new Headers())),
    ).toBe(true);
    expect(
      isRetryableTransportError(new RateLimitError(429, {} as never, "rate limited", new Headers())),
    ).toBe(true);
  });

  it("does not retry client errors, user aborts, or non-SDK errors", () => {
    expect(
      isRetryableTransportError(new BadRequestError(400, {} as never, "bad request", new Headers())),
    ).toBe(false);
    expect(isRetryableTransportError(new APIUserAbortError())).toBe(false);
    expect(
      isRetryableTransportError(
        new APIError(
          undefined,
          { type: "error", error: { type: "invalid_request_error", message: "nope" } } as never,
          undefined,
          undefined,
          "invalid_request_error",
        ),
      ),
    ).toBe(false);
    expect(isRetryableTransportError(new Error("boom"))).toBe(false);
  });

  /**
   * The SDK produces APIConnectionError only for a fetch that fails BEFORE
   * the headers. A body that dies mid-stream reaches BetaMessageStream's
   * error handler as an ordinary Error and is re-wrapped as a BARE
   * AnthropicError with the network error on `cause` — undici's ~300 s idle
   * body timeout is `TypeError: terminated` → `BodyTimeoutError`. Classified
   * as a programming error, that death rejected the pass promise, retried
   * nothing and dropped the usage the stream had billed.
   */
  it("classifies a stream that died after the headers as a retryable connection failure", () => {
    const bodyTimeout = Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" });
    const terminated = new TypeError("terminated", { cause: bodyTimeout });
    const wrapped = Object.assign(new AnthropicError("terminated"), { cause: terminated });
    expect(connectionFailureCode(wrapped)).toBe("UND_ERR_BODY_TIMEOUT");
    expect(isStreamConnectionFailure(wrapped)).toBe(true);
    expect(isRetryableTransportError(wrapped)).toBe(true);

    const reset = Object.assign(new AnthropicError("read ECONNRESET"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    expect(isRetryableTransportError(reset)).toBe(true);

    // A clean close before message_stop: the SDK's own finalMessage() error.
    const premature = new AnthropicError("stream ended without producing a Message with role=assistant");
    expect(isStreamConnectionFailure(premature)).toBe(true);
    expect(isRetryableTransportError(premature)).toBe(true);

    // The SDK's programming-error messages are NOT connection failures.
    expect(isStreamConnectionFailure(new AnthropicError("Cannot iterate over a consumed stream, use `.tee()` to split the stream."))).toBe(false);
    expect(isStreamConnectionFailure(new AnthropicError("Attempted to iterate over a response with no body"))).toBe(false);
    // An APIError is classified by its own rules, never as a bare stream death.
    expect(isStreamConnectionFailure(midStreamOverloadedError())).toBe(false);
    expect(isStreamConnectionFailure(new APIUserAbortError())).toBe(false);
  });
});

describe("runPassStreaming transport retry", () => {
  afterEach(() => {
    _setTransportRetrySleepForTests();
  });

  it("retries a mid-stream overloaded error with backoff and succeeds on the next attempt", async () => {
    const delays = instantSleep();
    const finalUsage = syntheticUsage({
      input_tokens: 5_000,
      cache_read_input_tokens: 40_000,
      output_tokens: 20_000,
      server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 },
    });
    const finalMsg = syntheticMessage({
      content: [{ type: "text", text: '{"ok":true}', citations: null }],
      usage: finalUsage,
    });
    const { client, streamCalls } = fakeStreamingClient([
      failingAttemptScript,
      { events: [messageStartEvent(attemptStartUsage)], final: finalMsg },
    ]);
    _resetAnthropicForTests(client);

    const handle = runPassStreaming(streamingOpts);
    await expect(handle.firstToken).resolves.toBe("streamEvent");
    const result = await handle.result;

    expect(streamCalls.length).toBe(2);
    // This attempt streamed before it died, so the longer mid-stream ladder
    // applies: Anthropic shed load while already generating.
    expect(delays).toEqual([PASS_MID_STREAM_RETRY_DELAYS_MS[0]]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The failed attempt's streamed tokens WERE billed — they must be folded
    // into the pass's total usage and cost, not silently dropped.
    expect(result.value.data.usage.input_tokens).toBe(10_000);
    expect(result.value.data.usage.output_tokens).toBe(28_000);
    expect(result.value.data.usage.server_tool_use?.web_search_requests).toBe(5);
    expect(result.value.data.costUsd).toBeCloseTo(
      computeCostUsd(attemptBilledUsage, "claude-opus-4-8", 2) +
        computeCostUsd(finalUsage, "claude-opus-4-8", 3),
      10,
    );
  });

  it("retries a stream that died after generation started and folds its billed usage into the result", async () => {
    const delays = instantSleep();
    const finalUsage = syntheticUsage({ input_tokens: 5_000, output_tokens: 20_000 });
    const finalMsg = syntheticMessage({
      content: [{ type: "text", text: '{"ok":true}', citations: null }],
      usage: finalUsage,
    });
    // What the SDK hands finalMessage() when undici's body timeout kills the socket.
    const died = Object.assign(new AnthropicError("terminated"), {
      cause: new TypeError("terminated", {
        cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }),
      }),
    });
    const settled: Array<Record<string, unknown>> = [];
    let released = 0;
    const admission = {
      reserve: async () => ({ id: `p${settled.length + 1}`, maximumUsd: 10 }),
      settle: async (_permit: unknown, settlement: Record<string, unknown>) => {
        settled.push(settlement);
      },
      release: async () => {
        released += 1;
      },
    };
    const { client, streamCalls } = fakeStreamingClient([
      { events: [messageStartEvent(attemptStartUsage), messageDeltaEvent(attemptDeltaUsage)], failWith: died },
      { events: [messageStartEvent(attemptStartUsage)], final: finalMsg },
    ]);
    _resetAnthropicForTests(client);

    const handle = runPassStreaming({ ...streamingOpts, admission: admission as never });
    await expect(handle.firstToken).resolves.toBe("streamEvent");
    const result = await handle.result;

    // Retried on the mid-stream ladder, never rejected, never released.
    expect(streamCalls.length).toBe(2);
    expect(delays).toEqual([PASS_MID_STREAM_RETRY_DELAYS_MS[0]]);
    expect(released).toBe(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.usage.input_tokens).toBe(10_000);
    expect(result.value.data.usage.output_tokens).toBe(28_000);
    // The dead attempt settled what it had reported (it reached generation).
    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({ usage: { input_tokens: 5_000, output_tokens: 8_000 } });
  });

  it("presumes a request whose body died before message_start rather than releasing it", async () => {
    instantSleep();
    const died = Object.assign(new AnthropicError("terminated"), {
      cause: new TypeError("terminated", {
        cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }),
      }),
    });
    const settled: Array<Record<string, unknown>> = [];
    let released = 0;
    const admission = {
      reserve: async () => ({ id: "p1", maximumUsd: 12.5 }),
      settle: async (_permit: unknown, settlement: Record<string, unknown>) => {
        settled.push(settlement);
      },
      release: async () => {
        released += 1;
      },
    };
    const { client } = fakeStreamingClient([{ events: [], failWith: died }]);
    _resetAnthropicForTests(client);

    const result = await runPass({ ...streamingOpts, admission: admission as never });
    expect(result.ok).toBe(false);
    // Headers arrived, so the provider may have generated and billed the
    // whole response with nobody listening: presumed at the maximum, never
    // released as "never reached the provider".
    expect(released).toBe(0);
    expect(settled.every((s) => s.presumed === true && s.costUsd === 12.5)).toBe(true);
    expect(settled.length).toBe(PASS_TRANSPORT_MAX_ATTEMPTS);
  });

  /**
   * An abort landing during the backoff between attempts used to escape the
   * catch block as a raw rejection: `firstToken` never settled (so a cancel
   * before the first token hung runBullThenBear) and a later abort filed the
   * side as an anonymous transport failure with no `aborted` flag and none of
   * the usage its earlier attempts billed.
   */
  it("resolves an aborted result and settles firstToken when the signal aborts during the retry backoff", async () => {
    const controller = new AbortController();
    const { client, streamCalls } = fakeStreamingClient([
      { events: [], failWith: new APIConnectionError({ message: "socket hang up" }) },
    ]);
    _resetAnthropicForTests(client);

    const handle = runPassStreaming({ ...streamingOpts, signal: controller.signal });
    // The first attempt fails pre-token and the pass sleeps 1 s; cancel now.
    setTimeout(() => controller.abort(new Error("job canceled upstream")), 25);

    await expect(handle.firstToken).resolves.toBe("abort");
    const result = await handle.result;
    expect(streamCalls.length).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("transport");
    expect(result.error.aborted).toBe(true);
  });

  it("carries the billed usage of earlier attempts on an abort during a mid-stream backoff", async () => {
    const controller = new AbortController();
    const { client } = fakeStreamingClient([failingAttemptScript]);
    _resetAnthropicForTests(client);

    const handle = runPassStreaming({ ...streamingOpts, signal: controller.signal });
    await expect(handle.firstToken).resolves.toBe("streamEvent");
    setTimeout(() => controller.abort(new Error("sibling ended the run")), 25);
    const result = await handle.result;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.aborted).toBe(true);
    // Attempt 1 streamed 5K input + 8K output before it died: still billed.
    expect(result.error.usage).toMatchObject({ input_tokens: 5_000, output_tokens: 8_000 });
    expect(result.error.costUsd).toBeCloseTo(computeCostUsd(attemptBilledUsage, "claude-opus-4-8", 2), 10);
  });

  /**
   * An abort after generation started (a cancel, a deadline, or a doomed run
   * abandoning its sibling) is billed by the provider up to the disconnect
   * and reported as ~1 output token, because cumulative output tokens arrive
   * only in the final message_delta. It settles like a dead stream: reported
   * usage plus the presumed remainder, flagged presumed so the reconciler can
   * lower it — not as an `actual` row at message_start usage.
   */
  it("settles an abort after message_start as reported usage plus a presumed remainder", async () => {
    const settled: Array<Record<string, unknown>> = [];
    const admission = {
      reserve: async () => ({ id: "p1", maximumUsd: 100 }),
      settle: async (_permit: unknown, settlement: Record<string, unknown>) => {
        settled.push(settlement);
      },
      release: async () => {
        throw new Error("must not release a request that reached generation");
      },
    };
    const { client } = fakeStreamingClient([
      {
        events: [messageStartEvent({ input_tokens: 40_000, output_tokens: 1 })],
        failWith: new APIUserAbortError(),
      },
    ]);
    _resetAnthropicForTests(client);

    const result = await runPass({ ...streamingOpts, effort: "low", admission: admission as never });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("transport");
    expect(result.error.aborted).toBe(true);
    expect(result.error.message).toMatch(/aborted by the caller after generation started/);
    // 40K input at $5/MTok = $0.20 reported, plus (16,001 − 1) output tokens
    // at $25/MTok = $0.40 presumed.
    const expected = 0.2 + 0.000025 + (16_000 / 1_000_000) * 25;
    expect(result.error.costUsd).toBeCloseTo(expected, 6);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ presumed: true });
    expect(settled[0].costUsd).toBeCloseTo(expected, 6);
  });

  it("resolves a typed transport failure carrying summed billed usage after exhausting attempts", async () => {
    const delays = instantSleep();
    const { client, streamCalls } = fakeStreamingClient([failingAttemptScript]);
    _resetAnthropicForTests(client);

    const handle = runPassStreaming(streamingOpts);
    await expect(handle.firstToken).resolves.toBe("streamEvent");
    const result = await handle.result; // must RESOLVE, not reject

    expect(streamCalls.length).toBe(PASS_TRANSPORT_MAX_ATTEMPTS);
    expect(delays).toEqual([
      PASS_MID_STREAM_RETRY_DELAYS_MS[0],
      ...Array.from(
        { length: PASS_TRANSPORT_MAX_ATTEMPTS - 2 },
        () => PASS_MID_STREAM_RETRY_DELAYS_MS[PASS_MID_STREAM_RETRY_DELAYS_MS.length - 1],
      ),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("transport");
    expect(result.gap.field).toBe("llm.bull");
    expect(result.gap.reason).toContain(`${PASS_TRANSPORT_MAX_ATTEMPTS} attempt`);
    expect(result.error.message).toContain("Overloaded");
    // Billed usage across ALL attempts is surfaced so cost_log records real
    // spend. Derived from the attempt budget rather than restated, because
    // that budget absorbed the SDK's retries (DECISIONS D-10).
    expect(result.error.usage?.input_tokens).toBe(5_000 * PASS_TRANSPORT_MAX_ATTEMPTS);
    expect(result.error.usage?.output_tokens).toBe(8_000 * PASS_TRANSPORT_MAX_ATTEMPTS);
    expect(result.error.model).toBe("claude-opus-4-8");
    expect(result.error.webSearches).toBe(2 * PASS_TRANSPORT_MAX_ATTEMPTS);
    expect(result.error.costUsd).toBeCloseTo(
      PASS_TRANSPORT_MAX_ATTEMPTS * computeCostUsd(attemptBilledUsage, "claude-opus-4-8", 2),
      10,
    );
  });

  it("does not retry non-retryable errors and still resolves a typed transport failure", async () => {
    const delays = instantSleep();
    const { client, streamCalls } = fakeStreamingClient([
      {
        events: [messageStartEvent(attemptStartUsage)],
        failWith: new BadRequestError(
          400,
          { type: "error", error: { type: "invalid_request_error", message: "invalid request" } } as never,
          undefined,
          new Headers(),
        ),
      },
    ]);
    _resetAnthropicForTests(client);

    const result = await runPassStreaming(streamingOpts).result;

    expect(streamCalls.length).toBe(1);
    expect(delays).toEqual([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("transport");
    expect(result.error.message).toContain("invalid request");
  });

  it("keeps firstToken pending across a pre-token retry so bear still sequences off the real cache write", async () => {
    instantSleep();
    const finalMsg = syntheticMessage({
      content: [{ type: "text", text: '{"ok":true}', citations: null }],
    });
    const { client } = fakeStreamingClient([
      { failWith: new APIConnectionError({ message: "socket hang up" }) },
      { events: [messageStartEvent(attemptStartUsage)], final: finalMsg },
    ]);
    _resetAnthropicForTests(client);

    const handle = runPassStreaming(streamingOpts);
    // Must resolve "streamEvent" (from attempt 2), NOT "error" from attempt 1.
    await expect(handle.firstToken).resolves.toBe("streamEvent");
    const result = await handle.result;
    expect(result.ok).toBe(true);
  });

  it('settles firstToken as "error" only when every attempt dies before any stream event', async () => {
    instantSleep();
    const { client, streamCalls } = fakeStreamingClient([
      { failWith: new APIConnectionError({ message: "socket hang up" }) },
    ]);
    _resetAnthropicForTests(client);

    const handle = runPassStreaming(streamingOpts);
    await expect(handle.firstToken).resolves.toBe("error");
    const result = await handle.result;

    expect(streamCalls.length).toBe(PASS_TRANSPORT_MAX_ATTEMPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("transport");
    // Nothing streamed → nothing billed → no usage/cost claimed.
    expect(result.error.usage).toBeUndefined();
    expect(result.error.costUsd).toBeUndefined();
  });

  it("a clean single-attempt success reports only its own usage (no synthetic pollution)", async () => {
    const finalUsage = syntheticUsage({ input_tokens: 1_000, output_tokens: 2_000 });
    const finalMsg = syntheticMessage({
      content: [{ type: "text", text: '{"ok":true}', citations: null }],
      usage: finalUsage,
    });
    const { client, streamCalls } = fakeStreamingClient([
      { events: [messageStartEvent({ input_tokens: 1_000 })], final: finalMsg },
    ]);
    _resetAnthropicForTests(client);

    const result = await runPassStreaming(streamingOpts).result;

    expect(streamCalls.length).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.usage.input_tokens).toBe(1_000);
    expect(result.value.data.usage.output_tokens).toBe(2_000);
    expect(result.value.data.costUsd).toBeCloseTo(computeCostUsd(finalUsage, "claude-opus-4-8"), 10);
  });
});

describe("runPass transport failures at stream construction", () => {
  it("resolves a typed transport failure instead of rejecting when the SDK gives up", async () => {
    const client = {
      beta: {
        messages: {
          stream: () => {
            throw new InternalServerError(
              529,
              { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } as never,
              "Overloaded",
              new Headers(),
            );
          },
        },
      },
    } as unknown as Anthropic;
    _resetAnthropicForTests(client);
    const delays = instantSleep();

    const result = await runPass({ ...baseOpts, field: "llm.judge" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("transport");
    expect(result.gap.field).toBe("llm.judge");
    expect(delays).toEqual(PASS_TRANSPORT_RETRY_DELAYS_MS);
  });

  it("still rethrows non-SDK errors (programming bugs must stay loud)", async () => {
    const client = {
      beta: {
        messages: {
          stream: () => {
            throw new TypeError("undefined is not a function");
          },
        },
      },
    } as unknown as Anthropic;
    _resetAnthropicForTests(client);

    await expect(runPass(baseOpts)).rejects.toThrow(TypeError);
  });

  /**
   * runPassStreaming documents that `firstToken` "cannot hang". The
   * programming-bug rethrow path never signalled it, so a bug thrown before
   * any stream event left `await bullHandle.firstToken` waiting forever — bear
   * was never launched and the pass died at its deadline.
   */
  it("settles firstToken before rethrowing a programming bug", async () => {
    _resetAnthropicForTests({
      beta: {
        messages: {
          stream: () => {
            throw new TypeError("undefined is not a function");
          },
        },
      },
    } as unknown as Anthropic);

    const handle = runPassStreaming(streamingOpts);
    handle.result.catch(() => {});
    await expect(Promise.race([
      handle.firstToken,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("firstToken hung")), 2_000).unref?.();
      }),
    ])).resolves.toBe("error");
    await expect(handle.result).rejects.toThrow(TypeError);
  });
});

/* ------------------------------------------------------------------------ *
 * Stream idle guard (DECISIONS D-09). Every paid pass streams, so a provider
 * that accepts a request and then goes silent would hold a durable lease and
 * its reservation until the 10-minute transport timeout, and the run would
 * record nothing for generation Anthropic may already have billed.
 * ------------------------------------------------------------------------ */

describe("stream idle timeout", () => {
  const idleOpts = { ...streamingOpts, model: "claude-sonnet-5", effort: "low" as const };

  /** The provider reads the validated config, so the cache must be dropped. */
  const setIdleSeconds = (value: string | undefined): void => {
    if (value === undefined) delete process.env.THESIS_STREAM_IDLE_SECONDS;
    else process.env.THESIS_STREAM_IDLE_SECONDS = value;
    resetConfigCache();
  };

  afterEach(() => {
    setIdleSeconds(undefined);
  });

  it("reads the idle limit from the validated THESIS_STREAM_IDLE_SECONDS config", () => {
    setIdleSeconds(undefined);
    expect(streamIdleTimeoutMs()).toBe(300_000);
    setIdleSeconds("30");
    expect(streamIdleTimeoutMs()).toBe(30_000);
    // Zero still disables the guard.
    setIdleSeconds("0");
    expect(streamIdleTimeoutMs()).toBe(0);
    // There is one parser now, and it fails loudly instead of quietly
    // substituting a default the rest of the process does not agree with.
    setIdleSeconds("not-a-number");
    expect(() => streamIdleTimeoutMs()).toThrow(/THESIS_STREAM_IDLE_SECONDS/);
    setIdleSeconds("3601");
    expect(() => streamIdleTimeoutMs()).toThrow(/THESIS_STREAM_IDLE_SECONDS/);
  });

  /**
   * The guard cannot see thinking: Thesis never asks for thinking summaries, so
   * reasoning is silent on the wire on every model. Effort is what sets how
   * long that silence lasts, so the limit has to widen with it — a flat limit
   * survivable at `low` is a guaranteed false abort at `max` (2026-09-03: AMZN
   * on claude-fable-5-1 at effort max, abandoned at 120s and settled at the
   * presumed 127,995-token remainder).
   */
  it("widens the idle limit with effort and clamps it to the model stage deadline", () => {
    setIdleSeconds(undefined);
    // The default base sits at undici's ~300s body-timeout window, so a dead
    // connection is caught by the layer that can see the provider's pings.
    expect(streamIdleTimeoutMsFor("low")).toBe(300_000);
    expect(streamIdleTimeoutMsFor("medium")).toBe(300_000);
    expect(streamIdleTimeoutMsFor("high")).toBe(600_000);
    expect(streamIdleTimeoutMsFor("xhigh")).toBe(900_000);
    expect(streamIdleTimeoutMsFor("max")).toBe(1_200_000);
    // A model without effort support keeps the unscaled base.
    expect(streamIdleTimeoutMsFor(undefined)).toBe(300_000);
    // Never past the stage that owns the request, where it could not fire.
    setIdleSeconds("3600");
    expect(streamIdleTimeoutMsFor("max")).toBe(MODEL_STAGE_DEADLINE_MS);
    // Zero still disables the guard at every effort.
    setIdleSeconds("0");
    expect(streamIdleTimeoutMsFor("max")).toBe(0);
  });

  /**
   * The regression that produced the 2026-09-03 loss, stated as a rule: the
   * guard must never fire before undici's own idle body timeout, because the
   * Anthropic SDK drops the `ping` events that prove the request is alive
   * (`core/streaming.js`: `if (sse.event === 'ping') continue;`) and undici,
   * which counts bytes on the socket, does not. Firing first means pre-empting
   * a working detector with a blind one.
   */
  it("never fires before the transport's own ping-aware timeout", () => {
    setIdleSeconds(undefined);
    const UNDICI_BODY_TIMEOUT_MS = 300_000;
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(streamIdleTimeoutMsFor(effort)).toBeGreaterThanOrEqual(UNDICI_BODY_TIMEOUT_MS);
    }
  });

  it("does not abandon a deep-thinking stream inside its scaled limit", async () => {
    // Base 1s: effort low would abort at 1s, effort max must not.
    setIdleSeconds("1");
    const silentFor = 2_000;
    let resolveFinal!: (message: BetaMessage) => void;
    const finalPromise = new Promise<BetaMessage>((resolve) => {
      resolveFinal = resolve;
    });
    const final = syntheticMessage({
      model: "claude-fable-5-1",
      usage: syntheticUsage({ input_tokens: 1_000, output_tokens: 10 }),
    });
    const listeners: Array<(event: unknown) => void> = [];
    const stalled = {
      on: (name: string, fn: (event: unknown) => void) => {
        if (name === "streamEvent") listeners.push(fn);
      },
      once: (name: string, fn: (event: unknown) => void) => {
        if (name === "streamEvent") listeners.push(fn);
      },
      finalMessage: () => finalPromise,
      abort: () => {},
    };
    _resetAnthropicForTests({
      beta: { messages: { stream: () => stalled, create: async () => { throw new Error("must stream"); } } },
    } as unknown as Anthropic);

    // One event, then silence for longer than the unscaled limit.
    queueMicrotask(() => {
      for (const fn of listeners) fn(messageStartEvent({ input_tokens: 1_000 }, "claude-fable-5-1"));
    });
    const run = runPass({ ...idleOpts, model: "claude-fable-5-1", effort: "max" });
    await new Promise((resolve) => setTimeout(resolve, silentFor));
    resolveFinal(final);

    const result = await run;
    expect(result.ok).toBe(true);
  }, 15_000);

  it("abandons a silent stream and settles reported usage plus the presumed remainder", async () => {
    setIdleSeconds("1");
    const aborts: number[] = [];
    const stalled = makeFakeStream({
      events: [
        messageStartEvent({ input_tokens: 10_000, cache_creation_input_tokens: 0, output_tokens: 1 }, "claude-sonnet-5"),
        messageDeltaEvent({ output_tokens: 2_000 }),
      ],
      // No terminal event: the provider accepted the request and went quiet.
    }) as Record<string, unknown>;
    stalled.abort = (): void => {
      aborts.push(1);
    };
    _resetAnthropicForTests({
      beta: { messages: { stream: () => stalled, create: async () => { throw new Error("must stream"); } } },
    } as unknown as Anthropic);

    const result = await runPass(idleOpts);

    expect(aborts).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("transport");
    expect(result.error.message).toMatch(/stream idle timeout/);
    expect(result.error.message).toMatch(/presumed .* remaining output tokens/);
    // Reported: 10K input at $2/MTok plus 2K output at $10/MTok = $0.04.
    // Presumed remainder: the request's max_tokens (16,001 at effort low)
    // less the 2,000 reported, at $10/MTok = $0.14001.
    expect(result.error.costUsd).toBeCloseTo(0.02 + 0.02 + 0.14001, 6);
    expect(result.error.usage).toMatchObject({ input_tokens: 10_000, output_tokens: 2_000 });
    expect(result.error.model).toBe("claude-sonnet-5");
  }, 15_000);

  it("does not fire while the stream keeps producing events", async () => {
    setIdleSeconds("1");
    const final = syntheticMessage({
      model: "claude-sonnet-5",
      usage: syntheticUsage({ input_tokens: 1_000, output_tokens: 10 }),
    });
    const { client } = fakeStreamingClient([{ events: [messageStartEvent({}, "claude-sonnet-5")], final }]);
    _resetAnthropicForTests(client);

    const result = await runPass(idleOpts);
    expect(result.ok).toBe(true);
  }, 15_000);

  it("keeps streaming even for a small max_tokens request", async () => {
    const final = syntheticMessage({
      model: "claude-sonnet-5",
      usage: syntheticUsage({ input_tokens: 100, output_tokens: 5 }),
    });
    const { client, streamCalls } = fakeStreamingClient([{ events: [messageStartEvent({}, "claude-sonnet-5")], final }]);
    _resetAnthropicForTests(client);

    const result = await runPass({ ...idleOpts, maxTokens: 500 });
    expect(result.ok).toBe(true);
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]).toMatchObject({ max_tokens: 500 });
  });
});
