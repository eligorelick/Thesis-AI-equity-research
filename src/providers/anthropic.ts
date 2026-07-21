/**
 * Anthropic provider client — model resolution, structured passes, cost
 * accounting, refusal fallbacks.
 *
 * SERVER-ONLY. Never import this module from a client component: it reads
 * ANTHROPIC_API_KEY from the environment.
 *
 * Design notes (the application contract §5, the cost model, the Anthropic API contract):
 * - No key → every call returns a FetchResult gap ("no Anthropic key") so the
 *   pipeline can dry-run end-to-end without throwing.
 * - All requests go through the beta messages surface (`client.beta.messages`)
 *   so fable-5 server-side refusal fallbacks and fallback detection share one
 *   code path; without `betas` the beta endpoint behaves like the GA API.
 * - NEVER send `temperature` / `top_p` / `top_k` (400 on 4.7+ models) and
 *   NEVER send a `thinking` param for claude-fable-5 (always-on; explicit
 *   config is a 400). Opus 4.8 gets `thinking: {type: "adaptive"}`; Sonnet 5
 *   runs adaptive by default when the param is omitted.
 *
 * Bull-first-then-bear cache-write sequencing (load-bearing for cost —
 * the cost model §2): a prompt-cache entry becomes readable only once the first
 * response *begins streaming*. Fire the bull pass with `runPassStreaming`,
 * await its `firstToken` promise, then fire the bear pass — it reads the
 * cache bull just wrote instead of paying a second 1.25x write:
 *
 *   const bull = runPassStreaming({ model, system, messages: bullMsgs, maxTokens: 32000 });
 *   await bull.firstToken;                  // cache entry now readable
 *   const bear = runPassStreaming({ model, system, messages: bearMsgs, maxTokens: 32000 });
 *   const [bullRes, bearRes] = await Promise.all([bull.result, bear.result]);
 */

import "server-only";

import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaTextBlockParam,
  BetaThinkingConfigParam,
  BetaToolUnion,
  BetaUsage,
  BetaWebSearchTool20250305,
  BetaWebSearchTool20260318,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";
import { canonicalizeFetchedUrl } from "@/pipeline/stageC/provenance";

/* ------------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------------ */

/**
 * "auto" model resolution preference order (the application contract §5).
 *
 * Opus 4.8 FIRST — the default recommended for accurate professional analysis in
 * the Anthropic API contract §9. Fable 5 is deliberately LAST despite being the
 * "most capable" model: at 2x Opus cost its cyber/bio safety classifiers can
 * refuse benign finance-adjacent tickers (defense, biotech, sanctions) →
 * degraded data-only reports, its single turns can run many minutes (worsening
 * page latency), and it requires 30-day org data retention (400s under ZDR).
 * Sonnet 5 is the safe cheaper middle (near-Opus quality, no classifier/retention
 * constraints). Fable 5 stays reachable via an explicit ANALYSIS_MODEL override
 * ("deep-dive" mode) but is never auto-selected while Opus/Sonnet are available.
 */
export const PREFERENCE_ORDER = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-fable-5",
] as const;

/** Beta header required for server-side refusal fallbacks (fable-5 only). */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-06-01";

/** Fallback target when claude-fable-5's safety classifiers decline. */
export const FABLE_FALLBACK_MODEL = "claude-opus-4-8";

/**
 * Web search tool version — switch here in one place if a newer variant
 * ships. `web_search_20260318` = dynamic filtering + `response_inclusion`
 * (the Anthropic API contract §2).
 */
export const WEB_SEARCH_TOOL_TYPE = "web_search_20260318" as const;

/**
 * Basic web search variant for models without dynamic-filtering support.
 * Haiku 4.5 rejects `web_search_20260318` with 400 "does not support
 * programmatic tool calling" (verified live 2026-07-08); it accepts the
 * basic `web_search_20250305`.
 */
export const WEB_SEARCH_TOOL_TYPE_BASIC = "web_search_20250305" as const;

/** Above this `maxTokens`, requests stream (SDK HTTP-timeout guidance). */
export const STREAMING_THRESHOLD_TOKENS = 16_000;

/** "auto" model resolution is cached for one hour. */
export const MODEL_RESOLUTION_TTL_MS = 60 * 60 * 1000;

/* ------------------------------------------------------------------------ *
 * Pricing (verified against live docs 2026-07-05 — the cost model §1)
 * ------------------------------------------------------------------------ */

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens (thinking is billed as output). */
  outputPerMTok: number;
}

/** 5-minute-TTL cache write bills at 1.25x base input. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
/** Cache read (hit) bills at 0.1x base input. */
export const CACHE_READ_MULTIPLIER = 0.1;
/** Web search: $10 per 1,000 searches, on top of token costs. */
export const WEB_SEARCH_USD_PER_SEARCH = 10 / 1000;

export const SONNET_5_INTRO_PRICING_END_EXCLUSIVE_MS = Date.UTC(2026, 8, 1);
export const SONNET_5_INTRO_PRICING: ModelPricing = { inputPerMTok: 2, outputPerMTok: 10 };

export const PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  // Standard pricing; computeCostUsd applies documented intro pricing before
  // 2026-09-01.
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * Look up pricing for a model id, tolerating dated snapshot ids
 * (e.g. "claude-haiku-4-5-20251001" matches "claude-haiku-4-5").
 */
export function findPricing(model: string): ModelPricing | undefined {
  const exact = PRICING[model];
  if (exact) return exact;
  const key = Object.keys(PRICING).find((k) => model.startsWith(`${k}-`));
  return key ? PRICING[key] : undefined;
}

