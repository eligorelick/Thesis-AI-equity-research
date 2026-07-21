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
 *   3. On the terminal "done" event, GET /api/report/view/[reportId] and render
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

interface StepUpdateEvent {
  type: "step-update";
  jobId: string;
  step: StepProgress;
  steps: StepProgress[];
}
interface CostUpdateEvent {
  type: "cost-update";
  jobId: string;
  step: string;
  passCostUsd: number;
  totalCostUsd: number;
}
interface JobDoneEvent {
  type: "done";
  jobId: string;
  reportId: number | null;
  verificationRate: number | null;
  totalCostUsd: number;
  dataOnly: boolean;
}
interface JobErrorEvent {
  type: "error";
  jobId: string;
  message: string;
}
interface SnapshotEvent {
  jobId: string;
  symbol: string;
  status: string;
  steps: StepProgress[];
  error: string | null;
  reportId: number | null;
  totalCostUsd: number;
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

type Phase = "idle" | "starting" | "running" | "done" | "error";

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

  const esRef = useRef<EventSource | null>(null);

  const closeStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  useEffect(() => closeStream, [closeStream]);

  const loadSummary = useCallback(async (reportId: number) => {
    try {
      const res = await fetch(`/api/report/view/${reportId}`, { cache: "no-store" });
      if (res.ok) {
        setSummary((await res.json()) as ReportSummary);
      }
    } catch {
      // Non-fatal — the stepper already shows completion; the panel is a bonus.
    }
  }, []);

  const openStream = useCallback(
    (jobId: string) => {
      closeStream();
      const es = new EventSource(`/api/report/${jobId}/stream`);
      esRef.current = es;

      es.addEventListener("snapshot", (ev) => {
        try {
          const snap = JSON.parse((ev as MessageEvent).data) as SnapshotEvent;
          if (Array.isArray(snap.steps) && snap.steps.length > 0) setSteps(snap.steps);
          // Adopted mid-flight/terminal jobs must show the true running cost,
          // not $0 — the snapshot carries the cost_log sum.
          if (typeof snap.totalCostUsd === "number") setTotalCost(snap.totalCostUsd);
          if (snap.status === "running" || snap.status === "queued") setPhase("running");
        } catch {
          /* ignore malformed frame */
        }
      });

      es.addEventListener("step-update", (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent).data) as StepUpdateEvent;
          if (Array.isArray(e.steps)) setSteps(e.steps);
          setPhase("running");
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("cost-update", (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent).data) as CostUpdateEvent;
          setTotalCost(e.totalCostUsd);
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("done", (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent).data) as JobDoneEvent;
          setPhase("done");
          setDataOnly(e.dataOnly);
          if (typeof e.totalCostUsd === "number") setTotalCost(e.totalCostUsd);
          if (e.reportId !== null) void loadSummary(e.reportId);
        } catch {
          /* ignore */
        }
        closeStream();
      });

      es.addEventListener("error", (ev) => {
        // Two cases: a server-sent "error" event frame (has data) or a transport
        // error (no data). Only treat a data-bearing frame as terminal failure.
        const data = (ev as MessageEvent).data;
        if (typeof data === "string" && data.length > 0) {
          try {
            const e = JSON.parse(data) as JobErrorEvent;
            setError(e.message);
            setPhase("error");
            closeStream();
          } catch {
            /* ignore */
          }
        }
        // Transport hiccups: EventSource auto-reconnects; leave the stream open.
      });
    },
    [closeStream, loadSummary],
  );

  const start = useCallback(async () => {
    setPhase("starting");
    setError(null);
    setSummary(null);
    setJobId(null);
    setTotalCost(0);
    setDataOnly(false);
    setSteps(PIPELINE_STEPS.map((step) => ({ step, status: "pending" as const })));

    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      if (res.status === 202) {
        const { jobId: newJobId } = (await res.json()) as { jobId: string };
        setJobId(newJobId);
        openStream(newJobId);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `report request failed (${res.status})`);
      setPhase("error");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [symbol, openStream]);

  const cancel = useCallback(async () => {
    if (jobId === null || phase !== "running") return;
    try {
      const res = await fetch(`/api/report/${jobId}/cancel`, { method: "POST" });
      if (res.status === 202) {
        setError("Cancellation requested; waiting for the active stage to stop.");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `cancel failed (${res.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [jobId, phase]);

  const busy = phase === "starting" || phase === "running";

  // Resume-from-failure (2026-07 audit item 1 + partial shape 2026-07-10):
  // the runner persists every SUCCESSFUL analyst pass output the moment it
  // has it. Two resumable shapes, mirroring the server predicate
  // (stepsShowResumableFailure): both analysts done + synthesize errored
  // (re-run only the judge tail), or exactly one analyst done + the other
  // errored (re-run only the failed side). Nothing already paid is re-billed.
  const stepOf = (step: PipelineStep): StepProgress | undefined =>
    steps.find((s) => s.step === step);
  const analystStatuses = [stepOf("bull")?.status, stepOf("bear")?.status];
  const analystDoneCount = analystStatuses.filter((s) => s === "done").length;
  const analystsTerminal = analystStatuses.every((s) => s === "done" || s === "error");
  const resumableShape =
    stepOf("synthesize")?.status !== "done" &&
    analystsTerminal &&
    (analystDoneCount === 2 ? stepOf("synthesize")?.status === "error" : analystDoneCount === 1);
  const canResume =
    !busy && jobId !== null && (phase === "done" || phase === "error") && resumableShape;
  const resumeHint =
    analystDoneCount === 2
      ? "the paid bull/bear analyst passes are saved — retry synthesis without re-billing them."
      : `the paid ${analystStatuses[0] === "done" ? "bull" : "bear"} analyst pass is saved — retry re-runs only the failed side, then synthesis.`;

  const retrySynthesis = useCallback(async () => {
    if (jobId === null) return;
    setPhase("starting");
    setError(null);
    setSummary(null);
    setDataOnly(false);
    try {
      const res = await fetch(`/api/report/${jobId}/retry`, { method: "POST" });
      if (res.status === 202) {
        openStream(jobId);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `retry failed (${res.status})`);
      setPhase("error");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [jobId, openStream]);

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
          disabled={busy}
          className={`mono border px-3 py-1 text-[11px] uppercase tracking-[0.1em] ${
            busy
              ? "cursor-not-allowed border-edge text-faint opacity-60"
              : "border-accent/50 text-accent hover:bg-accent/10"
          }`}
        >
          {phase === "idle" || phase === "error"
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
  const isDataOnly = summary?.dataOnly ?? dataOnly;
  const rate = summary?.verificationRate ?? null;
  const cost = summary?.costUsd ?? totalCost;

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
