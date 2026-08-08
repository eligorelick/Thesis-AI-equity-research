"use client";

/**
 * GenerateReport — the "generate report" client interaction for /company/[symbol].
 *
 * Flow:
 *   1. POST /api/report {symbol} → 202 { jobId } (or 409 if one is already
 *      running — we adopt that path via the returned message and just open the
 *      stream by re-POSTing is avoided; a 409 surfaces as a notice).
 *   2. Open GET /api/report/[jobId]/stream (SSE). Render the 7 PIPELINE_STEPS as
 *      a live stepper: per-step status, timing, and running cost.
 *   3. On an accepted terminal snapshot, GET /api/report/view/[reportId] and render
 *      a compact "report ready" panel: verdict synthesis + grade strip +
 *      verification rate + cost. (Full report rendering is the next UI wave.)
 *
 * Keeps the dense terminal theme (mono, tight borders, uppercase micro-labels).
 * The parent page stays a server component and passes `symbol` in.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Panel } from "@/components/ui";
import { ExportButtons } from "@/components/report/ExportButtons";
import { PIPELINE_STEPS, type StepProgress, type PipelineStep, type Grade } from "@/types/core";

/* ------------------------------------------------------------------------ *
 * Event + summary shapes (mirror the server contracts)
 * ------------------------------------------------------------------------ */

interface SnapshotEvent {
  jobId: string;
  revision: number;
  symbol: string;
  status: string;
  steps: StepProgress[];
  createdAt: string;
  updatedAt: string;
  error: string | null;
  reportId: number | null;
  verificationRate: number | null;
  totalCostUsd: number;
  dataOnly: boolean;
  resumable: boolean;
  settlementsPending: boolean;
  unsupported: { kind: "etf" | "fund" | "etf-fund"; message: string } | null;
}

interface GradeStripCell {
  key: string;
  grade: string;
  oneLineWhy: string;
}
interface ReportSummary {
  reportId: number;
  symbol: string;
  companyName: string;
  model: string;
  createdAt: string;
  costUsd: number | null;
  verificationRate: number | null;
  synthesis: string;
  grades: GradeStripCell[];
  dataOnly: boolean;
}

type Phase = "idle" | "starting" | "running" | "done" | "error" | "unsupported";

type TerminalSnapshotState = "done" | "error" | "unsupported" | "canceled";

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function validStep(value: unknown): value is StepProgress {
  if (value === null || typeof value !== "object") return false;
  const step = value as Partial<StepProgress>;
  if (!PIPELINE_STEPS.includes(step.step as PipelineStep)) return false;
  if (!(["pending", "running", "done", "error", "skipped"] as const)
    .includes(step.status as StepProgress["status"])) return false;
  for (const time of [step.startedAt, step.finishedAt, step.completedAt]) {
    if (time !== undefined && (typeof time !== "string" || !Number.isFinite(Date.parse(time)))) {
      return false;
    }
  }
  if (step.detail !== undefined && typeof step.detail !== "string") return false;
  if (step.costUsd !== undefined && !finiteNonnegative(step.costUsd)) return false;
  return true;
}

