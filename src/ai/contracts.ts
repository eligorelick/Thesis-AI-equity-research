/** Browser-safe connection and model identifiers. No credential fields. */
export type SubscriptionProvider = "chatgpt" | "gemini";
export type AiSelection =
  | { provider: "none" }
  | { provider: "anthropic" }
  | { provider: SubscriptionProvider; connectionId: string; model: string };

export interface AiConnectionSummary {
  id: string;
  provider: SubscriptionProvider;
  label: string;
  connected: boolean;
  planEnabled: boolean;
}

export interface AiConnectionsView {
  selection: AiSelection;
  connections: AiConnectionSummary[];
  hasAnthropicKey: boolean;
  geminiInstalled: boolean;
  pending: { status: "waiting" | "connected" | "error"; message: string; url?: string } | null;
}

export function validModelId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

export function subscriptionModel(provider: SubscriptionProvider, model: string): string {
  if (!validModelId(model)) throw new Error("Invalid model identifier");
  return `${provider}/${model}`;
}

export function parseSubscriptionModel(value: string): { provider: SubscriptionProvider; model: string } | null {
  const match = /^(chatgpt|gemini)\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/.exec(value);
  return match ? { provider: match[1] as SubscriptionProvider, model: match[2] } : null;
}
