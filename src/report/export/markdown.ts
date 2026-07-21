/**
 * reportToMarkdown — a clean, complete, DETERMINISTIC Markdown rendering of a
 * full {@link Report} (the application contract §7 sections 1–13 + appendix). This is the
 * shareable artifact behind the "Export MD" button.
 *
 * Design goals (mirror the on-screen ReportView, plain-text edition):
 *   - Every section header from SPEC §7 is present, numbered as on screen.
 *   - Every figure carries its as-of date and its FACT/ESTIMATE/JUDGMENT label
 *     (SPEC §1 rules #2 and #5 are structural in the schema — we surface them).
 *   - Tables render as GitHub-flavored Markdown tables.
 *   - The mandatory disclaimer and the FRED attribution appear verbatim.
 *   - DETERMINISTIC: same input → byte-identical output. No `Date.now()`, no
 *     locale-dependent formatting, no Map/Set iteration-order surprises; the
 *     `asOfMap` (a record) is rendered with sorted keys.
 *
 * Pure and dependency-free — safe to call from a route handler or a test. No
 * server-only imports (no db/providers), so it can also be unit-tested directly.
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
import { DISCLAIMER_TEXT, FRED_ATTRIBUTION_TEXT, citationOutcomeLabel } from "@/report/schema";

/* ======================================================================== *
 * Deterministic value formatting (no locale, no grouping — stable text)
 * ======================================================================== */

const DASH = "—";

function coverageCell(supported: number, total: number, rate: number | null): string {
  return `${supported}/${total} (${
    rate === null ? "n/a — no items" : `${(rate * 100).toFixed(0)}%`
  })`;
}

function provenanceCoverageTable(coverage: ProvenanceCoverage): string {
  return table(
    ["Evidence class", "Supported / total"],
    [
      [
        "Numeric provenance",
        coverageCell(coverage.numeric.supported, coverage.numeric.total, coverage.numeric.rate),
      ],
      [
        "Factual-claim citations",
        coverageCell(
          coverage.factualClaims.supported,
          coverage.factualClaims.total,
          coverage.factualClaims.rate,
        ),
      ],
      [
        "Judgment citations",
        coverageCell(
          coverage.judgments.cited,
          coverage.judgments.total,
          coverage.judgments.rate,
        ),
      ],
    ],
  );
}

/** Fixed-decimal number, or an em dash for null/non-finite. */
function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v.toFixed(digits);
}

/** Compact magnitude with a fixed scale suffix (deterministic, no grouping). */
function large(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

/**
 * Render a {@link TracedNumber}'s value per its declared `unit`, mirroring the
 * on-screen `formatTracedValue`. Unit strings are as-reported free-text.
 */
function tracedValue(n: TracedNumber): string {
  const u = n.unit.trim().toLowerCase();
  if (u === "%" || u === "pct" || u === "percent") return `${num(n.value, 1)}%`;
  if (u === "x" || u === "×" || u === "multiple") return `${num(n.value, 1)}×`;
  if (u === "usd" || u === "$" || u === "usd/share" || u === "$/share")
    return `$${num(n.value, 2)}`;
  if (u === "usd_large" || u === "usd-large" || u === "$_large")
    return `$${large(n.value)}`;
  if (u === "large" || u === "count_large") return large(n.value);
  if (u === "bps") return `${num(n.value, 0)} bps`;
  if (u === "years" || u === "yr" || u === "y") return `${num(n.value, 1)}y`;
  if (u === "" || u === "number" || u === "count")
    return num(n.value, Number.isInteger(n.value) ? 0 : 2);
  return `${num(n.value)} ${n.unit}`;
}

/** Signed percent for deltas (e.g. +7.3% / -4.0%). */
function signedPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** As-of stamp suffix; empty when the claim/figure is timeless (null). */
function asOfSuffix(asOf: string | null): string {
  return asOf ? ` _(as of ${asOf})_` : "";
}

/**
 * The citation-coverage marker for a traced number (PROVENANCE, not correctness
 * — audit 2026-07-11 finding #2): ✓ when traced to a citation/payload value,
 * "uncited" when not, — when the pass has not run. Never claims "verified".
 */
function verifiedMark(n: TracedNumber): string {
  if (n.verified === true) return "✓";
  if (n.verified === false) return "uncited";
  return DASH;
}

/* ======================================================================== *
 * Markdown-safe cell text (escape pipes/newlines so tables don't break)
 * ======================================================================== */

/** Collapse newlines and escape pipes so a value is safe inside a table cell. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * A Markdown table from a header row + body rows. Every cell is escaped. When
 * there are no body rows, emits a single "—" spanning-ish row so the table is
 * still valid GFM.
 */
function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  if (rows.length === 0) {
    const empty = `| ${headers.map((_, i) => (i === 0 ? DASH : "")).join(" | ")} |`;
    return [head, sep, empty].join("\n");
  }
  const body = rows.map((r) => `| ${r.map(cell).join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}

/* ======================================================================== *
 * Shared block renderers
 * ======================================================================== */

/** A bullet list of sourced claims, each with its label + as-of. */
function claimList(claims: readonly SourcedClaim[]): string {
  if (claims.length === 0) return `- ${DASH}`;
  return claims
    .map((c) => `- **[${c.label}]** ${c.text}${asOfSuffix(c.asOf)} \`src: ${c.source}\``)
    .join("\n");
}

