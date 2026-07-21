/**
 * Watchlist sidebar (the application contract §8): the app-wide left rail. Renders, per watched
 * symbol, a dense scannable row — ticker (mono, links to /company/SYMBOL),
 * price + colored change%, a compact 6-grade chip strip (n/a when no report),
 * last-report date, and next-earnings date. An AddTicker control sits at the
 * top and a per-row remove (×) at the right.
 *
 * Two entry points:
 *   - {@link WatchlistSidebar} — an async SERVER component that calls
 *     getWatchlistView() itself. The integrator slots <WatchlistSidebar/> into
 *     AppShell's `sidebar` prop across pages.
 *   - {@link Sidebar} — the presentational body, given an already-computed
 *     WatchlistRowView[]. Server-friendly (no hooks); reuses it in tests /
 *     stories or when a page has already loaded the view.
 *
 * Data fetching lives in the server data layer (@/watchlist/watchlist); the
 * only client pieces are AddTicker + RemoveButton, imported as leaves.
 */

import Link from "next/link";

import { GradeChip } from "@/components/ui";
import type { Grade } from "@/types/core";
import { getWatchlistView, type WatchlistRowView, type WatchlistGrades } from "@/watchlist/watchlist";

import { AddTicker } from "./AddTicker";
import { RemoveButton } from "./RemoveButton";
import { RunsDisclosure } from "./RunsDisclosure";

/* ------------------------------------------------------------------------ *
 * Async server entry — the mountable component
 * ------------------------------------------------------------------------ */

/**
 * Async server component: loads the enriched view and renders the sidebar.
 * Degrades to an empty (but functional) sidebar if the view load throws, so a
 * transient DB/provider error never blanks the whole app chrome.
 */
export async function WatchlistSidebar({ activeSymbol }: { activeSymbol?: string }) {
  let rows: WatchlistRowView[] = [];
  try {
    rows = await getWatchlistView();
  } catch {
    rows = [];
  }
  return <Sidebar rows={rows} activeSymbol={activeSymbol} />;
}

/* ------------------------------------------------------------------------ *
 * Presentational body
 * ------------------------------------------------------------------------ */

const GRADE_ORDER: ReadonlyArray<{ key: keyof WatchlistGrades; label: string }> = [
  { key: "fundamentals", label: "F" },
  { key: "valuation", label: "V" },
  { key: "technicals", label: "T" },
  { key: "quality", label: "Q" },
  { key: "leadership", label: "L" },
  { key: "moat", label: "M" },
];

export function Sidebar({
  rows,
  activeSymbol,
}: {
  rows: WatchlistRowView[];
  activeSymbol?: string;
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <span className="mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
          watchlist
        </span>
        <span className="mono text-[10px] text-faint">{rows.length}</span>
      </div>

      <div className="border-b border-edge p-2">
        <AddTicker />
      </div>

      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-[11px] text-faint">
          no tickers yet
          <div className="mt-1 text-[10px] text-faint">add one above to track it</div>
        </div>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <WatchRow
              key={row.symbol}
              row={row}
              active={activeSymbol !== undefined && row.symbol === activeSymbol}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Row
 * ------------------------------------------------------------------------ */

function WatchRow({ row, active }: { row: WatchlistRowView; active: boolean }) {
  const price = typeof row.price === "number" ? row.price : null;
  const change = typeof row.changePct === "number" ? row.changePct : null;
  const changeTone =
    change === null ? "text-faint" : change >= 0 ? "text-pos" : "text-neg";

  return (
    <li className="group border-b border-edge last:border-b-0">
      <Link
        href={`/company/${encodeURIComponent(row.symbol)}`}
        className="block px-3 py-2 hover:bg-raised"
      >
        {/* ticker + price + remove */}
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="mono text-[13px] font-semibold tracking-[0.06em] text-fg">
              {row.symbol}
            </span>
            {row.companyName ? (
              <span className="truncate text-[10px] text-faint">{row.companyName}</span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-baseline gap-1.5">
            <span className="mono text-[12px] text-fg">
              {price === null ? "—" : fmtPrice(price)}
            </span>
            <RemoveButton symbol={row.symbol} />
          </div>
        </div>

        {/* change% + grade strip */}
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className={`mono text-[11px] ${changeTone}`}>
            {change === null ? "" : fmtSignedPct(change)}
          </span>
          <GradeStrip grades={row.grades ?? null} />
        </div>

        {/* last report / next earnings */}
        <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-faint">
          <span className="mono">
            {row.lastReportAt ? `rpt ${row.lastReportAt.slice(0, 10)}` : "no report"}
            {typeof row.verificationRate === "number" ? (
              <span title="citation coverage — provenance, not correctness">
                {` · ${(row.verificationRate * 100).toFixed(0)}% cited`}
              </span>
            ) : (
              ""
            )}
          </span>
          <span className="mono">
            {row.nextEarnings ? `ER ${row.nextEarnings}` : "ER —"}
          </span>
        </div>
      </Link>
      <RunsDisclosure symbol={row.symbol} runs={row.runs ?? []} defaultOpen={active} />
    </li>
  );
}

/** Compact 6-grade strip; a plain "n/a" placeholder when no report exists. */
function GradeStrip({ grades }: { grades: WatchlistGrades | null }) {
  if (grades === null) {
    return <span className="mono text-[10px] text-faint">grades n/a</span>;
  }
  return (
    <div className="flex items-center gap-0.5" aria-label="section grades">
      {GRADE_ORDER.map(({ key, label }) => (
        <MiniGrade key={key} label={label} grade={grades[key]} />
      ))}
    </div>
  );
}

/**
 * A single tiny grade cell: a one-letter section label over a color-coded grade.
 * Reuses GradeChip's --grade-* coloring for the letter; the section label keeps
 * the strip legible in the narrow rail.
 */
function MiniGrade({ label, grade }: { label: string; grade: Grade }) {
  return (
    <span className="flex flex-col items-center gap-px" title={`${label}: ${grade}`}>
      <span className="text-[7px] leading-none text-faint">{label}</span>
      <GradeChip grade={grade} />
    </span>
  );
}

/* ------------------------------------------------------------------------ *
 * Local formatters (kept independent of the company page's format helpers)
 * ------------------------------------------------------------------------ */

function fmtPrice(v: number): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtSignedPct(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}
