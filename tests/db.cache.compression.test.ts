/**
 * api_cache compression + maintenance (2026-07 audit item 5: 90MB of the DB
 * was 28 uncompressed EDGAR HTML rows, and 174/231 expired FMP rows were never
 * purged).
 *
 * - Large bodies are stored gzip-compressed in the bodyGz BLOB (bodyJson "")
 *   transparently: cachedFetch round-trips them unchanged.
 * - maintainApiCache compresses pre-existing large plain rows, purges rows
 *   long past their stored TTL (30d margin), spares cache-forever filings,
 *   and VACUUMs when it did work. A settings-backed 24h guard keeps the
 *   startup hook cheap.
 */

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { apiCache } from "@/db/schema";
import { cachedFetch, flushPendingRefreshes } from "@/cache/apiCache";
import { COMPRESS_THRESHOLD_BYTES, decodeCacheBody, encodeCacheBody } from "@/cache/compression";
import { maintainApiCache, PURGE_EXPIRED_MARGIN_SECONDS } from "@/cache/maintenance";

let handle: DatabaseHandle;

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
});

afterEach(async () => {
  await flushPendingRefreshes();
  setDbForTests(null);
  handle.sqlite.close();
});

function readRow(cacheKey: string) {
  return handle.db.select().from(apiCache).where(eq(apiCache.cacheKey, cacheKey)).get();
}

/** A JSON-serializable body whose serialized size exceeds the threshold. */
function bigBody(): { html: string } {
  return { html: "x".repeat(COMPRESS_THRESHOLD_BYTES + 1024) };
}

function seedRow(over: Partial<typeof apiCache.$inferInsert> = {}): void {
  handle.db
    .insert(apiCache)
    .values({
      cacheKey: over.cacheKey ?? "edgar|https://example/doc|{}",
      provider: "edgar",
      endpoint: "https://example/doc",
      paramsJson: "{}",
      bodyJson: JSON.stringify({ status: 200, body: "x".repeat(200_000) }),
      fetchedAt: new Date().toISOString(),
      ttlSeconds: 315_360_000,
      asOf: "2026-01-01",
      ...over,
    })
    .run();
}

describe("compression codec", () => {
  it("round-trips large bodies and leaves small ones plain", () => {
    const small = encodeCacheBody(JSON.stringify({ a: 1 }));
    expect(small.bodyGz).toBeNull();
    expect(small.bodyJson).toBe(JSON.stringify({ a: 1 }));

    const large = encodeCacheBody(JSON.stringify(bigBody()));
    expect(large.bodyGz).not.toBeNull();
    expect(large.bodyJson).toBe("");
    expect(large.bodyGz!.length).toBeLessThan(COMPRESS_THRESHOLD_BYTES); // ~85%+ saving on repetitive text
    expect(decodeCacheBody(large)).toBe(JSON.stringify(bigBody()));
  });
});

