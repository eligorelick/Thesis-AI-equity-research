import "server-only";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { CHATGPT_EFFORTS, validModelId, type AiSelection } from "./contracts";
import { withAiMutex } from "./mutex";

export interface ChatGptProfile {
  id: string;
  clientId: string;
  subject?: string;
  email?: string;
  tokens?: { access: string; refresh: string; id: string; expiresAt: number; scopes: string[] };
}
export interface AiStore {
  version: 1;
  hostId: string;
  profiles: ChatGptProfile[];
  gemini: { id: string; connected: boolean } | null;
  selection: AiSelection;
  runtimeOwnerPid?: number;
}

// Validate the v1 fields consumed by connection/runtime code before any
// callback can rewrite the file. Unknown metadata is retained, and signed-out
// registrations/selections and historical model IDs remain valid.
const aiStoreSchema = z.object({
  version: z.literal(1),
  hostId: z.string().startsWith("urn:uuid:"),
  profiles: z.array(z.object({
    id: z.string().min(1),
    clientId: z.string().min(1),
    subject: z.string().optional(),
    email: z.string().optional(),
    tokens: z.object({
      access: z.string().min(1), refresh: z.string().min(1), id: z.string().min(1),
      expiresAt: z.number(), scopes: z.array(z.string()),
    }).passthrough().optional(),
  }).passthrough()),
  gemini: z.object({ id: z.string().min(1), connected: z.boolean() }).passthrough().nullable(),
  selection: z.union([
    z.object({ provider: z.enum(["none", "anthropic"]) }).passthrough(),
    z.object({
      provider: z.enum(["chatgpt", "gemini"]),
      connectionId: z.string().min(1), model: z.string().refine(validModelId),
      effort: z.enum(CHATGPT_EFFORTS).optional(),
      serviceTier: z.enum(["default", "fast"]).optional(),
    }).passthrough(),
  ]),
  runtimeOwnerPid: z.number().int().positive().optional(),
}).passthrough();

/** Call under withAiStore: one local server owns connection lifecycles at a time. */
export function claimAiRuntime(store: AiStore): void {
  const owner = store.runtimeOwnerPid;
  if (owner && owner !== process.pid) {
    let alive = true;
    try { process.kill(owner, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (alive) throw new Error("AI connections are active in another Thesis server. Use that server or stop it before connecting here.");
  }
  store.runtimeOwnerPid = process.pid;
}

/** Credentials deliberately ignore database/repository paths and live under the OS user profile. */
export function aiDirectory(): string {
  const base = process.platform === "win32"
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "Thesis", "ai");
}

export function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function windowsProtect(input: string, decrypt: boolean): string {
  // Secrets are piped on stdin, never command-line arguments, environment or logs.
  const operation = decrypt ? "Unprotect" : "Protect";
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      // First PowerShell startup on a cold Windows host can exceed 15 seconds.
      input, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 2_000_000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT") throw new Error("AI credentials: Windows protection timed out; retry shortly.");
    throw new Error("Unable to access Windows protected AI credentials");
  }
}

function filePath(): string { return path.join(aiDirectory(), "connections.v1.json"); }

export function readAiStore(): AiStore | null {
  if (!fs.existsSync(filePath())) return null;
  try {
    const envelope = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    const decoded = envelope.protection === "windows-dpapi"
      ? Buffer.from(windowsProtect(envelope.data, true), "base64").toString("utf8")
      : process.platform !== "win32" && envelope.protection === "owner-only" ? envelope.data : null;
    if (decoded === null) throw new Error();
    const value: unknown = JSON.parse(decoded);
    if (!aiStoreSchema.safeParse(value).success) throw new Error();
    return value as AiStore;
  } catch { throw new Error("AI connection storage cannot be read; credentials were not replaced"); }
}

function writeAiStore(store: AiStore): void {
  const data = JSON.stringify(store);
  const envelope = process.platform === "win32"
    ? { protection: "windows-dpapi", data: windowsProtect(Buffer.from(data).toString("base64"), false) }
    : { protection: "owner-only", data };
  const temporary = `${filePath()}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(envelope), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath());
    if (process.platform !== "win32") fs.chmodSync(filePath(), 0o600);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Cross-process exclusion protects rotating refresh tokens as well as settings writes. */
export async function withAiStore<T>(fn: (store: AiStore) => Promise<T> | T): Promise<T> {
  ensurePrivateDirectory(aiDirectory());
  return withAiMutex(path.join(aiDirectory(), "connections.lock"), async () => {
    const store = readAiStore() ?? { version: 1, hostId: `urn:uuid:${randomUUID()}`, profiles: [], gemini: null, selection: { provider: "none" } };
    const result = await fn(store);
    writeAiStore(store);
    return result;
  });
}
