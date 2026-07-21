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
 *   1. `Sec-Fetch-Site: cross-site`  → 403.
 *   2. No `Origin` header → ALLOW. curl, scripts, and server-to-server calls
 *      send no Origin; the app uses no cookies or ambient auth, so classic CSRF
 *      tokens are unnecessary — this is a belt-and-suspenders origin check on
 *      browser-initiated requests, not an auth layer. Unparseable origins —
 *      including the opaque `Origin: null` a sandboxed iframe or cross-origin
 *      redirect sends — are rejected.
 *   3. `Origin` present → allow only when BOTH hold:
 *        (a) the Origin's host:port equals the request's own Host header
 *            (rejects ordinary cross-origin CSRF, incl. same-machine web servers
 *            on another port, even on browsers that omit Sec-Fetch-Site); AND
 *        (b) that Host is a loopback host (localhost, 127.0.0.1, [::1]; any
 *            port) or the explicitly configured `THESIS_ALLOWED_HOST` (LAN dev).
 *      Origin==Host is thus necessary but no longer SUFFICIENT — a non-loopback
 *      Host that merely matches its own Origin (the DNS-rebinding case) is
 *      rejected.
 *
 * `THESIS_ALLOWED_HOST` (optional): set to the exact `host:port` you browse
 * Thesis under when serving it on a non-loopback interface, e.g.
 * "192.168.1.50:3000". Read at call time so it takes effect without a reload.
 */

import { NextResponse } from "next/server";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function forbid(reason: string): NextResponse {
  return NextResponse.json(
    { error: `cross-origin request rejected: ${reason}` },
    { status: 403 },
  );
}

/** The bare hostname of a `host:port` value (handles IPv6 `[::1]:3000`). */
function hostnameOfHost(host: string): string {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return host;
  }
}

/** True when the request's Host arrived on a loopback interface (any port). */
function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostnameOfHost(host));
}

/** The optional configured LAN host allowlist entry, or null when unset. */
function allowedHost(): string | null {
  const raw = process.env.THESIS_ALLOWED_HOST?.trim().toLowerCase();
  return raw !== undefined && raw.length > 0 ? raw : null;
}

/** Returns a 403 JSON response when the request is provably cross-site, else null. */
export function assertSameOrigin(request: Request): NextResponse | null {
  const secFetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (secFetchSite === "cross-site") {
    return forbid("sec-fetch-site is cross-site");
  }

  const origin = request.headers.get("origin");
  if (origin === null) return null; // rule 2: non-browser or header-free request

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return forbid(`unparseable origin "${origin}"`); // includes opaque "null"
  }

  const host = (request.headers.get("host") ?? new URL(request.url).host).trim().toLowerCase();

  // (a) Classic same-origin check. Rejects ordinary cross-origin CSRF
  //     (Origin=evil, Host=ours) even on browsers that omit Sec-Fetch-Site,
  //     and a same-machine web server on a different port (its Origin's port
  //     differs from ours).
  if (parsed.host.toLowerCase() !== host) {
    return forbid(`origin "${origin}" does not match host "${host}"`);
  }

  // (b) DNS-rebinding defense. Under a rebinding attack Origin==Host both carry
  //     the attacker's own host (rebound to loopback), so (a) passes; require
  //     the Host the request truly arrived on to be loopback (unforgeable to
  //     loopback from a cross-origin browser fetch) or the configured LAN host.
  if (isLoopbackHost(host)) return null;
  const allowed = allowedHost();
  if (allowed !== null && host === allowed) return null;

  return forbid(`host "${host}" is not loopback or an allowed host`);
}
