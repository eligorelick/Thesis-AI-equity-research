import "server-only";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { aiDirectory, ensurePrivateDirectory, readAiStore, withAiStore } from "./store";
import { chromeExecutable } from "./browser";

const KEY = Symbol.for("thesis.gemini.runtime.v1");
type Runtime = { pending: { status: "waiting" | "connected" | "error"; message: string } | null; children: Set<ChildProcessWithoutNullStreams> };
function runtime(): Runtime {
  const root = globalThis as typeof globalThis & { [KEY]?: Runtime };
  return root[KEY] ??= { pending: null, children: new Set() };
}
export function geminiPending() { return runtime().pending; }

/** Resolve the installed official package without executing a shell or downloading software. */
export function geminiExecutable(): string | null {
  for (const base of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidates = [path.join(base, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js")];
    const bin = path.join(base, "gemini");
    if (fs.existsSync(bin)) { try { candidates.push(fs.realpathSync(bin)); } catch { /* inaccessible */ } }
    for (const candidate of candidates) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(candidate), "..", "package.json"), "utf8"));
        const [major, minor] = String(pkg.version).split(".").map(Number);
        if (pkg.name === "@google/gemini-cli" && (major > 0 || minor >= 36) && fs.existsSync(candidate)) return candidate;
      } catch { /* Not a supported official CLI installation. */ }
    }
  }
  return null;
}

function profileHome(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid Gemini connection");
  return path.join(aiDirectory(), `gemini-${id}`);
}

export function geminiEnvironment(home: string, signingIn: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const name of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  // All state and settings belong to Thesis. Inherited API/Vertex/gateway keys,
  // NODE_OPTIONS, hooks, proxies and project .env files are not carried across.
  Object.assign(env, { HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: home,
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(home, "settings.json"),
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(home, "settings.json"),
    GEMINI_SYSTEM_MD: path.join(home, "system.md"),
    GEMINI_TELEMETRY_ENABLED: "false", GOOGLE_GENAI_USE_GCA: "true",
    GEMINI_CLI_TRUST_WORKSPACE: "true" });
  if (process.platform === "win32") Object.assign(env, { APPDATA: home, LOCALAPPDATA: home });
  const chrome = chromeExecutable();
  if (chrome) env.BROWSER = chrome;
  if (!signingIn) env.NO_BROWSER = "1";
  return env;
}

function prepareHome(id: string): string {
  const home = profileHome(id);
  for (const dir of [home, path.join(home, ".gemini"), path.join(home, ".gemini", "policies"), path.join(home, "work")]) ensurePrivateDirectory(dir);
  const settings = {
    security: { auth: { selectedType: "oauth-personal", enforcedType: "oauth-personal" }, enableConseca: false },
    tools: { core: ["__thesis_no_tools__"], allowed: [] },
    mcp: { enabled: false }, mcpServers: {}, extensions: { enabled: false },
    hooksConfig: { enabled: false }, telemetry: { enabled: false },
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
    context: { fileName: "THESIS_NO_CONTEXT.md", includeDirectoryTree: false, includeDirectories: [] },
    model: { maxSessionTurns: 1 }, useWriteTodos: false,
  };
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".gemini", "policies", "thesis.toml"), '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, "system.md"), "You are a financial research analyst. Follow the supplied research rules and return only the requested JSON. Use only the supplied evidence. Do not use tools, local files, shell commands, external agents or memory. Never invent a source or a missing financial value.\n", { mode: 0o600 });
  return home;
}

function launch(id: string, args: string[], signingIn: boolean): ChildProcessWithoutNullStreams {
  const executable = geminiExecutable();
  if (!executable) throw new Error("Install the official Gemini CLI version 0.36 or newer, then restart Thesis.");
  const home = prepareHome(id);
  const child = spawn(process.execPath, [executable, ...args], { cwd: path.join(home, "work"), env: geminiEnvironment(home, signingIn), windowsHide: true, shell: false, stdio: "pipe" });
  runtime().children.add(child);
  child.once("close", () => runtime().children.delete(child));
  child.stderr.resume(); // Never publish CLI diagnostics that might contain account details.
  return child;
}

