/**
 * Pure unit tests for the Anthropic provider client. NO network calls:
 * model resolution runs against an injected fake client, cost math and
 * fallback detection run against synthetic payloads.
 */
import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type { BetaMessage, BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  CLIENT_MAX_RETRIES,
  FABLE_FALLBACK_MODEL,
  MAX_PROVIDER_WEB_SEARCHES,
  PASS_TRANSPORT_MAX_ATTEMPTS,
  PASS_BILLING_EXPOSURE_MULTIPLIER,
  PASS_TRANSPORT_RETRY_DELAYS_MS,
  PREFERENCE_ORDER,
  PRICING,
  SERVER_SIDE_FALLBACK_BETA,
  WEB_SEARCH_TOOL_TYPE,
  WEB_SEARCH_USD_PER_SEARCH,
  MAX_PAUSE_RESUMPTIONS,
  _resetAnthropicForTests,
  _setTransportRetrySleepForTests,
  buildPassParams,
  collectFetchedUrls,
  computeCostUsd,
  detectFallbackUsed,
  findPricing,
  interpretPassMessage,
  isRetryableTransportError,
  modelContextTokenLimit,
  pickPreferredModel,
  pricedModelAlias,
  resolveModel,
  resumeIfPaused,
  runPass,
  runPassStreaming,
  streamIdleTimeoutMs,
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

  it("reproduces the the cost model bull-pass mid-case (~$0.90 on opus-4-8)", () => {
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
      tools: [webSearchTool(1)] as never,
    })).toThrow(/judge.*web.search|web.search.*judge/i);
  });

  it("adds the server-side fallback beta + fallbacks for claude-fable-5", () => {
    const { params, usesFallbackBeta } = buildPassParams({ ...baseOpts, model: "claude-fable-5" });
    expect(usesFallbackBeta).toBe(true);
    expect(params.betas).toEqual([SERVER_SIDE_FALLBACK_BETA]);
    expect(params.fallbacks).toEqual([{ model: FABLE_FALLBACK_MODEL }]);
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
    const tools = [webSearchTool(MAX_PROVIDER_WEB_SEARCHES)];
    const { params } = buildPassParams({ ...baseOpts, tools });
    expect(params.tools).toBe(tools);
  });
});

describe("webSearchTool", () => {
  it("returns the switchable tool type with name and max_uses", () => {
    expect(webSearchTool(MAX_PROVIDER_WEB_SEARCHES)).toEqual({
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
    expect(() => webSearchTool(MAX_PROVIDER_WEB_SEARCHES + 1)).toThrow(/max_uses.*8/i);
    for (const maxUses of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => webSearchTool(maxUses)).toThrow(/max_uses/i);
    }
    expect(() => webSearchTool(1, "claude-mystery-9")).toThrow(/unsupported|priced/i);
  });

  it("keeps the literal retry exposure multiplier executable", () => {
    expect(PASS_BILLING_EXPOSURE_MULTIPLIER).toBe(
      (CLIENT_MAX_RETRIES + 1) * PASS_TRANSPORT_MAX_ATTEMPTS * (MAX_PAUSE_RESUMPTIONS + 1),
    );
    expect(PASS_BILLING_EXPOSURE_MULTIPLIER).toBe(108);
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
    // priced at the SERVING model's rate ($5/MTok), not fable's $10
    expect(result.value.data.costUsd).toBeCloseTo(5, 10);
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
 * pause_turn resumption (the Anthropic API contract §2: long search turns can
 * pause mid-turn — resend the assistant's content UNCHANGED to resume).
 * ------------------------------------------------------------------------ */

/**
 * A client whose initial request STREAMS (every paid pass streams now) and
 * whose pause resumption uses create(). `streamFinal` is what finalMessage()
 * resolves with; `createResponses` answers each resumption in order.
 */
function fakeStreamingResumeClient(
  streamFinal: BetaMessage,
  createResponses: BetaMessage[],
): { client: Anthropic; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          calls.push(params);
          return makeFakeStream({ events: [{ type: "message_start", message: streamFinal }], final: streamFinal });
        },
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          const msg = createResponses[Math.min(i, createResponses.length - 1)];
          i++;
          return msg;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

function fakeCreateClient(responses: BetaMessage[]): { client: Anthropic; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          const msg = responses[Math.min(i, responses.length - 1)];
          i++;
          return msg;
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
    // The initial request streams and pauses; resumeIfPaused then calls
    // create() once and returns the final message.
    const { client } = fakeStreamingResumeClient(pausedMsg, [finalMsg]);
    _resetAnthropicForTests(client);
    const result = await runPass(baseOpts);
    expect(result.ok).toBe(true);
  });

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
    expect(delays).toEqual([PASS_TRANSPORT_RETRY_DELAYS_MS[0]]);
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

  it("resolves a typed transport failure carrying summed billed usage after exhausting attempts", async () => {
    const delays = instantSleep();
    const { client, streamCalls } = fakeStreamingClient([failingAttemptScript]);
    _resetAnthropicForTests(client);

    const handle = runPassStreaming(streamingOpts);
    await expect(handle.firstToken).resolves.toBe("streamEvent");
    const result = await handle.result; // must RESOLVE, not reject

    expect(streamCalls.length).toBe(PASS_TRANSPORT_MAX_ATTEMPTS);
    expect(delays).toEqual([...PASS_TRANSPORT_RETRY_DELAYS_MS]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("transport");
    expect(result.gap.field).toBe("llm.bull");
    expect(result.gap.reason).toContain(`${PASS_TRANSPORT_MAX_ATTEMPTS} attempt`);
    expect(result.error.message).toContain("Overloaded");
    // Billed usage across ALL attempts is surfaced so cost_log records real spend.
    expect(result.error.usage?.input_tokens).toBe(15_000);
    expect(result.error.usage?.output_tokens).toBe(24_000);
    expect(result.error.model).toBe("claude-opus-4-8");
    expect(result.error.webSearches).toBe(6);
    expect(result.error.costUsd).toBeCloseTo(
      3 * computeCostUsd(attemptBilledUsage, "claude-opus-4-8", 2),
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
});

/* ------------------------------------------------------------------------ *
 * Stream idle guard (DECISIONS D-09). Every paid pass streams, so a provider
 * that accepts a request and then goes silent would hold a durable lease and
 * its reservation until the 10-minute transport timeout, and the run would
 * record nothing for generation Anthropic may already have billed.
 * ------------------------------------------------------------------------ */

describe("stream idle timeout", () => {
  const idleOpts = { ...streamingOpts, model: "claude-sonnet-5", effort: "low" as const };

  afterEach(() => {
    delete process.env.THESIS_STREAM_IDLE_SECONDS;
  });

  it("reads the idle limit from THESIS_STREAM_IDLE_SECONDS and falls back to the default", () => {
    delete process.env.THESIS_STREAM_IDLE_SECONDS;
    expect(streamIdleTimeoutMs()).toBe(120_000);
    process.env.THESIS_STREAM_IDLE_SECONDS = "30";
    expect(streamIdleTimeoutMs()).toBe(30_000);
    process.env.THESIS_STREAM_IDLE_SECONDS = "0";
    expect(streamIdleTimeoutMs()).toBe(0);
    process.env.THESIS_STREAM_IDLE_SECONDS = "not-a-number";
    expect(streamIdleTimeoutMs()).toBe(120_000);
  });

  it("abandons a silent stream and settles reported usage plus the presumed remainder", async () => {
    process.env.THESIS_STREAM_IDLE_SECONDS = "1";
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
    process.env.THESIS_STREAM_IDLE_SECONDS = "1";
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
