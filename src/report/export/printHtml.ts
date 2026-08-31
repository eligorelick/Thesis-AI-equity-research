/**
 * reportToPrintHtml — a self-contained, print-optimized HTML document for a
 * full {@link Report}. This is the dependency-free path to a PDF: the browser
 * prints THIS page to PDF. Intentionally LIGHT (dark-on-light) for paper
 * legibility, with print CSS (page-break-friendly section blocks, a serif
 * body, tabular numerals).
 *
 * Two consumers:
 *   - the export route (?format=pdf) returns this HTML directly (self-contained,
 *     inline CSS, no external assets — safe to serve raw);
 *   - the print page route builds a React tree, but reuses this module's body
 *     renderer + CSS so both surfaces are byte-identical in content.
 *
 * DETERMINISTIC and pure — no timestamps, no server-only imports. Every figure
 * carries its as-of; the disclaimer and FRED attribution appear verbatim.
 *
 * Security: this HTML is assembled from report content (already schema-
 * validated), so every interpolated string is HTML-escaped via {@link esc}. No
 * user-controlled markup is ever injected.
 */

import type {
  Appendix,
  BalanceSheet,
  Business,
  CatalystsRisks,
  Competitive,
  Disagreement,
  Fundamentals,
  GradeBlock,
  Leadership,
  Macro,
  MetricRow,
  Projections,
  ProvenanceCoverage,
  Quality,
  Report,
  FairValue,
  Scenario,
  ScenarioTargets,
  Scoring,
  SegmentRow,
  SourcedClaim,
  Technicals,
  TracedNumber,
  Valuation,
} from "@/report/schema";
import {
  deriveReportCompletenessPresentation,
  type ReportCompletenessPresentation,
} from "@/report/completeness";
import {
  ASPECT_SCORE_FIELDS,
  AS_OF_MAP_FIELDS,
  COMPOSITE_SCORE_FIELDS,
  EXECUTIVE_EVIDENCE_GROUPS,
  MANIFEST_ENTRY_FIELDS,
  PROJECTION_METRIC_BY_KEY,
  PROJECTION_PATHS,
  PROJECTION_POINT_FIELD_BY_KEY,
  PROJECTION_ROOT_FIELDS,
  PROJECTION_SCENARIO_WEIGHTS,
  PROJECTION_SERIES_FIELD_BY_KEY,
  PROJECTION_DISCLOSURE_FIELDS,
  SCORE_WEIGHTS,
  SCORE_SURFACE_BY_KEY,
  SCORE_SURFACES,
  SOURCE_ENTRY_FIELDS,
  TRACED_NUMBER_FIELDS,
  VERIFICATION_LOG_FIELDS,
  gradeSurfaceEntries,
  orderedProjectionSeries,
  projectionCellPoint,
  projectionPeriodRows,
} from "@/report/surfaceManifest";
import { citationOutcomeLabel } from "@/report/schema";
import {
  formatCostUsd,
  formatFinancialValue,
  formatPct,
  roundedDisplayedCostTotal,
} from "@/report/format";
import {
  REPORT_SECTION_MANIFEST,
  reportSection,
  type ReportSectionKey,
} from "@/report/sectionManifest";

/* ======================================================================== *
 * Escaping + deterministic formatting
 * ======================================================================== */

const DASH = "—"; // em dash

function coverageCellHtml(
  supported: number,
  total: number,
  rate: number | null,
): string {
  return `${supported}/${total} (${
    rate === null ? "n/a &mdash; no items" : `${(rate * 100).toFixed(0)}%`
  })`;
}

function provenanceCoverageHtml(coverage: ProvenanceCoverage): string {
  return table(
    ["Evidence class", "Supported / total"],
    [
      [
        "Numeric provenance",
        coverageCellHtml(
          coverage.numeric.supported,
          coverage.numeric.total,
          coverage.numeric.rate,
        ),
      ],
      [
        "Factual-claim citations",
        coverageCellHtml(
          coverage.factualClaims.supported,
          coverage.factualClaims.total,
          coverage.factualClaims.rate,
        ),
      ],
      [
        "Judgment citations",
        coverageCellHtml(
          coverage.judgments.cited,
          coverage.judgments.total,
          coverage.judgments.rate,
        ),
      ],
    ],
  );
}

/** HTML-escape a string for safe interpolation into the print document. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v.toFixed(digits);
}

function tracedValue(n: TracedNumber): string {
  return formatFinancialValue(n.value, n.unit, n.currency);
}

function signedPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return formatPct(v, digits, true);
}

function asOfTag(asOf: string | null): string {
  return asOf ? ` <span class="asof">as of ${esc(asOf)}</span>` : "";
}

// Citation-coverage marker (PROVENANCE, not correctness — audit 2026-07-11
// finding #2): a check when the number traced to a citation or a payload value,
// an "uncited" flag when it did not, a hollow dot when the pass has not run.
// Never claims a number is "verified".
function verifiedTag(n: TracedNumber): string {
  if (n.verified === true)
    return `<span class="v ok" title="citation-traced (provenance, not correctness)">✓</span>`;
  if (n.verified === false)
    return `<span class="v warn" title="not traced to a citation or payload figure">uncited</span>`;
  return `<span class="v faint" title="citation coverage not computed">○</span>`;
}

function gradeClass(grade: string): string {
  return `g-${grade.toLowerCase()}`;
}

function auditValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  return String(value);
}

function citationTraceLabel(value: TracedNumber["verified"]): string {
  return value === true ? "citation-traced" : value === false ? "uncited" : "not checked";
}

function tracedAuditCells(trace: TracedNumber): string[] {
  return TRACED_NUMBER_FIELDS.map((field) => {
    if (field.key === "verified") return esc(citationTraceLabel(trace.verified));
    return esc(auditValue(trace[field.key]));
  });
}

/* ======================================================================== *
 * HTML building blocks
 * ======================================================================== */

