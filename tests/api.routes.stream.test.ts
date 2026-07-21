/**
 * Handler-level tests for GET /api/report/[jobId]/stream (the SSE progress
 * stream). Follows the api.routes.report.test.ts harness: the route's exported
 * GET is invoked directly with constructed Request objects + params against an
 * in-memory better-sqlite3 database (createDatabase(":memory:") +
 * setDbForTests). No network, no LLM: the route itself never calls runJob —
 * only sweepAbandonedJobs (real, DB-only) and the events bus.
 *
 * Coverage:
 *   - 404 JSON error for an unknown job id.
 *   - Already-terminal job at connect (done AND error): snapshot replay + a
 *     synthesized terminal frame, stream closes, no subscription leaks.
 *   - The subscribe/terminal RACE guard: job flips terminal between the
 *     handler-level snapshot read and the post-subscribe re-check (simulated
 *     via a getJobSnapshot wrapper) → terminal frame + close + unsubscribe.
 *   - Client abort tears down the subscription (subscriberCount → 0).
 *   - Live events stream in publish order for a running job and the stream
 *     closes on the terminal event.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// jobRunner can transitively pull the `server-only` shim (absent under the
// plain-node runner). Stub it to a no-op, same as api.routes.report.test.ts.
vi.mock("server-only", () => ({}));

// Wrap getJobSnapshot with a pass-through hook so ONE test can flip the job to
// terminal between the route's two snapshot reads (the race the re-check
// guards). Everything else in the events module stays real.
const snapshotHook = vi.hoisted(() => ({
  before: null as ((jobId: string) => void) | null,
}));
vi.mock("@/pipeline/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/events")>();
  return {
    ...actual,
    getJobSnapshot: (jobId: string) => {
      snapshotHook.before?.(jobId);
      return actual.getJobSnapshot(jobId);
    },
  };
});

import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { jobs } from "@/db/schema";
import {
  publishJobEvent,
  subscriberCount,
  _clearJobSubscribers,
  type JobEvent,
} from "@/pipeline/events";
import { createJob, initialSteps } from "@/pipeline/jobRunner";
import type { StepProgress } from "@/types/core";

import { GET as streamGET } from "@/app/api/report/[jobId]/stream/route";

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

let handle: DatabaseHandle;

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
  snapshotHook.before = null;
  _clearJobSubscribers();
});

afterEach(() => {
  _clearJobSubscribers();
  setDbForTests(null);
  handle.sqlite.close();
});

function streamReq(
  jobId: string,
  signal?: AbortSignal,
): [Request, { params: Promise<{ jobId: string }> }] {
  return [
    new Request(`http://localhost/api/report/${jobId}/stream`, { signal }),
    { params: Promise.resolve({ jobId }) },
  ];
}

/** Read the whole SSE body (the route must close the stream for this to end). */
async function readBody(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** Split raw SSE text into comment lines and event frames (in wire order). */
function parseSse(raw: string): { comments: string[]; frames: Frame[] } {
  const comments: string[] = [];
  const frames: Frame[] = [];
  for (const block of raw.split("\n\n")) {
    if (block.trim() === "") continue;
    if (block.startsWith(": ")) {
      comments.push(block.slice(2));
      continue;
    }
    const event = /^event: (.+)$/m.exec(block);
    const data = /^data: (.+)$/m.exec(block);
    if (event !== null && data !== null) {
      frames.push({ event: event[1], data: JSON.parse(data[1]) as Record<string, unknown> });
    }
  }
  return { comments, frames };
}

function markTerminal(jobId: string, status: "done" | "error", error: string | null = null): void {
  handle.db
    .update(jobs)
    .set({ status, error, updatedAt: new Date().toISOString() })
    .where(eq(jobs.id, jobId))
    .run();
}

/* ------------------------------------------------------------------------ *
 * 404
 * ------------------------------------------------------------------------ */

describe("GET /api/report/[jobId]/stream — unknown job", () => {
  it("returns a 404 JSON error (not an SSE stream)", async () => {
    const res = await streamGET(...streamReq("does-not-exist"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does-not-exist");
  });
});

/* ------------------------------------------------------------------------ *
 * Already-terminal at connect
 * ------------------------------------------------------------------------ */

describe("already-terminal job at connect", () => {
  it("replays the snapshot, emits a synthesized `done` frame, and closes", async () => {
    const { jobId } = createJob("AAPL");
    markTerminal(jobId, "done");

    const res = await streamGET(...streamReq(jobId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    // readBody only returns because the route closed the stream.
    const { comments, frames } = parseSse(await readBody(res));
    expect(comments[0]).toBe("stream open");
    expect(frames.map((f) => f.event)).toEqual(["snapshot", "done"]);
    expect(frames[0].data.jobId).toBe(jobId);
    expect(frames[0].data.status).toBe("done");
    // Synthesized terminal event from the snapshot: no report row → nulls/0.
    expect(frames[1].data).toEqual({
      type: "done",
      jobId,
      reportId: null,
      verificationRate: null,
      totalCostUsd: 0,
      dataOnly: false,
    });

    // No subscription was left behind (terminal path never subscribes).
    expect(subscriberCount(jobId)).toBe(0);
  });

  it("emits a synthesized `error` frame for an error-terminal job", async () => {
    const { jobId } = createJob("MSFT");
    markTerminal(jobId, "error", "synthesize failed (transport)");

    const res = await streamGET(...streamReq(jobId));
    const { frames } = parseSse(await readBody(res));
    expect(frames.map((f) => f.event)).toEqual(["snapshot", "error"]);
    expect(frames[1].data).toEqual({
      type: "error",
      jobId,
      message: "synthesize failed (transport)",
    });
    expect(subscriberCount(jobId)).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Subscribe/terminal race guard
 * ------------------------------------------------------------------------ */

describe("subscribe/terminal race guard", () => {
  it("re-checks after subscribing: a job that finished between the two reads gets a terminal frame + close + unsubscribe", async () => {
    const { jobId } = createJob("NVDA");

    // First getJobSnapshot call (handler level) sees "queued"; flip the row to
    // terminal BEFORE the second call (the post-subscribe re-check).
    let calls = 0;
    snapshotHook.before = (id) => {
      if (id !== jobId) return;
      calls++;
      if (calls === 2) markTerminal(jobId, "done");
    };

    const res = await streamGET(...streamReq(jobId));
    const { frames } = parseSse(await readBody(res));

    expect(calls).toBe(2); // snapshot + re-check both happened
    expect(frames.map((f) => f.event)).toEqual(["snapshot", "done"]);
    expect(frames[0].data.status).toBe("queued"); // pre-race snapshot replayed
    expect(frames[1].data.jobId).toBe(jobId);
    // cleanup() unsubscribed — the race does not leak the subscription.
    expect(subscriberCount(jobId)).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Abort cleanup
 * ------------------------------------------------------------------------ */

describe("client abort", () => {
  it("tears down the subscription (no leak) and closes the stream", async () => {
    const { jobId } = createJob("AAPL");
    const ac = new AbortController();

    const res = await streamGET(...streamReq(jobId, ac.signal));
    expect(res.status).toBe(200);
    // The subscription is live while the client is connected.
    expect(subscriberCount(jobId)).toBe(1);

    ac.abort();
    await vi.waitFor(() => {
      expect(subscriberCount(jobId)).toBe(0);
    });

    // cleanup() closed the controller: the body ends with only the pre-abort
    // chunks (open comment + snapshot), no terminal frame.
    const { comments, frames } = parseSse(await readBody(res));
    expect(comments[0]).toBe("stream open");
    expect(frames.map((f) => f.event)).toEqual(["snapshot"]);
  });
});

/* ------------------------------------------------------------------------ *
 * Live event streaming
 * ------------------------------------------------------------------------ */

describe("running job — live events", () => {
  it("streams published events in order and closes on the terminal one", async () => {
    const { jobId } = createJob("AAPL");
    const res = await streamGET(...streamReq(jobId));
    expect(subscriberCount(jobId)).toBe(1);

    const steps: StepProgress[] = initialSteps().map((s) =>
      s.step === "fetch" ? { ...s, status: "running" as const } : s,
    );
    const events: JobEvent[] = [
      { type: "step-update", jobId, step: steps[0], steps },
      { type: "cost-update", jobId, step: "bull", passCostUsd: 0.5, totalCostUsd: 0.5 },
      {
        type: "done",
        jobId,
        reportId: null,
        verificationRate: null,
        totalCostUsd: 0.5,
        dataOnly: false,
      },
    ];
    for (const e of events) publishJobEvent(e);

    // The terminal event unsubscribed + closed the stream.
    expect(subscriberCount(jobId)).toBe(0);
    const { comments, frames } = parseSse(await readBody(res));
    expect(comments[0]).toBe("stream open");
    expect(frames.map((f) => f.event)).toEqual([
      "snapshot",
      "step-update",
      "cost-update",
      "done",
    ]);
    expect(frames[0].data.status).toBe("queued");
    expect(frames[1].data).toMatchObject({ type: "step-update", jobId });
    expect((frames[1].data.step as StepProgress).status).toBe("running");
    expect(frames[2].data).toEqual({
      type: "cost-update",
      jobId,
      step: "bull",
      passCostUsd: 0.5,
      totalCostUsd: 0.5,
    });
    expect(frames[3].data).toMatchObject({ type: "done", totalCostUsd: 0.5 });
  });

  it("events published AFTER the terminal one are not delivered (subscription gone)", async () => {
    const { jobId } = createJob("TSLA");
    const res = await streamGET(...streamReq(jobId));

    publishJobEvent({ type: "error", jobId, message: "boom" });
    expect(subscriberCount(jobId)).toBe(0);
    // Nobody is listening — this must be a silent no-op, not a crash.
    publishJobEvent({ type: "cost-update", jobId, step: "bear", passCostUsd: 1, totalCostUsd: 1 });

    const { frames } = parseSse(await readBody(res));
    expect(frames.map((f) => f.event)).toEqual(["snapshot", "error"]);
  });
});