function decodeSnapshot(value: unknown): SnapshotEvent | null {
  if (value === null || typeof value !== "object") return null;
  const snapshot = value as Partial<SnapshotEvent>;
  if (typeof snapshot.jobId !== "string" || snapshot.jobId.length === 0) return null;
  if (typeof snapshot.symbol !== "string" || snapshot.symbol.length === 0) return null;
  if (!Number.isSafeInteger(snapshot.revision) || (snapshot.revision ?? -1) < 0) return null;
  if (!(["queued", "running", "done", "error", "unsupported", "canceled"] as const)
    .includes(snapshot.status as never)) return null;
  const terminal = snapshot.status === "done" || snapshot.status === "error" ||
    snapshot.status === "unsupported" || snapshot.status === "canceled";
  if (!Array.isArray(snapshot.steps) || !snapshot.steps.every(validStep)) return null;
  if (snapshot.steps.length === 0) {
    // The server deliberately parses corrupt legacy terminal stepsJson as an
    // empty list. Accepting that terminal row lets the UI stop reconnecting;
    // an empty live row is not safe to render as current progress.
    if (!terminal) return null;
  } else {
    const positions = snapshot.steps.map((step) => PIPELINE_STEPS.indexOf(step.step));
    const uniqueCanonicalOrder = new Set(positions).size === positions.length &&
      positions.every((position, index) => index === 0 || position > positions[index - 1]!);
    if (terminal) {
      if (!uniqueCanonicalOrder) return null;
    } else if (
      snapshot.steps.length !== PIPELINE_STEPS.length ||
      !PIPELINE_STEPS.every((expected, index) => snapshot.steps![index]?.step === expected)
    ) return null;
  }
  if (!validIsoTimestamp(snapshot.createdAt) || !validIsoTimestamp(snapshot.updatedAt)) return null;
  if (snapshot.error !== null && typeof snapshot.error !== "string") return null;
  if (snapshot.reportId !== null && (
    !Number.isSafeInteger(snapshot.reportId) || (snapshot.reportId ?? 0) <= 0
  )) return null;
  if (snapshot.verificationRate !== null && (
    typeof snapshot.verificationRate !== "number" ||
    !Number.isFinite(snapshot.verificationRate) ||
    snapshot.verificationRate < 0 || snapshot.verificationRate > 1
  )) return null;
  if (!finiteNonnegative(snapshot.totalCostUsd)) return null;
  if (
    typeof snapshot.dataOnly !== "boolean" ||
    typeof snapshot.resumable !== "boolean" ||
    typeof snapshot.settlementsPending !== "boolean"
  ) return null;
  if (!terminal && snapshot.settlementsPending) return null;
  if (snapshot.status === "unsupported") {
    // Invalid legacy metadata is rendered with the safe generic unsupported
    // message; the terminal status itself remains authoritative.
    if (snapshot.reportId !== null || snapshot.dataOnly) return null;
  } else if (snapshot.unsupported !== null) {
    return null;
  }
  return snapshot as SnapshotEvent;
}

export interface JobStreamSnapshotToken {
  readonly source: object;
  readonly jobId: string;
  readonly symbol: string;
  readonly revision: number;
  readonly sequence: number;
}

export interface JobStreamSnapshotFence {
  activate(source: object, jobId: string, symbol: string): void;
  accept(source: object, value: unknown): SnapshotEvent | null;
  isCurrent(source: object, jobId: string): boolean;
  token(source: object, jobId: string): JobStreamSnapshotToken | null;
  acceptsToken(token: JobStreamSnapshotToken): boolean;
  invalidate(): void;
}

export function createJobStreamSnapshotFence(): JobStreamSnapshotFence {
  let source: object | null = null;
  let jobId: string | null = null;
  let symbol: string | null = null;
  let revision = -1;
  let sequence = 0;
  const isCurrent = (candidate: object, candidateJobId: string): boolean =>
    candidate === source && candidateJobId === jobId;
  return {
    activate(nextSource, nextJobId, nextSymbol) {
      source = nextSource;
      jobId = nextJobId;
      symbol = nextSymbol;
      revision = -1;
      sequence += 1;
    },
    accept(candidateSource, value) {
      const decoded = decodeSnapshot(value);
      if (
        decoded === null ||
        candidateSource !== source ||
        decoded.jobId !== jobId ||
        decoded.symbol !== symbol ||
        decoded.revision <= revision
      ) return null;
      revision = decoded.revision;
      return decoded;
    },
    isCurrent,
    token(candidateSource, candidateJobId) {
      if (!isCurrent(candidateSource, candidateJobId) || revision < 0 || symbol === null) return null;
      return { source: candidateSource, jobId: candidateJobId, symbol, revision, sequence };
    },
    acceptsToken(token) {
      return token.source === source &&
        token.jobId === jobId &&
        token.symbol === symbol &&
        token.revision === revision &&
        token.sequence === sequence;
    },
    invalidate() {
      source = null;
      jobId = null;
      symbol = null;
      revision = -1;
      sequence += 1;
    },
  };
}

