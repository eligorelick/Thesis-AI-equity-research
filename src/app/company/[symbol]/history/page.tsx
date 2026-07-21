/**
 * /company/[symbol]/history — report history for a ticker (the application contract §8).
 *
 * Server component. Lists every persisted report for the symbol newest-first in
 * a dense, terminal-grade table: date, model, the six-grade strip, verification
 * rate, cost, and a data-only badge; each row links to view the report and to
 * export it (MD / PDF). A two-select "compare" control (report A older + B
 * newer) links to the diff route.
 *
 * A malformed row still lists (its grade strip / data-only flag show as "—"),
 * so one bad row never hides the rest of the history.
 */

import Link from "next/link";

import { AppShell } from "@/components/shell";
import { GradeChip, Badge, Panel } from "@/components/ui";
import { ExportButtons } from "@/components/report/ExportButtons";
import {
  listReportsForSymbol,
  type ReportSummary,
  type GradeStripCell,
} from "@/report/history";

import { HistoryCompare, type CompareOption } from "./HistoryCompare";

// Reads persisted rows at request time — never statically pre-render.
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------------ *
 * Sidebar (matches the company-page shell)
 * ------------------------------------------------------------------------ */

function Sidebar({ symbol }: { symbol: string }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="border border-edge bg-bg">
        <div className="border-b border-edge px-2 py-1.5">
          <span className="mono text-[11px] uppercase tracking-[0.14em] text-muted">
            history
          </span>
        </div>
        <div className="px-2 py-1.5 text-[11px] text-muted">
          <span className="mono text-fg">{symbol}</span>
          <span className="text-faint"> · saved reports</span>
        </div>
      </div>
      <Link
        href={`/company/${encodeURIComponent(symbol)}`}
        className="px-2 text-[11px] text-accent hover:underline"
      >
        ← back to {symbol}
      </Link>
      <Link href="/" className="px-2 text-[11px] text-accent hover:underline">
        ← home
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Grade strip (compact, in-table)
 * ------------------------------------------------------------------------ */

function GradeStripInline({ cells }: { cells: GradeStripCell[] | null }) {
  if (cells === null) {
    return <span className="mono text-[11px] text-faint">—</span>;
  }
  return (
    <div className="flex items-center gap-1">
      {cells.map((c) => (
        <span key={c.key} title={c.key}>
          <GradeChip grade={c.grade} />
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * One report row
 * ------------------------------------------------------------------------ */

function shortModel(model: string): string {
  // "claude-opus-4-8" → "opus-4-8" for a denser column.
  return model.replace(/^claude-/, "");
}

function ReportRow({
  symbol,
  r,
}: {
  symbol: string;
  r: ReportSummary;
}) {
  const date = r.createdAt.slice(0, 10);
  const time = r.createdAt.slice(11, 16);
  const vr =
    r.verificationRate === null
      ? "—"
      : `${(r.verificationRate * 100).toFixed(0)}%`;
  const cost = r.costUsd === null ? "—" : `$${r.costUsd.toFixed(2)}`;
  const statusTone =
    r.status === "done" ? "pos" : r.status === "error" ? "neg" : "muted";

  return (
    <tr className="border-b border-edge align-middle last:border-b-0 hover:bg-raised">
      <td className="px-2 py-1.5">
        <div className="mono text-[12px] text-fg">{date}</div>
        <div className="mono text-[9px] text-faint">
          {time} · #{r.id}
        </div>
      </td>
      <td className="px-2 py-1.5">
        <span className="mono text-[11px] text-muted">{shortModel(r.model)}</span>
      </td>
      <td className="px-2 py-1.5">
        <GradeStripInline cells={r.gradeStrip} />
      </td>
      <td className="px-2 py-1.5 text-right">
        <span className="mono text-[11px]">{vr}</span>
      </td>
      <td className="px-2 py-1.5 text-right">
        <span className="mono text-[11px]">{cost}</span>
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Badge tone={statusTone}>{r.status}</Badge>
          {r.dataOnly === true ? <Badge tone="warn">data-only</Badge> : null}
        </div>
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center justify-end gap-1.5">
          <Link
            href={`/company/${encodeURIComponent(symbol)}/report/${r.id}`}
            className="mono border border-edge-strong px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-muted hover:border-accent hover:text-accent"
            title={`open run #${r.id}`}
          >
            view
          </Link>
          {r.gradeStrip !== null ? (
            <ExportButtons reportId={r.id} symbol={symbol} />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------------ */

export default async function HistoryPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol: rawSymbol } = await params;
  const symbol = decodeURIComponent(rawSymbol).toUpperCase().trim();

  let reports: ReportSummary[] = [];
  let loadError: string | null = null;
  try {
    reports = listReportsForSymbol(symbol);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const compareOptions: CompareOption[] = reports.map((r) => ({
    id: r.id,
    label: `#${r.id} · ${r.createdAt.slice(0, 10)} · ${shortModel(r.model)}`,
  }));

  return (
    <AppShell sidebar={<Sidebar symbol={symbol} />}>
      <div className="mx-auto flex max-w-5xl flex-col gap-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="mono text-[16px] font-semibold tracking-[0.08em] text-fg">
            {symbol} <span className="text-faint">· report history</span>
          </h1>
          <span className="text-[11px] text-faint">
            {reports.length} saved {reports.length === 1 ? "report" : "reports"}
          </span>
        </div>

        {loadError ? (
          <div className="border border-neg/40 bg-neg/10 px-4 py-3 text-[12px] text-neg">
            <div className="mono font-semibold">could not load history</div>
            <p className="mt-1 text-muted">{loadError}</p>
          </div>
        ) : reports.length === 0 ? (
          <Panel title="no saved reports">
            <p className="text-[12px] text-muted">
              No reports have been saved for{" "}
              <span className="mono text-fg">{symbol}</span> yet. Generate one
              from the{" "}
              <Link
                href={`/company/${encodeURIComponent(symbol)}`}
                className="text-accent hover:underline"
              >
                company page
              </Link>
              .
            </p>
          </Panel>
        ) : (
          <>
            <Panel title="compare two reports">
              <HistoryCompare symbol={symbol} options={compareOptions} />
              <p className="mt-2 text-[10px] text-faint">
                The diff view reorders the pair chronologically, so grade and
                target arrows always read older → newer.
              </p>
            </Panel>

            <Panel
              title="saved reports"
              right={
                <span className="mono text-[10px] text-faint">newest first</span>
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="border-b border-edge-strong">
                      <Th>date</Th>
                      <Th>model</Th>
                      <Th>grades · fund/val/tech/qual/lead/moat</Th>
                      <Th align="right">cited</Th>
                      <Th align="right">cost</Th>
                      <Th>status</Th>
                      <Th align="right">actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((r) => (
                      <ReportRow key={r.id} symbol={symbol} r={r} />
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        )}
      </div>
    </AppShell>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-faint ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
