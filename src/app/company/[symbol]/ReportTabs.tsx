"use client";

/**
 * ReportTabs — client tab switcher for /company/[symbol] when a persisted report
 * exists for the symbol. Toggles between the live Stage-B analysis panels and the
 * full persisted ReportView (rendered by the server and passed in as ReactNodes,
 * so no data-fetching crosses the client boundary).
 *
 * When no report exists the page renders the analysis panels directly (this
 * component is not used), keeping the generate flow front-and-center.
 */

import { useState, type ReactNode } from "react";

type Tab = "analysis" | "report";

export function ReportTabs({
  analysis,
  report,
  reportMeta,
}: {
  analysis: ReactNode;
  report: ReactNode;
  /** Short label shown on the report tab, e.g. "#42 · 2026-07-06". */
  reportMeta: string;
}) {
  const [tab, setTab] = useState<Tab>("report");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 border-b border-edge">
        <TabButton active={tab === "report"} onClick={() => setTab("report")}>
          full report
          <span className="ml-1.5 text-[9px] text-faint">{reportMeta}</span>
        </TabButton>
        <TabButton active={tab === "analysis"} onClick={() => setTab("analysis")}>
          live analysis
        </TabButton>
      </div>
      {/* Mount only the active tab: charting libraries (recharts / lightweight-
          charts) measure their container at mount and won't re-measure if it was
          hidden via display:none, so a hidden tab would render 0-width charts. */}
      {tab === "report" ? report : analysis}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mono -mb-px border-b-2 px-3 py-1.5 text-[11px] uppercase tracking-[0.1em] transition-colors ${
        active
          ? "border-accent text-accent"
          : "border-transparent text-faint hover:text-muted"
      }`}
    >
      {children}
    </button>
  );
}
