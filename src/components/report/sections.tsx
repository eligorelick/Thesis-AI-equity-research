/**
 * One component per report section (the application contract §7 sections 1–13). Each is dense,
 * consistent, and provenance-first: figures render as {@link TracedFigure}s
 * (value + citation-coverage indicator + as-of on hover), claims as
 * {@link ClaimText} (label chip + source), graded sections lead with a
 * {@link GradeReasoning} block.
 *
 * Server Component — static presentational markup, no data fetching. The
 * click-to-reveal claim source line and the chart panels are the only
 * interactive leaves (client islands imported transitively via primitives.tsx
 * and components/charts/*); everything else here renders and streams from the
 * server with zero hydration cost. Consumed by ReportView.
 */

import type { ReactNode } from "react";

import {
  Badge,
  DataTable,
  GapNotice,
  GradeChip,
  ScorePill,
  SectionHeading,
  type Column,
  type Tone,
} from "@/components/ui";
import type {
  Appendix,
  BalanceSheet,
  Business,
  CatalystsRisks,
  Competitive,
  Disagreement,
  Executive,
  Fundamentals,
  GradeBlock,
  Leadership,
  Macro,
  MetricRow,
  MoatAssessment,
  MultipleRow,
  Outlook,
  Projections,
  Quality,
  Report,
  ScoreAspect,
  Scoring,
  SourcedClaim,
  FairValue,
  ScenarioTargets,
  Technicals,
  TracedNumber,
  Valuation,
  Verdict,
} from "@/report/schema";
import { citationOutcomeLabel } from "@/report/schema";
import {
  formatCostUsd,
  formatVerificationClaim,
  roundedDisplayedCostTotal,
} from "@/report/format";
import type { Grade } from "@/types/core";

import { SensitivityHeatmap } from "@/components/charts/SensitivityHeatmap";
import { ProjectionFanChart } from "@/components/charts/lazy";

import {
  ClaimList,
  formatMultiple,
  formatNumber,
  formatPct,
  GradeReasoning,
  ScenarioCard,
  sectionAnchorId,
  SeverityProbMatrix,
  ShareBar,
  TracedFigure,
  TracedStat,
  type MatrixItem,
} from "./primitives";

/* ======================================================================== *
 * Section frame — anchored wrapper with a numbered heading
 * ======================================================================== */

export function SectionFrame({
  id,
  index,
  title,
  right,
  children,
}: {
  id: string;
  index: number;
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={sectionAnchorId(id)}
      // scroll-margin so the sticky grade strip + nav don't cover the heading.
      className="scroll-mt-28 border border-edge bg-panel"
    >
      <div className="flex items-center justify-between gap-2 border-b border-edge px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="mono text-[10px] text-faint">
            {String(index).padStart(2, "0")}
          </span>
          <h2 className="mono text-[12px] font-medium uppercase tracking-[0.12em] text-fg">
            {title}
          </h2>
        </div>
        {right !== undefined && (
          <div className="flex items-center gap-2 text-[11px] text-muted">
            {right}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3 px-3 py-3">{children}</div>
    </section>
  );
}

/** Small labeled sub-block used inside sections. */
function SubBlock({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[9px] uppercase tracking-[0.12em] text-faint">
        {label}
      </div>
      {children}
    </div>
  );
}

/* ======================================================================== *
 * §7.1 Verdict header + grade strip
 * ======================================================================== */

export const GRADE_STRIP_KEYS = [
  { key: "fundamentals", label: "Fundamentals" },
  { key: "valuation", label: "Valuation" },
  { key: "technicals", label: "Technicals" },
  { key: "quality", label: "Quality / Red-Flags" },
  { key: "leadership", label: "Leadership" },
  { key: "moat", label: "Moat" },
] as const satisfies ReadonlyArray<{
  key: keyof Verdict["gradeStrip"];
  label: string;
}>;

/** Maps a grade-strip key to the section anchor it deep-links to. */
export const GRADE_TO_SECTION: Record<keyof Verdict["gradeStrip"], string> = {
  fundamentals: "fundamentals",
  valuation: "valuation",
  technicals: "technicals",
  quality: "quality",
  leadership: "leadership",
  moat: "competitive",
  balanceSheet: "balanceSheet",
};

export function VerdictHeader({ verdict }: { verdict: Verdict }) {
  return (
    <div className="border border-edge-strong bg-panel">
      <div className="border-b border-edge px-3 py-1.5">
        <SectionHeading>verdict · synthesis</SectionHeading>
      </div>
      <div className="px-3 py-3">
        <p className="text-[13px] leading-relaxed text-fg">
          {verdict.synthesis}
        </p>
      </div>
    </div>
  );
}

/**
 * The sticky, clickable grade strip. Each chip is a link to its section anchor
 * (`#report-<section>`) — clicking scrolls there where the full GradeReasoning
 * lives. Renders inline in flow AND is reused sticky at the top of ReportView.
 */
export function GradeStripBar({
  gradeStrip,
  compact = false,
}: {
  gradeStrip: Verdict["gradeStrip"];
  compact?: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-3 gap-1.5 lg:grid-cols-6 ${compact ? "" : ""}`}
    >
      {GRADE_STRIP_KEYS.map(({ key, label }) => {
        const block = gradeStrip[key];
        const anchor = sectionAnchorId(GRADE_TO_SECTION[key]);
        return (
          <a
            key={key}
            href={`#${anchor}`}
            className="group flex flex-col gap-1 border border-edge bg-panel px-2 py-1.5 transition-colors hover:border-accent/50 hover:bg-raised"
            title={block.oneLineWhy}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[9px] uppercase tracking-[0.09em] text-faint group-hover:text-muted">
                {label}
              </span>
              <GradeChip grade={block.grade} />
            </div>
            {!compact && (
              <p className="line-clamp-2 text-[10px] leading-snug text-faint">
                {block.oneLineWhy}
              </p>
            )}
          </a>
        );
      })}
    </div>
  );
}

/* ======================================================================== *
 * §7.1b Composite scorecard (deterministic 0–100 per aspect + composite)
 * ======================================================================== */

const SCORE_ASPECTS: { key: ScoreAspect; label: string }[] = [
  { key: "fundamentals", label: "Fundamentals" },
  { key: "valuation", label: "Valuation" },
  { key: "quality", label: "Quality" },
  { key: "balanceSheet", label: "Balance Sheet" },
  { key: "moat", label: "Moat" },
  { key: "leadership", label: "Leadership" },
  { key: "technicals", label: "Technicals" },
];

/**
 * The deterministic scorecard: the weighted composite (big) plus a clickable
 * 0–100 score pill per aspect, each deep-linking to its section. Sub-100 data
 * completeness is surfaced so a thinly-scored aspect is disclosed, not hidden.
 */