function h2(index: number, title: string): string {
  return `<h2 class="sec"><span class="secno">${index}</span> ${esc(title)}</h2>`;
}

function sectionHeading(key: ReportSectionKey): string {
  const section = reportSection(key);
  return h2(section.index, section.printTitle);
}

/** A table from escaped header + body cells (cells may carry inner markup). */
function table(headers: string[], rows: string[][]): string {
  const head = `<thead><tr>${headers
    .map((h) => `<th>${esc(h)}</th>`)
    .join("")}</tr></thead>`;
  const body =
    rows.length === 0
      ? `<tbody><tr><td colspan="${headers.length}" class="empty">${DASH}</td></tr></tbody>`
      : `<tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody>`;
  return `<table>${head}${body}</table>`;
}

function claimList(claims: readonly SourcedClaim[]): string {
  if (claims.length === 0) return `<p class="faint">${DASH}</p>`;
  return `<ul class="claims">${claims
    .map(
      (c) =>
        `<li><span class="label ${c.label.toLowerCase()}">${esc(
          c.label,
        )}</span> ${esc(c.text)}${asOfTag(c.asOf)} <span class="src">src: ${esc(
          c.source,
        )}</span> <span class="src">source id: ${esc(c.sourceId ?? "n/a")}</span></li>`,
    )
    .join("")}</ul>`;
}

function gradeBlock(title: string, block: GradeBlock): string {
  const parts: string[] = [];
  parts.push(
    `<div class="gradehead"><span class="chip ${gradeClass(
      block.grade,
    )}">${esc(block.grade)}</span> <strong>${esc(
      title,
    )}</strong> <span class="conf">confidence: ${esc(block.confidence)}</span></div>`,
  );
  parts.push(`<p class="why">${esc(block.oneLineWhy)}</p>`);
  if (block.interpretation) {
    parts.push(`<p class="interp">${esc(block.interpretation)}</p>`);
  }
  if (block.reasoning.length > 0) {
    parts.push(claimList(block.reasoning));
  }
  if (block.keyNumbers.length > 0) {
    parts.push(
      table(
        ["Metric", "Value", "As of", "Cited"],
        block.keyNumbers.map((n) => [
          esc(n.source),
          `<span class="mono">${esc(tracedValue(n))}</span>`,
          esc(n.asOf ?? DASH),
          verifiedTag(n),
        ]),
      ),
    );
  }
  return `<div class="gradeblock">${parts.join("")}</div>`;
}

function metricRowsTable(rows: readonly MetricRow[]): string {
  const body: string[][] = [];
  for (const row of rows) {
    for (const v of row.values) {
      body.push([
        esc(row.label),
        esc(v.period),
        `<span class="mono">${esc(tracedValue(v.value))}</span>`,
        esc(v.value.asOf ?? DASH),
      ]);
    }
  }
  return table(["Metric", "Period", "Value", "As of"], body);
}

function segmentTable(rows: readonly SegmentRow[]): string {
  return table(
    ["Segment", "Revenue", "Share", "As of"],
    rows.map((s) => [
      esc(s.name),
      `<span class="mono">${esc(tracedValue(s.revenue))}</span>`,
      s.sharePct === null ? DASH : `${s.sharePct.toFixed(1)}%`,
      esc(s.revenue.asOf ?? DASH),
    ]),
  );
}

function numbersTable(numbers: readonly TracedNumber[]): string {
  return table(
    ["Metric", "Value", "As of", "Cited"],
    numbers.map((n) => [
      esc(n.source),
      `<span class="mono">${esc(tracedValue(n))}</span>`,
      esc(n.asOf ?? DASH),
      verifiedTag(n),
    ]),
  );
}

/* ======================================================================== *
 * Section renderers
 * ======================================================================== */

function sectionVerdict(report: Report): string {
  const v = report.verdict;
  const strip = table(
    ["Section", "Grade", "Why"],
    gradeSurfaceEntries(v.gradeStrip).map(({ descriptor, block }) => [
      esc(descriptor.label),
      `<span class="chip ${gradeClass(block.grade)}">${esc(block.grade)}</span>`,
      esc(block.oneLineWhy),
    ]),
  );
  const execSummary =
    v.executiveSummary && v.executiveSummary.length > 0
      ? `<h3>Executive summary</h3>${claimList(v.executiveSummary)}`
      : "";
  return `<section class="block">${sectionHeading("verdict")}<p class="synthesis">${esc(
    v.synthesis,
  )}</p>${execSummary}${strip}</section>`;
}