export interface JobRequestToken { symbol: string; sequence: number }
export interface JobRequestFence {
  begin(symbol: string): JobRequestToken;
  accepts(token: JobRequestToken): boolean;
  invalidate(): void;
}

export function createJobRequestFence(): JobRequestFence {
  let sequence = 0;
  let symbol: string | null = null;
  return {
    begin(nextSymbol) {
      symbol = nextSymbol;
      sequence += 1;
      return { symbol: nextSymbol, sequence };
    },
    accepts(token) {
      return token.sequence === sequence && token.symbol === symbol;
    },
    invalidate() {
      symbol = null;
      sequence += 1;
    },
  };
}

export async function readFencedJobRequestJson(
  response: Pick<Response, "json">,
  token: JobRequestToken,
  fence: JobRequestFence,
): Promise<{ accepted: false } | { accepted: true; value: unknown }> {
  let value: unknown = {};
  try {
    value = await response.json();
  } catch {
    // Error responses may legitimately have no JSON body.
  }
  return fence.accepts(token) ? { accepted: true, value } : { accepted: false };
}

export function decodeAcceptedJobId(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const jobId = (value as { jobId?: unknown }).jobId;
  return typeof jobId === "string" && jobId.trim().length > 0 ? jobId : null;
}

export function canonicalReportPresentation(
  snapshot: { totalCostUsd: number; dataOnly: boolean },
  summary: { costUsd: number | null; dataOnly: boolean } | null,
): { costUsd: number; dataOnly: boolean } {
  void summary;
  return { costUsd: snapshot.totalCostUsd, dataOnly: snapshot.dataOnly };
}

export function terminalStateFromSnapshot(
  snapshot: Pick<SnapshotEvent, "status">,
): TerminalSnapshotState | null {
  return snapshot.status === "done" || snapshot.status === "error" ||
      snapshot.status === "unsupported" || snapshot.status === "canceled"
    ? snapshot.status
    : null;
}

export function terminalSnapshotFinalized(
  snapshot: Pick<SnapshotEvent, "status" | "settlementsPending">,
): boolean {
  return terminalStateFromSnapshot(snapshot) !== null && !snapshot.settlementsPending;
}

export function closeMatchingJobStream(
  fence: JobStreamSnapshotFence,
  source: object & { close(): void },
  jobId: string,
): boolean {
  if (!fence.isCurrent(source, jobId)) return false;
  source.close();
  return true;
}

type SummaryFetch = (url: string, init: { cache: "no-store" }) =>
  Promise<Pick<Response, "ok" | "json">>;

function decodeReportSummary(
  value: unknown,
  reportId: number,
  symbol: string,
): ReportSummary | null {
  if (value === null || typeof value !== "object") return null;
  const summary = value as Partial<ReportSummary>;
  if (summary.reportId !== reportId || summary.symbol !== symbol) return null;
  if (
    typeof summary.companyName !== "string" ||
    typeof summary.model !== "string" ||
    !validIsoTimestamp(summary.createdAt) ||
    typeof summary.synthesis !== "string" ||
    typeof summary.dataOnly !== "boolean"
  ) return null;
  if (summary.costUsd !== null && !finiteNonnegative(summary.costUsd)) return null;
  if (summary.verificationRate !== null && (
    typeof summary.verificationRate !== "number" ||
    !Number.isFinite(summary.verificationRate) ||
    summary.verificationRate < 0 || summary.verificationRate > 1
  )) return null;
  if (!Array.isArray(summary.grades) || !summary.grades.every((grade) => (
    grade !== null &&
    typeof grade === "object" &&
    typeof grade.key === "string" &&
    typeof grade.grade === "string" &&
    typeof grade.oneLineWhy === "string"
  ))) return null;
  return summary as ReportSummary;
}

