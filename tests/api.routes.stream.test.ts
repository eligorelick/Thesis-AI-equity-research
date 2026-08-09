import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

const snapshotHook = vi.hoisted(() => ({
  calls: 0,
  before: null as ((jobId: string, call: number) => void) | null,
  failFromCall: null as number | null,
  subscribeCalls: 0,
  unsubscribeCalls: 0,
}));
vi.mock("@/pipeline/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/events")>();
  return {
    ...actual,
    getJobSnapshot: (jobId: string) => {
      snapshotHook.calls += 1;
      snapshotHook.before?.(jobId, snapshotHook.calls);
      if (snapshotHook.failFromCall !== null && snapshotHook.calls >= snapshotHook.failFromCall) {
        throw new Error("injected snapshot read failure");
      }
      return actual.getJobSnapshot(jobId);
    },
    subscribeJob: (jobId: string, callback: Parameters<typeof actual.subscribeJob>[1]) => {
      snapshotHook.subscribeCalls += 1;
      const unsubscribe = actual.subscribeJob(jobId, callback);
      return () => {
        snapshotHook.unsubscribeCalls += 1;
        unsubscribe();
      };
    },
  };
});

import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { costLog, jobLlmLeases, jobPassArtifacts, jobs } from "@/db/schema";
import {
  _clearJobSubscribers,
  getJobSnapshot,
  publishJobEvent,
  reportJsonIsDataOnly,
  subscriberCount,
} from "@/pipeline/events";
import { cancelJob, createJob, initialSteps } from "@/pipeline/jobRunner";
import { GET as streamGET } from "@/app/api/report/[jobId]/stream/route";

let handle: DatabaseHandle;
const directories: string[] = [];

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
  snapshotHook.calls = 0;
  snapshotHook.before = null;
  snapshotHook.failFromCall = null;
  snapshotHook.subscribeCalls = 0;
  snapshotHook.unsubscribeCalls = 0;
  _clearJobSubscribers();
});

afterEach(() => {
  vi.useRealTimers();
  _clearJobSubscribers();
  setDbForTests(null);
  handle.sqlite.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function requestArgs(
  jobId: string,
  signal?: AbortSignal,
  lastEventId?: string,
): [Request, { params: Promise<{ jobId: string }> }] {
  const headers = lastEventId === undefined ? undefined : { "last-event-id": lastEventId };
  return [
    new Request(`http://localhost/api/report/${jobId}/stream`, { signal, headers }),
    { params: Promise.resolve({ jobId }) },
  ];
}

async function readBody(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text;
    text += decoder.decode(chunk.value, { stream: true });
  }
}

interface ParsedFrame {
  id: string | null;
  event: string;
  data: Record<string, unknown>;
}

function parseFrames(raw: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const block of raw.split("\n\n")) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (event === undefined || data === undefined) continue;
    frames.push({
      id: /^id: (.+)$/m.exec(block)?.[1] ?? null,
      event,
      data: JSON.parse(data) as Record<string, unknown>,
    });
  }
  return frames;
}

function mutateJob(
  jobId: string,
  patch: Partial<typeof jobs.$inferInsert>,
): number {
  const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
  const revision = row.revision + 1;
  handle.db.update(jobs).set({
    ...patch,
    revision,
    updatedAt: new Date(Date.parse(row.updatedAt) + 1).toISOString(),
  }).where(eq(jobs.id, jobId)).run();
  return revision;
}

function hint(jobId: string, revision: number, type: "step-update" | "cost-update" | "done" = "cost-update"): void {
  const event = type === "done"
    ? {
        type,
        jobId,
        revision,
        reportId: null,
        verificationRate: null,
        totalCostUsd: 999,
        dataOnly: false,
      }
    : type === "step-update"
      ? { type, jobId, revision, step: { step: "fetch", status: "done" }, steps: [] }
      : { type, jobId, revision, step: "bull", passCostUsd: 999, totalCostUsd: 999 };
  publishJobEvent(event as Parameters<typeof publishJobEvent>[0]);
}