function sectionScores(scores: Scoring): string {
  const c = scores.composite;
  const aspectDescriptors = SCORE_SURFACES.filter((descriptor) => descriptor.kind === "aspect");
  const compositeFields = COMPOSITE_SCORE_FIELDS.filter((field) => field.key !== "weights");
  const aspectFields = ASPECT_SCORE_FIELDS.filter((field) => field.key !== "drivers");
  const compositeChip = c.band
    ? `<span class="chip ${gradeClass(c.band)}">${esc(c.band)}</span>`
    : DASH;
  return `<section class="block"><h3>Scorecard (deterministic)</h3>
    <p>Composite: <strong class="mono">${
      c.score === null ? DASH : Math.round(c.score)
    } / 100</strong> ${compositeChip}</p>
    ${table(
      ["Score identity", ...compositeFields.map((field) => field.label)],
      [[
        esc(SCORE_SURFACE_BY_KEY.composite.label),
        ...compositeFields.map((field) => {
          if (field.key === "score") return esc(auditValue(c.score));
          if (field.key === "band") return esc(auditValue(c.band));
          return esc(c.methodology);
        }),
      ]],
    )}
    <h3>Composite weights</h3>${table(
      ["Aspect", "Weight"],
      SCORE_WEIGHTS.map((descriptor) => [
        esc(descriptor.label),
        esc(String(c.weights[descriptor.aspect])),
      ]),
    )}
    <h3>Aspect scores</h3>${table(
      ["Aspect", ...aspectFields.map((field) => field.label)],
      aspectDescriptors.map((descriptor) => {
        const aspect = scores.aspects[descriptor.key];
        return [
          esc(descriptor.label),
          ...aspectFields.map((field) => {
            if (field.key === "dataCompleteness") {
              return esc(String(aspect.dataCompleteness));
            }
            return esc(auditValue(aspect[field.key]));
          }),
        ];
      }),
    )}
    <h3>Score drivers</h3>${table(
      ["Aspect", ...TRACED_NUMBER_FIELDS.map((field) => field.label)],
      aspectDescriptors.flatMap((descriptor) =>
        scores.aspects[descriptor.key].drivers.map((driver) => [
          esc(descriptor.label),
          ...tracedAuditCells(driver),
        ])),
    )}
    <p class="faint">${esc(c.methodology)} <em>(bands ${esc(scores.bandsVersion)})</em></p></section>`;
}

function sectionProjections(p: Projections): string {
  const series = orderedProjectionSeries(p.series);
  const forwardPaths = PROJECTION_PATHS.filter((descriptor) => descriptor.kind !== "historical");
  const blocks = series
    .map((s) => {
      const rows = projectionPeriodRows(s).flatMap((row) => {
        const points = forwardPaths.map((descriptor) =>
          projectionCellPoint(row, descriptor.key, s.unit));
        if (points.every((point) => point === null)) return [];
        return [[
          esc(row.period),
          ...points.map((point) => `<span class="mono">${
            point === null ? DASH : esc(tracedValue(point.value))
          }</span>`),
        ]];
      });
      const assumptions =
        s.assumptions.length > 0
          ? `<ul class="claims">${s.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`
          : "";
      return `<h3>${esc(PROJECTION_METRIC_BY_KEY[s.metric].label)} (${esc(s.unit)})</h3>${table(
        ["Period", ...forwardPaths.map((descriptor) => descriptor.label)],
        rows,
      )}${assumptions}`;
    })
    .join("");
  const rootAudit = table(
    ["Field", "Value"],
    PROJECTION_ROOT_FIELDS.flatMap((field) => {
      if (field.key === "scenarioWeights") {
        return PROJECTION_SCENARIO_WEIGHTS.map((descriptor) => [
          esc(`${descriptor.label} scenario weight`),
          esc(String(p.scenarioWeights[descriptor.key])),
        ]);
      }
      if (field.key === "horizonYears") return [[esc(field.label), esc(String(p.horizonYears))]];
      if (field.key === "weightsVersion") return [[esc(field.label), esc(p.weightsVersion)]];
      if (field.key === "series") return [[esc(field.label), esc(String(p.series.length))]];
      return [[esc(field.label), esc(auditValue(p.notApplicableReason))]];
    }),
  );
  const seriesAudit = series.map((s) => {
    const metric = PROJECTION_METRIC_BY_KEY[s.metric];
    const points = table(
      [
        PROJECTION_SERIES_FIELD_BY_KEY.metric.label,
        "Path",
        PROJECTION_POINT_FIELD_BY_KEY.period.label,
        "Series unit",
        ...TRACED_NUMBER_FIELDS.map((field) => field.label),
      ],
      PROJECTION_PATHS.flatMap((path) =>
        s[path.key].map((point) => [
          esc(metric.label),
          esc(path.label),
          esc(point.period),
          esc(s.unit),
          ...tracedAuditCells(point.value),
        ])),
    );
    const assumptions = table(
      [PROJECTION_SERIES_FIELD_BY_KEY.assumptions.label],
      s.assumptions.map((assumption) => [esc(assumption)]),
    );
    const disclosures = table(
      PROJECTION_DISCLOSURE_FIELDS.map((field) => field.label),
      s.disclosures.map((disclosure) =>
        PROJECTION_DISCLOSURE_FIELDS.map((field) => {
          if (field.key === "attemptedSources") {
            return esc(disclosure.attemptedSources?.join(", ") ?? "n/a");
          }
          if (field.key === "expected") {
            return disclosure.expected === undefined
              ? "unknown"
              : disclosure.expected ? "yes" : "no";
          }
          return esc(disclosure[field.key]);
        })),
    );
    return `<h4>${esc(metric.label)} projection series</h4>${points}${assumptions}${disclosures}`;
  }).join("");
  return `<section class="block">${sectionHeading("projections")}
    <p class="faint">Horizon ${p.horizonYears}y · unbacktested display prior weights ${p.scenarioWeights.bull}/${p.scenarioWeights.base}/${p.scenarioWeights.bear} (bull/base/bear). Forward figures are ESTIMATEs, not facts or empirically calibrated odds.</p>
    ${series.length === 0 ? `<p class="faint">Not applicable${p.notApplicableReason ? `: ${esc(p.notApplicableReason)}` : "."}</p>` : ""}
    ${blocks}<h3>Projection audit trail</h3>${rootAudit}${seriesAudit}</section>`;
}

