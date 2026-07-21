/**
 * ReportView — the centerpiece renderer for a persisted {@link Report}
 * (src/report/schema.ts). Renders the full report (the application contract §7 sections 1–13)
 * as a dense, navigable, terminal-grade page:
 *
 *   - a sticky top bar holding the 6-grade strip (Fundamentals, Valuation,
 *     Technicals, Quality/Red-Flags, Leadership, Moat) — each a clickable
 *     GradeChip that scroll-anchors to that section's full GradeReasoning;
 *   - the verdict synthesis, prominently, right under the grades;
 *   - the Catalysts & Risks panel PINNED near the top with strong visual weight
 *     (SPEC §8) — accent-bordered, above the numbered deep-dive sections;
 *   - all sections in SPEC §7 order as anchored blocks;
 *   - a right-rail sticky anchor nav (the denser option vs. tabs) for jumping.
 *
 * Data-only reports (the LLM analysis did not run — no API key, or a degraded
 * pass) are detected exactly as the view API detects them
 * (appendix.missingData has an `analysis.llm` entry) and render a clear banner;
 * the graded LLM sections still render (the data-only report carries all-F
 * placeholder grades with a data-only synthesis) but the banner sets
 * expectations, and the appendix/manifest is always shown.
 *
 * Server Component: the anchor nav is plain <a href> links and the expandable
 * reasoning is native <details>, so none of this needs to hydrate. Callers
 * (e.g. ReportTabs) can instantiate this on the server and pass the result
 * down as a ReactNode without pulling it into the client bundle. The chart
 * for the technicals section is passed in as a ReactNode so the (client)
 * chart module stays decoupled from this renderer.
 */

import type { ReactNode } from "react";

import type { Report } from "@/report/schema";

import { sectionAnchorId } from "./primitives";
import {
  AppendixSection,
  BalanceSheetSection,
  BusinessSegments,
  CatalystsRisksPanel,
  CompetitiveSection,
  CompositeScorecard,
  ExecutiveSummary,
  FundamentalsSection,
  GradeStripBar,
  LeadershipSection,
  MacroSection,
  OutlookSection,
  ProjectionsSection,
  QualityFlags,
  ReportMetaStrip,
  TechnicalsSection,
  ValuationSection,
  VerdictHeader,
} from "./sections";

/* ------------------------------------------------------------------------ *
 * Data-only detection — identical rule to the view API
 * (src/app/api/report/view/[reportId]/route.ts).
 * ------------------------------------------------------------------------ */

export function isDataOnlyReport(report: Report): boolean {
  return report.appendix.missingData.some((m) => m.field === "analysis.llm");
}

/* ------------------------------------------------------------------------ *
 * Right-rail anchor nav
 * ------------------------------------------------------------------------ */

interface NavEntry {
  id: string;
  index: string;
  label: string;
  /** Prominent entries (Catalysts & Risks) get accent styling. */
  accent?: boolean;
}

const NAV_ENTRIES: NavEntry[] = [
  { id: "business", index: "02", label: "Business" },
  { id: "fundamentals", index: "03", label: "Fundamentals" },
  { id: "balanceSheet", index: "04", label: "Balance Sheet" },
  { id: "valuation", index: "05", label: "Valuation" },
  { id: "quality", index: "06", label: "Quality" },
  { id: "technicals", index: "07", label: "Technicals" },
  { id: "leadership", index: "08", label: "Leadership" },
  { id: "competitive", index: "09", label: "Competitive" },
  { id: "catalystsRisks", index: "10", label: "Catalysts & Risks", accent: true },
  { id: "outlook", index: "11", label: "Outlook" },
  { id: "projections", index: "12", label: "Projections" },
  { id: "macro", index: "13", label: "Macro" },
  { id: "appendix", index: "14", label: "Appendix" },
];

