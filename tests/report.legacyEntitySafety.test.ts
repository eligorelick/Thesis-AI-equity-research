import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { EntityRegistry } from "@/pipeline/stageC/entityValidation";
import { sanitizeLegacyEntityConflicts } from "@/report/legacyEntitySafety";
import { ReportSchema } from "@/report/schema";

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
});