function sectionBusiness(b: Business): string {
  return `<section class="block">${sectionHeading("business")}
    <h3>What they sell</h3>${claimList(b.whatTheySell)}
    <h3>Product segments</h3>${segmentTable(b.segments.product)}
    <h3>Geographic segments</h3>${segmentTable(b.segments.geographic)}
    <h3>Concentration risks</h3>${claimList(b.concentrationRisks)}</section>`;
}

function sectionFundamentals(f: Fundamentals): string {
  return `<section class="block">${sectionHeading("fundamentals")}${gradeBlock(
    "Fundamentals",
    f.graded,
  )}
    <h3>Growth</h3>${metricRowsTable(f.growthTable)}
    <h3>Margin trend</h3>${metricRowsTable(f.marginTrend)}
    <h3>Returns</h3>${metricRowsTable(f.returns)}
    <h3>Free cash flow</h3>${metricRowsTable(f.fcf)}
    ${f.commentary.length > 0 ? `<h3>Commentary</h3>${claimList(f.commentary)}` : ""}</section>`;
}

function sectionBalanceSheet(bs: BalanceSheet): string {
  const group = (
    title: string,
    g: { commentary: readonly SourcedClaim[]; numbers: readonly TracedNumber[] },
  ): string =>
    `<h3>${esc(title)}</h3>${claimList(g.commentary)}${
      g.numbers.length > 0 ? numbersTable(g.numbers) : ""
    }`;
  return `<section class="block">${sectionHeading("balanceSheet")}
    ${bs.graded ? gradeBlock("Balance Sheet & Capital", bs.graded) : ""}
    ${group("Debt profile", bs.debtProfile)}
    ${group("Coverage", bs.coverage)}
    ${group("Capex trajectory", bs.capexTrajectory)}
    <h3>Capital allocation</h3>${claimList(bs.capitalAllocation)}</section>`;
}

function sectionValuation(v: Valuation, scenarioTargets?: ScenarioTargets, fairValue?: FairValue): string {
  const parts: string[] = [];
  parts.push(gradeBlock("Valuation", v.graded));

  // perShare is null when the deterministic fair value was suppressed — show
  // "unavailable", never a fabricated number.
  const dcfPs = v.dcf.perShare;
  parts.push(
    dcfPs
      ? `<h3>DCF</h3><p>Intrinsic value per share: <strong class="mono">${esc(tracedValue(dcfPs))}</strong>${asOfTag(dcfPs.asOf)}${
          v.dcf.upsidePct === null
            ? ""
            : ` &mdash; upside <span class="mono">${esc(signedPct(v.dcf.upsidePct))}</span>`
        }</p>`
      : `<h3>DCF</h3><p>Intrinsic value per share: <strong>unavailable</strong> &mdash; the deterministic fair value could not be computed for this route/inputs (see missing-data).</p>`,
  );
  // Honest disclosure: computed-derived, route-appropriate method (or why suppressed).
  if (fairValue) {
    parts.push(
      fairValue.status === "available"
        ? `<p class="faint">${esc(fairValue.basis.join(" "))}</p>`
        : `<p class="faint">Intrinsic value per share suppressed &mdash; ${esc(fairValue.reasons.map((r) => r.reason).join("; ") || fairValue.basis.join(" "))}</p>`,
    );
  }
  parts.push(
    table(
      ["Assumption", "Value", "Basis"],
      v.dcf.assumptions.map((a) => [esc(a.name), esc(a.value), esc(a.basis)]),
    ),
  );

  const waccs = uniqueSorted(v.dcf.sensitivityGrid.map((c) => c.waccPct));
  const gterms = uniqueSorted(v.dcf.sensitivityGrid.map((c) => c.gTermPct));
  if (waccs.length > 0 && gterms.length > 0) {
    const lookup = new Map<string, number | null>();
    for (const c of v.dcf.sensitivityGrid)
      lookup.set(`${c.waccPct}|${c.gTermPct}`, c.perShare);
    const headers = ["WACC \\ g", ...gterms.map((g) => `${g.toFixed(1)}%`)];
    const rows = waccs.map((w) => [
      `${w.toFixed(1)}%`,
      ...gterms.map((g) => {
        const ps = lookup.get(`${w}|${g}`);
        return ps === undefined || ps === null ? DASH : `$${ps.toFixed(0)}`;
      }),
    ]);
    parts.push(
      `<h3>Sensitivity (per share &mdash; rows = WACC, cols = terminal g)</h3>`,
      table(headers, rows.map((r) => r.map((c) => `<span class="mono">${esc(c)}</span>`))),
    );
  }

  parts.push(
    `<h3>Reverse DCF</h3><p>Implied ${esc(
      v.reverseDcf.impliedMetric,
    )}: <strong class="mono">${
      v.reverseDcf.impliedValue === null
        ? DASH
        : esc(v.reverseDcf.impliedValue.toFixed(1))
    }</strong></p><p>${esc(v.reverseDcf.narrative)}</p>`,
  );

  parts.push(
    `<h3>Multiples</h3>`,
    table(
      ["Multiple", "Current", "Peer median", "Own 5y pctile", "Sector"],
      v.multiples.map((m) => [
        esc(m.name),
        m.current === null ? DASH : num(m.current, 1),
        m.peerMedian === null ? DASH : num(m.peerMedian, 1),
        m.own5yPercentile === null ? DASH : `${m.own5yPercentile.toFixed(0)}%`,
        m.sectorAppropriate ? "yes" : "no",
      ]),
    ),
  );

  parts.push(`<h3>Scenarios</h3>`);
  parts.push(
    `<p class="faint">Narrative probabilities are model JUDGMENTs, not empirically calibrated odds. Data-only reports show them as unavailable.</p>`,
  );
  // Honest disclosure: computed-derived DCF sensitivity, not analyst targets (or why suppressed).
  if (scenarioTargets) {
    if (scenarioTargets.status === "available") {
      parts.push(
        `<p class="faint">Price targets are computed-derived (${esc(scenarioTargets.method)}), not analyst targets. ${esc(scenarioTargets.basis.join(" "))}</p>`,
      );
    } else {
      const reasons = scenarioTargets.missingReasons.map((m) => m.reason).join("; ");
      parts.push(
        `<p class="faint">Scenario price targets suppressed — ${esc(reasons || scenarioTargets.basis.join(" "))}</p>`,
      );
    }
  }
  for (const sc of v.scenarios) parts.push(scenarioCard(sc));

  return `<section class="block">${sectionHeading("valuation")}${parts.join("")}</section>`;
}

