import "server-only";
import type { RunPassArgs, RunPassOutcome } from "@/pipeline/stageC/passes";
import { chatGptAccess, trackChatGptRequest, chatGptConnected } from "./chatgpt";
import { runGemini } from "./gemini";
import { parseSubscriptionModel, subscriptionModel, validModelId } from "./contracts";

const MAX_RESPONSE_BYTES = 4_000_000;
export function subscriptionMessages(args: RunPassArgs) {
  const evidenceRule = "Use only evidence in the supplied research payload. Web search is unavailable for this connection. Do not invent URLs or claim you fetched a source. Return JSON only, without Markdown fences.";
  return [
    { role: "developer", content: `${args.system}\n\n${evidenceRule}` },
    ...args.messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.map((b) => b.text).join("\n") })),
    ...(args.outputSchema ? [{ role: "user", content: `Your response must match this JSON schema:\n${JSON.stringify(args.outputSchema)}` }] : []),
  ];
}

/** A terminal completed event is mandatory; partial JSON is never a successful pass. */
export async function consumeChatGptStream(response: Response): Promise<{ text: string; model: string; input: number; output: number }> {
  if (!response.ok || !response.body) throw new Error(response.status === 429
    ? "ChatGPT usage allowance is exhausted. No paid fallback was attempted."
    : response.status === 401 || response.status === 403 ? "ChatGPT connection needs authorization or model access."
      : "ChatGPT could not start the report pass.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ""; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("ChatGPT response exceeded the local size limit");
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const raw = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!raw || raw === "[DONE]") continue;
        const event = JSON.parse(raw);
        if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
          throw new Error("ChatGPT did not complete the pass. Check your model access and plan allowance. No paid fallback was attempted.");
        }
        if (event.type === "response.completed") {
          const data = event.response;
          if (data?.status !== "completed" || !Array.isArray(data.output)) throw new Error("Invalid completed ChatGPT response");
          const text = data.output.flatMap((item: { type?: string; content?: { type?: string; text?: string }[] }) =>
            item.type === "message" ? item.content?.filter((c) => c.type === "output_text").map((c) => c.text ?? "") ?? [] : []).join("\n");
          if (!text.trim() || !validModelId(data.model)) throw new Error("ChatGPT returned no usable report content");
          const usage = data.usage;
          if (!Number.isFinite(usage?.input_tokens) || !Number.isFinite(usage?.output_tokens) || usage.input_tokens < 0 || usage.output_tokens < 0) throw new Error("ChatGPT response omitted valid usage accounting");
          return { text, model: data.model, input: usage.input_tokens, output: usage.output_tokens };
        }
      }
    }
    throw new Error("ChatGPT stream ended before completion");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function listChatGptModels(id: string): Promise<{ id: string; name: string }[]> {
  const access = await chatGptAccess(id);
  const response = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${access}` }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("ChatGPT model catalog is unavailable; reconnect or retry later");
  const data = await response.json();
  if (!Array.isArray(data.models)) throw new Error("Unexpected ChatGPT model catalog");
  return data.models.filter((m: { slug: string; visibility: string }) => m.visibility === "list" && validModelId(m.slug))
    .map((m: { slug: string; display_name?: string }) => ({ id: m.slug, name: m.display_name ?? m.slug }));
}

export async function runSubscriptionPass(args: RunPassArgs, connectionId: string): Promise<RunPassOutcome> {
  const parsed = parseSubscriptionModel(args.model);
  if (!parsed) throw new Error("Invalid subscription provider model");
  const field = args.field ?? "llm";
  const messages = subscriptionMessages(args);
  try {
    args.signal?.throwIfAborted();
    let result: { text: string; model: string; input: number; output: number };
    if (parsed.provider === "chatgpt") {
      const tracked = trackChatGptRequest(connectionId, args.signal);
      try {
        const access = await chatGptAccess(connectionId);
        tracked.signal.throwIfAborted();
        if (!chatGptConnected(connectionId)) throw new Error("ChatGPT connection is signed out");
        result = await consumeChatGptStream(await fetch("https://api.openai.com/v1/responses", {
          method: "POST", redirect: "error", signal: AbortSignal.any([tracked.signal, AbortSignal.timeout(180_000)]),
          headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
          // The plan-usage preview does not accept max_output_tokens or temperature.
          body: JSON.stringify({ model: parsed.model, input: messages, store: false, stream: true }),
        }));
      } finally { tracked.release(); }
    } else {
      result = await runGemini(connectionId, parsed.model, messages.map((m) => `${m.role}:\n${m.content}`).join("\n\n"), args.signal);
    }
    const usage = { input_tokens: result.input, output_tokens: result.output };
    const model = subscriptionModel(parsed.provider, result.model);
    return { ok: true, value: { data: { model, usage, costUsd: 0, fallbackUsed: false, fetchedUrls: [],
      message: { model, usage, stop_reason: "end_turn", content: [{ type: "text", text: result.text.replace(/^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/, "$1") }] } } } };
  } catch (error) {
    const reason = error instanceof Error && /^(ChatGPT|Gemini|Invalid completed|Invalid subscription)/.test(error.message)
      ? error.message : `${parsed.provider} pass failed or was canceled. No paid fallback was attempted.`;
    return { ok: false, gap: { field, reason, severity: "critical", attemptedSources: [parsed.provider] },
      error: { kind: "transport", message: reason, model: args.model, costUsd: 0, fallbackUsed: false, aborted: args.signal?.aborted === true } };
  }
}
