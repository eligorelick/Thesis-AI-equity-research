/**
 * assertSameOrigin — browser-CSRF guard for the mutating localhost API routes.
 *
 * Threat model: Thesis is a local-first, single-user app whose API listens on
 * localhost (and, when explicitly configured, on a LAN interface). A
 * drive-by web page open in the user's browser can fire cross-site fetch/form
 * POSTs at these routes and trigger PAID Anthropic report runs, burn provider
 * quota, or flip settings. Two distinct attacks must be stopped:
 *
 *   - Classic cross-origin CSRF: a page at evil.example POSTs to
 *     http://localhost:3000/… . The browser attaches Origin: evil.example (and,
 *     on modern browsers, Sec-Fetch-Site: cross-site), which does not match our
 *     Host — reject.
 *   - DNS-rebinding: evil.example serves a low-TTL A record that rebinds to
 *     127.0.0.1 after first load. The page's fetch now lands on the local
 *     server while BOTH Origin and Host are "evil.example:3000", so the browser
 *     believes it is same-origin (Sec-Fetch-Site: same-origin) and any
 *     Origin==Host equality holds. An Origin==Host check alone would ALLOW this.
 *     We additionally require the Host the request actually arrived on to be a
 *     loopback host — a value a cross-origin browser fetch cannot forge to
 *     loopback — or an explicitly configured LAN host.
 *
 * Rules (call from mutating handlers only — POST/PUT/DELETE; GETs are safe):
 *   1. The direct Host must be loopback or the exact `THESIS_ALLOWED_HOST`.
 *   2. `Sec-Fetch-Site: cross-site` → 403. A value no browser sends
 *      (`same-origin`, `same-site`, and `none` are the browser values) → 403.
 *   3. `Origin` present → its scheme and host:port must equal the request's own
 *      Host (rejects ordinary cross-origin CSRF, incl. same-machine web servers
 *      on another port, even on browsers that omit Sec-Fetch-Site). The opaque
 *      `Origin: null` a sandboxed iframe or cross-origin redirect sends is
 *      unparseable and rejected.
 *   4. No `Origin`: a browser-sent `Sec-Fetch-Site` (rule 2) is enough — every
 *      current browser sends Fetch Metadata or Origin on a mutation, so a
 *      browser never needs the token. Otherwise the request must carry
 *      `X-Thesis-Token` equal to the token this server minted at startup into
 *      `<data dir>/csrf-token` (see `ensureRequestToken`). curl and scripts read
 *      that file; a header-free request is rejected with a message naming the
 *      header options. The token is never logged and never reaches the browser.
 *
 * `THESIS_ALLOWED_HOST` (optional): set to the exact `host:port` you browse
 * Thesis under when serving it on a non-loopback interface, e.g.
 * "192.168.1.50:3000". Read at call time so it takes effect without a reload.
 */

import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { assertAllowedHost, requestOriginMatchesHost } from "@/app/requestSecurity";
import { getConfig } from "@/config/env";
import { defaultDataDir } from "@/db/paths";

/** Header a non-browser client sends with the minted token. */
export const REQUEST_TOKEN_HEADER = "x-thesis-token";

/** File name inside the data directory (override the full path with THESIS_TOKEN_FILE). */
export const REQUEST_TOKEN_FILE_NAME = "csrf-token";

/** `Sec-Fetch-Site` values a browser can send on a request that is not cross-site. */
const BROWSER_SITE_VALUES: ReadonlySet<string> = new Set(["same-origin", "same-site", "none"]);

const MISSING_CREDENTIALS_REASON =
  "no Sec-Fetch-Site, Origin, or X-Thesis-Token header; browsers send Sec-Fetch-Site or " +
  "Origin automatically, and scripts must send X-Thesis-Token with the contents of the " +
  `${REQUEST_TOKEN_FILE_NAME} file in the Thesis data directory (THESIS_TOKEN_FILE)`;

