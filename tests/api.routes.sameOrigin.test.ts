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
  setDbForTests(null);
  handle.sqlite.close();
});

/** A bare POST Request with the given headers (no body needed for the guard). */
function guardReq(
  headers: Record<string, string>,
  url = "http://localhost:3000/api/report",
): Request {
  return new Request(url, { method: "POST", headers });
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
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const EVIL = { origin: "https://evil.example" };

async function expect403(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("cross-origin request rejected");
}

/* ------------------------------------------------------------------------ *
 * assertSameOrigin — unit
 * ------------------------------------------------------------------------ */

describe("assertSameOrigin", () => {
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
});

/* ------------------------------------------------------------------------ *
 * Route level — the guard fires before any work
 * ------------------------------------------------------------------------ */

describe("POST /api/report (same-origin guard)", () => {
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
  it("rejects a cross-origin settings change with 403 and persists nothing", async () => {
    const res = await settingsPOST(
      jsonReq("http://localhost:3000/api/settings", "POST", { analysisModel: "claude-opus-4-8" }, EVIL),
    );
    await expect403(res);
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