function scenarioCard(sc: Scenario): string {
  const list = (items: readonly string[]): string =>
    items.length > 0
      ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
      : `<p class="faint">${DASH}</p>`;
  const probability = sc.probability === null
    ? "n/a"
    : `${(sc.probability * 100).toFixed(0)}%`;
  return `<div class="scenario ${esc(sc.name)}">
    <div class="scenariohead"><strong>${esc(sc.name.toUpperCase())}</strong>
      <span class="mono">${sc.priceTarget ? esc(tracedValue(sc.priceTarget)) : "target unavailable"}</span>
      <span class="prob">p = ${probability}</span>
      <span class="asof">${esc(sc.horizon)}</span></div>
    <div class="scenariobody">
      <div><em>Assumptions</em>${list(sc.assumptions)}</div>
      <div><em>What would have to be true</em>${list(sc.whatWouldHaveToBeTrue)}</div>
    </div></div>`;
}

function sectionQuality(q: Quality): string {
  const fs = q.forensicScores;
  // "Not applicable" carries the reason a battery was skipped for this route,
  // which the on-screen report shows and the export previously dropped.
  const forensic = table(
    ["Battery", "Variant", "Score", "Zone", "Not applicable"],
    (
      [
        ["Altman Z", fs.altman, num(fs.altman.score, 2)],
        ["Beneish M", fs.beneish, num(fs.beneish.score, 2)],
        ["Piotroski F", fs.piotroski, num(fs.piotroski.score, 0)],
        ["Accruals", fs.accruals, num(fs.accruals.score, 2)],
      ] as const
    ).map(([label, entry, score]) =>
      [label, entry.variant, score, entry.zone ?? DASH, entry.notApplicableReason ?? DASH].map(
        (c) => esc(String(c)),
      ),
    ),
  );
  const flags =
    q.flags.length > 0
      ? table(
          ["Severity", "Flag", "Source"],
          q.flags.map((f) => [esc(f.severity), esc(f.text), esc(f.source)]),
        )
      : `<p class="faint">No forensic flags raised.</p>`;
  return `<section class="block">${sectionHeading("quality")}${gradeBlock(
    "Quality",
    q.graded,
  )}<h3>Forensic scores</h3>${forensic}<h3>Flags</h3>${flags}</section>`;
}

function sectionTechnicals(t: Technicals): string {
  const read = `<ul class="read">
    <li><strong>Trend:</strong> ${esc(t.read.trend)}</li>
    <li><strong>Momentum:</strong> ${esc(t.read.momentum)}</li>
    <li><strong>Key levels:</strong> ${esc(t.read.keyLevels)}</li>
    <li><strong>Relative strength:</strong> ${esc(t.read.relativeStrength)}</li></ul>`;
  const indicators = t.indicators.length > 0 ? numbersTable(t.indicators) : "";
  const flags =
    t.flags.length > 0
      ? table(
          ["Severity", "Flag", "Source"],
          t.flags.map((f) => [esc(f.severity), esc(f.text), esc(f.source)]),
        )
      : "";
  return `<section class="block">${sectionHeading("technicals")}${gradeBlock(
    "Technicals",
    t.graded,
  )}<h3>Structured read</h3>${read}${
    indicators ? `<h3>Indicators</h3>${indicators}` : ""
  }${flags ? `<h3>Flags</h3>${flags}` : ""}</section>`;
}

function sectionLeadership(l: Leadership): string {
  const execs = l.executives
    .map((e) => {
      const evidence = EXECUTIVE_EVIDENCE_GROUPS.map((descriptor) => {
        const claims = e.evidence[descriptor.key];
        if (!claims || claims.length === 0) return "";
        return `<h4>${esc(descriptor.label)}</h4>${claimList(claims)}`;
      }).join("");
      return `<div class="exec"><h4>${esc(e.name)} &mdash; ${esc(e.title)}</h4>
        <p>Grade <span class="chip ${gradeClass(e.grade)}">${esc(
          e.grade,
        )}</span> &middot; credibility <span class="chip ${gradeClass(
          e.credibilityGrade,
        )}">${esc(e.credibilityGrade)}</span>${
          e.tenureYears === null ? "" : ` &middot; tenure ${e.tenureYears.toFixed(1)}y`
        }</p>${claimList(e.reasoning)}${evidence}</div>`;
    })
    .join("");
  return `<section class="block">${sectionHeading("leadership")}${gradeBlock(
    "Leadership",
    l.graded,
  )}<h3>Executives</h3>${execs}<h3>Insider activity</h3>${claimList(
    l.insiderSummary,
  )}<h3>Governance</h3>${claimList(l.governanceNotes)}</section>`;
}

