/** Revisioned, snapshot-only SSE transport for durable report jobs. */
import {
  getJobSnapshot,
  jobExists,
  subscribeJob,
  type JobSnapshot,
} from "@/pipeline/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const READ_RETRY_MS = [250, 500, 1_000] as const;
const encoder = new TextEncoder();

function snapshotFrame(snapshot: JobSnapshot): Uint8Array {
  return encoder.encode(
    `id: ${snapshot.revision}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
  );
}

function comment(text: string): Uint8Array {
  return encoder.encode(`: ${text}\n\n`);
}

function finalized(snapshot: JobSnapshot): boolean {
  return !snapshot.settlementsPending && (snapshot.status === "done" ||
    snapshot.status === "error" ||
    snapshot.status === "unsupported" ||
    snapshot.status === "canceled");
}

function closedStreamResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  }), { status: 200, headers: streamHeaders() });
}

function streamHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

/**
 * Next answers HEAD by running GET and dropping the body, which for this route
 * would build the stream, register a job subscriber and arm the poll/heartbeat
 * timers that a bodiless response never cancels. Handle HEAD explicitly so a
 * probe allocates nothing: same status and headers, no body, no subscription.
 */
export async function HEAD(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return new Response(null, {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(null, { status: 200, headers: streamHeaders() });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return new Response(JSON.stringify({ error: `no job with id "${jobId}"` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (request.signal.aborted) return closedStreamResponse();

  let cancelStream = (): void => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const refs: {
        closed: boolean;
        lastRevision: number | null;
        unsubscribe?: () => void;
        poll?: ReturnType<typeof setTimeout>;
        heartbeat?: ReturnType<typeof setTimeout>;
        retry?: ReturnType<typeof setTimeout>;
        retryIndex: number;
        refreshing: boolean;
        refreshPending: boolean;
      } = {
        closed: false,
        lastRevision: null,
        retryIndex: 0,
        refreshing: false,
        refreshPending: false,
      };

      const clearTimer = (key: "poll" | "heartbeat" | "retry"): void => {
        const timer = refs[key];
        if (timer === undefined) return;
        refs[key] = undefined;
        clearTimeout(timer);
      };

      const cleanup = (): void => {
        if (refs.closed) return;
        refs.closed = true;
        clearTimer("poll");
        clearTimer("heartbeat");
        clearTimer("retry");
        const unsubscribe = refs.unsubscribe;
        refs.unsubscribe = undefined;
        unsubscribe?.();
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // Reader cancellation or a prior enqueue failure may already close it.
        }
      };
      cancelStream = cleanup;

      const enqueue = (chunk: Uint8Array): boolean => {
        if (refs.closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      const scheduleHeartbeat = (): void => {
        if (refs.closed || refs.heartbeat !== undefined) return;
        refs.heartbeat = setTimeout(() => {
          refs.heartbeat = undefined;
          if (enqueue(comment("heartbeat"))) scheduleHeartbeat();
        }, HEARTBEAT_MS);
        refs.heartbeat.unref?.();
      };

      let refresh = (): void => {};
      const schedulePoll = (): void => {
        if (refs.closed || refs.poll !== undefined || refs.retry !== undefined) return;
        refs.poll = setTimeout(() => {
          refs.poll = undefined;
          refresh();
        }, POLL_MS);
        refs.poll.unref?.();
      };

      const scheduleReadRetry = (): void => {
        if (refs.closed || refs.retry !== undefined) return;
        const delay = READ_RETRY_MS[refs.retryIndex];
        if (delay === undefined) {
          cleanup();
          return;
        }
        refs.retryIndex += 1;
        refs.retry = setTimeout(() => {
          refs.retry = undefined;
          refresh();
        }, delay);
        refs.retry.unref?.();
      };

      refresh = (): void => {
        if (refs.closed) return;
        if (refs.refreshing) {
          refs.refreshPending = true;
          return;
        }
        refs.refreshing = true;
        let succeeded = false;
        try {
          const snapshot = getJobSnapshot(jobId);
          if (snapshot === null) {
            cleanup();
            return;
          }
          refs.retryIndex = 0;
          succeeded = true;
          if (refs.lastRevision === null || snapshot.revision > refs.lastRevision) {
            if (!enqueue(snapshotFrame(snapshot))) return;
            refs.lastRevision = snapshot.revision;
            if (finalized(snapshot)) {
              cleanup();
              return;
            }
          }
        } catch {
          scheduleReadRetry();
        } finally {
          refs.refreshing = false;
        }
        if (refs.closed) return;
        if (refs.refreshPending && refs.retry === undefined) {
          refs.refreshPending = false;
          refresh();
          return;
        }
        if (succeeded) schedulePoll();
      };

      request.signal.addEventListener("abort", cleanup, { once: true });
      if (request.signal.aborted) {
        cleanup();
        return;
      }

      // Local events are post-commit invalidation hints only. Subscribing before
      // the authoritative read closes the handshake race; payloads never go on wire.
      refs.unsubscribe = subscribeJob(jobId, () => refresh());
      if (!enqueue(comment("stream open"))) return;
      refresh();
      if (!refs.closed) scheduleHeartbeat();
    },
    cancel() {
      cancelStream();
    },
  });

  return new Response(stream, { status: 200, headers: streamHeaders() });
}