function AnchorNav() {
  return (
    <nav className="sticky top-4 hidden max-h-[calc(100vh-6rem)] w-48 shrink-0 flex-col gap-0.5 overflow-y-auto xl:flex">
      <div className="mono px-2 py-1 text-[9px] uppercase tracking-[0.14em] text-faint">
        sections
      </div>
      <a
        href={`#${sectionAnchorId("verdict")}`}
        className="mono flex items-baseline gap-2 px-2 py-1 text-[11px] text-muted hover:bg-raised hover:text-accent"
      >
        <span className="text-faint">01</span>
        <span>Verdict</span>
      </a>
      {NAV_ENTRIES.map((e) => (
        <a
          key={e.id}
          href={`#${sectionAnchorId(e.id)}`}
          className={`mono flex items-baseline gap-2 px-2 py-1 text-[11px] hover:bg-raised ${
            e.accent
              ? "text-accent hover:text-accent"
              : "text-muted hover:text-accent"
          }`}
        >
          <span className={e.accent ? "text-accent/70" : "text-faint"}>
            {e.index}
          </span>
          <span>{e.label}</span>
        </a>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------------------ *
 * Data-only banner
 * ------------------------------------------------------------------------ */

/**
 * `reason` is the report's own `analysis.llm` manifest entry — the pipeline's
 * honest account (no key vs. model resolution vs. passes that RAN and failed,
 * billing real cost). Hardcoding "no API key" here misdescribed the 2026-07-10
 * incident, where two ~8-minute analyst passes billed and then died overloaded.
 */
function DataOnlyBanner({ reason }: { reason: string | null }) {
  return (
    <div className="border border-warn/50 bg-warn/10 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="mono border border-warn/50 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-warn">
          data-only
        </span>
        <span className="text-[12px] font-medium text-warn">
          {reason ?? "no LLM analysis in this report"}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-muted">
        The multi-pass AI analysis is absent from this report, so the graded
        sections below carry placeholder grades and no reasoning. The fetched
        data, computed metrics, and the disclosed missing-data manifest (in the
        appendix) are still complete.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * ReportView
 * ------------------------------------------------------------------------ */

export function ReportView({
  report,
  /** Optional chart node mounted inside the Technicals section. */
  technicalsChart,
  /** Optional chart node mounted inside the Fundamentals section. */
  fundamentalsChart,
}: {
  report: Report;
  technicalsChart?: ReactNode;
  fundamentalsChart?: ReactNode;
}) {
  const dataOnly = isDataOnlyReport(report);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-3 p-4">
      {/* Sticky grade strip — clickable, deep-links to each graded section. */}
      <div className="sticky top-0 z-20 -mx-4 border-b border-edge bg-bg/95 px-4 py-2 backdrop-blur">
        <GradeStripBar gradeStrip={report.verdict.gradeStrip} compact />
      </div>

      {report.meta && <ReportMetaStrip report={report} />}

      {dataOnly && (
        <DataOnlyBanner
          reason={
            report.appendix.missingData.find((m) => m.field === "analysis.llm")?.reason ?? null
          }
        />
      )}

      <div className="flex gap-4">
        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* §1 Verdict */}
          <div id={sectionAnchorId("verdict")} className="scroll-mt-28">
            <VerdictHeader verdict={report.verdict} />
            {report.verdict.executiveSummary &&
              report.verdict.executiveSummary.length > 0 && (
                <div className="mt-3">
                  <ExecutiveSummary claims={report.verdict.executiveSummary} />
                </div>
              )}
            {report.scores && (
              <div className="mt-3">
                <CompositeScorecard scores={report.scores} />
              </div>
            )}
            <div className="mt-3">
              <GradeStripBar gradeStrip={report.verdict.gradeStrip} />
            </div>
          </div>

          {/* Catalysts & Risks — pinned near the top, visually prominent. */}
          <CatalystsRisksPanel
            catalystsRisks={report.catalystsRisks}
            index={10}
          />

          {/* §2–§13 in SPEC order (Catalysts also anchored above at #10). */}
          <BusinessSegments business={report.business} index={2} />
          <FundamentalsSection
            fundamentals={report.fundamentals}
            index={3}
            chart={fundamentalsChart}
          />
          <BalanceSheetSection balanceSheet={report.balanceSheet} index={4} />
          <ValuationSection
            valuation={report.valuation}
            scenarioTargets={report.scenarioTargets}
            fairValue={report.fairValue}
            index={5}
          />
          <QualityFlags quality={report.quality} index={6} />
          <TechnicalsSection
            technicals={report.technicals}
            index={7}
            chart={technicalsChart}
          />
          <LeadershipSection leadership={report.leadership} index={8} />
          <CompetitiveSection competitive={report.competitive} index={9} />
          <OutlookSection outlook={report.outlook} index={11} />
          {report.projections && (
            <ProjectionsSection projections={report.projections} index={12} />
          )}
          <MacroSection macro={report.macro} index={13} />
          <AppendixSection
            appendix={report.appendix}
            disagreements={report.disagreements}
            index={14}
          />
        </div>

        {/* Right-rail anchor nav (denser than tabs). */}
        <AnchorNav />
      </div>
    </div>
  );
}
