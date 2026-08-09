import { parentPort, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

const release = workerData.release === undefined
  ? null
  : new Int32Array(workerData.release);
const done = workerData.done === undefined
  ? null
  : new Int32Array(workerData.done);
const sqlite = new Database(workerData.file);
let locked = false;

function upsert(key, value) {
  sqlite.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

try {
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec("BEGIN IMMEDIATE");
  locked = true;
  upsert("analysisModel", workerData.state.analysisModel);
  upsert("analysisEffort", workerData.state.analysisEffort);
  upsert("__writableSettingsRevision", String(workerData.revision));
  parentPort?.postMessage({ state: "staged" });

  if (typeof workerData.holdMs === "number") {
    const hold = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.wait(hold, 0, 0, workerData.holdMs);
  } else {
    if (release === null) throw new Error("settings writer release barrier is required");
    if (Atomics.wait(release, 0, 0, 10_000) === "timed-out") {
      throw new Error("settings writer release barrier timed out");
    }
  }

  sqlite.exec("COMMIT");
  locked = false;
  if (done !== null) {
    Atomics.store(done, 0, 1);
    Atomics.notify(done, 0);
  }
  parentPort?.postMessage({ state: "committed" });
} catch (error) {
  if (locked) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
  }
  if (done !== null) {
    Atomics.store(done, 0, -1);
    Atomics.notify(done, 0);
  }
  parentPort?.postMessage({
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
} finally {
  sqlite.close();
}
