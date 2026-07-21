/**
 * Unit tests for the db/cache/settings module: cachedFetch fresh/stale/miss
 * paths, cache-key determinism, invalidation helpers, and settings precedence.
 * No network — everything runs against an in-memory better-sqlite3 database
 * injected via setDbForTests().
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  defaultDbPath,
  setDbForTests,
  type DatabaseHandle,
} from "@/db";
import { apiCache } from "@/db/schema";
import {
  buildCacheKey,
  cachedFetch,
  flushPendingRefreshes,
  invalidate,
  purgeOlderThan,
  stableStringify,
  TTL,
} from "@/cache/apiCache";
import {
  DEFAULT_ANALYSIS_EFFORT,
  EFFORT_LEVELS,
  getAnalysisEffortSetting,
  getAnalysisModelSetting,
  getSetting,
  setSetting,
  deleteSetting,
} from "@/settings/settings";

let handle: DatabaseHandle;

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
});

afterEach(async () => {
  await flushPendingRefreshes(); // don't let refreshes leak into the next test
  setDbForTests(null);
  handle.sqlite.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Backdates a cached row so the next cachedFetch sees it as expired. */
function backdate(cacheKey: string, ageSeconds: number): void {
  const past = new Date(Date.now() - ageSeconds * 1000).toISOString();
  handle.db.update(apiCache).set({ fetchedAt: past }).where(eq(apiCache.cacheKey, cacheKey)).run();
}

function readRow(cacheKey: string) {
  return handle.db.select().from(apiCache).where(eq(apiCache.cacheKey, cacheKey)).get();
}

describe("buildCacheKey determinism", () => {
  it("is insensitive to param insertion order (including nested objects)", () => {
    const a = buildCacheKey("fmp", "quote", {
      symbol: "AAPL",
      limit: 10,
      nested: { b: 2, a: 1 },
    });
    const b = buildCacheKey("fmp", "quote", {
      nested: { a: 1, b: 2 },
      limit: 10,
      symbol: "AAPL",
    });
    expect(a).toBe(b);
    expect(a).toBe('fmp|quote|{"limit":10,"nested":{"a":1,"b":2},"symbol":"AAPL"}');
  });

  it("drops undefined params but distinguishes real value changes", () => {
    const base = buildCacheKey("fmp", "quote", { symbol: "AAPL" });
    const withUndefined = buildCacheKey("fmp", "quote", { symbol: "AAPL", page: undefined });
    const different = buildCacheKey("fmp", "quote", { symbol: "MSFT" });
    expect(withUndefined).toBe(base);
    expect(different).not.toBe(base);
    expect(buildCacheKey("fmp", "quote", {})).not.toBe(
      buildCacheKey("finnhub", "quote", {}),
    );
  });

  it("stableStringify preserves array order and null values", () => {
    expect(stableStringify({ ids: [3, 1, 2], flag: null })).toBe('{"flag":null,"ids":[3,1,2]}');
  });
});

