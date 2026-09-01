/**
 * Handler-level tests for the settings + watchlist API routes (audit test-gap
 * finding). Imports the GET/POST/DELETE handlers directly and drives them with
 * constructed Request objects, against an in-memory better-sqlite3 database.
 *
 * No network / no LLM — settings reads/writes the `settings` table and
 * getConfig() (pure env parse); watchlist reads/writes the `watchlist` table.
 *
 * Coverage:
 *   GET  /api/settings          — coherent authority, strong ETag, additive
 *                                 options/capability booleans, no-store.
 *   POST /api/settings          — exact full pair, If-Match CAS, immediate
 *                                 transaction, inheritance, rollback, errors.
 *   GET  /api/watchlist         — list shape.
 *   POST /api/watchlist         — zod accept (uppercased), reject illegal
 *                                 symbol / over-length / non-JSON → 400.
 *   DELETE /api/watchlist       — removes; idempotent.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @/watchlist/watchlist imports the `server-only` shim (absent under the
// plain-node runner). Stub it to a no-op so the route's module graph resolves.
vi.mock("server-only", () => ({}));

import {
  createDatabase,
  setDbForTests,
  type DatabaseHandle,
  type ThesisDb,
} from "@/db";
import { settings, watchlist } from "@/db/schema";
import {
  SETTING_KEYS,
  setSetting,
} from "@/settings/settings";
import type { SettingsPayload, WritableSettings } from "@/settings/contracts";

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
const WRITABLE_SETTINGS_REVISION_KEY = "__writableSettingsRevision";

beforeEach(() => {
  vi.stubEnv("ANALYSIS_MODEL", "");
  vi.stubEnv("ANALYSIS_EFFORT", "");
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setDbForTests(null);
  handle.sqlite.close();
});

function jsonReq(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { host: new URL(url).host, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function settingsReq(body: unknown, ifMatch?: string): Request {
  const headers: Record<string, string> = {
    host: "localhost",
    "content-type": "application/json",
  };
  if (ifMatch !== undefined) headers["if-match"] = ifMatch;
  return new Request("http://localhost/api/settings", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function currentSettings(): Promise<{
  response: Response;
  body: SettingsPayload;
  etag: string;
}> {
  const response = await settingsGET();
  const body = await response.json() as SettingsPayload;
  const etag = response.headers.get("etag");
  expect(typeof etag).toBe("string");
  expect(etag!).toMatch(/^"[0-9a-f]{64}"$/);
  return { response, body, etag: etag! };
}

function expectFullSettingsPayload(body: SettingsPayload): void {
  expect(Object.keys(body).sort()).toEqual([
    "analysisEffort",
    "analysisEffortOptions",
    "analysisModel",
    "analysisModelOptions",
    "capabilities",
    "revision",
    "sources",
  ]);
  expect(body.analysisModelOptions).toEqual([
    "auto",
    "claude-haiku-4-5",
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
  ]);
  expect(body.analysisEffortOptions).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(Object.keys(body.capabilities).sort()).toEqual([
    "fixtureMode",
    "hasAnthropicKey",
    "hasFinnhubKey",
    "hasFmpKey",
    "hasFredKey",
  ]);
  for (const value of Object.values(body.capabilities)) expect(typeof value).toBe("boolean");
}

function physicalSettings(): Record<string, string> {
  return Object.fromEntries(
    handle.db.select().from(settings).all().map((row) => [row.key, row.value]),
  );
}

function waitForWorkerState(worker: Worker, wanted: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: { state?: string; error?: string }): void => {
      if (message.error !== undefined) {
        cleanup();
        reject(new Error(message.error));
      } else if (message.state === wanted) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

function interleaveAfterFirstRead(db: ThesisDb, afterRead: () => void): ThesisDb {
  let fired = false;

  const wrap = (value: unknown): unknown => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      return value;
    }
    return new Proxy(value as object, {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver) as unknown;
        if (typeof member !== "function") return member;
        return (...args: unknown[]): unknown => {
          const result = Reflect.apply(member, target, args);
          if (!fired && (property === "get" || property === "all" || property === "values")) {
            fired = true;
            afterRead();
          }
          return wrap(result);
        };
      },
    });
  };

  return new Proxy(db, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver) as unknown;
      if (typeof member !== "function") return member;
      if (property === "transaction") {
        return (callback: (tx: ThesisDb) => unknown, ...rest: unknown[]): unknown =>
          Reflect.apply(member, target, [
            (tx: ThesisDb) => callback(wrap(tx) as ThesisDb),
            ...rest,
          ]);
      }
      return (...args: unknown[]): unknown => wrap(Reflect.apply(member, target, args));
    },
  }) as ThesisDb;
}

/* ------------------------------------------------------------------------ *
 * /api/settings
 * ------------------------------------------------------------------------ */

