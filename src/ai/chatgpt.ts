import "server-only";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { openChrome } from "./browser";
import { readAiStore, withAiStore, type ChatGptProfile } from "./store";

const ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
type Pending = { status: "waiting" | "connected" | "error"; message: string; url?: string; cancel: () => void };
type Runtime = { pending: Pending | null; requests: Map<string, Set<AbortController>> };
const KEY = Symbol.for("thesis.chatgpt.runtime.v1");
function runtime(): Runtime {
  const root = globalThis as typeof globalThis & { [KEY]?: Runtime };
  return root[KEY] ??= { pending: null, requests: new Map() };
}
export function chatGptPending() {
  const p = runtime().pending;
  return p ? { status: p.status, message: p.message, ...(p.url ? { url: p.url } : {}) } : null;
}

async function discovery(): Promise<{ jwks_uri: string; revocation_endpoint: string }> {
  const response = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) throw new Error("ChatGPT identity service is unavailable");
  const data = await response.json();
  if (data.issuer !== ISSUER) throw new Error("Unexpected ChatGPT identity issuer");
  for (const key of ["jwks_uri", "revocation_endpoint"]) {
    if (typeof data[key] !== "string" || new URL(data[key]).origin !== ISSUER) throw new Error("Unexpected ChatGPT identity endpoint");
  }
  return data;
}

interface TokenResponse { access_token: string; refresh_token?: string; id_token?: string; expires_in: number; scope?: string; token_type: string }
async function exchange(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST", body: new URLSearchParams(body), redirect: "error", signal: AbortSignal.timeout(25_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  if (!response.ok) throw new Error(response.status === 400 || response.status === 401
    ? "ChatGPT authorization expired or was declined. Connect this account again." : "ChatGPT authorization is temporarily unavailable.");
  const data = await response.json() as TokenResponse;
  if (typeof data.access_token !== "string" || data.token_type?.toLowerCase() !== "bearer" ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error("Invalid ChatGPT token response");
  return data;
}

function tokenRecord(data: TokenResponse, previous?: ChatGptProfile["tokens"]): NonNullable<ChatGptProfile["tokens"]> {
  const refresh = data.refresh_token ?? previous?.refresh;
  const id = data.id_token ?? previous?.id;
  if (typeof refresh !== "string" || !refresh || typeof id !== "string" || !id) throw new Error("ChatGPT authorization is missing renewable credentials");
  return { access: data.access_token, refresh, id, expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope === undefined ? previous?.scopes ?? [] : data.scope.split(/\s+/) };
}