function isSonnet5(model: string): boolean {
  return model === "claude-sonnet-5" || model.startsWith("claude-sonnet-5-");
}

export function effectivePricingFor(model: string, at = new Date()): ModelPricing | undefined {
  const pricing = findPricing(model);
  if (!pricing) return undefined;
  return isSonnet5(model) && at.getTime() < SONNET_5_INTRO_PRICING_END_EXCLUSIVE_MS
    ? SONNET_5_INTRO_PRICING
    : pricing;
}

/** Structural subset of the SDK Usage/BetaUsage objects that cost math needs. */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * USD cost of one request. Reads `input_tokens`, `output_tokens`,
 * `cache_creation_input_tokens` (1.25x input), `cache_read_input_tokens`
 * (0.1x input) plus $0.01 per web search.
 *
 * Throws for a model with no PRICING entry — silent wrong cost accounting is
 * worse than a loud failure (programming error, not a data gap).
 */
export function computeCostUsd(usage: UsageLike, model: string, webSearches = 0, at = new Date()): number {
  const pricing = effectivePricingFor(model, at);
  if (!pricing) {
    throw new Error(`computeCostUsd: no pricing entry for model "${model}" — add it to PRICING`);
  }
  const M = 1_000_000;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  return (
    (usage.input_tokens / M) * pricing.inputPerMTok +
    (usage.output_tokens / M) * pricing.outputPerMTok +
    (cacheWriteTokens / M) * pricing.inputPerMTok * CACHE_WRITE_MULTIPLIER +
    (cacheReadTokens / M) * pricing.inputPerMTok * CACHE_READ_MULTIPLIER +
    webSearches * WEB_SEARCH_USD_PER_SEARCH
  );
}

/* ------------------------------------------------------------------------ *
 * Client singleton
 * ------------------------------------------------------------------------ */

let clientSingleton: Anthropic | null | undefined;

/**
 * SDK auto-retry budget for transient failures (408/409/429/5xx incl. 529
 * `overloaded_error`), retried with exponential backoff + jitter and honoring
 * any `retry-after` header. The SDK default is 2; a report is 3–4 sequential
 * LLM passes, so a brief Anthropic overload would fail the whole run (→ a
 * degraded data-only report) far too often at the default. Bumping to 5 rides
 * out short overloads at the cost of a few minutes on a bad-capacity moment.
 *
 * IMPORTANT SCOPE LIMIT: these SDK retries only cover failures of the initial
 * HTTP response. Once a stream is open, a mid-stream SSE `error` event (e.g.
 * `overloaded_error` minutes into generation — observed live 2026-07-10, both
 * analyst passes killed by one capacity blip after ~8 minutes of billed
 * output each) is thrown TERMINALLY by the SDK with no retry. That class of
 * failure is handled by the pass-level retry in {@link runPassStreaming}
 * (PASS_TRANSPORT_MAX_ATTEMPTS below).
 */
export const CLIENT_MAX_RETRIES = 5;

/**
 * Total attempts per streaming pass (1 initial + 2 retries) for retryable
 * transport failures the SDK cannot retry itself — chiefly mid-stream SSE
 * `error` events (overloaded/api_error) and dropped connections. Each retry is
 * a FRESH request: partial streamed output cannot be resumed, so the retry
 * re-bills input (a cache read when the previous attempt's 5-minute-TTL cache
 * entry is still warm; a re-write when not). Bounded low because each attempt
 * can run minutes and bill real output tokens; past this, the pass fails typed
 * ("transport") carrying the billed usage of every attempt.
 */
export const PASS_TRANSPORT_MAX_ATTEMPTS = 3;

/**
 * Backoff before pass-level retry k (index k-1). Deliberately much longer than
 * the SDK's sub-10s HTTP backoff: a mid-stream overload means Anthropic shed
 * load while ALREADY serving the request, so immediate re-entry mostly dies
 * again. Deterministic (no jitter) for testability; bull/bear retrying in
 * lockstep can at worst duplicate one 1.25x payload cache write (~$0.15),
 * which is not worth cross-pass coordination machinery.
 */
export const PASS_TRANSPORT_RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000];

/**
 * Whether a failed pass attempt is worth re-issuing from scratch.
 * - Connection failures (network drop, undici's ~300s idle body timeout on a
 *   hung stream) → yes.
 * - HTTP 408/409/429/5xx (the SDK's own retryable set, seen here only after
 *   CLIENT_MAX_RETRIES exhausted) → yes: by then minutes have passed, and the
 *   pass-level backoff operates on a longer timescale than the SDK's.
 * - Mid-stream SSE errors (APIError with NO status) → only transient types;
 *   `invalid_request_error` etc. would fail identically on every attempt.
 * - User aborts and non-SDK errors (programming bugs) → never.
 */
export function isRetryableTransportError(err: unknown): boolean {
  if (err instanceof APIUserAbortError) return false;
  if (err instanceof APIConnectionError) return true;
  if (err instanceof APIError) {
    if (typeof err.status === "number") {
      return err.status === 408 || err.status === 409 || err.status === 429 || err.status >= 500;
    }
    const bodyType = (err.error as { error?: { type?: string } } | undefined)?.error?.type;
    const type = err.type ?? bodyType;
    return (
      type === "overloaded_error" ||
      type === "api_error" ||
      type === "timeout_error" ||
      type === "rate_limit_error"
    );
  }
  return false;
}

