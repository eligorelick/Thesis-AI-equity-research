/**
 * Handler-level tests for the report API routes (audit test-gap finding: "No
 * API-route handler tests"). These import the route modules' exported POST/GET
 * functions directly and invoke them with constructed Request objects + params,
 * against an in-memory better-sqlite3 database (setDbForTests) — the same DB
 * setup jobRunner.test.ts uses.
 *
 * The durable scheduler kick and legacy pass runner are both stubbed so
 * NOTHING hits the network or an LLM. Route handlers may enqueue and kick,
 * but must never own a detached runJob promise.
 *
 * Coverage:
 *   POST /api/report               — symbol validation (regex/length),
 *                                    non-JSON body, duplicate POST reuses job.
 *   GET  /api/report/[jobId]       — 404 unknown id, snapshot shape persisted.
 *   POST /api/report/[jobId]/retry — 404 unknown, 409 running, 409 non-resumable
 *                                    shape, 409 no snapshots, resume claims
 *                                    atomically (second retry 409).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// The stageC dynamic import (via resolvePasses) can transitively pull the
// `server-only` shim, absent under the plain-node runner. Stub it to a no-op.
vi.mock("server-only", () => ({}));

// Stub the expensive part: runJob. Everything else in jobRunner is the real
// implementation (createJob, the resume helpers, sweeps, snapshot readers) so
// the routes' guards run against a real DB. runJob is fire-and-forget in the
// routes; the stub resolves instantly and never touches providers or an LLM.
// vi.hoisted so the mock fn exists when the hoisted vi.mock factory runs.
const {
  runJobMock,
  kickJobSchedulerMock,
  reconcileExpiredJobClaimsMock,
  reconcileExpiredSchedulerStateInTransactionMock,
} = vi.hoisted(() => ({
  runJobMock: vi.fn(async () => ({
    status: "done" as const,
    reportId: null,
    dataOnly: true,
    verificationRate: null,
    totalCostUsd: 0,
  })),
  kickJobSchedulerMock: vi.fn(),
  reconcileExpiredJobClaimsMock: vi.fn(() => 0),
  reconcileExpiredSchedulerStateInTransactionMock: vi
    .fn<(db: unknown, now: Date) => number>()
    .mockReturnValue(0),
}));

vi.mock("@/pipeline/jobRunner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/jobRunner")>();
  return { ...actual, runJob: runJobMock };
});
vi.mock("@/pipeline/jobScheduler", () => ({
  kickJobScheduler: kickJobSchedulerMock,
  reconcileExpiredJobClaims: reconcileExpiredJobClaimsMock,
  reconcileExpiredSchedulerStateInTransaction: reconcileExpiredSchedulerStateInTransactionMock,
  configuredSchedulerLimits: vi.fn(() => ({
    maxActiveJobs: 1,
    maxActiveLlmCalls: 2,
    maxRollingCostUsd: null,
    rollingCostWindowMs: 86_400_000,
    paidPassLeaseTtlMs: 900_000,
    jobLeaseTtlMs: 900_000,
  })),
}));

import {
  createDatabase,
  setDbForTests,
  type DatabaseHandle,
} from "@/db";
import { costLog, jobs, reports } from "@/db/schema";
import { createJob as createJobReal, initialSteps } from "@/pipeline/jobRunner";
import { persistPassSettlement } from "@/pipeline/jobArtifacts";
import type { StepProgress } from "@/types/core";
import { PIPELINE_STEPS } from "@/types/core";
import type { AnalystCase } from "@/report/schema";

import { POST as reportPOST } from "@/app/api/report/route";
import { GET as reportGET } from "@/app/api/report/[jobId]/route";
import { POST as retryPOST } from "@/app/api/report/[jobId]/retry/route";
import { POST as cancelPOST } from "@/app/api/report/[jobId]/cancel/route";

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

let handle: DatabaseHandle;

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
  runJobMock.mockClear();
  kickJobSchedulerMock.mockClear();
  reconcileExpiredSchedulerStateInTransactionMock.mockReset();
  reconcileExpiredSchedulerStateInTransactionMock.mockImplementation((db, now) => {
    const target = db as DatabaseHandle["db"];
    const at = now.toISOString();
    let changed = 0;
    for (const row of target.select().from(jobs).all()) {
      if (row.status !== "running" || (row.leaseExpiresAt !== null && row.leaseExpiresAt > at)) continue;
      changed += target.update(jobs).set({
        status: "error",
        error: "job lease expired before completion",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: at,
        revision: row.revision + 1,
      }).where(eq(jobs.id, row.id)).run().changes;
    }
    return changed;
  });
  reconcileExpiredJobClaimsMock.mockReset();
  reconcileExpiredJobClaimsMock.mockImplementation(() => {
    const at = new Date().toISOString();
    let changed = 0;
    for (const row of handle.db.select().from(jobs).all()) {
      if (row.status !== "running" || (row.leaseExpiresAt !== null && row.leaseExpiresAt > at)) continue;
      changed += handle.db.update(jobs).set({
        status: "error",
        error: "job lease expired before completion",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: at,
        revision: row.revision + 1,
      }).where(eq(jobs.id, row.id)).run().changes;
    }
    return changed;
  });
});

afterEach(() => {
  // vitest currently reuses module registries across files in a worker. Do not
  // leak this file's DB-closing reconciliation fixture into same-origin route
  // tests that import the shared mocked scheduler later in the same worker.
  reconcileExpiredJobClaimsMock.mockReset();
  reconcileExpiredJobClaimsMock.mockReturnValue(0);
  reconcileExpiredSchedulerStateInTransactionMock.mockReset();
  reconcileExpiredSchedulerStateInTransactionMock.mockReturnValue(0);
  setDbForTests(null);
  handle.sqlite.close();
});

/** POST /api/report with a JSON body. */
function reportRequest(body: unknown): Request {
  return new Request("http://localhost/api/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A schema-valid AnalystCase for a persisted resume snapshot. */
function fakeAnalystCase(): AnalystCase {
  return {
    thesis: [{ text: "t", label: "JUDGMENT", source: "payload", asOf: null }],
    keyDrivers: [],
    risksToCase: [],
    catalysts: [],
    priceTarget: { value: 250, horizon: "12mo", assumptions: [] },
    evidence: [],
  };
}

function passSnapshotJson(costUsd: number): string {
  return JSON.stringify({
    data: fakeAnalystCase(),
    model: "claude-opus-4-8",
    costUsd,
    fallbackUsed: false,
  });
}

/**
 * Seed a job in the RESUMABLE failure shape: bull/bear done, synthesize error,
 * terminal status "error", both analyst snapshots persisted.
 */
function seedResumableJob(symbol = "AAPL"): string {
  const { jobId } = createJobReal(symbol);
  const steps: Pick<StepProgress, "step" | "status">[] = initialSteps().map((s) => {
    if (s.step === "bull" || s.step === "bear") return { step: s.step, status: "done" };
    if (s.step === "synthesize") return { step: s.step, status: "error" };
    return { step: s.step, status: "done" };
  });
  handle.db
    .update(jobs)
    .set({
      status: "error",
      error: "synthesize failed (transport)",
      stepsJson: JSON.stringify(steps),
      bullJson: passSnapshotJson(0.9),
      bearJson: passSnapshotJson(0.47),
      payloadFingerprint: "1.3.0:api-resume",
    })
    .where(eq(jobs.id, jobId))
    .run();
  return jobId;
}

/* ------------------------------------------------------------------------ *
 * POST /api/report
 * ------------------------------------------------------------------------ */

describe("POST /api/report", () => {
  it("rejects a non-JSON body with 400", async () => {
    const req = new Request("http://localhost/api/report", {
      method: "POST",
      body: "not json{",
    });
    const res = await reportPOST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("JSON");
    // No job created, no runJob dispatched.
    expect(handle.db.select().from(jobs).all()).toHaveLength(0);
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("rejects a missing symbol with 400", async () => {
    const res = await reportPOST(reportRequest({}));
    expect(res.status).toBe(400);
    expect(handle.db.select().from(jobs).all()).toHaveLength(0);
  });

  it("rejects a symbol with illegal characters (regex) with 400", async () => {
    const res = await reportPOST(reportRequest({ symbol: "AA PL$" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid request");
    expect(handle.db.select().from(jobs).all()).toHaveLength(0);
  });

  it("rejects an over-length symbol with 400", async () => {
    const res = await reportPOST(reportRequest({ symbol: "ABCDEFGHIJKLM" })); // 13 > max 12
    expect(res.status).toBe(400);
    expect(handle.db.select().from(jobs).all()).toHaveLength(0);
  });

  it("accepts a valid symbol, creates a queued job, and kicks the durable scheduler (202)", async () => {
    const res = await reportPOST(reportRequest({ symbol: "aapl" }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; existing?: boolean };
    expect(typeof body.jobId).toBe("string");
    expect(body.existing).toBeUndefined();

    // Job persisted, symbol uppercased.
    const row = handle.db.select().from(jobs).where(eq(jobs.id, body.jobId)).get();
    expect(row?.symbol).toBe("AAPL");
    expect(row?.status).toBe("queued");

    expect(kickJobSchedulerMock).toHaveBeenCalledTimes(1);
    expect(kickJobSchedulerMock.mock.calls[0]?.[0]).toEqual(expect.any(Function));
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("returns the SAME job with existing:true on a duplicate POST for an active symbol", async () => {
    const first = (await (await reportPOST(reportRequest({ symbol: "MSFT" }))).json()) as {
      jobId: string;
    };
    const secondRes = await reportPOST(reportRequest({ symbol: "msft" }));
    expect(secondRes.status).toBe(202);
    const second = (await secondRes.json()) as { jobId: string; existing?: boolean };
    expect(second.existing).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    // Only one job row exists for the symbol (no double-create).
    expect(
      handle.db.select().from(jobs).where(eq(jobs.symbol, "MSFT")).all(),
    ).toHaveLength(1);
    expect(kickJobSchedulerMock).toHaveBeenCalledTimes(2);
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("atomically replaces an expired same-symbol owner instead of returning it as existing", async () => {
    const first = (await (await reportPOST(reportRequest({ symbol: "NVDA" }))).json()) as {
      jobId: string;
    };
    handle.db.update(jobs).set({
      status: "running",
      leaseOwner: "expired-post-owner",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      leaseExpiresAt: "2000-01-01T00:00:01.000Z",
    }).where(eq(jobs.id, first.jobId)).run();

    const response = await reportPOST(reportRequest({ symbol: "nvda" }));
    const body = (await response.json()) as { jobId: string; existing?: boolean };

    expect(response.status).toBe(202);
    expect(body.existing).toBeUndefined();
    expect(body.jobId).not.toBe(first.jobId);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, first.jobId)).get()).toMatchObject({
      status: "error",
      leaseOwner: null,
    });
    expect(handle.db.select().from(jobs).where(eq(jobs.id, body.jobId)).get()).toMatchObject({
      status: "queued",
      symbol: "NVDA",
    });
    expect(kickJobSchedulerMock).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------------ *
 * GET /api/report/[jobId]
 * ------------------------------------------------------------------------ */

describe("GET /api/report/[jobId]", () => {
  it("uses live all-generation ledger truth after a linked terminal report freezes its cost", async () => {
    const { jobId } = createJobReal("AAPL");
    const report = handle.db.insert(reports).values({
      symbol: "AAPL",
      createdAt: "2026-08-08T00:00:00.000Z",
      model: "claude-opus-4-8",
      status: "done",
      reportJson: null,
      verificationRate: 1,
      costUsd: 0.4,
      specVersion: "1.0.0",
    }).returning({ id: reports.id }).get();
    handle.db.insert(costLog).values([
      {
        jobId,
        runGeneration: 0,
        attemptId: "reported",
        step: "bull",
        model: "claude-opus-4-8",
        costUsd: 0.4,
        createdAt: "2026-08-08T00:00:00.000Z",
      },
      {
        jobId,
        runGeneration: 0,
        attemptId: "late",
        step: "bear",
        model: "claude-opus-4-8",
        costUsd: 0.2,
        createdAt: "2026-08-08T00:01:00.000Z",
      },
    ]).run();
    handle.db.update(jobs).set({
      status: "done",
      reportId: report.id,
      revision: 3,
    }).where(eq(jobs.id, jobId)).run();

    const response = await reportGET(new Request(`http://localhost/api/report/${jobId}`), {
      params: Promise.resolve({ jobId }),
    });

    const snapshot = await response.json() as { revision: number; totalCostUsd: number };
    expect(snapshot.revision).toBe(3);
    expect(snapshot.totalCostUsd).toBeCloseTo(0.6, 10);
    expect(handle.db.select().from(reports).where(eq(reports.id, report.id)).get()?.costUsd)
      .toBe(0.4);
  });

  it("uses linked report cost only as a legacy fallback when no durable ledger rows exist", async () => {
    const { jobId } = createJobReal("AAPL");
    const report = handle.db.insert(reports).values({
      symbol: "AAPL",
      createdAt: "2026-08-08T00:00:00.000Z",
      model: "legacy-model",
      status: "done",
      reportJson: null,
      verificationRate: null,
      costUsd: 0.75,
      specVersion: "0.9.0",
    }).returning({ id: reports.id }).get();
    handle.db.update(jobs).set({ status: "done", reportId: report.id, revision: 1 })
      .where(eq(jobs.id, jobId)).run();

    const response = await reportGET(new Request(`http://localhost/api/report/${jobId}`), {
      params: Promise.resolve({ jobId }),
    });

    expect(await response.json()).toMatchObject({ totalCostUsd: 0.75 });
  });

  it("returns 404 for an unknown job id", async () => {
    const res = await reportGET(new Request("http://localhost/api/report/nope"), {
      params: Promise.resolve({ jobId: "does-not-exist" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does-not-exist");
  });

  it("returns the persisted snapshot shape for a real job", async () => {
    const { jobId } = createJobReal("AAPL");
    const res = await reportGET(new Request(`http://localhost/api/report/${jobId}`), {
      params: Promise.resolve({ jobId }),
    });
    expect(res.status).toBe(200);
    const snap = (await res.json()) as {
      jobId: string;
      symbol: string;
      status: string;
      steps: StepProgress[];
      reportId: number | null;
      totalCostUsd: number;
      dataOnly: boolean;
      resumable: boolean;
    };
    expect(snap.jobId).toBe(jobId);
    expect(snap.symbol).toBe("AAPL");
    expect(snap.status).toBe("queued");
    expect(snap.steps.map((s) => s.step)).toEqual([...PIPELINE_STEPS]);
    expect(snap.steps.every((s) => s.status === "pending")).toBe(true);
    expect(snap.reportId).toBeNull();
    expect(snap.totalCostUsd).toBe(0);
    expect(snap.resumable).toBe(false);
  });

  it.each([
    ["duplicate", [
      { step: "fetch", status: "error" },
      { step: "fetch", status: "skipped" },
    ]],
    ["out-of-order", [
      { step: "validate", status: "skipped" },
      { step: "fetch", status: "error" },
    ]],
    ["invalid fields", [{ step: "fetch", status: "finished", costUsd: -1 }]],
  ])("sanitizes a terminal %s stored step array to an empty safe snapshot", async (_label, value) => {
    const { jobId } = createJobReal("AAPL");
    handle.db.update(jobs).set({
      status: "error",
      error: "terminal legacy row",
      stepsJson: JSON.stringify(value),
      revision: 1,
    }).where(eq(jobs.id, jobId)).run();

    const response = await reportGET(new Request(`http://localhost/api/report/${jobId}`), {
      params: Promise.resolve({ jobId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "error", revision: 1, steps: [] });
  });

  it("does not use updatedAt as write authority while polling a running job", async () => {
    const { jobId } = createJobReal("AAPL");
    handle.db.update(jobs).set({
      status: "running",
      updatedAt: "2000-01-01T00:00:00.000Z",
      leaseOwner: "live:owner",
      heartbeatAt: "2026-08-08T12:00:00.000Z",
      leaseExpiresAt: "2999-01-01T00:00:00.000Z",
      revision: 7,
    }).where(eq(jobs.id, jobId)).run();

    expect((await reportGET(new Request(`http://localhost/api/report/${jobId}`), {
      params: Promise.resolve({ jobId }),
    })).status).toBe(200);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "running",
      revision: 7,
      leaseOwner: "live:owner",
      updatedAt: "2000-01-01T00:00:00.000Z",
    });
  });

  it("exposes authoritative resumable true even when synthesize steps lie done", async () => {
    const jobId = seedResumableJob("AAPL");
    const lyingSteps = initialSteps().map((step) => ({
      step: step.step,
      status: step.step === "synthesize" ? ("done" as const) : ("error" as const),
    }));
    handle.db
      .update(jobs)
      .set({ status: "done", stepsJson: JSON.stringify(lyingSteps) })
      .where(eq(jobs.id, jobId))
      .run();

    const res = await reportGET(new Request(`http://localhost/api/report/${jobId}`), {
      params: Promise.resolve({ jobId }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { resumable: boolean }).toMatchObject({ resumable: true });
  });

  it("exposes authoritative resumable false when reportId names an existing row", async () => {
    const jobId = seedResumableJob("AAPL");
    const report = handle.db
      .insert(reports)
      .values({
        symbol: "AAPL",
        createdAt: "2026-08-08T00:00:00.000Z",
        model: "claude-opus-4-8",
        status: "done",
        reportJson: "{corrupt-json",
        verificationRate: null,
        costUsd: 1.37,
        specVersion: "1.0.0",
      })
      .returning({ id: reports.id })
      .get();
    handle.db.update(jobs).set({ reportId: report.id }).where(eq(jobs.id, jobId)).run();

    const res = await reportGET(new Request(`http://localhost/api/report/${jobId}`), {
      params: Promise.resolve({ jobId }),
    });

    expect((await res.json()) as { resumable: boolean }).toMatchObject({ resumable: false });
  });

  it.each([null, "   "])(
    "keeps current analyst provenance %j non-resumable across GET and retry claim",
    async (payloadFingerprint) => {
      const { jobId } = createJobReal("AAPL");
      persistPassSettlement({
        jobId,
        runGeneration: 0,
        attemptId: payloadFingerprint === null ? "unknown-current-null" : "unknown-current-blank",
        pass: "bull",
        settlement: {
          outcome: "success",
          data: fakeAnalystCase(),
          telemetry: {
            model: "claude-opus-4-8",
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            webSearches: 0,
            costUsd: 0.1,
            fallbackUsed: false,
            billable: true,
            fetchedUrls: [],
          },
        },
        payloadFingerprint,
        settledAt: "2026-08-08T00:00:00.000Z",
      });
      handle.db
        .update(jobs)
        .set({ status: "error", error: "source failed", reportId: null })
        .where(eq(jobs.id, jobId))
        .run();

      const get = await reportGET(new Request(`http://localhost/api/report/${jobId}`), {
        params: Promise.resolve({ jobId }),
      });
      expect((await get.json()) as { resumable: boolean }).toMatchObject({ resumable: false });

      const retry = await retryPOST(
        new Request(`http://localhost/api/report/${jobId}/retry`, { method: "POST" }),
        { params: Promise.resolve({ jobId }) },
      );
      expect(retry.status).toBe(409);
      expect(runJobMock).not.toHaveBeenCalled();
      expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
        status: "error",
        runGeneration: 0,
      });
    },
  );
});

/* ------------------------------------------------------------------------ *
 * POST /api/report/[jobId]/retry
 * ------------------------------------------------------------------------ */

describe("POST /api/report/[jobId]/retry", () => {
  function retryReq(jobId: string): [Request, { params: Promise<{ jobId: string }> }] {
    return [
      new Request(`http://localhost/api/report/${jobId}/retry`, { method: "POST" }),
      { params: Promise.resolve({ jobId }) },
    ];
  }

  it("returns 404 for an unknown job id", async () => {
    const res = await retryPOST(...retryReq("missing-job"));
    expect(res.status).toBe(404);
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the job is still queued/running", async () => {
    const { jobId } = createJobReal("AAPL"); // status "queued"
    const res = await retryPOST(...retryReq(jobId));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("still active");
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported before reusable snapshots can claim or dispatch paid retry work", async () => {
    const jobId = seedResumableJob("SPY");
    handle.db
      .update(jobs)
      .set({
        status: "unsupported",
        error: null,
        unsupportedKind: "etf",
        unsupportedMessage: "ETF analysis is not supported; companies only.",
      })
      .where(eq(jobs.id, jobId))
      .run();

    const res = await retryPOST(...retryReq(jobId));

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/unsupported/i),
    });
    expect(runJobMock).not.toHaveBeenCalled();
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "unsupported",
      unsupportedKind: "etf",
    });
  });

  it("returns 409 for a terminal job that is NOT in the resumable shape (healthy synthesize)", async () => {
    const { jobId } = createJobReal("AAPL");
    const steps = initialSteps().map((s) => ({ step: s.step, status: "done" as const }));
    handle.db
      .update(jobs)
      .set({ status: "done", stepsJson: JSON.stringify(steps) })
      .where(eq(jobs.id, jobId))
      .run();
    const res = await retryPOST(...retryReq(jobId));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not in a resumable state");
    expect(runJobMock).not.toHaveBeenCalled();
    // The healthy job's terminal state is untouched.
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.status).toBe("done");
  });

  it("reconciles an expired same-symbol owner before enqueueing a resumable retry", async () => {
    const target = seedResumableJob("AAPL");
    const { jobId: expired } = createJobReal("AAPL");
    handle.db.update(jobs).set({
      status: "running",
      revision: 1,
      leaseOwner: "expired:nonce",
      heartbeatAt: new Date(Date.now() - 2_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    }).where(eq(jobs.id, expired)).run();

    const res = await retryPOST(...retryReq(target));

    const body = await res.clone().json();
    expect(res.status, JSON.stringify({ body, rows: handle.db.select().from(jobs).all() })).toBe(202);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, expired)).get())
      .toMatchObject({ status: "error", leaseOwner: null, revision: 2 });
    expect(handle.db.select().from(jobs).where(eq(jobs.id, target)).get())
      .toMatchObject({ status: "queued", runGeneration: 1 });
    expect(kickJobSchedulerMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a live same-symbol owner as a retry conflict", async () => {
    const target = seedResumableJob("AAPL");
    const { jobId: live } = createJobReal("AAPL");
    handle.db.update(jobs).set({
      status: "running",
      revision: 1,
      leaseOwner: "live:nonce",
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).where(eq(jobs.id, live)).run();

    const res = await retryPOST(...retryReq(target));

    expect(res.status).toBe(409);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, live)).get()?.status).toBe("running");
    expect(handle.db.select().from(jobs).where(eq(jobs.id, target)).get()?.status).toBe("error");
    expect(kickJobSchedulerMock).not.toHaveBeenCalled();
  });

  it("retries from durable legacy analysts even when synthesize steps lie done", async () => {
    const jobId = seedResumableJob("AAPL");
    handle.db
      .update(jobs)
      .set({
        status: "done",
        stepsJson: JSON.stringify([
          { step: "bull", status: "error" },
          { step: "bear", status: "error" },
          { step: "synthesize", status: "done" },
        ] satisfies StepProgress[]),
      })
      .where(eq(jobs.id, jobId))
      .run();

    const res = await retryPOST(...retryReq(jobId));

    expect(res.status).toBe(202);
    expect(kickJobSchedulerMock).toHaveBeenCalledTimes(1);
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("does not retry a job whose reportId names an existing report row", async () => {
    const jobId = seedResumableJob("AAPL");
    const report = handle.db
      .insert(reports)
      .values({
        symbol: "AAPL",
        createdAt: "2026-08-08T00:00:00.000Z",
        model: "claude-opus-4-8",
        status: "done",
        reportJson: null,
        verificationRate: null,
        costUsd: 1.37,
        specVersion: "1.0.0",
      })
      .returning({ id: reports.id })
      .get();
    handle.db.update(jobs).set({ reportId: report.id }).where(eq(jobs.id, jobId)).run();

    const res = await retryPOST(...retryReq(jobId));

    expect(res.status).toBe(409);
    expect(runJobMock).not.toHaveBeenCalled();
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "error",
      reportId: report.id,
    });
  });

  it("returns 409 when the resumable shape has no persisted snapshots", async () => {
    const { jobId } = createJobReal("AAPL");
    const steps = initialSteps().map((s) => {
      if (s.step === "bull" || s.step === "bear") return { step: s.step, status: "done" as const };
      if (s.step === "synthesize") return { step: s.step, status: "error" as const };
      return { step: s.step, status: "done" as const };
    });
    // Resumable steps, but bullJson/bearJson never persisted.
    handle.db
      .update(jobs)
      .set({ status: "error", stepsJson: JSON.stringify(steps) })
      .where(eq(jobs.id, jobId))
      .run();
    const res = await retryPOST(...retryReq(jobId));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no reusable successful pass artifact");
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("resumes a valid failed job (202), claims it atomically, and rejects a second concurrent retry with 409", async () => {
    const jobId = seedResumableJob("AAPL");

    const res = await retryPOST(...retryReq(jobId));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; resumed: boolean };
    expect(body).toEqual({ jobId, resumed: true });

    // The claim flipped the terminal job to "queued" and cleared reportId/error
    // synchronously (before the fire-and-forget runJob).
    const claimed = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(claimed?.status).toBe("queued");
    expect(claimed?.error).toBeNull();
    expect(claimed?.reportId).toBeNull();

    // Route ownership ends after durable enqueue + scheduler notification.
    expect(kickJobSchedulerMock).toHaveBeenCalledTimes(1);
    expect(runJobMock).not.toHaveBeenCalled();

    // A second retry now sees a queued job → 409 (atomic single-claim), and does
    // NOT dispatch runJob again.
    const second = await retryPOST(...retryReq(jobId));
    expect(second.status).toBe(409);
    expect(kickJobSchedulerMock).toHaveBeenCalledTimes(1);
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it("leaves execution ownership to the scheduler after an accepted retry", async () => {
    const jobId = seedResumableJob("AAPL");

    const res = await retryPOST(...retryReq(jobId));

    expect(res.status).toBe(202);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "queued",
      runGeneration: 1,
      error: null,
    });
    expect(kickJobSchedulerMock).toHaveBeenCalledTimes(1);
    expect(runJobMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/report/[jobId]/cancel", () => {
  const cancelReq = (jobId: string): [Request, { params: Promise<{ jobId: string }> }] => [
    new Request(`http://localhost/api/report/${jobId}/cancel`, { method: "POST" }),
    { params: Promise.resolve({ jobId }) },
  ];

  it("returns 404 for an unknown job", async () => {
    expect((await cancelPOST(...cancelReq("missing"))).status).toBe(404);
  });

  it("atomically cancels a queued job and makes repeated cancellation terminal", async () => {
    const { jobId } = createJobReal("NVDA");
    const first = await cancelPOST(...cancelReq(jobId));
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ jobId, canceled: true });
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row?.status).toBe("error");
    expect(row?.error).toContain("canceled by user");
    expect(kickJobSchedulerMock).toHaveBeenCalledTimes(1);
    expect(runJobMock).not.toHaveBeenCalled();

    expect((await cancelPOST(...cancelReq(jobId))).status).toBe(409);
  });
});