/** The full reasoning behind a grade: header line + one-liner + claims + key numbers. */
function gradeBlock(title: string, block: GradeBlock): string {
  const lines: string[] = [];
  lines.push(
    `**${title} — Grade ${block.grade}** (confidence: ${block.confidence})`,
  );
  lines.push("");
  lines.push(`_${block.oneLineWhy}_`);
  if (block.interpretation) {
    lines.push("");
    lines.push(block.interpretation);
  }
  if (block.reasoning.length > 0) {
    lines.push("");
    lines.push("Reasoning:");
    lines.push("");
    lines.push(claimList(block.reasoning));
  }
  if (block.keyNumbers.length > 0) {
    lines.push("");
    lines.push("Key numbers:");
    lines.push("");
    lines.push(
      table(
        ["Metric", "Value", "As of", "Cited"],
        block.keyNumbers.map((n) => [
          n.source,
          tracedValue(n),
          n.asOf ?? DASH,
          verifiedMark(n),
        ]),
      ),
    );
  }
  return lines.join("\n");
}

/** A MetricRow group (growth/margins/returns/fcf) as a period → value table. */
function metricRowsTable(rows: readonly MetricRow[]): string {
  const body: string[][] = [];
  for (const row of rows) {
    for (const v of row.values) {
      body.push([
        row.label,
        v.period,
        tracedValue(v.value),
        v.value.asOf ?? DASH,
      ]);
    }
  }
  return table(["Metric", "Period", "Value", "As of"], body);
}

/** Segment rows (product/geographic) as name / revenue / share table. */
function segmentTable(rows: readonly SegmentRow[]): string {
  return table(
    ["Segment", "Revenue", "Share", "As of"],
    rows.map((s) => [
      s.name,
      tracedValue(s.revenue),
      s.sharePct === null ? DASH : `${s.sharePct.toFixed(1)}%`,
      s.revenue.asOf ?? DASH,
    ]),
  );
}

/* ======================================================================== *
 * Section renderers (SPEC §7.1 – §7.13)
 * ======================================================================== */

