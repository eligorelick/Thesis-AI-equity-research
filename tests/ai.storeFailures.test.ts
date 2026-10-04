import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ protect: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: (...args: unknown[]) => fake.protect(...args) }));
import { aiDirectory, ensurePrivateDirectory, readAiStore, withAiStore } from "@/ai/store";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "thesis-store-failures-"));
let directory: string;
function system(value: string) { Object.defineProperty(process, "platform", { value, configurable: true }); }
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(root, "case-"));
  system("linux"); vi.stubEnv("LOCALAPPDATA", directory); vi.stubEnv("XDG_CONFIG_HOME", directory);
  fake.protect.mockReset().mockImplementation((_exe, _args, options) => options.input);
});
afterEach(() => { vi.useRealTimers(); Object.defineProperty(process, "platform", platform); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
describe("credential protection and lock failures", () => {
  const validStore = () => ({
    version: 1, hostId: "urn:uuid:fixture", profiles: [], gemini: null,
    selection: { provider: "none" },
  });
  it.each([
    ["selection absent", { selection: undefined }],
    ["selection null", { selection: null }],
    ["unknown provider", { selection: { provider: "unknown" } }],
    ["subscription model absent", { selection: { provider: "chatgpt", connectionId: "test" } }],
    ["invalid effort", { selection: { provider: "chatgpt", connectionId: "test", model: "historical-model", effort: "surprise" } }],
    ["null profile", { profiles: [null] }],
    ["registration missing client", { profiles: [{ id: "test" }] }],
    ["token scopes not an array", { profiles: [{ id: "test", clientId: "oaiapp_test", tokens: { access: "a", refresh: "r", id: "i", expiresAt: 1, scopes: "chatgpt.tokens.use.direct" } }] }],
    ["nonstring scope", { profiles: [{ id: "test", clientId: "oaiapp_test", tokens: { access: "a", refresh: "r", id: "i", expiresAt: 1, scopes: [42] } }] }],
    ["missing renewable token", { profiles: [{ id: "test", clientId: "oaiapp_test", tokens: { access: "a", id: "i", expiresAt: 1, scopes: [] } }] }],
    ["nonnumeric token expiry", { profiles: [{ id: "test", clientId: "oaiapp_test", tokens: { access: "a", refresh: "r", id: "i", expiresAt: "later", scopes: [] } }] }],
    ["Gemini boolean replaced", { gemini: { id: "test", connected: "false" } }],
    ["invalid runtime PID", { runtimeOwnerPid: -1 }],
  ])("refuses malformed valid JSON (%s) before any mutation or credential replacement", async (_label, fields) => {
    ensurePrivateDirectory(aiDirectory());
    const file = path.join(aiDirectory(), "connections.v1.json");
    const saved = JSON.stringify({ protection: "owner-only", data: JSON.stringify({ ...validStore(), ...fields }) });
    fs.writeFileSync(file, saved);
    const mutate = vi.fn(() => {});
    await expect(withAiStore(mutate)).rejects.toThrow("credentials were not replaced");
    expect(mutate).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(saved);
    expect(fs.existsSync(path.join(aiDirectory(), "connections.lock"))).toBe(false);
  });

  it.each(["linux", "win32"])("retains valid v1 registrations, signed-out selection and unknown metadata on %s", async (host) => {
    system(host);
    ensurePrivateDirectory(aiDirectory());
    const file = path.join(aiDirectory(), "connections.v1.json");
    const saved = { ...validStore(),
      profiles: [
        { id: "signed-out", clientId: "oaiapp_saved", originalHint: "retained" },
        { id: "connected", clientId: "oaiapp_other", tokens: { access: "test-access", refresh: "test-refresh", id: "test-id", expiresAt: 1, scopes: [] } },
      ],
      gemini: { id: "google", connected: false },
      selection: { provider: "chatgpt", connectionId: "signed-out", model: "historical-model", effort: "high", serviceTier: "fast" },
      extraMetadata: { keep: true },
    };
    const data = JSON.stringify(saved);
    fs.writeFileSync(file, JSON.stringify(host === "win32"
      ? { protection: "windows-dpapi", data: Buffer.from(data).toString("base64") }
      : { protection: "owner-only", data }));
    expect(readAiStore()).toEqual(saved);
    await withAiStore(() => {});
    expect(readAiStore()).toEqual(saved);
  });

  it("preserves malformed Windows-protected JSON without calling a mutation or protecting a replacement", async () => {
    system("win32");
    ensurePrivateDirectory(aiDirectory());
    const file = path.join(aiDirectory(), "connections.v1.json");
    const saved = JSON.stringify({ protection: "windows-dpapi", data: Buffer.from(JSON.stringify({ ...validStore(), profiles: [null] })).toString("base64") });
    fs.writeFileSync(file, saved);
    const mutate = vi.fn(() => {});
    await expect(withAiStore(mutate)).rejects.toThrow("credentials were not replaced");
    expect(mutate).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(saved);
    expect(fake.protect).toHaveBeenCalledTimes(1);
    expect(fake.protect.mock.calls[0][1].join(" ")).toContain("Unprotect");
    expect(fs.existsSync(path.join(aiDirectory(), "connections.lock"))).toBe(false);
  });

  it.each(["write", "close"])("cleans its acquired lock when the PID %s fails", async (operation) => {
    const originalWrite = fs.writeFileSync;
    const originalClose = fs.closeSync;
    let ownedFd: number | undefined;
    let failed = false;
    const failure = Object.assign(new Error("lock I/O failed"), { code: "EIO" });
    vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === "number" && args[1] === String(process.pid)) {
        ownedFd = args[0];
        if (operation === "write" && !failed) { failed = true; throw failure; }
      }
      return originalWrite(...args);
    });
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      if (operation === "close" && fd === ownedFd && !failed) { failed = true; throw failure; }
      return originalClose(fd);
    });
    try {
      const mutate = vi.fn(() => {});
      await expect(withAiStore(mutate)).rejects.toBe(failure);
      expect(mutate).not.toHaveBeenCalled();
      expect(() => fs.fstatSync(ownedFd!)).toThrow();
      expect(fs.existsSync(path.join(aiDirectory(), "connections.lock"))).toBe(false);
      await expect(withAiStore(() => "retry")).resolves.toBe("retry");
    } finally {
      if (ownedFd !== undefined) { try { originalClose(ownedFd); } catch { /* already closed */ } }
    }
  });

  it("preserves a lock write failure when removing the owned partial lock also fails", async () => {
    const originalWrite = fs.writeFileSync;
    const originalRemove = fs.rmSync;
    const lock = path.join(aiDirectory(), "connections.lock");
    let ownedFd: number | undefined;
    const failure = Object.assign(new Error("lock write failed"), { code: "EIO" });
    vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === "number" && args[1] === String(process.pid)) { ownedFd = args[0]; throw failure; }
      return originalWrite(...args);
    });
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (target === lock) throw Object.assign(new Error("cleanup denied"), { code: "EPERM" });
      return originalRemove(target, options);
    });
    try {
      const mutate = vi.fn(() => {});
      await expect(withAiStore(mutate)).rejects.toBe(failure);
      expect(mutate).not.toHaveBeenCalled();
      expect(() => fs.fstatSync(ownedFd!)).toThrow();
      expect(fs.existsSync(lock)).toBe(true);
    } finally { originalRemove(lock, { force: true }); }
  });

  it("uses OS locations independently of report database overrides", () => {
    vi.stubEnv("THESIS_DATA_DIR", "report-only");
    expect(aiDirectory()).toBe(path.join(directory, "Thesis", "ai"));
    vi.stubEnv("XDG_CONFIG_HOME", undefined); expect(aiDirectory()).toBe(path.join(os.homedir(), ".config", "Thesis", "ai"));
    system("darwin"); expect(aiDirectory()).toBe(path.join(os.homedir(), "Library", "Application Support", "Thesis", "ai"));
    system("win32"); vi.stubEnv("LOCALAPPDATA", undefined); expect(aiDirectory()).toBe(path.join(os.homedir(), "AppData", "Local", "Thesis", "ai"));
  });
  it("pipes Windows protection over stdin and keeps unreadable credentials intact", async () => {
    system("win32");
    const host = await withAiStore((store) => store.hostId);
    const call = fake.protect.mock.calls[0];
    expect(call[0]).toBe("powershell.exe"); expect(call[2].windowsHide).toBe(true);
    expect(call[1].join(" ")).not.toContain(host);
    expect(readAiStore()?.hostId).toBe(host);
    const file = path.join(aiDirectory(), "connections.v1.json"); const saved = fs.readFileSync(file, "utf8");
    fake.protect.mockImplementation(() => { throw new Error("OS key unavailable"); });
    expect(() => readAiStore()).toThrow("credentials were not replaced");
    expect(fs.readFileSync(file, "utf8")).toBe(saved);
  });
  it("removes a stale dead-owner lock and always unlocks failed mutations", async () => {
    ensurePrivateDirectory(aiDirectory()); const lock = path.join(aiDirectory(), "connections.lock");
    fs.writeFileSync(lock, "12345");
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });
    await withAiStore(() => {}); expect(fs.existsSync(lock)).toBe(false);
    await expect(withAiStore(() => { throw new Error("mutation failed"); })).rejects.toThrow("mutation failed");
    expect(fs.existsSync(lock)).toBe(false);
  });
  it("reports a Windows startup timeout without persisting partial credentials", async () => {
    system("win32");
    fake.protect.mockImplementation(() => { throw Object.assign(new Error("private diagnostic"), { code: "ETIMEDOUT" }); });
    await expect(withAiStore(() => {})).rejects.toThrow("Windows protection timed out");
    expect(fs.existsSync(path.join(aiDirectory(), "connections.v1.json"))).toBe(false);
    expect(fs.existsSync(path.join(aiDirectory(), "connections.lock"))).toBe(false);
  });
  it("times out behind a live writer instead of overwriting its lock", async () => {
    ensurePrivateDirectory(aiDirectory()); const lock = path.join(aiDirectory(), "connections.lock");
    fs.writeFileSync(lock, String(process.pid));
    vi.useFakeTimers();
    const result = expect(withAiStore(() => {})).rejects.toThrow("busy");
    await vi.advanceTimersByTimeAsync(40_200); await result;
    expect(fs.readFileSync(lock, "utf8")).toBe(String(process.pid));
  });
  it.each([
    { protection: "unsupported", data: "{}" },
    { protection: "owner-only", data: "broken" },
    { protection: "owner-only", data: JSON.stringify({ version: 2, hostId: "urn:uuid:x", profiles: [] }) },
    { protection: "owner-only", data: JSON.stringify({ version: 1, hostId: "wrong", profiles: [] }) },
    { protection: "owner-only", data: JSON.stringify({ version: 1, hostId: "urn:uuid:x", profiles: {} }) },
  ])("refuses an invalid store envelope %j", (envelope) => {
    ensurePrivateDirectory(aiDirectory()); fs.writeFileSync(path.join(aiDirectory(), "connections.v1.json"), JSON.stringify(envelope));
    expect(() => readAiStore()).toThrow("credentials were not replaced");
  });
});
