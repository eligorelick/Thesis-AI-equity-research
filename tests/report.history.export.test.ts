/**
 * Report history + Markdown export tests.
 *
 * Node-side pure logic, persistence, and route-used SSR coverage:
 *   - reportToMarkdown on the DEMO fixture: disclaimer, FRED attribution, all
 *     section headers, scenario probabilities, verification rate, no unresolved
 *     "[object Object]", and determinism (same input → same output);
 *   - listReportsForSymbol / getReportById against an in-memory sqlite with
 *     seeded rows: grade extraction, ReportSchema validation, dataOnly detection,
 *     newest-first ordering, malformed-row tolerance;
 *   - parseReportId (strict digits-only URL-id parsing — rejects everything a
 *     lax parseInt would truncate to a different report);
 *   - getReportRecordById (missing vs unparseable vs ok — the 404/422 split);
 *   - loadReportPair / loadReportPairForSymbol (cross-company scoping) +
 *     orderPairChronologically + a diffReports smoke on two tweaked copies of
 *     the fixture.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @/report/history imports the `server-only` shim (a Next-build-time module
// absent under the plain-node test runner). Stub it to a no-op so the module
// graph resolves — it has no runtime behavior. (Same pattern as watchlist.test.)
vi.mock("server-only", () => ({}));

import {
  createDatabase,
  setDbForTests,
  type DatabaseHandle,
} from "@/db";
import { reports } from "@/db/schema";
import {
  ReportSchema,
  REPORT_SPEC_VERSION,
  type ProjectionPoint,
  type Report,
} from "@/report/schema";
import {
  reportToMarkdown,
  DISCLAIMER_TEXT,
  FRED_ATTRIBUTION_TEXT,
} from "@/report/export/markdown";
import { reportToPrintHtml } from "@/report/export/printHtml";
import {
  listReportsForSymbol,
  listRunRefsForSymbol,
  getReportById,
  getReportByIdForSymbol,
  getReportRecordById,
  parseStoredReport,
  loadReportPair,
  loadReportPairForSymbol,
  orderPairChronologically,
  extractGradeStrip,
  isDataOnly,
  parseReportId,
  GRADE_STRIP_KEYS,
} from "@/report/history";
import { diffReports } from "@/report/diff";
import { AppendixSection } from "@/components/report/sections";

/* ------------------------------------------------------------------------ *
 * Fixture loading + small mutation helpers
 * ------------------------------------------------------------------------ */

const FIXTURE_PATH = path.join(
  process.cwd(),
  "fixtures",
  "report",
  "DEMO-sample.json",
);

