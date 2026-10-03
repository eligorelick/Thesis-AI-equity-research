import "server-only";
import { getConfig } from "@/config/env";
import { readAiStore, withAiStore } from "./store";
import { chatGptPending } from "./chatgpt";
import { geminiExecutable, geminiPending } from "./gemini";
import { validModelId, type AiConnectionsView, type AiSelection } from "./contracts";

export function captureAiSelection(): AiSelection {
  // Existing API installations retain their explicitly configured key route;
  // once a connection choice is saved, it is authoritative even after sign-out.
  return readAiStore()?.selection ?? { provider: getConfig().hasAnthropicKey ? "anthropic" : "none" };
}

export function selectionIsConnected(selection: AiSelection): boolean {
  if (selection.provider === "none") return false;
  if (selection.provider === "anthropic") return getConfig().hasAnthropicKey;
  const store = readAiStore();
  if (selection.provider === "gemini") return store?.gemini?.id === selection.connectionId && store.gemini.connected && geminiExecutable() !== null;
  return store?.profiles.some((p) => p.id === selection.connectionId && p.tokens?.scopes.includes("chatgpt.tokens.use.direct")) ?? false;
}

export function connectionsView(): AiConnectionsView {
  const store = readAiStore();
  const google = geminiPending(); const openai = chatGptPending();
  return { selection: captureAiSelection(), hasAnthropicKey: getConfig().hasAnthropicKey, geminiInstalled: geminiExecutable() !== null,
    pending: google?.status === "waiting" ? google : openai?.status === "waiting" ? openai : google ?? openai,
    connections: [
      ...(store?.profiles ?? []).map((p, index) => ({ id: p.id, provider: "chatgpt" as const, label: `${p.email ?? "ChatGPT account"} · connection ${index + 1}`, connected: !!p.tokens, planEnabled: p.tokens?.scopes.includes("chatgpt.tokens.use.direct") ?? false })),
      ...(store?.gemini ? [{ id: store.gemini.id, provider: "gemini" as const, label: "Google account in Thesis's Gemini CLI", connected: store.gemini.connected, planEnabled: store.gemini.connected }] : []),
    ] };
}

export async function selectConnection(input: unknown): Promise<void> {
  if (!input || typeof input !== "object") throw new Error("Invalid AI selection");
  const s = input as Record<string, unknown>;
  if (s.provider === "none" || s.provider === "anthropic") {
    await withAiStore((store) => { store.selection = { provider: s.provider as "none" | "anthropic" }; }); return;
  }
  if ((s.provider !== "chatgpt" && s.provider !== "gemini") || typeof s.connectionId !== "string" || !validModelId(s.model)) throw new Error("Choose a connection and a valid model");
  const selection: AiSelection = { provider: s.provider, connectionId: s.connectionId, model: s.model };
  await withAiStore((store) => {
    const connected = selection.provider === "gemini" ? store.gemini?.id === selection.connectionId && store.gemini.connected
      : store.profiles.some((p) => p.id === selection.connectionId && p.tokens?.scopes.includes("chatgpt.tokens.use.direct"));
    if (!connected) throw new Error("Connect this account before selecting it");
    store.selection = selection;
  });
}