export async function beginChatGpt(profileId?: string): Promise<void> {
  runtime().pending?.cancel();
  const registration = await withAiStore((store) => {
    const profile = profileId ? store.profiles.find((p) => p.id === profileId) : undefined;
    if (profileId && !profile) throw new Error("Unknown ChatGPT connection");
    if (!profile && store.profiles.length >= 20) throw new Error("Too many saved ChatGPT registrations");
    return { hostId: store.hostId, profile: profile ? structuredClone(profile) : undefined };
  });
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const pending: Pending = { status: "waiting", message: "Complete sign-in in Chrome.", cancel: () => {} };
  runtime().pending = pending;
  let consumed = false;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (req.method !== "GET" || req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(400).end("Invalid callback"); return; }
    const url = new URL(req.url ?? "/", redirect);
    const supplied = url.searchParams.getAll("state");
    const received = Buffer.from(supplied[0] ?? "");
    if (url.pathname !== "/auth/callback" || supplied.length !== 1 || received.length !== state.length ||
        !timingSafeEqual(received, Buffer.from(state)) || consumed || pending.status !== "waiting") {
      res.writeHead(400).end("Invalid or expired sign-in. Return to Thesis."); return;
    }
    consumed = true;
    delete pending.url;
    try {
      if (url.searchParams.has("error")) throw new Error("ChatGPT sign-in was declined. No account was connected.");
      const code = url.searchParams.get("code");
      const issued = url.searchParams.get("client_id") ?? registration.profile?.clientId;
      if (!code || !issued || !/^oaiapp_[a-zA-Z0-9_-]+$/.test(issued) ||
          (registration.profile && issued !== registration.profile.clientId)) throw new Error("Incomplete ChatGPT registration");
      // Retain a newly issued registration even if token exchange fails. Reconnect
      // reuses its client ID instead of creating duplicate application grants.
      const id = registration.profile?.id ?? randomUUID();
      await withAiStore((store) => {
        if (pending.status !== "waiting") throw new Error("Sign-in canceled");
        if (!store.profiles.some((p) => p.id === id)) store.profiles.push({ id, clientId: issued });
      });
      const data = await exchange({ grant_type: "authorization_code", client_id: issued, code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE });
      const endpoints = await discovery();
      if (!data.id_token) throw new Error("Missing ChatGPT identity token");
      const { payload } = await jwtVerify(data.id_token, createRemoteJWKSet(new URL(endpoints.jwks_uri)), {
        issuer: ISSUER, audience: issued, requiredClaims: ["exp", "sub", "nonce"], algorithms: ["RS256"],
      });
      if (payload.nonce !== nonce || !payload.sub ||
          (registration.profile?.subject && registration.profile.subject !== payload.sub)) throw new Error("ChatGPT account identity did not match");
      const tokens = tokenRecord(data);
      await withAiStore((store) => {
        if (pending.status !== "waiting") throw new Error("Sign-in canceled");
        const profile = store.profiles.find((p) => p.id === id);
        if (!profile) throw new Error("Registration no longer exists");
        Object.assign(profile, { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined, tokens });
      });
      pending.status = "connected";
      pending.message = tokens.scopes.includes("chatgpt.tokens.use.direct")
        ? "ChatGPT connected. Select a model and choose this connection for reports."
        : "Signed in, but ChatGPT plan usage was not granted. Reconnect and allow plan usage.";
      res.end("You can close this tab and return to Thesis Settings.");
    } catch (error) {
      pending.status = "error";
      pending.message = error instanceof Error && /^(ChatGPT|Sign-in|Incomplete|Missing|Invalid|Unexpected)/.test(error.message)
        ? error.message : "ChatGPT sign-in could not be completed. Reconnect from Thesis.";
      res.writeHead(400).end(pending.message);
    } finally { clearTimeout(timer); server.close(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  const redirect = `http://127.0.0.1:${port}/auth/callback`;
  const timer = setTimeout(() => pending.cancel(), 5 * 60_000);
  timer.unref();
  pending.cancel = () => {
    if (pending.status === "waiting") { pending.status = "error"; pending.message = "Sign-in canceled or timed out. Connect again when ready."; }
    delete pending.url; clearTimeout(timer); server.close();
  };
  const query = new URLSearchParams({ client_id: registration.profile?.clientId ?? "dynamic_agent_client",
    ext_agent_host_id: registration.hostId, response_type: "code", redirect_uri: redirect, scope: SCOPES, resource: RESOURCE,
    state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
  if (!registration.profile) query.set("agent_name_hint", "Thesis");
  // Optional identity hints are intentionally omitted from browser-visible URLs.
  pending.url = `${ISSUER}/api/accounts/authorize?${query}`;
  if (!await openChrome(pending.url)) pending.message = "Open the sign-in link in your normal Chrome browser.";
}

export async function chatGptAccess(profileId: string): Promise<string> {
  return withAiStore(async (store) => {
    const profile = store.profiles.find((p) => p.id === profileId);
    if (!profile?.tokens) throw new Error("ChatGPT connection is signed out");
    if (profile.tokens.expiresAt < Date.now() + 60_000) {
      const data = await exchange({ grant_type: "refresh_token", client_id: profile.clientId, refresh_token: profile.tokens.refresh, resource: RESOURCE });
      // Identity was validated during sign-in. Refresh must not replace it with
      // an unverified new ID token; retain the verified hint instead.
      profile.tokens = tokenRecord({ ...data, id_token: undefined }, profile.tokens);
    }
    if (!profile.tokens.scopes.includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan usage was not granted");
    return profile.tokens.access;
  });
}

export function trackChatGptRequest(id: string, upstream?: AbortSignal): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const entries = runtime().requests.get(id) ?? new Set<AbortController>();
  runtime().requests.set(id, entries); entries.add(controller);
  return { signal: upstream ? AbortSignal.any([upstream, controller.signal]) : controller.signal,
    release: () => { entries.delete(controller); if (!entries.size) runtime().requests.delete(id); } };
}

export async function disconnectChatGpt(id: string): Promise<string> {
  runtime().pending?.cancel();
  for (const controller of runtime().requests.get(id) ?? []) controller.abort();
  const registration = await withAiStore((store) => {
    const profile = store.profiles.find((p) => p.id === id);
    if (!profile) throw new Error("Unknown ChatGPT connection");
    const saved = structuredClone(profile);
    delete profile.tokens;
    if ("connectionId" in store.selection && store.selection.connectionId === id) store.selection = { provider: "none" };
    return saved;
  });
  if (!registration.tokens) return "Disconnected.";
  try {
    const { revocation_endpoint } = await discovery();
    const response = await fetch(revocation_endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ client_id: registration.clientId, token: registration.tokens.refresh, token_type_hint: "refresh_token" }) });
    if (!response.ok) throw new Error();
    return "Disconnected and renewable session revoked.";
  } catch { return "Disconnected locally. Remote revocation was not confirmed; remove Thesis in ChatGPT Settings → Usage."; }
}

export function chatGptConnected(id: string): boolean {
  return readAiStore()?.profiles.some((p) => p.id === id && p.tokens?.scopes.includes("chatgpt.tokens.use.direct")) ?? false;
}
