/**
 * Storage codec for api_cache bodies. Large JSON bodies (multi-MB raw 10-K
 * HTML, companyfacts) are gzip-compressed into the bodyGz BLOB column —
 * ~85-90% smaller at rest — while small bodies stay as plain TEXT so the
 * common path pays no CPU. Leaf module by design: imported by both
 * src/cache/apiCache.ts and src/db (maintenance hook) without creating an
 * import cycle through @/db.
 */

import "server-only";

import { gunzipSync, gzipSync } from "node:zlib";

/** Bodies at/above this many UTF-8 bytes are stored gzip-compressed (BLOB). */
export const COMPRESS_THRESHOLD_BYTES = 65_536;

/**
 * Storage encoding for a cache body. Compressed rows keep bodyJson = "" (the
 * column is NOT NULL); the empty string is unambiguous because JSON.stringify
 * never produces "".
 */
export function encodeCacheBody(bodyJson: string): { bodyJson: string; bodyGz: Buffer | null } {
  if (Buffer.byteLength(bodyJson, "utf8") < COMPRESS_THRESHOLD_BYTES) {
    return { bodyJson, bodyGz: null };
  }
  return { bodyJson: "", bodyGz: gzipSync(Buffer.from(bodyJson, "utf8")) };
}

/** Inverse of {@link encodeCacheBody} at read time. */
export function decodeCacheBody(row: {
  bodyJson: string;
  bodyGz?: Buffer | Uint8Array | null;
}): string {
  const gz = row.bodyGz;
  if (gz != null && gz.length > 0) {
    return gunzipSync(Buffer.isBuffer(gz) ? gz : Buffer.from(gz)).toString("utf8");
  }
  return row.bodyJson;
}