function renderVerdict(report: Report): string {
  const v = report.verdict;
  const s = v.gradeStrip;
  const stripRows: string[][] = [
    ["Fundamentals", s.fundamentals.grade, s.fundamentals.oneLineWhy],
    ["Valuation", s.valuation.grade, s.valuation.oneLineWhy],
    ["Technicals", s.technicals.grade, s.technicals.oneLineWhy],
    ["Quality / Red-Flags", s.quality.grade, s.quality.oneLineWhy],
    ["Leadership", s.leadership.grade, s.leadership.oneLineWhy],
    ["Moat", s.moat.grade, s.moat.oneLineWhy],
  ];
  if (s.balanceSheet) {
    stripRows.splice(3, 0, ["Balance Sheet", s.balanceSheet.grade, s.balanceSheet.oneLineWhy]);
  }
  const strip = table(["Section", "Grade", "Why"], stripRows);
  const lines: string[] = ["## 1. Verdict", "", v.synthesis, ""];
  if (v.executiveSummary && v.executiveSummary.length > 0) {
    lines.push("### Executive summary", "", claimList(v.executiveSummary), "");
  }
  lines.push("### Grade strip", "", strip);
  return lines.join("\n");
}

const SCORE_ROWS: { key: keyof Scoring["aspects"]; label: string }[] = [
  { key: "fundamentals", label: "Fundamentals" },
  { key: "valuation", label: "Valuation" },
  { key: "quality", label: "Quality" },
  { key: "balanceSheet", label: "Balance Sheet" },
  { key: "moat", label: "Moat" },
  { key: "leadership", label: "Leadership" },
  { key: "technicals", label: "Technicals" },
];

function renderScores(scores: Scoring): string {
  const c = scores.composite;
  const rows = SCORE_ROWS.map(({ key, label }) => {
    const a = scores.aspects[key];
    return [
      label,
      a.score === null ? DASH : String(Math.round(a.score)),
      a.band ?? DASH,
      `${Math.round(a.dataCompleteness * 100)}%`,
      a.notApplicableReason ?? a.note,
    ];
  });
  return [
    "## 1b. Scorecard (deterministic)",
    "",
    `**Composite: ${c.score === null ? DASH : Math.round(c.score)} / 100 (${c.band ?? DASH})**`,
    "",
    table(["Aspect", "Score", "Band", "Completeness", "Note"], rows),
    "",
    `_${c.methodology}_`,
    "",
    `_Band table: ${scores.bandsVersion}._`,
  ].join("\n");
}

const PROJECTION_METRIC_LABEL: Record<Projections["series"][number]["metric"], string> = {
  revenue: "Revenue",
  operatingMargin: "Operating margin",
  fcf: "Free cash flow (FCFF)",
  epsDiluted: "Diluted EPS",
};

function renderProjections(p: Projections): string {
  if (p.series.length === 0) {
    return [
      "## 11b. Weighted Projections",
      "",
      `_Not applicable${p.notApplicableReason ? `: ${p.notApplicableReason}` : "."}_`,
    ].join("\n");
  }
  const lines: string[] = [
    "## 11b. Weighted Projections",
    "",
    `Horizon ${p.horizonYears}y · unbacktested display-prior weights ${p.scenarioWeights.bull}/${p.scenarioWeights.base}/${p.scenarioWeights.bear} (bull/base/bear). Forward figures are ESTIMATEs, not facts or empirically calibrated odds.`,
    "",
  ];
  for (const s of p.series) {
    lines.push(`### ${PROJECTION_METRIC_LABEL[s.metric]} (${s.unit})`, "");
    const rows = s.base.map((_, i) => [
      s.base[i].period,
      tracedValue(s.bull[i].value),
      tracedValue(s.base[i].value),
      tracedValue(s.weighted[i].value),
      tracedValue(s.bear[i].value),
    ]);
    lines.push(table(["Period", "Bull", "Base", "Weighted", "Bear"], rows), "");
    if (s.assumptions.length > 0) {
      lines.push("Assumptions:", "", s.assumptions.map((a) => `- ${a}`).join("\n"), "");
    }
  }
  return lines.join("\n").trimEnd();
}

function renderBusiness(b: Business): string {
  const lines: string[] = ["## 2. Business & Segments", ""];
  lines.push("### What they sell", "", claimList(b.whatTheySell), "");
  lines.push("### Product segments", "", segmentTable(b.segments.product), "");
  lines.push(
    "### Geographic segments",
    "",
    segmentTable(b.segments.geographic),
    "",
  );
  lines.push("### Concentration risks", "", claimList(b.concentrationRisks));
  return lines.join("\n");
}