export function CompositeScorecard({ scores }: { scores: Scoring }) {
  const c = scores.composite;
  return (
    <div className="border border-edge-strong bg-panel">
      <div className="flex items-center justify-between gap-2 border-b border-edge px-3 py-1.5">
        <SectionHeading>composite scorecard</SectionHeading>
        <span className="mono text-[9px] text-faint">bands {scores.bandsVersion}</span>
      </div>
      <div className="flex flex-col gap-3 px-3 py-3 lg:flex-row lg:items-center">
        <div className="flex shrink-0 items-center gap-3 border-b border-edge pb-3 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4">
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-[0.1em] text-faint">composite</span>
            <span className="mono text-[30px] leading-none text-fg">
              {c.score === null ? "n/a" : Math.round(c.score)}
            </span>
          </div>
          {c.band && <GradeChip grade={c.band} />}
        </div>
        <div className="grid flex-1 grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
          {SCORE_ASPECTS.map(({ key, label }) => {
            const a = scores.aspects[key];
            return (
              <a
                key={key}
                href={`#${sectionAnchorId(GRADE_TO_SECTION[key])}`}
                className="flex flex-col gap-1 border border-edge bg-raised px-2 py-1.5 transition-colors hover:border-accent/50"
                title={a.notApplicableReason ?? a.note}
              >
                <span className="text-[9px] uppercase tracking-[0.09em] text-faint">{label}</span>
                <div className="flex items-center justify-between gap-1">
                  <ScorePill score={a.score} band={a.band} />
                  {a.score !== null && a.dataCompleteness < 1 && (
                    <span
                      className="mono text-[9px] text-warn"
                      title={`data completeness ${(a.dataCompleteness * 100).toFixed(0)}%`}
                    >
                      {Math.round(a.dataCompleteness * 100)}%
                    </span>
                  )}
                </div>
              </a>
            );
          })}
        </div>
      </div>
      <div className="border-t border-edge px-3 py-1.5">
        <p className="text-[10px] leading-snug text-faint">{c.methodology}</p>
      </div>
    </div>
  );
}

/**
 * The executive summary / analyst note — the top-of-report interpretive narrative
 * that weaves the composite grade, projections, and scenarios into one thesis.
 */
export function ExecutiveSummary({ claims }: { claims: readonly SourcedClaim[] }) {
  if (claims.length === 0) return null;
  return (
    <div className="border border-accent/40 bg-panel">
      <div className="border-b border-edge px-3 py-1.5">
        <SectionHeading>executive summary · analyst note</SectionHeading>
      </div>
      <div className="px-3 py-3">
        <ClaimList claims={claims} />
      </div>
    </div>
  );
}

/* ======================================================================== *
 * §7.11b Weighted projections (deterministic fan)
 * ======================================================================== */