describe("cachedFetch with compression", () => {
  it("stores large bodies compressed and serves them back identically", async () => {
    const body = bigBody();
    const opts = {
      provider: "edgar" as const,
      endpoint: "big-doc",
      params: { url: "u" },
      ttlSeconds: 3600,
      fetcher: async () => ({ body, asOf: "2026-07-01" }),
    };
    const first = await cachedFetch(opts);
    expect(first.data).toEqual(body);

    const row = readRow("edgar|big-doc|" + '{"url":"u"}');
    expect(row?.bodyJson).toBe("");
    expect(row?.bodyGz).not.toBeNull();

    // Fresh hit decompresses.
    const second = await cachedFetch({ ...opts, fetcher: async () => ({ body: { html: "MISS" }, asOf: "x" }) });
    expect(second.data).toEqual(body);
  });

  it("an empty refresh never clobbers a previously-good COMPRESSED body (M6 + bodyGz)", async () => {
    const isEmptyBody = (b: { body?: unknown }): boolean => Array.isArray(b.body) && b.body.length === 0;
    // A good body large enough to be stored compressed (bodyGz), non-empty rows.
    const good = { body: [{ html: "x".repeat(COMPRESS_THRESHOLD_BYTES + 1024) }], status: 200 };
    const opts = {
      provider: "fmp" as const,
      endpoint: "income-statement",
      params: { symbol: "AAPL" },
      ttlSeconds: 0, // instantly stale so the next call background-refreshes
      isEmptyBody,
      fetcher: async () => ({ body: good, asOf: "2026-04-01" }),
    };
    await cachedFetch(opts);
    const key = "fmp|income-statement|" + '{"symbol":"AAPL"}';
    expect(readRow(key)?.bodyGz).not.toBeNull(); // stored compressed

    // Expired hit → background refresh returns an empty array.
    await cachedFetch({ ...opts, fetcher: async () => ({ body: { body: [], status: 200 }, asOf: "2026-07-01" }) });
    await flushPendingRefreshes();

    // The good compressed row survived — decodeCacheBody in the guard read bodyGz.
    const row = readRow(key);
    expect(row?.bodyGz).not.toBeNull();
    const decoded = JSON.parse(decodeCacheBody({ bodyJson: row!.bodyJson, bodyGz: row!.bodyGz as Buffer | null })) as { body: unknown[] };
    expect(decoded.body).toHaveLength(1);
    expect(row?.asOf).toBe("2026-04-01");
  });

  it("clears bodyGz when a refreshed body shrinks below the threshold", async () => {
    const opts = {
      provider: "fmp" as const,
      endpoint: "shrinking",
      params: {},
      ttlSeconds: 0, // instantly stale
      fetcher: async () => ({ body: bigBody(), asOf: "2026-07-01" }),
    };
    await cachedFetch(opts);
    expect(readRow("fmp|shrinking|{}")?.bodyGz).not.toBeNull();

    // Expired hit → background refresh with a small body.
    await cachedFetch({ ...opts, fetcher: async () => ({ body: { s: 1 }, asOf: "2026-07-02" }) });
    await flushPendingRefreshes();
    const row = readRow("fmp|shrinking|{}");
    expect(row?.bodyGz).toBeNull();
    expect(row?.bodyJson).toBe(JSON.stringify({ s: 1 }));
  });
});

describe("maintainApiCache", () => {
  it("compresses pre-existing large plain rows and purges long-expired rows, then vacuums", () => {
    // Large plain edgar row (cache-forever TTL) — must be compressed, NOT purged.
    seedRow({ cacheKey: "edgar|forever|{}" });
    // Small expired FMP row far past ttl+margin — must be purged.
    seedRow({
      cacheKey: "fmp|expired|{}",
      provider: "fmp",
      bodyJson: JSON.stringify({ small: true }),
      ttlSeconds: 900,
      fetchedAt: new Date(Date.now() - (900 + PURGE_EXPIRED_MARGIN_SECONDS + 3600) * 1000).toISOString(),
    });
    // Small fresh FMP row — untouched.
    seedRow({ cacheKey: "fmp|fresh|{}", provider: "fmp", bodyJson: JSON.stringify({ ok: 1 }), ttlSeconds: 900 });

    const result = maintainApiCache(handle.sqlite, { force: true });
    expect(result.skipped).toBe(false);
    expect(result.compressed).toBe(1);
    expect(result.purged).toBe(1);
    expect(result.vacuumed).toBe(true);

    const forever = readRow("edgar|forever|{}");
    expect(forever?.bodyGz).not.toBeNull();
    expect(forever?.bodyJson).toBe("");
    expect(decodeCacheBody({ bodyJson: forever!.bodyJson, bodyGz: forever!.bodyGz as Buffer | null })).toContain("200");
    expect(readRow("fmp|expired|{}")).toBeUndefined();
    expect(readRow("fmp|fresh|{}")).toBeDefined();
  });

  it("compressed rows still serve through cachedFetch afterwards", async () => {
    seedRow({ cacheKey: "edgar|https://example/doc|{}", endpoint: "https://example/doc", paramsJson: "{}" });
    maintainApiCache(handle.sqlite, { force: true });
    const served = await cachedFetch({
      provider: "edgar",
      endpoint: "https://example/doc",
      params: {},
      ttlSeconds: 315_360_000,
      fetcher: async () => {
        throw new Error("must not refetch — fresh compressed row exists");
      },
    });
    expect((served.data as { status: number }).status).toBe(200);
  });

  it("is guarded to one run per 24h unless forced", () => {
    seedRow({ cacheKey: "edgar|a|{}" });
    const first = maintainApiCache(handle.sqlite);
    expect(first.skipped).toBe(false);
    seedRow({ cacheKey: "edgar|b|{}" });
    const second = maintainApiCache(handle.sqlite);
    expect(second.skipped).toBe(true);
    expect(second.compressed).toBe(0);
    const forced = maintainApiCache(handle.sqlite, { force: true });
    expect(forced.skipped).toBe(false);
    expect(forced.compressed).toBe(1);
  });
});
