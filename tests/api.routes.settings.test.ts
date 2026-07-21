/**
 * Handler-level tests for the settings + watchlist API routes (audit test-gap
 * finding). Imports the GET/POST/DELETE handlers directly and drives them with
 * constructed Request objects, against an in-memory better-sqlite3 database.
 *
 * No network / no LLM — settings reads/writes the `settings` table and
 * getConfig() (pure env parse); watchlist reads/writes the `watchlist` table.
 *
 * Coverage:
 *   GET  /api/settings          — payload shape (options + capability flags).
 *   POST /api/settings          — zod enum accept, reject unknown model,
 *                                 non-JSON body → 400, unknown keys stripped.
 *   GET  /api/watchlist         — list shape.
 *   POST /api/watchlist         — zod accept (uppercased), reject illegal
 *                                 symbol / over-length / non-JSON → 400.
 *   DELETE /api/watchlist       — removes; idempotent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @/watchlist/watchlist imports the `server-only` shim (absent under the
// plain-node runner). Stub it to a no-op so the route's module graph resolves.
vi.mock("server-only", () => ({}));

import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { settings, watchlist } from "@/db/schema";
import {
  getAnalysisEffortSetting,
  getAnalysisModelSetting,
} from "@/settings/settings";

import { GET as settingsGET, POST as settingsPOST } from "@/app/api/settings/route";
import {
  GET as watchlistGET,
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
});

afterEach(() => {
  setDbForTests(null);
  handle.sqlite.close();
});

function jsonReq(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------------ *
 * /api/settings
 * ------------------------------------------------------------------------ */

describe("GET /api/settings", () => {
  it("returns the current model/effort, the option lists, and capability flags", async () => {
    const res = await settingsGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      analysisModel: string;
      analysisModelOptions: string[];
      analysisEffort: string;
      analysisEffortOptions: string[];
      capabilities: Record<string, boolean>;
    };
    expect(body.analysisModelOptions).toContain("auto");
    expect(body.analysisModelOptions).toContain("claude-opus-4-8");
    expect(typeof body.analysisModel).toBe("string");
    expect(body.analysisEffortOptions).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(body.analysisEffortOptions).toContain(body.analysisEffort);
    // Capability flags are booleans (values depend on the ambient env).
    for (const key of ["hasFmpKey", "hasFinnhubKey", "hasFredKey", "hasAnthropicKey", "fixtureMode"]) {
      expect(typeof body.capabilities[key]).toBe("boolean");
    }
  });

  it("wires each capability flag to its own env key (fix-review: exact values, not just booleans)", async () => {
    const { resetConfigCache } = await import("@/config/env");
    const saved = {
      FMP_API_KEY: process.env.FMP_API_KEY,
      FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
      FRED_API_KEY: process.env.FRED_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    try {
      process.env.FMP_API_KEY = "k-fmp";
      delete process.env.FINNHUB_API_KEY;
      process.env.FRED_API_KEY = "k-fred";
      delete process.env.ANTHROPIC_API_KEY;
      resetConfigCache();

      const res = await settingsGET();
      const body = (await res.json()) as { capabilities: Record<string, boolean> };
      expect(body.capabilities.hasFmpKey).toBe(true);
      expect(body.capabilities.hasFinnhubKey).toBe(false);
      expect(body.capabilities.hasFredKey).toBe(true);
      expect(body.capabilities.hasAnthropicKey).toBe(false);
      // fixtureMode is the inverse of hasFmpKey — a flag wired to the wrong key
      // would flip one of these.
      expect(body.capabilities.fixtureMode).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetConfigCache();
    }
  });
});

