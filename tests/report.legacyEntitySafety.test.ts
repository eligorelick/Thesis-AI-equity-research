import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { EntityRegistry } from "@/pipeline/stageC/entityValidation";
import {
  parseStoredReportWithSafety,
  sanitizeLegacyEntityConflicts,
  validateStoredReportInReadMode,
} from "@/report/legacyEntitySafety";
import { ReportSchema, type Report } from "@/report/schema";

const ENTITY_CONFLICT = "TRIUMPH evaluates Foundayo";

function fixtureReport(symbol: string): Report {
  const parsed = ReportSchema.parse(
    JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "report", "DEMO-sample.json"), "utf8")),
  );
  parsed.meta.symbol = symbol;
  return parsed;
}

const SYNTHETIC_ENTITY_REGISTRY: EntityRegistry = {
  symbol: "DEMO",
  records: [
    {
      id: "drug.demo",
      kind: "drug",
      canonicalName: "DemoMed",
      aliases: [
        { value: "DemoMed", status: "supported" },
        { value: "DemoMedd", status: "unsupported" },
      ],
      primarySourceIds: ["demo:primary"],
    },
    {
      id: "drug.control",
      kind: "drug",
      canonicalName: "ControlMed",
      aliases: [{ value: "ControlMed", status: "supported" }],
      primarySourceIds: ["demo:primary"],
    },
    {
      id: "trial.demo",
      kind: "trial-program",
      canonicalName: "DEMO-TRIAL",
      aliases: [{ value: "DEMO-TRIAL", status: "supported" }],
      relatedEntityId: "drug.demo",
      primarySourceIds: ["demo:primary"],
    },
  ],
};