export async function fetchReportSummaryForSnapshot(
  reportId: number,
  token: JobStreamSnapshotToken,
  fence: JobStreamSnapshotFence,
  install: (summary: ReportSummary) => void,
  fetcher: SummaryFetch = fetch,
): Promise<void> {
  try {
    const response = await fetcher(`/api/report/view/${reportId}`, { cache: "no-store" });
    if (!response.ok) return;
    const value = decodeReportSummary(await response.json(), reportId, token.symbol);
    if (value === null || !fence.acceptsToken(token)) return;
    install(value);
  } catch {
    // Summary is optional; the canonical terminal snapshot remains authoritative.
  }
}

export interface ClientUnsupportedTerminal {
  kind: "etf" | "fund" | "etf-fund" | null;
  message: string;
  totalCostUsd: number;
}

const CLIENT_UNSUPPORTED_MESSAGE = "This instrument is not supported for company analysis.";

function decodedUnsupported(
  input: unknown,
  totalCostUsd: unknown,
): ClientUnsupportedTerminal {
  const cost = typeof totalCostUsd === "number" && Number.isFinite(totalCostUsd) ? totalCostUsd : 0;
  if (input !== null && typeof input === "object") {
    const candidate = input as { kind?: unknown; message?: unknown };
    const kind = candidate.kind;
    if (
      (kind === "etf" || kind === "fund" || kind === "etf-fund") &&
      typeof candidate.message === "string" &&
      candidate.message.trim().length > 0
    ) {
      return { kind, message: candidate.message, totalCostUsd: cost };
    }
  }
  return { kind: null, message: CLIENT_UNSUPPORTED_MESSAGE, totalCostUsd: cost };
}

export function unsupportedFromSnapshot(input: {
  status: string;
  totalCostUsd: number;
  unsupported: unknown;
}): ClientUnsupportedTerminal | null {
  if (input.status !== "unsupported") return null;
  return decodedUnsupported(input.unsupported, input.totalCostUsd);
}

export function unsupportedFromEvent(input: unknown): ClientUnsupportedTerminal {
  if (input !== null && typeof input === "object") {
    const candidate = input as { kind?: unknown; message?: unknown; totalCostUsd?: unknown };
    return decodedUnsupported(candidate, candidate.totalCostUsd);
  }
  return decodedUnsupported(null, 0);
}

export function applyUnsupportedTerminal(
  terminal: ClientUnsupportedTerminal,
  actions: {
    setPhase: (phase: "unsupported") => void;
    setMessage: (message: string) => void;
    setTotalCost: (cost: number) => void;
    closeStream: () => void;
  },
): void {
  actions.setPhase("unsupported");
  actions.setMessage(terminal.message);
  actions.setTotalCost(terminal.totalCostUsd);
  actions.closeStream();
}

type TerminalSnapshotFetch = (
  url: string,
  init: { cache: "no-store" },
) => Promise<Pick<Response, "ok" | "json">>;

/** Read the one server-owned retry decision after a terminal stream event. */
export async function fetchTerminalResumable(
  jobId: string,
  fetcher: TerminalSnapshotFetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(`/api/report/${jobId}`, { cache: "no-store" });
    if (!response.ok) return false;
    const value = await response.json() as unknown;
    return value !== null &&
      typeof value === "object" &&
      (value as { resumable?: unknown }).resumable === true;
  } catch {
    return false;
  }
}

interface TerminalResumeRequestToken {
  jobId: string;
  sequence: number;
}

export interface TerminalResumeRequestFence {
  begin: (jobId: string) => TerminalResumeRequestToken;
  accepts: (token: TerminalResumeRequestToken) => boolean;
  invalidate: () => void;
}

/** Fence terminal GET results by both job identity and request order. */
export function createTerminalResumeRequestFence(): TerminalResumeRequestFence {
  let sequence = 0;
  let currentJobId: string | null = null;
  return {
    begin(jobId) {
      currentJobId = jobId;
      sequence += 1;
      return { jobId, sequence };
    },
    accepts(token) {
      return token.sequence === sequence && token.jobId === currentJobId;
    },
    invalidate() {
      currentJobId = null;
      sequence += 1;
    },
  };
}

