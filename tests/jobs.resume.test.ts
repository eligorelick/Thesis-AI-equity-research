/**
 * THESIS_RESUME_ON_START and POST /api/jobs/resume (WS8, D-21).
 *
 * A queued job is PAID work. With the flag at 0 a Node start must claim
 * nothing and arm no durable wake timer; the queue stays untouched until an
 * operator resumes it. With the default 1 the pre-existing bootstrap behavior
 * is unchanged. The scheduler harness mirrors tests/jobScheduler.test.ts: a
 * real on-disk SQLite database, a stubbed runClaim, and fake timers so an
 * armed wake timer would be observable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import {
  createDatabase,
  setDbForTests,
  type DatabaseHandle,
  type ThesisDb,
} from "@/db";
import { jobs } from "@/db/schema";
import { initialSteps } from "@/pipeline/jobRunner";
import { resetConfigCache } from "@/config/env";
import type { SchedulerKickOptions } from "@/pipeline/jobScheduler";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const LIMITS = {
  maxActiveJobs: 1,
  maxActiveLlmCalls: 1,
  maxRollingCostUsd: null,
  rollingCostWindowMs: 60 * 60 * 1000,
  paidPassLeaseTtlMs: 15 * 60 * 1000,
  jobLeaseTtlMs: 15 * 60 * 1000,
} as const;

let directory: string;
let handle: DatabaseHandle;

async function scheduler(): Promise<typeof import("@/pipeline/jobScheduler")> {
  return import("@/pipeline/jobScheduler");
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "thesis-resume-on-start-"));
  handle = createDatabase(join(directory, "scheduler.db"));
  setDbForTests(handle.db);
  delete process.env.THESIS_RESUME_ON_START;
  resetConfigCache();
});

afterEach(async () => {
  const { _resetJobSchedulerForTests } = await scheduler();
  _resetJobSchedulerForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.THESIS_RESUME_ON_START;
  resetConfigCache();
  setDbForTests(null);
  handle.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

function seedQueuedJob(db: ThesisDb, id: string, symbol: string): void {
  const now = NOW.toISOString();
  db.insert(jobs)
    .values({
      id,
      symbol,
      status: "queued",
      stepsJson: JSON.stringify(initialSteps()),
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
    })
    .run();
}

/** Bootstrap with a stubbed claim runner; returns the job ids it launched. */
async function bootstrapCapturingClaims(): Promise<{
  started: boolean;
  launched: string[];
}> {
  const { terminalizeClaim } = await scheduler();
  const launched: string[] = [];
  const options: SchedulerKickOptions = {
    limits: LIMITS,
    now: () => new Date(),
    runClaim: async (claim) => {
      launched.push(claim.jobId);
      terminalizeClaim(claim, "error", "test complete", new Date(), handle.db);
    },
  };
  const { bootstrapReportScheduler } = await import("@/pipeline/jobSchedulerBootstrap");
  const started = await bootstrapReportScheduler(options);
  await vi.advanceTimersByTimeAsync(0);
  return { started, launched };
}

