import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aiDirectory, claimAiRuntime, readAiStore, withAiStore, type AiStore } from "@/ai/store";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "thesis-ai-store-"));
beforeAll(() => { vi.stubEnv("LOCALAPPDATA", directory); vi.stubEnv("XDG_CONFIG_HOME", directory); });
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

// macOS uses a fixed OS support directory; this fixture never redirects or
// touches a real account there. Both supported CI hosts exercise their store.
describe.skipIf(process.platform === "darwin")("protected connection storage", () => {
  it("retains one host identity and serializes concurrent account updates", async () => {
    const host = await withAiStore((store) => store.hostId);
    await Promise.all([1, 2].map((n) => withAiStore(async (store) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      store.profiles.push({ id: `test-${n}`, clientId: `oaiapp_test${n}` });
    })));
    expect(readAiStore()?.hostId).toBe(host);
    expect(readAiStore()?.profiles).toHaveLength(2);
    expect(fs.existsSync(path.join(aiDirectory(), "connections.lock"))).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(aiDirectory()).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(aiDirectory(), "connections.v1.json")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(aiDirectory(), "connections.lock")).mode & 0o777).toBe(0o600);
    }
  }, 60_000);
  it("does not overwrite an unreadable credential file with an empty account list", async () => {
    await withAiStore(() => {});
    const file = path.join(aiDirectory(), "connections.v1.json");
    const saved = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, "corrupt-data");
    await expect(withAiStore(() => {})).rejects.toThrow("credentials were not replaced");
    expect(fs.readFileSync(file, "utf8")).toBe("corrupt-data");
    fs.writeFileSync(file, saved);
  }, 60_000);
  it("refuses a second live server but lets a new server recover a stopped owner", () => {
    const store = { runtimeOwnerPid: process.pid + 1 } as AiStore;
    const probe = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      expect(() => claimAiRuntime(store)).toThrow("another Thesis server");
      probe.mockImplementation(() => { throw Object.assign(new Error("stopped"), { code: "ESRCH" }); });
      claimAiRuntime(store); expect(store.runtimeOwnerPid).toBe(process.pid);
    } finally { probe.mockRestore(); }
  });
});
