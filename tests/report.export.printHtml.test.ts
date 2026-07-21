/**
 * Coverage for the print/PDF HTML renderer (src/report/export/printHtml.ts),
 * previously untested (full-codebase-audit-2026-07-09 test-gap finding).
 *
 * Verifies:
 *   - esc() escapes all five HTML-sensitive characters;
 *   - a schema-valid report renders with no literal "undefined"/"NaN";
 *   - optional sections absent -> gracefully omitted (no crash, no stray marker);
 *   - the missing-data manifest, disclaimer, and FRED attribution render verbatim;
 *   - injected markup ("<script>alert(1)</script>") appears only escaped.
 *
 * The fixture (fixtures/report/DEMO-sample.json) is the same one guarded by
 * tests/report.fixture.test.ts; it is parsed through ReportSchema so every
 * section is populated with real, contract-valid content.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

import {
  ReportSchema,
  DISCLAIMER_TEXT,
  FRED_ATTRIBUTION_TEXT,
  type Report,
} from "@/report/schema";
import {
  esc,
  reportToPrintBody,
  reportToPrintHtml,
} from "@/report/export/printHtml";

const FIXTURE_PATH = path.join(
  process.cwd(),
  "fixtures",
  "report",
  "DEMO-sample.json",
);

function loadReport(): Report {
  const parsed = ReportSchema.safeParse(
    JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
  );
  if (!parsed.success) throw new Error("fixture must parse against ReportSchema");
  return parsed.data;
}

describe("esc()", () => {
  it("escapes all five HTML-sensitive characters", () => {
    expect(esc("&")).toBe("&amp;");
    expect(esc("<")).toBe("&lt;");
    expect(esc(">")).toBe("&gt;");
    expect(esc('"')).toBe("&quot;");
    expect(esc("'")).toBe("&#39;");
  });

  it("escapes ampersands first so entities are not double-broken", () => {
    // A naive order would turn "<" -> "&lt;" then re-escape the "&".
    expect(esc("<a & b>")).toBe("&lt;a &amp; b&gt;");
    expect(esc('a"b\'c')).toBe("a&quot;b&#39;c");
  });

  it("leaves already-safe text untouched", () => {
    expect(esc("plain ascii 123 — em dash ok")).toBe(
      "plain ascii 123 — em dash ok",
    );
  });
});

describe("reportToPrintHtml — full schema-valid report", () => {
  let report: Report;
  let html: string;
  let body: string;

  beforeAll(() => {
    report = loadReport();
    html = reportToPrintHtml(report);
    body = reportToPrintBody(report);
  });

  it("emits a well-formed standalone document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<html lang=\"en\">");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain("<style>");
    // Title carries the escaped symbol + company name.
    expect(html).toContain(esc(report.meta.symbol));
    expect(html).toContain(esc(report.meta.companyName));
  });

  it("contains no literal 'undefined' or 'NaN' anywhere in the output", () => {
    expect(html).not.toMatch(/\bundefined\b/);
    expect(html).not.toMatch(/\bNaN\b/);
  });

  it("renders every numbered section heading (1..13)", () => {
    // Both section 1 headings (Verdict, Scorecard) and 11 (Projections/Outlook)
    // reuse indices; assert on the distinctive titles instead.
    for (const title of [
      "Verdict",
      "Scorecard (deterministic)",
      "Catalysts &amp; Risks",
      "Business &amp; Segments",
      "Fundamentals",
      "Balance Sheet &amp; Capital",
      "Valuation",
      "Quality &amp; Red Flags",
      "Technicals",
      "Leadership &amp; Governance",
      "Competitive Landscape",
      "Future Outlook",
      "Weighted Projections",
      "Macro Context",
      "Appendix",
    ]) {
      expect(body).toContain(title);
    }
  });

  it("auto-print script is opt-in", () => {
    expect(reportToPrintHtml(report)).not.toContain("window.print()");
    expect(reportToPrintHtml(report, { autoPrint: true })).toContain(
      "window.print()",
    );
  });

  it("renders the disclaimer and FRED attribution verbatim", () => {
    // Neither constant contains HTML-sensitive characters, so esc() is a no-op
    // and they must appear byte-for-byte.
    expect(DISCLAIMER_TEXT).toBe(esc(DISCLAIMER_TEXT));
    expect(FRED_ATTRIBUTION_TEXT).toBe(esc(FRED_ATTRIBUTION_TEXT));
    expect(body).toContain(DISCLAIMER_TEXT);
    expect(body).toContain(FRED_ATTRIBUTION_TEXT);
  });

  it("renders the missing-data manifest entries verbatim", () => {
    expect(report.appendix.missingData.length).toBeGreaterThan(0);
    for (const gap of report.appendix.missingData) {
      expect(body).toContain(esc(gap.field));
      expect(body).toContain(esc(gap.reason));
    }
    // The "no gaps" fallback must NOT appear when gaps exist.
    expect(body).not.toContain("full data coverage");
  });
});

describe("reportToPrintBody — optional sections absent", () => {
  it("gracefully omits scores/projections/optional grade blocks", () => {
    const base = loadReport();
    const stripped: Report = {
      ...base,
      scores: undefined,
      projections: undefined,
      verdict: {
        ...base.verdict,
        gradeStrip: { ...base.verdict.gradeStrip, balanceSheet: undefined },
      },
      balanceSheet: { ...base.balanceSheet, graded: undefined },
    };

    const body = reportToPrintBody(stripped);

    // Omitted sections leave no heading behind.
    expect(body).not.toContain("Scorecard (deterministic)");
    expect(body).not.toContain("Weighted Projections");

    // Still a valid render: no stray undefined/NaN, and the always-on sections
    // remain present.
    expect(body).not.toMatch(/\bundefined\b/);
    expect(body).not.toMatch(/\bNaN\b/);
    expect(body).toContain("Balance Sheet &amp; Capital");
    expect(body).toContain("Future Outlook");
  });

  it("renders the 'no gaps' fallback when the manifest is empty", () => {
    const base = loadReport();
    const clean: Report = {
      ...base,
      appendix: { ...base.appendix, missingData: [] },
    };
    const body = reportToPrintBody(clean);
    expect(body).toContain("full data coverage");
  });

  it("labels per-number provenance as citation coverage, never 'verified'/'unverified' (audit #2)", () => {
    // The DEMO fixture's scenario targets are verified:false (model projections),
    // so the false-branch tag is exercised. Citation coverage is provenance, not
    // correctness — the renderer must not assert a number is "verified".
    const body = reportToPrintBody(loadReport());
    expect(body).not.toContain('title="unverified"');
    expect(body).not.toContain('title="verified"');
    expect(body).toContain("not traced to a citation or payload figure");
  });

  it("labels the traced-number column 'Cited' (citation coverage), never 'Verified'", () => {
    const body = reportToPrintBody(loadReport());
    expect(body).toContain("<th>Cited</th>");
    expect(body).not.toContain("<th>Verified</th>");
    expect(body).not.toContain("Verified");
  });

  it("prints explicit provenance coverage denominators and honest zero-item rates", () => {
    const report = loadReport();
    const coverage = {
      numeric: { supported: 8, total: 10, rate: 0.8 },
      factualClaims: { supported: 3, total: 4, rate: 0.75 },
      judgments: { cited: 0, total: 0, rate: null },
    };
    report.meta.provenanceCoverage = coverage;
    report.appendix.provenanceCoverage = coverage;
    const body = reportToPrintBody(ReportSchema.parse(report));
    expect(body).toContain("Numeric provenance");
    expect(body).toContain("8/10 (80%)");
    expect(body).toContain("Factual-claim citations");
    expect(body).toContain("3/4 (75%)");
    expect(body).toContain("Judgment citations");
    expect(body).toContain("0/0 (n/a &mdash; no items)");
  });

  it("renders empty DCF assumptions + no sensitivity grid honestly when the route has no FCFF DCF", () => {
    const base = loadReport();
    const clone = JSON.parse(JSON.stringify(base)) as Report;
    clone.valuation.dcf.assumptions = [];
    clone.valuation.dcf.sensitivityGrid = [];
    const body = reportToPrintBody(ReportSchema.parse(clone));
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("NaN");
    expect(body).toContain("<h3>DCF</h3>");
  });

  it("renders the deterministic DCF assumptions with their computed basis", () => {
    const base = loadReport();
    const clone = JSON.parse(JSON.stringify(base)) as Report;
    clone.valuation.dcf.assumptions = [
      { name: "terminal growth", value: "2.5%", basis: "min(2.5%, risk-free) — deterministic house rule" },
    ];
    const body = reportToPrintBody(ReportSchema.parse(clone));
    expect(body).toContain("terminal growth");
    expect(body).toContain("min(2.5%, risk-free) — deterministic house rule");
  });

  it("renders 'unavailable' for a suppressed (null) DCF per-share, and discloses the fair-value method", () => {
    const base = loadReport();
    const suppressed = JSON.parse(JSON.stringify(base)) as Report;
    suppressed.valuation.dcf.perShare = null;
    suppressed.valuation.dcf.upsidePct = null;
    const suppBody = reportToPrintBody(ReportSchema.parse(suppressed));
    expect(suppBody.toLowerCase()).toContain("intrinsic value per share: <strong>unavailable");
    expect(suppBody).not.toContain("undefined");
    expect(suppBody).not.toContain("NaN");

    const bank = JSON.parse(JSON.stringify(base)) as Report;
    bank.fairValue = {
      status: "available",
      method: "excess-return",
      methodVersion: "FAIR_VALUE_2026_07",
      perShare: { value: 55, unit: "USD/share", source: "computed.valuation.excessReturn.perShare", asOf: "2026-07-06", verified: true },
      upsidePct: 3,
      basis: ["Intrinsic value per share = the deterministic book-value excess-return fair value (no WACC/FCFF)."],
      reasons: [],
    };
    bank.valuation.dcf.perShare = { value: 55, unit: "USD/share", source: "computed.valuation.excessReturn.perShare", asOf: "2026-07-06", verified: true };
    const bankBody = reportToPrintBody(ReportSchema.parse(bank));
    expect(bankBody).toContain("book-value excess-return fair value");
  });

  it("renders 'unavailable' for a scenario whose deterministic target is suppressed (null) — no crash / NaN", () => {
    const base = loadReport();
    const clone = JSON.parse(JSON.stringify(base)) as Report;
    for (const s of clone.valuation.scenarios) s.priceTarget = null;
    const body = reportToPrintBody(ReportSchema.parse(clone));
    expect(body.toLowerCase()).toContain("unavailable");
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("NaN");
  });

  it("discloses the computed-derived method / suppression reason for the scenario targets", () => {
    const base = loadReport();
    const available = JSON.parse(JSON.stringify(base)) as Report;
    available.scenarioTargets = {
      status: "available",
      method: "dcf-dispersion",
      methodVersion: "SCENARIO_TARGETS_2026_07",
      basis: ["base target = the deterministic FCFF-DCF fair value per share."],
      dispersion: { growthSigmaPp: 8, marginSigmaPp: 3, sigmaSource: "own-history" },
      targets: [],
      missingReasons: [],
    };
    const okBody = reportToPrintBody(ReportSchema.parse(available));
    expect(okBody.toLowerCase()).toContain("computed-derived");
    expect(okBody).toContain("deterministic FCFF-DCF fair value");

    const suppressed = JSON.parse(JSON.stringify(base)) as Report;
    for (const s of suppressed.valuation.scenarios) s.priceTarget = null;
    suppressed.scenarioTargets = {
      status: "suppressed",
      method: "dcf-dispersion",
      methodVersion: "SCENARIO_TARGETS_2026_07",
      basis: ["Scenario price targets unavailable."],
      dispersion: null,
      targets: [],
      missingReasons: [{ field: "valuation.scenarioTargets", reason: "base DCF per-share unavailable", severity: "warn" }],
    };
    const suppBody = reportToPrintBody(ReportSchema.parse(suppressed));
    expect(suppBody).toContain("base DCF per-share unavailable");
    expect(suppBody).not.toContain("undefined");
  });
});

describe("reportToPrintBody — injected markup is escaped", () => {
  it("never emits a live <script> tag from report content", () => {
    const base = loadReport();
    const payload = "<script>alert(1)</script>";
    const poisoned: Report = {
      ...base,
      verdict: { ...base.verdict, synthesis: payload },
    };

    const body = reportToPrintBody(poisoned);

    expect(body).not.toContain(payload);
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