describe("GET /api/report/[jobId]/stream — revisioned snapshot protocol", () => {
  it("returns JSON 404 for an unknown job", async () => {
    const response = await streamGET(...requestArgs("missing"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("reads job revision and ledger cost from one coherent SQLite snapshot", async () => {
    setDbForTests(null);
    handle.sqlite.close();
    const directory = mkdtempSync(join(tmpdir(), "thesis-stream-coherence-"));
    directories.push(directory);
    const file = join(directory, "stream.db");
    handle = createDatabase(file);
    setDbForTests(handle.db);
    const { jobId } = createJob("AAPL");
    handle.sqlite.prepare(`
      INSERT INTO cost_log (jobId, runGeneration, attemptId, step, model, costUsd, createdAt)
      VALUES (?, 0, 'coherence', 'bull', 'test-model', 0, ?)
    `).run(jobId, new Date().toISOString());
    const stop = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const worker = new Worker(new URL("./fixtures/snapshotToggleWorker.mjs", import.meta.url), {
      workerData: { file, jobId, stop },
    });
    await new Promise<void>((resolve, reject) => {
      worker.on("message", (message: { state?: string; error?: string }) => {
        if (message.state === "started") resolve();
        if (message.error) reject(new Error(message.error));
      });
      worker.on("error", reject);
    });

    const mismatches: Array<{ revision: number; totalCostUsd: number }> = [];
    try {
      for (let index = 0; index < 5_000 && mismatches.length === 0; index += 1) {
        const snapshot = getJobSnapshot(jobId)!;
        if (snapshot.totalCostUsd !== snapshot.revision) {
          mismatches.push({ revision: snapshot.revision, totalCostUsd: snapshot.totalCostUsd });
        }
      }
    } finally {
      Atomics.store(new Int32Array(stop), 0, 1);
      Atomics.notify(new Int32Array(stop), 0);
      await worker.terminate();
    }

    expect(mismatches).toEqual([]);
  }, 30_000);

  it("always emits a revision-zero baseline with an SSE id even when Last-Event-ID is newer", async () => {
    const { jobId } = createJob("AAPL");
    mutateJob(jobId, { status: "done" });
    handle.db.update(jobs).set({ revision: 0 }).where(eq(jobs.id, jobId)).run();

    const frames = parseFrames(await readBody(await streamGET(...requestArgs(jobId, undefined, "99"))));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: "0", event: "snapshot" });
    expect(frames[0].data).toMatchObject({ jobId, revision: 0, status: "done" });
  });

  it("retains lenient legacy data-only report parsing used by snapshot replay", () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "fixtures", "report", "DEMO-sample.json"), "utf8")) as {
      appendix: { missingData: unknown[] };
    } & Record<string, unknown>;
    raw.appendix.missingData.push({
      field: "analysis.llm",
      reason: "legacy data-only fixture",
      severity: "warn",
    });
    const replaceFirstAsOf = (node: unknown): boolean => {
      if (node === null || typeof node !== "object") return false;
      if (Array.isArray(node)) return node.some(replaceFirstAsOf);
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "asOf" && typeof value === "string") {
          (node as Record<string, unknown>)[key] = "2026-06";
          return true;
        }
        if (replaceFirstAsOf(value)) return true;
      }
      return false;
    };
    expect(replaceFirstAsOf(raw)).toBe(true);
    expect(reportJsonIsDataOnly(JSON.stringify(raw))).toBe(true);
  });

  it("subscribes before its authoritative read and never emits a stale handshake snapshot", async () => {
    const { jobId } = createJob("AAPL");
    const abort = new AbortController();
    let changed = false;
    snapshotHook.before = (id) => {
      if (id === jobId && !changed) {
        expect(subscriberCount(jobId)).toBe(1);
        changed = true;
        mutateJob(jobId, { status: "running" });
      }
    };

    const response = await streamGET(...requestArgs(jobId, abort.signal));
    await Promise.resolve();
    abort.abort();
    const frames = parseFrames(await readBody(response));

    expect(frames.map((frame) => frame.data.status)).toEqual(["running"]);
    expect(frames[0]).toMatchObject({ id: "1", event: "snapshot" });
  });

  it("collapses same-revision local hints and ignores their fabricated payloads", async () => {
    const { jobId } = createJob("AAPL");
    const abort = new AbortController();
    const response = await streamGET(...requestArgs(jobId, abort.signal));
    const revision = mutateJob(jobId, { status: "running" });

    hint(jobId, revision, "cost-update");
    hint(jobId, revision, "step-update");
    await Promise.resolve();
    abort.abort();
    const frames = parseFrames(await readBody(response));

    expect(frames.map(({ event, id }) => [event, id])).toEqual([
      ["snapshot", "0"],
      ["snapshot", String(revision)],
    ]);
    expect(frames[1].data.totalCostUsd).toBe(0);
  });

  it("drops a terminal database regression without closing, then emits and closes a newer terminal", async () => {
    const { jobId } = createJob("AAPL");
    const abort = new AbortController();
    const response = await streamGET(...requestArgs(jobId, abort.signal));
    handle.db.update(jobs).set({ revision: 5, status: "running" }).where(eq(jobs.id, jobId)).run();
    hint(jobId, 5);
    handle.db.update(jobs).set({ revision: 4, status: "done" }).where(eq(jobs.id, jobId)).run();
    hint(jobId, 4);
    await Promise.resolve();
    expect(subscriberCount(jobId)).toBe(1);
    handle.db.update(jobs).set({ revision: 6, status: "done" }).where(eq(jobs.id, jobId)).run();
    hint(jobId, 6);
    await Promise.resolve();

    expect(parseFrames(await readBody(response)).map((frame) => frame.id)).toEqual(["0", "5", "6"]);
    expect(subscriberCount(jobId)).toBe(0);
    abort.abort();
  });

  it("does not close for a fabricated terminal hint when durable state is nonterminal", async () => {
    const { jobId } = createJob("AAPL");
    const abort = new AbortController();
    const response = await streamGET(...requestArgs(jobId, abort.signal));

    hint(jobId, 999, "done");
    await Promise.resolve();
    const subscribersAfterHint = subscriberCount(jobId);
    abort.abort();
    const frames = parseFrames(await readBody(response));

    expect(subscribersAfterHint).toBe(1);
    expect(frames.map((frame) => frame.event)).toEqual(["snapshot"]);
  });

  it("polls durable nonterminal and terminal revisions without any local publish", async () => {
    vi.useFakeTimers();
    setDbForTests(null);
    handle.sqlite.close();
    const directory = mkdtempSync(join(tmpdir(), "thesis-stream-poll-"));
    directories.push(directory);
    const file = join(directory, "stream.db");
    handle = createDatabase(file);
    const external = createDatabase(file);
    setDbForTests(handle.db);
    const { jobId } = createJob("AAPL");
    const abort = new AbortController();
    let frames: ParsedFrame[] = [];
    let subscribers = -1;
    try {
      const response = await streamGET(...requestArgs(jobId, abort.signal));
      const body = readBody(response);

      const initial = external.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
      external.db.update(jobs).set({
        status: "running",
        revision: 1,
        updatedAt: new Date(Date.parse(initial.updatedAt) + 1).toISOString(),
      }).where(eq(jobs.id, jobId)).run();
      await vi.advanceTimersByTimeAsync(1_001);
      external.db.update(jobs).set({
        status: "done",
        revision: 2,
        updatedAt: new Date(Date.parse(initial.updatedAt) + 2).toISOString(),
      }).where(eq(jobs.id, jobId)).run();
      await vi.advanceTimersByTimeAsync(1_001);
      abort.abort();

      frames = parseFrames(await body);
      subscribers = subscriberCount(jobId);
    } finally {
      external.sqlite.close();
    }
    expect(frames.map((frame) => [frame.id, frame.data.status])).toEqual([
      ["0", "queued"],
      ["1", "running"],
      ["2", "done"],
    ]);
    expect(subscribers).toBe(0);
  });

  it("does not emit a new snapshot for lease-only renewal fields", async () => {
    vi.useFakeTimers();
    const { jobId } = createJob("AAPL");
    const abort = new AbortController();
    const response = await streamGET(...requestArgs(jobId, abort.signal));
    const body = readBody(response);
    handle.db.update(jobs).set({
      heartbeatAt: "2026-08-08T12:01:00.000Z",
      leaseExpiresAt: "2026-08-08T12:02:00.000Z",
    }).where(eq(jobs.id, jobId)).run();

    await vi.advanceTimersByTimeAsync(1_001);
    abort.abort();

    expect(parseFrames(await body).map((frame) => frame.id)).toEqual(["0"]);
  });

  it("closes terminal canceled state from its snapshot without a companion frame", async () => {
    const { jobId } = createJob("AAPL");
    handle.db.update(jobs).set({ status: "canceled" }).where(eq(jobs.id, jobId)).run();
    const abort = new AbortController();
    const response = await streamGET(...requestArgs(jobId, abort.signal));
    await Promise.resolve();
    const subscribersBeforeAbort = subscriberCount(jobId);
    abort.abort();

    const frames = parseFrames(await readBody(response));
    expect(subscribersBeforeAbort).toBe(0);
    expect(frames.map((frame) => frame.event)).toEqual(["snapshot"]);
    expect(frames[0].data.status).toBe("canceled");
  });

  it("keeps a canceled stream open until a retained paid settlement reaches the client", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-08T12:00:00.000Z");
    vi.setSystemTime(now);
    const {
      acquirePaidPassLease,
      authorizePaidPassLaunch,
      claimNextQueuedJob,
      settlePaidPassLease,
    } = await import("@/pipeline/jobScheduler");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 1,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60 * 60 * 1000,
      paidPassLeaseTtlMs: 15 * 60 * 1000,
      jobLeaseTtlMs: 15 * 60 * 1000,
    };
    const { jobId } = createJob("AAPL");
    const claim = claimNextQueuedJob("stream-late-cost", now, limits, handle.db)!;
    const acquired = acquirePaidPassLease(
      claim,
      "bull",
      "stream-late-cost",
      0.5,
      now,
      limits,
      handle.db,
    );
    if (!acquired.acquired) throw new Error("fixture paid lease was not acquired");
    const running = initialSteps();
    running[3] = { ...running[3]!, status: "running", startedAt: now.toISOString() };
    expect(authorizePaidPassLaunch(
      acquired.lease,
      claim.revision,
      JSON.stringify(running),
      now,
      limits,
      handle.db,
    )).not.toBeNull();
    expect(cancelJob(jobId)).toBe(true);
    const canceled = getJobSnapshot(jobId)!;
    expect(canceled).toMatchObject({
      status: "error",
      settlementsPending: true,
      totalCostUsd: 0,
    });

    const response = await streamGET(...requestArgs(jobId));
    const body = readBody(response);
    await Promise.resolve();
    expect(subscriberCount(jobId)).toBe(1);

    expect(settlePaidPassLease(acquired.lease, {
      settlement: {
        outcome: "failure",
        failure: { name: "ProviderError", message: "late billed cancellation" },
        telemetry: {
          model: "test-model",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          webSearches: 0,
          costUsd: 0.2,
          fallbackUsed: false,
          billable: true,
          fetchedUrls: [],
        },
      },
      payloadFingerprint: null,
      settledAt: new Date(now.getTime() + 1).toISOString(),
    }, handle.db, new Date(now.getTime() + 1))).toMatchObject({ inserted: true });
    expect(handle.db.select().from(jobPassArtifacts).where(eq(jobPassArtifacts.jobId, jobId)).all())
      .toHaveLength(1);
    expect(handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all())
      .toHaveLength(1);
    expect(handle.db.select().from(jobLlmLeases).where(eq(jobLlmLeases.jobId, jobId)).all())
      .toEqual([]);
    const finalized = getJobSnapshot(jobId)!;
    expect(finalized).toMatchObject({
      status: "error",
      revision: canceled.revision + 1,
      settlementsPending: false,
      totalCostUsd: 0.2,
    });

    await vi.advanceTimersByTimeAsync(1_001);
    const frames = parseFrames(await body);
    expect(frames.map((frame) => ({
      revision: frame.data.revision,
      pending: frame.data.settlementsPending,
      total: frame.data.totalCostUsd,
    }))).toEqual([
      { revision: canceled.revision, pending: true, total: 0 },
      { revision: canceled.revision + 1, pending: false, total: 0.2 },
    ]);
    expect(subscriberCount(jobId)).toBe(0);
  });
});

