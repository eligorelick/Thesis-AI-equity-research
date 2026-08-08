import type { ReactNode } from "react";

import { Badge, Panel } from "@/components/ui";
import type {
  CompositeWeightChange,
  CostChange,
  DiffComparison,
  DiffReasonCode,
  DriverChange,
  GradeChange,
  ProjectionChange,
  ReportDiff,
  ScoreChange,
  TargetChange,
  TextTransition,
  TracedValueSnapshot,
  TransitionKind,
  VerdictChange,
} from "@/report/diff";

const SECTION_LABELS: Record<string, string> = {
  composite: "Composite",
  fundamentals: "Fundamentals",
  valuation: "Valuation",
  technicals: "Technicals",
  quality: "Quality",
  balanceSheet: "Balance Sheet",
  leadership: "Leadership",
  moat: "Moat",
};

const METRIC_LABELS: Record<string, string> = {
  revenue: "Revenue",
  operatingMargin: "Operating margin",
  fcf: "FCF",
  epsDiluted: "EPS diluted",
};

const REASON_LABELS: Record<DiffReasonCode, string> = {
  "invalid-entity": "A report entity identifier is invalid",
  "entity-mismatch": "Reports belong to different entities",
  "missing-from-report-version": "Source report pipeline version is missing",
  "missing-to-report-version": "Target report pipeline version is missing",
  "from-report-version-conflict":
    "Source report pipeline version conflicts with embedded metadata",
  "to-report-version-conflict":
    "Target report pipeline version conflicts with embedded metadata",
  "report-version-mismatch": "Report pipeline versions differ",
  "missing-from-spec-version": "Source persisted spec version is missing",
  "missing-to-spec-version": "Target persisted spec version is missing",
  "from-spec-metadata-conflict":
    "Source persisted spec version conflicts with embedded metadata",
  "to-spec-metadata-conflict":
    "Target persisted spec version conflicts with embedded metadata",
  "spec-version-mismatch": "Persisted report spec versions differ",
  "duplicate-driver-identity": "Duplicate score-driver identity",
  "duplicate-target-identity": "Duplicate scenario-target identity",
  "duplicate-projection-identity": "Duplicate projection identity",
  "projection-period-conflict": "Projection point period conflicts with its series",
  "unit-mismatch": "Units are not comparable",
  "currency-mismatch": "Currencies are not comparable",
  "period-mismatch": "Periods are not comparable",
};

type Direction = "positive" | "negative" | "neutral";

function transitionLabel(transition: TransitionKind): string {
  return transition.replaceAll("-", " ");
}

function comparisonLabel(comparison: DiffComparison["comparison"]): string {
  return comparison.replaceAll("-", " ");
}

function displayVersion(version: string | null): string {
  return version !== null && version.trim().length > 0 ? version : "unknown";
}

function formatNumber(value: number | null, precision?: number): string {
  if (value === null) return "unavailable";
  return precision === undefined ? String(value) : value.toFixed(precision);
}

function missingEndpoint(
  side: "from" | "to",
  transition: TransitionKind,
): string {
  if (transition === "added" && side === "from") return "absent";
  if (transition === "removed" && side === "to") return "absent";
  return "unavailable";
}

function formatTrace(
  trace: TracedValueSnapshot | null,
  side: "from" | "to",
  transition: TransitionKind,
): string {
  if (trace === null) return missingEndpoint(side, transition);
  const parts = [formatNumber(trace.value)];
  if (trace.unit) parts.push(trace.unit);
  if (trace.currency) parts.push(trace.currency);
  if (trace.period) parts.push(trace.period);
  if (trace.seriesUnit && trace.seriesUnit !== trace.unit) {
    parts.push("series " + trace.seriesUnit);
  }
  if (trace.sourceId) parts.push(trace.sourceId);
  if (trace.source) parts.push(trace.source);
  if (trace.asOf) parts.push(trace.asOf);
  parts.push(
    trace.verified === true
      ? "cited"
      : trace.verified === false
        ? "uncited"
        : "citation unknown",
  );
  if (trace.verificationNote) parts.push(trace.verificationNote);
  return parts.join(" | ");
}

function numericDirection(
  from: number | null,
  to: number | null,
): Direction {
  if (from === null || to === null || from === to) return "neutral";
  return to > from ? "positive" : "negative";
}

const GRADE_ORDER = { A: 0, B: 1, C: 2, D: 3, F: 4 } as const;