describe("default database path", () => {
  it("keeps SQLite WAL/SHM churn outside the project tree by default", () => {
    vi.stubEnv("THESIS_DB_PATH", "");
    vi.stubEnv("THESIS_DATA_DIR", "");

    const dbPath = path.resolve(defaultDbPath());
    const cwd = path.resolve(process.cwd());
    const relative = path.relative(cwd, dbPath);

    expect(dbPath).not.toBe(path.join(cwd, "data", "thesis.db"));
    expect(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))).toBe(false);
  });

  it("honors THESIS_DB_PATH for explicit local overrides", () => {
    const explicit = path.join(process.cwd(), "data", "custom-test.db");
    vi.stubEnv("THESIS_DB_PATH", explicit);

    expect(defaultDbPath()).toBe(explicit);
  });

  it("honors THESIS_DATA_DIR when only the directory is overridden", () => {
    const dir = path.join(os.tmpdir(), "thesis-db-path-test");
    vi.stubEnv("THESIS_DB_PATH", "");
    vi.stubEnv("THESIS_DATA_DIR", dir);

    expect(defaultDbPath()).toBe(path.join(dir, "thesis.db"));
  });

  it("does not silently import a stale workspace DB and reports the active path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "thesis-db-migrate-"));
    const projectDir = path.join(root, "project");
    const appDataDir = path.join(root, "appdata");
    const legacyPath = path.join(projectDir, "data", "thesis.db");
    const targetPath = path.join(appDataDir, "thesis.db");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const legacy = createDatabase(legacyPath);
    legacy.sqlite.prepare('INSERT INTO "settings" ("key", "value") VALUES (?, ?)').run("legacy.marker", "present");
    legacy.sqlite.close();
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    vi.stubEnv("THESIS_DB_PATH", "");
    vi.stubEnv("THESIS_DATA_DIR", appDataDir);
    vi.stubEnv("THESIS_IMPORT_LEGACY_DB", "");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const active = createDatabase();

    expect(fs.existsSync(targetPath)).toBe(true);
    expect(
      active.sqlite.prepare('SELECT "value" FROM "settings" WHERE "key" = ?').get("legacy.marker"),
    ).toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.stringContaining(path.resolve(targetPath)));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(path.resolve(legacyPath)));
    active.sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("points drizzle-kit at the same default DB path instead of ./data/thesis.db", async () => {
    const dir = path.join(os.tmpdir(), "thesis-drizzle-path-test");
    vi.stubEnv("THESIS_DB_PATH", "");
    vi.stubEnv("THESIS_DATA_DIR", dir);
    vi.resetModules();

    const config = (await import("../drizzle.config")).default as {
      dbCredentials?: { url?: string };
    };

    expect(config.dbCredentials?.url).toBe(defaultDbPath());
    expect(path.resolve(config.dbCredentials?.url ?? "")).toBe(path.resolve(dir, "thesis.db"));
  });
});