describe("stream resource cleanup", () => {
  it("request abort invokes unsubscribe and clears each timer once", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { jobId } = createJob("AAPL");
    const abort = new AbortController();
    const response = await streamGET(...requestArgs(jobId, abort.signal));
    const body = readBody(response);

    abort.abort();
    abort.abort();
    await body;

    expect(snapshotHook.subscribeCalls).toBe(1);
    expect(snapshotHook.unsubscribeCalls).toBe(1);
    const cleared = clearTimeoutSpy.mock.calls.map(([timer]) => timer);
    expect(cleared.length).toBeGreaterThanOrEqual(2);
    expect(new Set(cleared).size).toBe(cleared.length);
  });

  it("allocates no subscriber or timers when the request is already aborted", async () => {
    vi.useFakeTimers();
    const { jobId } = createJob("AAPL");
    const abort = new AbortController();
    abort.abort();
    const beforeTimers = vi.getTimerCount();

    const response = await streamGET(...requestArgs(jobId, abort.signal));
    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(first.done).toBe(true);
    expect(subscriberCount(jobId)).toBe(0);
    expect(vi.getTimerCount()).toBe(beforeTimers);
  });

  it("reader cancel unsubscribes and clears every stream timer exactly once", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { jobId } = createJob("AAPL");
    const beforeTimers = vi.getTimerCount();
    const response = await streamGET(...requestArgs(jobId));
    const reader = response.body!.getReader();
    expect(subscriberCount(jobId)).toBe(1);

    await reader.cancel();
    await Promise.resolve();

    expect(subscriberCount(jobId)).toBe(0);
    expect(vi.getTimerCount()).toBe(beforeTimers);
    expect(snapshotHook.unsubscribeCalls).toBe(1);
    const cleared = clearTimeoutSpy.mock.calls.map(([timer]) => timer);
    expect(new Set(cleared).size).toBe(cleared.length);
  });

  it("bounds transient snapshot retries at 250/500/1000ms then closes for reconnect", async () => {
    vi.useFakeTimers();
    const { jobId } = createJob("AAPL");
    snapshotHook.failFromCall = 2;

    const response = await streamGET(...requestArgs(jobId));
    const body = readBody(response);
    await vi.advanceTimersByTimeAsync(3_001);

    await expect(body).resolves.toBeTypeOf("string");
    expect(snapshotHook.calls).toBe(5);
    expect(subscriberCount(jobId)).toBe(0);
  });
});