function sectionCompetitive(c: Competitive): string {
  let peers = `<p class="faint">No peer data.</p>`;
  if (c.peerTable.length > 0) {
    const maxMetrics = c.peerTable.reduce((m, p) => Math.max(m, p.metrics.length), 0);
    const headers = [
      "Peer",
      "Symbol",
      ...Array.from({ length: maxMetrics }, (_, i) => `Metric ${i + 1}`),
    ];
    const rows = c.peerTable.map((p) => [
      esc(p.name),
      esc(p.symbol ?? DASH),
      ...Array.from({ length: maxMetrics }, (_, i) =>
        p.metrics[i]
          ? `<span class="mono">${esc(tracedValue(p.metrics[i]))}</span>`
          : DASH,
      ),
    ]);
    peers = table(headers, rows);
  }
  const moat = c.moatAssessment
    .map(
      (m) =>
        `<li><strong>${esc(m.source)}</strong> (${esc(
          m.strength,
        )}): ${esc(m.reasoning.map((r) => r.text).join(" "))}</li>`,
    )
    .join("");
  return `<section class="block">${sectionHeading("competitive")}${gradeBlock(
    "Moat",
    c.moatGraded,
  )}<h3>Peer table</h3>${peers}<h3>Moat assessment</h3><ul>${moat}</ul>
    <h3>Market-share direction</h3><p>${esc(c.marketShareDirection)}</p></section>`;
}

function sectionCatalystsRisks(cr: CatalystsRisks): string {
  const catalysts = table(
    ["Catalyst", "Expected", "Direction", "Significance", "Note"],
    cr.catalysts.map((c) => [
      esc(c.title),
      esc(c.expectedDate ?? DASH),
      esc(c.direction),
      esc(c.significance),
      esc(c.reasoning.text),
    ]),
  );
  const risks = table(
    ["Risk", "Severity", "Probability", "Source", "Note"],
    cr.risks.map((r) => [
      esc(r.title),
      esc(r.severity),
      esc(r.probability),
      esc(r.source),
      esc(r.reasoning.text),
    ]),
  );
  return `<section class="block prominent">${sectionHeading("catalystsRisks")}<h3>Catalysts</h3>${catalysts}<h3>Risks</h3>${risks}</section>`;
}

function sectionOutlook(report: Report): string {
  const o = report.outlook;
  return `<section class="block">${sectionHeading("outlook")}
    <h3>Segment trajectories</h3>${claimList(o.segmentTrajectories)}
    ${o.tam && o.tam.length > 0 ? `<h3>TAM</h3>${claimList(o.tam)}` : ""}
    <h3>Estimate-revision trend</h3>${claimList(o.estimateRevisionTrend)}
    <h3>Guidance credibility</h3>${claimList(o.guidanceCredibility)}
    <h3>Scenario narratives</h3>
    <h4>1-year</h4>${claimList(o.scenarioNarratives.y1)}
    <h4>3-year</h4>${claimList(o.scenarioNarratives.y3)}
    <h4>5-year</h4>${claimList(o.scenarioNarratives.y5)}</section>`;
}

function sectionMacro(m: Macro): string {
  const series = table(
    ["Series", "Name", "Latest", "As of", "Relevance"],
    m.relevantSeries.map((s) => [
      esc(s.seriesId),
      esc(s.name),
      `<span class="mono">${esc(tracedValue(s.latest))}</span>`,
      esc(s.latest.asOf ?? DASH),
      esc(s.relevance),
    ]),
  );
  return `<section class="block">${sectionHeading("macro")}${series}${
    m.sensitivityNotes.length > 0
      ? `<h3>Sensitivity notes</h3>${claimList(m.sensitivityNotes)}`
      : ""
  }<p class="attribution">${esc(m.fredAttribution)}</p></section>`;
}

function disagreementsBlock(disagreements: readonly Disagreement[]): string {
  if (disagreements.length === 0) return "";
  const items = disagreements
    .map(
      (d) =>
        `<li><strong>${esc(d.topic)}</strong> (${esc(d.kind)})<ul>
        <li>Bull: ${esc(d.bullView)}</li>
        <li>Bear: ${esc(d.bearView)}</li>
        <li>Judge: ${esc(d.judgeResolution)}</li></ul></li>`,
    )
    .join("");
  return `<h3>Bull/bear disagreements</h3><ul class="disagreements">${items}</ul>`;
}

