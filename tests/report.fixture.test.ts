/**
 * Guards the full-report UI fixture (fixtures/report/DEMO-sample.json) and the
 * report-view format helpers. NO DOM/JSX render (no DOM env configured) — this
 * asserts the fixture parses cleanly against ReportSchema (which, being the
 * full report contract, transitively exercises every section type), plus a few
 * cross-field invariants the schema alone does not fully pin, and unit-tests
 * the formatting helpers added in src/components/report/primitives.tsx.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

import {
  ReportSchema,
  noBuySellHold,
  DISCLAIMER_TEXT,
  FRED_ATTRIBUTION_TEXT,
  REPORT_SPEC_VERSION,
  type Report,
} from "@/report/schema";
import {
  formatNumber,
  formatCurrency,
  formatPct,
  formatLargeNumber,
  formatMultiple,
  formatTracedValue,
} from "@/components/report/primitives";

const FIXTURE_PATH = path.join(
  process.cwd(),
  "fixtures",
  "report",
  "DEMO-sample.json",
);

function loadRaw(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

describe("DEMO-sample.json fixture", () => {
  it("is wholly synthetic and parses through the strict current schema", () => {
    const rawText = readFileSync(FIXTURE_PATH, "utf8");
    const parsed = ReportSchema.safeParse(JSON.parse(rawText));
    if (!parsed.success) {
      // Surface the first issues to make a failure actionable.
      const issues = parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`fixture failed validation:\n${issues}`);
    }
    expect(parsed.success).toBe(true);
    expect(parsed.data.meta.symbol).toBe("DEMO");
    expect(parsed.data.meta.companyName).toBe("Thesis Example Systems");
    expect(parsed.data.meta.specVersion).toBe(REPORT_SPEC_VERSION);
    expect(rawText).toContain("SYNTHETIC");
    expect(rawText).not.toMatch(
      /Apple|AAPL|iPhone|Tim Cook|Cupertino|apple\.com/i,
    );
  });

  describe("with the parsed report", () => {
    let report: Report;

    beforeAll(() => {
      const parsed = ReportSchema.safeParse(loadRaw());
      // Guarded by the test above; assert here for the type narrow.
      if (!parsed.success) throw new Error("fixture must parse");
      report = parsed.data;
    });

    it("is a fully analyzed report (NOT data-only)", () => {
      const dataOnly = report.appendix.missingData.some(
        (m) => m.field === "analysis.llm",
      );
      expect(dataOnly).toBe(false);
    });

    it("carries the mandatory disclaimer + FRED attribution literals", () => {
      expect(report.meta.disclaimer).toBe(DISCLAIMER_TEXT);
      expect(report.macro.fredAttribution).toBe(FRED_ATTRIBUTION_TEXT);
    });

    it("has exactly 3 scenarios whose probabilities sum to 1.0", () => {
      const s = report.valuation.scenarios;
      expect(s).toHaveLength(3);
      expect(s.map((x) => x.name).sort()).toEqual(["base", "bear", "bull"]);
      const sum = s.reduce((a, x) => a + (x.probability ?? 0), 0);
      expect(Math.abs(sum - 1)).toBeLessThanOrEqual(0.01);
    });

    it("populates all six graded sections of the strip", () => {
      const strip = report.verdict.gradeStrip;
      for (const key of [
        "fundamentals",
        "valuation",
        "technicals",
        "quality",
        "leadership",
        "moat",
      ] as const) {
        expect(strip[key].grade).toMatch(/^[A-F]$/);
        expect(strip[key].reasoning.length).toBeGreaterThan(0);
      }
    });

    it("uses a realistic spread of grades (not all identical)", () => {
      const strip = report.verdict.gradeStrip;
      const grades = new Set([
        strip.fundamentals.grade,
        strip.valuation.grade,
        strip.technicals.grade,
        strip.quality.grade,
        strip.leadership.grade,
        strip.moat.grade,
      ]);
      // At least two distinct letter grades across the six sections.
      expect(grades.size).toBeGreaterThanOrEqual(2);
    });

    it("populates the prominent Catalysts & Risks panel", () => {
      expect(report.catalystsRisks.catalysts.length).toBeGreaterThan(0);
      expect(report.catalystsRisks.risks.length).toBeGreaterThan(0);
      // Every catalyst carries a direction + significance; every risk a matrix
      // position.
      for (const c of report.catalystsRisks.catalysts) {
        expect(["positive", "negative", "mixed"]).toContain(c.direction);
        expect(["high", "medium", "low"]).toContain(c.significance);
      }
      for (const r of report.catalystsRisks.risks) {
        expect(["high", "medium", "low"]).toContain(r.severity);
        expect(["high", "medium", "low"]).toContain(r.probability);
      }
    });

    it("populates executives, multiples, forensics, macro, and appendix", () => {
      expect(report.leadership.executives.length).toBeGreaterThan(0);
      expect(report.valuation.multiples.length).toBeGreaterThan(0);
      expect(report.valuation.dcf.sensitivityGrid.length).toBeGreaterThan(0);
      expect(report.quality.forensicScores.beneish.score).not.toBeNull();
      expect(report.macro.relevantSeries.length).toBeGreaterThan(0);
      expect(report.appendix.sources.length).toBeGreaterThan(0);
      expect(report.appendix.costBreakdown.length).toBeGreaterThan(0);
    });

    it("keeps every rating-guarded free-text field clean of buy/sell/hold", () => {
      // The schema already refines these, but assert directly on the fixture so
      // a regression in the prose is caught with a clear message.
      const texts: string[] = [
        report.verdict.synthesis,
        report.valuation.reverseDcf.narrative,
        report.competitive.marketShareDirection,
      ];
      for (const sc of report.valuation.scenarios) {
        texts.push(...sc.assumptions, ...sc.whatWouldHaveToBeTrue);
      }
      for (const t of texts) {
        expect(noBuySellHold(t)).toBe(true);
      }
    });

    it("every scenario price target is a computed TracedNumber (or null when suppressed) with a source + as-of", () => {
      for (const sc of report.valuation.scenarios) {
        // A scenario target is either the deterministic computed TracedNumber or
        // null (suppressed when valuation inputs are insufficient) — never fabricated.
        const pt = sc.priceTarget;
        if (pt === null) continue;
        expect(typeof pt.value).toBe("number");
        expect(pt.source.length).toBeGreaterThan(0);
        expect(pt.asOf).not.toBeNull();
      }
    });
  });
});

describe("report format helpers", () => {
  it("formatNumber groups and pads; handles null/NaN", () => {
    expect(formatNumber(1234.5)).toBe("1,234.50");
    expect(formatNumber(1234.5, 0)).toBe("1,235");
    expect(formatNumber(null)).toBe("n/a");
    expect(formatNumber(undefined)).toBe("n/a");
    expect(formatNumber(Number.NaN)).toBe("n/a");
  });

  it("formatCurrency prefixes $ and groups", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
    expect(formatCurrency(0)).toBe("$0.00");
    expect(formatCurrency(null)).toBe("n/a");
  });

  it("formatPct fixes digits and optionally signs", () => {
    expect(formatPct(12.34)).toBe("12.3%");
    expect(formatPct(12.34, 2)).toBe("12.34%");
    expect(formatPct(5, 1, true)).toBe("+5.0%");
    expect(formatPct(-5, 1, true)).toBe("-5.0%");
    expect(formatPct(null)).toBe("n/a");
  });

  it("formatLargeNumber compacts to T/B/M/K", () => {
    expect(formatLargeNumber(3.5e12)).toBe("3.50T");
    expect(formatLargeNumber(45.61e9)).toBe("45.61B");
    expect(formatLargeNumber(789e6)).toBe("789.00M");
    expect(formatLargeNumber(12.3e3)).toBe("12.3K");
    expect(formatLargeNumber(-2.35e12)).toBe("-2.35T");
    expect(formatLargeNumber(500)).toBe("500.00");
    expect(formatLargeNumber(null)).toBe("n/a");
  });

  it("formatMultiple appends the × glyph; n/m for null", () => {
    expect(formatMultiple(28.6)).toBe("28.6×");
    expect(formatMultiple(null)).toBe("n/m");
  });

  it("formatTracedValue renders per the declared unit", () => {
    expect(
      formatTracedValue({
        value: 46.2,
        unit: "%",
        source: "x",
        asOf: null,
        verified: true,
      }),
    ).toBe("46.2%");
    expect(
      formatTracedValue({
        value: 28.6,
        unit: "x",
        source: "x",
        asOf: null,
        verified: true,
      }),
    ).toBe("28.6×");
    expect(
      formatTracedValue({
        value: 198.4,
        unit: "usd",
        source: "x",
        asOf: null,
        verified: true,
      }),
    ).toBe("$198.40");
    expect(
      formatTracedValue({
        value: 3.5e12,
        unit: "usd_large",
        source: "x",
        asOf: null,
        verified: true,
      }),
    ).toBe("$3.50T");
    // Unknown unit falls back to number + raw unit suffix.
    expect(
      formatTracedValue({
        value: 5,
        unit: "widgets",
        source: "x",
        asOf: null,
        verified: true,
      }),
    ).toBe("5.00 widgets");
  });
});