function renderFundamentals(f: Fundamentals): string {
  const lines: string[] = ["## 3. Fundamentals", ""];
  lines.push(gradeBlock("Fundamentals", f.graded), "");
  lines.push("### Growth", "", metricRowsTable(f.growthTable), "");
  lines.push("### Margin trend", "", metricRowsTable(f.marginTrend), "");
  lines.push("### Returns", "", metricRowsTable(f.returns), "");
  lines.push("### Free cash flow", "", metricRowsTable(f.fcf), "");
  if (f.commentary.length > 0) {
    lines.push("### Commentary", "", claimList(f.commentary));
  }
  return lines.join("\n");
}

function renderBalanceSheet(bs: BalanceSheet): string {
  const lines: string[] = ["## 4. Balance Sheet & Capital", ""];
  if (bs.graded) {
    lines.push(gradeBlock("Balance Sheet & Capital", bs.graded), "");
  }
  const group = (
    title: string,
    g: { commentary: readonly SourcedClaim[]; numbers: readonly TracedNumber[] },
  ): void => {
    lines.push(`### ${title}`, "", claimList(g.commentary), "");
    if (g.numbers.length > 0) {
      lines.push(
        table(
          ["Metric", "Value", "As of", "Cited"],
          g.numbers.map((n) => [
            n.source,
            tracedValue(n),
            n.asOf ?? DASH,
            verifiedMark(n),
          ]),
        ),
        "",
      );
    }
  };
  group("Debt profile", bs.debtProfile);
  group("Coverage", bs.coverage);
  group("Capex trajectory", bs.capexTrajectory);
  lines.push("### Capital allocation", "", claimList(bs.capitalAllocation));
  return lines.join("\n");
}

