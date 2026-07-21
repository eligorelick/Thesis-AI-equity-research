"use client";

/**
 * HistoryCompare — the two-select "compare" control on the report-history page.
 * Pick report A (older) and report B (newer); the "Compare →" link routes to
 * the diff view (?a=&b=). Client component: it only wires two <select>s to a
 * link — no data fetching (the option list is passed down from the server page).
 *
 * The diff route itself reorders chronologically, but we default A to the
 * second-newest and B to the newest so the common "what changed in the latest
 * report" comparison is one click away.
 */

import Link from "next/link";
import { useState } from "react";

export interface CompareOption {
  id: number;
  /** Short human label, e.g. "#42 · 2026-07-06 · opus-4-8". */
  label: string;
}

export function HistoryCompare({
  symbol,
  options,
}: {
  symbol: string;
  options: CompareOption[];
}) {
  // Options arrive newest-first. Default B = newest, A = second-newest.
  const [aId, setAId] = useState<number>(options[1]?.id ?? options[0]?.id ?? 0);
  const [bId, setBId] = useState<number>(options[0]?.id ?? 0);

  if (options.length < 2) {
    return (
      <div className="text-[11px] text-faint">
        Need at least two saved reports to compare.
      </div>
    );
  }

  const sameSelection = aId === bId;
  const sym = encodeURIComponent(symbol);
  const href = `/company/${sym}/history/diff?a=${aId}&b=${bId}`;

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Selector
        label="report A (older)"
        value={aId}
        options={options}
        onChange={setAId}
      />
      <span className="pb-1.5 text-[11px] text-faint">→</span>
      <Selector
        label="report B (newer)"
        value={bId}
        options={options}
        onChange={setBId}
      />
      {sameSelection ? (
        <span
          className="mono cursor-not-allowed border border-edge px-2.5 py-1 text-[10px] uppercase tracking-[0.1em] text-faint"
          title="pick two different reports"
        >
          compare →
        </span>
      ) : (
        <Link
          href={href}
          className="mono border border-accent/50 px-2.5 py-1 text-[10px] uppercase tracking-[0.1em] text-accent hover:bg-accent/10"
        >
          compare →
        </Link>
      )}
    </div>
  );
}

function Selector({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: CompareOption[];
  onChange: (id: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-[0.1em] text-faint">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
        className="mono border border-edge-strong bg-bg px-2 py-1 text-[11px] text-fg focus:border-accent focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