export function ProjectionsSection({
  projections,
  index,
}: {
  projections: Projections;
  index: number;
}) {
  if (projections.series.length === 0) {
    return (
      <SectionFrame id="projections" index={index} title="Weighted Projections">
        <div className="text-[11px] text-faint">
          Projections not applicable
          {projections.notApplicableReason ? `: ${projections.notApplicableReason}` : "."}
        </div>
      </SectionFrame>
    );
  }
  const weights = projections.scenarioWeights;
  const disclosures = projections.series.flatMap((s) => s.disclosures);
  return (
    <SectionFrame
      id="projections"
      index={index}
      title="Weighted Projections"
      right={
        <span className="mono text-[10px] text-faint">
          {projections.horizonYears}y · {Math.round(weights.bull * 100)}/{Math.round(weights.base * 100)}/
          {Math.round(weights.bear * 100)} bull/base/bear
        </span>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {projections.series.map((s) => (
          <div key={s.metric} className="border border-edge bg-bg p-2">
            <ProjectionFanChart series={s} />
          </div>
        ))}
      </div>
      {projections.series[0] && projections.series[0].assumptions.length > 0 && (
        <SubBlock label="method & assumptions">
          <ul className="flex flex-col gap-0.5">
            {projections.series[0].assumptions.map((a, i) => (
              <li key={i} className="text-[11px] leading-snug text-muted">· {a}</li>
            ))}
          </ul>
        </SubBlock>
      )}
      {disclosures.length > 0 && (
        <SubBlock label="disclosures">
          <div className="flex flex-col gap-1.5">
            {disclosures.map((d, i) => (
              <GapNotice key={i} entry={d} />
            ))}
          </div>
        </SubBlock>
      )}
      <p className="text-[10px] leading-snug text-faint">
        Forward figures are model ESTIMATEs (computed.projections.*), not facts. The weighted path uses a
        versioned, unbacktested display prior—not empirical outcome probabilities or a point prediction.
      </p>
    </SectionFrame>
  );
}

/* ======================================================================== *
 * §7.2 Business & segments
 * ======================================================================== */

function SegmentTable({
  rows,
  emptyLabel,
}: {
  rows: Business["segments"]["product"];
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <div className="text-[11px] text-faint">{emptyLabel}</div>;
  }
  // Share bars scaled to the max share so relative weight reads at a glance.
  const maxShare = Math.max(
    ...rows.map((r) => r.sharePct ?? 0),
    1,
  );
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="w-40 shrink-0 truncate text-[11px] text-fg" title={r.name}>
            {r.name}
          </div>
          <div className="w-28 shrink-0 text-right">
            <TracedFigure n={r.revenue} className="text-[11px]" />
          </div>
          <div className="min-w-0 flex-1">
            <ShareBar
              pct={r.sharePct === null ? null : (r.sharePct / maxShare) * 100}
              label={r.sharePct === null ? "n/a" : `${r.sharePct.toFixed(1)}%`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function BusinessSegments({
  business,
  index,
}: {
  business: Business;
  index: number;
}) {
  return (
    <SectionFrame id="business" index={index} title="Business & Segments">
      <SubBlock label="what they sell">
        <ClaimList claims={business.whatTheySell} />
      </SubBlock>
      <div className="grid gap-4 lg:grid-cols-2">
        <SubBlock label="revenue by product">
          <SegmentTable
            rows={business.segments.product}
            emptyLabel="no product segmentation reported"
          />
        </SubBlock>
        <SubBlock label="revenue by geography">
          <SegmentTable
            rows={business.segments.geographic}
            emptyLabel="no geographic segmentation reported"
          />
        </SubBlock>
      </div>
      <SubBlock label="concentration risks">
        <ClaimList claims={business.concentrationRisks} empty="none disclosed" />
      </SubBlock>
    </SectionFrame>
  );
}

/* ======================================================================== *
 * Shared: MetricRow tables (fundamentals)
 * ======================================================================== */

function MetricRowsTable({ rows }: { rows: readonly MetricRow[] }) {
  if (rows.length === 0) {
    return <div className="text-[11px] text-faint">no data</div>;
  }
  // Union of period labels across rows, in first-seen order.
  const periods: string[] = [];
  for (const row of rows) {
    for (const v of row.values) {
      if (!periods.includes(v.period)) periods.push(v.period);
    }
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-edge-strong">
            <th className="px-2 py-1 text-left text-[9px] uppercase tracking-[0.1em] text-faint">
              metric
            </th>
            {periods.map((p) => (
              <th
                key={p}
                className="px-2 py-1 text-right text-[9px] uppercase tracking-[0.1em] text-faint"
              >
                {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-edge last:border-b-0 hover:bg-raised">
              <td className="px-2 py-1 text-left text-muted">{row.label}</td>
              {periods.map((p) => {
                const cell = row.values.find((v) => v.period === p);
                return (
                  <td key={p} className="px-2 py-1 text-right">
                    {cell ? (
                      <TracedFigure n={cell.value} className="text-[11px]" />
                    ) : (
                      <span className="mono text-faint">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FundamentalsSection({
  fundamentals,
  index,
  openReasoning,
  chart,
}: {
  fundamentals: Fundamentals;
  index: number;
  openReasoning?: boolean;
  /** Optional fundamentals chart bundle (revenue/margin/FCF/shares) mounts here. */
  chart?: ReactNode;
}) {
  return (
    <SectionFrame id="fundamentals" index={index} title="Fundamentals">
      <GradeReasoning
        title="fundamentals"
        block={fundamentals.graded}
        defaultOpen={openReasoning}
      />
      {chart !== undefined && (
        <div className="border border-edge bg-bg">{chart}</div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <SubBlock label="growth">
          <MetricRowsTable rows={fundamentals.growthTable} />
        </SubBlock>
        <SubBlock label="margin trend">
          <MetricRowsTable rows={fundamentals.marginTrend} />
        </SubBlock>
        <SubBlock label="returns">
          <MetricRowsTable rows={fundamentals.returns} />
        </SubBlock>
        <SubBlock label="free cash flow">
          <MetricRowsTable rows={fundamentals.fcf} />
        </SubBlock>
      </div>
      <SubBlock label="commentary">
        <ClaimList claims={fundamentals.commentary} />
      </SubBlock>
    </SectionFrame>
  );
}

/* ======================================================================== *
 * §7.4 Balance sheet & capital
 * ======================================================================== */

function TracedNumberRow({ numbers }: { numbers: readonly TracedNumber[] }) {
  if (numbers.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {numbers.map((n, i) => (
        <TracedStat key={i} label={n.source.split(/[.:/]/).pop() ?? "value"} n={n} />
      ))}
    </div>
  );
}

export function BalanceSheetSection({
  balanceSheet,
  index,
}: {
  balanceSheet: BalanceSheet;
  index: number;
}) {
  const blocks: Array<{
    label: string;
    data: { commentary: readonly SourcedClaim[]; numbers: readonly TracedNumber[] };
  }> = [
    { label: "debt profile", data: balanceSheet.debtProfile },
    { label: "coverage", data: balanceSheet.coverage },
    { label: "capex trajectory", data: balanceSheet.capexTrajectory },
  ];
  return (
    <SectionFrame id="balanceSheet" index={index} title="Balance Sheet & Capital">
      {balanceSheet.graded && (
        <GradeReasoning title="balance sheet & capital" block={balanceSheet.graded} />
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        {blocks.map((b) => (
          <SubBlock key={b.label} label={b.label}>
            <TracedNumberRow numbers={b.data.numbers} />
            <div className="mt-1.5">
              <ClaimList claims={b.data.commentary} />
            </div>
          </SubBlock>
        ))}
      </div>
      <SubBlock label="capital allocation record">
        <ClaimList claims={balanceSheet.capitalAllocation} />
      </SubBlock>
    </SectionFrame>
  );
}

/* ======================================================================== *
 * §7.5 Valuation (graded)
 * ======================================================================== */

function SensitivityGrid({ dcf }: { dcf: Valuation["dcf"] }) {
  const cells = dcf.sensitivityGrid;
  if (cells.length === 0) {
    return <div className="text-[11px] text-faint">no sensitivity grid</div>;
  }
  // Highlight the middle (WACC, g) pair as the base case — the single shared
  // SensitivityHeatmap (src/components/charts) owns axis derivation + coloring.
  const waccs = [...new Set(cells.map((c) => c.waccPct))].sort((a, b) => a - b);
  const gs = [...new Set(cells.map((c) => c.gTermPct))].sort((a, b) => a - b);
  const baseWacc = waccs[Math.floor(waccs.length / 2)] ?? null;
  const baseG = gs[Math.floor(gs.length / 2)] ?? null;

  return (
    <SensitivityHeatmap cells={cells} baseWacc={baseWacc} baseG={baseG} />
  );
}

function MultiplesTable({ rows }: { rows: readonly MultipleRow[] }) {
  const cols: Column<MultipleRow>[] = [
    {
      key: "name",
      header: "multiple",
      render: (m) => <span className="mono text-muted">{m.name}</span>,
    },
    {
      key: "cur",
      header: "current",
      align: "right",
      render: (m) => <span className="mono">{formatMultiple(m.current)}</span>,
    },
    {
      key: "peer",
      header: "peer median",
      align: "right",
      render: (m) => (
        <span className="mono text-muted">{formatMultiple(m.peerMedian)}</span>
      ),
    },
    {
      key: "pct",
      header: "own 5y pct",
      align: "right",
      render: (m) =>
        m.own5yPercentile === null ? (
          <span className="mono text-faint">n/a</span>
        ) : (
          <div className="flex items-center justify-end gap-1.5">
            <div className="w-16">
              <ShareBar
                pct={m.own5yPercentile}
                tone={m.own5yPercentile >= 70 ? "warn" : "accent"}
                label={`${m.own5yPercentile.toFixed(0)}`}
              />
            </div>
          </div>
        ),
    },
    {
      key: "sector",
      header: "sector-appropriate",
      align: "center",
      render: (m) =>
        m.sectorAppropriate ? (
          <span className="mono text-pos">✓</span>
        ) : (
          <span className="mono text-faint">—</span>
        ),
    },
  ];
  return (
    <DataTable
      columns={cols}
      rows={rows}
      rowKey={(m) => m.name}
      empty="no multiples derivable"
    />
  );
}

export function ValuationSection({
  valuation,
  scenarioTargets,
  fairValue,
  index,
  openReasoning,
}: {
  valuation: Valuation;
  scenarioTargets?: ScenarioTargets;
  fairValue?: FairValue;
  index: number;
  openReasoning?: boolean;
}) {
  const { dcf, reverseDcf } = valuation;
  return (
    <SectionFrame id="valuation" index={index} title="Valuation">
      <GradeReasoning
        title="valuation"
        block={valuation.graded}
        defaultOpen={openReasoning}
      />

      {/* DCF headline + reverse-DCF callout */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex flex-col gap-2 border border-edge bg-raised px-3 py-2.5">
          <div className="text-[9px] uppercase tracking-[0.1em] text-faint">
            DCF · intrinsic value / share
          </div>
          {dcf.perShare ? (
            <TracedFigure n={dcf.perShare} tone="accent" className="text-[24px]" />
          ) : (
            // Deterministic fair value suppressed (no per-share model / insufficient
            // inputs) — show "unavailable", never a fabricated number.
            <span className="mono text-[15px] text-faint">unavailable</span>
          )}
          {dcf.perShare && dcf.upsidePct !== null && (
            <div className="mono text-[12px]">
              <span className="text-faint">vs price </span>
              <span className={dcf.upsidePct >= 0 ? "text-pos" : "text-neg"}>
                {formatPct(dcf.upsidePct, 1, true)}
              </span>
            </div>
          )}
          {fairValue ? (
            <p className="text-[10px] leading-snug text-faint">
              {fairValue.status === "available"
                ? fairValue.basis.join(" ")
                : `Intrinsic value per share suppressed — ${
                    fairValue.reasons.map((r) => r.reason).join("; ") || fairValue.basis.join(" ")
                  }`}
            </p>
          ) : null}
          <div className="mt-1 border-t border-edge pt-2">
            <div className="text-[9px] uppercase tracking-[0.1em] text-faint">
              reverse DCF — market is pricing
            </div>
            <div className="mono mt-0.5 text-[13px] text-warn">
              {reverseDcf.impliedValue === null
                ? "n/a"
                : `~${reverseDcf.impliedValue.toFixed(1)}% ${reverseDcf.impliedMetric}`}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted">
              {reverseDcf.narrative}
            </p>
          </div>
        </div>

        <SubBlock label="DCF assumptions">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-edge-strong">
                  <th className="px-2 py-1 text-left text-[9px] uppercase tracking-[0.1em] text-faint">
                    assumption
                  </th>
                  <th className="px-2 py-1 text-right text-[9px] uppercase tracking-[0.1em] text-faint">
                    value
                  </th>
                  <th className="px-2 py-1 text-left text-[9px] uppercase tracking-[0.1em] text-faint">
                    basis
                  </th>
                </tr>
              </thead>
              <tbody>
                {dcf.assumptions.map((a, i) => (
                  <tr
                    key={i}
                    className="border-b border-edge last:border-b-0 hover:bg-raised"
                  >
                    <td className="px-2 py-1 text-muted">{a.name}</td>
                    <td className="mono px-2 py-1 text-right text-fg">
                      {a.value}
                    </td>
                    <td className="px-2 py-1 text-[10px] text-faint">
                      {a.basis}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SubBlock>
      </div>

      <SubBlock label="sensitivity · per share (rows = WACC, cols = terminal g) — green high → red low">
        <SensitivityGrid dcf={dcf} />
      </SubBlock>

      <SubBlock label="multiples vs peers & own 5-yr history">
        <MultiplesTable rows={valuation.multiples} />
      </SubBlock>

      <SubBlock label="scenarios · probability-weighted (bull / base / bear)">
        <p className="mb-2 text-[11px] leading-snug text-faint">
          Narrative probabilities are model JUDGMENTs, not empirically calibrated odds. Data-only reports
          show them as unavailable.
        </p>
        {scenarioTargets ? (
          <p className="mb-2 text-[11px] leading-snug text-faint">
            {scenarioTargets.status === "available"
              ? `Price targets are computed-derived (${scenarioTargets.method}), not analyst targets. ${scenarioTargets.basis.join(" ")}`
              : `Scenario price targets suppressed — ${
                  scenarioTargets.missingReasons.map((m) => m.reason).join("; ") ||
                  scenarioTargets.basis.join(" ")
                }`}
          </p>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-3">
          {["bull", "base", "bear"].map((name) => {
            const s = valuation.scenarios.find((sc) => sc.name === name);
            if (!s) return null;
            return (
              <ScenarioCard
                key={name}
                name={s.name}
                probability={s.probability}
                priceTarget={s.priceTarget}
                horizon={s.horizon}
                assumptions={s.assumptions}
                whatWouldHaveToBeTrue={s.whatWouldHaveToBeTrue}
              />
            );
          })}
        </div>
      </SubBlock>
    </SectionFrame>
  );
}

/* ======================================================================== *
 * §7.6 Quality & red flags (graded)
 * ======================================================================== */

function zoneTone(zone: string | null): Tone {
  if (zone === null) return "muted";
  const z = zone.toLowerCase();
  if (z.includes("safe") || z.includes("strong") || z.includes("unlikely"))
    return "pos";
  if (z.includes("distress") || z.includes("manipulat") || z.includes("red"))
    return "neg";
  if (z.includes("grey") || z.includes("gray") || z.includes("caution"))
    return "warn";
  return "muted";
}

function ForensicCard({
  name,
  score,
  zone,
  variant,
  notApplicableReason,
}: {
  name: string;
  score: number | null;
  zone: string | null;
  variant: string;
  notApplicableReason?: string;
}) {
  const tone = zoneTone(zone);
  return (
    <div className="flex flex-col gap-1 border border-edge bg-raised px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="mono text-[10px] uppercase tracking-[0.1em] text-faint">
          {name}
        </span>
        <span className="text-[9px] text-faint">{variant}</span>
      </div>
      {notApplicableReason ? (
        <div className="text-[10px] leading-snug text-faint">
          {notApplicableReason}
        </div>
      ) : (
        <>
          <div className="mono text-[18px] text-fg">
            {score === null ? "n/a" : formatNumber(score, 2)}
          </div>
          {zone && <Badge tone={tone}>{zone}</Badge>}
        </>
      )}
    </div>
  );
}

const SEVERITY_TONE: Record<"high" | "medium" | "low", Tone> = {
  high: "neg",
  medium: "warn",
  low: "muted",
};

export function QualityFlags({
  quality,
  index,
  openReasoning,
}: {
  quality: Quality;
  index: number;
  openReasoning?: boolean;
}) {
  const f = quality.forensicScores;
  // Flags by severity (high → low).
  const order: Array<"high" | "medium" | "low"> = ["high", "medium", "low"];
  const sortedFlags = [...quality.flags].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity),
  );
  return (
    <SectionFrame id="quality" index={index} title="Quality & Red-Flags">
      <GradeReasoning
        title="quality / red-flags"
        block={quality.graded}
        defaultOpen={openReasoning}
      />
      <SubBlock label="forensic scores">
        <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-4">
          <ForensicCard
            name="Altman Z"
            score={f.altman.score}
            zone={f.altman.zone}
            variant={f.altman.variant}
            notApplicableReason={f.altman.notApplicableReason}
          />
          <ForensicCard
            name="Beneish M"
            score={f.beneish.score}
            zone={f.beneish.zone}
            variant={f.beneish.variant}
            notApplicableReason={f.beneish.notApplicableReason}
          />
          <ForensicCard
            name="Piotroski F"
            score={f.piotroski.score}
            zone={f.piotroski.zone}
            variant={f.piotroski.variant}
            notApplicableReason={f.piotroski.notApplicableReason}
          />
          <ForensicCard
            name="Accruals"
            score={f.accruals.score}
            zone={f.accruals.zone}
            variant={f.accruals.variant}
            notApplicableReason={f.accruals.notApplicableReason}
          />
        </div>
      </SubBlock>
      <SubBlock label={`plain-english flags (${sortedFlags.length})`}>
        {sortedFlags.length === 0 ? (
          <div className="text-[11px] text-faint">no flags raised.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {sortedFlags.map((flag, i) => (
              <div
                key={i}
                className="flex items-start gap-2 border border-edge bg-raised px-2 py-1.5"
              >
                <Badge tone={SEVERITY_TONE[flag.severity]}>
                  {flag.severity}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] leading-snug text-fg">{flag.text}</p>
                  <span className="mono text-[9px] text-faint">
                    {flag.source}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </SubBlock>
    </SectionFrame>
  );
}

/* ======================================================================== *
 * §7.7 Technicals (graded) — accepts a chart slot
 * ======================================================================== */

export function TechnicalsSection({
  technicals,
  index,
  openReasoning,
  chart,
}: {
  technicals: Technicals;
  index: number;
  openReasoning?: boolean;
  /** Chart mounts here (a client chart passed by the caller). */
  chart?: ReactNode;
}) {
  const read = technicals.read;
  const readRows: Array<{ label: string; value: string }> = [
    { label: "trend", value: read.trend },
    { label: "momentum", value: read.momentum },
    { label: "key levels", value: read.keyLevels },
    { label: "relative strength", value: read.relativeStrength },
  ];
  return (
    <SectionFrame id="technicals" index={index} title="Technicals">
      <GradeReasoning
        title="technicals"
        block={technicals.graded}
        defaultOpen={openReasoning}
      />

      {chart !== undefined && (
        <div className="border border-edge bg-bg">{chart}</div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <SubBlock label="structured read">
          <div className="flex flex-col gap-1.5">
            {readRows.map((r) => (
              <div key={r.label} className="flex items-baseline gap-2">
                <span className="w-28 shrink-0 text-[10px] uppercase tracking-[0.08em] text-faint">
                  {r.label}
                </span>
                <span className="text-[11px] leading-snug text-fg">
                  {r.value}
                </span>
              </div>
            ))}
          </div>
        </SubBlock>
        <SubBlock label="indicators">
          <div className="flex flex-wrap gap-1.5">
            {technicals.indicators.map((n, i) => (
              <TracedStat
                key={i}
                label={n.source.split(/[.:/]/).pop() ?? "ind"}
                n={n}
              />
            ))}
          </div>
        </SubBlock>
      </div>

      {technicals.flags.length > 0 && (
        <SubBlock label="flags">
          <div className="flex flex-col gap-1.5">
            {technicals.flags.map((flag, i) => (
              <div
                key={i}
                className="flex items-start gap-2 border border-edge bg-raised px-2 py-1.5"
              >
                <Badge tone={SEVERITY_TONE[flag.severity]}>{flag.severity}</Badge>
                <span className="text-[11px] leading-snug text-fg">
                  {flag.text}
                </span>
              </div>
            ))}
          </div>
        </SubBlock>
      )}
    </SectionFrame>
  );
}

/* ======================================================================== *
 * §7.8 Leadership & governance (graded)
 * ======================================================================== */

function ExecutiveCard({ exec }: { exec: Executive }) {
  const evidenceGroups: Array<{ label: string; claims?: readonly SourcedClaim[] }> = [
    { label: "guidance vs actuals", claims: exec.evidence.guidanceVsActuals },
    { label: "capital allocation", claims: exec.evidence.capitalAllocation },
    { label: "insider activity", claims: exec.evidence.insiderActivity },
    { label: "compensation", claims: exec.evidence.compensation },
  ].filter((g) => g.claims && g.claims.length > 0);

  return (
    <div className="flex flex-col border border-edge bg-raised">
      <div className="flex items-center justify-between gap-2 border-b border-edge px-2.5 py-1.5">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-fg">
            {exec.name}
          </div>
          <div className="truncate text-[10px] text-faint">
            {exec.title}
            {exec.tenureYears !== null
              ? ` · ${exec.tenureYears.toFixed(0)}y tenure`
              : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-[8px] uppercase tracking-[0.1em] text-faint">
              grade
            </span>
            <GradeChip grade={exec.grade} />
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-[8px] uppercase tracking-[0.1em] text-faint">
              cred
            </span>
            <GradeChip grade={exec.credibilityGrade} />
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2 px-2.5 py-2">
        <ClaimList claims={exec.reasoning} />
        {evidenceGroups.map((g) => (
          <SubBlock key={g.label} label={g.label}>
            <ClaimList claims={g.claims ?? []} />
          </SubBlock>
        ))}
      </div>
    </div>
  );
}

export function LeadershipSection({
  leadership,
  index,
  openReasoning,
}: {
  leadership: Leadership;
  index: number;
  openReasoning?: boolean;
}) {
  return (
    <SectionFrame id="leadership" index={index} title="Leadership & Governance">
      <GradeReasoning
        title="leadership"
        block={leadership.graded}
        defaultOpen={openReasoning}
      />
      <SubBlock label={`executives (${leadership.executives.length})`}>
        <div className="grid gap-3 lg:grid-cols-2">
          {leadership.executives.map((exec, i) => (
            <ExecutiveCard key={i} exec={exec} />
          ))}
        </div>
      </SubBlock>
      <div className="grid gap-4 lg:grid-cols-2">
        <SubBlock label="insider activity">
          <ClaimList claims={leadership.insiderSummary} empty="no insider data" />
        </SubBlock>
        <SubBlock label="board / comp notes">
          <ClaimList claims={leadership.governanceNotes} empty="none" />
        </SubBlock>
      </div>
    </SectionFrame>
  );
}

/* ======================================================================== *
 * §7.9 Competitive landscape (Moat graded)
 * ======================================================================== */

const MOAT_STRENGTH_TONE: Record<"none" | "narrow" | "wide", Tone> = {
  none: "muted",
  narrow: "warn",
  wide: "pos",
};

const MOAT_SOURCE_LABEL: Record<MoatAssessment["source"], string> = {
  switchingCosts: "switching costs",
  networkEffects: "network effects",
  scale: "scale",
  brand: "brand",
  ip: "IP",
};

function PeerTable({ peers }: { peers: Competitive["peerTable"] }) {
  if (peers.length === 0) {
    return <div className="text-[11px] text-faint">no peers resolved</div>;
  }
  // Union of metric labels (by source suffix) across peers.
  const metricKeys: string[] = [];
  for (const p of peers) {
    for (const m of p.metrics) {
      const key = m.source.split(/[.:/]/).pop() ?? m.unit;
      if (!metricKeys.includes(key)) metricKeys.push(key);
    }
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-edge-strong">
            <th className="px-2 py-1 text-left text-[9px] uppercase tracking-[0.1em] text-faint">
              peer
            </th>
            {metricKeys.map((k) => (
              <th key={k} className="px-2 py-1 text-right text-[9px] text-faint">
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {peers.map((p, i) => (
            <tr
              key={i}
              className="border-b border-edge last:border-b-0 hover:bg-raised"
            >
              <td className="px-2 py-1 text-left">
                <span className="text-fg">{p.name}</span>
                {p.symbol && (
                  <span className="mono ml-1 text-[9px] text-faint">
                    {p.symbol}
                  </span>
                )}
              </td>
              {metricKeys.map((k) => {
                const m = p.metrics.find(
                  (mm) => (mm.source.split(/[.:/]/).pop() ?? mm.unit) === k,
                );
                return (
                  <td key={k} className="px-2 py-1 text-right">
                    {m ? (
                      <TracedFigure n={m} className="text-[11px]" />
                    ) : (
                      <span className="mono text-faint">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CompetitiveSection({
  competitive,
  index,
  openReasoning,
}: {
  competitive: Competitive;
  index: number;
  openReasoning?: boolean;
}) {
  return (
    <SectionFrame id="competitive" index={index} title="Competitive · Moat">
      <GradeReasoning
        title="moat"
        block={competitive.moatGraded}
        defaultOpen={openReasoning}
      />
      <SubBlock label="moat sources">
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {competitive.moatAssessment.map((m, i) => (
            <div
              key={i}
              className="flex flex-col gap-1 border border-edge bg-raised px-2.5 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-fg">
                  {MOAT_SOURCE_LABEL[m.source]}
                </span>
                <Badge tone={MOAT_STRENGTH_TONE[m.strength]}>{m.strength}</Badge>
              </div>
              <ClaimList claims={m.reasoning} />
            </div>
          ))}
        </div>
      </SubBlock>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <SubBlock label="peer table">
          <PeerTable peers={competitive.peerTable} />
        </SubBlock>
        <SubBlock label="market-share direction">
          <p className="text-[11px] leading-snug text-fg">
            {competitive.marketShareDirection}
          </p>
        </SubBlock>
      </div>
    </SectionFrame>
  );
}

/* ======================================================================== *
 * §7.10 Catalysts & Risks — PROMINENT
 * ======================================================================== */

const DIRECTION_META: Record<
  "positive" | "negative" | "mixed",
  { glyph: string; tone: Tone }
> = {
  positive: { glyph: "▲", tone: "pos" },
  negative: { glyph: "▼", tone: "neg" },
  mixed: { glyph: "◆", tone: "warn" },
};

const SIGNIFICANCE_TONE: Record<"high" | "medium" | "low", Tone> = {
  high: "accent",
  medium: "muted",
  low: "muted",
};

/**
 * The Catalysts & Risks panel — SPEC §8 requires it be VISUALLY PROMINENT.
 * Rendered with a strong accent border and pinned near the top of the report
 * (ReportView places it above the numbered sections). Catalysts are a dated
 * timeline with direction arrows + significance; risks are placed on a
 * severity × probability matrix and also listed with their sources.
 */
export function CatalystsRisksPanel({
  catalystsRisks,
  index,
}: {
  catalystsRisks: CatalystsRisks;
  index?: number;
}) {
  const { catalysts, risks } = catalystsRisks;
  const matrixItems: MatrixItem[] = risks.map((r) => ({
    title: r.title,
    severity: r.severity,
    probability: r.probability,
  }));
  const sortedCatalysts = [...catalysts].sort((a, b) => {
    // Undated last; otherwise ascending by expected date.
    if (a.expectedDate === null && b.expectedDate === null) return 0;
    if (a.expectedDate === null) return 1;
    if (b.expectedDate === null) return -1;
    return a.expectedDate.localeCompare(b.expectedDate);
  });

  return (
    <section
      id={sectionAnchorId("catalystsRisks")}
      className="scroll-mt-28 border-2 border-accent/50 bg-panel shadow-[0_0_0_1px_rgba(59,167,245,0.08)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-accent/40 bg-accent/5 px-3 py-2">
        <div className="flex items-baseline gap-2">
          {index !== undefined && (
            <span className="mono text-[10px] text-accent">
              {String(index).padStart(2, "0")}
            </span>
          )}
          <h2 className="mono text-[12px] font-semibold uppercase tracking-[0.14em] text-accent">
            Catalysts &amp; Risks
          </h2>
        </div>
        <span className="mono text-[10px] text-muted">
          {catalysts.length} catalysts · {risks.length} risks
        </span>
      </div>

      <div className="grid gap-4 px-3 py-3 lg:grid-cols-2">
        {/* Catalysts timeline */}
        <div className="flex flex-col gap-2">
          <div className="text-[9px] uppercase tracking-[0.12em] text-faint">
            catalysts · dated
          </div>
          {sortedCatalysts.length === 0 ? (
            <div className="text-[11px] text-faint">none identified</div>
          ) : (
            <ol className="flex flex-col">
              {sortedCatalysts.map((c, i) => {
                const dir = DIRECTION_META[c.direction];
                return (
                  <li
                    key={i}
                    className="flex items-start gap-2 border-l-2 py-1.5 pl-2.5"
                    style={{
                      borderColor:
                        dir.tone === "pos"
                          ? "var(--pos)"
                          : dir.tone === "neg"
                            ? "var(--neg)"
                            : "var(--warn)",
                    }}
                  >
                    <span
                      className={`mono mt-px shrink-0 text-[12px] ${
                        dir.tone === "pos"
                          ? "text-pos"
                          : dir.tone === "neg"
                            ? "text-neg"
                            : "text-warn"
                      }`}
                    >
                      {dir.glyph}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[12px] font-medium text-fg">
                          {c.title}
                        </span>
                        <Badge tone={SIGNIFICANCE_TONE[c.significance]}>
                          {c.significance}
                        </Badge>
                      </div>
                      <div className="mono text-[10px] text-faint">
                        {c.expectedDate ?? "date TBD"}
                      </div>
                      <div className="mt-1">
                        <ClaimList claims={[c.reasoning]} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {/* Risks matrix + list */}
        <div className="flex flex-col gap-2">
          <div className="text-[9px] uppercase tracking-[0.12em] text-faint">
            risks · severity × probability
          </div>
          <SeverityProbMatrix items={matrixItems} />
          <div className="mt-1 flex flex-col gap-1.5">
            {risks.map((r, i) => (
              <div
                key={i}
                className="flex items-start gap-2 border border-edge bg-raised px-2 py-1.5"
              >
                <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] font-medium text-fg">
                      {r.title}
                    </span>
                    <span className="text-[9px] uppercase tracking-[0.08em] text-faint">
                      p·{r.probability}
                    </span>
                  </div>
                  <div className="mt-0.5">
                    <ClaimList claims={[r.reasoning]} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ======================================================================== *
 * §7.11 Future outlook
 * ======================================================================== */

export function OutlookSection({
  outlook,
  index,
}: {
  outlook: Outlook;
  index: number;
}) {
  const horizons: Array<{ label: string; claims: readonly SourcedClaim[] }> = [
    { label: "1-year", claims: outlook.scenarioNarratives.y1 },
    { label: "3-year", claims: outlook.scenarioNarratives.y3 },
    { label: "5-year", claims: outlook.scenarioNarratives.y5 },
  ];
  return (
    <SectionFrame id="outlook" index={index} title="Future Outlook">
      <SubBlock label="scenario narratives">
        <div className="grid gap-3 lg:grid-cols-3">
          {horizons.map((h) => (
            <div
              key={h.label}
              className="flex flex-col gap-2 border border-edge bg-raised px-2.5 py-2"
            >
              <div className="mono text-[10px] uppercase tracking-[0.1em] text-accent">
                {h.label}
              </div>
              <ClaimList claims={h.claims} />
            </div>
          ))}
        </div>
      </SubBlock>
      <div className="grid gap-4 lg:grid-cols-2">
        <SubBlock label="segment trajectories">
          <ClaimList claims={outlook.segmentTrajectories} />
        </SubBlock>
        {outlook.tam && outlook.tam.length > 0 && (
          <SubBlock label="TAM">
            <ClaimList claims={outlook.tam} />
          </SubBlock>
        )}
        <SubBlock label="estimate-revision trend">
          <ClaimList claims={outlook.estimateRevisionTrend} />
        </SubBlock>
        <SubBlock label="guidance credibility">
          <ClaimList claims={outlook.guidanceCredibility} />
        </SubBlock>
      </div>
    </SectionFrame>
  );
}

/* ======================================================================== *
 * §7.12 Macro context
 * ======================================================================== */

export function MacroSection({ macro, index }: { macro: Macro; index: number }) {
  const cols: Column<Macro["relevantSeries"][number]>[] = [
    {
      key: "id",
      header: "series",
      render: (s) => <span className="mono text-muted">{s.seriesId}</span>,
    },
    {
      key: "name",
      header: "name",
      render: (s) => <span className="text-fg">{s.name}</span>,
    },
    {
      key: "latest",
      header: "latest",
      align: "right",
      render: (s) => <TracedFigure n={s.latest} className="text-[11px]" />,
    },
    {
      key: "rel",
      header: "relevance",
      render: (s) => (
        <span className="text-[10px] leading-snug text-muted">{s.relevance}</span>
      ),
    },
  ];
  return (
    <SectionFrame id="macro" index={index} title="Macro Context">
      <SubBlock label="relevant FRED series">
        <DataTable
          columns={cols}
          rows={macro.relevantSeries}
          rowKey={(s) => s.seriesId}
          empty="no macro series mapped"
        />
      </SubBlock>
      <SubBlock label="rate / cycle / FX sensitivity">
        <ClaimList claims={macro.sensitivityNotes} />
      </SubBlock>
      <p className="mono border-t border-edge pt-2 text-[9px] leading-snug text-faint">
        {macro.fredAttribution}
      </p>
    </SectionFrame>
  );
}

/* ======================================================================== *
 * §7.13 Appendix
 * ======================================================================== */

function DisagreementsBlock({
  disagreements,
}: {
  disagreements: readonly Disagreement[];
}) {
  if (disagreements.length === 0) return null;
  return (
    <SubBlock label={`bull/bear disagreements (${disagreements.length})`}>
      <div className="flex flex-col gap-2">
        {disagreements.map((d, i) => (
          <div key={i} className="border border-edge bg-raised px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-fg">{d.topic}</span>
              <Badge tone={d.kind === "fact" ? "accent" : "muted"}>
                {d.kind}
              </Badge>
            </div>
            <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
              <div className="border-l-2 border-pos/50 pl-2">
                <div className="text-[8px] uppercase tracking-[0.1em] text-pos">
                  bull view
                </div>
                <p className="text-[11px] leading-snug text-muted">
                  {d.bullView}
                </p>
              </div>
              <div className="border-l-2 border-neg/50 pl-2">
                <div className="text-[8px] uppercase tracking-[0.1em] text-neg">
                  bear view
                </div>
                <p className="text-[11px] leading-snug text-muted">
                  {d.bearView}
                </p>
              </div>
            </div>
            <div className="mt-1.5 border-t border-edge pt-1.5">
              <div className="text-[8px] uppercase tracking-[0.1em] text-faint">
                judge resolution
              </div>
              <p className="text-[11px] leading-snug text-fg">
                {d.judgeResolution}
              </p>
            </div>
          </div>
        ))}
      </div>
    </SubBlock>
  );
}

export function AppendixSection({
  appendix,
  disagreements,
  index,
}: {
  appendix: Appendix;
  disagreements: readonly Disagreement[];
  index: number;
}) {
  const sourceCols: Column<Appendix["sources"][number]>[] = [
    {
      key: "prov",
      header: "provider",
      render: (s) => <span className="mono text-fg">{s.provider}</span>,
    },
    {
      key: "ep",
      header: "endpoint",
      render: (s) => (
        <span className="mono break-all text-[10px] text-muted">
          {s.endpoint}
        </span>
      ),
    },
    {
      key: "asof",
      header: "as of",
      align: "right",
      render: (s) => <span className="mono text-[10px] text-faint">{s.asOf}</span>,
    },
    {
      key: "fetched",
      header: "fetched",
      align: "right",
      render: (s) => (
        <span className="mono text-[10px] text-faint">
          {s.fetchedAt.replace("T", " ").slice(0, 16)}
        </span>
      ),
    },
  ];

  const costCols: Column<Appendix["costBreakdown"][number]>[] = [
    {
      key: "step",
      header: "step",
      render: (c) => <span className="mono text-muted">{c.step}</span>,
    },
    {
      key: "model",
      header: "model",
      render: (c) => <span className="mono text-[10px] text-faint">{c.model}</span>,
    },
    {
      key: "cost",
      header: "cost",
      align: "right",
      render: (c) => (
        <span className="mono text-fg">{formatCostUsd(c.costUsd)}</span>
      ),
    },
  ];
  const totalCost = roundedDisplayedCostTotal(appendix.costBreakdown.map((entry) => entry.costUsd));
  const rate = appendix.verificationRate;
  const provenance = appendix.provenanceCoverage;
  const log = appendix.verificationLog ?? [];
  const verifiedCount = log.filter((l) => l.outcome === "verified").length;
  const coverageValue = (
    supported: number,
    total: number,
    itemRate: number | null,
  ): string =>
    `${supported}/${total} (${
      itemRate === null ? "n/a — no items" : `${(itemRate * 100).toFixed(1)}%`
    })`;

  return (
    <SectionFrame
      id="appendix"
      index={index}
      title="Appendix"
      right={
        <span
          className="mono text-[11px] text-muted"
          title="Citation coverage: share of report figures traceable to a citation or payload value — a provenance check, not a correctness/accuracy check."
        >
          cited{" "}
          <span className="text-fg">
            {rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`}
          </span>{" "}
          · <span className="text-fg">{formatCostUsd(totalCost)}</span>
        </span>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <SubBlock label={`sources (${appendix.sources.length})`}>
          <DataTable
            columns={sourceCols}
            rows={appendix.sources}
            rowKey={(s, i) => `${s.provider}-${i}`}
            empty="no sources logged"
          />
        </SubBlock>
        <SubBlock label="per-report cost">
          <DataTable
            columns={costCols}
            rows={appendix.costBreakdown}
            rowKey={(c, i) => `${c.step}-${i}`}
            empty="no cost breakdown"
          />
        </SubBlock>
      </div>

      {provenance && (
        <SubBlock label="provenance coverage (support, not correctness)">
          <div className="grid gap-2 text-[11px] sm:grid-cols-3">
            <div>
              <span className="text-faint">numeric provenance</span>{" "}
              <span className="mono text-muted">
                {coverageValue(
                  provenance.numeric.supported,
                  provenance.numeric.total,
                  provenance.numeric.rate,
                )}
              </span>
            </div>
            <div>
              <span className="text-faint">factual-claim citations</span>{" "}
              <span className="mono text-muted">
                {coverageValue(
                  provenance.factualClaims.supported,
                  provenance.factualClaims.total,
                  provenance.factualClaims.rate,
                )}
              </span>
            </div>
            <div>
              <span className="text-faint">judgment citations</span>{" "}
              <span className="mono text-muted">
                {coverageValue(
                  provenance.judgments.cited,
                  provenance.judgments.total,
                  provenance.judgments.rate,
                )}
              </span>
            </div>
          </div>
        </SubBlock>
      )}

      <SubBlock
        label={(() => {
          const expected = appendix.missingData.filter((m) => m.expected === true).length;
          const unexpected = appendix.missingData.length - expected;
          return `missing-data manifest (${unexpected}${expected > 0 ? ` + ${expected} expected` : ""})`;
        })()}
      >
        {appendix.missingData.length === 0 ? (
          <div className="text-[11px] text-faint">
            no gaps — full data coverage.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {appendix.missingData.map((m, i) => (
              <GapNotice key={`${m.field}-${i}`} entry={m} />
            ))}
          </div>
        )}
      </SubBlock>

      {log.length > 0 && (
        <SubBlock
          label={`citation-coverage log (${verifiedCount}/${log.length} cited)`}
        >
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full border-collapse text-[11px]">
              <tbody>
                {log.map((l, i) => {
                  const tone: Tone =
                    l.outcome === "verified"
                      ? "pos"
                      : l.outcome === "removed"
                        ? "neg"
                        : "warn";
                  return (
                    <tr key={i} className="border-b border-edge last:border-b-0">
                      <td className="px-2 py-1 align-top">
                        <Badge tone={tone}>{citationOutcomeLabel(l.outcome)}</Badge>
                      </td>
                      <td className="px-2 py-1 text-[10px] leading-snug text-muted">
                        {formatVerificationClaim(l.claim)}
                        {l.note && (
                          <span className="text-faint"> — {l.note}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SubBlock>
      )}

      <DisagreementsBlock disagreements={disagreements} />
    </SectionFrame>
  );
}

/* ======================================================================== *
 * Meta strip — symbol / company / model / generated / cost
 * ======================================================================== */

export function ReportMetaStrip({ report }: { report: Report }) {
  const m = report.meta;
  const displayedCost = roundedDisplayedCostTotal(
    report.appendix.costBreakdown.map((entry) => entry.costUsd),
  );
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border border-edge bg-panel px-3 py-2">
      <div className="flex items-baseline gap-3">
        <span className="mono text-[20px] font-semibold tracking-[0.06em] text-fg">
          {m.symbol}
        </span>
        <span className="text-[13px] text-muted">{m.companyName}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-faint">
        <span>
          model <span className="mono text-muted">{m.model}</span>
        </span>
        {m.execution && (
          <span title={m.execution.map((entry) => `${entry.step}: requested ${entry.requestedModel}/${entry.requestedEffort ?? "n/a"}; effective ${entry.effectiveModel}/${entry.effectiveEffort ?? "n/a"}${entry.adjustments.length ? ` (${entry.adjustments.join(", ")})` : ""}`).join("\n")}>
            passes <span className="mono text-muted">{m.execution.map((entry) => `${entry.step}:${entry.effectiveModel.replace(/^claude-/, "")}`).join(" · ")}</span>
          </span>
        )}
        <span>
          cost{" "}
          <span className="mono text-muted">{formatCostUsd(displayedCost)}</span>
        </span>
        <span title="Citation coverage: share of figures traceable to a citation or payload value — provenance, not correctness.">
          cited{" "}
          <span className="mono text-muted">
            {m.verificationRate === null
              ? "n/a"
              : `${(m.verificationRate * 100).toFixed(1)}%`}
          </span>
        </span>
        <span>
          generated{" "}
          <span className="mono text-muted">
            {m.generatedAt.replace("T", " ").slice(0, 19)}Z
          </span>
        </span>
        <span className="mono">spec {m.specVersion}</span>
        {m.dataCompleteness && m.dataCompleteness.state !== "complete" && (
          <span
            className={m.dataCompleteness.state === "blocked" ? "font-semibold text-red-500" : "font-semibold text-amber-500"}
            title="Critical provider gaps make dependent forensic conclusions provisional."
          >
            data {m.dataCompleteness.state}; forensics {m.dataCompleteness.forensicValidation}
          </span>
        )}
      </div>
    </div>
  );
}

/** Re-export the grade type so callers can annotate without a second import. */
export type { Grade, GradeBlock };