function renderValuation(v: Valuation, scenarioTargets?: ScenarioTargets, fairValue?: FairValue): string {
  const lines: string[] = ["## 5. Valuation", ""];
  lines.push(gradeBlock("Valuation", v.graded), "");

  // DCF — perShare is null when the deterministic fair value was suppressed
  // (no per-share model for the route, or insufficient inputs). Show "unavailable",
  // never a fabricated number.
  const dcfPs = v.dcf.perShare;
  lines.push(
    "### DCF",
    "",
    dcfPs
      ? `Intrinsic value per share: **${tracedValue(dcfPs)}**${asOfSuffix(dcfPs.asOf)}${v.dcf.upsidePct === null ? "" : ` — upside ${signedPct(v.dcf.upsidePct)}`}`
      : "Intrinsic value per share: **unavailable** — the deterministic fair value could not be computed for this route/inputs (see missing-data appendix).",
    // Honest disclosure of how the intrinsic value was derived (computed-derived,
    // route-appropriate method), or why suppressed.
    ...(fairValue
      ? [
          fairValue.status === "available"
            ? `_${fairValue.basis.join(" ")}_`
            : `_Intrinsic value per share suppressed — ${fairValue.reasons.map((r) => r.reason).join("; ") || fairValue.basis.join(" ")}_`,
        ]
      : []),
    "",
    "Assumptions:",
    "",
    table(
      ["Assumption", "Value", "Basis"],
      v.dcf.assumptions.map((a) => [a.name, a.value, a.basis]),
    ),
    "",
  );

  // Sensitivity grid (WACC × terminal growth), rendered as a pivot table.
  const waccs = uniqueSorted(v.dcf.sensitivityGrid.map((c) => c.waccPct));
  const gterms = uniqueSorted(v.dcf.sensitivityGrid.map((c) => c.gTermPct));
  if (waccs.length > 0 && gterms.length > 0) {
    const lookup = new Map<string, number | null>();
    for (const c of v.dcf.sensitivityGrid) {
      lookup.set(`${c.waccPct}|${c.gTermPct}`, c.perShare);
    }
    const headers = ["WACC \\ g", ...gterms.map((g) => `${g.toFixed(1)}%`)];
    const rows = waccs.map((w) => [
      `${w.toFixed(1)}%`,
      ...gterms.map((g) => {
        const ps = lookup.get(`${w}|${g}`);
        return ps === undefined || ps === null ? DASH : `$${ps.toFixed(0)}`;
      }),
    ]);
    lines.push(
      "### Sensitivity (per share — rows = WACC, cols = terminal g)",
      "",
      table(headers, rows),
      "",
    );
  }

  // Reverse DCF
  lines.push(
    "### Reverse DCF",
    "",
    `Implied ${v.reverseDcf.impliedMetric}: **${
      v.reverseDcf.impliedValue === null
        ? DASH
        : `${v.reverseDcf.impliedValue.toFixed(1)}`
    }**`,
    "",
    v.reverseDcf.narrative,
    "",
  );

  // Multiples
  lines.push(
    "### Multiples",
    "",
    table(
      ["Multiple", "Current", "Peer median", "Own 5y pctile", "Sector-appropriate"],
      v.multiples.map((m) => [
        m.name,
        m.current === null ? DASH : num(m.current, 1),
        m.peerMedian === null ? DASH : num(m.peerMedian, 1),
        m.own5yPercentile === null ? DASH : `${m.own5yPercentile.toFixed(0)}%`,
        m.sectorAppropriate ? "yes" : "no",
      ]),
    ),
    "",
  );

  // Scenarios
  lines.push(
    "### Scenarios",
    "",
    "_Narrative probabilities are model JUDGMENTs, not empirically calibrated odds. Data-only reports show them as unavailable._",
    "",
  );
  // Honest disclosure of how the headline targets were derived (or why suppressed):
  // computed-derived DCF sensitivity, NOT source-verified analyst targets.
  if (scenarioTargets) {
    if (scenarioTargets.status === "available") {
      lines.push(`_Price targets are computed-derived (${scenarioTargets.method}), not analyst targets. ${scenarioTargets.basis.join(" ")}_`, "");
    } else {
      const reasons = scenarioTargets.missingReasons.map((m) => m.reason).join("; ");
      lines.push(`_Scenario price targets suppressed — ${reasons || scenarioTargets.basis.join(" ")}_`, "");
    }
  }
  for (const sc of v.scenarios) {
    lines.push(renderScenario(sc), "");
  }
  return lines.join("\n").trimEnd();
}

function renderScenario(sc: Scenario): string {
  const lines: string[] = [];
  // priceTarget is null when the deterministic computation suppressed it
  // (insufficient valuation inputs) — show "unavailable", never a fabricated value.
  const pt = sc.priceTarget;
  const target = pt ? tracedValue(pt) : "unavailable";
  const targetAsOf = pt ? asOfSuffix(pt.asOf) : "";
  const probability = sc.probability === null
    ? "n/a"
    : `${(sc.probability * 100).toFixed(0)}%`;
  lines.push(
    `#### ${capitalize(sc.name)} — target ${target} (p = ${probability}, ${sc.horizon})${targetAsOf}`,
  );
  lines.push("");
  lines.push("Assumptions:");
  lines.push("");
  lines.push(
    sc.assumptions.length > 0
      ? sc.assumptions.map((a) => `- ${a}`).join("\n")
      : `- ${DASH}`,
  );
  lines.push("");
  lines.push("What would have to be true:");
  lines.push("");
  lines.push(
    sc.whatWouldHaveToBeTrue.length > 0
      ? sc.whatWouldHaveToBeTrue.map((w) => `- ${w}`).join("\n")
      : `- ${DASH}`,
  );
  return lines.join("\n");
}