function forbid(reason: string): NextResponse {
  return NextResponse.json(
    { error: `cross-origin request rejected: ${reason}` },
    {
      status: 403,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

/* ------------------------------------------------------------------------ *
 * Startup token for non-browser clients
 * ------------------------------------------------------------------------ */

export interface RequestTokenState {
  /** 64 lowercase hex characters; never log it. */
  token: string;
  /** Where the token was (or should have been) written. */
  path: string;
  /** False when the file could not be written; the in-memory token still applies. */
  persisted: boolean;
}

interface RequestTokenStash {
  current?: RequestTokenState;
}

const REQUEST_TOKEN_KEY = Symbol.for("thesis.requestToken.v1");

/** Survives dev hot reloads the same way the scheduler pump state does. */
function tokenStash(): RequestTokenStash {
  const root = globalThis as typeof globalThis & {
    [REQUEST_TOKEN_KEY]?: RequestTokenStash;
  };
  root[REQUEST_TOKEN_KEY] ??= {};
  return root[REQUEST_TOKEN_KEY];
}

/** Resolved token file: THESIS_TOKEN_FILE, else `<data dir>/csrf-token`. */
export function requestTokenPath(): string {
  return getConfig().tokenFile ?? path.join(defaultDataDir(), REQUEST_TOKEN_FILE_NAME);
}

/**
 * Mint the process token once and write it to the token file with owner-only
 * permissions where the OS honors them (POSIX mode 0600; on Windows the file
 * inherits the per-user app-data ACL). A write failure is reported without the
 * token and leaves the in-memory token in force, so browsers keep working.
 */
export function ensureRequestToken(): RequestTokenState {
  const stash = tokenStash();
  if (stash.current !== undefined) return stash.current;

  const token = randomBytes(32).toString("hex");
  const file = requestTokenPath();
  let persisted = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    // writeFileSync applies `mode` only when it creates the file; tighten a
    // file left by an earlier run as well.
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    persisted = true;
  } catch (error) {
    console.warn(
      `[security] could not write the X-Thesis-Token file at ${file}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  stash.current = { token, path: file, persisted };
  return stash.current;
}

/** Test isolation only; never used by production routes. */
export function _resetRequestTokenForTests(): void {
  tokenStash().current = undefined;
}

/** Constant-time comparison over digests so neither length nor content leaks. */
function presentedTokenMatches(presented: string): boolean {
  const expected = ensureRequestToken().token;
  const presentedDigest = createHash("sha256").update(presented.trim()).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

/* ------------------------------------------------------------------------ *
 * Guard
 * ------------------------------------------------------------------------ */

/** Returns a 403 JSON response unless the request is provably local, else null. */
export function assertSameOrigin(request: Request): NextResponse | null {
  // This must precede every other check: an attacker can omit Origin and
  // Fetch Metadata while forging a rebound Host.
  const rejectedHost = assertAllowedHost(request);
  if (rejectedHost !== null) return rejectedHost;

  const secFetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (secFetchSite === "cross-site") {
    return forbid("sec-fetch-site is cross-site");
  }
  if (secFetchSite !== undefined && !BROWSER_SITE_VALUES.has(secFetchSite)) {
    return forbid("sec-fetch-site is invalid");
  }

  const origin = request.headers.get("origin");
  if (origin !== null) {
    // Classic same-origin check over the same strict authority representation
    // as the Host allowlist. This covers IDNA, IPv6, and default-port
    // equivalence without comparing a canonical Origin to attacker-controlled
    // raw Host text. The Host guard above already enforced loopback/allowlist.
    if (!requestOriginMatchesHost(request, origin)) {
      return forbid("origin does not match the request authority");
    }
    return null;
  }

  // Rule 4: browser-sent Fetch Metadata that is not cross-site is sufficient.
  if (secFetchSite !== undefined) return null;

  const presented = request.headers.get(REQUEST_TOKEN_HEADER);
  if (presented === null) return forbid(MISSING_CREDENTIALS_REASON);
  if (!presentedTokenMatches(presented)) {
    return forbid("x-thesis-token does not match the token this server minted at startup");
  }
  return null;
}
