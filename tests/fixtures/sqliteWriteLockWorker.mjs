import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const release = workerData.release === undefined ? null : new Int32Array(workerData.release);
const sqlite = new Database(workerData.file);
let locked = false;

try {
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec("BEGIN IMMEDIATE");
  locked = true;
  parentPort?.postMessage({ state: "locked" });
  if (typeof workerData.holdMs === "number") {
    const hold = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.wait(hold, 0, 0, workerData.holdMs);
  } else {
    if (release === null) throw new Error("writer release barrier is required");
    if (Atomics.wait(release, 0, 0, 10_000) === "timed-out") {
      throw new Error("writer release barrier timed out");
    }
  }
  sqlite.exec("COMMIT");
  locked = false;
  parentPort?.postMessage({ state: "released" });
} catch (error) {
  if (locked) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // The original lock error remains authoritative.
    }
  }
  parentPort?.postMessage({
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
} finally {
  sqlite.close();
}
