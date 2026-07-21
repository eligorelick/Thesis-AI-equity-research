/**
 * GET /api/report/[jobId]/stream — Server-Sent Events progress stream.
 *
 * Behavior:
 *  1. Replays the current job snapshot first (a "snapshot" event) so a late or
 *     refreshing client immediately catches up to where the pipeline is.
 *  2. Streams live events (step-update / cost-update / done / error) until a
 *     terminal event, then closes the stream.
 *  3. If the job is ALREADY terminal at connect time (done/error), it replays
 *     the snapshot, emits the terminal event, and closes — no hanging stream.
 *  4. Sends heartbeat comments so proxies don't idle-timeout the connection.
 *  5. Cleans up (unsubscribe + clear heartbeat) on client disconnect via the
 *     request AbortSignal and on normal termination.
 *
 * 404 when the job id is unknown. Server-only (nodejs runtime).
 */

import {
  getJobSnapshot,
  isTerminalEvent,
  subscribeJob,
  type JobEvent,
} from "@/pipeline/events";
import { sweepAbandonedJobs } from "@/pipeline/jobRunner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Heartbeat interval (ms) — a comment line keeps intermediaries from timing out. */
const HEARTBEAT_MS = 15_000;

const encoder = new TextEncoder();

/** Serialize one SSE event frame: `event: <name>\ndata: <json>\n\n`. */
function sseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** An SSE comment line (heartbeat / stream-open marker). */
function sseComment(text: string): Uint8Array {
  return encoder.encode(`: ${text}\n\n`);
}

function terminalEventFromSnapshot(snapshot: NonNullable<ReturnType<typeof getJobSnapshot>>): JobEvent {
  if (snapshot.status === "error") {
    return { type: "error", jobId: snapshot.jobId, message: snapshot.error ?? "job failed" };
  }
  return {
    type: "done",
    jobId: snapshot.jobId,
    reportId: snapshot.reportId,
    verificationRate: snapshot.verificationRate,
    totalCostUsd: snapshot.totalCostUsd,
    dataOnly: snapshot.dataOnly,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const { jobId } = await params;

  // A job orphaned by a process death terminal-izes here so the stream emits
  // an immediate error frame instead of heartbeating a dead "running" job.
  sweepAbandonedJobs();

  const snapshot = getJobSnapshot(jobId);
  if (snapshot === null) {
    return new Response(JSON.stringify({ error: `no job with id "${jobId}"` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const alreadyTerminal = snapshot.status === "done" || snapshot.status === "error";

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Mutable holder so the cleanup/enqueue closures can read handles that are
      // assigned later (subscription/heartbeat), captured by reference.
      const refs: {
        closed: boolean;
        heartbeat?: ReturnType<typeof setInterval>;
        unsubscribe?: () => void;
      } = { closed: false };

      const safeEnqueue = (chunk: Uint8Array): void => {
        if (refs.closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // Controller already closed (client vanished mid-write) — stop.
          cleanup();
        }
      };

      const cleanup = (): void => {
        if (refs.closed) return;
        refs.closed = true;
        if (refs.heartbeat !== undefined) clearInterval(refs.heartbeat);
        if (refs.unsubscribe !== undefined) refs.unsubscribe();
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Client disconnect → tear everything down.
      request.signal.addEventListener("abort", cleanup);

      // 1. Open marker + snapshot replay (catch-up for late subscribers).
      safeEnqueue(sseComment("stream open"));
      safeEnqueue(sseFrame("snapshot", snapshot));

      // 3. Already-terminal job: emit the terminal event synthetically + close.
      if (alreadyTerminal) {
        const terminal = terminalEventFromSnapshot(snapshot);
        safeEnqueue(sseFrame(terminal.type, terminal));
        cleanup();
        return;
      }

      // 2. Subscribe to live events; close on the terminal one.
      refs.unsubscribe = subscribeJob(jobId, (event) => {
        safeEnqueue(sseFrame(event.type, event));
        if (isTerminalEvent(event)) cleanup();
      });

      // Guard against a race: the job may have finished between the snapshot
      // read and the subscription. Re-check and synthesize a terminal event.
      const recheck = getJobSnapshot(jobId);
      if (recheck !== null && (recheck.status === "done" || recheck.status === "error")) {
        const terminal = terminalEventFromSnapshot(recheck);
        safeEnqueue(sseFrame(terminal.type, terminal));
        cleanup();
        return;
      }

      // 4. Heartbeat.
      refs.heartbeat = setInterval(() => safeEnqueue(sseComment("heartbeat")), HEARTBEAT_MS);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disable proxy buffering (nginx) so events flush immediately.
      "x-accel-buffering": "no",
    },
  });
}