/** Sleep between pass-level transport retries — injectable so tests don't wait. */
let transportRetrySleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** TEST-ONLY. Replace (or with no argument restore) the transport-retry sleep. */
export function _setTransportRetrySleepForTests(fn?: (ms: number) => Promise<void>): void {
  transportRetrySleep = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

async function transportRetrySleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await transportRetrySleep(ms);
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    transportRetrySleep(ms).then(
      () => {
        cleanup();
        resolve();
      },
      (err: unknown) => {
        cleanup();
        reject(err);
      },
    );
  });
}

/**
 * Singleton Anthropic client from ANTHROPIC_API_KEY.
 * Returns `null` when no key is configured — callers then produce a
 * FetchResult gap ("no Anthropic key") instead of throwing.
 */
export function getClient(): Anthropic | null {
  if (clientSingleton === undefined) {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    clientSingleton = key ? new Anthropic({ apiKey: key, maxRetries: CLIENT_MAX_RETRIES }) : null;
  }
  return clientSingleton;
}

/**
 * TEST-ONLY. Overrides the client singleton and clears the model-resolution
 * cache. Call with no argument to reset (env re-read on next getClient()),
 * `null` to force keyless mode, or a (fake) client instance to inject.
 */
export function _resetAnthropicForTests(client?: Anthropic | null): void {
  clientSingleton = client;
  autoResolution = null;
}

/* ------------------------------------------------------------------------ *
 * Model resolution
 * ------------------------------------------------------------------------ */

export interface ResolvedModel {
  model: string;
  resolvedFrom: "auto" | "explicit";
}

let autoResolution: { model: string; resolvedAt: number } | null = null;

/**
 * Pure preference selection: first PREFERENCE_ORDER entry present in the
 * available id list (dated snapshot ids match their alias). Falls back to the
 * first listed model (the API lists newest first); throws only when the list
 * is empty (hard environment failure).
 */
export function pickPreferredModel(availableIds: readonly string[]): string {
  for (const preferred of PREFERENCE_ORDER) {
    const match = availableIds.find((id) => id === preferred || id.startsWith(`${preferred}-`));
    if (match) return match;
  }
  if (availableIds.length > 0) return availableIds[0];
  throw new Error("pickPreferredModel: models.list() returned no models");
}

/**
 * Resolve a model setting.
 * - Explicit ids pass through untouched (no network, works keyless).
 * - "auto" queries `client.models.list()` and picks the first available model
 *   in PREFERENCE_ORDER; the resolution is cached for 1 hour.
 * - "auto" with no key resolves deterministically to PREFERENCE_ORDER[0]
 *   without network (harmless: every actual call gaps out in dry-run mode).
 */
export async function resolveModel(setting: string): Promise<ResolvedModel> {
  if (setting !== "auto") {
    return { model: setting, resolvedFrom: "explicit" };
  }

  const now = Date.now();
  if (autoResolution && now - autoResolution.resolvedAt < MODEL_RESOLUTION_TTL_MS) {
    return { model: autoResolution.model, resolvedFrom: "auto" };
  }

  const client = getClient();
  if (!client) {
    return { model: PREFERENCE_ORDER[0], resolvedFrom: "auto" };
  }

  const availableIds: string[] = [];
  // PagePromise auto-paginates when iterated.
  for await (const info of client.models.list()) {
    availableIds.push(info.id);
  }
  const model = pickPreferredModel(availableIds);
  autoResolution = { model, resolvedAt: now };
  return { model, resolvedFrom: "auto" };
}

/* ------------------------------------------------------------------------ *
 * Request construction
 * ------------------------------------------------------------------------ */

export interface RunPassOptions {
  /** Model id (alias or dated snapshot). */
  model: string;
  system: string | BetaTextBlockParam[];
  messages: BetaMessageParam[];
  /** Keep IDENTICAL across passes — tool-set changes invalidate the cache. */
  tools?: BetaToolUnion[];
  /**
   * JSON schema for structured output (`output_config.format`, GA — no beta
   * header). Every object in the schema must set `additionalProperties: false`.
   */
  outputSchema?: Record<string, unknown>;
  maxTokens: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Manifest dot-path used in gap entries when the pass fails,
   * e.g. "llm.bull". Defaults to "llm.pass".
   */
  field?: string;
  /** Job-level cancellation/deadline signal. */
  signal?: AbortSignal;
}

/**
 * Thinking config per model family:
 * - fable-5: OMIT the param entirely (always-on; any explicit config is a 400).
 * - opus-4-8: `{type: "adaptive"}` (omitting would run WITHOUT thinking).
 * - everything else (sonnet-5 runs adaptive by default when omitted;
 *   haiku-4-5 has no adaptive support): omit.
 */
export function thinkingConfigFor(model: string): BetaThinkingConfigParam | undefined {
  if (model === "claude-fable-5" || model.startsWith("claude-fable-5-")) return undefined;
  if (model === "claude-opus-4-8" || model.startsWith("claude-opus-4-8-")) {
    return { type: "adaptive" };
  }
  return undefined;
}

/**
 * Whether a model accepts `output_config.effort`. Haiku 4.5 (and pre-4.6
 * Sonnets) reject it with 400 "This model does not support the effort
 * parameter" — sending it fails the whole pass, so buildPassParams drops
 * effort for those families instead. Fable/Opus 4.5+/Sonnet 4.6+/Sonnet 5
 * all support it.
 */