function renderQuality(q: Quality): string {
  const lines: string[] = ["## 6. Quality & Red Flags", ""];
  lines.push(gradeBlock("Quality", q.graded), "");
  const fs = q.forensicScores;
  lines.push(
    "### Forensic scores",
    "",
    table(
      ["Battery", "Variant", "Score", "Zone"],
      [
        ["Altman Z", fs.altman.variant, num(fs.altman.score, 2), fs.altman.zone ?? DASH],
        ["Beneish M", fs.beneish.variant, num(fs.beneish.score, 2), fs.beneish.zone ?? DASH],
        ["Piotroski F", fs.piotroski.variant, num(fs.piotroski.score, 0), fs.piotroski.zone ?? DASH],
        ["Accruals", fs.accruals.variant, num(fs.accruals.score, 2), fs.accruals.zone ?? DASH],
      ],
    ),
    "",
  );
  lines.push(
    "### Flags",
    "",
    q.flags.length > 0
      ? table(
          ["Severity", "Flag", "Source"],
          q.flags.map((f) => [f.severity, f.text, f.source]),
        )
      : `_No forensic flags raised._`,
  );
  return lines.join("\n");
}

function renderTechnicals(t: Technicals): string {
  const lines: string[] = ["## 7. Technicals", ""];
  lines.push(gradeBlock("Technicals", t.graded), "");
  lines.push(
    "### Structured read",
    "",
    `- **Trend:** ${t.read.trend}`,
    `- **Momentum:** ${t.read.momentum}`,
    `- **Key levels:** ${t.read.keyLevels}`,
    `- **Relative strength:** ${t.read.relativeStrength}`,
    "",
  );
  if (t.indicators.length > 0) {
    lines.push(
      "### Indicators",
      "",
      table(
        ["Indicator", "Value", "As of", "Cited"],
        t.indicators.map((n) => [
          n.source,
          tracedValue(n),
          n.asOf ?? DASH,
          verifiedMark(n),
        ]),
      ),
      "",
    );
  }
  if (t.flags.length > 0) {
    lines.push(
      "### Flags",
      "",
      table(
        ["Severity", "Flag", "Source"],
        t.flags.map((f) => [f.severity, f.text, f.source]),
      ),
    );
  }
  return lines.join("\n").trimEnd();
}

function renderLeadership(l: Leadership): string {
  const lines: string[] = ["## 8. Leadership & Governance", ""];
  lines.push(gradeBlock("Leadership", l.graded), "");
  lines.push("### Executives", "");
  for (const e of l.executives) {
    lines.push(
      `#### ${e.name} — ${e.title}`,
      "",
      `Grade **${e.grade}** · credibility **${e.credibilityGrade}**${
        e.tenureYears === null ? "" : ` · tenure ${e.tenureYears.toFixed(1)}y`
      }`,
      "",
      claimList(e.reasoning),
      "",
    );
  }
  lines.push("### Insider activity", "", claimList(l.insiderSummary), "");
  lines.push("### Governance", "", claimList(l.governanceNotes));
  return lines.join("\n");
}

function renderCompetitive(c: Competitive): string {
  const lines: string[] = ["## 9. Competitive Landscape", ""];
  lines.push(gradeBlock("Moat", c.moatGraded), "");
  lines.push("### Peer table", "");
  if (c.peerTable.length > 0) {
    // Peers carry a free-form metrics list; render name + symbol + each metric.
    const maxMetrics = c.peerTable.reduce((m, p) => Math.max(m, p.metrics.length), 0);
    const headers = [
      "Peer",
      "Symbol",
      ...Array.from({ length: maxMetrics }, (_, i) => `Metric ${i + 1}`),
    ];
    const rows = c.peerTable.map((p) => [
      p.name,
      p.symbol ?? DASH,
      ...Array.from({ length: maxMetrics }, (_, i) =>
        p.metrics[i] ? tracedValue(p.metrics[i]) : DASH,
      ),
    ]);
    lines.push(table(headers, rows), "");
  } else {
    lines.push(`_No peer data._`, "");
  }
  lines.push("### Moat assessment", "");
  for (const m of c.moatAssessment) {
    lines.push(`- **${m.source}** (${m.strength}): ${m.reasoning.map((r) => r.text).join(" ")}`);
  }
  lines.push("", "### Market-share direction", "", c.marketShareDirection);
  return lines.join("\n");
}

