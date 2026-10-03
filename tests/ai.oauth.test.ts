import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStore } from "@/ai/store";
const fake = vi.hoisted(() => ({ store: null as AiStore | null, queue: Promise.resolve() as Promise<unknown>, nonce: "" }));
vi.mock("@/ai/store", () => ({
  claimAiRuntime: () => {},
  readAiStore: () => fake.store,
  withAiStore: <T>(fn: (store: AiStore) => Promise<T> | T): Promise<T> => {
    const result = fake.queue.then(() => fn(fake.store!)); fake.queue = result.catch(() => {}); return result;
  },
}));
vi.mock("@/ai/browser", () => ({ openChrome: vi.fn(async () => false) }));
vi.mock("jose", () => ({ createRemoteJWKSet: vi.fn(() => "jwks"), jwtVerify: vi.fn(async () => ({ payload: { sub: "account-subject", nonce: fake.nonce, email: "person@example.test" } })) }));
import { beginChatGpt, chatGptPending, chatGptAccess, disconnectChatGpt } from "@/ai/chatgpt";
import { jwtVerify } from "jose";

let remote: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fake.store = { version: 1, hostId: "urn:uuid:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", profiles: [], gemini: null, selection: { provider: "none" } };
  fake.queue = Promise.resolve();
  remote = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" });
    if (String(url).endsWith("/revoke")) return new Response("");
    return Response.json({ access_token: "fake-access", refresh_token: "fake-refresh", id_token: "fake-id", token_type: "Bearer", expires_in: 3600, scope: "openid chatgpt.tokens.use.direct" });
  });
  vi.stubGlobal("fetch", remote); vi.clearAllMocks();
});
afterEach(async () => {
  for (const profile of fake.store?.profiles ?? []) await disconnectChatGpt(profile.id);
  vi.unstubAllGlobals();
});
function callback(url: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, text })); }).on("error", reject);
  });
}
async function authorize() {
  await beginChatGpt();
  const authorization = new URL(chatGptPending()!.url!);
  fake.nonce = authorization.searchParams.get("nonce")!;
  const target = new URL(authorization.searchParams.get("redirect_uri")!);
  target.search = new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "one-use-code", client_id: "oaiapp_testregistration" }).toString();
  return { authorization, target };
}

describe("ChatGPT OAuth account boundaries", () => {
  it("rejects a wrong state, exchanges against the issued client, validates identity and retains host ID", async () => {
    const { authorization, target } = await authorize();
    const bad = new URL(target); bad.searchParams.set("state", "wrong");
    expect((await callback(bad.href)).status).toBe(400);
    expect(remote).not.toHaveBeenCalled();
    expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("ext_agent_host_id")).toBe(fake.store!.hostId);
    expect((await callback(target.href)).status).toBe(200);
    const tokenCall = remote.mock.calls.find(([url]) => String(url).endsWith("/oauth/token")) as unknown as [string, RequestInit];
    const form = tokenCall[1].body as URLSearchParams;
    expect(form.get("client_id")).toBe("oaiapp_testregistration");
    expect(form.get("redirect_uri")).toBe(authorization.searchParams.get("redirect_uri"));
    expect(form.has("client_secret")).toBe(false);
    expect(jwtVerify).toHaveBeenCalledWith("fake-id", "jwks", expect.objectContaining({ issuer: "https://auth.openai.com", audience: "oaiapp_testregistration", requiredClaims: ["exp", "sub", "nonce"] }));
    expect(fake.store!.profiles[0].subject).toBe("account-subject");
    expect(chatGptPending()!.url).toBeUndefined();
    // Sign-in alone must not opt an account into report generation.
    expect(fake.store!.selection).toEqual({ provider: "none" });
  });
  it("rejects identity nonce mismatch instead of storing tokens", async () => {
    const { target } = await authorize(); fake.nonce = "another-attempt";
    expect((await callback(target.href)).status).toBe(400);
    expect(fake.store!.profiles[0].tokens).toBeUndefined();
  });
  it("serializes refresh, retains the validated identity and clears secrets on disconnect", async () => {
    const { target } = await authorize(); await callback(target.href);
    const profile = fake.store!.profiles[0]; profile.tokens!.expiresAt = 0;
    const before = remote.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token")).length;
    await Promise.all([chatGptAccess(profile.id), chatGptAccess(profile.id)]);
    expect(remote.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token")).length - before).toBe(1);
    const form = (remote.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body as URLSearchParams;
    expect(form.get("grant_type")).toBe("refresh_token"); expect(form.has("scope")).toBe(false);
    expect(await disconnectChatGpt(profile.id)).toContain("revoked");
    expect(profile.tokens).toBeUndefined(); expect(profile.clientId).toBe("oaiapp_testregistration");
    await expect(chatGptAccess(profile.id)).rejects.toThrow("signed out");
  });
  it("cancels a reconnect that is still waiting for the credential lock", async () => {
    const { target } = await authorize(); await callback(target.href);
    const profile = fake.store!.profiles[0];
    let unlock!: () => void;
    fake.queue = new Promise<void>((resolve) => { unlock = resolve; });
    const reconnect = beginChatGpt(profile.id);
    const rejected = expect(reconnect).rejects.toThrow("Sign-in canceled");
    const disconnect = disconnectChatGpt(profile.id);
    unlock();
    await rejected; await disconnect;
    expect(chatGptPending()?.status).toBe("error");
    expect(chatGptPending()?.url).toBeUndefined();
    expect(profile.tokens).toBeUndefined();
  });
});
