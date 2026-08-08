import { NextResponse } from "next/server";

interface Authority {
  hostname: string;
  port: string | null;
}

function forbidden(reason: string): NextResponse {
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

function validPort(value: string | undefined): string | null | undefined {
  if (value === undefined) return null;
  if (!/^[1-9]\d{0,4}$/.test(value)) return undefined;
  return Number(value) <= 65_535 ? value : undefined;
}

function validDnsHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  return hostname.split(".").every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

/**
 * Parse one HTTP authority without accepting URL syntax, legacy IPv4 spellings,
 * or ambiguous port forms. Hostnames are normalized through URL's IDNA parser;
 * ports remain explicit so a configured LAN authority is an exact allowlist.
 */
function parseAuthority(value: string): Authority | null {
  const raw = value.trim();
  if (raw.length === 0) return null;
  if (/[\s,/@\\?#%]/u.test(raw)) return null;

  let rawHostname: string;
  let rawPort: string | undefined;

  if (raw.startsWith("[")) {
    const ipv6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(raw);
    if (ipv6 === null) return null;
    rawHostname = `[${ipv6[1]}]`;
    rawPort = ipv6[2];
  } else {
    const firstColon = raw.indexOf(":");
    const lastColon = raw.lastIndexOf(":");
    if (firstColon !== lastColon) return null;
    if (firstColon === -1) {
      rawHostname = raw;
    } else {
      rawHostname = raw.slice(0, firstColon);
      rawPort = raw.slice(firstColon + 1);
    }
    if (rawHostname.length === 0) return null;
  }

  const port = validPort(rawPort);
  if (port === undefined) return null;

  let hostname: string;
  try {
    hostname = new URL(`http://${rawHostname}/`).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (hostname.startsWith("[")) {
    if (/^\[::ffff:/i.test(hostname)) return null;
    return { hostname, port };
  }

  const canonicalIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
  if (canonicalIpv4) {
    const octets = hostname.split(".").map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) return null;
    // WHATWG URL accepts shorthand, integer, octal, and hex IPv4 forms. They
    // are unnecessary for local access and make an allowlist hard to audit.
    if (rawHostname.toLowerCase() !== hostname) return null;
    return { hostname, port };
  }

  if (!validDnsHostname(hostname)) return null;
  return { hostname, port };
}

function requestAuthority(request: Request): Authority | null {
  const directHost = request.headers.get("host");
  return directHost === null ? null : parseAuthority(directHost);
}

function isLoopback(authority: Authority): boolean {
  if (authority.hostname === "localhost" || authority.hostname === "[::1]") return true;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(authority.hostname)) return false;
  return Number(authority.hostname.split(".")[0]) === 127;
}

function configuredAuthority(): Authority | null {
  const configured = process.env.THESIS_ALLOWED_HOST;
  if (configured === undefined || configured.trim().length === 0) return null;
  return parseAuthority(configured.trim());
}

function sameAuthority(left: Authority, right: Authority): boolean {
  return left.hostname === right.hostname && left.port === right.port;
}

function withoutDefaultPort(authority: Authority, protocol: "http:" | "https:"): Authority {
  const defaultPort = protocol === "http:" ? "80" : "443";
  return authority.port === defaultPort ? { ...authority, port: null } : authority;
}

/** Compare a serialized browser Origin to the direct Host using one authority parser. */
export function requestOriginMatchesHost(request: Request, origin: string): boolean {
  const match = /^(https?):\/\/([^/?#]+)$/i.exec(origin);
  if (match === null) return false;

  const protocol = `${match[1].toLowerCase()}:` as "http:" | "https:";
  let requestProtocol: string;
  try {
    requestProtocol = new URL(request.url).protocol.toLowerCase();
  } catch {
    return false;
  }
  if (requestProtocol !== protocol) return false;

  const direct = requestAuthority(request);
  const supplied = parseAuthority(match[2]);
  if (direct === null || supplied === null) return false;
  return sameAuthority(
    withoutDefaultPort(direct, protocol),
    withoutDefaultPort(supplied, protocol),
  );
}

/** Reject a request whose direct Host is neither loopback nor the exact LAN allowlist. */
export function assertAllowedHost(request: Request): NextResponse | null {
  const authority = requestAuthority(request);
  if (authority === null) return forbidden("host authority is missing or invalid");
  if (isLoopback(authority)) return null;

  const configured = configuredAuthority();
  if (configured !== null && sameAuthority(authority, configured)) return null;
  return forbidden("host authority is not loopback or explicitly allowed");
}

function metadataToken(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  return value === null ? null : value.trim().toLowerCase();
}

function hasPrefetchToken(value: string | null): boolean {
  return value !== null && /(?:^|[\s;,])prefetch(?=$|[\s;,])/i.test(value);
}

/**
 * Protect a heavy GET/HEAD after routing has identified it as a company landing.
 * Same-site and cross-site embeds can consume the full provider pipeline, while
 * a top-level navigation remains a supported way to open a shared local link.
 */
export function assertHeavyGetMetadata(request: Request): NextResponse | null {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;

  const site = metadataToken(request, "sec-fetch-site");
  const mode = metadataToken(request, "sec-fetch-mode");
  const destination = metadataToken(request, "sec-fetch-dest");
  const speculative =
    hasPrefetchToken(request.headers.get("sec-purpose")) ||
    hasPrefetchToken(request.headers.get("purpose"));

  if (site === null) {
    if (speculative) return forbidden("heavy speculation request is not allowed");
    if (mode === null && destination === null) return null;
    return forbidden("fetch metadata is incomplete");
  }
  if (site === "same-origin" || site === "none") return null;
  if (site === "same-site" || site === "cross-site") {
    if (mode === "navigate" && destination === "document" && !speculative) return null;
    return forbidden("heavy cross-origin subresource request is not allowed");
  }
  return forbidden("fetch metadata site is invalid");
}