function renderCatalystsRisks(cr: CatalystsRisks): string {
  const lines: string[] = ["## 10. Catalysts & Risks", ""];
  lines.push(
    "### Catalysts",
    "",
    table(
      ["Catalyst", "Expected", "Direction", "Significance", "Note"],
      cr.catalysts.map((c) => [
        c.title,
        c.expectedDate ?? DASH,
        c.direction,
        c.significance,
        c.reasoning.text,
      ]),
    ),
    "",
  );
  lines.push(
    "### Risks",
    "",
    table(
      ["Risk", "Severity", "Probability", "Source", "Note"],
      cr.risks.map((r) => [
        r.title,
        r.severity,
        r.probability,
        r.source,
        r.reasoning.text,
      ]),
    ),
  );
  return lines.join("\n");
}

function renderOutlook(report: Report): string {
  const o = report.outlook;
  const lines: string[] = ["## 11. Future Outlook", ""];
  lines.push("### Segment trajectories", "", claimList(o.segmentTrajectories), "");
  if (o.tam && o.tam.length > 0) {
    lines.push("### TAM", "", claimList(o.tam), "");
  }
  lines.push(
    "### Estimate-revision trend",
    "",
    claimList(o.estimateRevisionTrend),
    "",
  );
  lines.push("### Guidance credibility", "", claimList(o.guidanceCredibility), "");
  lines.push("### Scenario narratives", "");
  lines.push("", "**1-year**", "", claimList(o.scenarioNarratives.y1), "");
  lines.push("**3-year**", "", claimList(o.scenarioNarratives.y3), "");
  lines.push("**5-year**", "", claimList(o.scenarioNarratives.y5));
  return lines.join("\n");
}

function renderMacro(m: Macro): string {
  const lines: string[] = ["## 12. Macro Context", ""];
  lines.push(
    table(
      ["Series", "Name", "Latest", "As of", "Relevance"],
      m.relevantSeries.map((s) => [
        s.seriesId,
        s.name,
        tracedValue(s.latest),
        s.latest.asOf ?? DASH,
        s.relevance,
      ]),
    ),
    "",
  );
  if (m.sensitivityNotes.length > 0) {
    lines.push("### Sensitivity notes", "", claimList(m.sensitivityNotes), "");
  }
  // Mandatory FRED attribution, verbatim.
  lines.push(`> ${m.fredAttribution}`);
  return lines.join("\n");
}

function renderDisagreements(disagreements: readonly Disagreement[]): string {
  if (disagreements.length === 0) return "";
  const lines: string[] = ["### Bull/bear disagreements", ""];
  for (const d of disagreements) {
    lines.push(
      `- **${d.topic}** (${d.kind})`,
      `  - Bull: ${d.bullView}`,
      `  - Bear: ${d.bearView}`,
      `  - Judge: ${d.judgeResolution}`,
    );
  }
  return lines.join("\n");
}

function renderAppendix(a: Appendix): string {
  const lines: string[] = ["## 13. Appendix", ""];
  lines.push(
    "### Sources",
    "",
    table(
      ["Provider", "Endpoint", "As of", "Fetched at"],
      a.sources.map((s) => [s.provider, s.endpoint, s.asOf, s.fetchedAt]),
    ),
    "",
  );
  lines.push(
    "### Missing-data manifest",
    "",
    a.missingData.length > 0
      ? table(
          ["Field", "Severity", "Reason", "Tried"],
          a.missingData.map((g) => [
            g.field,
            g.severity,
            g.reason,
            g.attemptedSources ? g.attemptedSources.join(", ") : DASH,
          ]),
        )
      : `_No gaps — full data coverage._`,
    "",
  );
  lines.push(
    "### Citation coverage",
    "",
    `Citation coverage: **${
      a.verificationRate === null
        ? DASH
        : `${(a.verificationRate * 100).toFixed(0)}%`
    }** — share of report figures traceable to a citation or payload value; a provenance check, not a correctness/accuracy check.`,
    "",
  );
  if (a.provenanceCoverage) {
    lines.push(provenanceCoverageTable(a.provenanceCoverage), "");
  }
  if (a.verificationLog && a.verificationLog.length > 0) {
    lines.push(
      table(
        ["Claim", "Outcome", "Note"],
        a.verificationLog.map((v) => [v.claim, citationOutcomeLabel(v.outcome), v.note ?? DASH]),
      ),
      "",
    );
  }
  const totalCost = a.costBreakdown.reduce((s, e) => s + e.costUsd, 0);
  lines.push(
    "### Cost breakdown",
    "",
    table(
      ["Step", "Model", "Cost (USD)"],
      a.costBreakdown.map((e) => [e.step, e.model, `$${e.costUsd.toFixed(4)}`]),
    ),
    "",
    `Total: **$${totalCost.toFixed(4)}**`,
  );
  return lines.join("\n");
}

