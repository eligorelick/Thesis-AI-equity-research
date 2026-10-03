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