describe("THESIS_RESUME_ON_START", () => {
  it("holds a pre-existing queued job on bootstrap when set to 0", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { _resetJobSchedulerForTests } = await scheduler();
    _resetJobSchedulerForTests();
    process.env.THESIS_RESUME_ON_START = "0";
    resetConfigCache();
    seedQueuedJob(handle.db, "held-queued", "AAPL");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const { started, launched } = await bootstrapCapturingClaims();

    expect(started).toBe(false);
    expect(launched).toEqual([]);
    // Untouched: still queued, unclaimed, at its original revision.
    expect(handle.db.select().from(jobs).where(eq(jobs.id, "held-queued")).get()).toMatchObject({
      status: "queued",
      revision: 0,
      leaseOwner: null,
    });
    expect(String(info.mock.calls.at(-1)?.[0])).toContain("THESIS_RESUME_ON_START=0");

    // No durable wake timer was armed, so time passing changes nothing.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(
      handle.db.select().from(jobs).where(eq(jobs.id, "held-queued")).get()?.status,
    ).toBe("queued");
  });

  it("claims the same job after an explicit resume", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { _resetJobSchedulerForTests, terminalizeClaim } = await scheduler();
    _resetJobSchedulerForTests();
    process.env.THESIS_RESUME_ON_START = "0";
    resetConfigCache();
    seedQueuedJob(handle.db, "resumed-queued", "AAPL");
    vi.spyOn(console, "info").mockImplementation(() => {});

    const { launched } = await bootstrapCapturingClaims();
    expect(launched).toEqual([]);

    const { resumeReportScheduler } = await import("@/pipeline/jobSchedulerBootstrap");
    await resumeReportScheduler({
      limits: LIMITS,
      now: () => new Date(),
      runClaim: async (claim) => {
        launched.push(claim.jobId);
        terminalizeClaim(claim, "error", "test complete", new Date(), handle.db);
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(launched).toEqual(["resumed-queued"]);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, "resumed-queued")).get()).toMatchObject({
      status: "error",
      leaseOwner: null,
    });
  });

  it("claims a pre-existing queued job on bootstrap by default (unset and 1)", async () => {
    for (const value of [undefined, "1"] as const) {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const { _resetJobSchedulerForTests } = await scheduler();
      _resetJobSchedulerForTests();
      if (value === undefined) delete process.env.THESIS_RESUME_ON_START;
      else process.env.THESIS_RESUME_ON_START = value;
      resetConfigCache();
      const id = `startup-queued-${value ?? "unset"}`;
      seedQueuedJob(handle.db, id, "AAPL");

      const { started, launched } = await bootstrapCapturingClaims();

      expect(started, String(value)).toBe(true);
      expect(launched, String(value)).toEqual([id]);
      expect(handle.db.select().from(jobs).where(eq(jobs.id, id)).get()).toMatchObject({
        status: "error",
        revision: 2,
        leaseOwner: null,
      });
      _resetJobSchedulerForTests();
      vi.useRealTimers();
    }
  });
});

describe("POST /api/jobs/resume", () => {
  /** The same-origin guard is exercised in tests/api.routes.sameOrigin.test.ts. */
  const SAME_ORIGIN = { "sec-fetch-site": "same-origin" } as const;

  function resumeRequest(headers: Record<string, string> = SAME_ORIGIN): Request {
    return new Request("http://localhost/api/jobs/resume", {
      method: "POST",
      headers: { host: "localhost", ...headers },
    });
  }

  it("kicks the scheduler and reports how many jobs are queued", async () => {
    const kickJobScheduler = vi.fn();
    vi.doMock("@/pipeline/jobScheduler", () => ({ kickJobScheduler }));
    try {
      seedQueuedJob(handle.db, "queued-a", "AAPL");
      seedQueuedJob(handle.db, "queued-b", "MSFT");
      const { POST } = await import("@/app/api/jobs/resume/route");

      const response = await POST(resumeRequest());

      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ resumed: true, queued: 2 });
      expect(kickJobScheduler).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("@/pipeline/jobScheduler");
      vi.resetModules();
    }
  });

  it("reports zero and still kicks when nothing is queued", async () => {
    const kickJobScheduler = vi.fn();
    vi.doMock("@/pipeline/jobScheduler", () => ({ kickJobScheduler }));
    try {
      const { POST } = await import("@/app/api/jobs/resume/route");

      const response = await POST(resumeRequest());

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ resumed: true, queued: 0 });
      expect(kickJobScheduler).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("@/pipeline/jobScheduler");
      vi.resetModules();
    }
  });

  it("rejects a cross-site resume before touching the scheduler", async () => {
    const kickJobScheduler = vi.fn();
    vi.doMock("@/pipeline/jobScheduler", () => ({ kickJobScheduler }));
    try {
      seedQueuedJob(handle.db, "queued-a", "AAPL");
      const { POST } = await import("@/app/api/jobs/resume/route");

      const crossSite = await POST(
        resumeRequest({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }),
      );
      const headerless = await POST(resumeRequest({}));

      expect(crossSite.status).toBe(403);
      expect(headerless.status).toBe(403);
      expect(kickJobScheduler).not.toHaveBeenCalled();
      expect(
        handle.db.select().from(jobs).where(eq(jobs.id, "queued-a")).get()?.status,
      ).toBe("queued");
    } finally {
      vi.doUnmock("@/pipeline/jobScheduler");
      vi.resetModules();
    }
  });
});
