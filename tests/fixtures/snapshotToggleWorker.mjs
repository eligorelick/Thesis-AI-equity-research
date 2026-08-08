import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const stop = new Int32Array(workerData.stop);
const sqlite = new Database(workerData.file);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");
const updateCost = sqlite.prepare(`UPDATE cost_log SET costUsd = ? WHERE jobId = ?`);
const updateJob = sqlite.prepare(`UPDATE jobs SET revision = ?, updatedAt = ? WHERE id = ?`);
const commit = sqlite.transaction((revision) => {
  updateCost.run(revision, workerData.jobId);
  updateJob.run(revision, new Date(1_700_000_000_000 + revision).toISOString(), workerData.jobId);
});

try {
  let revision = 1;
  commit.immediate(revision);
  parentPort?.postMessage({ state: "started" });
  while (Atomics.load(stop, 0) === 0) {
    revision += 1;
    commit.immediate(revision);
  }
  parentPort?.postMessage({ state: "stopped", revision });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
  sqlite.close();
}