describe("POST /api/settings", () => {
  it("rejects a non-JSON body with 400", async () => {
    const res = await settingsPOST(
      new Request("http://localhost/api/settings", { method: "POST", body: "oops{" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("JSON");
  });

  it("rejects a model outside the allowed enum with 400 and does not persist", async () => {
    const res = await settingsPOST(
      jsonReq("http://localhost/api/settings", "POST", { analysisModel: "gpt-4o" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid settings");
    // Nothing written to the settings table.
    expect(handle.db.select().from(settings).all()).toHaveLength(0);
  });

  it("accepts a valid enum model, persists it, and echoes the new payload", async () => {
    const res = await settingsPOST(
      jsonReq("http://localhost/api/settings", "POST", { analysisModel: "claude-opus-4-8" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { analysisModel: string };
    expect(body.analysisModel).toBe("claude-opus-4-8");
    // Persisted through the settings layer (survives a fresh read).
    expect(getAnalysisModelSetting()).toBe("claude-opus-4-8");
  });

  it("accepts a valid effort level, persists it, and echoes the new payload", async () => {
    const res = await settingsPOST(
      jsonReq("http://localhost/api/settings", "POST", { analysisEffort: "medium" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { analysisEffort: string };
    expect(body.analysisEffort).toBe("medium");
    // Persisted through the settings layer (survives a fresh read).
    expect(getAnalysisEffortSetting()).toBe("medium");
  });

  it("rejects an effort outside the allowed enum with 400 and does not persist", async () => {
    const res = await settingsPOST(
      jsonReq("http://localhost/api/settings", "POST", { analysisEffort: "turbo" }),
    );
    expect(res.status).toBe(400);
    expect(handle.db.select().from(settings).all()).toHaveLength(0);
  });

  it("strips unknown keys (z.object) and leaves the model unchanged when none is given", async () => {
    // A stale client POSTing the removed verifyModel key must be ignored, not 400.
    const res = await settingsPOST(
      jsonReq("http://localhost/api/settings", "POST", { verifyModel: "whatever" }),
    );
    expect(res.status).toBe(200);
    // No analysisModel provided → nothing persisted.
    expect(handle.db.select().from(settings).all()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ *
 * /api/watchlist
 * ------------------------------------------------------------------------ */

describe("GET /api/watchlist", () => {
  it("returns the (empty) watchlist array", async () => {
    const res = await watchlistGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { watchlist: unknown[] };
    expect(body.watchlist).toEqual([]);
  });
});

describe("POST /api/watchlist", () => {
  it("adds a symbol (uppercased) and returns the updated list", async () => {
    const res = await watchlistPOST(
      jsonReq("http://localhost/api/watchlist", "POST", { symbol: "aapl" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { watchlist: { symbol: string }[] };
    expect(body.watchlist.map((r) => r.symbol)).toEqual(["AAPL"]);
    // Persisted in the table under the canonical key.
    expect(handle.db.select().from(watchlist).all().map((r) => r.symbol)).toEqual(["AAPL"]);
  });

  it("rejects an illegal symbol (regex) with 400 and adds nothing", async () => {
    const res = await watchlistPOST(
      jsonReq("http://localhost/api/watchlist", "POST", { symbol: "no spaces!" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid request");
    expect(handle.db.select().from(watchlist).all()).toHaveLength(0);
  });

  it("rejects an over-length symbol with 400", async () => {
    const res = await watchlistPOST(
      jsonReq("http://localhost/api/watchlist", "POST", { symbol: "ABCDEFGHIJKLM" }),
    );
    expect(res.status).toBe(400);
    expect(handle.db.select().from(watchlist).all()).toHaveLength(0);
  });

  it("rejects a non-JSON body with 400", async () => {
    const res = await watchlistPOST(
      new Request("http://localhost/api/watchlist", { method: "POST", body: "bad{" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("JSON");
  });
});

describe("DELETE /api/watchlist", () => {
  it("removes a symbol (case-insensitive) and is idempotent", async () => {
    await watchlistPOST(jsonReq("http://localhost/api/watchlist", "POST", { symbol: "aapl" }));
    await watchlistPOST(jsonReq("http://localhost/api/watchlist", "POST", { symbol: "msft" }));

    const res = await watchlistDELETE(
      jsonReq("http://localhost/api/watchlist", "DELETE", { symbol: "AAPL" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { watchlist: { symbol: string }[] };
    expect(body.watchlist.map((r) => r.symbol)).toEqual(["MSFT"]);

    // Deleting an absent symbol is a no-op (still 200, list unchanged).
    const again = await watchlistDELETE(
      jsonReq("http://localhost/api/watchlist", "DELETE", { symbol: "AAPL" }),
    );
    expect(again.status).toBe(200);
    const body2 = (await again.json()) as { watchlist: { symbol: string }[] };
    expect(body2.watchlist.map((r) => r.symbol)).toEqual(["MSFT"]);
  });

  it("rejects a non-JSON DELETE body with 400", async () => {
    const res = await watchlistDELETE(
      new Request("http://localhost/api/watchlist", { method: "DELETE", body: "x{" }),
    );
    expect(res.status).toBe(400);
  });
});