/** Component-used terminal refresh: stale jobs and stale requests cannot install state. */
export async function refreshTerminalResumableState(
  jobId: string,
  fence: TerminalResumeRequestFence,
  install: (jobId: string, resumable: boolean) => void,
  fetcher: TerminalSnapshotFetch = fetch,
): Promise<void> {
  const token = fence.begin(jobId);
  const resumable = await fetchTerminalResumable(jobId, fetcher);
  if (fence.accepts(token)) install(jobId, resumable);
}

/** UI visibility consumes no step shape; steps remain display metadata only. */
export function shouldShowServerRetry(input: {
  busy: boolean;
  jobId: string | null;
  phase: Phase;
  resumable: boolean;
}): boolean {
  return !input.busy &&
    input.jobId !== null &&
    (input.phase === "done" || input.phase === "error") &&
    input.resumable;
}

/* ------------------------------------------------------------------------ *
 * Small presentational helpers
 * ------------------------------------------------------------------------ */

const STEP_LABEL: Record<PipelineStep, string> = {
  fetch: "fetch",
  validate: "validate",
  compute: "compute",
  bull: "bull",
  bear: "bear",
  synthesize: "synthesize",
  verify: "cite-check",
};

const STATUS_TONE: Record<StepProgress["status"], string> = {
  pending: "text-faint border-edge",
  running: "text-accent border-accent/50",
  done: "text-pos border-pos/40",
  error: "text-neg border-neg/50",
  skipped: "text-warn border-warn/40",
};

const STATUS_GLYPH: Record<StepProgress["status"], string> = {
  pending: "·",
  running: "▸",
  done: "✓",
  error: "✕",
  skipped: "⊘",
};

