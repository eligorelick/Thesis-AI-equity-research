"use client";

import { useCallback, useMemo, useState } from "react";
import { Badge, Panel } from "@/components/ui";

/**
 * Operator control for a held startup (`THESIS_RESUME_ON_START=0`).
 *
 * Rendered only when the server reports `capabilities.resumeOnStart === false`
 * (see `SettingsPageView`). On the default `1` the scheduler already claimed
 * whatever was queued at startup, so the panel would offer a button with
 * nothing to do.
 *
 * Self-contained on purpose: it owns its own request state so the settings
 * write queue, which has a compare-and-swap contract of its own, is not
 * entangled with a button that has no persistent state at all. The browser
 * attaches Sec-Fetch-Site to this POST, so it needs no X-Thesis-Token.
 */

export type ResumeQueueStatus = "idle" | "resuming" | "resumed" | "error";

export interface ResumeQueueState {
  status: ResumeQueueStatus;
  detail: string | null;
}

/**
 * Everything the button does, lifted out of the component so it can be driven
 * without a DOM: it reports every state the click passes through to `onState`.
 */
export function createResumeQueueAction(
  onState: (next: ResumeQueueState) => void,
  fetchImpl: typeof fetch = fetch,
): () => Promise<void> {
  return async () => {
    onState({ status: "resuming", detail: null });
    try {
      const response = await fetchImpl("/api/jobs/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) {
        onState({
          status: "error",
          detail: `the server refused the resume (HTTP ${response.status})`,
        });
        return;
      }
      const body = (await response.json()) as { queued?: number };
      const queued = typeof body.queued === "number" ? body.queued : 0;
      onState({
        status: "resumed",
        detail: queued === 0
          ? "the scheduler is running; no job was waiting in the queue"
          : `the scheduler is running; ${queued} queued ${queued === 1 ? "job" : "jobs"} may now start`,
      });
    } catch {
      onState({ status: "error", detail: "the resume request could not be sent" });
    }
  };
}

export function ResumeQueueControl() {
  const [state, setState] = useState<ResumeQueueState>({ status: "idle", detail: null });
  const action = useMemo(() => createResumeQueueAction(setState), []);
  const resume = useCallback(() => {
    void action();
  }, [action]);

  const { status, detail } = state;
  const badge = status === "resuming" ? (
    <Badge tone="muted">resuming…</Badge>
  ) : status === "resumed" ? (
    <Badge tone="pos">resumed</Badge>
  ) : status === "error" ? (
    <Badge tone="neg">resume failed</Badge>
  ) : null;

  return (
    <Panel title="queued work" right={badge}>
      <button
        type="button"
        onClick={resume}
        disabled={status === "resuming"}
        className="mono border border-edge bg-bg px-2 py-1.5 text-[12px] hover:border-edge-strong disabled:opacity-50"
      >
        resume queued work
      </button>
      <p className="pt-2 text-[11px] leading-snug text-faint">
        With <span className="mono">THESIS_RESUME_ON_START=0</span> the server
        starts without claiming queued jobs, so paid work left behind by a
        restart waits for you. This starts the scheduler now. Starting, retrying,
        or canceling a report does the same thing.
      </p>
      {detail !== null && (
        <p className="pt-1 text-[11px] leading-snug text-faint">{detail}</p>
      )}
    </Panel>
  );
}
