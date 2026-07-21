/**
 * /company/[symbol]/report/[reportId] — the full, in-app view of ONE saved run.
 *
 * The company page always shows a symbol's LATEST report; this route renders a
 * specific persisted run by id (every run is saved as its own row — see
 * persistReport in jobRunner.ts), so past runs are actually viewable, not just
 * the newest. It reuses the shared ReportView renderer inside the normal
 * AppShell chrome (watchlist sidebar, current ticker auto-expanded).
 *
 * Deliberately does NOT re-run the pipeline: this is a pure DB read of the saved
 * snapshot, so it is fast and faithful — a historical run is shown as it was,
 * not decorated with today's live price/fundamentals charts (those live on the
 * company page). A missing / unparseable id degrades to a friendly in-shell
 * message rather than a 500.
 *
 * Server Component; reads persisted rows at request time.
 */

import Link from "next/link";

import { AppShell } from "@/components/shell";
import { Badge } from "@/components/ui";
import { WatchlistSidebar } from "@/components/watchlist/Sidebar";
import { ReportView, isDataOnlyReport } from "@/components/report/ReportView";
import { ExportButtons } from "@/components/report/ExportButtons";
import { getReportByIdForSymbol, parseReportId } from "@/report/history";

// Reads persisted rows at request time — never statically pre-render.
export const dynamic = "force-dynamic";

/** "claude-opus-4-8" → "opus-4-8" for a denser header. */
function shortModel(model: string): string {
  return model.replace(/^claude-/, "");
}

export default async function RunReportPage({
  params,
}: {
  params: Promise<{ symbol: string; reportId: string }>;
}) {
  const { symbol: rawSymbol, reportId: rawId } = await params;
  const symbol = decodeURIComponent(rawSymbol).toUpperCase().trim();
  const reportId = parseReportId(rawId);

  const loaded = reportId !== null ? getReportByIdForSymbol(reportId, symbol) : null;

  if (loaded === null) {
    return (
      <AppShell sidebar={<WatchlistSidebar activeSymbol={symbol} />}>
        <div className="mx-auto max-w-2xl p-6">
          <div className="border border-neg/40 bg-neg/10 px-4 py-3 text-[12px] text-neg">
            <div className="mono font-semibold">run unavailable</div>
            <p className="mt-1 text-muted">
              No readable report was found for id{" "}
              <span className="mono text-fg">#{rawId}</span> ({symbol}). It may
              not exist, or its stored content could not be parsed.
            </p>
            <div className="mt-3 flex gap-3 text-[11px]">
              <Link
                href={`/company/${encodeURIComponent(symbol)}/history`}
                className="text-accent hover:underline"
              >
                ← {symbol} history
              </Link>
              <Link
                href={`/company/${encodeURIComponent(symbol)}`}
                className="text-accent hover:underline"
              >
                {symbol} (live) →
              </Link>
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  const { row, report } = loaded;
  const date = row.createdAt.slice(0, 10);
  const time = row.createdAt.slice(11, 16);
  const statusTone =
    row.status === "done" ? "pos" : row.status === "error" ? "neg" : "muted";
  const dataOnly = isDataOnlyReport(report);

  return (
    <AppShell sidebar={<WatchlistSidebar activeSymbol={symbol} />}>
      {/* Run header strip — which run this is, when it ran, and its actions. */}
      <div className="mx-auto w-full max-w-[1400px] px-4 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge pb-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="mono text-[15px] font-semibold tracking-[0.08em] text-fg">
              {symbol} <span className="text-faint">· run #{row.id}</span>
            </h1>
            <span className="mono text-[11px] text-faint">
              {date} {time} · {shortModel(row.model)}
            </span>
            <Badge tone={statusTone}>{row.status}</Badge>
            {dataOnly ? <Badge tone="warn">data-only</Badge> : null}
            {typeof row.verificationRate === "number" ? (
              <span
                className="mono text-[10px] text-faint"
                title="citation coverage — provenance, not correctness"
              >
                {(row.verificationRate * 100).toFixed(0)}% cited
              </span>
            ) : null}
            {typeof row.costUsd === "number" ? (
              <span className="mono text-[10px] text-faint">
                ${row.costUsd.toFixed(2)}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <ExportButtons reportId={row.id} symbol={symbol} />
            <Link
              href={`/company/${encodeURIComponent(symbol)}/history`}
              className="mono border border-edge-strong px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-muted transition-colors hover:border-accent hover:text-accent"
              title="all saved runs for this ticker"
            >
              history
            </Link>
            <Link
              href={`/company/${encodeURIComponent(symbol)}`}
              className="mono border border-edge-strong px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-muted transition-colors hover:border-accent hover:text-accent"
              title="live analysis + charts (latest report)"
            >
              live →
            </Link>
          </div>
        </div>
      </div>

      <ReportView report={report} />
    </AppShell>
  );
}