describe("GET /api/settings", () => {
  it("returns the current model/effort, the option lists, and capability flags", async () => {
    const { response: res, body } = await currentSettings();
    expect(res.status).toBe(200);
    expect(body.analysisModelOptions).toEqual([
      "auto",
      "claude-haiku-4-5",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
    ]);
    expect(typeof body.analysisModel).toBe("string");
    expect(body.analysisEffortOptions).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(body.analysisEffortOptions).toContain(body.analysisEffort);
    // Capability flags are booleans (values depend on the ambient env).
    for (const key of ["hasFmpKey", "hasFinnhubKey", "hasFredKey", "hasAnthropicKey", "fixtureMode"]) {
      expect(typeof body.capabilities[key as keyof typeof body.capabilities]).toBe("boolean");
    }
    expect(Object.keys(body.capabilities).sort()).toEqual([
      "fixtureMode",
      "hasAnthropicKey",
      "hasFinnhubKey",
      "hasFmpKey",
      "hasFredKey",
    ]);
    expect(body.sources).toEqual({ analysisModel: "default", analysisEffort: "default" });
    expect(body.revision).toBe(0);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(Object.keys(body).sort()).toEqual([
      "analysisEffort",
      "analysisEffortOptions",
      "analysisModel",
      "analysisModelOptions",
      "capabilities",
      "revision",
      "sources",
    ]);
  });

  it("resolves writable values from the live trimmed environment without config-cache coupling", async () => {
    vi.stubEnv("ANALYSIS_MODEL", "  claude-sonnet-5  ");
    vi.stubEnv("ANALYSIS_EFFORT", "  xhigh  ");
    const first = await currentSettings();
    expect(first.body).toMatchObject({
      analysisModel: "claude-sonnet-5",
      analysisEffort: "xhigh",
      sources: { analysisModel: "environment", analysisEffort: "environment" },
      revision: 0,
    });

    vi.stubEnv("ANALYSIS_EFFORT", "medium");
    const second = await currentSettings();
    expect(second.body).toMatchObject({
      analysisModel: "claude-sonnet-5",
      analysisEffort: "medium",
      sources: { analysisModel: "environment", analysisEffort: "environment" },
    });
    expect(second.etag).not.toBe(first.etag);

    vi.stubEnv("ANALYSIS_MODEL", "claude-opus-4-8");
    const third = await currentSettings();
    expect(third.body).toMatchObject({
      analysisModel: "claude-opus-4-8",
      analysisEffort: "medium",
      sources: { analysisModel: "environment", analysisEffort: "environment" },
    });
    expect(third.etag).not.toBe(second.etag);
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
      const before = await currentSettings();
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
      expect(res.headers.get("etag")).toBe(before.etag);
      expect(JSON.stringify(body)).not.toContain("k-fmp");
      expect(JSON.stringify(body)).not.toContain("k-fred");
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
  // Task 29 full-state compare-and-swap coverage begins here.

  const BASE: WritableSettings = {
    analysisModel: "auto",
    analysisEffort: "high",
  };
  const A: WritableSettings = {
    analysisModel: "claude-opus-4-8",
    analysisEffort: "medium",
  };
  const B: WritableSettings = {
    analysisModel: "claude-sonnet-5",
    analysisEffort: "max",
  };

  it.each([
    ["missing", undefined],
    ["unquoted", "settings-0"],
    ["weak", 'W/"settings-0"'],
    ["wildcard", "*"],
    ["list", '"settings-0", "settings-1"'],
    ["empty", ""],
  ])("returns 428 for a %s If-Match before parsing or mutating", async (_label, tag) => {
    const before = physicalSettings();
    const headers: Record<string, string> = {
      host: "localhost",
      "content-type": "application/json",
    };
    if (tag !== undefined) headers["if-match"] = tag;
    const response = await settingsPOST(new Request("http://localhost/api/settings", {
      method: "POST",
      headers,
      body: "not-json{",
    }));

    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({ error: "a strong If-Match header is required" });
    expect(physicalSettings()).toEqual(before);
  });

  it.each(['"opaque!nonhex"', '""', '"\u0080"'])(
    "treats a single well-formed strong opaque nonmatch %s as stale and returns authority",
    async (staleTag) => {
    const before = physicalSettings();
    const response = await settingsPOST(settingsReq(
      { analysisModel: "new-unsupported-model", analysisEffort: "medium" },
      staleTag,
    ));
    const body = await response.json() as SettingsPayload;

    expect(response.status).toBe(412);
    expect(body).toMatchObject(BASE);
    expectFullSettingsPayload(body);
    expect(body.revision).toBe(0);
    expect(body.sources).toEqual({ analysisModel: "default", analysisEffort: "default" });
    const current = await currentSettings();
    expect(response.headers.get("etag")).toBe(current.etag);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(physicalSettings()).toEqual(before);
    },
  );

  it("rejects malformed JSON only after a valid current precondition", async () => {
    const { etag } = await currentSettings();
    const response = await settingsPOST(new Request("http://localhost/api/settings", {
      method: "POST",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        "if-match": etag,
      },
      body: "oops{",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "request body must be JSON" });
    expect(physicalSettings()).toEqual({});
  });

  it.each([
    ["missing effort", { analysisModel: "auto" }],
    ["missing model", { analysisEffort: "high" }],
    ["empty object", {}],
    ["extra legacy key", { ...BASE, verifyModel: "legacy" }],
    ["extra secret key", { ...BASE, anthropicApiKey: "TASK29-secret" }],
    ["extra capability key", { ...BASE, capabilities: { fixtureMode: false } }],
    ["extra revision", { ...BASE, revision: 0 }],
    ["null model", { ...BASE, analysisModel: null }],
    ["null effort", { ...BASE, analysisEffort: null }],
    ["array", [BASE]],
    ["invalid effort", { ...BASE, analysisEffort: "turbo" }],
    ["numeric model", { ...BASE, analysisModel: 4 }],
    ["oversized model", { ...BASE, analysisModel: `claude-${"x".repeat(70_000)}` }],
  ])("rejects an exact-body violation (%s) with zero writes", async (_label, requestBody) => {
    const { etag } = await currentSettings();
    const before = physicalSettings();
    const response = await settingsPOST(settingsReq(requestBody, etag));
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "invalid settings" });
    expect(JSON.stringify(body)).not.toContain("TASK29-secret");
    expect(physicalSettings()).toEqual(before);
  });

  it.each([
    ["partial", { analysisModel: "auto" }],
    ["extra", { ...BASE, verifyModel: "legacy" }],
    ["oversized", { ...BASE, analysisModel: `claude-${"x".repeat(70_000)}` }],
  ])("rejects a structurally %s body before any database access", async (_label, requestBody) => {
    const { etag } = await currentSettings();
    const throwingDb = new Proxy(handle.db, {
      get() {
        throw new Error("TASK29 database must not be touched");
      },
    }) as ThesisDb;
    setDbForTests(throwingDb);
    try {
      const response = await settingsPOST(settingsReq(requestBody, etag));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid settings" });
    } finally {
      setDbForTests(handle.db);
    }
    expect(physicalSettings()).toEqual({});
  });

  it("atomically writes the full pair and advances one committed revision", async () => {
    const { etag } = await currentSettings();
    const response = await settingsPOST(settingsReq(A, etag));
    const body = await response.json() as SettingsPayload;
    const nextTag = response.headers.get("etag");

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ...A,
      sources: { analysisModel: "database", analysisEffort: "database" },
      revision: 1,
    });
    expectFullSettingsPayload(body);
    expect(nextTag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(nextTag).not.toBe(etag);
    expect(nextTag).not.toContain(A.analysisModel);
    expect(nextTag).not.toContain(A.analysisEffort);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(physicalSettings()).toEqual({
      [SETTING_KEYS.analysisModel]: A.analysisModel,
      [SETTING_KEYS.analysisEffort]: A.analysisEffort,
      [WRITABLE_SETTINGS_REVISION_KEY]: "1",
    });
    const current = await currentSettings();
    expect(current.etag).toBe(nextTag);
    expect(current.body).toEqual(body);
  });

  it("advances revision for accepted effective no-ops without materializing inherited rows", async () => {
    const first = await currentSettings();
    const response1 = await settingsPOST(settingsReq(BASE, first.etag));
    const body1 = await response1.json() as SettingsPayload;
    expect(response1.status).toBe(200);
    const tag1 = response1.headers.get("etag");
    expect(tag1).toMatch(/^"[0-9a-f]{64}"$/);
    expect(tag1).not.toBe(first.etag);
    expect(body1.revision).toBe(1);
    expect(body1.sources).toEqual({ analysisModel: "default", analysisEffort: "default" });
    expect(physicalSettings()).toEqual({ [WRITABLE_SETTINGS_REVISION_KEY]: "1" });

    const response2 = await settingsPOST(settingsReq(BASE, tag1!));
    const body2 = await response2.json() as SettingsPayload;
    expect(response2.status).toBe(200);
    expect(response2.headers.get("etag")).not.toBe(tag1);
    expect(body2.revision).toBe(2);
    expect(physicalSettings()).toEqual({ [WRITABLE_SETTINGS_REVISION_KEY]: "2" });
  });

  it("preserves an inherited model row when only effort changes", async () => {
    vi.stubEnv("ANALYSIS_MODEL", "claude-sonnet-5");
    const { body: before, etag } = await currentSettings();
    expect(before).toMatchObject({
      analysisModel: "claude-sonnet-5",
      sources: { analysisModel: "environment", analysisEffort: "default" },
    });

    const response = await settingsPOST(settingsReq({
      analysisModel: "claude-sonnet-5",
      analysisEffort: "medium",
    }, etag));
    expect(response.status).toBe(200);
    expect(physicalSettings()).toEqual({
      [SETTING_KEYS.analysisEffort]: "medium",
      [WRITABLE_SETTINGS_REVISION_KEY]: "1",
    });
  });

  it("preserves an inherited effort row when only model changes", async () => {
    vi.stubEnv("ANALYSIS_EFFORT", "medium");
    const { body: before, etag } = await currentSettings();
    expect(before).toMatchObject({
      analysisEffort: "medium",
      sources: { analysisModel: "default", analysisEffort: "environment" },
    });

    const response = await settingsPOST(settingsReq({
      analysisModel: "claude-opus-4-8",
      analysisEffort: "medium",
    }, etag));
    expect(response.status).toBe(200);
    expect(physicalSettings()).toEqual({
      [SETTING_KEYS.analysisModel]: "claude-opus-4-8",
      [WRITABLE_SETTINGS_REVISION_KEY]: "1",
    });
  });

  it("allows exactly one of two same-tag writers and never stores the losing pair", async () => {
    const { etag } = await currentSettings();
    const [first, second] = await Promise.all([
      settingsPOST(settingsReq(A, etag)),
      settingsPOST(settingsReq(B, etag)),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 412]);
    const winnerResponse = first.status === 200 ? first : second;
    const loserResponse = first.status === 200 ? second : first;
    const winner = first.status === 200 ? A : B;
    const loser = first.status === 200 ? B : A;
    const winnerBody = await winnerResponse.json() as SettingsPayload;
    const loserBody = await loserResponse.json() as SettingsPayload;
    expect(loserBody).toEqual(winnerBody);
    expect(loserResponse.headers.get("etag")).toBe(winnerResponse.headers.get("etag"));
    expect(loserResponse.headers.get("cache-control")).toContain("no-store");
    const current = await currentSettings();
    expect(current.body).toMatchObject({ ...winner, revision: 1 });
    expect(current.etag).toBe(winnerResponse.headers.get("etag"));
    expect(Object.values(physicalSettings())).not.toContain(loser.analysisModel);
    expect(Object.values(physicalSettings())).not.toContain(loser.analysisEffort);
  });

  it("serializes two identical no-op writers by revision even though values and sources do not change", async () => {
    const { etag } = await currentSettings();
    const [first, second] = await Promise.all([
      settingsPOST(settingsReq(BASE, etag)),
      settingsPOST(settingsReq(BASE, etag)),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 412]);
    const winner = first.status === 200 ? first : second;
    const loser = first.status === 200 ? second : first;
    expect(loser.headers.get("etag")).toBe(winner.headers.get("etag"));
    expect(await loser.json()).toEqual(await winner.json());
    expect((await currentSettings()).etag).toBe(winner.headers.get("etag"));
    expect(physicalSettings()).toEqual({ [WRITABLE_SETTINGS_REVISION_KEY]: "1" });
  });

  it("excludes unrelated settings from the ETag and preserves them byte-for-byte", async () => {
    setSetting("verifyModel", "legacy-verifier");
    setSetting("cacheMaintenanceStamp", "stamp-before");
    const first = await currentSettings();
    setSetting("cacheMaintenanceStamp", "stamp-after");
    const second = await currentSettings();
    expect(second.etag).toBe(first.etag);

    const response = await settingsPOST(settingsReq(A, first.etag));
    expect(response.status).toBe(200);
    expect(physicalSettings()).toMatchObject({
      verifyModel: "legacy-verifier",
      cacheMaintenanceStamp: "stamp-after",
    });
  });

  it("changes the ETag when row presence/source changes despite the same effective value", async () => {
    const first = await currentSettings();
    setSetting(SETTING_KEYS.analysisModel, "auto");
    const second = await currentSettings();
    expect(second.body.analysisModel).toBe(first.body.analysisModel);
    expect(second.body.revision).toBe(first.body.revision);
    expect(second.body.sources.analysisModel).toBe("database");
    expect(second.etag).not.toBe(first.etag);
  });

  it("carries forward the exact current valid dated model without materializing it", async () => {
    const dated = "claude-opus-4-8-20260601";
    vi.stubEnv("ANALYSIS_MODEL", dated);
    const { body: before, etag } = await currentSettings();
    expect(before).toMatchObject({
      analysisModel: dated,
      sources: { analysisModel: "environment", analysisEffort: "default" },
    });

    const response = await settingsPOST(settingsReq({
      analysisModel: dated,
      analysisEffort: "medium",
    }, etag));
    expect(response.status).toBe(200);
    expect(physicalSettings()).toEqual({
      [SETTING_KEYS.analysisEffort]: "medium",
      [WRITABLE_SETTINGS_REVISION_KEY]: "1",
    });
  });

  it("carries forward an exact valid dated model already persisted in the database", async () => {
    const dated = "claude-opus-4-8-20260601";
    setSetting(SETTING_KEYS.analysisModel, dated);
    const { body: before, etag } = await currentSettings();
    expect(before).toMatchObject({
      analysisModel: dated,
      sources: { analysisModel: "database", analysisEffort: "default" },
    });

    const response = await settingsPOST(settingsReq({
      analysisModel: dated,
      analysisEffort: "medium",
    }, etag));
    const body = await response.json() as SettingsPayload;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      analysisModel: dated,
      analysisEffort: "medium",
      sources: { analysisModel: "database", analysisEffort: "database" },
      revision: 1,
    });
    expect(physicalSettings()).toEqual({
      [SETTING_KEYS.analysisModel]: dated,
      [SETTING_KEYS.analysisEffort]: "medium",
      [WRITABLE_SETTINGS_REVISION_KEY]: "1",
    });
  });

  it.each([
    ["new unlisted dated", "claude-opus-4-8-20260601"],
    ["unpriced mystery", "mystery-model"],
    ["malformed dated suffix", "claude-opus-4-8-2026060"],
  ])("rejects a %s model after a fresh CAS comparison", async (_label, analysisModel) => {
    const { etag } = await currentSettings();
    const response = await settingsPOST(settingsReq({ analysisModel, analysisEffort: "medium" }, etag));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid settings" });
    expect(physicalSettings()).toEqual({});
  });

  it("surfaces an invalid legacy current model but requires a supported repair before effort changes", async () => {
    vi.stubEnv("ANALYSIS_MODEL", "legacy-mystery-model");
    const initial = await currentSettings();
    expect(initial.body).toMatchObject({
      analysisModel: "legacy-mystery-model",
      sources: { analysisModel: "environment" },
    });

    const carry = await settingsPOST(settingsReq({
      analysisModel: "legacy-mystery-model",
      analysisEffort: "medium",
    }, initial.etag));
    expect(carry.status).toBe(400);
    expect(physicalSettings()).toEqual({});

    const repair = await settingsPOST(settingsReq({
      analysisModel: "auto",
      analysisEffort: "medium",
    }, initial.etag));
    expect(repair.status).toBe(200);
    expect(physicalSettings()).toEqual({
      [SETTING_KEYS.analysisModel]: "auto",
      [SETTING_KEYS.analysisEffort]: "medium",
      [WRITABLE_SETTINGS_REVISION_KEY]: "1",
    });
  });

  it("surfaces and repairs an invalid legacy model persisted in the database", async () => {
    setSetting(SETTING_KEYS.analysisModel, "legacy-database-model");
    setSetting(SETTING_KEYS.analysisEffort, "high");
    const initial = await currentSettings();
    expect(initial.body).toMatchObject({
      analysisModel: "legacy-database-model",
      analysisEffort: "high",
      sources: { analysisModel: "database", analysisEffort: "database" },
    });

    const carry = await settingsPOST(settingsReq({
      analysisModel: "legacy-database-model",
      analysisEffort: "medium",
    }, initial.etag));
    expect(carry.status).toBe(400);
    expect(physicalSettings()).toMatchObject({
      [SETTING_KEYS.analysisModel]: "legacy-database-model",
      [SETTING_KEYS.analysisEffort]: "high",
    });

    const repair = await settingsPOST(settingsReq({
      analysisModel: "auto",
      analysisEffort: "medium",
    }, initial.etag));
    expect(repair.status).toBe(200);
    expect(await repair.json()).toMatchObject({
      analysisModel: "auto",
      analysisEffort: "medium",
      sources: { analysisModel: "database", analysisEffort: "database" },
      revision: 1,
    });
    expect(physicalSettings()).toEqual({
      [SETTING_KEYS.analysisModel]: "auto",
      [SETTING_KEYS.analysisEffort]: "medium",
      [WRITABLE_SETTINGS_REVISION_KEY]: "1",
    });
  });

  it("rolls back the first pair write when the second pair upsert fails and sanitizes the error", async () => {
    handle.sqlite.exec(`
      CREATE TRIGGER task29_reject_second_pair
      BEFORE INSERT ON settings
      WHEN NEW.key IN ('analysisModel', 'analysisEffort')
        AND (SELECT count(*) FROM settings WHERE key IN ('analysisModel', 'analysisEffort')) = 1
      BEGIN
        SELECT RAISE(ABORT, 'TASK29 secret second-upsert');
      END;
    `);
    const { etag } = await currentSettings();
    const response = await settingsPOST(settingsReq(A, etag));
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toContain("settings storage failure");
    expect(text).not.toContain("TASK29 secret");
    expect(physicalSettings()).toEqual({});
  });

  it("rolls back both pair rows when the revision write fails and sanitizes the error", async () => {
    handle.sqlite.exec(`
      CREATE TRIGGER task29_reject_revision
      BEFORE INSERT ON settings
      WHEN NEW.key = '${WRITABLE_SETTINGS_REVISION_KEY}'
      BEGIN
        SELECT RAISE(ABORT, 'TASK29 secret revision');
      END;
    `);
    const { etag } = await currentSettings();
    const response = await settingsPOST(settingsReq(A, etag));
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toContain("settings storage failure");
    expect(text).not.toContain("TASK29 secret");
    expect(physicalSettings()).toEqual({});
  });

  it("rolls back to existing bytes when the second pair UPDATE fails", async () => {
    setSetting(SETTING_KEYS.analysisModel, A.analysisModel);
    setSetting(SETTING_KEYS.analysisEffort, A.analysisEffort);
    setSetting(WRITABLE_SETTINGS_REVISION_KEY, "4");
    handle.sqlite.exec(`
      CREATE TABLE task29_pair_update_counter (value INTEGER NOT NULL);
      INSERT INTO task29_pair_update_counter (value) VALUES (0);
      CREATE TRIGGER task29_reject_second_pair_update
      BEFORE UPDATE ON settings
      WHEN NEW.key IN ('analysisModel', 'analysisEffort')
      BEGIN
        UPDATE task29_pair_update_counter SET value = value + 1;
        SELECT CASE
          WHEN (SELECT value FROM task29_pair_update_counter) = 2
          THEN RAISE(ABORT, 'TASK29 secret second-update')
        END;
      END;
    `);
    const { etag } = await currentSettings();
    const before = physicalSettings();
    const response = await settingsPOST(settingsReq(B, etag));
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toContain("settings storage failure");
    expect(text).not.toContain("TASK29 secret");
    expect(physicalSettings()).toEqual(before);
    expect(handle.sqlite.prepare(
      "SELECT value FROM task29_pair_update_counter",
    ).pluck().get()).toBe(0);
  });

  it("rolls back updated pair rows when the revision UPDATE fails", async () => {
    setSetting(SETTING_KEYS.analysisModel, A.analysisModel);
    setSetting(SETTING_KEYS.analysisEffort, A.analysisEffort);
    setSetting(WRITABLE_SETTINGS_REVISION_KEY, "4");
    handle.sqlite.exec(`
      CREATE TRIGGER task29_reject_revision_update
      BEFORE UPDATE ON settings
      WHEN OLD.key = '${WRITABLE_SETTINGS_REVISION_KEY}'
      BEGIN
        SELECT RAISE(ABORT, 'TASK29 secret revision-update');
      END;
    `);
    const { etag } = await currentSettings();
    const before = physicalSettings();
    const response = await settingsPOST(settingsReq(B, etag));
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toContain("settings storage failure");
    expect(text).not.toContain("TASK29 secret");
    expect(physicalSettings()).toEqual(before);
  });

  it("upgrades a legacy missing revision from zero to one", async () => {
    setSetting(SETTING_KEYS.analysisModel, "claude-opus-4-8");
    setSetting(SETTING_KEYS.analysisEffort, "medium");
    const { body: before, etag } = await currentSettings();
    expect(before.revision).toBe(0);
    const response = await settingsPOST(settingsReq(B, etag));
    expect(response.status).toBe(200);
    expect((await response.json() as SettingsPayload).revision).toBe(1);
    expect(physicalSettings()[WRITABLE_SETTINGS_REVISION_KEY]).toBe("1");
  });

  it.each(["not-an-integer", "1.5", "-1", "9007199254740992"])(
    "fails closed and sanitizes an unsafe persisted revision %s",
    async (revision) => {
      setSetting(WRITABLE_SETTINGS_REVISION_KEY, revision);
      const response = await settingsGET();
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(text).toContain("settings storage failure");
      expect(text).not.toContain(revision);
    },
  );

  it("refuses revision overflow without changing the pair", async () => {
    setSetting(WRITABLE_SETTINGS_REVISION_KEY, String(Number.MAX_SAFE_INTEGER));
    const { etag } = await currentSettings();
    const before = physicalSettings();
    const response = await settingsPOST(settingsReq(A, etag));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "settings storage failure" });
    expect(physicalSettings()).toEqual(before);
  });
});