function durationMs(s: StepProgress): number | null {
  if (!s.startedAt || !s.finishedAt) return null;
  const start = Date.parse(s.startedAt);
  const end = Date.parse(s.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtUsd(v: number | null | undefined): string {
  if (typeof v !== "number") return "—";
  return `$${v.toFixed(4)}`;
}

const GRADE_SET = new Set(["A", "B", "C", "D", "F"]);
function asGrade(g: string): Grade | null {
  return GRADE_SET.has(g) ? (g as Grade) : null;
}

/* ------------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------------ */

export function GenerateReport({ symbol }: { symbol: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [steps, setSteps] = useState<StepProgress[]>(() =>
    PIPELINE_STEPS.map((step) => ({ step, status: "pending" as const })),
  );
  const [totalCost, setTotalCost] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [dataOnly, setDataOnly] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [unsupportedMessage, setUnsupportedMessage] = useState<string | null>(null);
  const [resumable, setResumable] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const streamFenceRef = useRef<JobStreamSnapshotFence>(createJobStreamSnapshotFence());
  const requestFenceRef = useRef<JobRequestFence>(createJobRequestFence());

  const closeCurrentStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    streamFenceRef.current.invalidate();
  }, []);

  useEffect(() => () => {
    requestFenceRef.current.invalidate();
    closeCurrentStream();
  }, [closeCurrentStream, symbol]);

  const openStream = useCallback(
    (jobId: string) => {
      closeCurrentStream();
      const es = new EventSource(`/api/report/${jobId}/stream`);
      esRef.current = es;
      streamFenceRef.current.activate(es, jobId, symbol);

      es.addEventListener("snapshot", (ev) => {
        try {
          const raw = JSON.parse((ev as MessageEvent).data) as unknown;
          const snap = streamFenceRef.current.accept(es, raw);
          if (snap === null) return;
          setSteps(snap.steps);
          setTotalCost(snap.totalCostUsd);
          setDataOnly(snap.dataOnly);
          setResumable(snap.resumable);
          const terminal = terminalStateFromSnapshot(snap);
          if (terminal !== null) requestFenceRef.current.invalidate();
          if (terminal === null) {
            setPhase("running");
            return;
          }
          if (terminal === "unsupported") {
            const unsupported = unsupportedFromSnapshot(snap)!;
            setPhase("unsupported");
            setUnsupportedMessage(unsupported.message);
          } else if (terminal === "done") {
            setPhase("done");
            setError(null);
            if (snap.reportId !== null) {
              const token = streamFenceRef.current.token(es, jobId);
              if (token !== null) {
                void fetchReportSummaryForSnapshot(
                  snap.reportId,
                  token,
                  streamFenceRef.current,
                  setSummary,
                );
              }
            }
          } else {
            setError(snap.error ?? (terminal === "canceled" ? "job canceled" : "job failed"));
            setPhase("error");
          }
          if (
            terminalSnapshotFinalized(snap) &&
            closeMatchingJobStream(streamFenceRef.current, es, jobId) &&
            esRef.current === es
          ) {
            esRef.current = null;
          }
        } catch {
          /* ignore malformed frame */
        }
      });
      es.addEventListener("error", () => {
        // Transport hiccups are nonterminal; EventSource auto-reconnects and
        // the next validated snapshot catches up by canonical revision.
      });
    },
    [closeCurrentStream, symbol],
  );

  const start = useCallback(async () => {
    const requestToken = requestFenceRef.current.begin(symbol);
    closeCurrentStream();
    setPhase("starting");
    setError(null);
    setSummary(null);
    setJobId(null);
    setTotalCost(0);
    setDataOnly(false);
    setUnsupportedMessage(null);
    setResumable(false);
    setSteps(PIPELINE_STEPS.map((step) => ({ step, status: "pending" as const })));

    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      if (!requestFenceRef.current.accepts(requestToken)) return;
      if (res.status === 202) {
        const body = await readFencedJobRequestJson(res, requestToken, requestFenceRef.current);
        if (!body.accepted) return;
        const newJobId = decodeAcceptedJobId(body.value);
        if (newJobId === null) {
          setError("report request returned an invalid job id");
          setPhase("error");
          return;
        }
        setJobId(newJobId);
        openStream(newJobId);
        return;
      }
      const body = await readFencedJobRequestJson(res, requestToken, requestFenceRef.current);
      if (!body.accepted) return;
      const errorBody = body.value as { error?: unknown };
      setError(typeof errorBody.error === "string"
        ? errorBody.error
        : `report request failed (${res.status})`);
      setPhase("error");
    } catch (err) {
      if (!requestFenceRef.current.accepts(requestToken)) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [symbol, openStream, closeCurrentStream]);

  const cancel = useCallback(async () => {
    if (jobId === null || phase !== "running") return;
    const cancelToken = requestFenceRef.current.begin(`${symbol}:${jobId}:cancel`);
    try {
      const res = await fetch(`/api/report/${jobId}/cancel`, { method: "POST" });
      if (!requestFenceRef.current.accepts(cancelToken)) return;
      if (res.status === 202) {
        setError("Cancellation requested; waiting for the active stage to stop.");
        return;
      }
      const body = await readFencedJobRequestJson(res, cancelToken, requestFenceRef.current);
      if (!body.accepted) return;
      const errorBody = body.value as { error?: unknown };
      setError(typeof errorBody.error === "string" ? errorBody.error : `cancel failed (${res.status})`);
    } catch (err) {
      if (!requestFenceRef.current.accepts(cancelToken)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [jobId, phase, symbol]);

  const busy = phase === "starting" || phase === "running";
  const generationDisabled = busy || phase === "unsupported";

  const canResume = shouldShowServerRetry({ busy, jobId, phase, resumable });
  const resumeHint =
    "durable prior work is available — retry continues from server-validated artifacts without re-billing reusable passes.";

  const retrySynthesis = useCallback(async () => {
    if (jobId === null) return;
    const requestToken = requestFenceRef.current.begin(symbol);
    closeCurrentStream();
    setPhase("starting");
    setError(null);
    setSummary(null);
    setDataOnly(false);
    setResumable(false);
    try {
      const res = await fetch(`/api/report/${jobId}/retry`, { method: "POST" });
      if (!requestFenceRef.current.accepts(requestToken)) return;
      if (res.status === 202) {
        openStream(jobId);
        return;
      }
      const body = await readFencedJobRequestJson(res, requestToken, requestFenceRef.current);
      if (!body.accepted) return;
      const errorBody = body.value as { error?: unknown };
      setError(typeof errorBody.error === "string" ? errorBody.error : `retry failed (${res.status})`);
      setPhase("error");
    } catch (err) {
      if (!requestFenceRef.current.accepts(requestToken)) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [jobId, symbol, openStream, closeCurrentStream]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-3">
        {busy ? (
          <span className="mono text-[11px] text-muted">
            running · <span className="text-accent">{fmtUsd(totalCost)}</span>
          </span>
        ) : null}
        {phase === "running" && jobId !== null ? (
          <button
            type="button"
            onClick={() => void cancel()}
            className="mono border border-neg/50 px-3 py-1 text-[11px] uppercase tracking-[0.1em] text-neg hover:bg-neg/10"
          >
            cancel
          </button>
        ) : null}
        <button
          type="button"
          onClick={start}
          disabled={generationDisabled}
          className={`mono border px-3 py-1 text-[11px] uppercase tracking-[0.1em] ${
            generationDisabled
              ? "cursor-not-allowed border-edge text-faint opacity-60"
              : "border-accent/50 text-accent hover:bg-accent/10"
          }`}
        >
          {phase === "unsupported"
            ? "unsupported"
            : phase === "idle" || phase === "error"
              ? "generate report ·"
              : phase === "done"
                ? "regenerate ·"
                : "generating…"}
        </button>
      </div>

      {phase !== "idle" ? (
        <Panel
          title="report pipeline"
          right={
            <span className="mono text-[11px]">
              total <span className="text-accent">{fmtUsd(totalCost)}</span>
            </span>
          }
        >
          <ol className="flex flex-col divide-y divide-edge">
            {steps.map((s) => {
              const ms = durationMs(s);
              return (
                <li key={s.step} className="flex items-center gap-3 py-1.5">
                  <span
                    className={`mono inline-flex h-5 w-5 items-center justify-center border text-[12px] leading-none ${STATUS_TONE[s.status]}`}
                    aria-label={s.status}
                  >
                    {STATUS_GLYPH[s.status]}
                  </span>
                  <span className="mono w-24 shrink-0 text-[12px] text-fg">
                    {STEP_LABEL[s.step]}
                  </span>
                  <span className={`mono w-16 shrink-0 text-[10px] uppercase tracking-[0.08em] ${STATUS_TONE[s.status].split(" ")[0]}`}>
                    {s.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-faint">
                    {s.detail ?? ""}
                  </span>
                  {typeof s.costUsd === "number" ? (
                    <span className="mono shrink-0 text-[10px] text-muted">{fmtUsd(s.costUsd)}</span>
                  ) : null}
                  <span className="mono w-14 shrink-0 text-right text-[10px] text-faint">
                    {fmtDuration(ms)}
                  </span>
                </li>
              );
            })}
          </ol>

          {error ? (
            <div className="mt-2 border border-neg/40 bg-neg/10 px-2 py-1.5 text-[11px] text-neg">
              {error}
            </div>
          ) : null}

          {unsupportedMessage ? (
            <div className="mt-2 border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
              {unsupportedMessage} No company report was generated and no paid analysis was started.
            </div>
          ) : null}

          {canResume ? (
            <div className="mt-2 flex items-center justify-between gap-2 border border-accent/40 bg-accent/5 px-2 py-1.5">
              <span className="text-[11px] text-muted">{resumeHint}</span>
              <button
                type="button"
                onClick={retrySynthesis}
                className="mono shrink-0 border border-accent/50 px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-accent hover:bg-accent/10"
              >
                resume run ·
              </button>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {phase === "done" ? (
        <ReportReadyPanel summary={summary} dataOnly={dataOnly} totalCost={totalCost} steps={steps} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Report-ready compact panel
 * ------------------------------------------------------------------------ */

/**
 * Why this report is data-only, derived from the actual step outcomes. An
 * errored LLM step means the passes RAN and (partially) billed — saying "did
 * not run" there hid real spend behind a $0-looking banner (2026-07-10
 * incident: two ~8-minute overloaded analyst passes, banner claimed no run).
 */
function dataOnlyBannerText(steps: StepProgress[]): string {
  const llmFailed = steps.some(
    (s) => (s.step === "bull" || s.step === "bear" || s.step === "synthesize") && s.status === "error",
  );
  return llmFailed
    ? "LLM analysis failed mid-run (see the step details above for the provider error) — the failed passes' billed cost is included in the total below. This is a data-only report: sections are ungraded; the fetched data + disclosed gaps are still available."
    : "LLM analysis did not run (no ANTHROPIC key, or the model could not be resolved). This is a data-only report — sections are ungraded; the fetched data + disclosed gaps are still available.";
}

function ReportReadyPanel({
  summary,
  dataOnly,
  totalCost,
  steps,
}: {
  summary: ReportSummary | null;
  dataOnly: boolean;
  totalCost: number;
  steps: StepProgress[];
}) {
  const { costUsd: cost, dataOnly: isDataOnly } = canonicalReportPresentation(
    { totalCostUsd: totalCost, dataOnly },
    summary,
  );
  const rate = summary?.verificationRate ?? null;

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          report ready
          {isDataOnly ? (
            <span className="mono border border-warn/40 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-warn">
              data-only
            </span>
          ) : (
            <span className="mono border border-pos/40 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-pos">
              analyzed
            </span>
          )}
        </span>
      }
      right={
        summary ? (
          <div className="flex items-center gap-2">
            <span className="mono text-[11px] text-faint">#{summary.reportId}</span>
            <Link
              href={`/company/${encodeURIComponent(summary.symbol)}/report/${summary.reportId}`}
              className="mono border border-accent/50 px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-accent hover:bg-accent/10"
            >
              open
            </Link>
            <ExportButtons reportId={summary.reportId} symbol={summary.symbol} />
          </div>
        ) : null
      }
    >
      {isDataOnly ? (
        <div className="mb-2 border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
          {dataOnlyBannerText(steps)}
        </div>
      ) : null}

      {summary ? (
        <>
          {/* verdict synthesis */}
          <div className="border border-edge bg-raised px-3 py-2 text-[12px] leading-relaxed text-muted">
            {summary.synthesis}
          </div>

          {/* grade strip */}
          {summary.grades.length > 0 ? (
            <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
              {summary.grades.map((g) => {
                const gr = asGrade(g.grade);
                const color = gr ? `var(--grade-${gr.toLowerCase()})` : "var(--color-faint)";
                return (
                  <div key={g.key} className="flex flex-col gap-1 border border-edge px-2 py-1.5">
                    <div className="text-[9px] uppercase tracking-[0.1em] text-faint">{g.key}</div>
                    <div className="flex items-center gap-1.5">
                      <span
                        className="mono inline-flex h-5 w-5 items-center justify-center border text-[12px] font-semibold leading-none"
                        style={{
                          color,
                          borderColor: color,
                          backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
                        }}
                      >
                        {g.grade}
                      </span>
                    </div>
                    <div className="line-clamp-2 text-[10px] leading-snug text-faint">
                      {g.oneLineWhy}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* footer stats */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge pt-2 text-[11px]">
            <span
              className="text-faint"
              title="Citation coverage: share of report figures traceable to a citation or payload value — provenance, not correctness."
            >
              citation coverage:{" "}
              <span className="mono text-fg">
                {rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`}
              </span>
            </span>
            <span className="text-faint">
              cost: <span className="mono text-fg">{fmtUsd(cost)}</span>
            </span>
            <span className="text-faint">
              model: <span className="mono text-fg">{summary.model}</span>
            </span>
            <span className="text-faint">
              generated:{" "}
              <span className="mono text-fg">
                {summary.createdAt.replace("T", " ").slice(0, 19)}Z
              </span>
            </span>
          </div>
        </>
      ) : (
        <div className="text-[11px] text-faint">
          Report persisted{cost ? ` (cost ${fmtUsd(cost)})` : ""}. Summary details unavailable.
        </div>
      )}
    </Panel>
  );
}