function sectionAppendix(
  a: Appendix,
  disagreements: readonly Disagreement[],
  asOfMap: Report["meta"]["asOfMap"],
  completeness: ReportCompletenessPresentation,
): string {
  const sources = table(
    SOURCE_ENTRY_FIELDS.map((field) => field.label),
    a.sources.map((source) =>
      SOURCE_ENTRY_FIELDS.map((field) => {
        if (field.key === "stale") {
          return source.stale === undefined ? "unknown" : source.stale ? "yes" : "no";
        }
        return esc(source[field.key]);
      })),
  );
  const missing =
    a.missingData.length > 0
      ? table(
          MANIFEST_ENTRY_FIELDS.map((field) => field.label),
          a.missingData.map((gap) =>
            MANIFEST_ENTRY_FIELDS.map((field) => {
              if (field.key === "attemptedSources") {
                return esc(gap.attemptedSources?.join(", ") ?? "n/a");
              }
              if (field.key === "expected") {
                return gap.expected === undefined ? "unknown" : gap.expected ? "yes" : "no";
              }
              return esc(gap[field.key]);
            })),
        )
      : `<p class="faint">${esc(completeness.manifestText)}</p>`;
  const totalCost = roundedDisplayedCostTotal(a.costBreakdown.map((entry) => entry.costUsd));
  const cost = table(
    ["Step", "Model", "Cost (USD)"],
    a.costBreakdown.map((e) => [esc(e.step), esc(e.model), formatCostUsd(e.costUsd)]),
  );
  const vlog =
    a.verificationLog && a.verificationLog.length > 0
      ? table(
          VERIFICATION_LOG_FIELDS.map((field) => field.label),
          a.verificationLog.map((entry) =>
            VERIFICATION_LOG_FIELDS.map((field) => {
              if (field.key === "outcome") return esc(citationOutcomeLabel(entry.outcome));
              return esc(auditValue(entry[field.key]));
            })),
        )
      : "";
  const asOfRows = Object.keys(asOfMap).sort().map((field) => [esc(field), esc(asOfMap[field])]);
  const asOfTable = table(AS_OF_MAP_FIELDS.map((field) => field.label), asOfRows);
  return `<section class="block">${sectionHeading("appendix")}
    ${disagreementsBlock(disagreements)}
    <h3>Sources</h3>${sources}
    <h3>Missing-data manifest</h3>${missing}
    <h3>Citation coverage</h3><p>Citation coverage: <strong>${
      a.verificationRate === null
        ? DASH
        : `${(a.verificationRate * 100).toFixed(0)}%`
    }</strong> <span class="muted">— share of report figures traceable to a citation or payload value; a provenance check, not a correctness/accuracy check.</span></p>${
      a.provenanceCoverage ? provenanceCoverageHtml(a.provenanceCoverage) : ""
    }${vlog}
    <h3>As-of map</h3>${asOfTable}
    <h3>Cost breakdown</h3>${cost}<p>Total: <strong>${formatCostUsd(totalCost)}</strong></p></section>`;
}

/* ======================================================================== *
 * Header + document shell
 * ======================================================================== */

function headerBlock(
  report: Report,
  completeness: ReportCompletenessPresentation,
): string {
  const m = report.meta;
  const displayedCost = roundedDisplayedCostTotal(
    report.appendix.costBreakdown.map((entry) => entry.costUsd),
  );
  const meta = table(
    ["Field", "Value"],
    [
      ["Generated", m.generatedAt],
      ["Model", m.model],
      ...(m.execution
        ? [[
            "Pass execution",
            m.execution.map((entry) => `${entry.step}: requested ${entry.requestedModel}/${entry.requestedEffort ?? "n/a"}; effective ${entry.effectiveModel}/${entry.effectiveEffort ?? "n/a"}${entry.adjustments.length > 0 ? ` (${entry.adjustments.join(", ")})` : ""}`).join(" | "),
          ]]
        : []),
      // Legacy reports carry a verifyModel label (removed setting) — keep it.
      ...(m.verifyModel !== undefined ? [["Verify model", m.verifyModel]] : []),
      ["Spec version", m.specVersion],
      ["Pipeline version", m.pipelineVersion],
      ["Data completeness", completeness.statusText],
      ["Cost (USD)", formatCostUsd(displayedCost)],
      [
        "Citation coverage",
        m.verificationRate === null
          ? DASH
          : `${(m.verificationRate * 100).toFixed(0)}%`,
      ],
    ].map((r) => r.map((c) => esc(String(c)))),
  );
  return `<header class="report-header">
    <h1>${esc(m.companyName)} <span class="ticker">(${esc(m.symbol)})</span></h1>
    <p class="subtitle">Equity Research Report</p>
    ${meta}
    <p class="disclaimer">${esc(m.disclaimer)}</p>
  </header>`;
}

/**
 * The report BODY (sections only) as an HTML fragment — reused by both the
 * standalone document and the React print page. Does NOT include <html>/<head>.
 */
export function reportToPrintBody(report: Report): string {
  const completeness = deriveReportCompletenessPresentation(
    report.meta.dataCompleteness,
    report.appendix.missingData,
  );
  const sections: Record<ReportSectionKey, string> = {
    verdict: `${sectionVerdict(report)}${report.scores ? sectionScores(report.scores) : ""}`,
    business: sectionBusiness(report.business),
    fundamentals: sectionFundamentals(report.fundamentals),
    balanceSheet: sectionBalanceSheet(report.balanceSheet),
    valuation: sectionValuation(report.valuation, report.scenarioTargets, report.fairValue),
    quality: sectionQuality(report.quality),
    technicals: sectionTechnicals(report.technicals),
    leadership: sectionLeadership(report.leadership),
    competitive: sectionCompetitive(report.competitive),
    catalystsRisks: sectionCatalystsRisks(report.catalystsRisks),
    outlook: sectionOutlook(report),
    projections: report.projections ? sectionProjections(report.projections) : "",
    macro: sectionMacro(report.macro),
    appendix: sectionAppendix(
      report.appendix,
      report.disagreements,
      report.meta.asOfMap,
      completeness,
    ),
  };
  return [
    headerBlock(report, completeness),
    completeness.bannerText
      ? `<aside class="data-only-banner">${esc(completeness.bannerText)}</aside>`
      : "",
    ...REPORT_SECTION_MANIFEST.map((section) => sections[section.key]),
  ]
    .filter((b) => b.length > 0)
    .join("\n");
}

/**
 * The print CSS — light, paper-legible, page-break-friendly. Exported so the
 * React print page can inject the identical stylesheet.
 */
