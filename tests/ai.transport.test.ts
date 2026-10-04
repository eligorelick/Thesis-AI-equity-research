import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { RunPassArgs } from "@/pipeline/stageC/passes";
const fake = vi.hoisted(() => ({ access: vi.fn(), connected: true, controller: null as AbortController | null, release: vi.fn(), gemini: vi.fn() }));
vi.mock("@/ai/chatgpt", () => ({ chatGptAccess: fake.access, chatGptConnected: () => fake.connected,
  trackChatGptRequest: () => ({ signal: fake.controller!.signal, release: fake.release }) }));
vi.mock("@/ai/gemini", () => ({ runGemini: fake.gemini }));
import { consumeChatGptStream, listChatGptModels, runSubscriptionPass, subscriptionMessages } from "@/ai/transport";
const args: RunPassArgs = { model: "chatgpt/example", system: "research", messages: [{ role: "user", content: "evidence" }], maxTokens: 100 };
const completed = { type: "response.completed", response: { status: "completed", model: "example", usage: { input_tokens: 3, output_tokens: 2 }, output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] } };
const event = (data: unknown) => new Response(`data: ${JSON.stringify(data)}\n\n`);
let remote: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks(); fake.controller = new AbortController(); fake.connected = true;
  fake.access.mockReset().mockResolvedValue("fake-access"); fake.gemini.mockReset();
  remote = vi.fn(async () => event(completed)); vi.stubGlobal("fetch", remote);
});
afterEach(() => vi.unstubAllGlobals());
describe("provider dispatch and catalog lifecycle", () => {
  it("sends only the OAuth Responses contract and releases the account request", async () => {
    const result = await runSubscriptionPass(args, "account");
    expect(result.ok).toBe(true);
    const [, options] = remote.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({ model: "example", input: subscriptionMessages(args), store: false, stream: true, service_tier: "default" });
    expect(options.headers).toEqual({ Authorization: "Bearer fake-access", "Content-Type": "application/json" });
    expect(fake.release).toHaveBeenCalled();
  });
  it("sends captured reasoning and Fast settings, retaining the actual returned controls", async () => {
    remote.mockResolvedValueOnce(event({ ...completed, response: { ...completed.response, model: "gpt-6.1-sol", reasoning: { effort: "high" }, service_tier: "default" } }));
    const result = await runSubscriptionPass({ ...args, model: "chatgpt/gpt-6.1-sol", effort: "low" }, "account", { effort: "high", serviceTier: "fast" });
    const [, options] = remote.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "high" }, service_tier: "fast" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.execution).toMatchObject({ requestedEffort: "high", effectiveEffort: "high", requestedServiceTier: "fast", effectiveServiceTier: "default" });
  });
  it("does not infer actual effort or speed when the provider omitted them", async () => {
    const result = await runSubscriptionPass(args, "account", { effort: "max", serviceTier: "fast" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.execution).toMatchObject({ requestedEffort: "max", effectiveEffort: null, requestedServiceTier: "fast", effectiveServiceTier: null });
  });
  it("preserves GPT-6.1 Sol and valid reasoning choices in a refreshed account catalog", async () => {
    remote.mockResolvedValueOnce(Response.json({ models: [null, { slug: "gpt-6.1-sol", visibility: "list", display_name: "GPT-6.1 Sol", supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }, { effort: "invalid" }] }, { slug: "gpt-6.1-sol", visibility: "list" }] }));
    expect(await listChatGptModels("account")).toEqual([{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["high", "max"] }]);
    const [, options] = remote.mock.calls[0] as unknown as [string, RequestInit];
    expect(options.cache).toBe("no-store");
  });
  it("normalizes the official Gemini result without recording API spend or fetched URLs", async () => {
    fake.gemini.mockResolvedValue({ text: '```json\n{"ok":true}\n```', model: "gemini-example", input: 4, output: 5 });
    const result = await runSubscriptionPass({ ...args, model: "gemini/auto" }, "google");
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.value.data.costUsd).toBe(0); expect(result.value.data.fetchedUrls).toEqual([]); expect(result.value.data.model).toBe("gemini/gemini-example"); }
    expect(remote).not.toHaveBeenCalled();
  });
  it("never calls a provider after cancellation or disconnect and sanitizes unexpected errors", async () => {
    fake.connected = false;
    expect((await runSubscriptionPass(args, "account")).ok).toBe(false); expect(remote).not.toHaveBeenCalled();
    fake.connected = true; fake.controller!.abort();
    expect((await runSubscriptionPass(args, "account")).ok).toBe(false); expect(remote).not.toHaveBeenCalled();
    const signal = AbortSignal.abort();
    const canceled = await runSubscriptionPass({ ...args, model: "gemini/auto", signal }, "google");
    expect(canceled.ok).toBe(false); if (!canceled.ok) expect(canceled.error.aborted).toBe(true);
    fake.gemini.mockRejectedValue(new Error("private token"));
    expect(JSON.stringify(await runSubscriptionPass({ ...args, model: "gemini/auto" }, "google"))).not.toContain("private token");
    await expect(runSubscriptionPass({ ...args, model: "invalid" }, "account")).rejects.toThrow("Invalid subscription");
  });
  it("filters the account model catalog and rejects inaccessible or malformed catalogs", async () => {
    remote.mockResolvedValueOnce(Response.json({ models: [{ slug: "m", visibility: "list" }, { slug: "n", visibility: "list", display_name: "Named" }, { slug: "hidden", visibility: "hide" }, { slug: "https://bad", visibility: "list" }] }));
    expect(await listChatGptModels("account")).toEqual([{ id: "m", name: "m" }, { id: "n", name: "Named" }]);
    remote.mockResolvedValueOnce(new Response("", { status: 403 })); await expect(listChatGptModels("account")).rejects.toThrow("unavailable");
    remote.mockResolvedValueOnce(Response.json({ data: [] })); await expect(listChatGptModels("account")).rejects.toThrow("Unexpected");
    fake.connected = false; await expect(listChatGptModels("account")).rejects.toThrow("signed out");
    fake.connected = true; fake.controller!.abort(); await expect(listChatGptModels("account")).rejects.toThrow();
    expect(fake.release).toHaveBeenCalledTimes(5);
  });
});
describe("response validation boundaries", () => {
  it.each([401, 403, 500])("rejects HTTP %i without using response contents", async (status) => {
    await expect(consumeChatGptStream(new Response("private contents", { status }))).rejects.toThrow("ChatGPT");
  });
  it.each([
    { ...completed.response, status: "incomplete" }, { ...completed.response, output: null },
    { ...completed.response, output: [] }, { ...completed.response, model: "bad/model" },
    { ...completed.response, usage: { input_tokens: -1, output_tokens: 1 } },
    { ...completed.response, usage: { input_tokens: 1, output_tokens: -1 } },
    { ...completed.response, usage: { input_tokens: 1.5, output_tokens: 1 } },
    { ...completed.response, usage: { input_tokens: 1, output_tokens: Number.MAX_SAFE_INTEGER + 1 } },
  ])("rejects a malformed terminal result %j", async (response) => {
    await expect(consumeChatGptStream(event({ type: "response.completed", response }))).rejects.toThrow();
  });
  it("ignores comments, DONE, and non-text blocks but enforces the size limit", async () => {
    const valid = { ...completed, response: { ...completed.response, output: [{ type: "reasoning" }, { type: "message" }, { type: "message", content: [{ type: "other" }, { type: "output_text" }, { type: "output_text", text: "{}" }] }] } };
    expect((await consumeChatGptStream(new Response(`: heartbeat\n\ndata: [DONE]\n\ndata: ${JSON.stringify(valid)}\n\n`))).text.trim()).toBe("{}");
    await expect(consumeChatGptStream(new Response("x".repeat(4_000_001)))).rejects.toThrow("size limit");
    await expect(consumeChatGptStream(new Response(null))).rejects.toThrow("start");
  });
});