describe("settings SQLite serialization", () => {
  const EXTERNAL: WritableSettings = {
    analysisModel: "claude-sonnet-5",
    analysisEffort: "max",
  };
  const LOCAL: WritableSettings = {
    analysisModel: "claude-opus-4-8",
    analysisEffort: "medium",
  };

  it("routes the CAS through the settings transaction configured for an immediate writer lock", () => {
    const settingsSource = readFileSync(
      join(process.cwd(), "src", "settings", "settings.ts"),
      "utf8",
    );
    const routeSource = readFileSync(
      join(process.cwd(), "src", "app", "api", "settings", "route.ts"),
      "utf8",
    );
    expect(settingsSource).toContain("compareAndSwapWritableSettings");
    expect(settingsSource.match(/behavior:\s*["']immediate["']/g)).toHaveLength(1);
    expect(routeSource).toContain("compareAndSwapWritableSettings(");
    expect(routeSource).not.toContain("setSetting(");
  });

  it("waits behind an existing writer before reading and comparing the ETag", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thesis-settings-cas-"));
    const file = join(directory, "settings.db");
    const fileHandle = createDatabase(file);
    let worker: Worker | null = null;
    try {
      setDbForTests(fileHandle.db);
      fileHandle.sqlite.pragma("busy_timeout = 5000");
      const initial = await currentSettings();
      worker = new Worker(
        new URL("./fixtures/settingsWriteLockWorker.mjs", import.meta.url),
        { workerData: { file, state: EXTERNAL, revision: 1, holdMs: 500 } },
      );
      const staged = waitForWorkerState(worker, "staged");
      const committed = waitForWorkerState(worker, "committed");
      await staged;

      const response = await settingsPOST(settingsReq(LOCAL, initial.etag));
      const body = await response.json() as SettingsPayload;
      await committed;

      expect(response.status).toBe(412);
      expect(body).toMatchObject({
        ...EXTERNAL,
        sources: { analysisModel: "database", analysisEffort: "database" },
        revision: 1,
      });
      expectFullSettingsPayload(body);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const current = await currentSettings();
      expect(response.headers.get("etag")).toBe(current.etag);
      expect(current.body).toMatchObject(EXTERNAL);
      expect(fileHandle.db.select().from(settings).all()).toEqual(expect.arrayContaining([
        { key: SETTING_KEYS.analysisModel, value: EXTERNAL.analysisModel },
        { key: SETTING_KEYS.analysisEffort, value: EXTERNAL.analysisEffort },
        { key: WRITABLE_SETTINGS_REVISION_KEY, value: "1" },
      ]));
    } finally {
      setDbForTests(handle.db);
      if (worker !== null) await worker.terminate();
      fileHandle.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns an old or new complete snapshot when another handle commits between read executions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thesis-settings-read-"));
    const file = join(directory, "settings.db");
    const fileHandle = createDatabase(file);
    const release = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const releaseView = new Int32Array(release);
    const done = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const doneView = new Int32Array(done);
    let worker: Worker | null = null;
    let interleaved = false;
    try {
      setDbForTests(fileHandle.db);
      const oldAuthority = await currentSettings();
      worker = new Worker(
        new URL("./fixtures/settingsWriteLockWorker.mjs", import.meta.url),
        { workerData: { file, state: EXTERNAL, revision: 1, release, done } },
      );
      const staged = waitForWorkerState(worker, "staged");
      const committed = waitForWorkerState(worker, "committed");
      await staged;
      const proxy = interleaveAfterFirstRead(fileHandle.db, () => {
        interleaved = true;
        Atomics.store(releaseView, 0, 1);
        Atomics.notify(releaseView, 0);
        const result = Atomics.wait(doneView, 0, 0, 5_000);
        if (result === "timed-out" || Atomics.load(doneView, 0) !== 1) {
          throw new Error("settings writer did not commit at the read interleaving point");
        }
      });
      setDbForTests(proxy);

      const response = await settingsGET();
      const body = await response.json() as SettingsPayload;
      await committed;
      setDbForTests(fileHandle.db);
      const newAuthority = await currentSettings();

      expect(interleaved).toBe(true);
      expect(response.status).toBe(200);
      const identity = JSON.stringify({
        analysisModel: body.analysisModel,
        analysisEffort: body.analysisEffort,
        revision: body.revision,
        sources: body.sources,
      });
      const oldIdentity = JSON.stringify({
          analysisModel: "auto",
          analysisEffort: "high",
          revision: 0,
          sources: { analysisModel: "default", analysisEffort: "default" },
        });
      const newIdentity = JSON.stringify({
          ...EXTERNAL,
          revision: 1,
          sources: { analysisModel: "database", analysisEffort: "database" },
        });
      expect([oldIdentity, newIdentity]).toContain(identity);
      expect(response.headers.get("etag")).toBe(
        identity === oldIdentity ? oldAuthority.etag : newAuthority.etag,
      );
    } finally {
      if (Atomics.load(releaseView, 0) === 0) {
        Atomics.store(releaseView, 0, 1);
        Atomics.notify(releaseView, 0);
      }
      setDbForTests(handle.db);
      if (worker !== null) await worker.terminate();
      fileHandle.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
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

  it.each(["ß", "ſ", "ﬀ"])("rejects raw Unicode symbol %s with 400 and adds nothing", async (symbol) => {
    const res = await watchlistPOST(
      jsonReq("http://localhost/api/watchlist", "POST", { symbol }),
    );
    expect(res.status).toBe(400);
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
      new Request("http://localhost/api/watchlist", {
        method: "POST",
        headers: { host: "localhost" },
        body: "bad{",
      }),
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
      new Request("http://localhost/api/watchlist", {
        method: "DELETE",
        headers: { host: "localhost" },
        body: "x{",
      }),
    );
    expect(res.status).toBe(400);
  });

  it.each(["ß", "ſ", "ﬀ"])(
    "rejects raw Unicode DELETE symbol %s without removing its ASCII expansion",
    async (symbol) => {
      await watchlistPOST(
        jsonReq("http://localhost/api/watchlist", "POST", { symbol: symbol.toUpperCase() }),
      );
      const res = await watchlistDELETE(
        jsonReq("http://localhost/api/watchlist", "DELETE", { symbol }),
      );
      expect(res.status).toBe(400);
      expect(handle.db.select().from(watchlist).all().map((row) => row.symbol)).toEqual([
        symbol.toUpperCase(),
      ]);
    },
  );
});
