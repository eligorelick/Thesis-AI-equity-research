import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalReportPresentation,
  decodeAcceptedJobId,
  closeMatchingJobStream,
  createJobRequestFence,
  createJobStreamSnapshotFence,
  fetchReportSummaryForSnapshot,
  readFencedJobRequestJson,
  terminalSnapshotFinalized,
  terminalStateFromSnapshot,
} from "@/app/company/[symbol]/GenerateReport";
import type { StepProgress } from "@/types/core";

const COMPLETE_DATA_COMPLETENESS = {
  state: "complete",
  criticalCount: 0,
  warningCount: 0,
  edgar: "available",
  xbrl: "checked",
  forensicValidation: "complete",
} as const;

const ANALYSIS_GAP = {
  field: "analysis.llm",
  reason: "TASK28:summary:data-only",
  severity: "critical",
  attemptedSources: ["anthropic"],
} as const;

function snapshot(over: Record<string, unknown> = {}) {
  return {
    jobId: "job-A",
    symbol: "AAPL",
    revision: 0,
    status: "queued",
    steps: [
      { step: "fetch", status: "pending" },
      { step: "validate", status: "pending" },
      { step: "compute", status: "pending" },
      { step: "bull", status: "pending" },
      { step: "bear", status: "pending" },
      { step: "synthesize", status: "pending" },
      { step: "verify", status: "pending" },
    ] satisfies StepProgress[],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    error: null,
    reportId: null,
    verificationRate: null,
    totalCostUsd: 0,
    dataOnly: false,
    resumable: false,
    settlementsPending: false,
    unsupported: null,
    ...over,
  };
}

function reportSummary(over: Record<string, unknown> = {}) {
  return {
    reportId: 11,
    symbol: "AAPL",
    companyName: "Apple Inc.",
    model: "test-model",
    createdAt: "2026-08-08T00:00:00.000Z",
    costUsd: 1.25,
    verificationRate: 0.8,
    synthesis: "current synthesis",
    grades: [
      { key: "fundamentals", grade: "A", oneLineWhy: "fundamentals sentinel" },
      { key: "valuation", grade: "B", oneLineWhy: "valuation sentinel" },
      { key: "technicals", grade: "C", oneLineWhy: "technicals sentinel" },
      { key: "balanceSheet", grade: "D", oneLineWhy: "balance sentinel" },
      { key: "quality", grade: "F", oneLineWhy: "quality sentinel" },
      { key: "leadership", grade: "A", oneLineWhy: "leadership sentinel" },
      { key: "moat", grade: "B", oneLineWhy: "moat sentinel" },
    ],
    dataOnly: false,
    dataCompleteness: COMPLETE_DATA_COMPLETENESS,
    missingData: [],
    ...over,
  };
}

