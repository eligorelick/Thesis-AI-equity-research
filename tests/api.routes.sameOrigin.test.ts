/**
 * Same-origin (CSRF) trust boundary for the mutating API routes.
 *
 * Unit-tests `assertSameOrigin` (src/app/api/sameOrigin.ts) directly, then
 * proves at the route level that a provably cross-site browser request is
 * rejected with 403 BEFORE any work happens — no job row, no runJob dispatch,
 * no settings/watchlist writes. Requests with no Origin/Sec-Fetch-Site header
 * (curl, scripts, the existing route-test harnesses) must keep passing.
 *
 * Route harness mirrors tests/api.routes.report.test.ts: handlers imported
 * directly, in-memory better-sqlite3 via setDbForTests, runJob stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// Route module graphs can pull the `server-only` shim (absent under the plain
// node runner). Stub it to a no-op.
vi.mock("server-only", () => ({}));

// Stub runJob (the paid part). Everything else in jobRunner stays real so the
// routes' own control flow runs against a real DB.
const { runJobMock } = vi.hoisted(() => ({
  runJobMock: vi.fn(async () => ({
    status: "done" as const,
    reportId: null,
    dataOnly: true,
    verificationRate: null,
    totalCostUsd: 0,
  })),
}));
vi.mock("@/pipeline/jobRunner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/jobRunner")>();
  return { ...actual, runJob: runJobMock };
});

import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { jobs, settings, watchlist } from "@/db/schema";
import { createJob as createJobReal } from "@/pipeline/jobRunner";

import { assertSameOrigin } from "@/app/api/sameOrigin";
import { assertAllowedHost } from "@/app/requestSecurity";
import * as requestSecurityModule from "@/app/requestSecurity";
import { POST as reportPOST } from "@/app/api/report/route";
import { POST as retryPOST } from "@/app/api/report/[jobId]/retry/route";
import { POST as cancelPOST } from "@/app/api/report/[jobId]/cancel/route";
import { POST as settingsPOST } from "@/app/api/settings/route";
import {
  POST as watchlistPOST,
  DELETE as watchlistDELETE,
} from "@/app/api/watchlist/route";

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

let handle: DatabaseHandle;

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
  runJobMock.mockClear();
});

afterEach(() => {
  delete process.env.THESIS_ALLOWED_HOST;
  setDbForTests(null);
  handle.sqlite.close();
});

/** A bare POST Request with the given headers (no body needed for the guard). */
function guardReq(
  headers: Record<string, string>,
  url = "http://localhost:3000/api/report",
): Request {
  return new Request(url, {
    method: "POST",
    headers: { host: new URL(url).host, ...headers },
  });
}

