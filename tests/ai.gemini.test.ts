import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AiStore } from "@/ai/store";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ directory: "", store: null as AiStore | null, queue: Promise.resolve() as Promise<unknown>, spawn: vi.fn(), autoClose: true, chrome: true }));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => fake.spawn(...args) }));
vi.mock("@/ai/browser", () => ({ chromeExecutable: () => fake.chrome ? "fixture-chrome" : null }));
vi.mock("@/ai/store", () => ({
  aiDirectory: () => fake.directory,
  claimAiRuntime: () => {},
  ensurePrivateDirectory: (directory: string) => fs.mkdirSync(directory, { recursive: true }),
  withAiStore: <T>(fn: (store: AiStore) => Promise<T> | T): Promise<T> => {
    const result = fake.queue.then(() => fn(fake.store!)); fake.queue = result.catch(() => {}); return result;
  },
}));
import { beginGemini, disconnectGemini, geminiEnvironment, geminiPending, runGemini, geminiExecutable, prepareGeminiHome, stopGeminiChild } from "@/ai/gemini";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "thesis-gemini-lifecycle-"));
const bin = path.join(root, "bin");
const packageDir = path.join(bin, "node_modules", "@google", "gemini-cli");
fs.mkdirSync(path.join(packageDir, "bundle"), { recursive: true });
fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@google/gemini-cli", version: "0.36.0" }));
fs.writeFileSync(path.join(packageDir, "bundle", "gemini.js"), "// Offline fixture; never executed.\n");
let child: ChildProcessWithoutNullStreams;
function closed() { Object.assign(child, { signalCode: "SIGKILL" }); child.emit("close", null, "SIGKILL"); }
beforeEach(() => {
  fake.directory = path.join(root, "owned");
  fake.store = { version: 1, hostId: "urn:uuid:fixture", profiles: [], gemini: null, selection: { provider: "none" } };
  fake.queue = Promise.resolve(); fake.autoClose = true; fake.chrome = true;
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@google/gemini-cli", version: "0.36.0" }));
  vi.stubEnv("PATH", bin);
  fake.spawn.mockReset().mockImplementation(() => {
    child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null,
      kill: vi.fn(() => { if (fake.autoClose) queueMicrotask(closed); return true; }),
    }) as unknown as ChildProcessWithoutNullStreams;
    return child;
  });
});
afterEach(async () => { fake.autoClose = true; vi.useRealTimers(); await disconnectGemini(); vi.unstubAllEnvs(); });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("Gemini lifecycle without authentication or inference", () => {
  it("publishes pending before the store lock and never launches after disconnect", async () => {
    let unlock!: () => void;
    fake.queue = new Promise<void>((resolve) => { unlock = resolve; });
    const start = beginGemini(); const rejected = expect(start).rejects.toThrow("canceled");
    const disconnect = disconnectGemini(); unlock();
    await rejected; await disconnect;
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(geminiPending()?.status).toBe("error");
  });
  it("allows only one pending authentication even while the store is busy", async () => {
    let unlock!: () => void;
    fake.queue = new Promise<void>((resolve) => { unlock = resolve; });
    const start = beginGemini();
    await expect(beginGemini()).rejects.toThrow("already waiting");
    unlock(); await start;
    expect(fake.spawn).toHaveBeenCalledTimes(1);
  });
  it("waits for actual process exit before deleting its connection directory", async () => {
    await beginGemini();
    const home = path.join(fake.directory, `gemini-${fake.store!.gemini!.id}`);
    fake.autoClose = false;
    let finished = false;
    const disconnect = disconnectGemini().then(() => { finished = true; });
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGKILL"));
    expect(finished).toBe(false); expect(fs.existsSync(home)).toBe(true);
    closed(); await disconnect;
    expect(fs.existsSync(home)).toBe(false); expect(fake.store!.gemini).toBeNull();
  });
  it("blocks inherited env discovery and supplies effective post-admin capability allowlists", async () => {
    fs.mkdirSync(fake.directory, { recursive: true });
    fs.writeFileSync(path.join(fake.directory, ".env"), "GOOGLE_CLOUD_ACCESS_TOKEN=ancestor-secret\nHTTPS_PROXY=ancestor-proxy\n");
    await beginGemini();
    const [, args, options] = fake.spawn.mock.calls[0] as [string, string[], { cwd: string; env: NodeJS.ProcessEnv }];
    // CLI 0.36 findEnvFile checks cwd/.gemini/.env, then cwd/.env before ancestors.
    expect(fs.existsSync(path.join(options.cwd, ".gemini", ".env"))).toBe(false);
    expect(fs.readFileSync(path.join(options.cwd, ".env"), "utf8")).toBe("");
    expect(options.env.GOOGLE_CLOUD_ACCESS_TOKEN).toBeUndefined();
    expect(options.env.GEMINI_CLI_NO_RELAUNCH).toBe("true");
    const allowed = args[args.indexOf("--allowed-mcp-server-names") + 1];
    expect(allowed).toMatch(/^thesis-disabled-[0-9a-f-]{36}$/);
    expect(args[args.indexOf("--extensions") + 1]).toBe("none");
    const settings = JSON.parse(fs.readFileSync(options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, "utf8"));
    expect(settings.skills.enabled).toBe(false);
    expect(settings.experimental.enableAgents).toBe(false);
    expect(new RegExp(settings.security.allowedExtensions[0]).test("any-extension")).toBe(false);
    expect(settings.tools.core).toEqual(["__thesis_no_tools__"]);
  });
  it("keeps browser profile locations while separating CLI storage", () => {
    vi.stubEnv("HOME", "browser-home"); vi.stubEnv("LOCALAPPDATA", "browser-local");
    const env = geminiEnvironment("thesis-only", true);
    expect(env.HOME).toBe("browser-home"); expect(env.LOCALAPPDATA).toBe("browser-local");
    expect(env.GEMINI_CLI_HOME).toBe("thesis-only");
  });
  it("does not finish cancellation until its inference process has exited", async () => {
    fake.store!.gemini = { id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", connected: true };
    const controller = new AbortController();
    const run = runGemini(fake.store!.gemini.id, "auto", "synthetic evidence", controller.signal);
    const rejected = expect(run).rejects.toThrow();
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled());
    fake.autoClose = false; controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    closed(); await rejected;
  });
  it("requires a supported official CLI and a browser before starting authentication", async () => {
    fake.chrome = false; await expect(beginGemini()).rejects.toThrow("Chrome");
    expect(geminiEnvironment("isolated", true).BROWSER).toBeUndefined(); fake.chrome = true;
    for (const version of ["0.35.0", "0.37.0", "1.0.0"]) {
      fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@google/gemini-cli", version }));
      expect(geminiExecutable()).toBeNull();
    }
    await expect(beginGemini()).rejects.toThrow("0.36.x");
    fs.writeFileSync(path.join(packageDir, "package.json"), "malformed"); expect(geminiExecutable()).toBeNull();
    vi.stubEnv("PATH", undefined); expect(geminiExecutable()).toBeNull();
    expect(() => prepareGeminiHome("../not-an-account")).toThrow("Invalid");
    expect(fake.spawn).not.toHaveBeenCalled();
  });
  it("resolves an installed CLI path and handles a process launch error", async () => {
    fs.writeFileSync(path.join(bin, "gemini"), "fixture-link-target");
    expect(geminiExecutable()).toBe(path.join(packageDir, "bundle", "gemini.js"));
    fake.spawn.mockImplementationOnce(() => { throw new Error("cannot start"); });
    await expect(beginGemini()).rejects.toThrow("cannot start"); expect(geminiPending()?.status).toBe("error");
  });
  it("negotiates only Google OAuth and records connection after authentication", async () => {
    await beginGemini(); const requests: string[] = []; child.stdin.on("data", (data) => requests.push(data.toString()));
    child.stdout.emit("data", Buffer.from('not-json\n{"id":1,"result":{"authMethods":[{"id":"oauth-personal"}]}}\n'));
    await vi.waitFor(() => expect(requests.join("")).toContain('"authenticate"'));
    expect(requests.join("")).toContain('"oauth-personal"');
    child.stdout.emit("data", Buffer.from('{"id":2,"result":{}}\n'));
    await vi.waitFor(() => expect(geminiPending()?.status).toBe("connected"));
    expect(fake.store!.gemini?.connected).toBe(true); expect(fake.store!.selection).toEqual({ provider: "none" });
    await vi.waitFor(() => expect(child.signalCode).toBe("SIGKILL"));
    await stopGeminiChild(child);
  });
  it.each(['{"error":{"message":"failed"}}\n', '{"id":1,"result":{}}\n', "x".repeat(2_000_001)])("stops unusable ACP output %#", async (output) => {
    await beginGemini(); child.stdout.emit("data", Buffer.from(output));
    await vi.waitFor(() => expect(geminiPending()?.status).toBe("error"));
    expect(fake.store!.gemini?.connected).toBe(false);
  });
  it("does not restore connection state when disconnect races an auth response", async () => {
    await beginGemini();
    let unlock!: () => void; fake.queue = new Promise<void>((resolve) => { unlock = resolve; });
    child.stdout.emit("data", Buffer.from('{"id":2,"result":{}}\n'));
    const disconnect = disconnectGemini(); unlock(); await disconnect;
    expect(fake.store!.gemini).toBeNull();
  });
  it.each([
    { response: "{}", stats: { models: { first: { tokens: { input: 3, candidates: 1 } }, second: { tokens: { input: 5, candidates: 2 } } } } },
    { response: "{}", stats: { models: { first: {} } } },
    { response: "{}" },
  ])("reads completed CLI JSON and combines usage %#", async (output) => {
    fake.store!.gemini = { id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", connected: true };
    const result = runGemini(fake.store!.gemini.id, "example-model", "evidence");
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled());
    expect(fake.spawn.mock.calls[0][1]).toContain("--model");
    child.stdout.emit("data", Buffer.from(JSON.stringify(output))); Object.assign(child, { exitCode: 0 }); child.emit("close", 0);
    const value = await result; expect(value.text).toBe("{}");
    if ("stats" in output && output.stats?.models && "second" in output.stats.models) expect(value).toEqual({ text: "{}", model: "second", input: 8, output: 3 });
  });
  it.each(["invalid-json", '{"error":"quota"}', '{"response":""}', '{"response":2}'])("rejects failed CLI results %s", async (output) => {
    fake.store!.gemini = { id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", connected: true };
    const result = runGemini(fake.store!.gemini.id, "auto", "evidence"); const rejected = expect(result).rejects.toThrow("could not complete");
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from(output)); Object.assign(child, { exitCode: 0 }); child.emit("close", 0); await rejected;
  });
  it("refuses signed-out accounts and survives asynchronous process errors", async () => {
    await expect(runGemini("missing", "auto", "evidence")).rejects.toThrow("signed out");
    fake.store!.gemini = { id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", connected: true };
    const result = runGemini(fake.store!.gemini.id, "auto", "evidence"); const rejected = expect(result).rejects.toThrow("could not start");
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled()); child.emit("error", new Error("spawn failed")); closed(); await rejected;
  });
  it("retains credentials and reports a bounded error when a child will not exit", async () => {
    await beginGemini(); fake.autoClose = false; vi.useFakeTimers();
    const result = expect(stopGeminiChild(child)).rejects.toThrow("files were retained");
    await vi.advanceTimersByTimeAsync(10_000); await result;
    expect(fake.store!.gemini).not.toBeNull(); closed();
  });
  it("terminates authentication on its deadline", async () => {
    vi.useFakeTimers(); await beginGemini();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
