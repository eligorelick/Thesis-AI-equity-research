"use client";

/**
 * RunsDisclosure — the per-ticker expandable run history in the sidebar
 * (the application contract §8: all saved reports per ticker). A quiet toggle bar shows the run
 * count; expanding reveals every saved run (newest-first), each linking to that
 * exact run's full report at /company/[symbol]/report/[id] — distinct from the
 * ticker link above it, which opens the company page (the latest report).
 *
 * A tiny client island (one useState) so the collapsed rail stays dense while
 * every past run stays one click away. The run links themselves are plain
 * <Link>s. Renders nothing when the ticker has no saved runs.
 */

import { useState } from "react";
import Link from "next/link";

import type { RunRef } from "@/report/history";

export function RunsDisclosure({
  symbol,
  runs,
  defaultOpen = false,
}: {
  symbol: string;
  runs: RunRef[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (runs.length === 0) return null;

  const base = `/company/${encodeURIComponent(symbol)}/report/`;

  return (
    <div className="border-t border-edge">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${open ? "hide" : "show"} ${symbol} run history`}
        className="mono flex w-full items-center justify-between px-3 py-1 text-[10px] text-faint hover:bg-raised hover:text-muted"
      >
        <span>
          <span className="inline-block w-3 text-center">{open ? "▾" : "▸"}</span>
          {runs.length} {runs.length === 1 ? "run" : "runs"}
        </span>
        <span className="text-[9px] uppercase tracking-[0.1em]">history</span>
      </button>
      {open ? (
        <ul className="flex flex-col pb-1">
          {runs.map((r) => (
            <li key={r.id}>
              <Link
                href={`${base}${r.id}`}
                className="mono flex items-center justify-between gap-2 py-1 pl-6 pr-3 text-[10px] text-muted hover:bg-raised hover:text-accent"
              >
                <span className="truncate">
                  <span className="text-faint">#{r.id}</span> {r.createdAt.slice(0, 10)}
                  <span className="text-faint"> {r.createdAt.slice(11, 16)}</span>
                </span>
                <RunStatus status={r.status} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RunStatus({ status }: { status: string }) {
  const tone =
    status === "done" ? "text-pos" : status === "error" ? "text-neg" : "text-faint";
  return <span className={`shrink-0 text-[9px] ${tone}`}>{status}</span>;
}