/* ======================================================================== *
 * Header / meta
 * ======================================================================== */

function renderHeader(report: Report): string {
  const m = report.meta;
  const lines: string[] = [];
  lines.push(`# ${m.companyName} (${m.symbol}) — Research Report`);
  lines.push("");
  lines.push(
    table(
      ["Field", "Value"],
      [
        ["Generated", m.generatedAt],
        ["Model", m.model],
        // Legacy reports carry a verifyModel label (removed setting) — keep it.
        ...(m.verifyModel !== undefined ? [["Verify model", m.verifyModel]] : []),
        ["Spec version", m.specVersion],
        ["Pipeline version", m.pipelineVersion],
        ["Cost (USD)", `$${m.costUsd.toFixed(4)}`],
        [
          "Citation coverage",
          m.verificationRate === null
            ? DASH
            : `${(m.verificationRate * 100).toFixed(0)}%`,
        ],
      ],
    ),
  );
  lines.push("");
  // Mandatory disclaimer, verbatim.
  lines.push(`> ${m.disclaimer}`);
  return lines.join("\n");
}

/** As-of map, rendered with SORTED keys for deterministic output. */
function renderAsOfMap(asOfMap: Record<string, string>): string {
  const keys = Object.keys(asOfMap).sort();
  if (keys.length === 0) return "";
  return [
    "### As-of map",
    "",
    table(
      ["Field", "As of"],
      keys.map((k) => [k, asOfMap[k]]),
    ),
  ].join("\n");
}

/* ======================================================================== *
 * Small helpers
 * ======================================================================== */

function uniqueSorted(values: readonly number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/* ======================================================================== *
 * reportToMarkdown — the public entry point
 * ======================================================================== */

/**
 * Render a full {@link Report} to a complete, deterministic Markdown document.
 * Every SPEC §7 section, the appendix, the disclaimer, and the FRED attribution
 * are present; every figure carries its as-of and verification state.
 */
export function reportToMarkdown(report: Report): string {
  const blocks: string[] = [
    renderHeader(report),
    renderVerdict(report),
    report.scores ? renderScores(report.scores) : "",
    renderBusiness(report.business),
    renderFundamentals(report.fundamentals),
    renderBalanceSheet(report.balanceSheet),
    renderValuation(report.valuation, report.scenarioTargets, report.fairValue),
    renderQuality(report.quality),
    renderTechnicals(report.technicals),
    renderLeadership(report.leadership),
    renderCompetitive(report.competitive),
    renderCatalystsRisks(report.catalystsRisks),
    renderOutlook(report),
    report.projections ? renderProjections(report.projections) : "",
    renderMacro(report.macro),
    renderDisagreements(report.disagreements),
    renderAppendix(report.appendix),
    renderAsOfMap(report.meta.asOfMap),
  ].filter((b) => b.length > 0);

  // Join sections with a blank-line-separated horizontal rule for readability;
  // ensure a single trailing newline for a clean file.
  return blocks.join("\n\n---\n\n") + "\n";
}

/** Constants re-exported so callers/tests can assert on them without a second import. */
export { DISCLAIMER_TEXT, FRED_ATTRIBUTION_TEXT };
