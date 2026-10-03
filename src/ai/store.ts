import "server-only";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AiSelection } from "./contracts";

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
      input, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 2_000_000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch { throw new Error("Unable to access Windows protected AI credentials"); }
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
    const value = JSON.parse(decoded) as AiStore;
    if (value.version !== 1 || !value.hostId.startsWith("urn:uuid:") || !Array.isArray(value.profiles)) throw new Error();
    return value;
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
  const lock = path.join(aiDirectory(), "connections.lock");
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number(fs.readFileSync(lock, "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") { fs.rmSync(lock); continue; } }
        }
      } catch { /* Another writer may be creating or removing the lock. */ }
      if (Date.now() - started > 40_000) throw new Error("AI credentials are busy; retry shortly");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    const store = readAiStore() ?? { version: 1, hostId: `urn:uuid:${randomUUID()}`, profiles: [], gemini: null, selection: { provider: "none" } };
    const result = await fn(store);
    writeAiStore(store);
    return result;
  } finally { fs.rmSync(lock, { force: true }); }
}
