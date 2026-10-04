import { createHash } from "node:crypto";
import type { AiSelection } from "./contracts";

/** Account IDs are opaque, not emails or tokens, and only their hash is persisted. */
export function bindAiFingerprint(payload: string | null, selection: AiSelection): string | null {
  if (payload === null || !("connectionId" in selection)) return payload;
  const identity: unknown[] = [selection.provider, selection.connectionId, selection.model];
  // Preserve old fingerprints when no new controls were captured. Any explicit
  // effort/speed choice prevents reuse of passes generated under other settings.
  if (selection.provider === "chatgpt" && (selection.effort !== undefined || selection.serviceTier !== undefined)) {
    identity.push(selection.effort ?? null, selection.serviceTier ?? "default");
  }
  return `${payload}:ai-v1:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}
