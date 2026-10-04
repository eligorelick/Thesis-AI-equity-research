import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSubscriptionModel, subscriptionModel } from "@/ai/contracts";
import { bindAiFingerprint } from "@/ai/fingerprint";
import { consumeChatGptStream, subscriptionMessages } from "@/ai/transport";
import { geminiEnvironment } from "@/ai/gemini";
import { buildExecutionMetadataEntry, sharedModelFamilyOf } from "@/report/execution";

afterEach(() => vi.unstubAllEnvs());
const completed = { type: "response.completed", response: { status: "completed", model: "example-model", usage: { input_tokens: 10, output_tokens: 4 }, output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] }] } };
function events(...data: unknown[]) { return new Response(data.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")); }

describe("subscription transport boundaries", () => {
  it("accepts only a completed response with final content and usage", async () => {
    expect(await consumeChatGptStream(events({ type: "response.output_text.delta", delta: "ignored partial" }, completed)))
      .toEqual({ text: '{"ok":true}', model: "example-model", input: 10, output: 4 });
  });
  it.each(["response.failed", "response.incomplete", "error"])("rejects %s even after text arrives", async (type) => {
    await expect(consumeChatGptStream(events({ type: "response.output_text.delta", delta: '{"ok":true}' }, { type }))).rejects.toThrow("did not complete");
  });
  it("rejects a truncated stream, quota failure and completion without usage", async () => {
    await expect(consumeChatGptStream(events({ type: "response.output_text.delta", delta: "{}" }))).rejects.toThrow("before completion");
    await expect(consumeChatGptStream(new Response("", { status: 429 }))).rejects.toThrow("No paid fallback");
    await expect(consumeChatGptStream(events({ ...completed, response: { ...completed.response, usage: undefined } }))).rejects.toThrow("usage accounting");
  });
  it("handles frames split across byte chunks without mistaking deltas for final content", async () => {
    const encoded = new TextEncoder().encode(`data: ${JSON.stringify(completed)}\n\n`);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7)); controller.close();
    } });
    expect((await consumeChatGptStream(new Response(stream))).text).toBe('{"ok":true}');
  });
  it("accepts CRLF frames even when every CR/LF pair straddles a chunk", async () => {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(completed)}\r\n\r\n`);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close();
    } });
    expect((await consumeChatGptStream(new Response(stream))).text).toBe('{"ok":true}');
  });
  it("sends developer rules and schema, without inventing observed web sources", () => {
    const input = subscriptionMessages({ model: "chatgpt/example", system: "Research rules", messages: [{ role: "user", content: [{ type: "text", text: "evidence", cache_control: { type: "ephemeral" } }] }], outputSchema: { type: "object" }, maxTokens: 100 });
    expect(input[0].role).toBe("developer");
    expect(input[0].content).toContain("Web search is unavailable");
    expect(input[1].content).toBe("evidence");
    expect(input.at(-1)?.content).toContain('{"type":"object"}');
    expect(JSON.stringify(input)).not.toContain("cache_control");
  });
});

describe("account binding and billing disclosures", () => {
  it("changes durable compatibility for a provider, account or model change", () => {
    const base = { provider: "chatgpt" as const, connectionId: "account-a", model: "model-a" };
    const fingerprints = [base, { ...base, provider: "gemini" as const }, { ...base, connectionId: "account-b" }, { ...base, model: "model-b" }].map((selection) => bindAiFingerprint("payload", selection));
    expect(new Set(fingerprints).size).toBe(4);
    expect(fingerprints[0]).not.toContain("account-a");
    expect(bindAiFingerprint("payload", { provider: "anthropic" })).toBe("payload");
    expect(bindAiFingerprint(null, base)).toBeNull();
  });
  it("rejects arbitrary endpoints and shell syntax in model identifiers", () => {
    expect(subscriptionModel("chatgpt", "example-model")).toBe("chatgpt/example-model");
    expect(parseSubscriptionModel("chatgpt/example-model")).toEqual({ provider: "chatgpt", model: "example-model" });
    expect(parseSubscriptionModel("https://evil.example/model")).toBeNull();
    expect(() => subscriptionModel("gemini", "model; command")).toThrow();
  });
  it("does not reuse passes across captured reasoning or speed settings", () => {
    const selection = { provider: "chatgpt" as const, connectionId: "account", model: "gpt-6.1-sol" };
    const variants = [selection, { ...selection, effort: "high" as const }, { ...selection, effort: "max" as const }, { ...selection, effort: "high" as const, serviceTier: "fast" as const }];
    expect(new Set(variants.map((item) => bindAiFingerprint("payload", item))).size).toBe(4);
  });
  it("reports plan usage and the same serving model for all three passes", () => {
    const model = "chatgpt/example-model";
    const entry = buildExecutionMetadataEntry({ step: "bull", requestedModel: model, effectiveModel: model, requestedEffort: "high", fallbackUsed: false });
    expect(entry.note).toContain("not free or unlimited");
    expect(entry.note).toContain("without additional web search");
    expect(entry.effectiveEffort).toBeNull();
    expect(sharedModelFamilyOf(["bull", "bear", "synthesize"].map((step) => ({ step, effectiveModel: model }))).shared).toBe(true);
  });
  it("does not pass API credentials or runtime injection settings into Gemini", () => {
    for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "NODE_OPTIONS", "HTTPS_PROXY", "GEMINI_CLI_SYSTEM_SETTINGS_PATH"]) vi.stubEnv(key, "private-test-value");
    const env = geminiEnvironment("isolated-home", false);
    expect(Object.values(env)).not.toContain("private-test-value");
    expect(env.GEMINI_CLI_HOME).toBe("isolated-home");
    expect(env.GEMINI_CLI_NO_RELAUNCH).toBe("true");
    expect(env.GOOGLE_GENAI_USE_GCA).toBe("true");
    expect(env.NO_BROWSER).toBe("1");
    expect(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toContain("isolated-home");
  });
});
