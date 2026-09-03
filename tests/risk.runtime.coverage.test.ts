import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";

vi.mock("server-only", () => ({}));

const stageCMock = vi.hoisted(() => ({
  pipelinePasses: undefined as unknown,
  passes: undefined as unknown,
  default: undefined as unknown,
}));
vi.mock("@/pipeline/stageC", () => stageCMock);

import { reportSection } from "@/report/sectionManifest";
import { REPORT_SPEC_VERSION } from "@/report/schema";
import {
  createSettingsPageController,
  settingsModelOptionsForDisplay,
} from "@/settings/writeQueue";
import {
  ANALYSIS_MODEL_OPTIONS,
  EFFORT_LEVELS,
} from "@/settings/contracts";
import {
  closeDb,
  createDatabase,
  getDb,
  getRawSqlite,
  setDbForTests,
} from "@/db";
import {
  apiCache,
  costLog,
  jobLlmLeases,
  jobPassArtifacts,
  jobs,
  reports,
} from "@/db/schema";
import type { FmpClient } from "@/providers/fmp";
import {
  addToWatchlist,
  getWatchlistView,
} from "@/watchlist/watchlist";

const DYNAMIC_MOCKS = [
  "@/app/api/sameOrigin",
  "@/app/api/report/resolvePasses",
  "@/db",
  "@/pipeline/events",
  "@/pipeline/jobRunner",
  "@/pipeline/jobScheduler",
  "@/pipeline/jobStore",
] as const;

function resetDynamicMocks(): void {
  for (const id of DYNAMIC_MOCKS) vi.doUnmock(id);
  vi.resetModules();
}

