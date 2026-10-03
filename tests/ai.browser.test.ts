import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ event: "spawn", spawn: vi.fn(), unref: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => fake.spawn(...args) }));
import { chromeExecutable, openChrome } from "@/ai/browser";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
function system(value: string) { Object.defineProperty(process, "platform", { value, configurable: true }); }
beforeEach(() => {
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
  fake.event = "spawn";
  fake.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: fake.unref });
    queueMicrotask(() => child.emit(fake.event)); return child;
  });
});
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("normal Chrome launch", () => {
  it("finds the per-user Windows install and falls back when absent", async () => {
    system("win32"); vi.stubEnv("PROGRAMFILES", ""); vi.stubEnv("PROGRAMFILES(X86)", "missing"); vi.stubEnv("LOCALAPPDATA", "user-apps");
    const executable = path.join("user-apps", "Google", "Chrome", "Application", "chrome.exe");
    vi.mocked(fs.existsSync).mockImplementation((file) => file === executable);
    expect(chromeExecutable()).toBe(executable);
    expect(await openChrome("https://auth.example.test/")).toBe(true);
    expect(fake.spawn).toHaveBeenCalledWith(executable, ["https://auth.example.test/"], expect.objectContaining({ shell: false, detached: true }));
    expect(fake.unref).toHaveBeenCalled();
    vi.mocked(fs.existsSync).mockReturnValue(false); expect(await openChrome("https://auth.example.test/")).toBe(false);
  });
  it("finds Linux Chrome variants without starting a shell", () => {
    system("linux"); vi.stubEnv("PATH", ["first", "second"].join(path.delimiter));
    vi.mocked(fs.existsSync).mockImplementation((file) => file === path.join("second", "chromium-browser"));
    expect(chromeExecutable()).toBe(path.join("second", "chromium-browser"));
    vi.stubEnv("PATH", undefined); vi.mocked(fs.existsSync).mockReturnValue(false); expect(chromeExecutable()).toBeNull();
  });
  it("uses the normal macOS app and reports a failed launch as a fallback link", async () => {
    system("darwin"); fake.event = "error";
    expect(chromeExecutable()).toContain("Google Chrome.app");
    expect(await openChrome("https://auth.example.test/")).toBe(false);
  });
});