export function supportsEffort(model: string): boolean {
  if (model.startsWith("claude-haiku-")) return false;
  if (model === "claude-sonnet-4-5" || model.startsWith("claude-sonnet-4-5-")) return false;
  return true;
}

export interface BuiltPassRequest {
  params: MessageCreateParamsNonStreaming;
  /** True when the request opts into the fable-5 server-side fallback beta. */
  usesFallbackBeta: boolean;
}

/**
 * Pure request builder (exported for tests). Applies the model-family rules:
 * fable-5 always carries `betas: [SERVER_SIDE_FALLBACK_BETA]` +
 * `fallbacks: [{model: FABLE_FALLBACK_MODEL}]`; sampling params are never sent.
 */
export function buildPassParams(opts: RunPassOptions): BuiltPassRequest {
  const isFable = opts.model === "claude-fable-5" || opts.model.startsWith("claude-fable-5-");

  const params: MessageCreateParamsNonStreaming = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: opts.messages,
  };
  if (opts.tools) params.tools = opts.tools;

  const thinking = thinkingConfigFor(opts.model);
  if (thinking) params.thinking = thinking;

  const effort = supportsEffort(opts.model) ? opts.effort : undefined;
  if (effort !== undefined || opts.outputSchema !== undefined) {
    params.output_config = {
      ...(effort !== undefined ? { effort } : {}),
      ...(opts.outputSchema !== undefined
        ? { format: { type: "json_schema" as const, schema: opts.outputSchema } }
        : {}),
    };
  }

  if (isFable) {
    params.betas = [SERVER_SIDE_FALLBACK_BETA];
    params.fallbacks = [{ model: FABLE_FALLBACK_MODEL }];
  }

  return { params, usesFallbackBeta: isFable };
}

/**
 * Web search server tool (identical shape on every pass — cache discipline).
 * Pass the target model to get the variant that model accepts: haiku gets
 * the basic `web_search_20250305`, everything else the dynamic-filtering
 * `web_search_20260318`. Omitting `model` keeps the modern variant.
 */
export function webSearchTool(
  maxUses: number,
  model?: string,
): BetaWebSearchTool20260318 | BetaWebSearchTool20250305 {
  if (model?.startsWith("claude-haiku-")) {
    return { type: WEB_SEARCH_TOOL_TYPE_BASIC, name: "web_search", max_uses: maxUses };
  }
  return {
    type: WEB_SEARCH_TOOL_TYPE,
    name: "web_search",
    max_uses: maxUses,
    response_inclusion: "full",
  };
}

/* ------------------------------------------------------------------------ *
 * Response interpretation
 * ------------------------------------------------------------------------ */

/**
 * Detect whether a server-side fallback model served (part of) the response:
 * a `fallback` content block marks a switch point, and a `fallback_message`
 * entry in `usage.iterations` is the served-by signal (sticky-served turns
 * carry no block, so both signals are checked).
 */
export function detectFallbackUsed(message: {
  content?: ReadonlyArray<{ type: string }>;
  usage?: { iterations?: ReadonlyArray<{ type: string }> | null } | null;
}): boolean {
  const blockHit = (message.content ?? []).some((block) => block.type === "fallback");
  const iterationHit = (message.usage?.iterations ?? []).some(
    (entry) => entry.type === "fallback_message",
  );
  return blockHit || iterationHit;
}

function webSearchCount(message: BetaMessage): number {
  return message.usage.server_tool_use?.web_search_requests ?? 0;
}

function webFetchCount(message: BetaMessage): number {
  return message.usage.server_tool_use?.web_fetch_requests ?? 0;
}

/**
 * Extract exact successful web-search result URLs from a completed message.
 * Model-authored text and citation-shaped strings are intentionally ignored.
 */
export function collectFetchedUrls(message: BetaMessage): string[] {
  const urls = new Set<string>();
  for (const block of message.content) {
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const result of block.content) {
      if (result.type !== "web_search_result") continue;
      const canonical = canonicalizeFetchedUrl(result.url);
      if (canonical) urls.add(canonical);
    }
  }
  return [...urls].sort();
}

function costForMessage(message: BetaMessage, opts: RunPassOptions): number {
  // A fallback-served response reports the serving model's canonical id;
  // fall back to the requested model if the served id has no pricing entry.
  const pricingModel = findPricing(message.model) ? message.model : opts.model;
  return computeCostUsd(message.usage, pricingModel, webSearchCount(message));
}

function aggregateUsage(messages: readonly BetaMessage[]): BetaUsage {
  const finalUsage = messages[messages.length - 1]?.usage;
  if (!finalUsage) {
    throw new Error("aggregateUsage: at least one message is required");
  }
  if (messages.length === 1) return finalUsage;

  const inputTokens = messages.reduce((sum, message) => sum + message.usage.input_tokens, 0);
  const outputTokens = messages.reduce((sum, message) => sum + message.usage.output_tokens, 0);
  const cacheCreationTokens = messages.reduce(
    (sum, message) => sum + (message.usage.cache_creation_input_tokens ?? 0),
    0,
  );
  const cacheReadTokens = messages.reduce(
    (sum, message) => sum + (message.usage.cache_read_input_tokens ?? 0),
    0,
  );
  const webSearches = messages.reduce((sum, message) => sum + webSearchCount(message), 0);
  const webFetches = messages.reduce((sum, message) => sum + webFetchCount(message), 0);
  const iterations = messages.flatMap((message) => Array.from(message.usage.iterations ?? []));

  return {
    ...finalUsage,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
    iterations: iterations.length > 0 ? iterations : finalUsage.iterations,
    server_tool_use:
      finalUsage.server_tool_use || webSearches > 0 || webFetches > 0
        ? ({
            ...(finalUsage.server_tool_use ?? {}),
            web_search_requests: webSearches,
            web_fetch_requests: webFetches,
          } as NonNullable<BetaUsage["server_tool_use"]>)
        : finalUsage.server_tool_use,
  } as BetaUsage;
}

