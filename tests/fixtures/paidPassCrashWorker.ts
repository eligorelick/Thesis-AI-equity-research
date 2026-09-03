/**
 * A second OS-level process that claims a job, reserves one paid pass, and
 * then exits WITHOUT settling — the crash the durable spend accounting has to
 * survive. It posts the claim and lease identities back so the surviving
 * process can assert on them; nothing else is shared but the SQLite file.
 */
import { parentPort, workerData } from "node:worker_threads";

import { createDatabase } from "@/db";
import {
  acquirePaidPassLease,
  claimNextQueuedJob,
  type SchedulerLimits,
} from "@/pipeline/jobScheduler";

interface WorkerData {
  file: string;
  workerId: string;
  pass: "bull" | "bear";
  attemptId: string;
  reservationUsd: number;
  model: string;
  limits: SchedulerLimits;
  nowIso: string;
}

const data = workerData as WorkerData;
let sqlite: ReturnType<typeof createDatabase>["sqlite"] | undefined;

try {
  const handle = createDatabase(data.file);
  sqlite = handle.sqlite;
  const now = new Date(data.nowIso);
  const claim = claimNextQueuedJob(data.workerId, now, data.limits, handle.db);
  if (claim === null) throw new Error("crash worker could not claim a job");
  const acquired = acquirePaidPassLease(
    claim,
    data.pass,
    data.attemptId,
    data.reservationUsd,
    now,
    data.limits,
    handle.db,
    data.model,
  );
  if (!acquired.acquired) {
    throw new Error(`crash worker could not reserve: ${acquired.reason}`);
  }
  // Deliberately no settlement and no release: the process dies here, exactly
  // as it would on a power cut mid-request.
  parentPort?.postMessage({ ok: true, claim, lease: acquired.lease });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
} finally {
  sqlite?.close();
}
