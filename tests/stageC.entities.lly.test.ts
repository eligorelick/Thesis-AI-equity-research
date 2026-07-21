import { describe, expect, it } from "vitest";

import {
  LLY_ENTITY_REGISTRY,
  getEntityRegistry,
  collectEntityConflicts,
  validateEntityText,
  validateJudgeEntityResolution,
  type EntityRegistry,
} from "@/pipeline/stageC/entityValidation";

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

describe("canonical entity validation", () => {
  it("returns only explicitly curated issuer registries", () => {
    expect(getEntityRegistry("lly")).toBe(LLY_ENTITY_REGISTRY);
    expect(getEntityRegistry("AAPL")).toBeNull();
  });

  it("accepts primary-supported canonical drug and trial relationships", () => {
    const result = validateEntityText(
      "ACHIEVE-4 evaluated Foundayo (orforglipron).",
      LLY_ENTITY_REGISTRY,
      "https://investor.lilly.com/news-releases/news-release-details/achieve-4-longest-phase-3-study-lillys-foundayo-orforglipron",
    );
    expect(result.issues).toEqual([]);
  });

  it("rejects an inverted canonical trial relationship", () => {
    expect(
      validateEntityText(
        "TRIUMPH evaluated Foundayo (orforglipron).",
        LLY_ENTITY_REGISTRY,
        null,
      ).issues,
    ).toContainEqual(expect.objectContaining({ code: "relationship-conflict" }));
  });

  it("surfaces a synthetic unsupported alias instead of replacing it", () => {
    expect(
      validateEntityText("DemoMedd", SYNTHETIC_ENTITY_REGISTRY, null).issues,
    ).toContainEqual(
      expect.objectContaining({ code: "unsupported-alias", canonicalName: "DemoMed" }),
    );
  });

  it("requires a registered primary source for material canonical entity claims", () => {
    const result = validateEntityText(
      "Foundayo (orforglipron) is Lilly's oral GLP-1 medicine.",
      LLY_ENTITY_REGISTRY,
      "https://example.test/not-primary",
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "primary-source-required" }),
    );
  });

  it("detects synthetic alias and relationship conflicts", () => {
    const conflicts = collectEntityConflicts(
      ["DemoMedd launch remains early."],
      ["DEMO-TRIAL evaluated ControlMed."],
      SYNTHETIC_ENTITY_REGISTRY,
    );
    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonicalName: "DemoMed" }),
        expect.objectContaining({ code: "relationship-conflict" }),
      ]),
    );
  });

  it("requires the judge to resolve every synthetic entity conflict", () => {
    const bull = ["DemoMedd launch remains early."];
    const bear = ["DEMO-TRIAL evaluated ControlMed."];
    const conflicts = collectEntityConflicts(bull, bear, SYNTHETIC_ENTITY_REGISTRY);
    expect(validateJudgeEntityResolution(conflicts, [])).toHaveLength(conflicts.length);
    expect(
      validateJudgeEntityResolution(conflicts, [
        {
          kind: "entity",
          topic: "DemoMed and DEMO-TRIAL entity conflicts",
          bullView: bull.join(" "),
          bearView: bear.join(" "),
          judgeResolution:
            "Use DemoMed and associate DEMO-TRIAL with DemoMed; ControlMed is a separate entity.",
        },
      ]),
    ).toEqual([]);
  });
});