function loadFixtureReport(): Report {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const parsed = ReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `fixture must parse: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/** Structured clone via JSON so mutations never touch the shared fixture. */
function clone(report: Report): Report {
  return JSON.parse(JSON.stringify(report)) as Report;
}

function persistedVersions(
  older: Report,
  newer: Report,
  overrides: Partial<{
    fromReportVersion: string;
    toReportVersion: string;
    fromSpecVersion: string | null;
    toSpecVersion: string | null;
  }> = {},
) {
  return {
    fromReportVersion: older.meta.pipelineVersion,
    toReportVersion: newer.meta.pipelineVersion,
    fromSpecVersion: older.meta.specVersion,
    toSpecVersion: newer.meta.specVersion,
    ...overrides,
  };
}

type RuntimeWeightMap = Record<string, number | null | undefined>;
type RuntimeTrace = Report["scores"] extends infer S
  ? S extends { aspects: Record<string, { drivers: Array<infer D> }> }
    ? Omit<D, "value"> & { value: number | null }
    : never
  : never;

function runtimeWeights(report: Report): RuntimeWeightMap {
  return report.scores!.composite.weights as unknown as RuntimeWeightMap;
}

function runtimeDrivers(report: Report): Array<{ aspect: string; driver: RuntimeTrace }> {
  return Object.entries(report.scores!.aspects).flatMap(([aspect, score]) =>
    score.drivers.map((driver) => ({ aspect, driver: driver as RuntimeTrace })),
  );
}

/** Turn a full report into a data-only one (adds the analysis.llm gap entry). */
function makeDataOnly(report: Report): Report {
  const r = clone(report);
  r.appendix.missingData = [
    ...r.appendix.missingData,
    {
      field: "analysis.llm",
      reason: "no ANTHROPIC_API_KEY — data-only report",
      severity: "warn",
    },
  ];
  return r;
}

/* ------------------------------------------------------------------------ *
 * DB seeding
 * ------------------------------------------------------------------------ */

let handle: DatabaseHandle;

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
});

afterEach(() => {
  setDbForTests(null);
  handle.sqlite.close();
});

interface SeedOpts {
  id?: number;
  symbol?: string;
  createdAt: string;
  model?: string;
  status?: string;
  report?: Report | null;
  reportJson?: string | null; // raw override (for malformed rows)
  verificationRate?: number | null;
  costUsd?: number | null;
  specVersion?: string | null;
}

function seedReport(opts: SeedOpts): number {
  const rowSymbol = opts.symbol ?? "AAPL";
  const coherentReport = opts.report === null || opts.report === undefined
    ? opts.report
    : (() => {
        const report = clone(opts.report!);
        report.meta.symbol = rowSymbol;
        return report;
      })();
  const json =
    opts.reportJson !== undefined
      ? opts.reportJson
      : coherentReport === null || coherentReport === undefined
        ? null
        : JSON.stringify(coherentReport);
  const row = handle.db
    .insert(reports)
    .values({
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      symbol: rowSymbol,
      createdAt: opts.createdAt,
      model: opts.model ?? "claude-opus-4-8",
      status: opts.status ?? "done",
      reportJson: json,
      verificationRate: opts.verificationRate ?? null,
      costUsd: opts.costUsd ?? null,
      specVersion: opts.specVersion === undefined ? REPORT_SPEC_VERSION : opts.specVersion,
    })
    .returning({ id: reports.id })
    .get();
  return row.id;
}

/* ======================================================================== *
 * reportToMarkdown
 * ======================================================================== */

describe("reportToMarkdown", () => {
  const report = loadFixtureReport();
  const md = reportToMarkdown(report);

  it("contains the mandatory disclaimer and FRED attribution verbatim", () => {
    expect(md).toContain(DISCLAIMER_TEXT);
    expect(md).toContain(FRED_ATTRIBUTION_TEXT);
    // And the schema literals match the exported constants.
    expect(report.meta.disclaimer).toBe(DISCLAIMER_TEXT);
    expect(report.macro.fredAttribution).toBe(FRED_ATTRIBUTION_TEXT);
  });

  it("renders source envelopes in Markdown and React appendices", () => {
    const r = clone(report);
    r.appendix.sources = [
      {
        provider: "fmp",
        endpoint: "/stable/treasury-rates",
        asOf: "2026-07-04",
        fetchedAt: "2026-07-05T18:30:00.000Z",
        stale: true,
      },
    ];

    const renderedMarkdown = reportToMarkdown(r);
    expect(renderedMarkdown).toContain(
      "| fmp | /stable/treasury-rates | 2026-07-04 | 2026-07-05T18:30:00.000Z | yes |",
    );

    const renderedReact = renderToStaticMarkup(
      createElement(AppendixSection, {
        appendix: r.appendix,
        disagreements: [],
        index: 13,
      }),
    );
    expect(renderedReact).toContain("/stable/treasury-rates");
    expect(renderedReact).toContain(">stale<");
    expect(renderedReact).toContain(">yes<");
  });

  it("renders every SPEC §7 section header", () => {
    for (const header of [
      "# Thesis Example Systems (DEMO)",
      "## 1. Verdict",
      "## 2. Business & Segments",
      "## 3. Fundamentals",
      "## 4. Balance Sheet & Capital",
      "## 5. Valuation",
      "## 6. Quality & Red Flags",
      "## 7. Technicals",
      "## 8. Leadership & Governance",
      "## 9. Competitive Landscape",
      "## 10. Catalysts & Risks",
      "## 11. Future Outlook",
      "## 12. Macro Context",
      "## 13. Appendix",
    ]) {
      expect(md).toContain(header);
    }
  });

  it("includes each scenario name and its probability", () => {
    // bull 25% / base 50% / bear 25% from the fixture.
    expect(md).toMatch(/Bull — target .* \(p = 25%/);
    expect(md).toMatch(/Base — target .* \(p = 50%/);
    expect(md).toMatch(/Bear — target .* \(p = 25%/);
  });

  it("renders 'unavailable' for a scenario whose deterministic target is suppressed (null) — no crash / NaN", () => {
    const r = clone(report);
    for (const s of r.valuation.scenarios) s.priceTarget = null;
    const out = reportToMarkdown(ReportSchema.parse(r));
    expect(out).toMatch(/Base — target unavailable/i);
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
  });

  it("discloses the deterministic method (computed-derived, not analyst targets) when targets are available", () => {
    const r = clone(report);
    r.scenarioTargets = {
      status: "available",
      method: "dcf-dispersion",
      methodVersion: "SCENARIO_TARGETS_2026_07",
      basis: ["base target = the deterministic FCFF-DCF fair value per share.", "bull/bear shift growth and margin ±1σ of the company's own history."],
      dispersion: { growthSigmaPp: 8, marginSigmaPp: 3, sigmaSource: "own-history" },
      targets: [],
      missingReasons: [],
    };
    const out = reportToMarkdown(ReportSchema.parse(r));
    expect(out).toMatch(/computed-derived/i);
    expect(out).toContain("deterministic FCFF-DCF fair value");
  });

  it("labels the traced-number table column 'Cited', never 'Verified' (citation coverage is provenance, not correctness)", () => {
    expect(md).toContain("| As of | Cited |");
    expect(md).not.toContain("Verified");
  });

  it("renders 'unavailable' for a suppressed (null) DCF per-share — no crash / NaN", () => {
    const r = clone(report);
    r.valuation.dcf.perShare = null;
    r.valuation.dcf.upsidePct = null;
    const out = reportToMarkdown(ReportSchema.parse(r));
    expect(out).toMatch(/Intrinsic value per share:\s*\*\*unavailable\*\*/i);
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
  });

  it("renders empty DCF assumptions + no sensitivity grid honestly when the route has no FCFF DCF", () => {
    const r = clone(report);
    r.valuation.dcf.assumptions = [];
    r.valuation.dcf.sensitivityGrid = [];
    const out = reportToMarkdown(ReportSchema.parse(r));
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
    // The assumptions block still renders (empty table); no fabricated grid rows.
    expect(out).toContain("Assumptions:");
  });

  it("renders the deterministic DCF assumptions with their computed basis", () => {
    const r = clone(report);
    r.valuation.dcf.assumptions = [
      { name: "sales-to-capital", value: "2.50", basis: "TTM revenue / invested capital (deterministic)" },
    ];
    const out = reportToMarkdown(ReportSchema.parse(r));
    expect(out).toContain("sales-to-capital");
    expect(out).toContain("TTM revenue / invested capital (deterministic)");
  });

  it("discloses the fair-value method (e.g. excess-return for banks, under a DCF header)", () => {
    const r = clone(report);
    r.fairValue = {
      status: "available",
      method: "excess-return",
      methodVersion: "FAIR_VALUE_2026_07",
      perShare: { value: 55, unit: "USD/share", source: "computed.valuation.excessReturn.perShare", asOf: "2026-07-06", verified: true },
      upsidePct: 3,
      basis: ["Intrinsic value per share = the deterministic book-value excess-return fair value (no WACC/FCFF)."],
      reasons: [],
    };
    r.valuation.dcf.perShare = { value: 55, unit: "USD/share", source: "computed.valuation.excessReturn.perShare", asOf: "2026-07-06", verified: true };
    const out = reportToMarkdown(ReportSchema.parse(r));
    expect(out).toContain("book-value excess-return fair value");
  });

  it("discloses the suppression reason when scenario targets are unavailable", () => {
    const r = clone(report);
    for (const s of r.valuation.scenarios) s.priceTarget = null;
    r.scenarioTargets = {
      status: "suppressed",
      method: "dcf-dispersion",
      methodVersion: "SCENARIO_TARGETS_2026_07",
      basis: ["Scenario price targets unavailable: the base DCF per-share is not computable."],
      dispersion: null,
      targets: [],
      missingReasons: [{ field: "valuation.scenarioTargets", reason: "base DCF per-share unavailable", severity: "warn" }],
    };
    const out = reportToMarkdown(ReportSchema.parse(r));
    expect(out).toContain("base DCF per-share unavailable");
  });

  it("reports citation coverage as a percentage", () => {
    // The synthetic fixture pins the backwards-compatible field to 0.92.
    // (Field name is kept for backward-compat; the LABEL is citation coverage.)
    expect(md).toContain("Citation coverage: **92%**");
  });

  it("exports the explicit numeric, factual-claim, and judgment coverage denominators", () => {
    const r = clone(loadFixtureReport());
    const coverage = {
      numeric: { supported: 8, total: 10, rate: 0.8 },
      factualClaims: { supported: 3, total: 4, rate: 0.75 },
      judgments: { cited: 0, total: 0, rate: null },
    };
    r.meta.provenanceCoverage = coverage;
    r.appendix.provenanceCoverage = coverage;
    const out = reportToMarkdown(ReportSchema.parse(r));
    expect(out).toContain("Numeric provenance");
    expect(out).toContain("8/10 (80%)");
    expect(out).toContain("Factual-claim citations");
    expect(out).toContain("3/4 (75%)");
    expect(out).toContain("Judgment citations");
    expect(out).toContain("0/0 (n/a — no items)");
  });

  it("marks untraced numbers with a bare 'uncited' cell, never 'unverified' (audit #2)", () => {
    // Citation coverage is provenance, not correctness — the per-number table
    // mark must not present a status of "unverified". (The verification-log NOTE
    // may still read "[unverified] ..." as the flag reason; that is an
    // explanation, not a status claim, so it is deliberately not matched here.)
    expect(md).not.toMatch(/\|\s*unverified\s*\|/);
    expect(md).toMatch(/\|\s*uncited\s*\|/);
  });

  it("has no unresolved [object Object] or [object … ] artifacts", () => {
    expect(md).not.toContain("[object Object]");
    expect(md).not.toMatch(/\[object [A-Z]/);
  });

  it("renders traced figures, not raw JSON — e.g. DCF per share as currency", () => {
    // Fixture DCF per share is 48 with unit "usd".
    expect(md).toContain("$48.00");
    // A percentage-unit figure renders with a % suffix, not a bare object.
    expect(md).toContain("60.0%");
    // Large monetary values render through the compact scale.
    expect(md).toContain("$7.50B");
    expect(md).toContain("$5.00B");
  });

  it("renders every FACT/ESTIMATE/JUDGMENT claim label", () => {
    expect(md).toContain("[FACT]");
    expect(md).toContain("[ESTIMATE]");
    expect(md).toContain("[JUDGMENT]");
  });

  it("renders the as-of map with SORTED keys (deterministic)", () => {
    // Scope the ordering check to the "As-of map" section (these dot-paths also
    // appear earlier as claim sources), then assert the three keys are sorted.
    const section = md.slice(md.indexOf("### As-of map"));
    const idx = (k: string) => section.indexOf(k);
    // fixture asOfMap keys sort to: computed… < quote… < valuation…
    expect(idx("computed.growth.revenueCagr5y")).toBeGreaterThan(-1);
    expect(idx("computed.growth.revenueCagr5y")).toBeLessThan(idx("quote.price"));
    expect(idx("quote.price")).toBeLessThan(idx("valuation.dcf.perShare"));
  });

  it("renders the 1.1.0 scorecard, executive summary, interpretation, and projections", () => {
    expect(md).toContain("## 1b. Scorecard (deterministic)");
    expect(md).toContain("**Composite:");
    expect(md).toContain("### Executive summary");
    expect(md).toContain("## 11b. Weighted Projections");
    expect(md).toMatch(/### Revenue \(USD\)/);
    // Balance sheet is now a graded aspect.
    expect(md).toContain("Balance Sheet & Capital — Grade");
    // The forward-values table has the four scenario columns.
    expect(md).toContain("| Period | Bull | Base | Weighted | Bear |");
  });

  it("does not crash when an in-memory projection has unequal scenario arrays", () => {
    const malformed = clone(report);
    if (!malformed.projections || malformed.projections.series.length === 0) {
      throw new Error("fixture must carry projections");
    }
    malformed.projections.series[0]!.bull = malformed.projections.series[0]!.bull.slice(0, 1);
    expect(() => reportToMarkdown(malformed)).not.toThrow();
  });

  it("collapses claim newlines so bullet formatting remains one claim per line", () => {
    const malformed = clone(report);
    const firstClaim = malformed.verdict.executiveSummary?.[0];
    if (!firstClaim) throw new Error("fixture must carry an executive-summary claim");
    malformed.verdict.executiveSummary = [
      { ...firstClaim, text: "first\r\nsecond\rthird\nfourth" },
    ];
    const rendered = reportToMarkdown(malformed);
    expect(rendered).toContain("first second third fourth");
    expect(rendered).not.toContain("first\nsecond");
  });

  it("is deterministic — same input yields byte-identical output", () => {
    const a = reportToMarkdown(loadFixtureReport());
    const b = reportToMarkdown(loadFixtureReport());
    expect(a).toBe(b);
    // And re-rendering the already-parsed instance matches too.
    expect(reportToMarkdown(report)).toBe(md);
  });

  it("ends with a single trailing newline", () => {
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });
});

/* ======================================================================== *
 * history queries — extraction helpers
 * ======================================================================== */

describe("grade extraction + data-only detection", () => {
  const report = loadFixtureReport();

  it("extractGradeStrip returns the six sections in fixed order", () => {
    const strip = extractGradeStrip(report);
    expect(strip.map((c) => c.key)).toEqual([...GRADE_STRIP_KEYS]);
    // Grades match the fixture's strip.
    const byKey = Object.fromEntries(strip.map((c) => [c.key, c.grade]));
    expect(byKey.fundamentals).toBe("A");
    expect(byKey.valuation).toBe("C");
    expect(byKey.technicals).toBe("B");
    expect(byKey.moat).toBe("A");
  });

  it("isDataOnly is false for a full report, true once analysis.llm is missing", () => {
    expect(isDataOnly(report)).toBe(false);
    expect(isDataOnly(makeDataOnly(report))).toBe(true);
  });
});

/* ======================================================================== *
 * listReportsForSymbol
 * ======================================================================== */

describe("listReportsForSymbol", () => {
  it("returns rows newest-first with parsed grade strips + metadata", () => {
    const report = loadFixtureReport();
    seedReport({
      symbol: "AAPL",
      createdAt: "2026-05-01T10:00:00.000Z",
      report,
      verificationRate: 0.9,
      costUsd: 2.1,
    });
    seedReport({
      symbol: "AAPL",
      createdAt: "2026-07-05T14:22:31.000Z",
      report,
      verificationRate: 0.94,
      costUsd: 2.18,
    });

    const list = listReportsForSymbol("AAPL");
    expect(list).toHaveLength(2);
    // Newest first.
    expect(list[0].createdAt).toBe("2026-07-05T14:22:31.000Z");
    expect(list[1].createdAt).toBe("2026-05-01T10:00:00.000Z");
    // Grade strip parsed.
    expect(list[0].gradeStrip).not.toBeNull();
    expect(list[0].gradeStrip?.map((c) => c.key)).toEqual([...GRADE_STRIP_KEYS]);
    expect(list[0].verificationRate).toBe(0.94);
    expect(list[0].costUsd).toBe(2.18);
    expect(list[0].dataOnly).toBe(false);
  });

  it("only returns rows for the requested symbol", () => {
    const report = loadFixtureReport();
    seedReport({ symbol: "AAPL", createdAt: "2026-07-01T00:00:00.000Z", report });
    seedReport({ symbol: "MSFT", createdAt: "2026-07-02T00:00:00.000Z", report });
    expect(listReportsForSymbol("AAPL")).toHaveLength(1);
    expect(listReportsForSymbol("MSFT")).toHaveLength(1);
    expect(listReportsForSymbol("NVDA")).toHaveLength(0);
  });

  it("lists canonical dot-hyphen alias rows from either route spelling", () => {
    const dot = loadFixtureReport();
    dot.meta.symbol = "BRK.B";
    const id = seedReport({
      symbol: "BRK-B",
      createdAt: "2026-07-02T00:00:00.000Z",
      reportJson: JSON.stringify(dot),
    });
    expect(listReportsForSymbol("BRK.B").map((row) => row.id)).toEqual([id]);
    expect(listReportsForSymbol("BRK-B").map((row) => row.id)).toEqual([id]);
  });

  it("flags a data-only report and tolerates a malformed row", () => {
    const report = loadFixtureReport();
    seedReport({
      symbol: "AAPL",
      createdAt: "2026-07-03T00:00:00.000Z",
      report: makeDataOnly(report),
    });
    // A malformed reportJson row still lists, with null grade strip / dataOnly.
    seedReport({
      symbol: "AAPL",
      createdAt: "2026-07-04T00:00:00.000Z",
      reportJson: "{ this is not valid json",
      status: "error",
    });
    // A row with null reportJson (never produced content).
    seedReport({
      symbol: "AAPL",
      createdAt: "2026-07-02T00:00:00.000Z",
      reportJson: null,
      status: "running",
    });

    const list = listReportsForSymbol("AAPL");
    expect(list).toHaveLength(3);
    const byDate = Object.fromEntries(list.map((r) => [r.createdAt.slice(0, 10), r]));

    expect(byDate["2026-07-03"].dataOnly).toBe(true);
    expect(byDate["2026-07-03"].gradeStrip).not.toBeNull();

    expect(byDate["2026-07-04"].gradeStrip).toBeNull();
    expect(byDate["2026-07-04"].dataOnly).toBeNull();
    expect(byDate["2026-07-04"].status).toBe("error");

    expect(byDate["2026-07-02"].gradeStrip).toBeNull();
    expect(byDate["2026-07-02"].dataOnly).toBeNull();
  });
});

/* ======================================================================== *
 * listRunRefsForSymbol — every run kept as a distinct row (no overwrite)
 * ======================================================================== */

describe("listRunRefsForSymbol", () => {
  it("returns every run for a symbol newest-first — re-running never overwrites", () => {
    const report = loadFixtureReport();
    // Same symbol "run" three times → three distinct rows.
    const first = seedReport({ symbol: "AAPL", createdAt: "2026-05-01T10:00:00.000Z", report });
    const second = seedReport({ symbol: "AAPL", createdAt: "2026-06-15T09:30:00.000Z", report });
    const third = seedReport({ symbol: "AAPL", createdAt: "2026-07-05T14:22:31.000Z", report });

    const runs = listRunRefsForSymbol("AAPL");
    // Every run is preserved as its own row (distinct ids, none overwritten).
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((r) => r.id)).size).toBe(3);
    expect(runs.map((r) => r.id)).toEqual([third, second, first]); // newest-first
    // Lean shape: id / createdAt / status only (no reportJson parse).
    expect(runs[0]).toEqual({
      id: third,
      createdAt: "2026-07-05T14:22:31.000Z",
      status: "done",
    });
  });

  it("lists a run even when its stored content is unparseable (no JSON parse)", () => {
    seedReport({
      symbol: "TSLA",
      createdAt: "2026-07-01T00:00:00.000Z",
      reportJson: "{ broken",
      status: "error",
    });
    seedReport({
      symbol: "TSLA",
      createdAt: "2026-07-02T00:00:00.000Z",
      reportJson: null,
      status: "running",
    });
    const runs = listRunRefsForSymbol("TSLA");
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.status)).toEqual(["running", "error"]); // newest-first
  });

  it("only returns runs for the requested symbol", () => {
    const report = loadFixtureReport();
    seedReport({ symbol: "AAPL", createdAt: "2026-07-01T00:00:00.000Z", report });
    seedReport({ symbol: "MSFT", createdAt: "2026-07-02T00:00:00.000Z", report });
    expect(listRunRefsForSymbol("AAPL")).toHaveLength(1);
    expect(listRunRefsForSymbol("NVDA")).toHaveLength(0);
  });

  it("lists run refs through either canonical dot-hyphen alias", () => {
    const dot = loadFixtureReport();
    dot.meta.symbol = "BRK.B";
    const id = seedReport({
      symbol: "BRK-B",
      createdAt: "2026-07-02T00:00:00.000Z",
      reportJson: JSON.stringify(dot),
    });
    expect(listRunRefsForSymbol("BRK.B").map((row) => row.id)).toEqual([id]);
    expect(listRunRefsForSymbol("BRK-B").map((row) => row.id)).toEqual([id]);
  });
});

/* ======================================================================== *
 * parseReportId — the strict URL-id trust boundary
 * ======================================================================== */

describe("parseReportId", () => {
  it("accepts a plain run of digits", () => {
    expect(parseReportId("12")).toBe(12);
    expect(parseReportId("0")).toBe(0);
    expect(parseReportId("007")).toBe(7); // leading zeros are still digits
  });

  it("accepts up to 15 digits (safe-integer cap) and rejects 16", () => {
    expect(parseReportId("999999999999999")).toBe(999_999_999_999_999);
    expect(parseReportId("9999999999999999")).toBeNull();
    expect(parseReportId("1".repeat(200))).toBeNull();
  });

  it("rejects everything lax parseInt would have truncated or coerced", () => {
    // parseInt("12abc") === 12, parseInt("12.9") === 12, parseInt("1e5") === 1:
    // each would silently resolve to a DIFFERENT report. Strict parse: null.
    expect(parseReportId("12abc")).toBeNull();
    expect(parseReportId("12.9")).toBeNull();
    expect(parseReportId("1e5")).toBeNull();
    expect(parseReportId("")).toBeNull();
    expect(parseReportId("-5")).toBeNull();
    expect(parseReportId("+5")).toBeNull();
    expect(parseReportId(" 12")).toBeNull();
    expect(parseReportId("12 ")).toBeNull();
    expect(parseReportId("0x1f")).toBeNull();
    expect(parseReportId("Infinity")).toBeNull();
    expect(parseReportId(undefined)).toBeNull();
    expect(parseReportId(null)).toBeNull();
  });
});

/* ======================================================================== *
 * getReportById / getReportRecordById + loadReportPair + ordering
 * ======================================================================== */

describe("getReportRecordById", () => {
  it("returns kind 'ok' with row + parsed report for a valid id", () => {
    const report = loadFixtureReport();
    const id = seedReport({ createdAt: "2026-07-05T00:00:00.000Z", report });
    const record = getReportRecordById(id);
    expect(record.kind).toBe("ok");
    if (record.kind === "ok") {
      expect(record.row.id).toBe(id);
      expect(record.report.meta.symbol).toBe("AAPL");
    }
  });

  it("returns kind 'missing' for an unknown id", () => {
    expect(getReportRecordById(999999)).toEqual({ kind: "missing" });
  });

  it("returns kind 'missing' for non-integer / negative / NaN ids (never a DB error)", () => {
    expect(getReportRecordById(12.5)).toEqual({ kind: "missing" });
    expect(getReportRecordById(-3)).toEqual({ kind: "missing" });
    expect(getReportRecordById(Number.NaN)).toEqual({ kind: "missing" });
  });

  it("returns kind 'unparseable' WITH the row for corrupt stored JSON", () => {
    const id = seedReport({
      createdAt: "2026-07-05T00:00:00.000Z",
      reportJson: "{ this is not valid json",
      status: "done",
    });
    const record = getReportRecordById(id);
    expect(record.kind).toBe("unparseable");
    if (record.kind === "unparseable") {
      expect(record.row.id).toBe(id);
      expect(record.row.status).toBe("done");
    }
  });

  it("returns kind 'unparseable' for JSON that parses but fails ReportSchema", () => {
    const id = seedReport({
      createdAt: "2026-07-05T00:00:00.000Z",
      reportJson: JSON.stringify({ hello: "not a report" }),
    });
    expect(getReportRecordById(id).kind).toBe("unparseable");
  });

  it("returns kind 'unparseable' for a row with null reportJson", () => {
    const id = seedReport({
      createdAt: "2026-07-05T00:00:00.000Z",
      reportJson: null,
      status: "running",
    });
    expect(getReportRecordById(id).kind).toBe("unparseable");
  });

  it("getReportById collapses 'missing' and 'unparseable' to null (back-compat)", () => {
    const corrupt = seedReport({
      createdAt: "2026-07-05T00:00:00.000Z",
      reportJson: "not json",
    });
    expect(getReportById(corrupt)).toBeNull();
    expect(getReportById(999999)).toBeNull();
  });
});

describe("getReportById", () => {
  it("returns the row + parsed report for a valid id", () => {
    const report = loadFixtureReport();
    const id = seedReport({ createdAt: "2026-07-05T00:00:00.000Z", report });
    const loaded = getReportById(id);
    expect(loaded).not.toBeNull();
    expect(loaded?.row.id).toBe(id);
    expect(loaded?.report.meta.symbol).toBe("AAPL");
  });

  it("getReportByIdForSymbol rejects ids that belong to another ticker", () => {
    const report = loadFixtureReport();
    report.meta.symbol = "MSFT";
    const id = seedReport({ symbol: "MSFT", createdAt: "2026-07-05T00:00:00.000Z", report });
    expect(getReportByIdForSymbol(id, "AAPL")).toBeNull();
    expect(getReportByIdForSymbol(id, "msft")?.row.id).toBe(id);
  });

  it("returns null for an unknown id", () => {
    expect(getReportById(999999)).toBeNull();
  });

  it("returns null when the stored JSON is unparseable", () => {
    const id = seedReport({
      createdAt: "2026-07-05T00:00:00.000Z",
      reportJson: "not json",
    });
    expect(getReportById(id)).toBeNull();
  });

  it("returns null for a non-finite id", () => {
    expect(getReportById(Number.NaN)).toBeNull();
  });
});

describe("loadReportPair + orderPairChronologically", () => {
  it("loads two reports and orders them older → newer regardless of arg order", () => {
    const report = loadFixtureReport();
    const older = seedReport({ createdAt: "2026-05-01T00:00:00.000Z", report });
    const newer = seedReport({ createdAt: "2026-07-05T00:00:00.000Z", report });

    // Pass newer first as `a`: loadReportPair preserves arg order...
    const pair = loadReportPair(newer, older);
    expect(pair).not.toBeNull();
    expect(pair?.a.row.id).toBe(newer);
    expect(pair?.b.row.id).toBe(older);

    // ...and orderPairChronologically fixes it (swapped === true).
    const ordered = orderPairChronologically(pair!);
    expect(ordered.older.row.id).toBe(older);
    expect(ordered.newer.row.id).toBe(newer);
    expect(ordered.swapped).toBe(true);

    // In-order input is not swapped.
    const inOrder = loadReportPair(older, newer);
    const ordered2 = orderPairChronologically(inOrder!);
    expect(ordered2.swapped).toBe(false);
    expect(ordered2.older.row.id).toBe(older);
  });

  it("returns null when either id is missing/unparseable", () => {
    const report = loadFixtureReport();
    const ok = seedReport({ createdAt: "2026-07-05T00:00:00.000Z", report });
    expect(loadReportPair(ok, 999999)).toBeNull();
    expect(loadReportPair(999999, ok)).toBeNull();
  });
});

describe("loadReportPairForSymbol — cross-company scoping for the diff page", () => {
  it("loads a pair when BOTH reports belong to the symbol (case-insensitive)", () => {
    const report = loadFixtureReport();
    const a = seedReport({ symbol: "AAPL", createdAt: "2026-05-01T00:00:00.000Z", report });
    const b = seedReport({ symbol: "AAPL", createdAt: "2026-07-05T00:00:00.000Z", report });

    const pair = loadReportPairForSymbol(a, b, "AAPL");
    expect(pair).not.toBeNull();
    expect(pair?.a.row.id).toBe(a);
    expect(pair?.b.row.id).toBe(b);

    // The route symbol is normalized (lowercase / padded still matches).
    expect(loadReportPairForSymbol(a, b, "aapl")).not.toBeNull();
    expect(loadReportPairForSymbol(a, b, "  aapl  ")).not.toBeNull();
  });

  it("returns null when EITHER report belongs to a different company", () => {
    const aapl = loadFixtureReport();
    const msft = clone(aapl);
    msft.meta.symbol = "MSFT";
    const aaplId = seedReport({ symbol: "AAPL", createdAt: "2026-05-01T00:00:00.000Z", report: aapl });
    const msftId = seedReport({ symbol: "MSFT", createdAt: "2026-07-05T00:00:00.000Z", report: msft });

    // /company/AAPL/history/diff?a=<MSFT id>&b=<AAPL id> must not diff.
    expect(loadReportPairForSymbol(msftId, aaplId, "AAPL")).toBeNull();
    expect(loadReportPairForSymbol(aaplId, msftId, "AAPL")).toBeNull();
    // ...and both foreign under a third symbol.
    expect(loadReportPairForSymbol(aaplId, msftId, "NVDA")).toBeNull();
    // Under MSFT the mixed pair is equally rejected (the AAPL id is foreign).
    expect(loadReportPairForSymbol(msftId, aaplId, "MSFT")).toBeNull();
  });

  it("returns null when either id is unknown or unparseable (same as loadReportPair)", () => {
    const report = loadFixtureReport();
    const ok = seedReport({ symbol: "AAPL", createdAt: "2026-07-05T00:00:00.000Z", report });
    const corrupt = seedReport({
      symbol: "AAPL",
      createdAt: "2026-07-06T00:00:00.000Z",
      reportJson: "{ broken",
    });
    expect(loadReportPairForSymbol(ok, 999999, "AAPL")).toBeNull();
    expect(loadReportPairForSymbol(ok, corrupt, "AAPL")).toBeNull();
  });

  it("rejects a row-to-embedded symbol mismatch without mutating persisted bytes", () => {
    const mismatched = loadFixtureReport();
    mismatched.meta.symbol = "MSFT";
    const bytes = JSON.stringify(mismatched);
    const badId = seedReport({
      symbol: "AAPL",
      createdAt: "2026-07-07T00:00:00.000Z",
      reportJson: bytes,
    });
    const goodId = seedReport({
      symbol: "AAPL",
      createdAt: "2026-07-08T00:00:00.000Z",
      report: loadFixtureReport(),
    });

    const genericRead = getReportById(badId);
    expect(genericRead?.report.meta.symbol).toBe("MSFT");
    expect(loadReportPair(badId, goodId)).toBeNull();
    expect(loadReportPairForSymbol(badId, goodId, "AAPL")).toBeNull();
    expect(listReportsForSymbol("AAPL").find((row) => row.id === badId)).toEqual(
      expect.objectContaining({ gradeStrip: null, dataOnly: null }),
    );
    const stored = handle.sqlite
      .prepare('SELECT "reportJson" FROM "reports" WHERE "id" = ?')
      .get(badId) as { reportJson: string };
    expect(stored.reportJson).toBe(bytes);
  });

  it("accepts canonical dot-hyphen aliases across route, rows, and embedded reports", () => {
    const dot = loadFixtureReport();
    dot.meta.symbol = "BRK.B";
    const first = seedReport({
      symbol: "BRK-B",
      createdAt: "2026-07-07T00:00:00.000Z",
      reportJson: JSON.stringify(dot),
    });
    const hyphen = clone(dot);
    hyphen.meta.symbol = "BRK-B";
    const second = seedReport({
      symbol: "BRK.B",
      createdAt: "2026-07-08T00:00:00.000Z",
      reportJson: JSON.stringify(hyphen),
    });

    expect(loadReportPair(first, second)).not.toBeNull();
    expect(loadReportPairForSymbol(first, second, "BRK.B")).not.toBeNull();
    expect(loadReportPairForSymbol(first, second, "BRK-B")).not.toBeNull();
  });

  it("rejects an unscoped pair whose internally consistent endpoints are different entities", () => {
    const aapl = loadFixtureReport();
    aapl.meta.symbol = "AAPL";
    const msft = clone(aapl);
    msft.meta.symbol = "MSFT";
    const aaplId = seedReport({
      symbol: "AAPL",
      createdAt: "2026-07-07T00:00:00.000Z",
      reportJson: JSON.stringify(aapl),
    });
    const msftId = seedReport({
      symbol: "MSFT",
      createdAt: "2026-07-08T00:00:00.000Z",
      reportJson: JSON.stringify(msft),
    });
    expect(loadReportPair(aaplId, msftId)).toBeNull();
  });

  it("rejects invalid route, row, and embedded symbol identities", () => {
    const invalidEmbedded = loadFixtureReport();
    invalidEmbedded.meta.symbol = "KELVIN-â„ª";
    const invalidEmbeddedId = seedReport({
      symbol: "AAPL",
      createdAt: "2026-07-07T00:00:00.000Z",
      reportJson: JSON.stringify(invalidEmbedded),
    });
    const invalidRow = loadFixtureReport();
    invalidRow.meta.symbol = "AAPL";
    const invalidRowId = seedReport({
      symbol: "KELVIN-â„ª",
      createdAt: "2026-07-08T00:00:00.000Z",
      reportJson: JSON.stringify(invalidRow),
    });
    const goodId = seedReport({
      symbol: "AAPL",
      createdAt: "2026-07-09T00:00:00.000Z",
      report: loadFixtureReport(),
    });
    expect(loadReportPairForSymbol(invalidEmbeddedId, goodId, "AAPL")).toBeNull();
    expect(loadReportPairForSymbol(invalidRowId, goodId, "AAPL")).toBeNull();
    expect(loadReportPairForSymbol(goodId, goodId, "KELVIN-â„ª")).toBeNull();
  });
});

/* ======================================================================== *
 * diffReports smoke — two tweaked copies
 * ======================================================================== */

describe("diffReports smoke on tweaked fixtures", () => {
  it("detects grade, target, catalyst/risk, verdict, and cost deltas", () => {
    const older = loadFixtureReport();
    const newer = clone(older);

    // Grade change: valuation C → B (an improvement).
    newer.verdict.gradeStrip.valuation.grade = "B";

    // Target change: synthetic bull scenario target 52 → 300.
    const bull = newer.valuation.scenarios.find((s) => s.name === "bull")!;
    bull.priceTarget!.value = 300; // fixture target is non-null

    // New catalyst + removed catalyst.
    newer.catalystsRisks.catalysts = [
      ...newer.catalystsRisks.catalysts.slice(1), // drop the first (removed)
      {
        title: "Brand-new AI feature launch",
        expectedDate: "2027-01-15",
        direction: "positive",
        significance: "high",
        reasoning: {
          text: "A new capability could re-accelerate the upgrade cycle.",
          label: "JUDGMENT",
          source: "web:news",
          asOf: "2026-07-05",
        },
      },
    ];

    // Verdict + cost change.
    newer.verdict.synthesis =
      "A materially different synthesis paragraph that should trip the verdict-changed flag in the diff.";
    newer.meta.costUsd = older.meta.costUsd + 0.5;

    const diff = diffReports(older, newer, persistedVersions(older, newer));

    // Grade change present, in the right direction.
    const val = diff.gradeChanges.find((g) => g.section === "valuation");
    expect(val).toBeDefined();
    expect(val?.from).toBe("C");
    expect(val?.to).toBe("B");

    // Target change for bull.
    const bullChange = diff.targetChanges.find((t) => t.scenario === "bull");
    expect(bullChange).toBeDefined();
    expect(bullChange?.fromValue).toBe(52);
    expect(bullChange?.toValue).toBe(300);
    expect(bullChange?.pctChange).toBeCloseTo((300 - 52) / 52, 6);

    // Catalyst deltas.
    expect(diff.newCatalysts).toContain("Brand-new AI feature launch");
    expect(diff.removedCatalysts.length).toBeGreaterThan(0);

    // Verdict + cost.
    expect(diff.verdictChanged).toBe(true);
    expect(diff.costDelta).toBeCloseTo(0.5, 6);
  });

  it("detects deterministic score + weighted-projection deltas", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    // A composite + aspect score move (fixture carries 1.1.0 scores).
    newer.scores!.composite.score = older.scores!.composite.score! + 6;
    newer.scores!.composite.band = "A";
    newer.scores!.aspects.valuation.score = 70;
    newer.scores!.aspects.valuation.band = "B";
    // A weighted revenue projection move at y5.
    const revA = newer.projections!.series.find((s) => s.metric === "revenue")!;
    const y5 = revA.weighted.length - 1;
    revA.weighted[y5].value.value = older.projections!.series.find((s) => s.metric === "revenue")!.weighted[y5].value.value * 1.1;

    const diff = diffReports(older, newer, persistedVersions(older, newer));
    const comp = diff.scoreChanges.find((s) => s.aspect === "composite");
    expect(comp).toBeDefined();
    expect(comp?.toBand).toBe("A");
    expect(diff.scoreChanges.find((s) => s.aspect === "valuation")).toBeDefined();
    const rev = diff.projectionChanges.find((p) => p.metric === "revenue");
    expect(rev).toBeDefined();
    expect(rev?.pctChange).toBeCloseTo(0.1, 4);
  });

  it("an unchanged report diffs to no changes", () => {
    const report = loadFixtureReport();
    const same = clone(report);
    const diff = diffReports(report, same, persistedVersions(report, same));
    expect(diff.gradeChanges).toHaveLength(0);
    expect(diff.targetChanges).toHaveLength(0);
    expect(diff.scoreChanges).toHaveLength(0);
    expect(diff.projectionChanges).toHaveLength(0);
    expect(diff.newCatalysts).toHaveLength(0);
    expect(diff.removedCatalysts).toHaveLength(0);
    expect(diff.newRisks).toHaveLength(0);
    expect(diff.removedRisks).toHaveLength(0);
    expect(diff.verdictChanged).toBe(false);
    expect(diff.costDelta).toBe(0);
  });
});

/* ======================================================================== *
 * Complete versioned transitions (M10)
 * ======================================================================== */

describe("diffReports complete versioned transitions", () => {
  it("reports added and removed optional grades with explicit endpoints", () => {
    const withBalance = loadFixtureReport();
    const withoutBalance = clone(withBalance);
    delete withoutBalance.verdict.gradeStrip.balanceSheet;

    const added = diffReports(
      withoutBalance,
      withBalance,
      persistedVersions(withoutBalance, withBalance),
    );
    expect(added.gradeChanges).toContainEqual(
      expect.objectContaining({
        section: "balanceSheet",
        transition: "added",
        from: null,
        to: withBalance.verdict.gradeStrip.balanceSheet!.grade,
        comparison: "comparable",
      }),
    );

    const removed = diffReports(
      withBalance,
      withoutBalance,
      persistedVersions(withBalance, withoutBalance),
    );
    expect(removed.gradeChanges).toContainEqual(
      expect.objectContaining({
        section: "balanceSheet",
        transition: "removed",
        from: withBalance.verdict.gradeStrip.balanceSheet!.grade,
        to: null,
        comparison: "comparable",
      }),
    );
  });

  it("reports score blocks added and removed and score null values became available or unavailable", () => {
    const scored = loadFixtureReport();
    const unscored = clone(scored);
    delete unscored.scores;

    const added = diffReports(unscored, scored, persistedVersions(unscored, scored));
    expect(added.scoreChanges).toHaveLength(8);
    expect(added.scoreChanges.every((change) => change.transition === "added")).toBe(true);
    expect(added.weightChanges).toHaveLength(7);
    expect(added.weightChanges.every((change) => change.transition === "added")).toBe(true);
    expect(added.driverChanges).toHaveLength(runtimeDrivers(scored).length);
    expect(added.driverChanges.every((change) => change.transition === "added")).toBe(true);

    const removed = diffReports(scored, unscored, persistedVersions(scored, unscored));
    expect(removed.scoreChanges).toHaveLength(8);
    expect(removed.scoreChanges.every((change) => change.transition === "removed")).toBe(true);
    expect(removed.weightChanges).toHaveLength(7);
    expect(removed.weightChanges.every((change) => change.transition === "removed")).toBe(true);
    expect(removed.driverChanges).toHaveLength(runtimeDrivers(scored).length);
    expect(removed.driverChanges.every((change) => change.transition === "removed")).toBe(true);

    const older = loadFixtureReport();
    const newer = clone(older);
    older.scores!.aspects.fundamentals.score = null;
    older.scores!.aspects.fundamentals.band = null;
    newer.scores!.aspects.quality.score = null;
    newer.scores!.aspects.quality.band = null;
    const availability = diffReports(older, newer, persistedVersions(older, newer));
    expect(availability.scoreChanges).toContainEqual(
      expect.objectContaining({ aspect: "fundamentals", transition: "became-available" }),
    );
    expect(availability.scoreChanges).toContainEqual(
      expect.objectContaining({ aspect: "quality", transition: "became-unavailable" }),
    );
  });

  it("detects raw fractional score changes and band-only changes without display rounding", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    older.scores!.aspects.valuation.score = 60.1;
    newer.scores!.aspects.valuation.score = 60.4;
    newer.scores!.aspects.leadership.band =
      older.scores!.aspects.leadership.band === "A" ? "B" : "A";

    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.comparisonStatus).toBe("changed");
    expect(diff.scoreChanges).toContainEqual(
      expect.objectContaining({
        aspect: "valuation",
        transition: "changed",
        fromValue: 60.1,
        toValue: 60.4,
      }),
    );
    expect(diff.scoreChanges).toContainEqual(
      expect.objectContaining({ aspect: "leadership", transition: "changed" }),
    );
  });

  it("keeps unique composite and aspect score endpoints including composite availability", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    older.scores!.composite.score = null;
    older.scores!.composite.band = null;
    newer.scores!.composite.score = 80.125;
    newer.scores!.composite.band = "B";
    const aspects = [
      "fundamentals",
      "valuation",
      "quality",
      "balanceSheet",
      "moat",
      "leadership",
      "technicals",
    ] as const;
    aspects.forEach((aspect, index) => {
      older.scores!.aspects[aspect].score = 10.25 + index;
      newer.scores!.aspects[aspect].score = 20.75 + index;
    });

    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(
      diff.scoreChanges.map(
        (change) =>
          `${change.aspect}:${change.fromValue}->${change.toValue}:${change.transition}`,
      ),
    ).toEqual([
      "composite:null->80.125:became-available",
      "fundamentals:10.25->20.75:changed",
      "valuation:11.25->21.75:changed",
      "quality:12.25->22.75:changed",
      "balanceSheet:13.25->23.75:changed",
      "moat:14.25->24.75:changed",
      "leadership:15.25->25.75:changed",
      "technicals:16.25->26.75:changed",
    ]);

    const unavailable = diffReports(newer, older, persistedVersions(newer, older));
    expect(unavailable.scoreChanges).toContainEqual(
      expect.objectContaining({ aspect: "composite", transition: "became-unavailable" }),
    );
  });

  it("reports unique sentinels for every weight across all transition kinds", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    const from = runtimeWeights(older);
    const to = runtimeWeights(newer);

    from.fundamentals = 1;
    to.fundamentals = 101;
    from.valuation = null;
    to.valuation = 102;
    from.quality = 3;
    to.quality = null;
    delete from.balanceSheet;
    to.balanceSheet = 104;
    from.moat = 5;
    delete to.moat;
    from.leadership = 6;
    to.leadership = 106;
    from.technicals = 7;
    to.technicals = 107;

    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.weightChanges).toHaveLength(7);
    expect(diff.weightChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ aspect: "fundamentals", fromValue: 1, toValue: 101, transition: "changed" }),
        expect.objectContaining({ aspect: "valuation", fromValue: null, toValue: 102, transition: "became-available" }),
        expect.objectContaining({ aspect: "quality", fromValue: 3, toValue: null, transition: "became-unavailable" }),
        expect.objectContaining({ aspect: "balanceSheet", fromValue: null, toValue: 104, transition: "added" }),
        expect.objectContaining({ aspect: "moat", fromValue: 5, toValue: null, transition: "removed" }),
        expect.objectContaining({ aspect: "leadership", fromValue: 6, toValue: 106, transition: "changed" }),
        expect.objectContaining({ aspect: "technicals", fromValue: 7, toValue: 107, transition: "changed" }),
      ]),
    );
  });

  it("reports every aspect driver by tuple identity, provenance, and all transition kinds", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    const oldDrivers = runtimeDrivers(older);
    const newDrivers = runtimeDrivers(newer);
    expect(oldDrivers).toHaveLength(19);
    expect(newDrivers).toHaveLength(19);

    for (let index = 0; index < oldDrivers.length; index += 1) {
      oldDrivers[index]!.driver.value = 1000 + index;
      newDrivers[index]!.driver.value = 2000 + index;
    }

    // Same tuple and value, but sourceId-stable traced provenance changed.
    oldDrivers[0]!.driver.value = 1000;
    newDrivers[0]!.driver.value = 1000;
    oldDrivers[0]!.driver.sourceId = "driver-stable-id";
    newDrivers[0]!.driver.sourceId = "driver-stable-id";
    oldDrivers[0]!.driver.source = "legacy-display-a";
    newDrivers[0]!.driver.source = "legacy-display-b";
    newDrivers[0]!.driver.asOf = "2026-01-02";
    newDrivers[0]!.driver.verified = false;
    newDrivers[0]!.driver.verificationNote = "provenance changed";

    // Present semantic values may independently become available/unavailable.
    oldDrivers[1]!.driver.value = null;
    newDrivers[1]!.driver.value = 2001;
    oldDrivers[2]!.driver.value = 1002;
    newDrivers[2]!.driver.value = null;

    const removedDriver = structuredClone(oldDrivers[3]!.driver);
    removedDriver.value = 9001;
    removedDriver.sourceId = "driver-removed-id";
    removedDriver.source = "driver-removed-display";
    older.scores!.aspects.fundamentals.drivers.push(
      removedDriver as Report["scores"] extends { aspects: { fundamentals: { drivers: Array<infer D> } } } ? D : never,
    );
    const addedDriver = structuredClone(newDrivers[3]!.driver);
    addedDriver.value = 9002;
    addedDriver.sourceId = "driver-added-id";
    addedDriver.source = "driver-added-display";
    newer.scores!.aspects.fundamentals.drivers.push(
      addedDriver as Report["scores"] extends { aspects: { fundamentals: { drivers: Array<infer D> } } } ? D : never,
    );

    // Array position is irrelevant.
    for (const aspect of Object.values(newer.scores!.aspects)) {
      aspect.drivers.reverse();
    }

    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.driverChanges).toHaveLength(21);
    expect(diff.driverChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transition: "changed", from: expect.objectContaining({ value: 1000 }), to: expect.objectContaining({ value: 1000, verificationNote: "provenance changed" }) }),
        expect.objectContaining({ transition: "became-available", from: expect.objectContaining({ value: null }), to: expect.objectContaining({ value: 2001 }) }),
        expect.objectContaining({ transition: "became-unavailable", from: expect.objectContaining({ value: 1002 }), to: expect.objectContaining({ value: null }) }),
        expect.objectContaining({ sourceKey: "driver-removed-id", transition: "removed", from: expect.objectContaining({ value: 9001 }), to: null }),
        expect.objectContaining({ sourceKey: "driver-added-id", transition: "added", from: null, to: expect.objectContaining({ value: 9002 }) }),
      ]),
    );
    expect(
      diff.driverChanges
        .filter((change) => change.transition === "changed" && change.from?.value !== change.to?.value)
        .map((change) => `${change.from?.value}->${change.to?.value}`),
    ).toEqual(
      expect.arrayContaining([
        "1003->2003", "1004->2004", "1005->2005", "1006->2006",
        "1007->2007", "1008->2008", "1009->2009", "1010->2010",
        "1011->2011", "1012->2012", "1013->2013", "1014->2014",
        "1015->2015", "1016->2016", "1017->2017", "1018->2018",
      ]),
    );
  });

  it("reordered identical drivers do not create false changes", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    for (const aspect of Object.values(newer.scores!.aspects)) {
      aspect.drivers.reverse();
    }
    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.driverChanges).toHaveLength(0);
  });

  it("uses collision-safe driver tuples and localizes duplicate identity conflicts", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    const base = structuredClone(older.scores!.aspects.fundamentals.drivers[0]!);
    const collisionA = { ...base, value: 801, sourceId: undefined, source: "a|b", unit: "c", period: "d" };
    const collisionB = { ...base, value: 802, sourceId: undefined, source: "a", unit: "b|c", period: "d" };
    older.scores!.aspects.fundamentals.drivers = [collisionA, collisionB];
    newer.scores!.aspects.fundamentals.drivers = [
      { ...collisionA, value: 811 },
      { ...collisionB, value: 812 },
    ];
    // A duplicate in a different aspect must taint only the driver family, not
    // erase the two unambiguous fundamentals transitions.
    const duplicate = structuredClone(older.scores!.aspects.valuation.drivers[0]!);
    duplicate.value += 1;
    older.scores!.aspects.valuation.drivers.push(duplicate);

    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.familyComparisons.drivers).toEqual(
      expect.objectContaining({
        comparison: "not-comparable",
        reasons: expect.arrayContaining(["duplicate-driver-identity"]),
      }),
    );
    expect(diff.comparisonStatus).toBe("not-comparable");
    expect(diff.driverChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKey: "a|b", unit: "c", period: "d", comparison: "comparable" }),
        expect.objectContaining({ sourceKey: "a", unit: "b|c", period: "d", comparison: "comparable" }),
      ]),
    );
    expect(
      diff.driverChanges.filter(
        (change) =>
          change.aspect === "valuation" &&
          change.sourceKey === (duplicate.sourceId ?? duplicate.source) &&
          change.unit === duplicate.unit &&
          change.period === (duplicate.period ?? ""),
      ),
    ).toHaveLength(0);
  });

  it.each([
    {
      label: "source display",
      mutate: (from: RuntimeTrace, to: RuntimeTrace) => {
        from.sourceId = "stable-driver";
        to.sourceId = "stable-driver";
        to.source = "new-display-source";
      },
      comparison: "comparable",
      reason: null,
    },
    {
      label: "sourceId fallback",
      mutate: (from: RuntimeTrace, to: RuntimeTrace) => {
        delete from.sourceId;
        to.sourceId = from.source;
      },
      comparison: "comparable",
      reason: null,
    },
    {
      label: "currency",
      mutate: (from: RuntimeTrace, to: RuntimeTrace) => {
        from.currency = "USD";
        to.currency = "EUR";
      },
      comparison: "not-comparable",
      reason: "currency-mismatch",
    },
    {
      label: "asOf",
      mutate: (_from: RuntimeTrace, to: RuntimeTrace) => {
        to.asOf = "2026-04-05";
      },
      comparison: "comparable",
      reason: null,
    },
    {
      label: "verified",
      mutate: (from: RuntimeTrace, to: RuntimeTrace) => {
        from.verified = true;
        to.verified = false;
      },
      comparison: "comparable",
      reason: null,
    },
    {
      label: "verification note",
      mutate: (_from: RuntimeTrace, to: RuntimeTrace) => {
        to.verificationNote = "only-note-changed";
      },
      comparison: "comparable",
      reason: null,
    },
  ])("detects isolated driver $label provenance changes", ({ mutate, comparison, reason }) => {
    const older = loadFixtureReport();
    const newer = clone(older);
    const from = runtimeDrivers(older)[0]!.driver;
    const to = runtimeDrivers(newer)[0]!.driver;
    mutate(from, to);
    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.driverChanges).toHaveLength(1);
    expect(diff.driverChanges[0]).toEqual(
      expect.objectContaining({ transition: "changed", comparison }),
    );
    if (reason === null) {
      expect(diff.driverChanges[0]!.reasons).toEqual([]);
    } else {
      expect(diff.driverChanges[0]!.reasons).toContain(reason);
      expect(diff.familyComparisons.drivers.reasons).toContain(reason);
    }
  });

  it("treats driver unit and period identity changes as removed plus added", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    runtimeDrivers(newer)[0]!.driver.unit = "different-unit";
    runtimeDrivers(newer)[1]!.driver.period = "FY2099";
    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.driverChanges.filter((change) => change.transition === "removed")).toHaveLength(2);
    expect(diff.driverChanges.filter((change) => change.transition === "added")).toHaveLength(2);
  });

  it("reports targets became available, became unavailable, zero, and dimension conflicts", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    const oldBull = older.valuation.scenarios.find((scenario) => scenario.name === "bull")!;
    const newBull = newer.valuation.scenarios.find((scenario) => scenario.name === "bull")!;
    oldBull.priceTarget = null;
    newBull.priceTarget!.value = 0;
    const newBase = newer.valuation.scenarios.find((scenario) => scenario.name === "base")!;
    newBase.priceTarget = null;
    const oldBear = older.valuation.scenarios.find((scenario) => scenario.name === "bear")!;
    const newBear = newer.valuation.scenarios.find((scenario) => scenario.name === "bear")!;
    oldBear.priceTarget!.value = 0;
    newBear.priceTarget!.value = 25;

    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.targetChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scenario: "bull", transition: "became-available", fromValue: null, toValue: 0, pctChange: null }),
        expect.objectContaining({ scenario: "base", transition: "became-unavailable", toValue: null, pctChange: null }),
        expect.objectContaining({ scenario: "bear", transition: "changed", fromValue: 0, toValue: 25, pctChange: null, comparison: "comparable" }),
      ]),
    );

    const dimensionA = loadFixtureReport();
    const dimensionB = clone(dimensionA);
    const targetA = dimensionA.valuation.scenarios.find((scenario) => scenario.name === "bull")!.priceTarget!;
    const targetB = dimensionB.valuation.scenarios.find((scenario) => scenario.name === "bull")!.priceTarget!;
    targetA.currency = "USD";
    targetB.currency = "EUR";
    targetB.value += 1;
    const dimensionDiff = diffReports(
      dimensionA,
      dimensionB,
      persistedVersions(dimensionA, dimensionB),
    );
    expect(dimensionDiff.targetChanges).toContainEqual(
      expect.objectContaining({
        scenario: "bull",
        transition: "changed",
        comparison: "not-comparable",
        reasons: expect.arrayContaining(["currency-mismatch"]),
        pctChange: null,
      }),
    );
    expect(dimensionDiff.comparisonStatus).toBe("not-comparable");
    expect(dimensionDiff.familyComparisons.targets.reasons).toContain(
      "currency-mismatch",
    );
  });

  it.each([
    {
      label: "source",
      mutate: (target: NonNullable<Report["valuation"]["scenarios"][number]["priceTarget"]>) => {
        target.source = "target-provenance-only";
      },
      comparison: "comparable",
      reason: null,
    },
    {
      label: "asOf",
      mutate: (target: NonNullable<Report["valuation"]["scenarios"][number]["priceTarget"]>) => {
        target.asOf = "2026-05-06";
      },
      comparison: "comparable",
      reason: null,
    },
    {
      label: "sourceId",
      mutate: (target: NonNullable<Report["valuation"]["scenarios"][number]["priceTarget"]>) => {
        target.sourceId = "target-source-id-only";
      },
      comparison: "comparable",
      reason: null,
    },
    {
      label: "verified",
      mutate: (target: NonNullable<Report["valuation"]["scenarios"][number]["priceTarget"]>) => {
        target.verified = !target.verified;
      },
      comparison: "comparable",
      reason: null,
    },
    {
      label: "verification note",
      mutate: (target: NonNullable<Report["valuation"]["scenarios"][number]["priceTarget"]>) => {
        target.verificationNote = "target-note-only";
      },
      comparison: "comparable",
      reason: null,
    },
    {
      label: "currency",
      mutate: (target: NonNullable<Report["valuation"]["scenarios"][number]["priceTarget"]>) => {
        target.currency = "EUR";
      },
      comparison: "not-comparable",
      reason: "currency-mismatch",
    },
    {
      label: "unit",
      mutate: (target: NonNullable<Report["valuation"]["scenarios"][number]["priceTarget"]>) => {
        target.unit = "EUR/share";
      },
      comparison: "not-comparable",
      reason: "unit-mismatch",
    },
    {
      label: "period",
      mutate: (target: NonNullable<Report["valuation"]["scenarios"][number]["priceTarget"]>) => {
        target.period = "FY2099";
      },
      comparison: "not-comparable",
      reason: "period-mismatch",
    },
  ])("detects isolated target $label changes", ({ mutate, comparison, reason }) => {
    const older = loadFixtureReport();
    const newer = clone(older);
    mutate(newer.valuation.scenarios.find((scenario) => scenario.name === "bull")!.priceTarget!);
    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.targetChanges).toHaveLength(1);
    expect(diff.targetChanges[0]).toEqual(
      expect.objectContaining({
        scenario: "bull",
        transition: "changed",
        comparison,
        pctChange: null,
      }),
    );
    if (reason !== null) expect(diff.targetChanges[0]!.reasons).toContain(reason);
  });

  it("localizes duplicate target identities without dropping an unrelated target change", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    older.valuation.scenarios.push(structuredClone(older.valuation.scenarios[0]!));
    newer.valuation.scenarios.find((scenario) => scenario.name === "base")!.priceTarget!.value += 1;
    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.familyComparisons.targets).toEqual(
      expect.objectContaining({
        comparison: "not-comparable",
        reasons: expect.arrayContaining(["duplicate-target-identity"]),
      }),
    );
    expect(diff.targetChanges).toContainEqual(
      expect.objectContaining({ scenario: "base", comparison: "comparable" }),
    );
    expect(diff.targetChanges.some((change) => change.scenario === "bull")).toBe(
      false,
    );
  });

  it("compares every point on every projection path including years two and four", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    const revenue = newer.projections!.series.find((series) => series.metric === "revenue")!;
    const paths = ["historical", "bull", "base", "bear", "weighted"] as const;

    for (const [pathIndex, path] of paths.entries()) {
      revenue[path].forEach((point, pointIndex) => {
        point.value.value = (pathIndex + 1) * 100_000 + pointIndex;
      });
    }

    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(
      diff.projectionChanges
        .filter((change) => change.metric === "revenue")
        .map((change) => `${change.path}:${change.period}:${change.toValue}`),
    ).toEqual([
      "historical:FY2021:100000",
      "historical:FY2022:100001",
      "historical:FY2023:100002",
      "historical:FY2024:100003",
      "historical:FY2025:100004",
      "bull:FY2026:200000",
      "bull:FY2027:200001",
      "bull:FY2028:200002",
      "bull:FY2029:200003",
      "bull:FY2030:200004",
      "base:FY2026:300000",
      "base:FY2027:300001",
      "base:FY2028:300002",
      "base:FY2029:300003",
      "base:FY2030:300004",
      "bear:FY2026:400000",
      "bear:FY2027:400001",
      "bear:FY2028:400002",
      "bear:FY2029:400003",
      "bear:FY2030:400004",
      "weighted:FY2026:500000",
      "weighted:FY2027:500001",
      "weighted:FY2028:500002",
      "weighted:FY2029:500003",
      "weighted:FY2030:500004",
    ]);
    expect(diff.projectionChanges.every((change) => change.transition === "changed")).toBe(
      true,
    );
  });

  it("reports projection blocks and metric unions as added or removed", () => {
    const projected = loadFixtureReport();
    const unprojected = clone(projected);
    delete unprojected.projections;
    const expectedPointCount = 4 * 5 * 5;

    const addedBlock = diffReports(
      unprojected,
      projected,
      persistedVersions(unprojected, projected),
    );
    expect(addedBlock.projectionChanges).toHaveLength(expectedPointCount);
    expect(addedBlock.projectionChanges.every((change) => change.transition === "added")).toBe(true);

    const removedBlock = diffReports(
      projected,
      unprojected,
      persistedVersions(projected, unprojected),
    );
    expect(removedBlock.projectionChanges).toHaveLength(expectedPointCount);
    expect(removedBlock.projectionChanges.every((change) => change.transition === "removed")).toBe(true);

    const older = loadFixtureReport();
    const newer = clone(older);
    older.projections!.series = older.projections!.series.filter((series) => series.metric !== "epsDiluted");
    newer.projections!.series = newer.projections!.series.filter((series) => series.metric !== "fcf");
    const metricUnion = diffReports(older, newer, persistedVersions(older, newer));
    expect(metricUnion.projectionChanges.filter((change) => change.metric === "epsDiluted")).toHaveLength(25);
    expect(
      metricUnion.projectionChanges
        .filter((change) => change.metric === "epsDiluted")
        .every((change) => change.transition === "added"),
    ).toBe(true);
    expect(metricUnion.projectionChanges.filter((change) => change.metric === "fcf")).toHaveLength(25);
    expect(
      metricUnion.projectionChanges
        .filter((change) => change.metric === "fcf")
        .every((change) => change.transition === "removed"),
    ).toBe(true);
  });

  it("reports a rolled FY horizon by metric and period union", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    const weighted = newer.projections!.series.find((series) => series.metric === "revenue")!.weighted;
    weighted.shift();
    const fy2031 = structuredClone(weighted.at(-1)!);
    fy2031.period = "FY2031";
    fy2031.value.period = "FY2031";
    fy2031.value.value = 20_310_000_000;
    weighted.push(fy2031);

    const diff = diffReports(older, newer, persistedVersions(older, newer));
    const revenueWeighted = diff.projectionChanges.filter(
      (change) => change.metric === "revenue" && change.path === "weighted",
    );
    expect(revenueWeighted).toEqual([
      expect.objectContaining({ period: "FY2026", transition: "removed" }),
      expect.objectContaining({ period: "FY2031", transition: "added" }),
    ]);
  });

  it("reordered projection series and points do not create false changes", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    newer.projections!.series.reverse();
    for (const series of newer.projections!.series) {
      for (const path of ["historical", "bull", "base", "bear", "weighted"] as const) {
        series[path].reverse();
      }
    }
    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.projectionChanges).toHaveLength(0);
  });

  it.each([
    {
      label: "source",
      mutate: (point: ProjectionPoint) => {
        point.value.source = "projection-source-only";
      },
    },
    {
      label: "asOf",
      mutate: (point: ProjectionPoint) => {
        point.value.asOf = "2026-06-07";
      },
    },
    {
      label: "verified",
      mutate: (point: ProjectionPoint) => {
        point.value.verified = false;
      },
    },
    {
      label: "verification note",
      mutate: (point: ProjectionPoint) => {
        point.value.verificationNote = "projection-note-only";
      },
    },
    {
      label: "sourceId",
      mutate: (point: ProjectionPoint) => {
        point.value.sourceId = "projection-source-id-only";
      },
    },
  ])("detects isolated projection $label provenance changes", ({ mutate }) => {
    const older = loadFixtureReport();
    const newer = clone(older);
    const point = newer.projections!.series.find((series) => series.metric === "revenue")!.weighted[1]!;
    mutate(point);
    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.projectionChanges).toHaveLength(1);
    expect(diff.projectionChanges[0]).toEqual(
      expect.objectContaining({
        path: "weighted",
        metric: "revenue",
        period: "FY2027",
        transition: "changed",
        comparison: "comparable",
      }),
    );
  });

  it("treats a matching inner projection period as comparable provenance enrichment", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    const from = older.projections!.series.find((series) => series.metric === "revenue")!.weighted[0]!;
    const to = newer.projections!.series.find((series) => series.metric === "revenue")!.weighted[0]!;
    from.value.period = null;
    to.value.period = to.period;
    const diff = diffReports(older, newer, persistedVersions(older, newer));
    expect(diff.projectionChanges).toEqual([
      expect.objectContaining({
        path: "weighted",
        metric: "revenue",
        period: to.period,
        transition: "changed",
        comparison: "comparable",
        reasons: [],
      }),
    ]);
    expect(diff.familyComparisons.projections.weighted.reasons).not.toContain(
      "period-mismatch",
    );
  });

  it("marks projection point and series unit conflicts not comparable", () => {
    const currencyA = loadFixtureReport();
    const currencyB = clone(currencyA);
    currencyA.projections!.series.find((series) => series.metric === "revenue")!.weighted[0]!.value.currency = "USD";
    currencyB.projections!.series.find((series) => series.metric === "revenue")!.weighted[0]!.value.currency = "EUR";
    const currencyDiff = diffReports(currencyA, currencyB, persistedVersions(currencyA, currencyB));
    expect(currencyDiff.projectionChanges).toContainEqual(
      expect.objectContaining({
        path: "weighted",
        metric: "revenue",
        period: "FY2026",
        comparison: "not-comparable",
        reasons: expect.arrayContaining(["currency-mismatch"]),
        pctChange: null,
      }),
    );
    expect(currencyDiff.familyComparisons.projections.weighted.reasons).toContain(
      "currency-mismatch",
    );

    const pointUnitA = loadFixtureReport();
    const pointUnitB = clone(pointUnitA);
    const point = pointUnitB.projections!.series.find((series) => series.metric === "revenue")!.weighted[0]!;
    point.value.unit = "EUR";
    const pointDiff = diffReports(pointUnitA, pointUnitB, persistedVersions(pointUnitA, pointUnitB));
    expect(pointDiff.projectionChanges).toContainEqual(
      expect.objectContaining({
        path: "weighted",
        metric: "revenue",
        period: "FY2026",
        comparison: "not-comparable",
        reasons: expect.arrayContaining(["unit-mismatch"]),
        pctChange: null,
      }),
    );

    const seriesUnitA = loadFixtureReport();
    const seriesUnitB = clone(seriesUnitA);
    seriesUnitB.projections!.series.find((series) => series.metric === "revenue")!.unit = "EUR";
    const seriesDiff = diffReports(seriesUnitA, seriesUnitB, persistedVersions(seriesUnitA, seriesUnitB));
    expect(seriesDiff.projectionChanges).toContainEqual(
      expect.objectContaining({
        path: "weighted",
        metric: "revenue",
        period: "FY2026",
        comparison: "not-comparable",
        reasons: expect.arrayContaining(["unit-mismatch"]),
        pctChange: null,
      }),
    );

    const innerOuterA = loadFixtureReport();
    const innerOuterB = clone(innerOuterA);
    innerOuterB.projections!.series.find((series) => series.metric === "revenue")!.unit = "USD";
    innerOuterB.projections!.series.find((series) => series.metric === "revenue")!.weighted[0]!.value.unit = "shares";
    const innerOuterDiff = diffReports(
      innerOuterA,
      innerOuterB,
      persistedVersions(innerOuterA, innerOuterB),
    );
    expect(innerOuterDiff.projectionChanges[0]).toEqual(
      expect.objectContaining({
        comparison: "not-comparable",
        reasons: expect.arrayContaining(["unit-mismatch"]),
      }),
    );

    const internallyInvalidA = loadFixtureReport();
    const internallyInvalidB = clone(internallyInvalidA);
    for (const report of [internallyInvalidA, internallyInvalidB]) {
      report.projections!.series.find((series) => series.metric === "revenue")!
        .weighted[0]!.value.unit = "shares";
    }
    const internallyInvalidDiff = diffReports(
      internallyInvalidA,
      internallyInvalidB,
      persistedVersions(internallyInvalidA, internallyInvalidB),
    );
    expect(
      internallyInvalidDiff.familyComparisons.projections.weighted.reasons,
    ).toContain("unit-mismatch");
    expect(internallyInvalidDiff.projectionChanges).toHaveLength(0);
  });

  it("surfaces projection provenance, duplicate identities, period conflicts, and dimensions locally", () => {
    const provenanceA = loadFixtureReport();
    const provenanceB = clone(provenanceA);
    const provenancePoint = provenanceB.projections!.series.find((series) => series.metric === "revenue")!.weighted[1]!;
    provenancePoint.value.source = "revised-projection-source";
    provenancePoint.value.asOf = "2026-02-03";
    provenancePoint.value.verified = false;
    provenancePoint.value.verificationNote = "rechecked";
    const provenanceDiff = diffReports(
      provenanceA,
      provenanceB,
      persistedVersions(provenanceA, provenanceB),
    );
    expect(provenanceDiff.projectionChanges).toContainEqual(
      expect.objectContaining({
        path: "weighted",
        metric: "revenue",
        period: "FY2027",
        transition: "changed",
        comparison: "comparable",
        to: expect.objectContaining({
          source: "revised-projection-source",
          asOf: "2026-02-03",
          verified: false,
          verificationNote: "rechecked",
        }),
      }),
    );

    const dimensionA = loadFixtureReport();
    const dimensionB = clone(dimensionA);
    const dimensionPoint = dimensionB.projections!.series.find((series) => series.metric === "fcf")!.weighted[0]!;
    dimensionA.projections!.series.find((series) => series.metric === "fcf")!.weighted[0]!.value.currency = "USD";
    dimensionPoint.value.currency = "EUR";
    dimensionPoint.value.value += 1;
    const dimensionDiff = diffReports(
      dimensionA,
      dimensionB,
      persistedVersions(dimensionA, dimensionB),
    );
    expect(dimensionDiff.projectionChanges).toContainEqual(
      expect.objectContaining({
        path: "weighted",
        metric: "fcf",
        period: "FY2026",
        comparison: "not-comparable",
        reasons: expect.arrayContaining(["currency-mismatch"]),
        pctChange: null,
      }),
    );
    expect(dimensionDiff.comparisonStatus).toBe("not-comparable");

    const conflictA = loadFixtureReport();
    const conflictB = clone(conflictA);
    const conflictSeries = conflictA.projections!.series.find((series) => series.metric === "revenue")!;
    conflictSeries.weighted.push(structuredClone(conflictSeries.weighted[0]!));
    const innerOuter = conflictB.projections!.series.find((series) => series.metric === "revenue")!.bull[0]!;
    innerOuter.value.period = "FY2099";
    const duplicateSeries = structuredClone(
      conflictB.projections!.series.find((series) => series.metric === "epsDiluted")!,
    );
    conflictB.projections!.series.push(duplicateSeries);
    conflictB.projections!.series.find((series) => series.metric === "fcf")!.weighted[1]!.value.value += 77;
    const conflictDiff = diffReports(conflictA, conflictB, persistedVersions(conflictA, conflictB));
    expect(conflictDiff.familyComparisons.projections.weighted).toEqual(
      expect.objectContaining({
        comparison: "not-comparable",
        reasons: expect.arrayContaining(["duplicate-projection-identity"]),
      }),
    );
    expect(conflictDiff.familyComparisons.projections.bull).toEqual(
      expect.objectContaining({
        comparison: "not-comparable",
        reasons: expect.arrayContaining([
          "duplicate-projection-identity",
          "projection-period-conflict",
        ]),
      }),
    );
    expect(conflictDiff.familyComparisons.targets.comparison).toBe("comparable");
    expect(conflictDiff.projectionChanges).toContainEqual(
      expect.objectContaining({
        path: "weighted",
        metric: "fcf",
        period: "FY2027",
        comparison: "comparable",
      }),
    );
    expect(
      conflictDiff.projectionChanges.some(
        (change) =>
          change.path === "weighted" &&
          change.metric === "revenue" &&
          change.period === "FY2026",
      ),
    ).toBe(false);
    expect(
      conflictDiff.projectionChanges.some(
        (change) => change.metric === "epsDiluted",
      ),
    ).toBe(false);
  });

  it("surfaces compatible, mismatched, missing, and conflicting version context", () => {
    const sameA = loadFixtureReport();
    const sameB = clone(sameA);
    const compatible = diffReports(sameA, sameB, persistedVersions(sameA, sameB));
    expect(compatible.context).toEqual({
      fromReportVersion: "synthetic-sample-1.0.0",
      toReportVersion: "synthetic-sample-1.0.0",
      fromSpecVersion: "1.2.0",
      toSpecVersion: "1.2.0",
    });
    expect(compatible.comparisonStatus).toBe("unchanged");
    expect(compatible.notComparableReasons).toEqual([]);

    const pipelineB = clone(sameA);
    pipelineB.meta.pipelineVersion = "pipeline-next";
    pipelineB.valuation.scenarios.find((scenario) => scenario.name === "bull")!.priceTarget!.value += 1;
    const pipelineMismatch = diffReports(
      sameA,
      pipelineB,
      persistedVersions(sameA, pipelineB),
    );
    expect(pipelineMismatch.comparisonStatus).toBe("not-comparable");
    expect(pipelineMismatch.notComparableReasons).toContain("report-version-mismatch");
    expect(pipelineMismatch.familyComparisons.targets).toEqual(
      expect.objectContaining({
        comparison: "not-comparable",
        reasons: expect.arrayContaining(["report-version-mismatch"]),
      }),
    );
    expect(pipelineMismatch.targetChanges).toContainEqual(
      expect.objectContaining({
        scenario: "bull",
        comparison: "not-comparable",
        reasons: expect.arrayContaining(["report-version-mismatch"]),
      }),
    );
    for (const family of [
      "grades",
      "scores",
      "weights",
      "drivers",
      "targets",
      "catalysts",
      "risks",
      "verdict",
      "cost",
    ] as const) {
      expect(pipelineMismatch.familyComparisons[family].comparison).toBe("not-comparable");
    }
    for (const path of ["historical", "bull", "base", "bear", "weighted"] as const) {
      expect(pipelineMismatch.familyComparisons.projections[path].comparison).toBe(
        "not-comparable",
      );
    }

    const specA = clone(sameA);
    const specB = clone(sameA);
    specA.meta.specVersion = "1.1.0";
    specB.meta.specVersion = "1.2.0";
    const specMismatch = diffReports(specA, specB, persistedVersions(specA, specB));
    expect(specMismatch.notComparableReasons).toContain("spec-version-mismatch");

    const missing = diffReports(
      sameA,
      sameB,
      persistedVersions(sameA, sameB, { fromSpecVersion: null }),
    );
    expect(missing.notComparableReasons).toContain("missing-from-spec-version");
    const missingTo = diffReports(
      sameA,
      sameB,
      persistedVersions(sameA, sameB, { toSpecVersion: null }),
    );
    expect(missingTo.notComparableReasons).toContain("missing-to-spec-version");

    const conflict = diffReports(
      sameA,
      sameB,
      persistedVersions(sameA, sameB, { fromSpecVersion: "row-conflict" }),
    );
    expect(conflict.notComparableReasons).toContain("from-spec-metadata-conflict");
    const conflictTo = diffReports(
      sameA,
      sameB,
      persistedVersions(sameA, sameB, { toSpecVersion: "row-conflict" }),
    );
    expect(conflictTo.notComparableReasons).toContain("to-spec-metadata-conflict");

    const blankA = clone(sameA);
    const blankB = clone(sameB);
    blankA.meta.pipelineVersion = " ";
    blankB.meta.pipelineVersion = "";
    blankA.meta.specVersion = " ";
    blankB.meta.specVersion = "";
    const blank = diffReports(blankA, blankB, persistedVersions(blankA, blankB));
    expect(blank.notComparableReasons).toEqual(
      expect.arrayContaining([
        "missing-from-report-version",
        "missing-to-report-version",
        "missing-from-spec-version",
        "missing-to-spec-version",
      ]),
    );
  });

  it("carries comparison state for catalyst, risk, verdict, and cost families", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    newer.catalystsRisks.catalysts = [
      ...newer.catalystsRisks.catalysts.slice(1),
      { ...structuredClone(newer.catalystsRisks.catalysts[0]!), title: "New catalyst family sentinel" },
    ];
    newer.catalystsRisks.risks = [
      ...newer.catalystsRisks.risks.slice(1),
      { ...structuredClone(newer.catalystsRisks.risks[0]!), title: "New risk family sentinel" },
    ];
    newer.verdict.synthesis = "Version-compatible verdict family sentinel changed materially.";
    newer.meta.costUsd = older.meta.costUsd + 0.75;

    const comparable = diffReports(older, newer, persistedVersions(older, newer));
    expect(comparable.catalystChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transition: "added", comparison: "comparable" }),
        expect.objectContaining({ transition: "removed", comparison: "comparable" }),
      ]),
    );
    expect(comparable.riskChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transition: "added", comparison: "comparable" }),
        expect.objectContaining({ transition: "removed", comparison: "comparable" }),
      ]),
    );
    expect(comparable.verdictChange).toEqual(
      expect.objectContaining({ transition: "changed", comparison: "comparable" }),
    );
    expect(comparable.costChange).toEqual(
      expect.objectContaining({ transition: "changed", comparison: "comparable", delta: 0.75 }),
    );
    expect(comparable.comparisonStatus).toBe("changed");

    const noDelta = diffReports(older, clone(older), persistedVersions(older, older));
    for (const family of ["catalysts", "risks", "verdict", "cost"] as const) {
      expect(noDelta.familyComparisons[family]).toEqual({
        comparison: "comparable",
        reasons: [],
      });
    }
  });

  it("reports source freshness as stale, fresh, or unknown without guessing per number", () => {
    const unknown = loadFixtureReport();
    const fresh = clone(unknown);
    const stale = clone(unknown);
    unknown.appendix.sources = [];
    fresh.appendix.sources = [
      { provider: "fmp", endpoint: "/fresh", asOf: "2026-01-01", fetchedAt: "2026-01-02", stale: false },
      { provider: "fred", endpoint: "/fresh-too", asOf: "2026-01-01", fetchedAt: "2026-01-02", stale: false },
    ];
    stale.appendix.sources = [
      { provider: "fmp", endpoint: "/unknown", asOf: "2026-01-01", fetchedAt: "2026-01-02" },
      { provider: "fred", endpoint: "/stale", asOf: "2026-01-01", fetchedAt: "2026-01-02", stale: true },
    ];

    expect(
      diffReports(unknown, fresh, persistedVersions(unknown, fresh)).sourceFreshness,
    ).toEqual({ from: "unknown", to: "fresh" });
    expect(
      diffReports(fresh, stale, persistedVersions(fresh, stale)).sourceFreshness,
    ).toEqual({ from: "fresh", to: "stale" });
    const onlyUnknownEnvelope = clone(unknown);
    onlyUnknownEnvelope.appendix.sources = [
      { provider: "legacy", endpoint: "/unknown", asOf: "2020", fetchedAt: "2020" },
    ];
    expect(
      diffReports(unknown, onlyUnknownEnvelope, persistedVersions(unknown, onlyUnknownEnvelope))
        .sourceFreshness.to,
    ).toBe("unknown");
    const mixedFreshUnknown = clone(unknown);
    mixedFreshUnknown.appendix.sources = [
      { provider: "fmp", endpoint: "/fresh", asOf: "2020", fetchedAt: "2020", stale: false },
      { provider: "legacy", endpoint: "/unknown", asOf: "2020", fetchedAt: "2020" },
    ];
    expect(
      diffReports(unknown, mixedFreshUnknown, persistedVersions(unknown, mixedFreshUnknown))
        .sourceFreshness.to,
    ).toBe("unknown");
  });

  it("returns not comparable and no deltas for direct cross-entity reports while accepting dot-hyphen aliases", () => {
    const aapl = loadFixtureReport();
    const msft = clone(aapl);
    msft.meta.symbol = "MSFT";
    msft.valuation.scenarios.find((scenario) => scenario.name === "bull")!.priceTarget!.value += 999;
    msft.meta.costUsd += 9;
    msft.verdict.synthesis = "Different entity content must never be diffed.";

    const crossEntity = diffReports(aapl, msft, persistedVersions(aapl, msft));
    expect(crossEntity.comparisonStatus).toBe("not-comparable");
    expect(crossEntity.notComparableReasons).toContain("entity-mismatch");
    expect(crossEntity.gradeChanges).toHaveLength(0);
    expect(crossEntity.scoreChanges).toHaveLength(0);
    expect(crossEntity.weightChanges).toHaveLength(0);
    expect(crossEntity.driverChanges).toHaveLength(0);
    expect(crossEntity.targetChanges).toHaveLength(0);
    expect(crossEntity.projectionChanges).toHaveLength(0);
    expect(crossEntity.newCatalysts).toHaveLength(0);
    expect(crossEntity.removedCatalysts).toHaveLength(0);
    expect(crossEntity.newRisks).toHaveLength(0);
    expect(crossEntity.removedRisks).toHaveLength(0);
    expect(crossEntity.verdictChanged).toBe(false);
    expect(crossEntity.costDelta).toBe(0);

    const dot = loadFixtureReport();
    const hyphen = clone(dot);
    dot.meta.symbol = "BRK.B";
    hyphen.meta.symbol = "BRK-B";
    const alias = diffReports(dot, hyphen, persistedVersions(dot, hyphen));
    expect(alias.notComparableReasons).not.toContain("entity-mismatch");
    expect(alias.comparisonStatus).toBe("unchanged");
  });

  it("returns deterministic JSON-safe output without mutating either report", () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    newer.scores!.aspects.valuation.score = 61.25;
    newer.projections!.series[0]!.weighted[1]!.value.asOf = "2026-03-04";
    const olderBytes = JSON.stringify(older);
    const newerBytes = JSON.stringify(newer);

    const first = diffReports(older, newer, persistedVersions(older, newer));
    const second = diffReports(older, newer, persistedVersions(older, newer));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(JSON.stringify(older)).toBe(olderBytes);
    expect(JSON.stringify(newer)).toBe(newerBytes);
  });
});

describe("history diff route-used SSR renderer", () => {
  async function loadDiffPageModule() {
    return import("@/app/company/[symbol]/history/diff/page");
  }

  async function renderDiffBody(diff: ReturnType<typeof diffReports>): Promise<string> {
    const diffBodyModule = await import("@/app/company/[symbol]/history/diff/diff-body");
    const Renderer = diffBodyModule.DiffBody as ComponentType<{
      diff: ReturnType<typeof diffReports>;
    }>;
    expect(Renderer).toBeTypeOf("function");
    return renderToStaticMarkup(createElement(Renderer!, { diff }));
  }

  it("renders every transition kind, complete counts, paths, provenance, versions, and freshness", async () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    delete older.verdict.gradeStrip.balanceSheet;
    older.scores!.composite.score = 70.125;
    newer.scores!.composite.score = 70.375;

    const fromWeights = runtimeWeights(older);
    const toWeights = runtimeWeights(newer);
    fromWeights.fundamentals = 1;
    toWeights.fundamentals = 101;
    fromWeights.valuation = null;
    toWeights.valuation = 102;
    fromWeights.quality = 3;
    toWeights.quality = null;
    delete fromWeights.balanceSheet;
    toWeights.balanceSheet = 104;
    fromWeights.moat = 5;
    delete toWeights.moat;

    const oldDrivers = older.scores!.aspects.fundamentals.drivers as RuntimeTrace[];
    const newDrivers = newer.scores!.aspects.fundamentals.drivers as RuntimeTrace[];
    oldDrivers[0]!.sourceId = "driver-ui-stable";
    newDrivers[0]!.sourceId = "driver-ui-stable";
    oldDrivers[0]!.currency = "USD";
    newDrivers[0]!.value = (newDrivers[0]!.value ?? 0) + 1;
    newDrivers[0]!.source = "driver-ui-display";
    newDrivers[0]!.currency = "USD";
    newDrivers[0]!.asOf = "2026-08-01";
    newDrivers[0]!.verified = false;
    newDrivers[0]!.verificationNote = "driver UI note";
    oldDrivers[1]!.value = null;
    newDrivers[1]!.value = 202;
    oldDrivers[2]!.value = 303;
    newDrivers[2]!.value = null;
    const removedDriver = { ...structuredClone(oldDrivers[0]!), sourceId: "ui-removed", source: "ui-removed", value: 404 };
    const addedDriver = {
      ...structuredClone(newDrivers[0]!),
      sourceId: "ui-added",
      source: "ui-added",
      unit: "ui-sentinel-unit",
      value: 505,
    };
    oldDrivers.push(removedDriver);
    newDrivers.push(addedDriver);

    older.valuation.scenarios.find((scenario) => scenario.name === "bull")!.priceTarget = null;
    const newBull = newer.valuation.scenarios.find((scenario) => scenario.name === "bull")!.priceTarget!;
    newBull.value = 0;
    newBull.currency = "USD";
    newBull.sourceId = "target-ui-source";
    newBull.asOf = "2026-08-02";

    const oldRevenue = older.projections!.series.find((series) => series.metric === "revenue")!;
    const newRevenue = newer.projections!.series.find((series) => series.metric === "revenue")!;
    for (const path of ["historical", "bull", "base", "bear"] as const) {
      newRevenue[path][0]!.value.value += 1;
    }
    newRevenue.weighted.shift();
    const fy2031 = structuredClone(newRevenue.weighted.at(-1)!);
    fy2031.period = "FY2031";
    fy2031.value.period = "FY2031";
    fy2031.value.value = 20_310_000_000;
    fy2031.value.sourceId = "projection-ui-source";
    fy2031.value.currency = "USD";
    fy2031.value.asOf = "2026-08-03";
    newRevenue.weighted.push(fy2031);
    expect(oldRevenue.weighted[0]!.period).toBe("FY2026");

    older.appendix.sources = [
      { provider: "fmp", endpoint: "/fresh", asOf: "2026-08-01", fetchedAt: "2026-08-02", stale: false },
    ];
    newer.appendix.sources = [
      { provider: "fmp", endpoint: "/stale", asOf: "2026-08-01", fetchedAt: "2026-08-02", stale: true },
    ];
    newer.catalystsRisks.catalysts = [
      ...newer.catalystsRisks.catalysts.slice(1),
      { ...structuredClone(newer.catalystsRisks.catalysts[0]!), title: "UI catalyst added" },
    ];
    newer.catalystsRisks.risks = [
      ...newer.catalystsRisks.risks.slice(1),
      { ...structuredClone(newer.catalystsRisks.risks[0]!), title: "UI risk added" },
    ];
    newer.verdict.synthesis = "The UI verdict transition changed on comparable evidence.";
    newer.meta.costUsd = older.meta.costUsd + 0.75;

    const diff = diffReports(older, newer, persistedVersions(older, newer));
    const html = await renderDiffBody(diff);
    expect(html).toContain("comparison changed");
    expect(html).toContain("pipeline synthetic-sample-1.0.0");
    expect(html).toContain("spec 1.2.0");
    expect(html).toContain("sources fresh");
    expect(html).toContain("stale");
    expect(html).toContain(
      "1 grade · 1 score · 5 weight · 5 driver · 1 target · 6 projection · 2 catalyst · 2 risk · 1 verdict · 1 cost",
    );
    expect(html).toContain("composite weights");
    expect(html).toContain("score drivers");
    for (const label of ["changed", "added", "removed", "became available", "became unavailable"]) {
      expect(html).toContain(label);
    }
    for (const path of ["historical", "bull", "base", "bear", "weighted"]) {
      expect(html).toContain(path);
    }
    for (const field of [
      "driver-ui-stable",
      "driver-ui-display",
      "driver UI note",
      "target-ui-source",
      "projection-ui-source",
      "2026-08-01",
      "uncited",
      "USD",
      "ui-sentinel-unit",
      "70.13",
      "70.38",
      "absent",
      "unavailable",
    ]) {
      expect(html).toContain(field);
    }
    expect(html).toContain("data-transition=\"added\"");
    for (const transition of ["added", "removed"] as const) {
      const row = html.match(
        new RegExp(`<[^>]+data-transition="${transition}"[\\s\\S]*?<\\/div>`),
      )?.[0];
      expect(row).toBeDefined();
      expect(row).not.toMatch(/text-(?:pos|neg)/);
    }
  });

  it("renders not comparable warnings neutrally without false unchanged or raw conflict text", async () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    newer.meta.pipelineVersion = "pipeline-next";
    newer.valuation.scenarios.find((scenario) => scenario.name === "bull")!.priceTarget!.value *= 1.1;
    const malicious = structuredClone(older.scores!.aspects.fundamentals.drivers[0]!);
    malicious.sourceId = undefined;
    malicious.source = "raw-duplicate-secret-</div><script>alert(1)</script>";
    older.scores!.aspects.fundamentals.drivers = [malicious, structuredClone(malicious)];

    const diff = diffReports(older, newer, persistedVersions(older, newer));
    const html = await renderDiffBody(diff);
    expect(html).toContain("comparison not comparable");
    expect(html).toContain("Report pipeline versions differ");
    expect(html).toContain("Duplicate score-driver identity");
    expect(html).not.toContain("raw-duplicate-secret");
    expect(html).not.toContain("â–²");
    expect(html).not.toContain("â–¼");
    expect(html).not.toContain("+10.0%");
    const notComparableRows = [
      ...html.matchAll(/<[^>]+data-comparison="not-comparable"[\s\S]*?<\/div>/g),
    ].map((match) => match[0]);
    expect(notComparableRows.length).toBeGreaterThan(0);
    for (const row of notComparableRows) expect(row).not.toMatch(/text-(?:pos|neg)/);
    for (const falseClaim of [
      "comparison unchanged",
      "verdict unchanged",
      "No grade changed",
      "No deterministic score changed",
      "No scenario price target changed",
      "No weighted projection changed",
    ]) {
      expect(html).not.toContain(falseClaim);
    }
  });

  it("distinguishes comparable unchanged from a missing-version not-comparable result", async () => {
    const report = loadFixtureReport();
    const unchanged = diffReports(report, clone(report), persistedVersions(report, report));
    expect(await renderDiffBody(unchanged)).toContain("comparison unchanged");

    const unknownVersion = diffReports(
      report,
      clone(report),
      persistedVersions(report, report, { toSpecVersion: null }),
    );
    const html = await renderDiffBody(unknownVersion);
    expect(html).toContain("comparison not comparable");
    expect(html).toContain("Target persisted spec version is missing");
    expect(html).not.toContain("comparison unchanged");
  });

  it("keeps empty unaffected families comparable under a localized driver conflict", async () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    const duplicate = structuredClone(older.scores!.aspects.fundamentals.drivers[0]!);
    older.scores!.aspects.fundamentals.drivers.push(duplicate);
    const html = await renderDiffBody(
      diffReports(older, newer, persistedVersions(older, newer)),
    );
    expect(html).toMatch(
      /data-family="grade changes" data-comparison="comparable"[\s\S]*?No transitions\./,
    );
    expect(html).toMatch(
      /data-family="score drivers" data-comparison="not-comparable"/,
    );
    expect(html).toContain("verdict unchanged");
  });

  it("shows direction and percentage only for comparable changed values", async () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    newer.verdict.gradeStrip.valuation.grade = "B";
    newer.valuation.scenarios.find((scenario) => scenario.name === "bull")!
      .priceTarget!.value += 10;
    newer.meta.costUsd = older.meta.costUsd + 0.5;
    const comparableHtml = await renderDiffBody(
      diffReports(older, newer, persistedVersions(older, newer)),
    );
    const comparableTargetRow = comparableHtml.match(
      /<div data-transition="changed" data-comparison="comparable" data-direction="positive" data-identity="bull target"[^>]*>[\s\S]*?<\/div>/,
    )?.[0];
    expect(comparableTargetRow).toBeDefined();
    expect(comparableTargetRow).toContain("text-pos");
    expect(comparableTargetRow).toContain("19.2%");
    expect(comparableHtml).toContain("delta $0.50");

    newer.meta.pipelineVersion = "pipeline-incompatible";
    const incompatibleHtml = await renderDiffBody(
      diffReports(older, newer, persistedVersions(older, newer)),
    );
    const incompatibleTargetRow = incompatibleHtml.match(
      /<div data-transition="changed" data-comparison="not-comparable" data-direction="neutral" data-identity="bull target"[^>]*>[\s\S]*?<\/div>/,
    )?.[0];
    expect(incompatibleTargetRow).toBeDefined();
    expect(incompatibleTargetRow).not.toMatch(/text-(?:pos|neg)/);
    expect(incompatibleTargetRow).not.toContain("19.2%");
    expect(incompatibleHtml).not.toContain("delta $0.50");
  });

  it("actual DiffPage maps pipeline versions from reports and nullable spec versions from rows", async () => {
    const older = loadFixtureReport();
    const newer = clone(older);
    older.meta.symbol = "AAPL";
    newer.meta.symbol = "AAPL";
    older.meta.pipelineVersion = "pipeline-from-report";
    newer.meta.pipelineVersion = "pipeline-to-report";
    newer.valuation.scenarios.find((scenario) => scenario.name === "bull")!.priceTarget!.value += 10;
    const olderId = seedReport({
      symbol: "AAPL",
      createdAt: "2026-08-01T00:00:00.000Z",
      reportJson: JSON.stringify(older),
      specVersion: "1.1.0-row",
    });
    const newerId = seedReport({
      symbol: "AAPL",
      createdAt: "2026-08-02T00:00:00.000Z",
      reportJson: JSON.stringify(newer),
      specVersion: null,
    });
    const diffPageModule = await loadDiffPageModule();
    const tree = await diffPageModule.default({
      params: Promise.resolve({ symbol: "AAPL" }),
      searchParams: Promise.resolve({ a: String(olderId), b: String(newerId) }),
    });
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain("pipeline pipeline-from-report");
    expect(html).toContain("pipeline-to-report");
    expect(html).toContain("spec 1.1.0-row");
    expect(html).toContain("unknown");
    expect(html).toContain("Source persisted spec version conflicts with embedded metadata");
    expect(html).toContain("Target persisted spec version is missing");
    expect(html).toContain("comparison not comparable");
    expect(html).not.toContain("comparison unchanged");

    const swappedTree = await diffPageModule.default({
      params: Promise.resolve({ symbol: "AAPL" }),
      searchParams: Promise.resolve({ a: String(newerId), b: String(olderId) }),
    });
    const swappedHtml = renderToStaticMarkup(swappedTree as ReactElement);
    expect(swappedHtml).toContain("Selected reports were out of chronological order");
    expect(swappedHtml.indexOf("pipeline-from-report")).toBeLessThan(
      swappedHtml.indexOf("pipeline-to-report"),
    );
    expect(swappedHtml.indexOf("1.1.0-row")).toBeLessThan(
      swappedHtml.indexOf("unknown"),
    );
    expect(swappedHtml).toContain("Source persisted spec version conflicts with embedded metadata");
    expect(swappedHtml).toContain("Target persisted spec version is missing");
  });

  it("actual DiffPage renders a fixed unavailable state for a sanitized entity conflict", async () => {
    const mismatched = loadFixtureReport();
    mismatched.meta.symbol = "raw-entity-secret-<script>alert(1)</script>";
    const badId = seedReport({
      symbol: "AAPL",
      createdAt: "2026-08-01T00:00:00.000Z",
      reportJson: JSON.stringify(mismatched),
    });
    const goodId = seedReport({
      symbol: "AAPL",
      createdAt: "2026-08-02T00:00:00.000Z",
      report: loadFixtureReport(),
    });
    const diffPageModule = await loadDiffPageModule();
    const tree = await diffPageModule.default({
      params: Promise.resolve({ symbol: "AAPL" }),
      searchParams: Promise.resolve({ a: String(badId), b: String(goodId) }),
    });
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain("report unavailable");
    expect(html).not.toContain("raw-entity-secret");
    expect(html).not.toContain("script");
  });
});

/* ------------------------------------------------------------------------ *
 * Legacy-read leniency (2026-07-20 regression)
 *
 * Reports persisted under earlier spec versions carry asOf strings the
 * strict IsoDateSchema rejects ("2026-06", "2025-12-31/2026-05-05") and
 * prose the newer rating-language battery rejects. Those gates are
 * SAVE-time contracts: parseStoredReport must retry leniently so paid,
 * previously-readable reports never become unrenderable (observed live:
 * 12 of 36 stored reports failed before the fallback existed).
 * ------------------------------------------------------------------------ */

describe("parseStoredReport — legacy-read leniency", () => {
  function legacyReportJson(): string {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    raw.meta.symbol = "LEGACY";
    // Legacy asOf shapes seen in the real DB (year-month + date-range).
    raw.fundamentals.commentary[0].asOf = "2026-06";
    raw.verdict.executiveSummary[0].asOf = "2025-12-31/2026-05-05";
    // Prose the save-time battery rejects — legal in reports saved under the
    // old contract, and must remain displayable.
    raw.verdict.executiveSummary[1].text =
      "Analysts said investors should buy the stock on dips.";
    return JSON.stringify(raw);
  }

  it("the strict schema rejects the legacy shapes (save-time contract intact)", () => {
    const strict = ReportSchema.safeParse(JSON.parse(legacyReportJson()));
    expect(strict.success).toBe(false);
  });

  it("parseStoredReport still reads the legacy report (lenient retry)", () => {
    const report = parseStoredReport(legacyReportJson());
    expect(report).not.toBeNull();
    expect(report?.fundamentals.commentary[0]?.asOf).toBe("2026-06");
    expect(report?.verdict.executiveSummary?.[1]?.text).toContain("buy the stock");
  });

  it("leniency does not relax shape or strictness — corrupt rows stay null", () => {
    expect(parseStoredReport('{"meta": {"symbol": "X"}}')).toBeNull();
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    raw.verdict.unknownExtraKey = true; // .strict() must still reject
    expect(parseStoredReport(JSON.stringify(raw))).toBeNull();
  });

  it("getReportRecordById classifies a legacy report as ok, not unparseable", () => {
    const id = seedReport({
      symbol: "LEGACY",
      createdAt: "2026-07-10T00:00:00.000Z",
      reportJson: legacyReportJson(),
    });
    const rec = getReportRecordById(id);
    expect(rec.kind).toBe("ok");
  });
});

describe("immutable legacy entity safety across stored-report reads", () => {
  const entityConflict = "TRIUMPH evaluates Foundayo";

  it("sanitizes direct, ID, diff-pair, Markdown, and print reads without changing stored bytes", () => {
    const report = loadFixtureReport();
    report.meta.symbol = "LLY";
    report.meta.companyName = "Eli Lilly and Company";
    report.verdict.synthesis = entityConflict;
    expect(ReportSchema.safeParse(report).success).toBe(true);
    const insertedJsonByteForByte = JSON.stringify(report);
    const olderId = seedReport({
      symbol: "LLY",
      createdAt: "2026-07-01T00:00:00.000Z",
      reportJson: insertedJsonByteForByte,
    });
    const newerId = seedReport({
      symbol: "LLY",
      createdAt: "2026-07-02T00:00:00.000Z",
      reportJson: insertedJsonByteForByte,
    });

    const direct = parseStoredReport(insertedJsonByteForByte);
    const byId = getReportById(olderId);
    const pair = loadReportPair(olderId, newerId);
    expect(direct).not.toBeNull();
    expect(byId).not.toBeNull();
    expect(pair).not.toBeNull();

    for (const candidate of [direct!, byId!.report, pair!.a.report, pair!.b.report]) {
      expect(JSON.stringify(candidate)).not.toContain(entityConflict);
      expect(candidate.appendix.missingData).toContainEqual(
        expect.objectContaining({ field: "legacy.entityValidation", severity: "critical" }),
      );
    }

    const markdown = reportToMarkdown(byId!.report);
    const printHtml = reportToPrintHtml(byId!.report);
    for (const rendered of [markdown, printHtml]) {
      expect(rendered).not.toContain(entityConflict);
      expect(rendered).toContain("legacy.entityValidation");
      expect(rendered).toContain("critical");
    }

    const stored = handle.sqlite
      .prepare('SELECT "reportJson" FROM "reports" WHERE "id" = ?')
      .get(olderId) as { reportJson: string };
    expect(stored.reportJson).toBe(insertedJsonByteForByte);
  });
});
