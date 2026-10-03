import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ view: vi.fn(() => ({ selection: { provider: "none" }, connections: [] })), select: vi.fn() }));
vi.mock("@/ai/connections", () => ({ connectionsView: fake.view, selectConnection: fake.select }));
vi.mock("@/ai/chatgpt", () => ({ beginChatGpt: vi.fn(), disconnectChatGpt: vi.fn() }));
vi.mock("@/ai/gemini", () => ({ beginGemini: vi.fn(), disconnectGemini: vi.fn() }));
vi.mock("@/ai/transport", () => ({ listChatGptModels: vi.fn() }));
import { GET, POST } from "@/app/api/ai/connections/route";
beforeEach(() => vi.clearAllMocks());
describe("local connection API", () => {
  it("rejects cross-site reads and writes before accessing account storage", async () => {
    const headers = { host: "127.0.0.1:3000", origin: "https://attacker.example", "sec-fetch-site": "cross-site" };
    expect((await GET(new Request("http://127.0.0.1:3000/api/ai/connections", { headers }))).status).toBe(403);
    expect((await POST(new Request("http://127.0.0.1:3000/api/ai/connections", { method: "POST", headers, body: '{"action":"select","selection":{"provider":"anthropic"}}' }))).status).toBe(403);
    expect(fake.view).not.toHaveBeenCalled(); expect(fake.select).not.toHaveBeenCalled();
  });
  it("returns sanitized status to the local UI without initiating inference", async () => {
    const response = await GET(new Request("http://127.0.0.1:3000/api/ai/connections", { headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ selection: { provider: "none" }, connections: [] });
    expect(fake.select).not.toHaveBeenCalled();
  });
});
