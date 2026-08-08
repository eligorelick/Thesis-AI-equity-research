/**
 * Persisted-report comparison page. Reports are loaded under the route entity,
 * ordered chronologically, and compared using their persisted version context.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell";
import { diffReports } from "@/report/diff";
import {
  loadReportPairForSymbol,
  orderPairChronologically,
  parseReportId,
  type LoadedReport,
} from "@/report/history";
import { normalizeRouteSymbol } from "@/symbol";
import { DiffBody } from "./diff-body";

export const dynamic = "force-dynamic";

function Sidebar({ symbol }: { symbol: string }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="border border-edge bg-bg px-2 py-1.5">
        <span className="mono text-[11px] uppercase tracking-[0.14em] text-muted">
          {symbol} report diff
        </span>
      </div>
      <Link
        href={"/company/" + encodeURIComponent(symbol) + "/history"}
        className="px-2 text-[11px] text-accent hover:underline"
      >
        back to report history
      </Link>
      <Link href="/" className="px-2 text-[11px] text-accent hover:underline">
        home
      </Link>
    </div>
  );
}

function ReportStamp({ label, loaded }: { label: string; loaded: LoadedReport }) {
  const row = loaded.row;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-[0.1em] text-faint">
        {label}
      </span>
      <span className="mono text-[13px] text-fg">
        #{row.id} {row.createdAt.slice(0, 10)}
      </span>
      <span className="mono text-[10px] text-faint">
        {row.model.replace(/^claude-/, "")}
        {row.costUsd === null ? "" : " $" + row.costUsd.toFixed(2)}
      </span>
    </div>
  );
}

function CompareHeader({
  older,
  newer,
  swapped,
}: {
  older: LoadedReport;
  newer: LoadedReport;
  swapped: boolean;
}) {
  return (
    <div className="border border-edge bg-panel">
      <div className="flex flex-wrap items-stretch gap-3 px-3 py-2">
        <ReportStamp label="older source" loaded={older} />
        <span className="mono self-center text-[11px] text-faint">to</span>
        <ReportStamp label="newer target" loaded={newer} />
      </div>
      {swapped ? (
        <div className="border-t border-edge px-3 py-1.5 text-[10px] text-faint">
          Selected reports were out of chronological order; reordered so deltas
          read older to newer.
        </div>
      ) : null}
    </div>
  );
}

function Notice({
  symbol,
  title,
  body,
}: {
  symbol: string;
  title: string;
  body: ReactNode;
}) {
  return (
    <div className="border border-warn/40 bg-warn/10 px-4 py-3">
      <div className="mono text-[13px] font-semibold text-warn">{title}</div>
      <p className="mt-1 text-[12px] text-muted">{body}</p>
      <Link
        href={"/company/" + encodeURIComponent(symbol) + "/history"}
        className="mt-2 inline-block text-[11px] text-accent hover:underline"
      >
        back to report history
      </Link>
    </div>
  );
}

export default async function DiffPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const { symbol: routeSymbol } = await params;
  const { a: fromRaw, b: toRaw } = await searchParams;
  const symbol = normalizeRouteSymbol(routeSymbol);
  if (symbol === null) notFound();

  const fromId = parseReportId(fromRaw);
  const toId = parseReportId(toRaw);
  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h1 className="mono text-[16px] font-semibold tracking-[0.08em] text-fg">
        {symbol} report diff
      </h1>
      <Link
        href={"/company/" + encodeURIComponent(symbol) + "/history"}
        className="text-[11px] text-accent hover:underline"
      >
        history
      </Link>
    </div>
  );

  if (fromId === null || toId === null) {
    return (
      <AppShell sidebar={<Sidebar symbol={symbol} />}>
        <div className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
          {header}
          <Notice
            symbol={symbol}
            title="pick two reports to compare"
            body="Use the history page to select two saved reports."
          />
        </div>
      </AppShell>
    );
  }

  if (fromId === toId) {
    return (
      <AppShell sidebar={<Sidebar symbol={symbol} />}>
        <div className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
          {header}
          <Notice
            symbol={symbol}
            title="same report selected"
            body="Choose two different saved reports."
          />
        </div>
      </AppShell>
    );
  }

  let pair;
  try {
    pair = loadReportPairForSymbol(fromId, toId, symbol);
  } catch {
    pair = null;
  }
  if (pair === null) {
    return (
      <AppShell sidebar={<Sidebar symbol={symbol} />}>
        <div className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
          {header}
          <Notice
            symbol={symbol}
            title="report unavailable"
            body="At least one selected report is missing, unreadable, or belongs to another entity."
          />
        </div>
      </AppShell>
    );
  }

  const { older, newer, swapped } = orderPairChronologically(pair);
  const diff = diffReports(older.report, newer.report, {
    fromReportVersion: older.report.meta.pipelineVersion,
    toReportVersion: newer.report.meta.pipelineVersion,
    fromSpecVersion: older.row.specVersion,
    toSpecVersion: newer.row.specVersion,
  });

  return (
    <AppShell sidebar={<Sidebar symbol={symbol} />}>
      <div className="mx-auto flex max-w-5xl flex-col gap-3 p-4">
        {header}
        <CompareHeader older={older} newer={newer} swapped={swapped} />
        <DiffBody diff={diff} />
      </div>
    </AppShell>
  );
}
