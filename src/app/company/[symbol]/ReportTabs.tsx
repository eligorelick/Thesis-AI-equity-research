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
  const panelId = (key: Tab): string => `report-tabs-panel-${key}`;
  const tabId = (key: Tab): string => `report-tabs-tab-${key}`;
  // WAI-ARIA tabs: the active tab is announced through aria-selected and the
  // arrow keys move between tabs, so the state is not conveyed by colour
  // alone (audit 2026-09-06, F219).
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: Tab = tab === "report" ? "analysis" : "report";
    setTab(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="report views" onKeyDown={onKeyDown} className="flex items-center gap-1.5 border-b border-edge">
        <TabButton id={tabId("report")} controls={panelId("report")} active={tab === "report"} onClick={() => setTab("report")}>
          full report
          <span className="ml-1.5 text-[9px] text-faint">{reportMeta}</span>
        </TabButton>
        <TabButton id={tabId("analysis")} controls={panelId("analysis")} active={tab === "analysis"} onClick={() => setTab("analysis")}>
          live analysis
        </TabButton>
      </div>
      {/* Mount only the active tab: charting libraries (recharts / lightweight-
          charts) measure their container at mount and won't re-measure if it was
          hidden via display:none, so a hidden tab would render 0-width charts. */}
      <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)}>
        {tab === "report" ? report : analysis}
      </div>
    </div>
  );
}

function TabButton({
  id,
  controls,
  active,
  onClick,
  children,
}: {
  id: string;
  controls: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={active}
      aria-controls={controls}
      tabIndex={active ? 0 : -1}
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