export async function beginGemini(): Promise<void> {
  if (runtime().pending?.status === "waiting") throw new Error("Gemini sign-in is already waiting in Chrome");
  if (!chromeExecutable()) throw new Error("Install Chrome to connect Gemini from Thesis.");
  const profile = await withAiStore((store) => store.gemini ??= { id: randomUUID(), connected: false });
  const child = launch(profile.id, ["--acp"], true);
  const pending = { status: "waiting" as "waiting" | "connected" | "error", message: "Complete Google sign-in in Chrome." };
  runtime().pending = pending;
  let buffer = "";
  const timer = setTimeout(() => child.kill(), 5 * 60_000); timer.unref();
  const fail = () => { if (pending.status === "waiting") { pending.status = "error"; pending.message = "Gemini sign-in did not complete. Check the CLI installation and try again."; } };
  child.on("error", fail);
  child.on("close", () => { clearTimeout(timer); fail(); });
  const send = (id: number, method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  child.stdout.on("data", (data: Buffer) => {
    buffer += data.toString("utf8");
    if (buffer.length > 2_000_000) { child.kill(); return; }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message: { id?: number; error?: unknown; result?: { authMethods?: { id: string }[] } };
      try { message = JSON.parse(line); } catch { continue; }
      if (message.error) { child.kill(); return; }
      if (message.id === 1) {
        if (!message.result?.authMethods?.some((m) => m.id === "oauth-personal")) { child.kill(); return; }
        send(2, "authenticate", { methodId: "oauth-personal" });
      } else if (message.id === 2) {
        void withAiStore((store) => {
          if (pending.status !== "waiting" || store.gemini?.id !== profile.id) return;
          store.gemini.connected = true;
          pending.status = "connected"; pending.message = "Gemini connected through Google's CLI. Select it for reports below.";
        }).catch(fail).finally(() => child.kill());
      }
    }
  });
  send(1, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "thesis", version: "0.1.0" } });
}

export async function runGemini(id: string, model: string, prompt: string, signal?: AbortSignal): Promise<{ text: string; model: string; input: number; output: number }> {
  const profile = readAiStore()?.gemini;
  if (profile?.id !== id || !profile.connected) throw new Error("Gemini connection is signed out");
  signal?.throwIfAborted();
  const args = ["--output-format", "json", "-p", "Answer the research request from standard input. Return only the requested JSON."];
  if (model !== "auto") args.push("--model", model);
  const child = launch(id, args, false);
  return new Promise((resolve, reject) => {
    let output = "";
    const abort = () => { child.kill(); reject(new Error("Gemini request canceled")); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    const timer = setTimeout(abort, 180_000); timer.unref();
    child.stdout.on("data", (data: Buffer) => { output += data.toString("utf8"); if (output.length > 4_000_000) abort(); });
    child.on("error", () => reject(new Error("Gemini CLI could not start")));
    child.on("close", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      try {
        if (code !== 0) throw new Error();
        const data = JSON.parse(output);
        if (data.error || typeof data.response !== "string" || !data.response.trim()) throw new Error();
        const entries = Object.entries(data.stats?.models ?? {}) as [string, { tokens?: { input?: number; candidates?: number } }][];
        const tokens = entries.reduce((sum, [, entry]) => ({ input: sum.input + (entry.tokens?.input ?? 0), output: sum.output + (entry.tokens?.candidates ?? 0) }), { input: 0, output: 0 });
        resolve({ text: data.response, model: entries.at(-1)?.[0] ?? model, ...tokens });
      } catch { reject(new Error("Gemini could not complete this pass. Check your connection or Google usage allowance. No paid fallback was attempted.")); }
    });
    child.stdin.end(prompt);
  });
}

export async function disconnectGemini(): Promise<string> {
  if (runtime().pending?.status === "waiting") runtime().pending!.status = "error";
  for (const child of runtime().children) child.kill();
  await withAiStore((store) => {
    if (store.gemini) {
      const home = path.resolve(profileHome(store.gemini.id));
      const parent = path.resolve(aiDirectory());
      if (path.dirname(home) !== parent || !path.basename(home).startsWith("gemini-")) throw new Error("Invalid Gemini credential directory");
      fs.rmSync(home, { recursive: true, force: true });
      store.gemini = null;
    }
    if (store.selection.provider === "gemini") store.selection = { provider: "none" };
  });
  return "Disconnected locally. Manage the Google CLI authorization in your Google Account connections.";
}
