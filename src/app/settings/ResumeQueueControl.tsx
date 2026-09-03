"use client";

import { useCallback, useState } from "react";
import { Badge, Panel } from "@/components/ui";

/**
 * Operator control for a held startup (`THESIS_RESUME_ON_START=0`).
 *
 * Self-contained on purpose: it owns its own request state so the settings
 * write queue, which has a compare-and-swap contract of its own, is not
 * entangled with a button that has no persistent state at all. The browser
 * attaches Sec-Fetch-Site to this POST, so it needs no X-Thesis-Token.
 */
export function ResumeQueueControl() {
  const [status, setStatus] = useState<"idle" | "resuming" | "resumed" | "error">("idle");
  const [detail, setDetail] = useState<string | null>(null);

  const resume = useCallback(() => {
    setStatus("resuming");
    setDetail(null);
    void (async () => {
      try {
        const response = await fetch("/api/jobs/resume", {
          method: "POST",
          headers: { "content-type": "application/json" },
        });
        if (!response.ok) {
          setStatus("error");
          setDetail(`the server refused the resume (HTTP ${response.status})`);
          return;
        }
        const body = (await response.json()) as { queued?: number };
        const queued = typeof body.queued === "number" ? body.queued : 0;
        setStatus("resumed");
        setDetail(
          queued === 0
            ? "the scheduler is running; no job was waiting in the queue"
            : `the scheduler is running; ${queued} queued ${queued === 1 ? "job" : "jobs"} may now start`,
        );
      } catch {
        setStatus("error");
        setDetail("the resume request could not be sent");
      }
    })();
  }, []);

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