/**
 * Provider-produced kinds: no_key | refusal | max_tokens | context_window |
 * paused | transport. Stage C (src/pipeline/stageC/passes.ts) fabricates two
 * more so run forensics can tell a genuine safety refusal from a model that
 * produced malformed output (the 2026-07 audit found "refusal" covering both):
 *   parse     — output was not valid JSON
 *   schema    — JSON parsed but failed Zod validation
 *
 * "transport" is produced HERE (2026-07-10 incident fix) when a request/stream
 * fails after {@link PASS_TRANSPORT_MAX_ATTEMPTS}, carrying the billed usage
 * of every attempt so cost_log records real spend; Stage C's hardFailure
 * fabricates the same kind only as a safety net for unexpected rejections.
 */
export type PassErrorKind =
  | "no_key"
  | "refusal"
  | "max_tokens"
  | "context_window"
  | "paused"
  | "parse"
  | "schema"
  | "transport";

/**
 * Bound on automatic `stop_reason: "pause_turn"` resumption. Long search turns
 * can pause and resume when the assistant message is re-sent unchanged. Without
 * this bound,
 * interpretPassMessage previously fell through to its unconditional SUCCESS
 * branch on any unrecognized stop_reason — a paused message (whose content is
 * mid-search tool-result blocks, no final text) then failed JSON.parse and the
 * whole pass was discarded, burning its full sunk cost (cache write + searches
 * + output) for nothing. See resumeIfPaused.
 */
export const MAX_PAUSE_RESUMPTIONS = 5;

export interface PassError {
  kind: PassErrorKind;
  message: string;
  /** kind "refusal": policy category from stop_details (may be null). */
  refusalCategory?: "cyber" | "bio" | "frontier_llm" | "reasoning_extraction" | null;
  /** kind "max_tokens"/"context_window": the limit configured for the request. */
  maxTokens?: number;
  /** Usage/cost of the failed attempt(s) (mid-stream failures bill partial output). */
  usage?: BetaUsage;
  costUsd?: number;
  fallbackUsed?: boolean;
  /** Model that served the billed attempt(s), when known (kind "transport"). */
  model?: string;
  /** Web searches billed across failed attempt(s) ($0.01 each, kind "transport"). */
  webSearches?: number;
}

export interface PassOutcome {
  message: BetaMessage;
  /** Canonical URLs observed in successful web-search result blocks. */
  fetchedUrls: string[];
  usage: BetaUsage;
  costUsd: number;
  /** True when the fable-5 server-side fallback chain served the response. */
  fallbackUsed: boolean;
  /** Model that actually produced the response (fallback model when one served it). */
  model: string;
}

/**
 * Structural superset of FetchResult<PassOutcome>: the failure branch also
 * carries the typed PassError so the pipeline can branch on refusal vs
 * max_tokens vs dry-run while still filing the ManifestEntry.
 */
export type RunPassResult =
  | { ok: true; value: Sourced<PassOutcome> }
  | { ok: false; gap: ManifestEntry; error: PassError };

// Compile-time check: RunPassResult must remain assignable to FetchResult.
const _assertFetchResultCompat = (r: RunPassResult): FetchResult<PassOutcome> => r;
void _assertFetchResultCompat;

function gapEntry(opts: RunPassOptions, reason: string): ManifestEntry {
  return {
    field: opts.field ?? "llm.pass",
    reason,
    severity: "critical",
    attemptedSources: ["anthropic"],
  };
}

function noKeyResult(opts: RunPassOptions): RunPassResult {
  return {
    ok: false,
    gap: gapEntry(opts, "no Anthropic key"),
    error: {
      kind: "no_key",
      message: "ANTHROPIC_API_KEY is not set — Anthropic calls are disabled (pipeline dry-run)",
    },
  };
}

