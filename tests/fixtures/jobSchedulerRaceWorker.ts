import { parentPort, workerData } from "node:worker_threads";

import { createDatabase } from "@/db";
import {
  acquirePaidPassLease,
  claimNextQueuedJob,
  type ClaimedJob,
  type SchedulerLimits,
} from "@/pipeline/jobScheduler";

interface WorkerData {
  action:
    | { kind: "claim"; workerId: string }
    | {
        kind: "spend";
        claim: ClaimedJob;
        pass: "bull" | "bear";
        attemptId: string;
        reservationUsd: number;
      };
  file: string;
  limits: SchedulerLimits;
  nowIso: string;
  ready: SharedArrayBuffer;
  start: SharedArrayBuffer;
}

const data = workerData as WorkerData;
const ready = new Int32Array(data.ready);
const start = new Int32Array(data.start);
let sqlite: ReturnType<typeof createDatabase>["sqlite"] | undefined;

try {
  const handle = createDatabase(data.file);
  sqlite = handle.sqlite;
  Atomics.add(ready, 0, 1);
  Atomics.notify(ready, 0);
  if (Atomics.wait(start, 0, 0, 10_000) === "timed-out") {
    throw new Error("race start barrier timed out");
  }
  const now = new Date(data.nowIso);
  const result = data.action.kind === "claim"
    ? { claim: claimNextQueuedJob(data.action.workerId, now, data.limits, handle.db) }
    : {
        lease: acquirePaidPassLease(
          data.action.claim,
          data.action.pass,
          data.action.attemptId,
          data.action.reservationUsd,
          now,
          data.limits,
          handle.db,
        ),
      };
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
} finally {
  sqlite?.close();
}
