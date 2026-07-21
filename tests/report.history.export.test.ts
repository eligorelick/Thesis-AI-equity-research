/**
 * Report history + Markdown export tests.
 *
 * NO DOM/JSX render (vitest env is "node") — this exercises the pure logic:
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
  type Report,
} from "@/report/schema";
import {
  reportToMarkdown,
  DISCLAIMER_TEXT,
  FRED_ATTRIBUTION_TEXT,
} from "@/report/export/markdown";
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
  const json =
    opts.reportJson !== undefined
      ? opts.reportJson
      : opts.report === null || opts.report === undefined
        ? null
        : JSON.stringify(opts.report);
  const row = handle.db
    .insert(reports)
    .values({
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      symbol: opts.symbol ?? "AAPL",
      createdAt: opts.createdAt,
      model: opts.model ?? "claude-opus-4-8",
      status: opts.status ?? "done",
      reportJson: json,
      verificationRate: opts.verificationRate ?? null,
      costUsd: opts.costUsd ?? null,
      specVersion: opts.specVersion ?? REPORT_SPEC_VERSION,
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
      expect(record.report.meta.symbol).toBe("DEMO");
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
    expect(loaded?.report.meta.symbol).toBe("DEMO");
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

    const diff = diffReports(older, newer);

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

    const diff = diffReports(older, newer);
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
    const diff = diffReports(report, clone(report));
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