function interpretPassMessages(
  message: BetaMessage,
  opts: RunPassOptions,
  billableMessages: readonly BetaMessage[],
): RunPassResult {
  const fallbackUsed = billableMessages.some(detectFallbackUsed);
  const usage = aggregateUsage(billableMessages);
  const costUsd = billableMessages.reduce((sum, billedMessage) => sum + costForMessage(billedMessage, opts), 0);
  const fetchedUrls = [
    ...new Set(billableMessages.flatMap((billedMessage) => collectFetchedUrls(billedMessage))),
  ].sort();

  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category ?? null;
    return {
      ok: false,
      gap: gapEntry(
        opts,
        `Anthropic declined the request (stop_reason "refusal"${category ? `, category "${category}"` : ""})${fallbackUsed ? " — fallback chain also declined" : ""}`,
      ),
      error: {
        kind: "refusal",
        message:
          message.stop_details?.explanation ??
          "Request declined by safety classifiers (stop_reason refusal). Discard any partial output.",
        refusalCategory: category,
        usage,
        costUsd,
        fallbackUsed,
      },
    };
  }

  if (message.stop_reason === "max_tokens") {
    return {
      ok: false,
      gap: gapEntry(
        opts,
        `Pass truncated at max_tokens=${opts.maxTokens} — output incomplete; retry with a higher limit`,
      ),
      error: {
        kind: "max_tokens",
        message: `Response hit max_tokens=${opts.maxTokens} before completing. Retry with a higher maxTokens (streaming engages automatically above ${STREAMING_THRESHOLD_TOKENS}).`,
        maxTokens: opts.maxTokens,
        usage,
        costUsd,
        fallbackUsed,
      },
    };
  }

  if (message.stop_reason === "model_context_window_exceeded") {
    return {
      ok: false,
      gap: gapEntry(
        opts,
        `Pass stopped at model context window (stop_reason "model_context_window_exceeded") with max_tokens=${opts.maxTokens} - reduce input payload or maxTokens`,
      ),
      error: {
        kind: "context_window",
        message: `Response stopped because input plus max_tokens exceeded the model context window. Reduce the prompt size or maxTokens=${opts.maxTokens}; partial output discarded.`,
        maxTokens: opts.maxTokens,
        usage,
        costUsd,
        fallbackUsed,
      },
    };
  }

  // Reachable only when resumeIfPaused (runPass/runPassStreaming) exhausted
  // MAX_PAUSE_RESUMPTIONS and the turn is STILL paused — an unusually long
  // chain of search iterations. A single pause_turn along the way is invisible
  // here: the caller already resumed it before this function ever saw the
  // message. Filed as a typed, honest error rather than silently succeeding
  // into a downstream "not valid JSON" failure (there is no final text yet).
  if (message.stop_reason === "pause_turn") {
    return {
      ok: false,
      gap: gapEntry(
        opts,
        `Pass still paused (stop_reason "pause_turn") after ${MAX_PAUSE_RESUMPTIONS} resumption attempt(s) — an unusually long search turn`,
      ),
      error: {
        kind: "paused",
        message: `Turn paused repeatedly and exceeded the resumption budget (${MAX_PAUSE_RESUMPTIONS}). Partial output discarded.`,
        usage,
        costUsd,
        fallbackUsed,
      },
    };
  }

  const now = new Date().toISOString();
  return {
    ok: true,
    value: {
      data: {
        message,
        fetchedUrls,
        usage,
        costUsd,
        fallbackUsed,
        model: message.model,
      },
      asOf: now,
      source: "anthropic",
      endpoint: "/v1/messages",
      fetchedAt: now,
    },
  };
}

/**
 * Interpret a completed BetaMessage into a RunPassResult (exported for tests
 * against synthetic response shapes). Handles stop_reason "refusal" and
 * "max_tokens" as typed errors; everything else is a success.
 */
export function interpretPassMessage(message: BetaMessage, opts: RunPassOptions): RunPassResult {
  return interpretPassMessages(message, opts, [message]);
}

/* ------------------------------------------------------------------------ *
 * Passes
 * ------------------------------------------------------------------------ */

interface ResumedMessage {
  final: BetaMessage;
  billableMessages: BetaMessage[];
}

/**
 * A pause-resumption `create()` call failed AFTER earlier messages of the same
 * pass attempt were fully received (and billed). Carries those messages so the
 * caller's transport accounting doesn't lose their real spend.
 */