describe("read-only legacy export safety", () => {
  it("withholds whole unsupported statements and records the conflict", () => {
    const report = ReportSchema.parse(
      JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "report", "DEMO-sample.json"), "utf8")),
    );
    report.meta.symbol = "DEMO";
    report.verdict.synthesis = "DemoMedd succeeds and DEMO-TRIAL evaluates ControlMed.";
    const claim = report.verdict.gradeStrip.fundamentals.reasoning[0];
    const originalSource = claim.source;
    claim.source = `[${claim.source} · ${claim.asOf}]`;

    const result = sanitizeLegacyEntityConflicts(report, SYNTHETIC_ENTITY_REGISTRY);
    const serialized = JSON.stringify(result.report);

    expect(result.withheldCount).toBeGreaterThan(0);
    expect(serialized).not.toContain("DemoMedd");
    expect(serialized).not.toContain("DEMO-TRIAL evaluates ControlMed");
    expect(result.report.appendix.missingData).toContainEqual(
      expect.objectContaining({ field: "legacy.entityValidation", severity: "critical" }),
    );
    expect(result.report.verdict.gradeStrip.fundamentals.reasoning[0].sourceId).toBe(originalSource);
    expect(result.report.verdict.gradeStrip.fundamentals.reasoning[0].source).toBe(originalSource);
    expect(ReportSchema.safeParse(result.report).success).toBe(true);
  });

  it("does not withhold prose that merely uses an acronym alias as an ordinary verb", () => {
    // The real LLY registry carries trial acronyms that are also English verbs
    // (ACHIEVE, ATTAIN, TRIUMPH, TRANSCEND). Matching them case-insensitively
    // made ordinary analyst prose look like an entity conflict and replaced the
    // whole sentence with a "Legacy statement withheld" placeholder.
    const report = fixtureReport("DEMO");
    const prose =
      "Management expects to achieve mid-teens margins and attain its cost targets.";
    report.verdict.synthesis = prose;

    const result = sanitizeLegacyEntityConflicts(report, SYNTHETIC_ENTITY_REGISTRY);

    expect(result.report.verdict.synthesis).toBe(prose);
    expect(JSON.stringify(result.report)).not.toContain("Legacy statement withheld");
  });

  it("legacy entity safety preserves rendered citation correction and marks ambiguity unsupported", () => {
    const report = fixtureReport("DEMO");
    const rendered = report.verdict.gradeStrip.fundamentals.reasoning[0];
    const originalSource = rendered.source;
    delete rendered.sourceId;
    rendered.source = `[${originalSource} · ${rendered.asOf}]`;
    const ambiguous = report.verdict.gradeStrip.valuation.reasoning[0];
    delete ambiguous.sourceId;
    ambiguous.source = "[ambiguous";

    const result = sanitizeLegacyEntityConflicts(report, SYNTHETIC_ENTITY_REGISTRY);

    expect(result.report.verdict.gradeStrip.fundamentals.reasoning[0]).toMatchObject({
      source: originalSource,
      sourceId: originalSource,
    });
    expect(result.report.verdict.gradeStrip.valuation.reasoning[0].source).toBe(
      "unsupported:legacy-citation",
    );
    expect(result.report.appendix.missingData).toContainEqual(
      expect.objectContaining({ field: "legacy.citationValidation", severity: "warn" }),
    );
    expect(ReportSchema.safeParse(result.report).success).toBe(true);
  });

  it("parseStoredReportWithSafety reports strict mode and withholds legacy entity conflicts", () => {
    const report = fixtureReport("LLY");
    report.verdict.synthesis = ENTITY_CONFLICT;
    const insertedJson = JSON.stringify(ReportSchema.parse(report));

    const result = parseStoredReportWithSafety(insertedJson);

    expect(result).not.toBeNull();
    expect(result?.readMode).toBe("strict");
    expect(result?.withheldCount).toBeGreaterThan(0);
    expect(result?.issues).not.toHaveLength(0);
    expect(JSON.stringify(result?.report)).not.toContain(ENTITY_CONFLICT);
    expect(result?.report.appendix.missingData).toContainEqual(
      expect.objectContaining({ field: "legacy.entityValidation", severity: "critical" }),
    );
    expect(insertedJson).toContain(ENTITY_CONFLICT);

    const reread = parseStoredReportWithSafety(JSON.stringify(result?.report));
    expect(reread?.report).toEqual(result?.report);
    expect(reread?.withheldCount).toBe(0);
    expect(reread?.issues).toEqual([]);
  });

  it("legacy entity safety preserves lenient read mode and keeps the legacy report readable", () => {
    const report = fixtureReport("LLY");
    report.fundamentals.commentary[0]!.asOf = "2026-06";
    report.verdict.synthesis = ENTITY_CONFLICT;
    const legacyJson = JSON.stringify(report);
    expect(ReportSchema.safeParse(JSON.parse(legacyJson)).success).toBe(false);

    const result = parseStoredReportWithSafety(legacyJson);

    expect(result).not.toBeNull();
    expect(result?.readMode).toBe("legacy");
    expect(result?.report.fundamentals.commentary[0]?.asOf).toBe("2026-06");
    expect(JSON.stringify(result?.report)).not.toContain(ENTITY_CONFLICT);
    expect(result?.report.appendix.missingData).toContainEqual(
      expect.objectContaining({ field: "legacy.entityValidation", severity: "critical" }),
    );
    expect(validateStoredReportInReadMode(result?.report, result!.readMode)).not.toBeNull();
    expect(validateStoredReportInReadMode(result?.report, "strict")).toBeNull();
  });

  it("leaves a clean LLY report idempotent and an uncovered AAPL report unchanged", () => {
    for (const symbol of ["LLY", "AAPL"]) {
      const report = fixtureReport(symbol);
      const insertedJson = JSON.stringify(ReportSchema.parse(report));

      const first = parseStoredReportWithSafety(insertedJson);
      const second = parseStoredReportWithSafety(JSON.stringify(first?.report));

      expect(first?.readMode).toBe("strict");
      expect(first?.withheldCount).toBe(0);
      expect(first?.issues).toEqual([]);
      expect(first?.report).toEqual(ReportSchema.parse(JSON.parse(insertedJson)));
      expect(second?.report).toEqual(first?.report);
      expect(second?.withheldCount).toBe(0);
    }
  });

  it("legacy entity safety keeps null, malformed, and schema-invalid rows unreadable", () => {
    expect(parseStoredReportWithSafety(null)).toBeNull();
    expect(parseStoredReportWithSafety("{ not json")).toBeNull();
    expect(parseStoredReportWithSafety(JSON.stringify({ meta: { symbol: "LLY" } }))).toBeNull();
  });
});
