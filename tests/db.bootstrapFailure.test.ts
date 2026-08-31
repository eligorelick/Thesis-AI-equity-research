import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDatabase } from "@/db";

/**
 * `getDb()` memoizes its handle only on success, so a `createDatabase()` that
 * throws after opening the connection makes every later call open another one.
 * On Windows each stranded handle also keeps a file lock, so the failure
 * compounds instead of staying a single clean error.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "thesis-db-bootstrap-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createDatabase failure handling", () => {
  it("closes the connection when bootstrap fails on a corrupt file", () => {
    const file = path.join(dir, "corrupt.db");
    // Valid SQLite header magic followed by garbage: the open succeeds and the
    // failure surfaces from the first pragma/schema statement, which is the
    // realistic corrupted-database shape.
    writeFileSync(file, Buffer.concat([Buffer.from("SQLite format 3\0", "utf8"), Buffer.alloc(4096, 0x7f)]));

    expect(() => createDatabase(file)).toThrow();

    // A stranded better-sqlite3 handle keeps the file locked on Windows, so a
    // successful unlink is the observable proof that the handle was released.
    expect(() => unlinkSync(file)).not.toThrow();
  });
});