function gradeDirection(change: GradeChange): Direction {
  if (change.from === null || change.to === null) return "neutral";
  if (GRADE_ORDER[change.to] < GRADE_ORDER[change.from]) return "positive";
  if (GRADE_ORDER[change.to] > GRADE_ORDER[change.from]) return "negative";
  return "neutral";
}

function scoreDirection(change: ScoreChange): Direction {
  if (change.fromValue !== change.toValue) {
    return numericDirection(change.fromValue, change.toValue);
  }
  if (change.fromBand === null || change.toBand === null) return "neutral";
  if (GRADE_ORDER[change.toBand] < GRADE_ORDER[change.fromBand]) return "positive";
  if (GRADE_ORDER[change.toBand] > GRADE_ORDER[change.fromBand]) return "negative";
  return "neutral";
}

function ReasonList({ reasons }: { reasons: readonly DiffReasonCode[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 border border-warn/40 bg-warn/10 px-2 py-1.5">
      {reasons.map((reason) => (
        <li key={reason} className="text-[11px] text-warn">
          {REASON_LABELS[reason]}
        </li>
      ))}
    </ul>
  );
}

function TransitionRow({
  transition,
  comparison,
  identity,
  from,
  to,
  detail,
  direction = "neutral",
  identityKey,
}: {
  transition: TransitionKind;
  comparison: DiffComparison["comparison"];
  identity: ReactNode;
  from: ReactNode;
  to: ReactNode;
  detail?: ReactNode;
  direction?: Direction;
  identityKey?: string;
}) {
  const effectiveDirection =
    transition === "changed" && comparison === "comparable"
      ? direction
      : "neutral";
  const tone =
    effectiveDirection === "positive"
      ? "text-pos"
      : effectiveDirection === "negative"
        ? "text-neg"
        : "text-fg";
  return (
    <div
      data-transition={transition}
      data-comparison={comparison}
      data-direction={effectiveDirection}
      data-identity={identityKey}
      className="flex flex-wrap items-center gap-2 border border-edge bg-raised px-2.5 py-1.5 text-muted"
    >
      <span className="mono min-w-28 text-[10px] uppercase tracking-[0.06em] text-muted">
        {identity}
      </span>
      <span className="mono text-[10px] text-faint">
        {transitionLabel(transition)}
      </span>
      <span className="mono text-[10px] text-faint">
        {comparisonLabel(comparison)}
      </span>
      <span className="mono text-[11px] text-muted">{from}</span>
      <span className="mono text-[10px] text-faint">to</span>
      <span className={"mono text-[11px] " + tone}>{to}</span>
      {detail === undefined ? null : (
        <span className={"mono ml-auto text-[10px] " + tone}>{detail}</span>
      )}
    </div>
  );
}

function EmptyFamily({
  comparison,
}: {
  comparison: DiffComparison["comparison"];
}) {
  return (
    <div className="text-[11px] text-faint">
      {comparison === "not-comparable"
        ? "No comparable transition is available for this family."
        : "No transitions."}
    </div>
  );
}

function FamilyPanel({
  title,
  comparison,
  children,
}: {
  title: string;
  comparison: DiffComparison;
  children: ReactNode;
}) {
  return (
    <div data-family={title} data-comparison={comparison.comparison}>
      <Panel
        title={title}
        right={
          <span className="mono text-[9px] uppercase">
            {comparisonLabel(comparison.comparison)}
          </span>
        }
      >
        <div className="flex flex-col gap-1.5">
          <ReasonList reasons={comparison.reasons} />
          {children}
        </div>
      </Panel>
    </div>
  );
}

function gradeRow(change: GradeChange) {
  return (
    <TransitionRow
      key={change.section}
      transition={change.transition}
      comparison={change.comparison}
      identity={SECTION_LABELS[change.section]}
      from={change.from ?? missingEndpoint("from", change.transition)}
      to={change.to ?? missingEndpoint("to", change.transition)}
      direction={gradeDirection(change)}
    />
  );
}

function scoreRow(change: ScoreChange) {
  const from =
    change.from === null
      ? missingEndpoint("from", change.transition)
      : formatNumber(change.fromValue, 2) +
        (change.fromBand === null ? "" : " " + change.fromBand);
  const to =
    change.to === null
      ? missingEndpoint("to", change.transition)
      : formatNumber(change.toValue, 2) +
        (change.toBand === null ? "" : " " + change.toBand);
  return (
    <TransitionRow
      key={change.aspect}
      transition={change.transition}
      comparison={change.comparison}
      identity={SECTION_LABELS[change.aspect]}
      from={from}
      to={to}
      direction={scoreDirection(change)}
    />
  );
}

function weightRow(change: CompositeWeightChange) {
  return (
    <TransitionRow
      key={change.aspect}
      transition={change.transition}
      comparison={change.comparison}
      identity={SECTION_LABELS[change.aspect]}
      from={
        change.fromValue === null
          ? missingEndpoint("from", change.transition)
          : formatNumber(change.fromValue)
      }
      to={
        change.toValue === null
          ? missingEndpoint("to", change.transition)
          : formatNumber(change.toValue)
      }
    />
  );
}

function driverRow(change: DriverChange, index: number) {
  return (
    <TransitionRow
      key={
        change.aspect +
        "|" +
        change.sourceKey +
        "|" +
        change.unit +
        "|" +
        change.period +
        "|" +
        index
      }
      transition={change.transition}
      comparison={change.comparison}
      identity={
        SECTION_LABELS[change.aspect] +
        " | " +
        change.sourceKey +
        " | " +
        change.unit +
        (change.period ? " | " + change.period : "")
      }
      from={formatTrace(change.from, "from", change.transition)}
      to={formatTrace(change.to, "to", change.transition)}
    />
  );
}

function targetRow(change: TargetChange) {
  return (
    <TransitionRow
      key={change.scenario}
      transition={change.transition}
      comparison={change.comparison}
      identity={change.scenario + " target"}
      identityKey={change.scenario + " target"}
      from={formatTrace(change.from, "from", change.transition)}
      to={formatTrace(change.to, "to", change.transition)}
      detail={
        change.pctChange === null
          ? undefined
          : (change.pctChange * 100).toFixed(1) + "%"
      }
      direction={numericDirection(change.fromValue, change.toValue)}
    />
  );
}

function projectionRow(change: ProjectionChange) {
  return (
    <TransitionRow
      key={
        change.path +
        "|" +
        change.metric +
        "|" +
        change.period +
        "|" +
        change.transition
      }
      transition={change.transition}
      comparison={change.comparison}
      identity={
        change.path +
        " | " +
        (METRIC_LABELS[change.metric] ?? change.metric) +
        " | " +
        change.period
      }
      from={formatTrace(change.from, "from", change.transition)}
      to={formatTrace(change.to, "to", change.transition)}
      detail={
        change.pctChange === null
          ? undefined
          : (change.pctChange * 100).toFixed(1) + "%"
      }
      direction={numericDirection(change.fromValue, change.toValue)}
    />
  );
}

function textRow(change: TextTransition, family: string, index: number) {
  return (
    <TransitionRow
      key={family + "|" + change.title + "|" + index}
      transition={change.transition}
      comparison={change.comparison}
      identity={family}
      from={change.from ?? missingEndpoint("from", change.transition)}
      to={change.to ?? missingEndpoint("to", change.transition)}
    />
  );
}

function verdictRow(change: VerdictChange) {
  return (
    <TransitionRow
      transition={change.transition}
      comparison={change.comparison}
      identity="verdict synthesis"
      from={change.from}
      to={change.to}
    />
  );
}

function costRow(change: CostChange) {
  return (
    <TransitionRow
      transition={change.transition}
      comparison={change.comparison}
      identity="report cost"
      from={"$" + change.fromValue.toFixed(2)}
      to={"$" + change.toValue.toFixed(2)}
      detail={
        change.comparison === "comparable"
          ? "delta $" + change.delta.toFixed(2)
          : undefined
      }
      direction={
        change.delta < 0
          ? "positive"
          : change.delta > 0
            ? "negative"
            : "neutral"
      }
    />
  );
}

function rowsOrEmpty(
  rows: ReactNode,
  length: number,
  comparison: DiffComparison,
): ReactNode {
  return length === 0 ? (
    <EmptyFamily comparison={comparison.comparison} />
  ) : (
    <div className="flex flex-col gap-1.5">{rows}</div>
  );
}

/** The renderer imported by the Next page and exercised directly in SSR tests. */
export function DiffBody({ diff }: { diff: ReportDiff }) {
  const summary = [
    String(diff.gradeChanges.length) + " grade",
    String(diff.scoreChanges.length) + " score",
    String(diff.weightChanges.length) + " weight",
    String(diff.driverChanges.length) + " driver",
    String(diff.targetChanges.length) + " target",
    String(diff.projectionChanges.length) + " projection",
    String(diff.catalystChanges.length) + " catalyst",
    String(diff.riskChanges.length) + " risk",
    String(diff.verdictChange === null ? 0 : 1) + " verdict",
    String(diff.costChange === null ? 0 : 1) + " cost",
  ].join(" \u00b7 ");
  const projectionComparison: DiffComparison = {
    comparison: Object.values(diff.familyComparisons.projections).some(
      (value) => value.comparison === "not-comparable",
    )
      ? "not-comparable"
      : "comparable",
    reasons: [
      ...new Set(
        Object.values(diff.familyComparisons.projections).flatMap(
          (value) => value.reasons,
        ),
      ),
    ],
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5 border border-edge bg-panel px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={diff.comparisonStatus === "not-comparable" ? "warn" : "muted"}>
            comparison {diff.comparisonStatus.replaceAll("-", " ")}
          </Badge>
          <span className="mono text-[11px] text-muted">
            pipeline {displayVersion(diff.context.fromReportVersion)} to{" "}
            {displayVersion(diff.context.toReportVersion)}
          </span>
          <span className="mono text-[11px] text-muted">
            spec {displayVersion(diff.context.fromSpecVersion)} to{" "}
            {displayVersion(diff.context.toSpecVersion)}
          </span>
          <span className="mono text-[11px] text-muted">
            sources {diff.sourceFreshness.from} to {diff.sourceFreshness.to}
          </span>
        </div>
        <div className="mono text-[11px] text-faint">{summary}</div>
        <ReasonList reasons={diff.notComparableReasons} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <FamilyPanel title="grade changes" comparison={diff.familyComparisons.grades}>
          {rowsOrEmpty(diff.gradeChanges.map(gradeRow), diff.gradeChanges.length, diff.familyComparisons.grades)}
        </FamilyPanel>
        <FamilyPanel title="score changes" comparison={diff.familyComparisons.scores}>
          {rowsOrEmpty(diff.scoreChanges.map(scoreRow), diff.scoreChanges.length, diff.familyComparisons.scores)}
        </FamilyPanel>
        <FamilyPanel title="composite weights" comparison={diff.familyComparisons.weights}>
          {rowsOrEmpty(diff.weightChanges.map(weightRow), diff.weightChanges.length, diff.familyComparisons.weights)}
        </FamilyPanel>
        <FamilyPanel title="score drivers" comparison={diff.familyComparisons.drivers}>
          {rowsOrEmpty(diff.driverChanges.map(driverRow), diff.driverChanges.length, diff.familyComparisons.drivers)}
        </FamilyPanel>
        <FamilyPanel title="scenario target changes" comparison={diff.familyComparisons.targets}>
          {rowsOrEmpty(diff.targetChanges.map(targetRow), diff.targetChanges.length, diff.familyComparisons.targets)}
        </FamilyPanel>
        <FamilyPanel title="projection changes" comparison={projectionComparison}>
          {rowsOrEmpty(diff.projectionChanges.map(projectionRow), diff.projectionChanges.length, projectionComparison)}
        </FamilyPanel>
        <FamilyPanel title="catalysts" comparison={diff.familyComparisons.catalysts}>
          {rowsOrEmpty(
            diff.catalystChanges.map((change, index) => textRow(change, "catalyst", index)),
            diff.catalystChanges.length,
            diff.familyComparisons.catalysts,
          )}
        </FamilyPanel>
        <FamilyPanel title="risks" comparison={diff.familyComparisons.risks}>
          {rowsOrEmpty(
            diff.riskChanges.map((change, index) => textRow(change, "risk", index)),
            diff.riskChanges.length,
            diff.familyComparisons.risks,
          )}
        </FamilyPanel>
        <FamilyPanel title="verdict" comparison={diff.familyComparisons.verdict}>
          {diff.verdictChange === null ? (
            <div className="text-[11px] text-faint">
              verdict{" "}
              {diff.familyComparisons.verdict.comparison === "not-comparable"
                ? "not comparable"
                : "unchanged"}
            </div>
          ) : (
            verdictRow(diff.verdictChange)
          )}
        </FamilyPanel>
        <FamilyPanel title="cost" comparison={diff.familyComparisons.cost}>
          {rowsOrEmpty(
            diff.costChange === null ? null : costRow(diff.costChange),
            diff.costChange === null ? 0 : 1,
            diff.familyComparisons.cost,
          )}
        </FamilyPanel>
      </div>
    </div>
  );
}
