import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ view: vi.fn(() => ({ selection: { provider: "none" }, connections: [] })), select: vi.fn() }));
vi.mock("@/ai/connections", () => ({ connectionsView: fake.view, selectConnection: fake.select }));
vi.mock("@/ai/chatgpt", () => ({ beginChatGpt: vi.fn(), disconnectChatGpt: vi.fn() }));
vi.mock("@/ai/gemini", () => ({ beginGemini: vi.fn(), disconnectGemini: vi.fn() }));
vi.mock("@/ai/transport", () => ({ listChatGptModels: vi.fn() }));
vi.mock("@/app/api/sameOrigin", async (original) => {
  const actual = await original<typeof import("@/app/api/sameOrigin")>();
  return { ...actual, assertSameOrigin: vi.fn(actual.assertSameOrigin) };
});
import { GET, POST } from "@/app/api/ai/connections/route";
import { assertSameOrigin } from "@/app/api/sameOrigin";
import { beginChatGpt, disconnectChatGpt } from "@/ai/chatgpt";
import { beginGemini, disconnectGemini } from "@/ai/gemini";
import { listChatGptModels } from "@/ai/transport";
beforeEach(() => { vi.clearAllMocks(); fake.view.mockImplementation(() => ({ selection: { provider: "none" }, connections: [] })); });
function request(body: unknown) {
  return new Request("http://127.0.0.1:3000/api/ai/connections", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
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
  it("rejects LAN access even if the general origin guard allows that host", async () => {
    vi.mocked(assertSameOrigin).mockReturnValueOnce(null);
    expect((await GET(new Request("http://lan.test/api/ai/connections", { headers: { host: "lan.test" } }))).status).toBe(403);
    vi.mocked(assertSameOrigin).mockReturnValueOnce(null);
    expect((await GET(new Request("http://127.0.0.1/api/ai/connections"))).status).toBe(403);
    expect(fake.view).not.toHaveBeenCalled();
  });
  it("sanitizes corrupt storage, malformed input and unexpected internal errors", async () => {
    fake.view.mockImplementationOnce(() => { throw new Error("private token"); });
    const response = await GET(request({})); expect(response.status).toBe(500); expect(await response.text()).not.toContain("private token");
    expect((await POST(request("x".repeat(8193)))).status).toBe(413);
    expect((await POST(request("not-json"))).status).toBe(400);
    expect((await POST(request({ action: "unknown" }))).status).toBe(400);
    fake.select.mockRejectedValueOnce(new Error("private-token"));
    expect(await (await POST(request({ action: "select", selection: {} }))).text()).not.toContain("private-token");
    fake.select.mockRejectedValueOnce(new Error("Choose a model"));
    expect(await (await POST(request({ action: "select", selection: {} }))).text()).toContain("Choose a model");
  });
  it("routes each explicit action and rejects malformed account identifiers", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    for (const action of ["connect-chatgpt", "disconnect-chatgpt", "models"]) {
      expect((await POST(request({ action, id: "bad" }))).status).toBe(400);
    }
    vi.mocked(disconnectChatGpt).mockResolvedValueOnce("Disconnected");
    vi.mocked(disconnectGemini).mockResolvedValueOnce("Disconnected locally");
    vi.mocked(listChatGptModels).mockResolvedValueOnce([{ id: "m", name: "Model" }]);
    for (const action of ["connect-chatgpt", "connect-gemini", "disconnect-chatgpt", "disconnect-gemini", "select"]) {
      expect((await POST(request({ action, id, selection: { provider: "none" } }))).status).toBe(200);
    }
    expect(beginChatGpt).toHaveBeenCalledWith(id); expect(beginGemini).toHaveBeenCalled();
    expect(disconnectChatGpt).toHaveBeenCalledWith(id); expect(disconnectGemini).toHaveBeenCalled();
    expect(await (await POST(request({ action: "models", id }))).json()).toEqual({ models: [{ id: "m", name: "Model" }] });
    expect((await POST(request({ action: "connect-chatgpt" }))).status).toBe(200);
  });
});