class ResumptionFailedError extends Error {
  constructor(
    readonly cause: unknown,
    readonly billableMessages: BetaMessage[],
  ) {
    super(errorMessageOf(cause));
    this.name = "ResumptionFailedError";
  }
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resume a `stop_reason: "pause_turn"` message by re-sending the assistant's
 * paused content UNCHANGED as an appended assistant turn (explicitly NOT a new
 * "continue" user message), bounded by {@link MAX_PAUSE_RESUMPTIONS} so a turn
 * that keeps re-pausing can't loop
 * forever. Resumption calls are plain (non-streaming) `create()` regardless of
 * whether the original request streamed — a paused turn's content is already
 * fully materialized (it's a complete message, not a partial stream), so there
 * is no first-token/cache-warming reason to stream the resumption itself.
 * Returns the message unchanged if it never paused; returns the last (still
 * "pause_turn") message if the budget is exhausted — interpretPassMessage
 * files that as a typed "paused" error rather than misreading it as success.
 * Throws {@link ResumptionFailedError} (wrapping the cause + the messages
 * billed so far) if a resumption call itself fails.
 */
async function resumeIfPausedWithUsage(
  client: Anthropic,
  params: MessageCreateParamsNonStreaming,
  message: BetaMessage,
  signal?: AbortSignal,
): Promise<ResumedMessage> {
  let current = params;
  let msg = message;
  const billableMessages = [message];
  let resumptions = 0;
  while (msg.stop_reason === "pause_turn" && resumptions < MAX_PAUSE_RESUMPTIONS) {
    current = {
      ...current,
      messages: [...current.messages, { role: "assistant", content: msg.content }],
    };
    try {
      msg = await client.beta.messages.create(current, { signal });
    } catch (err) {
      throw new ResumptionFailedError(err, billableMessages);
    }
    billableMessages.push(msg);
    resumptions++;
  }
  return { final: msg, billableMessages };
}

export async function resumeIfPaused(
  client: Anthropic,
  params: MessageCreateParamsNonStreaming,
  message: BetaMessage,
): Promise<BetaMessage> {
  try {
    const { final } = await resumeIfPausedWithUsage(client, params, message);
    return final;
  } catch (err) {
    // Public wrapper keeps the raw cause (ResumptionFailedError is internal).
    throw err instanceof ResumptionFailedError ? err.cause : err;
  }
}

export interface StreamingPassHandle {
  /**
   * Settles when the first stream event arrives — the moment the prompt-cache
   * entry written by this request becomes readable by other requests. Fire the
   * next pass (bear after bull) only after this resolves with "streamEvent".
   * Never rejects: it also settles on terminal error/abort/end so callers
   * cannot hang (the failure itself surfaces via `result`). A retryable
   * pre-token failure does NOT settle it — the retry may still write the
   * cache, so "error" here means the pass is terminally dead without ever
   * having streamed.
   */
  firstToken: Promise<"streamEvent" | "error" | "abort" | "end">;
  /**
   * Resolves with the interpreted pass result. Transport failures (mid-stream
   * SSE errors, dropped connections, HTTP failures after SDK retries) resolve
   * as `ok:false, kind:"transport"` carrying the billed usage of every attempt
   * — they do NOT reject. Rejects only on programming errors.
   */
  result: Promise<RunPassResult>;
}

/* -- billed-usage tracking for in-flight streams --------------------------- */

/**
 * Last-known cumulative usage snapshot of an in-flight stream attempt, updated
 * from `message_start` (input + cache tokens, serving model) and
 * `message_delta` (cumulative output tokens, server tool use) events. When the
 * stream dies mid-generation, Anthropic has still billed everything streamed
 * so far — this snapshot is the best-effort record of that spend (the exact
 * failure mode of 2026-07-10: two ~8-minute passes billed, $0 recorded).
 */
interface StreamedUsageSnapshot {
  model: string | null;
  usage: BetaUsage | null;
}

function trackStreamedUsage(stream: {
  on: (event: "streamEvent", listener: (event: BetaRawMessageStreamEvent) => void) => unknown;
}): StreamedUsageSnapshot {
  const snapshot: StreamedUsageSnapshot = { model: null, usage: null };
  stream.on("streamEvent", (event: BetaRawMessageStreamEvent) => {
    if (event.type === "message_start") {
      snapshot.model = event.message.model;
      snapshot.usage = { ...event.message.usage };
      return;
    }
    if (event.type === "message_delta" && event.usage) {
      const u = event.usage as Partial<BetaUsage>;
      const base = snapshot.usage ?? ({} as BetaUsage);
      snapshot.usage = {
        ...base,
        ...(typeof u.input_tokens === "number" ? { input_tokens: u.input_tokens } : {}),
        ...(typeof u.output_tokens === "number" ? { output_tokens: u.output_tokens } : {}),
        ...(typeof u.cache_creation_input_tokens === "number"
          ? { cache_creation_input_tokens: u.cache_creation_input_tokens }
          : {}),
        ...(typeof u.cache_read_input_tokens === "number"
          ? { cache_read_input_tokens: u.cache_read_input_tokens }
          : {}),
        ...(u.server_tool_use ? { server_tool_use: u.server_tool_use } : {}),
      };
    }
  });
  return snapshot;
}

/**
 * Materialize a failed attempt's streamed-usage snapshot as a minimal
 * BetaMessage so aggregateUsage/costForMessage treat it like any other billed
 * message. Returns null when nothing was billed (the stream died before
 * message_start — the request never reached generation).
 */
function billedMessageFromSnapshot(
  snapshot: StreamedUsageSnapshot,
  opts: RunPassOptions,
): BetaMessage | null {
  if (snapshot.usage === null) return null;
  // Normalize explicitly: a snapshot built only from message_delta events (no
  // message_start seen) can structurally lack the required numeric fields.
  const u = snapshot.usage;
  return {
    id: "msg_partial_failed_attempt",
    type: "message",
    role: "assistant",
    model: snapshot.model ?? opts.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: {
      ...u,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    },
  } as unknown as BetaMessage;
}

/** Typed `ok:false` transport result carrying the billed usage of all attempts. */
function transportFailureResult(
  opts: RunPassOptions,
  err: unknown,
  billedMessages: readonly BetaMessage[],
  attempts: number,
): RunPassResult {
  const raw = errorMessageOf(err);
  const billed = billedMessages.length > 0;
  const usage = billed ? aggregateUsage(billedMessages) : undefined;
  const costUsd = billed
    ? billedMessages.reduce((sum, m) => sum + costForMessage(m, opts), 0)
    : undefined;
  const webSearches = billed
    ? billedMessages.reduce((sum, m) => sum + webSearchCount(m), 0)
    : undefined;
  const attemptNoun = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
  return {
    ok: false,
    gap: gapEntry(opts, `LLM pass transport failure after ${attemptNoun} (incl. automatic retries): ${raw}`),
    error: {
      kind: "transport",
      message: `transport failure after ${attemptNoun}: ${raw}`,
      usage,
      costUsd,
      fallbackUsed: billed ? billedMessages.some(detectFallbackUsed) : undefined,
      model: billed ? (billedMessages[billedMessages.length - 1].model || opts.model) : undefined,
      webSearches,
    },
  };
}

/**
 * Streaming pass. Always streams (use for maxTokens > 16K and for the
 * bull-first-then-bear cache-write sequencing — see module JSDoc).
 *
 * Retries retryable transport failures ({@link isRetryableTransportError}) up
 * to {@link PASS_TRANSPORT_MAX_ATTEMPTS} total attempts with
 * {@link PASS_TRANSPORT_RETRY_DELAYS_MS} backoff — the SDK cannot retry a
 * stream that dies mid-generation, and without this a single overload blip
 * discards the pass's full sunk cost. Terminal failures resolve as a typed
 * "transport" RunPassResult carrying the summed billed usage of every attempt;
 * a pass that eventually succeeds folds its failed attempts' billed usage into
 * the reported cost so cost_log reflects true spend.
 */
export function runPassStreaming(opts: RunPassOptions): StreamingPassHandle {
  const client = getClient();
  if (!client) {
    return {
      firstToken: Promise.resolve("end"),
      result: Promise.resolve(noKeyResult(opts)),
    };
  }

  const { params } = buildPassParams(opts);

  let firstSettled = false;
  let signalFirst!: (event: "streamEvent" | "error" | "abort" | "end") => void;
  const firstToken = new Promise<"streamEvent" | "error" | "abort" | "end">((resolve) => {
    signalFirst = (event) => {
      if (firstSettled) return;
      firstSettled = true;
      resolve(event);
    };
  });

  const result = (async (): Promise<RunPassResult> => {
    const billedFailedAttempts: BetaMessage[] = [];
    for (let attempt = 1; attempt <= PASS_TRANSPORT_MAX_ATTEMPTS; attempt++) {
      const stream = client.beta.messages.stream(params, { signal: opts.signal });
      const snapshot = trackStreamedUsage(stream);
      stream.once("streamEvent", () => signalFirst("streamEvent"));
      try {
        const message = await stream.finalMessage();
        const { final, billableMessages } = await resumeIfPausedWithUsage(
          client,
          params,
          message,
          opts.signal,
        );
        signalFirst("end"); // only reachable pre-signal if the stream emitted no events
        return interpretPassMessages(final, opts, [...billedFailedAttempts, ...billableMessages]);
      } catch (err) {
        // A failed resumption still billed the attempt's completed messages
        // (incl. the streamed first message); otherwise fall back to the
        // last streamed usage snapshot.
        const cause = err instanceof ResumptionFailedError ? err.cause : err;
        if (err instanceof ResumptionFailedError) {
          billedFailedAttempts.push(...err.billableMessages);
        } else {
          const billed = billedMessageFromSnapshot(snapshot, opts);
          if (billed) billedFailedAttempts.push(billed);
        }
        if (isRetryableTransportError(cause) && attempt < PASS_TRANSPORT_MAX_ATTEMPTS) {
          const delay =
            PASS_TRANSPORT_RETRY_DELAYS_MS[
              Math.min(attempt - 1, PASS_TRANSPORT_RETRY_DELAYS_MS.length - 1)
            ];
          // Server-log every retry — post-mortems must not depend on the
          // transient pipeline UI (2026-07-10: the only trace of two failed
          // ~8-minute passes was a step detail on one page).
          console.warn(
            `[anthropic] ${opts.field ?? "llm.pass"}: transport failure on attempt ${attempt}/${PASS_TRANSPORT_MAX_ATTEMPTS}, retrying in ${Math.round(delay / 1000)}s: ${errorMessageOf(cause)}`,
          );
          await transportRetrySleepWithSignal(delay, opts.signal);
          continue;
        }
        if (!(cause instanceof APIUserAbortError)) {
          console.error(
            `[anthropic] ${opts.field ?? "llm.pass"}: terminal transport failure after ${attempt} attempt(s): ${errorMessageOf(cause)}`,
          );
        }
        signalFirst(cause instanceof APIUserAbortError ? "abort" : "error");
        return transportFailureResult(opts, cause, billedFailedAttempts, attempt);
      }
    }
    throw new Error("unreachable: transport retry loop exited without returning");
  })();

  return { firstToken, result };
}

/**
 * Run one LLM pass. Non-streaming below STREAMING_THRESHOLD_TOKENS; streams
 * with `finalMessage()` above it (SDK HTTP-timeout guidance). A `pause_turn`
 * (long web-search turn) is auto-resumed via {@link resumeIfPaused} before
 * interpretation. Returns `{message, usage, costUsd, fallbackUsed, model}`
 * wrapped in Sourced<T>, or a gap + typed error (no key / refusal / max_tokens
 * / paused / transport). SDK-level failures resolve as typed "transport"
 * results (the non-streaming request is atomic, so the SDK's own
 * CLIENT_MAX_RETRIES already cover its transient failures — no pass-level
 * retry loop here); only programming errors reject.
 */
export async function runPass(opts: RunPassOptions): Promise<RunPassResult> {
  if (opts.maxTokens > STREAMING_THRESHOLD_TOKENS) {
    return runPassStreaming(opts).result;
  }

  const client = getClient();
  if (!client) return noKeyResult(opts);

  const { params } = buildPassParams(opts);
  try {
    const message = await client.beta.messages.create(params, { signal: opts.signal });
    const { final, billableMessages } = await resumeIfPausedWithUsage(
      client,
      params,
      message,
      opts.signal,
    );
    return interpretPassMessages(final, opts, billableMessages);
  } catch (err) {
    if (err instanceof ResumptionFailedError) {
      console.error(
        `[anthropic] ${opts.field ?? "llm.pass"}: pause-resumption transport failure: ${err.message}`,
      );
      return transportFailureResult(opts, err.cause, err.billableMessages, 1);
    }
    if (err instanceof APIError) {
      // Covers connection/abort subclasses too; nothing streamed → no usage.
      console.error(
        `[anthropic] ${opts.field ?? "llm.pass"}: transport failure: ${errorMessageOf(err)}`,
      );
      return transportFailureResult(opts, err, [], 1);
    }
    throw err;
  }
}
