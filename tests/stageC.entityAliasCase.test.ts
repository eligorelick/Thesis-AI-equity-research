import { describe, expect, it } from "vitest";

import { getEntityRegistry, validateEntityText, type EntityRegistry } from "@/pipeline/stageC/entityValidation";

/**
 * Several curated LLY trial programs are acronyms that are also ordinary
 * English verbs — ACHIEVE, ATTAIN, TRIUMPH, TRANSCEND. Alias matching was
 * case-insensitive, so a sentence like "management expects to achieve mid-teens
 * margins" registered a trial mention and raised a spurious
 * `primary-source-required` issue, withholding correct analyst prose.
 *
 * Real mentions capitalize the acronym, so an ALL-CAPS alias must match
 * case-sensitively. Ordinary mixed-case aliases (drug and company names) keep
 * case-insensitive matching.
 */
const registry = getEntityRegistry("LLY")!;

describe("entity alias matching vs ordinary English", () => {
  it("has a registry to test against", () => {
    expect(registry).toBeTruthy();
  });

  it("does not treat the verb 'achieve' as a trial mention", () => {
    const r = validateEntityText(
      "Management expects to achieve mid-teens operating margins by 2027.",
      registry,
      "some-source",
    );

    expect(r.mentions).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it("does not fire on attain / triumph / transcend used as verbs", () => {
    const r = validateEntityText(
      "Cost programs should attain their targets, and the brand may transcend its category even if rivals triumph in retail.",
      registry,
      "some-source",
    );

    expect(r.mentions).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it("still recognizes the trial acronym when written in caps", () => {
    const r = validateEntityText(
      "The ACHIEVE readout is expected in the second half.",
      registry,
      "some-source",
    );

    expect(r.mentions.map((m) => m.canonicalName)).toContain("ACHIEVE");
  });

  it("keeps case-insensitive matching for ordinary mixed-case aliases", () => {
    const r = validateEntityText(
      "The company closed its acquisition of orna therapeutics.",
      registry,
      "some-source",
    );

    expect(r.mentions.map((m) => m.canonicalName)).toContain("Orna Therapeutics");
  });
});

/**
 * `relationship-conflict` fired once per (mentioned trial x every OTHER
 * mentioned drug), with no requirement that the trial's own registered drug be
 * absent. So a factually correct sentence naming two programmes side by side
 * produced a conflict, and the judge pass then withheld correct prose from the
 * stored report. A conflict now requires the registered drug to be MISSING.
 */
describe("relationship-conflict requires an actual conflict, not co-occurrence", () => {
  it("does not flag correct prose that names the registered drug alongside another", () => {
    const text =
      "ATTAIN-1 showed orforglipron delivered 12 percent weight loss, while " +
      "retatrutide delivered 24 percent in TRIUMPH-4.";
    const { issues } = validateEntityText(text, getEntityRegistry("LLY") as EntityRegistry, "test-source");

    expect(issues.filter((i) => i.code === "relationship-conflict")).toHaveLength(0);
  });

  it("still flags a trial attributed to a drug when its own drug is absent", () => {
    const text = "ATTAIN-1 showed retatrutide delivered 24 percent weight loss.";
    const { issues } = validateEntityText(text, getEntityRegistry("LLY") as EntityRegistry, "test-source");

    expect(issues.some((i) => i.code === "relationship-conflict")).toBe(true);
  });
});