/** A JSON POST Request with extra headers (for route-level tests). */
function jsonReq(
  url: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method,
    headers: { host: new URL(url).host, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const EVIL = { origin: "https://evil.example" };

async function expect403(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("cross-origin request rejected");
}

/* ------------------------------------------------------------------------ *
 * assertSameOrigin — unit
 * ------------------------------------------------------------------------ */

describe("assertSameOrigin", () => {
  it("rejects a missing direct Host instead of trusting the normalized request URL", () => {
    const request = new Request("http://localhost:3000/api/report", { method: "POST" });
    expect(request.headers.get("host")).toBeNull();
    expect(assertSameOrigin(request)?.status).toBe(403);
  });

  it("rejects a forged non-loopback Host even when Origin and Fetch Metadata are absent", async () => {
    const res = assertSameOrigin(
      guardReq({ host: "evil.example:3000" }, "http://localhost:3000/api/report"),
    );

    expect(res).not.toBeNull();
    await expect403(res as Response);
  });

  it("uses the direct Host authority and never expands trust from forwarded headers", () => {
    const forgedDirectHost = guardReq(
      {
        host: "evil.example:3000",
        forwarded: 'host="localhost:3000";proto=http',
        "x-forwarded-host": "localhost:3000",
      },
      "http://localhost:3000/api/report",
    );
    expect(assertSameOrigin(forgedDirectHost)?.status).toBe(403);

    const forgedForwardedHost = guardReq(
      {
        host: "localhost:3000",
        forwarded: 'host="evil.example:3000";proto=https',
        "x-forwarded-host": "evil.example:3000",
      },
    );
    expect(assertSameOrigin(forgedForwardedHost)).toBeNull();
  });

  it.each([
    "localhost.evil.example:3000",
    "localhost.:3000",
    "127.1:3000",
    "0177.0.0.1:3000",
    "2130706433:3000",
    "[::ffff:127.0.0.1]:3000",
    "localhost:03000",
    "localhost:0",
    "localhost:65536",
    "user@localhost:3000",
    "localhost:3000, evil.example:3000",
  ])("rejects malformed or non-canonical Host authority %s", (host) => {
    expect(assertSameOrigin(guardReq({ host }))?.status).toBe(403);
  });

  it("accepts the canonical IPv6 loopback authority when the Host uses its full spelling", () => {
    const host = "[0:0:0:0:0:0:0:1]:3000";
    expect(assertSameOrigin(guardReq({ host }, `http://${host}/api/report`))).toBeNull();
  });

  it("accepts canonical dotted-decimal members of the IPv4 127/8 loopback range", () => {
    const host = "127.0.0.2:3000";
    expect(assertSameOrigin(guardReq({ host }, `http://${host}/api/report`))).toBeNull();
  });

  it("allows a request with neither Origin nor Sec-Fetch-Site (curl/scripts)", () => {
    expect(assertSameOrigin(guardReq({}))).toBeNull();
  });

  it("allows Sec-Fetch-Site: same-origin", () => {
    expect(assertSameOrigin(guardReq({ "sec-fetch-site": "same-origin" }))).toBeNull();
  });

  it("rejects Sec-Fetch-Site: cross-site with 403 even without an Origin header", async () => {
    const res = assertSameOrigin(guardReq({ "sec-fetch-site": "cross-site" }));
    expect(res).not.toBeNull();
    await expect403(res as Response);
  });

  it("rejects Sec-Fetch-Site: cross-site even when the Origin claims loopback", () => {
    const res = assertSameOrigin(
      guardReq({ "sec-fetch-site": "cross-site", origin: "http://localhost:3000" }),
    );
    expect(res?.status).toBe(403);
  });

  it("rejects a cross-site Origin with 403", async () => {
    const res = assertSameOrigin(guardReq(EVIL));
    expect(res).not.toBeNull();
    await expect403(res as Response);
  });

  it.each([
    ["http://localhost:3000", "localhost:3000"],
    ["http://127.0.0.1:3000", "127.0.0.1:3000"],
    ["http://[::1]:3000", "[::1]:3000"],
  ])("allows loopback origin %s talking to its matching loopback Host", (origin, host) => {
    const req = guardReq({ origin, host }, `http://${host}/api/report`);
    expect(assertSameOrigin(req)).toBeNull();
  });

  it("rejects a loopback origin whose Host is a non-loopback interface (Origin!=Host)", () => {
    // A loopback Origin no longer grants access on its own: acceptance is
    // decided by the Host the request actually arrived on. localhost:3000 does
    // not match a LAN Host, so this is rejected.
    const req = guardReq(
      { origin: "http://localhost:3000", host: "192.168.1.50:3000" },
      "http://192.168.1.50:3000/api/report",
    );
    expect(assertSameOrigin(req)?.status).toBe(403);
  });

  it("rejects a request whose Host merely matches its own Origin but is not loopback (DNS-rebinding)", () => {
    // The core hardening: under a rebinding attack Origin and Host are the SAME
    // attacker-controlled value ('evil.example:3000' rebound to 127.0.0.1) and
    // Sec-Fetch-Site is same-origin — so the old Origin==Host equality allowed
    // it. A non-loopback Host that equals its Origin must NOT pass without an
    // explicit allowlist.
    const req = guardReq(
      {
        origin: "http://evil.example:3000",
        host: "evil.example:3000",
        "sec-fetch-site": "same-origin",
      },
      "http://evil.example:3000/api/report",
    );
    expect(assertSameOrigin(req)?.status).toBe(403);
  });

  it("allows a matching non-loopback Host only when THESIS_ALLOWED_HOST is configured (LAN dev)", () => {
    const req = () =>
      guardReq(
        { origin: "http://192.168.1.50:3000", host: "192.168.1.50:3000" },
        "http://192.168.1.50:3000/api/report",
      );
    // Unset → the exact DNS-rebinding shape → rejected.
    delete process.env.THESIS_ALLOWED_HOST;
    expect(assertSameOrigin(req())?.status).toBe(403);
    // Configured to this exact host:port → allowed.
    process.env.THESIS_ALLOWED_HOST = "192.168.1.50:3000";
    try {
      expect(assertSameOrigin(req())).toBeNull();
      // A different LAN host is still rejected even with one configured.
      const other = guardReq(
        { origin: "http://192.168.1.99:3000", host: "192.168.1.99:3000" },
        "http://192.168.1.99:3000/api/report",
      );
      expect(assertSameOrigin(other)?.status).toBe(403);
    } finally {
      delete process.env.THESIS_ALLOWED_HOST;
    }
  });

  it("rejects an Origin whose host:port does not match the Host header", () => {
    const req = guardReq(
      { origin: "http://192.168.1.99:3000", host: "192.168.1.50:3000" },
      "http://192.168.1.50:3000/api/report",
    );
    expect(req.headers.get("origin")).toBe("http://192.168.1.99:3000");
    expect(assertSameOrigin(req)?.status).toBe(403);
  });

  it("rejects a same-host different-port Origin (host:port comparison, not host)", () => {
    const req = guardReq(
      { origin: "http://192.168.1.50:8080", host: "192.168.1.50:3000" },
      "http://192.168.1.50:3000/api/report",
    );
    expect(assertSameOrigin(req)?.status).toBe(403);
  });

  it('rejects the opaque "null" Origin (sandboxed iframe / cross-origin redirect)', () => {
    expect(assertSameOrigin(guardReq({ origin: "null" }))?.status).toBe(403);
  });

  it.each([
    "ftp://localhost:3000",
    "http://user@localhost:3000",
    "http://localhost:3000/path",
    "http://localhost:3000?query",
    "http://localhost:3000#fragment",
  ])("rejects a non-HTTP or non-serialized Origin %s", (origin) => {
    expect(assertSameOrigin(guardReq({ origin }))?.status).toBe(403);
  });

  it("rejects an Origin whose scheme differs from the direct request scheme", () => {
    expect(
      assertSameOrigin(
        guardReq(
          { host: "localhost:3000", origin: "https://localhost:3000" },
          "http://localhost:3000/api/report",
        ),
      )?.status,
    ).toBe(403);
  });

  it("treats an explicit default Host port as the same serialized HTTP Origin", () => {
    expect(
      assertSameOrigin(
        guardReq(
          { host: "localhost:80", origin: "http://localhost" },
          "http://localhost/api/report",
        ),
      ),
    ).toBeNull();
  });
});

describe("assertAllowedHost", () => {
  it("matches an exact configured IDNA hostname and port after canonicalization", () => {
    process.env.THESIS_ALLOWED_HOST = "b\u00fccher.local:3000";
    expect(
      assertAllowedHost(guardReq({ host: "xn--bcher-kva.local:3000" })),
    ).toBeNull();
    expect(
      assertAllowedHost(guardReq({ host: "xn--bcher-kva.local:3001" }))?.status,
    ).toBe(403);
  });

  it("matches a configured expanded IPv6 authority exactly after canonicalization", () => {
    process.env.THESIS_ALLOWED_HOST = "[0:0:0:0:0:0:0:2]:3000";
    expect(assertAllowedHost(guardReq({ host: "[::2]:3000" }))).toBeNull();
    expect(assertAllowedHost(guardReq({ host: "[::2]:3001" }))?.status).toBe(403);
  });

  it("rejects IPv4-mapped IPv6 even when that exact authority is configured", () => {
    process.env.THESIS_ALLOWED_HOST = "[::ffff:192.168.1.50]:3000";
    expect(
      assertAllowedHost(guardReq({ host: "[::ffff:192.168.1.50]:3000" }))?.status,
    ).toBe(403);
  });

  it("does not grant access when THESIS_ALLOWED_HOST is malformed", () => {
    process.env.THESIS_ALLOWED_HOST = "lan.example:3000/path";
    expect(assertAllowedHost(guardReq({ host: "lan.example:3000" }))?.status).toBe(403);
  });
});

describe("assertHeavyGetMetadata", () => {
  type HeavyGuard = (request: Request) => Response | null;

  function heavyGuard(): HeavyGuard | undefined {
    return (requestSecurityModule as unknown as { assertHeavyGetMetadata?: HeavyGuard })
      .assertHeavyGetMetadata;
  }

  function heavyRequest(
    headers: Record<string, string> = {},
    method = "GET",
  ): Request {
    return new Request("http://localhost:3000/company/AAPL", {
      method,
      headers: { host: "localhost:3000", ...headers },
    });
  }

  it.each([
    ["cross-site", "navigate", "iframe"],
    ["cross-site", "cors", "empty"],
    ["cross-site", "no-cors", "image"],
    ["cross-site", "no-cors", "script"],
    ["same-site", "navigate", "iframe"],
    ["same-site", "cors", "empty"],
  ])(
    "rejects %s heavy subresource metadata mode=%s dest=%s",
    (site, mode, dest) => {
      const guard = heavyGuard();
      expect(guard).toBeTypeOf("function");
      if (guard === undefined) return;

      expect(
        guard(
          heavyRequest({
            "sec-fetch-site": site,
            "sec-fetch-mode": mode,
            "sec-fetch-dest": dest,
          }),
        )?.status,
      ).toBe(403);
    },
  );

  it.each(["cross-site", "same-site"])(
    "allows %s top-level navigation without requiring Sec-Fetch-User",
    (site) => {
      const guard = heavyGuard();
      expect(guard).toBeTypeOf("function");
      if (guard === undefined) return;

      expect(
        guard(
          heavyRequest({
            "sec-fetch-site": site,
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          }),
        ),
      ).toBeNull();
    },
  );

  it("allows same-origin RSC/prefetch metadata", () => {
    const guard = heavyGuard();
    expect(guard).toBeTypeOf("function");
    if (guard === undefined) return;

    expect(
      guard(
        heavyRequest({
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["cross-site", "sec-purpose", "prefetch"],
    ["cross-site", "sec-purpose", "  PreFeTcH ; prerender  "],
    ["same-site", "purpose", "prefetch"],
  ])(
    "rejects %s navigate/document speculation loads from %s=%s",
    (site, purposeHeader, purpose) => {
      const guard = heavyGuard();
      expect(guard).toBeTypeOf("function");
      if (guard === undefined) return;

      expect(
        guard(
          heavyRequest({
            "sec-fetch-site": site,
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
            [purposeHeader]: purpose,
          }),
        )?.status,
      ).toBe(403);
    },
  );

  it("keeps the same-origin prefetch fast path", () => {
    const guard = heavyGuard();
    expect(guard).toBeTypeOf("function");
    if (guard === undefined) return;

    expect(
      guard(
        heavyRequest({
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
          "sec-purpose": "prefetch",
        }),
      ),
    ).toBeNull();
  });

  it("allows a truly headerless local client and Sec-Fetch-Site none", () => {
    const guard = heavyGuard();
    expect(guard).toBeTypeOf("function");
    if (guard === undefined) return;

    expect(guard(heavyRequest())).toBeNull();
    expect(guard(heavyRequest({ "sec-fetch-site": "none" }))).toBeNull();
  });

  it.each(["purpose", "sec-purpose"])(
    "rejects a legacy header-only speculation load from %s",
    (purposeHeader) => {
      const guard = heavyGuard();
      expect(guard).toBeTypeOf("function");
      if (guard === undefined) return;

      expect(guard(heavyRequest({ [purposeHeader]: "prefetch" }))?.status).toBe(403);
    },
  );

  it("rejects partial or unknown Fetch Metadata but ignores Sec-Fetch-User", () => {
    const guard = heavyGuard();
    expect(guard).toBeTypeOf("function");
    if (guard === undefined) return;

    expect(
      guard(
        heavyRequest({
          "sec-fetch-mode": "no-cors",
          "sec-fetch-dest": "image",
        }),
      )?.status,
    ).toBe(403);
    expect(guard(heavyRequest({ "sec-fetch-site": "unexpected" }))?.status).toBe(403);
    expect(
      guard(
        heavyRequest({
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          "sec-fetch-user": "?0",
        }),
      ),
    ).toBeNull();
  });

  it("does not apply the heavy GET policy to a mutation", () => {
    const guard = heavyGuard();
    expect(guard).toBeTypeOf("function");
    if (guard === undefined) return;

    expect(
      guard(
        heavyRequest(
          {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "no-cors",
            "sec-fetch-dest": "image",
          },
          "POST",
        ),
      ),
    ).toBeNull();
  });
});

describe("request-wide proxy", () => {
  type ProxyFunction = (request: Request) => Response | Promise<Response>;

  async function loadProxyModule(): Promise<Record<string, unknown>> {
    try {
      return await vi.importActual<Record<string, unknown>>("@/proxy");
    } catch {
      return {};
    }
  }

  function proxyFunction(loadedModule: Record<string, unknown>): ProxyFunction | undefined {
    const candidate = loadedModule.proxy;
    expect(candidate).toBeTypeOf("function");
    return typeof candidate === "function" ? (candidate as ProxyFunction) : undefined;
  }

  function proxyRequest(
    path: string,
    headers: Record<string, string>,
    method = "GET",
  ): Request {
    return new Request(`http://localhost:3000${path}`, {
      method,
      headers: { host: "localhost:3000", ...headers },
    });
  }

  it("has no matcher or runtime export so Host validation covers every request", async () => {
    const loadedModule = await loadProxyModule();
    if (proxyFunction(loadedModule) === undefined) return;
    expect(loadedModule).not.toHaveProperty("config");
    expect(loadedModule).not.toHaveProperty("runtime");

    await import("next/dist/server/node-environment");
    const { unstable_doesMiddlewareMatch } = await import(
      "next/experimental/testing/server"
    );
    for (const url of [
      "http://localhost:3000/",
      "http://localhost:3000/company/AAPL?_rsc=1",
      "http://localhost:3000/api/report",
      "http://localhost:3000/_next/static/chunks/app.js",
      "http://localhost:3000/_next/image?url=%2Flogo.png&w=32&q=75",
      "http://localhost:3000/favicon.ico",
    ]) {
      expect(unstable_doesMiddlewareMatch({ config: {}, url })).toBe(true);
    }
  });

  it.each([
    "/",
    "/api/report",
    "/company/AAPL",
    "/_next/static/chunks/app.js",
    "/_next/image?url=%2Flogo.png&w=32&q=75",
    "/favicon.ico",
  ])("rejects a forged Host on %s", async (path) => {
    const loadedModule = await loadProxyModule();
    const runProxy = proxyFunction(loadedModule);
    if (runProxy === undefined) return;

    const response = await runProxy(
      proxyRequest(path, {
        host: "evil.example:3000",
        "x-forwarded-host": "localhost:3000",
      }),
    );
    await expect403(response);
  });

  it.each([
    "/company/AAPL",
    "/company/AAPL/",
    "/company/aapl",
    "/company/BRK.B",
    "/company/BRK-B",
    "/company/%41APL",
    "/company/%2541APL",
    "/company/AAPL?_rsc=1",
  ])("rejects cross-site subresources on exact heavy landing %s", async (path) => {
    const loadedModule = await loadProxyModule();
    const runProxy = proxyFunction(loadedModule);
    if (runProxy === undefined) return;

    const response = await runProxy(
      proxyRequest(path, {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-dest": "image",
      }),
    );
    await expect403(response);
  });

  it.each([
    "/company/",
    "/company/AAPL/history",
    "/company/AAPL/report/1",
    "/company/AAPL/report/1/print",
    "/company/AAPL/history?tab=all",
  ])("does not extend the heavy policy to non-landing route %s", async (path) => {
    const loadedModule = await loadProxyModule();
    const runProxy = proxyFunction(loadedModule);
    if (runProxy === undefined) return;

    const response = await runProxy(
      proxyRequest(path, {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-dest": "image",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps an EventSource-shaped report stream on the Host-only proxy path", async () => {
    const loadedModule = await loadProxyModule();
    const runProxy = proxyFunction(loadedModule);
    if (runProxy === undefined) return;

    const eventSourceHeaders = {
      accept: "text/event-stream",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
    const allowed = await runProxy(
      proxyRequest("/api/report/job-sse/stream", eventSourceHeaders),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("x-middleware-next")).toBe("1");

    const forgedHost = await runProxy(
      proxyRequest("/api/report/job-sse/stream", {
        ...eventSourceHeaders,
        host: "evil.example:3000",
      }),
    );
    await expect403(forgedHost);
  });

  it("allows top-level and same-origin heavy loads, including RSC prefetch", async () => {
    const loadedModule = await loadProxyModule();
    const runProxy = proxyFunction(loadedModule);
    if (runProxy === undefined) return;

    const topLevel = await runProxy(
      proxyRequest("/company/AAPL", {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      }),
    );
    const rsc = await runProxy(
      proxyRequest("/company/AAPL?_rsc=1", {
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "sec-purpose": "prefetch",
      }),
    );
    expect(topLevel.headers.get("x-middleware-next")).toBe("1");
    expect(rsc.headers.get("x-middleware-next")).toBe("1");
  });

  it("uses only raw Host authority, not request URL or X-Forwarded-Host", async () => {
    const loadedModule = await loadProxyModule();
    const runProxy = proxyFunction(loadedModule);
    if (runProxy === undefined) return;

    const localDirectHost = await runProxy(
      new Request("http://evil.example:3000/", {
        headers: {
          host: "localhost:3000",
          "x-forwarded-host": "evil.example:3000",
        },
      }),
    );
    expect(localDirectHost.headers.get("x-middleware-next")).toBe("1");

    const missingDirectHost = await runProxy(
      new Request("http://localhost:3000/", {
        headers: { "x-forwarded-host": "localhost:3000" },
      }),
    );
    expect(missingDirectHost.status).toBe(403);
  });

  it("guards GET and HEAD heavy landings but leaves mutation metadata to route guards", async () => {
    const loadedModule = await loadProxyModule();
    const runProxy = proxyFunction(loadedModule);
    if (runProxy === undefined) return;

    const metadata = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-dest": "image",
    };
    expect((await runProxy(proxyRequest("/company/AAPL", metadata, "GET"))).status).toBe(403);
    expect((await runProxy(proxyRequest("/company/AAPL", metadata, "HEAD"))).status).toBe(403);
    expect(
      (await runProxy(proxyRequest("/company/AAPL", metadata, "POST"))).headers.get(
        "x-middleware-next",
      ),
    ).toBe("1");
  });
});

/* ------------------------------------------------------------------------ *
 * Route level — the guard fires before any work
 * ------------------------------------------------------------------------ */

describe("POST /api/report (same-origin guard)", () => {
  it("rejects a forged Host without Origin before creating a job or dispatching runJob", async () => {
    const res = await reportPOST(
      jsonReq(
        "http://localhost:3000/api/report",
        "POST",
        { symbol: "AAPL" },
        { host: "evil.example:3000" },
      ),
    );

    await expect403(res);
    expect(handle.db.select().from(jobs).all()).toHaveLength(0);
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request with 403 before creating a job or dispatching runJob", async () => {
    const res = await reportPOST(
      jsonReq("http://localhost:3000/api/report", "POST", { symbol: "AAPL" }, EVIL),
    );
    await expect403(res);
    // No work happened: no job row, no (paid) runJob dispatch.
    expect(handle.db.select().from(jobs).all()).toHaveLength(0);
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("still accepts a same-origin browser request (Origin: http://localhost:3000) with 202", async () => {
    const res = await reportPOST(
      jsonReq("http://localhost:3000/api/report", "POST", { symbol: "AAPL" }, {
        origin: "http://localhost:3000",
        "sec-fetch-site": "same-origin",
      }),
    );
    expect(res.status).toBe(202);
    expect(handle.db.select().from(jobs).all()).toHaveLength(1);
  });
});

describe("POST /api/report/[jobId]/{retry,cancel} (same-origin guard)", () => {
  it("retry: 403 before the job lookup (unknown id would otherwise be 404)", async () => {
    const res = await retryPOST(
      new Request("http://localhost:3000/api/report/x/retry", { method: "POST", headers: EVIL }),
      { params: Promise.resolve({ jobId: "does-not-exist" }) },
    );
    await expect403(res);
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("cancel: 403 and the queued job is left untouched", async () => {
    const { jobId } = createJobReal("NVDA");
    const res = await cancelPOST(
      new Request(`http://localhost:3000/api/report/${jobId}/cancel`, {
        method: "POST",
        headers: EVIL,
      }),
      { params: Promise.resolve({ jobId }) },
    );
    await expect403(res);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.status).toBe("queued");
  });
});

describe("POST /api/settings (same-origin guard)", () => {
  it.each([
    ["cross-origin", { origin: "https://evil.example" }],
    ["forged Host", { host: "evil.example:3000" }],
  ])("rejects %s before If-Match, body parsing, or database access", async (_label, headers) => {
    const request = new Request("http://localhost:3000/api/settings", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "content-type": "application/json",
        "if-match": "not-even-a-valid-tag",
        ...headers,
      },
      body: "hostile-json{",
    });
    const jsonSpy = vi.spyOn(request, "json").mockRejectedValue(
      new Error("TASK29 body parser must not run"),
    );
    const throwingDb = new Proxy(handle.db, {
      get() {
        throw new Error("TASK29 database must not be touched");
      },
    });
    setDbForTests(throwingDb);
    try {
      await expect403(await settingsPOST(request));
    } finally {
      setDbForTests(handle.db);
    }
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(handle.db.select().from(settings).all()).toHaveLength(0);
  });
});

describe("/api/watchlist (same-origin guard)", () => {
  it("POST: rejects cross-origin with 403 and adds nothing", async () => {
    const res = await watchlistPOST(
      jsonReq("http://localhost:3000/api/watchlist", "POST", { symbol: "AAPL" }, EVIL),
    );
    await expect403(res);
    expect(handle.db.select().from(watchlist).all()).toHaveLength(0);
  });

  it("DELETE: rejects cross-origin with 403 and removes nothing", async () => {
    // Seed same-origin-style (no Origin header — the CLI/script path).
    await watchlistPOST(jsonReq("http://localhost:3000/api/watchlist", "POST", { symbol: "AAPL" }));
    const res = await watchlistDELETE(
      jsonReq("http://localhost:3000/api/watchlist", "DELETE", { symbol: "AAPL" }, EVIL),
    );
    await expect403(res);
    expect(handle.db.select().from(watchlist).all()).toHaveLength(1);
  });
});
