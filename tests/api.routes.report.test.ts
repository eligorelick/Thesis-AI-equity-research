/**
 * Handler-level tests for the report API routes (audit test-gap finding: "No
 * API-route handler tests"). These import the route modules' exported POST/GET
 * functions directly and invoke them with constructed Request objects + params,
 * against an in-memory better-sqlite3 database (setDbForTests) — the same DB
 * setup jobRunner.test.ts uses.
 *
 * The pass runner is stubbed: runJob is mocked to a no-op so NOTHING hits the
 * network or an LLM. createJob / getReusableActiveJobForSymbol / the resume
 * helpers / sweepAbandonedJobs are kept REAL (they only touch the DB) via
 * importOriginal, so the route's own control flow (dedup, 404/409 guards,
 * atomic claim) is exercised for real.
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
const { runJobMock } = vi.hoisted(() => ({
  runJobMock: vi.fn(async () => ({
    status: "done" as const,
    reportId: null,
    dataOnly: true,
    verificationRate: null,
    totalCostUsd: 0,
  })),
}));

/** The recorded runJob call args (the no-arg mock signature erases them). */
function runJobCalls(): unknown[][] {
  return runJobMock.mock.calls as unknown as unknown[][];
}
vi.mock("@/pipeline/jobRunner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/jobRunner")>();
  return { ...actual, runJob: runJobMock };
});

import {
  createDatabase,
  setDbForTests,
  type DatabaseHandle,
} from "@/db";
import { jobs, reports } from "@/db/schema";
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
});

afterEach(() => {
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

  it("accepts a valid symbol, creates a queued job, and dispatches runJob (202)", async () => {
    const res = await reportPOST(reportRequest({ symbol: "aapl" }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; existing?: boolean };
    expect(typeof body.jobId).toBe("string");
    expect(body.existing).toBeUndefined();

    // Job persisted, symbol uppercased.
    const row = handle.db.select().from(jobs).where(eq(jobs.id, body.jobId)).get();
    expect(row?.symbol).toBe("AAPL");
    expect(row?.status).toBe("queued");

    // Background dispatch reached the (stubbed) runJob for this job id.
    await vi.waitFor(() => {
      expect(runJobMock).toHaveBeenCalledTimes(1);
      expect(runJobCalls()[0]?.[0]).toBe(body.jobId);
    });
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
  });
});

/* ------------------------------------------------------------------------ *
 * GET /api/report/[jobId]
 * ------------------------------------------------------------------------ */

describe("GET /api/report/[jobId]", () => {
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
    await vi.waitFor(() => expect(runJobMock).toHaveBeenCalledTimes(1));
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

    // A resume dispatch reached the stubbed runJob with the resume flag.
    await vi.waitFor(() => {
      expect(runJobMock).toHaveBeenCalledTimes(1);
      expect(runJobCalls()[0]?.[0]).toBe(jobId);
      expect(runJobCalls()[0]?.[2]).toMatchObject({ resume: true });
    });

    // A second retry now sees a queued job → 409 (atomic single-claim), and does
    // NOT dispatch runJob again.
    const second = await retryPOST(...retryReq(jobId));
    expect(second.status).toBe(409);
    expect(runJobMock).toHaveBeenCalledTimes(1);
  });

  it("terminalizes a detached pre-run failure without leaking its raw detail or stranding queued", async () => {
    const jobId = seedResumableJob("AAPL");
    runJobMock.mockRejectedValueOnce(new Error("raw provider payload: secret-response-body"));

    const res = await retryPOST(...retryReq(jobId));

    expect(res.status).toBe(202);
    await vi.waitFor(() => {
      expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
        status: "error",
        runGeneration: 1,
        error: "runJob: queued retry dispatch failed before execution",
      });
    });
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.error).not.toContain(
      "secret-response-body",
    );
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

    expect((await cancelPOST(...cancelReq(jobId))).status).toBe(409);
  });
});
