import { createHash } from "node:crypto";
import type { AiSelection } from "./contracts";

/** Account IDs are opaque, not emails or tokens, and only their hash is persisted. */
export function bindAiFingerprint(payload: string | null, selection: AiSelection): string | null {
  if (payload === null || !("connectionId" in selection)) return payload;
  return `${payload}:ai-v1:${createHash("sha256").update(JSON.stringify([selection.provider, selection.connectionId, selection.model])).digest("hex")}`;
}