export const PRINT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  background: #ffffff; color: #16181d;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 11pt; line-height: 1.45;
  font-variant-numeric: tabular-nums;
}
.print-doc { max-width: 8.1in; margin: 0 auto; padding: 0.6in 0.7in; }
h1 { font-size: 20pt; margin: 0 0 2pt; font-family: Georgia, serif; }
.ticker { color: #55606e; font-weight: normal; }
.subtitle { margin: 0 0 12pt; color: #55606e; font-size: 11pt; letter-spacing: 0.04em; text-transform: uppercase; }
.report-header { border-bottom: 2px solid #16181d; padding-bottom: 12pt; margin-bottom: 16pt; }
.disclaimer { margin-top: 10pt; font-style: italic; color: #55606e; }
.attribution { margin-top: 8pt; font-size: 9pt; color: #55606e; font-style: italic; }
h2.sec { font-size: 14pt; margin: 18pt 0 6pt; padding-top: 6pt; border-top: 1px solid #c8ccd4; }
.secno { display: inline-block; min-width: 1.6em; color: #8a919e; font-weight: normal; }
h3 { font-size: 11.5pt; margin: 12pt 0 4pt; color: #2a2e36; }
h4 { font-size: 10.5pt; margin: 8pt 0 3pt; color: #2a2e36; }
p { margin: 4pt 0; }
.synthesis { font-size: 11.5pt; margin: 0 0 10pt; }
.faint { color: #8a919e; }
.mono { font-family: "SF Mono", "Consolas", "Menlo", monospace; font-variant-numeric: tabular-nums; }
.asof { color: #8a919e; font-size: 8.5pt; font-family: "SF Mono", Consolas, monospace; }
.src { color: #8a919e; font-size: 8.5pt; font-family: "SF Mono", Consolas, monospace; }
table { width: 100%; border-collapse: collapse; margin: 5pt 0 9pt; font-size: 9.5pt; break-inside: auto; page-break-inside: auto; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { border: 1px solid #d5d9e0; padding: 3pt 5pt; text-align: left; vertical-align: top; }
th { background: #f1f3f6; font-family: Arial, Helvetica, sans-serif; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.03em; color: #55606e; }
td.empty { text-align: center; color: #8a919e; }
ul.claims { margin: 4pt 0; padding-left: 16pt; }
ul.claims li { margin: 3pt 0; }
.read { margin: 4pt 0; padding-left: 16pt; }
.label { display: inline-block; font-family: Arial, sans-serif; font-size: 7.5pt; font-weight: bold; text-transform: uppercase; padding: 0 3pt; border: 1px solid currentColor; border-radius: 2px; letter-spacing: 0.04em; }
.label.fact { color: #55606e; }
.label.estimate { color: #1f6feb; }
.label.judgment { color: #9a6b00; }
.chip { display: inline-block; min-width: 1.4em; text-align: center; font-family: Arial, sans-serif; font-weight: bold; padding: 0 4pt; border: 1.5px solid currentColor; border-radius: 2px; }
.g-a { color: #1a7f4b; } .g-b { color: #3a8f3a; } .g-c { color: #9a6b00; } .g-d { color: #b5521a; } .g-f { color: #c0392b; }
.gradeblock { border: 1px solid #d5d9e0; background: #f8f9fb; padding: 8pt 10pt; margin: 6pt 0 10pt; }
.gradehead { font-size: 11pt; }
.conf { color: #8a919e; font-size: 9pt; }
.why { font-style: italic; margin: 4pt 0; }
.interp { margin: 4pt 0; color: #2a2e36; border-left: 2px solid #c8ccd4; padding-left: 8pt; }
.v.ok { color: #1a7f4b; } .v.warn { color: #b5521a; font-size: 8pt; } .v.faint { color: #b5bac4; }
.scenario { border: 1px solid #d5d9e0; margin: 6pt 0; padding: 6pt 8pt; break-inside: avoid; }
.scenario.bull { border-left: 3px solid #1a7f4b; }
.scenario.base { border-left: 3px solid #1f6feb; }
.scenario.bear { border-left: 3px solid #c0392b; }
.scenariohead { font-size: 10.5pt; }
.scenariohead .prob { color: #55606e; margin-left: 6pt; }
.scenariobody { display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; margin-top: 4pt; }
.scenariobody ul { margin: 2pt 0; padding-left: 14pt; }
.block { break-inside: auto; }
.block.prominent { border: 2px solid #1f6feb; padding: 6pt 10pt; background: #f5f8ff; margin: 12pt 0; }
.exec { break-inside: avoid; margin: 6pt 0; }
.disagreements ul { margin: 2pt 0; }
@media print {
  .print-doc { max-width: none; padding: 0; margin: 0; }
  h2.sec, h3, h4 { break-after: avoid-page; page-break-after: avoid; }
  .scenario, .gradeblock, .exec { break-inside: avoid; page-break-inside: avoid; }
  @page { margin: 0.6in 0.5in; }
}
`;

/**
 * The tiny auto-print script: fires the browser print dialog once the document
 * has loaded. Included only when {@link ReportToPrintHtmlOptions.autoPrint} is
 * set — the self-contained ?format=pdf response uses it so the print dialog
 * appears immediately.
 */
const AUTOPRINT_SCRIPT = `<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},250);});</script>`;

export interface ReportToPrintHtmlOptions {
  /** When true, embed a script that fires window.print() on load. */
  autoPrint?: boolean;
}

/**
 * Full standalone print document (`<!doctype html>` … `</html>`) for a report.
 * Self-contained: inline CSS, no external assets, escaped content.
 */
export function reportToPrintHtml(
  report: Report,
  options: ReportToPrintHtmlOptions = {},
): string {
  const title = `${report.meta.symbol} — ${report.meta.companyName} — Thesis Report`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<div class="print-doc">
${reportToPrintBody(report)}
</div>
${options.autoPrint ? AUTOPRINT_SCRIPT : ""}
</body>
</html>`;
}

/* ======================================================================== *
 * Helpers
 * ======================================================================== */

function uniqueSorted(values: readonly number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}
