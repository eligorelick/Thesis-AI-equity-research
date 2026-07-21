/**
 * api_cache maintenance sweep (2026-07 audit item 5: the DB grew unbounded —
 * 90MB of 103MB was 28 uncompressed EDGAR HTML rows and 174/231 FMP rows sat
 * expired forever).
 *
 * Three passes over the raw better-sqlite3 handle (runs inside createDatabase
 * before Drizzle wraps it, so it takes the handle directly and must NOT import
 * @/db — that would be an import cycle):
 *
 *  1. Compress: any plain row whose bodyJson meets the compression threshold
 *     is moved into the bodyGz BLOB (retrofit for rows written before the
 *     codec existed).
 *  2. Purge: rows older than their stored ttlSeconds + a 30-day margin are
 *     deleted. Serve-stale-while-revalidate means an expired row still has
 *     value for instant renders, hence the wide margin; cache-forever rows
 *     (filings/transcripts, 10-year TTL) never match the predicate. The stored
 *     ttlSeconds is advisory (freshness is judged against the caller's TTL at
 *     read time), so a purge is safe — worst case is a refetch.
 *  3. VACUUM when either pass did work, so the file actually shrinks.
 *
 * A settings-table stamp guards the sweep to once per 24h so the startup hook
 * stays free in the steady state.
 */

import "server-only";

import type Database from "better-sqlite3";
import { COMPRESS_THRESHOLD_BYTES, encodeCacheBody } from "./compression";

/** Rows this far past their stored TTL are deleted by the sweep. */
export const PURGE_EXPIRED_MARGIN_SECONDS = 30 * 86_400;

/** Settings key stamping the last completed sweep (ISO timestamp). */
export const MAINTENANCE_LAST_RUN_KEY = "cacheMaintenanceLastRunAt";

/** Minimum seconds between unforced sweeps. */
const MIN_INTERVAL_SECONDS = 86_400;

export interface CacheMaintenanceResult {
  /** True when the 24h guard skipped the sweep entirely. */
  skipped: boolean;
  /** Plain rows moved into the bodyGz BLOB. */
  compressed: number;
  /** Rows deleted for being > ttlSeconds + margin old. */
  purged: number;
  /** True when VACUUM ran (only after actual work). */
  vacuumed: boolean;
}

export interface CacheMaintenanceOptions {
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Bypass the 24h guard (tests / manual compaction). */
  force?: boolean;
}

const NO_WORK: CacheMaintenanceResult = { skipped: true, compressed: 0, purged: 0, vacuumed: false };

export function maintainApiCache(
  sqlite: Database.Database,
  opts: CacheMaintenanceOptions = {},
): CacheMaintenanceResult {
  const now = (opts.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  if (!opts.force) {
    const row = sqlite
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(MAINTENANCE_LAST_RUN_KEY) as { value: string } | undefined;
    if (row !== undefined) {
      const lastMs = Date.parse(row.value);
      if (Number.isFinite(lastMs) && now.getTime() - lastMs < MIN_INTERVAL_SECONDS * 1000) {
        return NO_WORK;
      }
    }
  }

  // 1) Compress plain rows at/above the threshold. SQLite length() counts
  //    characters for TEXT; chars <= UTF-8 bytes, so every row the byte
  //    threshold would catch is included (a few multibyte-heavy rows just
  //    under the char count slip until their next write — harmless).
  let compressed = 0;
  const candidates = sqlite
    .prepare(
      `SELECT cacheKey, bodyJson FROM api_cache
        WHERE (bodyGz IS NULL OR length(bodyGz) = 0) AND length(bodyJson) >= ?`,
    )
    .all(COMPRESS_THRESHOLD_BYTES) as { cacheKey: string; bodyJson: string }[];
  // The UPDATE is conditional on the snapshot still matching: a background
  // refresh (cachedFetch's fire-and-forget path) may have replaced the row
  // between our SELECT and UPDATE, and writing the OLD body over the fresh one
  // would silently serve stale data under the new fetchedAt. A refreshed row
  // simply skips compression until the next sweep.
  const update = sqlite.prepare(
    `UPDATE api_cache SET bodyJson = ?, bodyGz = ?
      WHERE cacheKey = ? AND bodyJson = ? AND (bodyGz IS NULL OR length(bodyGz) = 0)`,
  );
  for (const row of candidates) {
    const enc = encodeCacheBody(row.bodyJson);
    if (enc.bodyGz !== null) {
      compressed += update.run(enc.bodyJson, enc.bodyGz, row.cacheKey, row.bodyJson).changes;
    }
  }

  // 2) Purge rows long past their stored TTL. julianday(NULL-ish fetchedAt)
  //    yields NULL and the comparison is then false — unparseable rows stay.
  const purged = sqlite
    .prepare(
      `DELETE FROM api_cache
        WHERE (julianday(?) - julianday(fetchedAt)) * 86400.0 > (ttlSeconds + ?)`,
    )
    .run(nowIso, PURGE_EXPIRED_MARGIN_SECONDS).changes;

  // 3) Reclaim file space only when something changed.
  let vacuumed = false;
  if (compressed + purged > 0) {
    sqlite.exec("VACUUM");
    vacuumed = true;
  }

  sqlite
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(MAINTENANCE_LAST_RUN_KEY, nowIso);

  return { skipped: false, compressed, purged, vacuumed };
}