describe("cachedFetch — miss path", () => {
  it("fetches, stores, and returns a fresh Sourced<T>", async () => {
    const fetcher = vi.fn(async () => ({ body: { price: 123.45 }, asOf: "2026-07-06" }));
    const result = await cachedFetch({
      provider: "fmp",
      endpoint: "quote",
      params: { symbol: "AAPL" },
      ttlSeconds: TTL.QUOTE,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ price: 123.45 });
    expect(result.asOf).toBe("2026-07-06");
    expect(result.source).toBe("fmp");
    expect(result.endpoint).toBe("quote");
    expect(result.stale).toBeUndefined();
    expect(Date.parse(result.fetchedAt)).not.toBeNaN();

    const row = readRow(buildCacheKey("fmp", "quote", { symbol: "AAPL" }));
    expect(row).toBeDefined();
    expect(row?.bodyJson).toBe(JSON.stringify({ price: 123.45 }));
    expect(row?.ttlSeconds).toBe(TTL.QUOTE);
    expect(row?.asOf).toBe("2026-07-06");
  });

  it("propagates fetcher errors on a miss (hard transport failure)", async () => {
    await expect(
      cachedFetch({
        provider: "fred",
        endpoint: "series/observations",
        params: { series_id: "DGS10" },
        ttlSeconds: TTL.MACRO,
        fetcher: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).rejects.toThrow("ECONNREFUSED");
  });
});

describe("cachedFetch — fresh hit path", () => {
  it("serves from cache without calling the fetcher", async () => {
    const first = vi.fn(async () => ({ body: [1, 2, 3], asOf: "2026-07-05" }));
    const opts = {
      provider: "edgar" as const,
      endpoint: "companyfacts",
      params: { cik: "0000320193" },
      ttlSeconds: TTL.FUNDAMENTALS,
    };
    await cachedFetch({ ...opts, fetcher: first });

    const second = vi.fn(async () => ({ body: [9, 9, 9], asOf: "2026-07-06" }));
    // Same params in a different key order must hit the same row.
    const hit = await cachedFetch({
      ...opts,
      params: { cik: "0000320193" },
      fetcher: second,
    });

    expect(second).not.toHaveBeenCalled();
    expect(hit.data).toEqual([1, 2, 3]);
    expect(hit.asOf).toBe("2026-07-05");
    expect(hit.stale).toBeUndefined();
  });
});

describe("cachedFetch — stale (serve-stale-while-revalidate) path", () => {
  const opts = {
    provider: "fmp" as const,
    endpoint: "income-statement",
    params: { symbol: "AAPL", period: "annual" },
    ttlSeconds: TTL.FUNDAMENTALS,
  };
  const key = buildCacheKey(opts.provider, opts.endpoint, opts.params);

  it("returns stale data immediately and refreshes in the background", async () => {
    await cachedFetch({ ...opts, fetcher: async () => ({ body: "old", asOf: "2026-04-01" }) });
    backdate(key, TTL.FUNDAMENTALS + 3600); // 1 h past TTL

    const refresher = vi.fn(async () => ({ body: "new", asOf: "2026-07-01" }));
    const staleResult = await cachedFetch({ ...opts, fetcher: refresher });

    expect(staleResult.stale).toBe(true);
    expect(staleResult.data).toBe("old");
    expect(staleResult.asOf).toBe("2026-04-01");

    await flushPendingRefreshes();
    expect(refresher).toHaveBeenCalledTimes(1);

    const row = readRow(key);
    expect(row?.bodyJson).toBe(JSON.stringify("new"));
    expect(row?.asOf).toBe("2026-07-01");

    // Next read is fresh again and does not re-fetch.
    const after = await cachedFetch({ ...opts, fetcher: refresher });
    expect(after.stale).toBeUndefined();
    expect(after.data).toBe("new");
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it("swallows and logs background refresh failures, keeping stale data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await cachedFetch({ ...opts, fetcher: async () => ({ body: "old", asOf: "2026-04-01" }) });
    backdate(key, TTL.FUNDAMENTALS + 3600);

    const failing = vi.fn(async () => {
      throw new Error("FMP 500");
    });
    const staleResult = await cachedFetch({ ...opts, fetcher: failing });
    expect(staleResult.stale).toBe(true);
    expect(staleResult.data).toBe("old");

    await flushPendingRefreshes();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(readRow(key)?.bodyJson).toBe(JSON.stringify("old")); // unchanged
  });

  it("dedupes concurrent background refreshes for the same key", async () => {
    await cachedFetch({ ...opts, fetcher: async () => ({ body: "old", asOf: "2026-04-01" }) });
    backdate(key, TTL.FUNDAMENTALS + 3600);

    let resolveFetch: (() => void) | undefined;
    const slow = vi.fn(
      () =>
        new Promise<{ body: string; asOf: string }>((resolve) => {
          resolveFetch = () => resolve({ body: "new", asOf: "2026-07-01" });
        }),
    );
    const r1 = await cachedFetch({ ...opts, fetcher: slow });
    const r2 = await cachedFetch({ ...opts, fetcher: slow });
    expect(r1.stale).toBe(true);
    expect(r2.stale).toBe(true);
    expect(slow).toHaveBeenCalledTimes(1); // second stale hit did not start another refresh

    resolveFetch?.();
    await flushPendingRefreshes();
    expect(readRow(key)?.bodyJson).toBe(JSON.stringify("new"));
  });

  it("does not serve stale data beyond maxStaleSeconds; it refreshes synchronously instead", async () => {
    await cachedFetch({ ...opts, fetcher: async () => ({ body: "old", asOf: "2026-04-01" }) });
    backdate(key, TTL.FUNDAMENTALS + 7 * 86_400 + 1);

    const refresher = vi.fn(async () => ({ body: "new", asOf: "2026-07-01" }));
    const result = await cachedFetch({
      ...opts,
      maxStaleSeconds: 7 * 86_400,
      fetcher: refresher,
    });

    expect(result.stale).toBeUndefined();
    expect(result.data).toBe("new");
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(readRow(key)?.bodyJson).toBe(JSON.stringify("new"));
  });

  it("propagates refresh failures once cached data is beyond maxStaleSeconds", async () => {
    await cachedFetch({ ...opts, fetcher: async () => ({ body: "old", asOf: "2026-04-01" }) });
    backdate(key, TTL.FUNDAMENTALS + 7 * 86_400 + 1);

    await expect(
      cachedFetch({
        ...opts,
        maxStaleSeconds: 7 * 86_400,
        fetcher: async () => {
          throw new Error("FMP entitlement failed");
        },
      }),
    ).rejects.toThrow("FMP entitlement failed");
    expect(readRow(key)?.bodyJson).toBe(JSON.stringify("old"));
  });
});

describe("cachedFetch — empty body never clobbers good cached data (M6)", () => {
  // FMP wraps responses as { body, status, fetchedAt }; a transient 200-[] means
  // body === []. isEmptyBody detects that so an empty refresh cannot wipe a
  // previously-good non-empty statement/price body for the whole TTL.
  const isEmptyBody = (b: { body?: unknown }): boolean => Array.isArray(b.body) && b.body.length === 0;
  const opts = {
    provider: "fmp" as const,
    endpoint: "income-statement",
    params: { symbol: "AAPL" },
    ttlSeconds: TTL.FUNDAMENTALS,
    isEmptyBody,
  };
  const key = buildCacheKey(opts.provider, opts.endpoint, opts.params);

  it("keeps the good rows when a background refresh returns an empty array", async () => {
    await cachedFetch({ ...opts, fetcher: async () => ({ body: { body: [{ revenue: 1 }], status: 200 }, asOf: "2026-04-01" }) });
    backdate(key, TTL.FUNDAMENTALS + 3600);

    const emptyRefresh = vi.fn(async () => ({ body: { body: [], status: 200 }, asOf: "2026-07-01" }));
    const stale = await cachedFetch({ ...opts, fetcher: emptyRefresh });
    // Serves the good stale data immediately (not the incoming empty).
    expect(stale.stale).toBe(true);
    expect(stale.data).toEqual({ body: [{ revenue: 1 }], status: 200 });

    await flushPendingRefreshes();
    expect(emptyRefresh).toHaveBeenCalledTimes(1);

    // The good row SURVIVED the empty refresh — it was not clobbered.
    const row = readRow(key);
    expect(JSON.parse(row!.bodyJson)).toEqual({ body: [{ revenue: 1 }], status: 200 });
    expect(row?.asOf).toBe("2026-04-01");

    // A subsequent read (still expired) again serves the good data.
    const again = await cachedFetch({ ...opts, fetcher: async () => ({ body: { body: [], status: 200 }, asOf: "2026-07-02" }) });
    expect(again.data).toEqual({ body: [{ revenue: 1 }], status: 200 });
    expect(again.staleReason).toBe("empty-refresh-preserved");
    await flushPendingRefreshes();
  });

  it("stops preserving an empty refresh once the absolute stale ceiling is exceeded", async () => {
    await cachedFetch({ ...opts, fetcher: async () => ({ body: { body: [{ revenue: 1 }], status: 200 }, asOf: "2026-04-01" }) });
    // Beyond ttl + maxStaleSeconds → the synchronous fetchStoreReturn path.
    backdate(key, TTL.FUNDAMENTALS + 8 * 86_400);

    const refreshed = await cachedFetch({
      ...opts,
      maxStaleSeconds: 7 * 86_400,
      fetcher: async () => ({ body: { body: [], status: 200 }, asOf: "2026-07-09" }),
    });
    // At the hard ceiling the authoritative empty body replaces the old row.
    expect(refreshed.data).toEqual({ body: [], status: 200 });
    expect(refreshed.stale).toBeUndefined();
    expect(refreshed.asOf).toBe("2026-07-09");
    expect(JSON.parse(readRow(key)!.bodyJson)).toEqual({ body: [], status: 200 });
  });

  it("caches an empty array on FIRST fetch (segmentation expected-empty still works)", async () => {
    const segKey = buildCacheKey("fmp", "revenue-geographic", { symbol: "AAPL" });
    await cachedFetch({
      provider: "fmp",
      endpoint: "revenue-geographic",
      params: { symbol: "AAPL" },
      ttlSeconds: TTL.FUNDAMENTALS,
      isEmptyBody,
      fetcher: async () => ({ body: { body: [], status: 200 }, asOf: "2026-07-01" }),
    });
    const row = readRow(segKey);
    expect(row).toBeDefined();
    expect(JSON.parse(row!.bodyJson)).toEqual({ body: [], status: 200 });
  });

  it("without isEmptyBody, an empty refresh overwrites as before (behavior unchanged for other providers)", async () => {
    const bareOpts = { provider: "fred" as const, endpoint: "series/x", params: {}, ttlSeconds: TTL.MACRO };
    const bareKey = buildCacheKey(bareOpts.provider, bareOpts.endpoint, bareOpts.params);
    await cachedFetch({ ...bareOpts, fetcher: async () => ({ body: [1, 2, 3], asOf: "2026-04-01" }) });
    backdate(bareKey, TTL.MACRO + 3600);
    await cachedFetch({ ...bareOpts, fetcher: async () => ({ body: [], asOf: "2026-07-01" }) });
    await flushPendingRefreshes();
    expect(JSON.parse(readRow(bareKey)!.bodyJson)).toEqual([]); // overwritten (no guard configured)
  });
});

describe("cachedFetch — corrupt row self-heals instead of crash-looping (L6)", () => {
  it("deletes an undecodable (bad gzip) row and refetches", async () => {
    const key = buildCacheKey("fmp", "quote", { symbol: "AAPL" });
    // Seed a FRESH row whose bodyGz is not valid gzip → decodeCacheBody throws.
    handle.db
      .insert(apiCache)
      .values({
        cacheKey: key,
        provider: "fmp",
        endpoint: "quote",
        paramsJson: "{}",
        bodyJson: "",
        bodyGz: Buffer.from("not-actually-gzip"),
        fetchedAt: new Date().toISOString(),
        ttlSeconds: TTL.QUOTE,
        asOf: "2026-07-06",
      })
      .run();

    const fetcher = vi.fn(async () => ({ body: { price: 999 }, asOf: "2026-07-07" }));
    const result = await cachedFetch({
      provider: "fmp",
      endpoint: "quote",
      params: { symbol: "AAPL" },
      ttlSeconds: TTL.QUOTE,
      fetcher,
    });

    // Refetched (self-heal) rather than throwing the gunzip error.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ price: 999 });
    // The healed row is valid and freshly stored.
    const row = readRow(key);
    expect(row?.bodyJson).toBe(JSON.stringify({ price: 999 }));
    expect(row?.asOf).toBe("2026-07-07");
  });

  it("deletes a row with valid decode but malformed JSON and refetches", async () => {
    const key = buildCacheKey("fmp", "quote", { symbol: "MSFT" });
    handle.db
      .insert(apiCache)
      .values({
        cacheKey: key,
        provider: "fmp",
        endpoint: "quote",
        paramsJson: "{}",
        bodyJson: "{ this is not json",
        bodyGz: null,
        fetchedAt: new Date().toISOString(),
        ttlSeconds: TTL.QUOTE,
        asOf: "2026-07-06",
      })
      .run();

    const fetcher = vi.fn(async () => ({ body: { price: 5 }, asOf: "2026-07-07" }));
    const result = await cachedFetch({ provider: "fmp", endpoint: "quote", params: { symbol: "MSFT" }, ttlSeconds: TTL.QUOTE, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ price: 5 });
    expect(readRow(key)?.bodyJson).toBe(JSON.stringify({ price: 5 }));
  });
});

describe("invalidate / purgeOlderThan", () => {
  async function seed(provider: "fmp" | "fred", endpoint: string, symbol: string): Promise<string> {
    await cachedFetch({
      provider,
      endpoint,
      params: { symbol },
      ttlSeconds: TTL.QUOTE,
      fetcher: async () => ({ body: symbol, asOf: "2026-07-06" }),
    });
    return buildCacheKey(provider, endpoint, { symbol });
  }

  it("invalidate deletes only matching provider + endpoint prefix", async () => {
    await seed("fmp", "quote", "AAPL");
    await seed("fmp", "quote", "MSFT");
    await seed("fmp", "income-statement", "AAPL");
    await seed("fred", "quote", "DGS10");

    expect(invalidate("fmp", "quote")).toBe(2);
    expect(readRow(buildCacheKey("fmp", "quote", { symbol: "AAPL" }))).toBeUndefined();
    expect(readRow(buildCacheKey("fmp", "income-statement", { symbol: "AAPL" }))).toBeDefined();
    expect(readRow(buildCacheKey("fred", "quote", { symbol: "DGS10" }))).toBeDefined();

    // Empty prefix wipes the whole provider.
    expect(invalidate("fmp")).toBe(1);
    expect(invalidate("fmp")).toBe(0);
  });

  it("escapes SQL LIKE wildcards in the endpoint prefix", async () => {
    await seed("fmp", "a_b", "X");
    await seed("fmp", "axb", "X");
    expect(invalidate("fmp", "a_b")).toBe(1); // must not match "axb" via `_`
    expect(readRow(buildCacheKey("fmp", "axb", { symbol: "X" }))).toBeDefined();
  });

  it("purgeOlderThan removes rows by fetch age", async () => {
    const oldKey = await seed("fmp", "quote", "AAPL");
    const newKey = await seed("fmp", "quote", "MSFT");
    backdate(oldKey, 8 * 86_400); // 8 days old

    expect(purgeOlderThan(7 * 86_400)).toBe(1);
    expect(readRow(oldKey)).toBeUndefined();
    expect(readRow(newKey)).toBeDefined();
  });
});

describe("TTL constants (the provider data contract §3)", () => {
  it("match the spec values", () => {
    expect(TTL.QUOTE).toBe(900);
    expect(TTL.EOD).toBe(900);
    expect(TTL.FUNDAMENTALS).toBe(86_400);
    expect(TTL.ESTIMATES).toBe(86_400);
    expect(TTL.TRANSCRIPT).toBe(10 * 365 * 86_400);
    expect(TTL.FILINGS).toBe(10 * 365 * 86_400);
    expect(TTL.INSIDER).toBe(86_400);
    expect(TTL.THIRTEEN_F).toBe(86_400);
    expect(TTL.NEWS).toBe(21_600);
    expect(TTL.MACRO).toBe(14_400);
    expect(TTL.TREASURY).toBe(7_200);
    expect(TTL.SECTOR).toBe(3_600);
    expect(TTL.SHORT_INTEREST).toBe(86_400);
  });
});

describe("settings", () => {
  it("getSetting returns fallback until set, then persisted value", () => {
    expect(getSetting("someKey", "dflt")).toBe("dflt");
    setSetting("someKey", "v1");
    expect(getSetting("someKey", "dflt")).toBe("v1");
    setSetting("someKey", "v2"); // upsert
    expect(getSetting("someKey", "dflt")).toBe("v2");
    deleteSetting("someKey");
    expect(getSetting("someKey", "dflt")).toBe("dflt");
  });

  it("getAnalysisModelSetting: table overrides env overrides 'auto' default", () => {
    vi.stubEnv("ANALYSIS_MODEL", ""); // empty env = unset, regardless of host machine
    expect(getAnalysisModelSetting()).toBe("auto");
    vi.stubEnv("ANALYSIS_MODEL", "claude-sonnet-5");
    expect(getAnalysisModelSetting()).toBe("claude-sonnet-5");
    setSetting("analysisModel", "claude-fable-5");
    expect(getAnalysisModelSetting()).toBe("claude-fable-5");
  });

  it("a stray legacy verifyModel row is inert (nothing reads the removed key)", () => {
    // Existing databases may still carry the row; it must not break anything.
    setSetting("verifyModel", "claude-opus-4-8");
    expect(getSetting("verifyModel", "unused-fallback")).toBe("claude-opus-4-8");
    expect(getAnalysisModelSetting()).toBe("auto");
  });

  it("getAnalysisEffortSetting: table overrides env overrides 'high' default", () => {
    vi.stubEnv("ANALYSIS_EFFORT", ""); // empty env = unset, regardless of host machine
    expect(getAnalysisEffortSetting()).toBe(DEFAULT_ANALYSIS_EFFORT);
    vi.stubEnv("ANALYSIS_EFFORT", "medium");
    expect(getAnalysisEffortSetting()).toBe("medium");
    setSetting("analysisEffort", "xhigh");
    expect(getAnalysisEffortSetting()).toBe("xhigh");
  });

  it("getAnalysisEffortSetting sanitizes unknown/miscased values to the default (never bricks a report)", () => {
    vi.stubEnv("ANALYSIS_EFFORT", "turbo"); // not a real level
    expect(getAnalysisEffortSetting()).toBe(DEFAULT_ANALYSIS_EFFORT);
    setSetting("analysisEffort", " MEDIUM "); // hand-edited row: case/space tolerant
    expect(getAnalysisEffortSetting()).toBe("medium");
    setSetting("analysisEffort", "9000"); // garbage row: sanitize, don't throw
    expect(getAnalysisEffortSetting()).toBe(DEFAULT_ANALYSIS_EFFORT);
    // Every declared level round-trips unchanged.
    for (const level of EFFORT_LEVELS) {
      setSetting("analysisEffort", level);
      expect(getAnalysisEffortSetting()).toBe(level);
    }
  });
});
