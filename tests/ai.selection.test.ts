import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStore } from "@/ai/store";
const fake = vi.hoisted(() => ({ store: null as AiStore | null, key: false, cli: null as string | null, google: null as null | { status: string }, openai: null as null | { status: string } }));
vi.mock("@/ai/store", () => ({ readAiStore: () => fake.store, withAiStore: async (fn: (s: AiStore) => unknown) => fn(fake.store!) }));
vi.mock("@/config/env", () => ({ getConfig: () => ({ hasAnthropicKey: fake.key }) }));
vi.mock("@/ai/chatgpt", () => ({ chatGptPending: () => fake.openai }));
vi.mock("@/ai/gemini", () => ({ geminiExecutable: () => fake.cli, geminiPending: () => fake.google }));
import { captureAiSelection, connectionsView, selectConnection, selectionIsConnected } from "@/ai/connections";
beforeEach(() => { fake.store = null; fake.key = false; fake.cli = null; fake.google = null; fake.openai = null; });
function store(): AiStore { return fake.store = { version: 1, hostId: "urn:uuid:fixture", profiles: [], gemini: null, selection: { provider: "none" } }; }
describe("explicit account selection", () => {
  it("preserves a legacy configured API route only before a saved selection exists", () => {
    expect(captureAiSelection()).toEqual({ provider: "none" });
    fake.key = true; expect(captureAiSelection()).toEqual({ provider: "anthropic" });
    store(); expect(captureAiSelection()).toEqual({ provider: "none" });
    expect(selectionIsConnected({ provider: "none" })).toBe(false);
    expect(selectionIsConnected({ provider: "anthropic" })).toBe(true);
  });
  it("requires the selected account's grant and installed Gemini runtime", async () => {
    const s = store(); s.profiles.push({ id: "p", clientId: "oaiapp_fixture" });
    const chat = { provider: "chatgpt" as const, connectionId: "p", model: "m" };
    expect(selectionIsConnected(chat)).toBe(false); await expect(selectConnection(chat)).rejects.toThrow("Connect");
    s.profiles[0].tokens = { access: "a", refresh: "r", id: "i", expiresAt: 1, scopes: ["chatgpt.tokens.use.direct"] };
    expect(selectionIsConnected(chat)).toBe(true); await selectConnection(chat); expect(s.selection).toEqual(chat);
    const google = { provider: "gemini" as const, connectionId: "g", model: "auto" };
    expect(selectionIsConnected(google)).toBe(false); await expect(selectConnection(google)).rejects.toThrow("Connect");
    s.gemini = { id: "g", connected: true };
    expect(selectionIsConnected(google)).toBe(false); fake.cli = "official";
    expect(selectionIsConnected(google)).toBe(true); await selectConnection(google); expect(s.selection).toEqual(google);
    await selectConnection({ provider: "anthropic" }); expect(s.selection).toEqual({ provider: "anthropic" });
    await selectConnection({ provider: "none" }); expect(s.selection).toEqual({ provider: "none" });
  });
  it.each([null, "text", {}, { provider: "unknown" }, { provider: "gemini", connectionId: 1 }, { provider: "chatgpt", connectionId: "p", model: "https://wrong" }])("rejects malformed selection %j", async (input) => {
    store(); await expect(selectConnection(input)).rejects.toThrow();
  });
  it("returns public labels and pending state without credential material", () => {
    expect(connectionsView().connections).toEqual([]);
    const s = store(); s.profiles.push({ id: "p", clientId: "oaiapp_private", email: "a@example.test" }, { id: "q", clientId: "oaiapp_private2" });
    s.gemini = { id: "g", connected: true };
    fake.google = { status: "error" }; fake.openai = { status: "waiting" };
    expect(connectionsView().pending?.status).toBe("waiting");
    fake.google = { status: "waiting" }; expect(connectionsView().pending).toEqual(fake.google);
    fake.google = null; fake.openai = { status: "connected" }; expect(connectionsView().pending).toEqual(fake.openai);
    const view = connectionsView(); expect(view.connections).toHaveLength(3);
    expect(view.connections[1].label).toContain("ChatGPT account");
    expect(JSON.stringify(view)).not.toContain("oaiapp_private");
  });
  it("saves only validated ChatGPT effort and speed controls", async () => {
    const s = store();
    s.profiles.push({ id: "p", clientId: "oaiapp_fixture", tokens: { access: "a", refresh: "r", id: "i", expiresAt: 1, scopes: ["chatgpt.tokens.use.direct"] } });
    const choice = { provider: "chatgpt", connectionId: "p", model: "gpt-6.1-sol", effort: "high", serviceTier: "fast" };
    await selectConnection(choice); expect(s.selection).toEqual(choice);
    await expect(selectConnection({ ...choice, effort: "ultra" })).rejects.toThrow("Choose");
    await expect(selectConnection({ ...choice, serviceTier: "invalid" })).rejects.toThrow("Choose");
    await expect(selectConnection({ ...choice, provider: "gemini" })).rejects.toThrow("Choose");
    expect(s.selection).toEqual(choice);
  });
});