describe("GenerateReport — revisioned snapshot stream fence", () => {
  it("accepts revision zero and jumps, but rejects duplicate/regressing or malformed revisions", () => {
    const fence = createJobStreamSnapshotFence();
    const source = {};
    fence.activate(source, "job-A", "AAPL");

    expect(fence.accept(source, snapshot({ revision: 0 }))).toMatchObject({ revision: 0 });
    expect(fence.accept(source, snapshot({ revision: 0 }))).toBeNull();
    expect(fence.accept(source, snapshot({ revision: -1 }))).toBeNull();
    expect(fence.accept(source, snapshot({ revision: 0.5 }))).toBeNull();
    expect(fence.accept(source, snapshot({ revision: Number.MAX_SAFE_INTEGER + 1 }))).toBeNull();
    expect(fence.accept(source, snapshot({ revision: 7 }))).toMatchObject({ revision: 7 });
    expect(fence.accept(source, snapshot({ revision: 6 }))).toBeNull();
  });

  it("validates the complete snapshot before advancing, so malformed high revisions cannot poison replay", () => {
    const fence = createJobStreamSnapshotFence();
    const source = {};
    fence.activate(source, "job-A", "AAPL");
    expect(fence.accept(source, snapshot({ revision: 0 }))).not.toBeNull();
    const malformed: Array<[string, Record<string, unknown>]> = [
      ["unknown status", { status: "finished" }],
      ["string cost", { totalCostUsd: "1.00" }],
      ["NaN cost", { totalCostUsd: Number.NaN }],
      ["negative cost", { totalCostUsd: -0.01 }],
      ["invalid report id", { reportId: 0 }],
      ["invalid data-only flag", { dataOnly: "false" }],
      ["invalid resumable flag", { resumable: 1 }],
      ["invalid settlement-pending flag", { settlementsPending: "false" }],
      ["settlement pending on a live job", { status: "running", settlementsPending: true }],
      ["unsupported metadata on running", {
        status: "running",
        unsupported: { kind: "etf", message: "not a company" },
      }],
      ["unsupported report link", {
        status: "unsupported",
        reportId: 9,
        unsupported: { kind: "etf", message: "not a company" },
      }],
      ["bad step collection", { steps: "not-an-array" }],
      ["incomplete steps", { steps: [{ step: "fetch", status: "pending" }] }],
      ["duplicate steps", {
        steps: snapshot().steps.map((step, index) => index === 1 ? { ...step, step: "fetch" } : step),
      }],
      ["bad step status", {
        steps: snapshot().steps.map((step, index) => index === 0 ? { ...step, status: "finished" } : step),
      }],
      ["invalid created timestamp", { createdAt: "not-a-date" }],
      ["missing updated timestamp", { updatedAt: undefined }],
    ];

    for (const [name, value] of malformed) {
      expect(fence.accept(source, snapshot({ revision: 4, ...value })), name).toBeNull();
      expect(fence.accept(source, snapshot({ revision: 4 })), name).toMatchObject({ revision: 4 });
      fence.activate(source, "job-A", "AAPL");
      expect(fence.accept(source, snapshot({ revision: 0 }))).not.toBeNull();
    }
  });

  it("shows a pending canceled terminal but closes only after its finalized revision", () => {
    const fence = createJobStreamSnapshotFence();
    const source = { close: vi.fn() };
    fence.activate(source, "job-A", "AAPL");

    const canceled = fence.accept(source, snapshot({
      status: "canceled",
      error: null,
      settlementsPending: true,
    }));

    expect(canceled).not.toBeNull();
    expect(terminalStateFromSnapshot(canceled!)).toBe("canceled");
    expect(terminalSnapshotFinalized(canceled!)).toBe(false);
    if (terminalSnapshotFinalized(canceled!)) {
      closeMatchingJobStream(fence, source, "job-A");
    }
    expect(source.close).not.toHaveBeenCalled();

    const finalized = fence.accept(source, snapshot({
      revision: 1,
      status: "canceled",
      error: null,
      totalCostUsd: 0.25,
      settlementsPending: false,
    }));
    expect(finalized).not.toBeNull();
    expect(terminalSnapshotFinalized(finalized!)).toBe(true);
    expect(closeMatchingJobStream(fence, source, "job-A")).toBe(true);
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("accepts null-message and defensively parsed terminal rows so the UI cannot reconnect forever", () => {
    const fence = createJobStreamSnapshotFence();
    const source = {};
    fence.activate(source, "job-A", "AAPL");

    expect(fence.accept(source, snapshot({
      revision: 1,
      status: "error",
      error: null,
      steps: [],
    }))).toMatchObject({ status: "error", error: null, steps: [] });

    fence.activate(source, "job-A", "AAPL");
    const unsupported = fence.accept(source, snapshot({
      revision: 2,
      status: "unsupported",
      unsupported: { kind: "unknown", message: 42 },
      steps: [],
    }));
    expect(unsupported).toMatchObject({ status: "unsupported", steps: [] });
    expect(terminalStateFromSnapshot(unsupported!)).toBe("unsupported");

    fence.activate(source, "job-A", "AAPL");
    expect(fence.accept(source, snapshot({
      revision: 3,
      status: "error",
      error: null,
      steps: [{ step: "fetch", status: "skipped" }],
    }))).toMatchObject({ status: "error", steps: [{ step: "fetch", status: "skipped" }] });

    fence.activate(source, "job-A", "AAPL");
    expect(fence.accept(source, snapshot({ revision: 4, status: "running", steps: [] }))).toBeNull();
  });

  it("binds exact source, job, and symbol so an old stream cannot mutate or close a newer job", () => {
    const fence = createJobStreamSnapshotFence();
    const oldSource = {};
    const currentSource = {};
    fence.activate(oldSource, "job-A", "AAPL");
    expect(fence.accept(oldSource, snapshot())).not.toBeNull();

    fence.activate(currentSource, "job-B", "MSFT");
    expect(fence.accept(oldSource, snapshot({ revision: 9, status: "done" }))).toBeNull();
    expect(fence.accept(currentSource, snapshot({ jobId: "job-A", symbol: "MSFT" }))).toBeNull();
    expect(fence.accept(currentSource, snapshot({ jobId: "job-B", symbol: "AAPL" }))).toBeNull();
    expect(fence.isCurrent(oldSource, "job-A")).toBe(false);
    expect(fence.isCurrent(currentSource, "job-B")).toBe(true);
    expect(fence.accept(currentSource, snapshot({
      jobId: "job-B",
      symbol: "MSFT",
      revision: 3,
      status: "done",
    }))).toMatchObject({ status: "done", revision: 3 });
  });

  it("invalidates delayed POST adoption tokens when a newer start or retry begins", () => {
    const fence = createJobRequestFence();
    const first = fence.begin("AAPL");
    const second = fence.begin("AAPL");

    expect(fence.accepts(first)).toBe(false);
    expect(fence.accepts(second)).toBe(true);
    fence.invalidate();
    expect(fence.accepts(second)).toBe(false);
  });

  it("rechecks a request token after asynchronous response JSON parsing", async () => {
    let resolveBody!: (value: unknown) => void;
    const body = new Promise<unknown>((resolve) => { resolveBody = resolve; });
    const fence = createJobRequestFence();
    const tokenA = fence.begin("AAPL");
    const pending = readFencedJobRequestJson({ json: () => body }, tokenA, fence);

    fence.begin("MSFT");
    resolveBody({ error: "stale A failure" });

    expect(await pending).toEqual({ accepted: false });
  });

  it("rejects a malformed accepted job id instead of leaving the UI starting forever", () => {
    expect(decodeAcceptedJobId(null)).toBeNull();
    expect(decodeAcceptedJobId({})).toBeNull();
    expect(decodeAcceptedJobId({ jobId: "" })).toBeNull();
    expect(decodeAcceptedJobId({ jobId: 42 })).toBeNull();
    expect(decodeAcceptedJobId({ jobId: "job-A" })).toBe("job-A");
  });

  it("keeps canonical snapshot cost while a valid persisted summary owns data-only truth", () => {
    expect(canonicalReportPresentation(
      { totalCostUsd: 1.25, dataOnly: true },
      { costUsd: 0.4, dataOnly: false },
    )).toEqual({ costUsd: 1.25, dataOnly: false });
    expect(canonicalReportPresentation(
      { totalCostUsd: 1.25, dataOnly: false },
      { costUsd: 0.4, dataOnly: null },
    )).toEqual({ costUsd: 1.25, dataOnly: null });
    expect(canonicalReportPresentation(
      { totalCostUsd: 1.25, dataOnly: true },
      null,
    )).toEqual({ costUsd: 1.25, dataOnly: true });
  });

  it("drops a delayed job-A summary after job B becomes the current stream", async () => {
    let resolveOld!: (value: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/11")) return oldResponse;
      return new Response(JSON.stringify(reportSummary({
        reportId: 22,
        symbol: "MSFT",
        synthesis: "job B",
      })), { status: 200 });
    });
    const fence = createJobStreamSnapshotFence();
    const sourceA = {};
    const sourceB = {};
    fence.activate(sourceA, "job-A", "AAPL");
    fence.accept(sourceA, snapshot({ revision: 1, status: "done", reportId: 11 }));
    const tokenA = fence.token(sourceA, "job-A");
    const installed: unknown[] = [];
    const oldLoad = fetchReportSummaryForSnapshot(11, tokenA!, fence, (value) => installed.push(value), fetcher);

    fence.activate(sourceB, "job-B", "MSFT");
    fence.accept(sourceB, snapshot({
      jobId: "job-B",
      symbol: "MSFT",
      revision: 2,
      status: "done",
      reportId: 22,
    }));
    const tokenB = fence.token(sourceB, "job-B");
    await fetchReportSummaryForSnapshot(22, tokenB!, fence, (value) => installed.push(value), fetcher);
    resolveOld(new Response(JSON.stringify(reportSummary({
      reportId: 11,
      synthesis: "stale job A",
    })), { status: 200 }));
    await oldLoad;

    expect(installed).toEqual([expect.objectContaining({ reportId: 22, synthesis: "job B" })]);
  });

  it("installs only a complete summary matching the terminal report and symbol", async () => {
    const fence = createJobStreamSnapshotFence();
    const source = {};
    fence.activate(source, "job-A", "AAPL");
    fence.accept(source, snapshot({ revision: 1, status: "done", reportId: 11 }));
    const token = fence.token(source, "job-A")!;
    const installed: unknown[] = [];
    const cases = [
      reportSummary({ reportId: 12 }),
      reportSummary({ symbol: "MSFT" }),
      reportSummary({ grades: null }),
      reportSummary({ createdAt: "not-a-date" }),
      reportSummary({ verificationRate: Number.NaN }),
      reportSummary({ costUsd: -1 }),
      reportSummary({ dataOnly: "false" }),
      reportSummary({ synthesis: 42 }),
      reportSummary({ missingData: null }),
      reportSummary({ missingData: [{ field: null, reason: "reason", severity: "info" }] }),
      reportSummary({ missingData: [{ field: "field", reason: null, severity: "info" }] }),
      reportSummary({ missingData: [{ field: "field", reason: "reason", severity: "warning" }] }),
      reportSummary({ missingData: [{
        field: "field",
        reason: "reason",
        severity: "warn",
        attemptedSources: ["source", 28],
      }] }),
      reportSummary({ missingData: [{
        field: "field",
        reason: "reason",
        severity: "warn",
        expected: null,
      }] }),
      reportSummary({ missingData: [{
        field: "field",
        reason: "reason",
        severity: "warn",
        extra: "not permitted",
      }] }),
      reportSummary({ dataCompleteness: {} }),
      ...Object.entries({
        state: "finished",
        criticalCount: -1,
        warningCount: 0.5,
        edgar: "unknown",
        xbrl: "unchecked",
        forensicValidation: "unknown",
      }).map(([field, invalid]) => reportSummary({
        dataCompleteness: { ...COMPLETE_DATA_COMPLETENESS, [field]: invalid },
      })),
      reportSummary({
        dataCompleteness: { ...COMPLETE_DATA_COMPLETENESS, extra: "not permitted" },
      }),
      reportSummary({
        dataCompleteness: { ...COMPLETE_DATA_COMPLETENESS, criticalCount: Number.NaN },
      }),
      reportSummary({
        dataCompleteness: { ...COMPLETE_DATA_COMPLETENESS, warningCount: Number.POSITIVE_INFINITY },
      }),
      reportSummary({
        dataCompleteness: {
          ...COMPLETE_DATA_COMPLETENESS,
          criticalCount: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
      reportSummary({ dataOnly: false, missingData: [ANALYSIS_GAP] }),
      reportSummary({ dataOnly: true, grades: [], missingData: [] }),
      reportSummary({ dataOnly: true, missingData: [] }),
      reportSummary({
        dataOnly: true,
        grades: [],
        dataCompleteness: {
          state: "blocked",
          criticalCount: 1,
          warningCount: 0,
          edgar: "available",
          xbrl: "checked",
          forensicValidation: "complete",
        },
        missingData: [ANALYSIS_GAP],
      }),
      reportSummary({ dataOnly: null, dataCompleteness: null, missingData: null }),
      reportSummary({
        dataOnly: null,
        grades: [],
        dataCompleteness: null,
        missingData: [],
      }),
      reportSummary({
        dataOnly: null,
        grades: [],
        dataCompleteness: COMPLETE_DATA_COMPLETENESS,
        missingData: null,
      }),
    ];
    for (const value of cases) {
      await fetchReportSummaryForSnapshot(
        11,
        token,
        fence,
        (summary) => installed.push(summary),
        async () => ({ ok: true, json: async () => value }),
      );
    }
    expect(installed).toEqual([]);

    await fetchReportSummaryForSnapshot(
      11,
      token,
      fence,
      (summary) => installed.push(summary),
      async () => new Response(JSON.stringify(reportSummary()), { status: 200 }),
    );
    expect(installed).toEqual([expect.objectContaining({ reportId: 11, symbol: "AAPL" })]);
  });

  it("accepts exactly the canonical required grade sequence plus optional balance and rejects malformed sequences", async () => {
    const fence = createJobStreamSnapshotFence();
    const source = {};
    fence.activate(source, "job-A", "AAPL");
    fence.accept(source, snapshot({ revision: 1, status: "done", reportId: 11 }));
    const token = fence.token(source, "job-A")!;
    const canonical = reportSummary().grades as Array<Record<string, unknown>>;
    const withoutBalance = canonical.filter((grade) => grade.key !== "balanceSheet");
    const malformed = [
      [...canonical, { key: "mystery", grade: "A", oneLineWhy: "unknown" }],
      [...canonical, canonical[0]],
      [canonical[1], canonical[0], ...canonical.slice(2)],
      canonical.filter((grade) => grade.key !== "quality"),
      [canonical[0], canonical[1], canonical[2], ...canonical.slice(4), canonical[3]],
      [],
    ];
    const installed: unknown[] = [];
    for (const grades of malformed) {
      await fetchReportSummaryForSnapshot(
        11,
        token,
        fence,
        (summary) => installed.push(summary),
        async () => new Response(JSON.stringify(reportSummary({ grades })), { status: 200 }),
      );
    }
    expect(installed).toEqual([]);

    for (const value of [
      reportSummary({ grades: canonical }),
      reportSummary({ grades: withoutBalance }),
      reportSummary({
        grades: withoutBalance.map((grade) => ({ ...grade, grade: "F" })),
        dataOnly: true,
        dataCompleteness: {
          state: "blocked",
          criticalCount: 1,
          warningCount: 1,
          edgar: "available",
          xbrl: "checked",
          forensicValidation: "complete",
        },
        missingData: [
          ANALYSIS_GAP,
          {
            field: "llm.bull",
            reason: "TASK28:summary:additional-info",
            severity: "info",
            attemptedSources: ["anthropic"],
            expected: false,
          },
          {
            field: "shares.float",
            reason: "TASK28:summary:additional-warning",
            severity: "warn",
            attemptedSources: ["fmp", "sec"],
          },
          {
            field: "projections.eps.shareCountTrend",
            reason: "TASK28:summary:expected",
            severity: "warn",
            expected: true,
          },
        ],
      }),
      reportSummary({
        grades: [],
        dataOnly: null,
        dataCompleteness: null,
        missingData: null,
      }),
      reportSummary({
        dataCompleteness: null,
        missingData: [{
          field: "shares.float",
          reason: "TASK28:summary:legacy-gap",
          severity: "info",
          expected: false,
        }],
      }),
      reportSummary({
        dataCompleteness: { ...COMPLETE_DATA_COMPLETENESS, warningCount: 99 },
        missingData: [],
      }),
    ]) {
      await fetchReportSummaryForSnapshot(
        11,
        token,
        fence,
        (summary) => installed.push(summary),
        async () => new Response(JSON.stringify(value), { status: 200 }),
      );
    }
    expect(installed).toHaveLength(6);
    expect(installed).toEqual([
      expect.objectContaining({ grades: canonical }),
      expect.objectContaining({ grades: withoutBalance }),
      expect.objectContaining({
        dataOnly: true,
        grades: expect.arrayContaining([expect.objectContaining({ grade: "F" })]),
      }),
      expect.objectContaining({ grades: [], dataOnly: null }),
      expect.objectContaining({ dataCompleteness: null }),
      expect.objectContaining({ dataCompleteness: expect.objectContaining({ warningCount: 99 }) }),
    ]);
  });

  it("closes only the matching source and derives every terminal phase from snapshots", () => {
    const fence = createJobStreamSnapshotFence();
    const oldSource = { close: vi.fn() };
    const currentSource = { close: vi.fn() };
    fence.activate(oldSource, "job-A", "AAPL");
    fence.activate(currentSource, "job-B", "MSFT");

    expect(closeMatchingJobStream(fence, oldSource, "job-A")).toBe(false);
    expect(oldSource.close).not.toHaveBeenCalled();
    expect(closeMatchingJobStream(fence, currentSource, "job-B")).toBe(true);
    expect(currentSource.close).toHaveBeenCalledTimes(1);

    expect(terminalStateFromSnapshot(snapshot({ status: "done" }))).toBe("done");
    expect(terminalStateFromSnapshot(snapshot({ status: "error" }))).toBe("error");
    expect(terminalStateFromSnapshot(snapshot({ status: "unsupported" }))).toBe("unsupported");
    expect(terminalStateFromSnapshot(snapshot({ status: "canceled" }))).toBe("canceled");
    expect(terminalStateFromSnapshot(snapshot({ status: "running" }))).toBeNull();
  });

  it("wires the real component to snapshot fencing only and leaves transport errors reconnectable", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "app", "company", "[symbol]", "GenerateReport.tsx"),
      "utf8",
    );
    expect(source).toContain("streamFenceRef.current.accept(es");
    expect(source).toContain("terminalStateFromSnapshot");
    expect(source).toContain("terminalSnapshotFinalized(snap)");
    expect(source).not.toContain('addEventListener("done"');
    expect(source).not.toContain('addEventListener("step-update"');
    expect(source).not.toContain('addEventListener("cost-update"');
    expect(source).toMatch(/es\.addEventListener\("error"[\s\S]*auto-reconnects/);
    expect(source).toContain("canonicalReportPresentation(");
    expect(source).toMatch(/const \{ costUsd: cost, dataOnly: isDataOnly \} = canonicalReportPresentation/);
    expect(source).toContain("const cancelToken = requestFenceRef.current.begin");
    expect(source).toContain("requestFenceRef.current.accepts(cancelToken)");
    expect(source).toMatch(/terminal !== null[\s\S]*requestFenceRef\.current\.invalidate\(\)/);
    expect(source).toContain("readFencedJobRequestJson(");
    expect(source).toContain('setError("report request returned an invalid job id")');
    expect(source).toMatch(/useEffect\(\(\) => \(\) => \{[\s\S]*?\}, \[closeCurrentStream, symbol\]\)/);
    const page = readFileSync(
      join(process.cwd(), "src", "app", "company", "[symbol]", "page.tsx"),
      "utf8",
    );
    expect(page).toContain('<GenerateReport key={bundle.symbol} symbol={bundle.symbol} />');
  });
});