afterEach(() => {
  setDbForTests(null);
  closeDb();
  resetDynamicMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("risk runtime behavior coverage", () => {
  it("resolves every supported Stage C export shape and exposes honest noop passes", async () => {
    const candidate = { kind: "pipeline-passes" };
    const resolver = await import("@/app/api/report/resolvePasses");

    stageCMock.pipelinePasses = candidate;
    await expect(resolver.resolvePasses()).resolves.toBe(candidate);
    stageCMock.pipelinePasses = undefined;
    stageCMock.passes = candidate;
    await expect(resolver.resolvePasses()).resolves.toBe(candidate);
    stageCMock.passes = undefined;
    stageCMock.default = candidate;
    await expect(resolver.resolvePasses()).resolves.toBe(candidate);
    stageCMock.default = "invalid";
    await expect(resolver.resolvePasses()).resolves.toBeNull();
    stageCMock.default = undefined;
    Object.defineProperty(stageCMock, "pipelinePasses", {
      configurable: true,
      get: () => {
        throw new Error("malformed module namespace");
      },
    });
    await expect(resolver.resolvePasses()).resolves.toBeNull();
    Object.defineProperty(stageCMock, "pipelinePasses", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const noop = resolver.noopPasses();
    expect(
      (noop.assembleContextPayload as (...args: unknown[]) => unknown)(),
    ).toEqual({});
    await expect(
      (noop.runBullThenBear as (...args: unknown[]) => Promise<unknown>)(),
    ).rejects.toThrow(/Stage C passes module not wired/);
    await expect(
      (noop.runJudgePass as (...args: unknown[]) => Promise<unknown>)(),
    ).rejects.toThrow(/Stage C passes module not wired/);
    await expect(
      (noop.runVerifyPass as (...args: unknown[]) => Promise<unknown>)(),
    ).rejects.toThrow(/Stage C passes module not wired/);
    expect(() =>
      (noop.assembleReport as (...args: unknown[]) => unknown)(),
    ).toThrow(/Stage C passes module not wired/);
  });

  it("executes the deferred pass resolver for successful cancel and retry routes", async () => {
    const candidate = { kind: "runnable" };
    const fallback = { kind: "fallback" };
    const resolved: Array<Promise<unknown>> = [];
    const kickJobScheduler = vi.fn((resolver: () => Promise<unknown>) => {
      resolved.push(resolver());
    });
    const row = { id: "job-1", symbol: "AAPL", status: "queued" };
    const get = vi.fn(() => row);

    vi.doMock("@/app/api/sameOrigin", () => ({ assertSameOrigin: () => null }));
    vi.doMock("@/db", () => ({
      getDb: () => ({
        select: () => ({
          from: () => ({ where: () => ({ get }) }),
        }),
      }),
    }));
    vi.doMock("@/pipeline/jobRunner", () => ({ cancelJob: () => true }));
    vi.doMock("@/pipeline/jobScheduler", () => ({ kickJobScheduler }));
    vi.doMock("@/app/api/report/resolvePasses", () => ({
      resolvePasses: async () => candidate,
      noopPasses: () => fallback,
    }));

    const cancelRoute = await import("@/app/api/report/[jobId]/cancel/route");
    const cancelResponse = await cancelRoute.POST(
      new Request("http://localhost/api/report/job-1/cancel", { method: "POST" }),
      { params: Promise.resolve({ jobId: "job-1" }) },
    );
    expect(cancelResponse.status).toBe(202);
    await expect(resolved.shift()).resolves.toBe(candidate);

    resetDynamicMocks();
    row.status = "done";
    vi.doMock("@/app/api/sameOrigin", () => ({ assertSameOrigin: () => null }));
    vi.doMock("@/db", () => ({
      getDb: () => ({
        select: () => ({
          from: () => ({ where: () => ({ get }) }),
        }),
      }),
    }));
    vi.doMock("@/pipeline/jobRunner", () => ({
      claimPreparedJobResume: () => true,
      isSymbolJobActive: () => false,
      prepareJobResume: () => ({ jobId: "job-1" }),
    }));
    vi.doMock("@/pipeline/jobScheduler", () => ({
      kickJobScheduler,
      reconcileExpiredJobClaims: () => 0,
    }));
    vi.doMock("@/pipeline/jobStore", () => ({ readJobResumeState: () => null }));
    vi.doMock("@/app/api/report/resolvePasses", () => ({
      resolvePasses: async () => null,
      noopPasses: () => fallback,
    }));

    const retryRoute = await import("@/app/api/report/[jobId]/retry/route");
    const retryResponse = await retryRoute.POST(
      new Request("http://localhost/api/report/job-1/retry", { method: "POST" }),
      { params: Promise.resolve({ jobId: "job-1" }) },
    );
    expect(retryResponse.status).toBe(202);
    await expect(resolved.shift()).resolves.toBe(fallback);
  });

  it("closes an already-aborted SSE request without subscribing or reading state", async () => {
    const getJobSnapshot = vi.fn();
    const subscribeJob = vi.fn();
    vi.doMock("@/pipeline/events", () => ({
      getJobSnapshot,
      jobExists: () => true,
      subscribeJob,
    }));
    const { GET } = await import("@/app/api/report/[jobId]/stream/route");
    const controller = new AbortController();
    controller.abort();
    const response = await GET(
      new Request("http://localhost/api/report/job-1/stream", {
        signal: controller.signal,
      }),
      { params: Promise.resolve({ jobId: "job-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    await expect(response.text()).resolves.toBe("");
    expect(getJobSnapshot).not.toHaveBeenCalled();
    expect(subscribeJob).not.toHaveBeenCalled();
  });

  it("closes an SSE request that aborts during the subscribe handshake", async () => {
    const getJobSnapshot = vi.fn();
    const subscribeJob = vi.fn();
    vi.doMock("@/pipeline/events", () => ({
      getJobSnapshot,
      jobExists: () => true,
      subscribeJob,
    }));
    const { GET } = await import("@/app/api/report/[jobId]/stream/route");
    let abortedReads = 0;
    const removeEventListener = vi.fn();
    const request = {
      signal: {
        get aborted() {
          abortedReads += 1;
          return abortedReads > 1;
        },
        addEventListener: vi.fn(),
        removeEventListener,
      },
    } as unknown as Request;

    const response = await GET(request, {
      params: Promise.resolve({ jobId: "job-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
    expect(abortedReads).toBeGreaterThanOrEqual(2);
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(getJobSnapshot).not.toHaveBeenCalled();
    expect(subscribeJob).not.toHaveBeenCalled();
  });

  it("closes an SSE stream when the durable snapshot disappears after admission", async () => {
    const unsubscribe = vi.fn();
    const getJobSnapshot = vi.fn(() => null);
    const subscribeJob = vi.fn(() => unsubscribe);
    vi.doMock("@/pipeline/events", () => ({
      getJobSnapshot,
      jobExists: () => true,
      subscribeJob,
    }));
    const { GET } = await import("@/app/api/report/[jobId]/stream/route");

    const response = await GET(
      new Request("http://localhost/api/report/job-1/stream"),
      { params: Promise.resolve({ jobId: "job-1" }) },
    );

    await expect(response.text()).resolves.toBe(": stream open\n\n");
    expect(getJobSnapshot).toHaveBeenCalledWith("job-1");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("bootstraps the durable scheduler with real and fallback deferred passes", async () => {
    const candidate = { kind: "candidate" };
    const fallback = { kind: "fallback" };
    const resolvePasses = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(candidate);
    const kickJobScheduler = vi.fn();
    vi.doMock("@/pipeline/jobScheduler", () => ({ kickJobScheduler }));
    vi.doMock("@/app/api/report/resolvePasses", () => ({
      resolvePasses,
      noopPasses: () => fallback,
    }));

    const { bootstrapReportScheduler } = await import(
      "@/pipeline/jobSchedulerBootstrap"
    );
    await bootstrapReportScheduler();

    expect(kickJobScheduler).toHaveBeenCalledTimes(1);
    const [passResolver, options] = kickJobScheduler.mock.calls[0]!;
    expect(options).toEqual({});
    await expect(passResolver()).resolves.toBe(fallback);
    await expect(passResolver()).resolves.toBe(candidate);
  });

  it("looks up every declared report section and rejects unknown keys", () => {
    expect(reportSection("verdict")).toMatchObject({
      index: 1,
      label: "Verdict",
    });
    expect(() => reportSection("missing" as "verdict")).toThrow(
      /Unknown report section: missing/,
    );
  });

  it("returns advertised settings models without inventing a carry-only row", () => {
    expect(
      settingsModelOptionsForDisplay("auto", ["auto", "claude-opus-4-8"]),
    ).toEqual([
      { value: "auto", carryOnly: false, unsupported: false },
      { value: "claude-opus-4-8", carryOnly: false, unsupported: false },
    ]);
  });

  it("rejects an unsupported settings intent before issuing a write", async () => {
    const states: Array<{ error: string | null }> = [];
    const payload = {
      analysisModel: "auto",
      analysisModelOptions: [...ANALYSIS_MODEL_OPTIONS],
      analysisEffort: "medium",
      analysisEffortOptions: [...EFFORT_LEVELS],
      sources: {
        analysisModel: "default",
        analysisEffort: "default",
      },
      revision: 0,
      capabilities: {
        hasFmpKey: false,
        hasFinnhubKey: false,
        hasFredKey: false,
        hasAnthropicKey: false,
        fixtureMode: true,
        resumeOnStart: true,
      },
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: '"settings-0"',
      },
    }));
    const controller = createSettingsPageController({
      fetcher,
      onState: (state) => states.push({ error: state.error }),
    });

    await controller.start();
    controller.setDesired({
      analysisModel: "unsupported-model",
      analysisEffort: "medium",
    } as never);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.error).toMatch(/supported analysis model/i);
    controller.dispose();
  });

  it("materializes every foreign-key schema callback and audited index family", () => {
    const jobConfig = getTableConfig(jobs);
    const artifactConfig = getTableConfig(jobPassArtifacts);
    const leaseConfig = getTableConfig(jobLlmLeases);

    expect(jobConfig.foreignKeys).toHaveLength(1);
    expect(artifactConfig.foreignKeys).toHaveLength(1);
    expect(leaseConfig.foreignKeys).toHaveLength(1);
    expect(jobConfig.foreignKeys[0]!.getName()).toMatch(/jobs_reportId_reports_id/);
    expect(artifactConfig.foreignKeys[0]!.getName()).toMatch(
      /job_pass_artifacts_jobId_jobs_id/,
    );
    expect(leaseConfig.foreignKeys[0]!.getName()).toMatch(
      /job_llm_leases_jobId_jobs_id/,
    );
    expect(getTableConfig(reports).indexes.map((index) => index.config.name)).toContain(
      "idx_reports_symbol_createdAt",
    );
    expect(getTableConfig(apiCache).indexes).toHaveLength(2);
    // jobId, createdAt, the billed-attempt unique index, and the presumed-attempt unique index (D-07).
    expect(getTableConfig(costLog).indexes).toHaveLength(4);
  });

  it("uses test and on-disk singleton database authority without leaking handles", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "thesis-risk-db-"));
    const singletonFile = path.join(tempRoot, "singleton", "thesis.db");
    const memory = createDatabase(":memory:");
    try {
      setDbForTests(memory.db);
      expect(getDb()).toBe(memory.db);
      expect(() => getRawSqlite()).toThrow(/test database override/i);

      setDbForTests(null);
      memory.sqlite.close();
      vi.stubEnv("THESIS_DB_PATH", singletonFile);
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = getDb();
      expect(getDb()).toBe(first);
      const raw = getRawSqlite();
      expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(existsSync(singletonFile)).toBe(true);
      closeDb();
      expect(raw.open).toBe(false);
      closeDb();
    } finally {
      setDbForTests(null);
      if (memory.sqlite.open) memory.sqlite.close();
      closeDb();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("imports a legacy project database only under the explicit one-time flag", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "thesis-risk-legacy-"));
    const projectDir = path.join(tempRoot, "project");
    const dataDir = path.join(tempRoot, "app-data");
    const legacyFile = path.join(projectDir, "data", "thesis.db");
    const importedFile = path.join(dataDir, "thesis.db");
    mkdirSync(path.dirname(legacyFile), { recursive: true });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    vi.stubEnv("THESIS_DB_PATH", "");
    vi.stubEnv("THESIS_DATA_DIR", dataDir);
    vi.stubEnv("THESIS_IMPORT_LEGACY_DB", "1");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const legacy = createDatabase(legacyFile);
      legacy.sqlite
        .prepare('INSERT INTO "settings" ("key", "value") VALUES (?, ?)')
        .run("legacy.marker", "present");
      legacy.sqlite.close();

      const imported = createDatabase();
      expect(imported.sqlite
        .prepare('SELECT "value" FROM "settings" WHERE "key" = ?')
        .get("legacy.marker")).toEqual({ value: "present" });
      imported.sqlite.close();
      expect(existsSync(importedFile)).toBe(true);

      const reopened = createDatabase();
      expect(reopened.sqlite
        .prepare('SELECT "value" FROM "settings" WHERE "key" = ?')
        .get("legacy.marker")).toEqual({ value: "present" });
      reopened.sqlite.close();
    } finally {
      cwd.mockRestore();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("degrades malformed watchlist enrichments without losing the stored row", async () => {
    const handle = createDatabase(":memory:");
    setDbForTests(handle.db);
    try {
      addToWatchlist("aapl");
      handle.db.insert(reports).values({
        symbol: "AAPL",
        createdAt: "2026-08-01T00:00:00.000Z",
        model: "fixture",
        status: "done",
        reportJson: "{not-json",
        verificationRate: 0.5,
        costUsd: 0,
        specVersion: REPORT_SPEC_VERSION,
      }).run();
      const fmp = {
        quote: async () => ({
          ok: true,
          value: {
            data: { rows: [], raw: [] },
            asOf: "2026-08-01",
            source: "fmp",
            endpoint: "quote",
            fetchedAt: "2026-08-01T00:00:00.000Z",
          },
        }),
        earnings: async () => {
          throw "earnings transport offline";
        },
      } as unknown as FmpClient;

      const [row] = await getWatchlistView({
        fmp,
        now: () => new Date("2026-08-01T00:00:00.000Z"),
      });
      expect(row).toMatchObject({
        symbol: "AAPL",
        price: null,
        grades: null,
        lastReportAt: "2026-08-01T00:00:00.000Z",
      });
      expect(row?.gaps).toEqual(expect.arrayContaining([
        "price: quote returned no rows",
        "report: stored JSON unreadable \u2014 grades unavailable",
        "earnings: earnings transport offline",
      ]));
    } finally {
      setDbForTests(null);
      handle.sqlite.close();
    }
  });

  it("falls back to the persisted company name while filtering malformed earnings rows", async () => {
    const handle = createDatabase(":memory:");
    setDbForTests(handle.db);
    try {
      addToWatchlist("demo");
      const reportJson = readFileSync(
        path.join(process.cwd(), "fixtures", "report", "DEMO-sample.json"),
        "utf8",
      );
      handle.db.insert(reports).values({
        symbol: "DEMO",
        createdAt: "2026-08-01T00:00:00.000Z",
        model: "fixture",
        status: "done",
        reportJson,
        verificationRate: 0.9,
        costUsd: 0,
        specVersion: REPORT_SPEC_VERSION,
      }).run();
      const fmp = {
        quote: async () => ({
          ok: true,
          value: {
            data: {
              rows: [{ price: "unknown", changePercentage: 1.5, name: "" }],
              raw: [],
            },
            asOf: "2026-08-01",
            source: "fmp",
            endpoint: "quote",
            fetchedAt: "2026-08-01T00:00:00.000Z",
          },
        }),
        earnings: async () => ({
          ok: true,
          value: {
            data: {
              rows: [
                { date: 42 },
                { date: "2026-08" },
                { date: "2026-07-01" },
                { date: "2026-09-15" },
                { date: "2026-08-20" },
              ],
              raw: [],
            },
            asOf: "2026-08-01",
            source: "fmp",
            endpoint: "earnings",
            fetchedAt: "2026-08-01T00:00:00.000Z",
          },
        }),
      } as unknown as FmpClient;

      const [row] = await getWatchlistView({
        fmp,
        now: () => new Date("2026-08-01T00:00:00.000Z"),
      });
      expect(row?.companyName).toBe("Thesis Example Systems");
      expect(row?.price).toBeNull();
      expect(row?.changePct).toBe(1.5);
      expect(row?.nextEarnings).toBe("2026-08-20");
      expect(row?.gaps).toContain("price: quote row has no price");
    } finally {
      setDbForTests(null);
      handle.sqlite.close();
    }
  });
});
