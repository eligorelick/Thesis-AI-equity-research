/**
 * Report schema + diff tests (the application contract §7, §1 rules).
 *
 * Covers, per the module brief:
 *  - a minimal valid report fixture parses cleanly;
 *  - the scenario probability-sum refine rejects 0.5/0.3/0.3 (=1.1) and
 *    accepts a partition summing to 1;
 *  - the buy/sell/hold refine rejects "Strong Buy" in a scenario narrative but
 *    ALLOWS "buyback" and "sell-side" (word-boundary + compound handling);
 *  - `.strict()` rejects unexpected keys;
 *  - z.toJSONSchema output closes every object with additionalProperties:false;
 *  - diffReports catches a grade change, a new catalyst, and a fuzzy title
 *    match (reworded catalyst treated as persisted, not new+removed).
 */

import { describe, expect, it } from "vitest";

import {
  ReportSchema,
  JUDGE_OUTPUT_SCHEMA,
  ANALYST_CASE_SCHEMA,
  ScenariosSchema,
  ScenarioSchema,
  GradeBlockSchema,
  SourcedClaimSchema,
  TracedNumberSchema,
  ScoringSchema,
  AspectScoreSchema,
  ProjectionsSchema,
  ProjectionSeriesSchema,
  ScenarioTargetsSchema,
  FairValueSchema,
  ProvenanceCoverageSchema,
  noBuySellHold,
  reportToJsonSchema,
  judgeOutputToJsonSchema,
  analystCaseToJsonSchema,
  fillNullableGaps,
  VerdictSchema,
  AltmanScoreSchema,
  BeneishScoreSchema,
  PiotroskiScoreSchema,
  AccrualsScoreSchema,
  DISCLAIMER_TEXT,
  FRED_ATTRIBUTION_TEXT,
  REPORT_SPEC_VERSION,
  type Report,
} from "@/report/schema";
import { diffReports } from "@/report/diff";

/* ------------------------------------------------------------------------ *
 * Fixture builders
 * ------------------------------------------------------------------------ */

function claim(text = "Revenue grew on cloud demand.") {
  return {
    text,
    label: "FACT" as const,
    source: "computed.growth.revenueCagr5y",
    asOf: "2025-09-30",
  };
}

function num(value = 1, unit = "USD") {
  return {
    value,
    unit,
    source: "computed.valuation.dcf.perShare",
    asOf: "2025-09-30",
    verified: null as boolean | null,
  };
}

function gradeBlock(grade: "A" | "B" | "C" | "D" | "F" = "B") {
  return {
    grade,
    oneLineWhy: "Durable double-digit growth with expanding margins.",
    reasoning: [claim()],
    confidence: "high" as const,
    keyNumbers: [num()],
  };
}

function scenario(
  name: "bull" | "base" | "bear",
  probability: number,
  target: number,
) {
  return {
    name,
    probability,
    priceTarget: num(target),
    horizon: "12 months",
    // NOTE: avoid the bare word "hold" here — the crude rating guard
    // (\bhold\b) rejects it. "Margins stay firm" instead of "margins hold".
    assumptions: ["Margins stay firm on operating leverage."],
    whatWouldHaveToBeTrue: ["Cloud growth stays above 20%."],
  };
}

/** A minimal but fully-valid Report. Optional overrides deep-merge shallowly. */
function makeReport(overrides: Partial<Report> = {}): Report {
  const base: Report = {
    meta: {
      symbol: "AAPL",
      companyName: "Apple Inc.",
      generatedAt: "2026-07-06T00:00:00Z",
      specVersion: REPORT_SPEC_VERSION,
      model: "claude-opus-4-8",
      pipelineVersion: "2.0.0",
      costUsd: 2.1,
      verificationRate: null,
      disclaimer: DISCLAIMER_TEXT,
      asOfMap: { "fundamentals.revenue": "2025-09-30" },
    },
    verdict: {
      synthesis:
        "A cash-generative franchise with a wide moat and steady buybacks.",
      gradeStrip: {
        fundamentals: gradeBlock("A"),
        valuation: gradeBlock("C"),
        technicals: gradeBlock("B"),
        quality: gradeBlock("A"),
        leadership: gradeBlock("B"),
        moat: gradeBlock("A"),
      },
    },
    business: {
      whatTheySell: [claim("They sell devices, services, and wearables.")],
      segments: { product: [], geographic: [] },
      concentrationRisks: [claim("iPhone is the majority of revenue.")],
    },
    fundamentals: {
      graded: gradeBlock("A"),
      growthTable: [],
      marginTrend: [],
      returns: [],
      fcf: [],
      commentary: [claim()],
    },
    balanceSheet: {
      debtProfile: { commentary: [claim()], numbers: [num()] },
      coverage: { commentary: [claim()], numbers: [num()] },
      capexTrajectory: { commentary: [claim()], numbers: [num()] },
      capitalAllocation: [claim("Consistent buyback cadence.")],
    },
    valuation: {
      graded: gradeBlock("C"),
      dcf: {
        perShare: num(180),
        assumptions: [{ name: "WACC", value: "8.5%", basis: "CAPM build" }],
        sensitivityGrid: [
          { waccPct: 8.5, gTermPct: 2.5, perShare: 180 },
          { waccPct: 9.0, gTermPct: 2.5, perShare: 165 },
        ],
        upsidePct: 0.12,
      },
      reverseDcf: {
        impliedMetric: "revenue growth",
        impliedValue: 0.08,
        narrative: "The market is pricing ~8% growth.",
      },
      multiples: [
        {
          name: "P/E",
          current: 28,
          peerMedian: 24,
          own5yPercentile: 0.7,
          sectorAppropriate: true,
        },
      ],
      scenarios: [
        scenario("bull", 0.3, 240),
        scenario("base", 0.5, 190),
        scenario("bear", 0.2, 140),
      ],
    },
    quality: {
      graded: gradeBlock("A"),
      forensicScores: {
        altman: { variant: "Z''", score: 5.1, zone: "safe" },
        beneish: { variant: "M-8", score: -2.6, zone: "unlikely" },
        piotroski: { variant: "F-9", score: 8, zone: "strong" },
        accruals: { variant: "CF", score: 0.02, zone: "low" },
      },
      flags: [
        {
          severity: "low" as const,
          text: "Receivables grew slower than revenue.",
          source: "computed.forensics.flags",
        },
      ],
    },
    technicals: {
      graded: gradeBlock("B"),
      read: {
        trend: "Above the 200-day; golden cross intact.",
        momentum: "RSI-14 neutral at 55.",
        keyLevels: "Support near 170, resistance near 200.",
        relativeStrength: "Outperforming SPY over 6 months.",
      },
      indicators: [num(55, "RSI")],
      flags: [],
    },
    leadership: {
      graded: gradeBlock("B"),
      executives: [
        {
          name: "Tim Cook",
          title: "CEO",
          tenureYears: 13,
          grade: "A" as const,
          credibilityGrade: "A" as const,
          reasoning: [claim("Consistent guidance beats.")],
          evidence: {
            guidanceVsActuals: [claim("Beat guidance 9 of last 12 quarters.")],
          },
        },
      ],
      insiderSummary: [claim("Net insider selling, mostly 10b5-1.")],
      governanceNotes: [claim("Independent board majority.")],
    },
    competitive: {
      moatGraded: gradeBlock("A"),
      peerTable: [
        { name: "Samsung", symbol: null, metrics: [num(1.5, "P/S")] },
      ],
      moatAssessment: [
        {
          source: "switchingCosts" as const,
          strength: "wide" as const,
          reasoning: [claim("Ecosystem lock-in raises switching costs.")],
        },
      ],
      marketShareDirection: "Gaining share in premium handsets.",
    },
    catalystsRisks: {
      catalysts: [
        {
          title: "AI feature launch",
          expectedDate: "2026-09-01",
          direction: "positive" as const,
          significance: "high" as const,
          reasoning: claim("New AI features could lift upgrade rates."),
        },
      ],
      risks: [
        {
          title: "China demand slowdown",
          severity: "high" as const,
          probability: "medium" as const,
          source: "10-K item1A",
          reasoning: claim("Greater China is a large revenue share."),
        },
      ],
    },
    outlook: {
      segmentTrajectories: [claim("Services keeps compounding.")],
      estimateRevisionTrend: [claim("Upward FY revisions.")],
      guidanceCredibility: [claim("High historical guidance accuracy.")],
      scenarioNarratives: {
        y1: [claim("Modest growth resumes.")],
        y3: [claim("Services mix expands margins.")],
        y5: [claim("Installed base drives durable cash flow.")],
      },
    },
    macro: {
      relevantSeries: [
        {
          seriesId: "DGS10",
          name: "10-Year Treasury",
          latest: num(4.2, "%"),
          relevance: "Discount-rate input for the DCF.",
        },
      ],
      sensitivityNotes: [claim("Rate-sensitive via the discount rate.")],
      fredAttribution: FRED_ATTRIBUTION_TEXT,
    },
    appendix: {
      sources: [
        {
          provider: "fmp",
          endpoint: "/stable/income-statement",
          asOf: "2025-09-30",
          fetchedAt: "2026-07-06T00:00:00Z",
        },
      ],
      missingData: [
        {
          field: "leadership.cet1Ratio",
          reason: "Not a financial; N/A.",
          severity: "info" as const,
        },
      ],
      verificationRate: null,
      costBreakdown: [
        { step: "synthesize", model: "claude-opus-4-8", costUsd: 1.2 },
      ],
    },
    disagreements: [
      {
        topic: "Services growth durability",
        bullView: "Services compounds for years.",
        bearView: "Services growth decelerates as penetration saturates.",
        kind: "interpretation" as const,
        judgeResolution: "Growth likely moderates but stays positive.",
      },
    ],
  };
  return { ...base, ...overrides };
}

/* ------------------------------------------------------------------------ *
 * Valid fixture parses
 * ------------------------------------------------------------------------ */

describe("ReportSchema — valid fixture", () => {
  it("parses a minimal valid report", () => {
    const result = ReportSchema.safeParse(makeReport());
    if (!result.success) {
      // Surface the first issue for a legible failure.
      throw new Error(JSON.stringify(result.error.issues.slice(0, 3), null, 2));
    }
    expect(result.success).toBe(true);
  });

  it("JUDGE_OUTPUT_SCHEMA parses the report minus meta/appendix", () => {
    const r = makeReport();
    const {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      meta,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      appendix,
      ...judge
    } = r;
    expect(JUDGE_OUTPUT_SCHEMA.safeParse(judge).success).toBe(true);
  });

  it("ANALYST_CASE_SCHEMA parses a bull/bear case", () => {
    const analystCase = {
      thesis: [claim()],
      keyDrivers: [claim("Operating leverage.")],
      risksToCase: [claim("FX headwinds.")],
      catalysts: [claim("Product cycle.")],
      priceTarget: {
        value: 240,
        horizon: "12 months",
        assumptions: ["Margins expand 100bps."],
      },
      evidence: [num()],
    };
    expect(ANALYST_CASE_SCHEMA.safeParse(analystCase).success).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * L5 — disclaimer / fredAttribution are stored-text tolerant (parse-side)
 *
 * Every read path safeParses the whole ReportSchema and degrades to null on
 * failure. Pinning meta.disclaimer / macro.fredAttribution to z.literal of a
 * MUTABLE module constant meant any future edit to either constant would
 * silently brick ALL historical reports. The schema now accepts any non-empty
 * string on the parse side so historical documents remain readable forever,
 * while generation still embeds the CURRENT constants (pinned below + in
 * report.fixture / stageC.payload / report.history.export generation tests).
 * ------------------------------------------------------------------------ */

describe("L5: stored disclaimer / fredAttribution tolerance", () => {
  it("parses a historical report whose disclaimer differs from the current DISCLAIMER_TEXT", () => {
    const oldReport = makeReport();
    oldReport.meta.disclaimer =
      "For informational purposes only. Not a recommendation to buy or sell.";
    // Sanity: this is genuinely a DIFFERENT string than the current constant.
    expect(oldReport.meta.disclaimer).not.toBe(DISCLAIMER_TEXT);
    expect(ReportSchema.safeParse(oldReport).success).toBe(true);
  });

  it("parses a historical report whose fredAttribution differs from the current FRED_ATTRIBUTION_TEXT", () => {
    const oldReport = makeReport();
    oldReport.macro.fredAttribution =
      "Data provided by FRED, Federal Reserve Bank of St. Louis.";
    expect(oldReport.macro.fredAttribution).not.toBe(FRED_ATTRIBUTION_TEXT);
    expect(ReportSchema.safeParse(oldReport).success).toBe(true);
  });

  it("still rejects an empty disclaimer / fredAttribution (min(1) guard)", () => {
    const emptyDisclaimer = makeReport();
    emptyDisclaimer.meta.disclaimer = "";
    expect(ReportSchema.safeParse(emptyDisclaimer).success).toBe(false);

    const emptyFred = makeReport();
    emptyFred.macro.fredAttribution = "";
    expect(ReportSchema.safeParse(emptyFred).success).toBe(false);
  });

  it("preserves the STORED text verbatim through a parse round-trip (renderers show it as written)", () => {
    const historical = "Legacy disclaimer text — kept exactly as generated.";
    const r = makeReport();
    r.meta.disclaimer = historical;
    const parsed = ReportSchema.safeParse(r);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.meta.disclaimer).toBe(historical);
  });

  it("a freshly-built report carries the CURRENT constants verbatim (generation-side pin)", () => {
    // makeReport() mirrors what generation embeds. If the constant is edited,
    // generation continues to embed the new value — this asserts the wiring.
    const r = makeReport();
    expect(r.meta.disclaimer).toBe(DISCLAIMER_TEXT);
    expect(r.macro.fredAttribution).toBe(FRED_ATTRIBUTION_TEXT);
    const parsed = ReportSchema.safeParse(r);
    expect(parsed.success).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Scenario probability-sum refine
 * ------------------------------------------------------------------------ */

describe("scenario probability-sum refine (±0.01)", () => {
  it("rejects 0.5 / 0.3 / 0.3 (sum 1.1)", () => {
    const bad = [
      scenario("bull", 0.5, 240),
      scenario("base", 0.3, 190),
      scenario("bear", 0.3, 140),
    ];
    expect(ScenariosSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a partition summing to 1", () => {
    const good = [
      scenario("bull", 0.3, 240),
      scenario("base", 0.5, 190),
      scenario("bear", 0.2, 140),
    ];
    expect(ScenariosSchema.safeParse(good).success).toBe(true);
  });

  it("accepts a sum within ±0.01 of 1 (0.34/0.33/0.33 = 1.00)", () => {
    // Rounding-tolerant: three-way split need not sum to exactly 1.
    const good = [
      scenario("bull", 0.34, 240),
      scenario("base", 0.33, 190),
      scenario("bear", 0.33, 140),
    ];
    expect(ScenariosSchema.safeParse(good).success).toBe(true);
  });

  it("rejects a sum well under 1 (0.3/0.3/0.3 = 0.9)", () => {
    const bad = [
      scenario("bull", 0.3, 240),
      scenario("base", 0.3, 190),
      scenario("bear", 0.3, 140),
    ];
    expect(ScenariosSchema.safeParse(bad).success).toBe(false);
  });

  it("requires exactly 3 scenarios", () => {
    const two = [scenario("bull", 0.5, 240), scenario("bear", 0.5, 140)];
    expect(ScenariosSchema.safeParse(two).success).toBe(false);
  });

  it("rejects a probability outside [0,1]", () => {
    const bad = { ...scenario("bull", 1.4, 240) };
    expect(ScenarioSchema.safeParse(bad).success).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * Buy/sell/hold refine
 * ------------------------------------------------------------------------ */

describe("buy/sell/hold rating refine", () => {
  it("rejects 'Strong Buy' in a scenario narrative field", () => {
    const bad = {
      ...scenario("bull", 0.3, 240),
      assumptions: ["Strong Buy on the next print."],
    };
    expect(ScenarioSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a bare Sell / Hold rating in the verdict synthesis", () => {
    const withSell = makeReport();
    withSell.verdict.synthesis = "We would Sell here.";
    expect(ReportSchema.safeParse(withSell).success).toBe(false);

    const withHold = makeReport();
    withHold.verdict.synthesis = "Hold and wait for a pullback.";
    expect(ReportSchema.safeParse(withHold).success).toBe(false);
  });

  it("rejects rating language in nested free-text fields that lack local refinements", () => {
    const claimText = makeReport();
    claimText.business.whatTheySell[0]!.text = "Strong Buy after the launch.";
    expect(ReportSchema.safeParse(claimText).success).toBe(false);

    const appendixReason = makeReport();
    appendixReason.appendix.missingData.push({
      field: "analystConsensus",
      reason: "The consensus is a Hold rating.",
      severity: "info",
    });
    expect(ReportSchema.safeParse(appendixReason).success).toBe(false);
  });

  it("keeps nested operational uses of buy/sell/hold valid", () => {
    const report = makeReport();
    report.business.whatTheySell[0]!.text =
      "Customers buy premium devices while management holds margins steady.";
    report.outlook.segmentTrajectories[0]!.text =
      "The company can sell more seats into the installed base.";
    expect(ReportSchema.safeParse(report).success).toBe(true);
  });

  it("ALLOWS 'buyback' in a rating-safe field", () => {
    expect(noBuySellHold("Management accelerated the buyback.")).toBe(true);
    const ok = makeReport();
    ok.verdict.synthesis = "Steady buybacks reduce the share count.";
    expect(ReportSchema.safeParse(ok).success).toBe(true);
  });

  it("ALLOWS 'sell-side' in a rating-safe field", () => {
    expect(noBuySellHold("Sell-side estimates moved higher.")).toBe(true);
    const ok = makeReport();
    ok.verdict.synthesis = "Sell-side estimates trend upward on services.";
    expect(ReportSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects rating/directive language but ALLOWS ordinary business verbs", () => {
    // Rejected — a rating / recommendation / directive about the security:
    expect(noBuySellHold("Buy")).toBe(false);
    expect(noBuySellHold("a clear sell")).toBe(false);
    expect(noBuySellHold("hold rating reiterated")).toBe(false);
    expect(noBuySellHold("Strong Buy on the print.")).toBe(false);
    expect(noBuySellHold("our recommendation is Hold")).toBe(false);
    expect(noBuySellHold("we would sell into strength")).toBe(false);
    expect(noBuySellHold("Sell the position here.")).toBe(false);
    expect(noBuySellHold("recommend buying the dip")).toBe(false);
    expect(noBuySellHold("Hold and wait for a pullback.")).toBe(false);
    expect(noBuySellHold("Overweight the shares")).toBe(false);
    expect(noBuySellHold("Underweight the stock")).toBe(false);
    expect(noBuySellHold("Accumulate shares")).toBe(false);
    expect(noBuySellHold("Avoid the stock")).toBe(false);
    expect(noBuySellHold("Strong outperform rating")).toBe(false);
    expect(noBuySellHold("Reduce exposure")).toBe(false);

    // Allowed — ordinary business VERBS. These are the false positives that used
    // to hard-fail a whole report on one stray word in a scenario assumption.
    expect(noBuySellHold("Intuit holds ~35% operating margins.")).toBe(true);
    expect(noBuySellHold("Management will hold margins near current levels.")).toBe(true);
    expect(noBuySellHold("hold the line on operating expenses")).toBe(true);
    expect(noBuySellHold("customers continue to buy the premium tier")).toBe(true);
    expect(noBuySellHold("cross-sell drives ARPU expansion")).toBe(true);
    expect(noBuySellHold("sell more seats into the installed base")).toBe(true);
    expect(noBuySellHold("The new product outperforms the prior generation.")).toBe(true);
    expect(noBuySellHold("Inventory accumulated ahead of the launch.")).toBe(true);
    expect(noBuySellHold("Hedging reduced exposure to commodity prices.")).toBe(true);

    // Allowed — compounds / substrings (unchanged):
    expect(noBuySellHold("buybacks")).toBe(true);
    expect(noBuySellHold("sell-through")).toBe(true);
    expect(noBuySellHold("buy-side flows")).toBe(true);
    expect(noBuySellHold("shareholder")).toBe(true);
    expect(noBuySellHold("holding company")).toBe(true);
    expect(noBuySellHold("household demand")).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * .strict() rejects extra keys
 * ------------------------------------------------------------------------ */

describe(".strict() rejects unexpected keys", () => {
  it("rejects an extra key at the report root", () => {
    const withExtra = { ...makeReport(), rating: "Buy" } as unknown;
    expect(ReportSchema.safeParse(withExtra).success).toBe(false);
  });

  it("rejects an extra key inside a nested object (GradeBlock)", () => {
    const bad = { ...gradeBlock("A"), recommendation: "Buy" } as unknown;
    expect(GradeBlockSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an extra key inside a SourcedClaim", () => {
    const bad = { ...claim(), extra: 1 } as unknown;
    expect(SourcedClaimSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an extra key inside a TracedNumber", () => {
    const bad = { ...num(), unexpected: "USD" } as unknown;
    expect(TracedNumberSchema.safeParse(bad).success).toBe(false);
  });
});

describe("evidence schema invariants", () => {
  it("rejects empty evidence sources and malformed as-of dates", () => {
    expect(SourcedClaimSchema.safeParse({ ...claim(), source: "  " }).success).toBe(false);
    expect(SourcedClaimSchema.safeParse({ ...claim(), asOf: "2026-02-30" }).success).toBe(false);
    expect(TracedNumberSchema.safeParse({ ...num(), asOf: "last quarter" }).success).toBe(false);
  });

  it("requires coverage rates to agree exactly with their counters", () => {
    const valid = {
      numeric: { supported: 2, total: 4, rate: 0.5 },
      factualClaims: { supported: 0, total: 0, rate: null },
      judgments: { cited: 1, total: 2, rate: 0.5 },
    };
    expect(ProvenanceCoverageSchema.safeParse(valid).success).toBe(true);
    expect(
      ProvenanceCoverageSchema.safeParse({
        ...valid,
        numeric: { supported: 2, total: 4, rate: 0.75 },
      }).success,
    ).toBe(false);
    expect(
      ProvenanceCoverageSchema.safeParse({
        ...valid,
        factualClaims: { supported: 0, total: 0, rate: 1 },
      }).success,
    ).toBe(false);
    expect(
      ProvenanceCoverageSchema.safeParse({
        ...valid,
        judgments: { cited: 3, total: 2, rate: 1 },
      }).success,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * JSON Schema — additionalProperties:false on nested objects
 * ------------------------------------------------------------------------ */

describe("z.toJSONSchema output — additionalProperties:false", () => {
  /** Every object node that declares `properties` must be closed. */
  function assertClosed(node: unknown, path: string): number {
    let checked = 0;
    if (node === null || typeof node !== "object") return 0;
    if (Array.isArray(node)) {
      node.forEach((n, i) => {
        checked += assertClosed(n, `${path}[${i}]`);
      });
      return checked;
    }
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties !== undefined) {
      expect(obj.additionalProperties, `open object at ${path}`).toBe(false);
      checked += 1;
    }
    for (const key of Object.keys(obj)) {
      checked += assertClosed(obj[key], `${path}.${key}`);
    }
    return checked;
  }

  it("closes every object-with-properties in the full report schema", () => {
    const schema = reportToJsonSchema();
    expect(schema.additionalProperties).toBe(false);
    const checked = assertClosed(schema, "$");
    // Sanity: the report is deep — expect many closed objects, not zero.
    expect(checked).toBeGreaterThan(50);
  });

  it("closes objects in the judge and analyst schemas too", () => {
    expect(judgeOutputToJsonSchema().additionalProperties).toBe(false);
    expect(analystCaseToJsonSchema().additionalProperties).toBe(false);
    assertClosed(judgeOutputToJsonSchema(), "$judge");
    assertClosed(analystCaseToJsonSchema(), "$analyst");
  });

  it("leaves meta.asOfMap as an open string map (the documented exception)", () => {
    const prop = (node: unknown, key: string): Record<string, unknown> => {
      const obj = node as Record<string, unknown>;
      const props = obj.properties as Record<string, unknown>;
      return props[key] as Record<string, unknown>;
    };
    const schema = reportToJsonSchema();
    const asOfMap = prop(prop(schema, "meta"), "asOfMap");
    // A record: no `properties`, and additionalProperties is a schema, not false.
    expect(asOfMap.properties).toBeUndefined();
    expect(asOfMap.additionalProperties).toEqual({ type: "string" });
  });
});

/* ------------------------------------------------------------------------ *
 * JSON Schema — no Anthropic-unsupported constraints (structured outputs
 * rejects the request outright otherwise — see relaxUnsupportedConstraints's
 * docstring for the two live 400s this regresses: array minItems>1/maxItems,
 * and numeric minimum/maximum/multipleOf).
 * ------------------------------------------------------------------------ */

describe("z.toJSONSchema output — no Anthropic-unsupported constraints", () => {
  function findUnsupported(node: unknown, path: string, out: string[]): string[] {
    if (node === null || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      node.forEach((n, i) => findUnsupported(n, `${path}[${i}]`, out));
      return out;
    }
    const obj = node as Record<string, unknown>;
    if (obj.type === "array") {
      if (typeof obj.minItems === "number" && obj.minItems > 1) out.push(`${path}: minItems=${obj.minItems}`);
      if (obj.maxItems !== undefined) out.push(`${path}: maxItems=${obj.maxItems}`);
    }
    if (obj.type === "number" || obj.type === "integer") {
      if (obj.minimum !== undefined) out.push(`${path}: minimum=${obj.minimum}`);
      if (obj.maximum !== undefined) out.push(`${path}: maximum=${obj.maximum}`);
      if (obj.multipleOf !== undefined) out.push(`${path}: multipleOf=${obj.multipleOf}`);
    }
    if (obj.type === "string") {
      if (obj.minLength !== undefined) out.push(`${path}: minLength=${obj.minLength}`);
      if (obj.maxLength !== undefined) out.push(`${path}: maxLength=${obj.maxLength}`);
    }
    for (const key of Object.keys(obj)) findUnsupported(obj[key], `${path}.${key}`, out);
    return out;
  }

  it("strips ScenariosSchema's length(3) and probability min/max from the judge request schema", () => {
    expect(findUnsupported(judgeOutputToJsonSchema(), "$judge", [])).toEqual([]);
  });

  it("has none in the analyst-case or full report schemas either", () => {
    expect(findUnsupported(analystCaseToJsonSchema(), "$analyst", [])).toEqual([]);
    expect(findUnsupported(reportToJsonSchema(), "$report", [])).toEqual([]);
  });

  it("leaves the underlying Zod schema's exact-length and probability-range validation intact (post-hoc parse safety net)", () => {
    // Only 2 of the required 3 scenarios — still rejected at parse-time even
    // though the REQUEST schema no longer declares minItems/maxItems.
    const twoScenarios = [scenario("bull", 0.5, 200), scenario("bear", 0.5, 100)];
    expect(ScenariosSchema.safeParse(twoScenarios).success).toBe(false);

    // probability=1.5 — still rejected at parse-time even though the REQUEST
    // schema no longer declares minimum/maximum on the number.
    const outOfRangeProbability = scenario("bull", 1.5, 200);
    expect(ScenarioSchema.safeParse(outOfRangeProbability).success).toBe(false);
  });

  it("preserves a stripped bound as a `description` instead of silently dropping it (mirrors the SDK's zodOutputFormat behavior)", () => {
    function findDescriptions(node: unknown, pred: RegExp, out: string[], seen = new WeakSet<object>()): string[] {
      if (node === null || typeof node !== "object") return out;
      if (seen.has(node as object)) return out;
      seen.add(node as object);
      if (Array.isArray(node)) {
        for (const item of node) findDescriptions(item, pred, out, seen);
        return out;
      }
      const obj = node as Record<string, unknown>;
      if (typeof obj.description === "string" && pred.test(obj.description)) out.push(obj.description);
      for (const key of Object.keys(obj)) findDescriptions(obj[key], pred, out, seen);
      return out;
    }
    // ScenarioSchema.probability's stripped [0,1] bound must survive as a description.
    const hits = findDescriptions(judgeOutputToJsonSchema(), />= 0.*<= 1/, []);
    expect(hits.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Nullable-union complexity collapse (Anthropic's separate "too many
 * parameters with union types" cap — observed live 2026-07-08: JUDGE_OUTPUT_
 * SCHEMA hit 17 anyOf/type-array fields against a documented limit of 16, even
 * AFTER reused:"ref" already cut it from 115 to 21).
 * ------------------------------------------------------------------------ */

describe("collapseNullableComplexity + fillNullableGaps", () => {
  function countUnions(node: unknown, seen = new WeakSet<object>()): number {
    if (node === null || typeof node !== "object") return 0;
    if (seen.has(node as object)) return 0;
    seen.add(node as object);
    if (Array.isArray(node)) return node.reduce((n: number, item) => n + countUnions(item, seen), 0);
    const obj = node as Record<string, unknown>;
    let count = Array.isArray(obj.anyOf) || Array.isArray(obj.type) ? 1 : 0;
    for (const key of Object.keys(obj)) count += countUnions(obj[key], seen);
    return count;
  }

  it("collapses every nullable union in the judge/analyst/report request schemas to 0 (well under Anthropic's 16-parameter cap)", () => {
    expect(countUnions(judgeOutputToJsonSchema())).toBe(0);
    expect(countUnions(analystCaseToJsonSchema())).toBe(0);
    expect(countUnions(reportToJsonSchema())).toBe(0);
  });

  it("removes a collapsed nullable field from its object's `required` list (model may now omit it instead of sending null)", () => {
    const judge = judgeOutputToJsonSchema() as { $defs?: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
    // Find TracedNumber's shared definition. Verification fields are omitted
    // from the model request entirely because the deterministic pass owns them.
    const tracedNumberDef = Object.values(judge.$defs ?? {}).find(
      (d) =>
        d.properties &&
        "value" in d.properties &&
        "unit" in d.properties &&
        "source" in d.properties &&
        "asOf" in d.properties,
    );
    expect(tracedNumberDef).toBeDefined();
    expect(tracedNumberDef?.required).not.toContain("asOf");
    expect(tracedNumberDef?.properties).not.toHaveProperty("verified");
    expect(tracedNumberDef?.properties).not.toHaveProperty("verificationNote");
  });

  it("fillNullableGaps restores an explicit null for an omitted nullable field before Zod validation", () => {
    const withNull = { value: 1, unit: "USD", source: "computed.x", asOf: null, verified: null };
    const omitted = { value: 1, unit: "USD", source: "computed.x" }; // asOf/verified OMITTED, not null
    expect(TracedNumberSchema.safeParse(omitted).success).toBe(false); // baseline: Zod rejects missing keys
    const filled = fillNullableGaps(TracedNumberSchema, omitted);
    expect(filled).toEqual(withNull);
    expect(TracedNumberSchema.safeParse(filled).success).toBe(true);
  });

  it("fillNullableGaps is a no-op for a value that already has explicit nulls or real values", () => {
    const already = { value: 1, unit: "USD", source: "computed.x", asOf: null, verified: true };
    expect(fillNullableGaps(TracedNumberSchema, already)).toEqual(already);
  });
});

/* ------------------------------------------------------------------------ *
 * Schema-complexity budget (Anthropic's SEPARATE "too many optional
 * parameters" cap — observed live 2026-07-08: JUDGE_OUTPUT_SCHEMA hit 29
 * against a documented limit of 24, even with 0 nullable unions remaining.
 * requireAlwaysFilledFields + consolidating the four forensic-score schemas
 * into one shared $ref brought it to 18 — this test pins a margin under 24
 * rather than a bare pass, so schema growth gets caught in CI before it
 * regresses into another live 400.
 * ------------------------------------------------------------------------ */

describe("judge/analyst request schemas stay inside Anthropic's complexity budget", () => {
  function countOptional(node: unknown, seen = new WeakSet<object>()): number {
    if (node === null || typeof node !== "object") return 0;
    if (seen.has(node as object)) return 0;
    seen.add(node as object);
    if (Array.isArray(node)) return node.reduce((n: number, item) => n + countOptional(item, seen), 0);
    const obj = node as Record<string, unknown>;
    let count = 0;
    if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
      const props = obj.properties as Record<string, unknown>;
      const required = new Set((obj.required as string[] | undefined) ?? []);
      for (const key of Object.keys(props)) if (!required.has(key)) count++;
    }
    for (const key of Object.keys(obj)) count += countOptional(obj[key], seen);
    return count;
  }

  it("keeps the judge schema's optional-parameter count comfortably under the documented limit of 24 (margin, not a bare pass)", () => {
    const count = countOptional(judgeOutputToJsonSchema());
    expect(count).toBeLessThanOrEqual(20);
  });

  it("keeps the analyst-case schema's optional-parameter count comfortably under 24 too", () => {
    expect(countOptional(analystCaseToJsonSchema())).toBeLessThanOrEqual(20);
  });

  it("marks executiveSummary/interpretation/graded required in the wire schema despite being .optional() on the Zod side (backward-compat with pre-1.1.0 persisted reports, not a generation-time gap)", () => {
    // ReportSchema itself must still tolerate a persisted 1.0.0 report missing these.
    expect(VerdictSchema.safeParse({
      synthesis: "x",
      gradeStrip: { fundamentals: gradeBlock(), valuation: gradeBlock(), technicals: gradeBlock(), quality: gradeBlock(), leadership: gradeBlock(), moat: gradeBlock() },
      // executiveSummary omitted — must still parse (old-report tolerance).
    }).success).toBe(true);

    function findBySignature(
      node: unknown,
      keys: string[],
      seen = new WeakSet<object>(),
    ): { properties?: Record<string, unknown>; required?: string[] } | undefined {
      if (node === null || typeof node !== "object") return undefined;
      if (seen.has(node as object)) return undefined;
      seen.add(node as object);
      if (Array.isArray(node)) {
        for (const item of node) {
          const hit = findBySignature(item, keys, seen);
          if (hit) return hit;
        }
        return undefined;
      }
      const obj = node as Record<string, unknown> & { properties?: Record<string, unknown> };
      if (obj.properties && keys.every((k) => obj.properties && k in obj.properties)) {
        return obj as { properties?: Record<string, unknown>; required?: string[] };
      }
      for (const key of Object.keys(obj)) {
        const hit = findBySignature(obj[key], keys, seen);
        if (hit) return hit;
      }
      return undefined;
    }

    const verdictDef = findBySignature(judgeOutputToJsonSchema(), ["gradeStrip", "synthesis"]);
    expect(verdictDef?.required).toContain("executiveSummary");
  });

  it("consolidates the four forensic-score schemas (Altman/Beneish/Piotroski/accruals) into one shared instance", () => {
    expect(AltmanScoreSchema).toBe(BeneishScoreSchema);
    expect(AltmanScoreSchema).toBe(PiotroskiScoreSchema);
    expect(AltmanScoreSchema).toBe(AccrualsScoreSchema);
  });
});

/* ------------------------------------------------------------------------ *
 * diffReports
 * ------------------------------------------------------------------------ */

describe("diffReports", () => {
  it("catches a grade change", () => {
    const a = makeReport();
    const b = makeReport();
    b.verdict.gradeStrip.valuation = gradeBlock("D"); // was C
    const diff = diffReports(a, b);
    expect(diff.gradeChanges).toContainEqual({
      section: "valuation",
      from: "C",
      to: "D",
    });
    // Unchanged sections do not appear.
    expect(diff.gradeChanges.every((g) => g.section !== "fundamentals")).toBe(
      true,
    );
  });

  it("catches a new catalyst and a removed one", () => {
    const a = makeReport();
    const b = makeReport();
    b.catalystsRisks.catalysts = [
      {
        title: "Regulatory approval in the EU",
        expectedDate: null,
        direction: "positive",
        significance: "medium",
        reasoning: claim("EU approval opens a new market."),
      },
    ];
    const diff = diffReports(a, b);
    expect(diff.newCatalysts).toContain("Regulatory approval in the EU");
    // The original "AI feature launch" is gone from b.
    expect(diff.removedCatalysts).toContain("AI feature launch");
  });

  it("treats a lightly reworded catalyst title as the SAME (fuzzy match)", () => {
    const a = makeReport();
    const b = makeReport();
    // Reword the same catalyst — high similarity, should NOT count as new/removed.
    b.catalystsRisks.catalysts[0].title = "AI features launch";
    const diff = diffReports(a, b);
    expect(diff.newCatalysts).toHaveLength(0);
    expect(diff.removedCatalysts).toHaveLength(0);
  });

  it("catches a genuinely new risk while fuzzy-matching a reworded one", () => {
    const a = makeReport();
    const b = makeReport();
    // Reword existing risk (fuzzy match) + add a brand-new one.
    b.catalystsRisks.risks[0].title = "China demand slow-down";
    b.catalystsRisks.risks.push({
      title: "Antitrust litigation",
      severity: "medium",
      probability: "low",
      source: "web:news",
      reasoning: claim("Pending antitrust cases."),
    });
    const diff = diffReports(a, b);
    expect(diff.newRisks).toEqual(["Antitrust litigation"]);
    expect(diff.removedRisks).toHaveLength(0);
  });

  it("catches scenario target changes with pctChange", () => {
    const a = makeReport();
    const b = makeReport();
    b.valuation.scenarios = [
      scenario("bull", 0.3, 264), // was 240 → +10%
      scenario("base", 0.5, 190),
      scenario("bear", 0.2, 140),
    ];
    const diff = diffReports(a, b);
    const bull = diff.targetChanges.find((t) => t.scenario === "bull");
    expect(bull).toBeDefined();
    expect(bull?.fromValue).toBe(240);
    expect(bull?.toValue).toBe(264);
    expect(bull?.pctChange).toBeCloseTo(0.1, 5);
  });

  it("flags verdict change and computes cost delta", () => {
    const a = makeReport();
    const b = makeReport();
    b.verdict.synthesis = "The thesis has shifted materially on new data.";
    b.meta.costUsd = 2.6; // a.meta.costUsd = 2.1
    const diff = diffReports(a, b);
    expect(diff.verdictChanged).toBe(true);
    expect(diff.costDelta).toBeCloseTo(0.5, 5);
  });

  it("reports no changes for identical reports", () => {
    const diff = diffReports(makeReport(), makeReport());
    expect(diff.gradeChanges).toHaveLength(0);
    expect(diff.targetChanges).toHaveLength(0);
    expect(diff.newCatalysts).toHaveLength(0);
    expect(diff.removedCatalysts).toHaveLength(0);
    expect(diff.newRisks).toHaveLength(0);
    expect(diff.removedRisks).toHaveLength(0);
    expect(diff.verdictChanged).toBe(false);
    expect(diff.costDelta).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * 1.1.0 additions — deterministic scores + weighted projections + interp
 * ------------------------------------------------------------------------ */

function aspectScore(score = 82, band: "A" | "B" | "C" | "D" | "F" = "B") {
  return {
    score,
    band,
    weightPct: 20,
    dataCompleteness: 1,
    drivers: [num(score, "score")],
    notApplicableReason: null as string | null,
    note: "Anchored to the ROIC minus WACC spread and margin trend.",
  };
}

function scoring() {
  return {
    aspects: {
      fundamentals: aspectScore(),
      valuation: aspectScore(60, "C"),
      quality: aspectScore(88, "A"),
      balanceSheet: aspectScore(75, "B"),
      moat: aspectScore(90, "A"),
      leadership: aspectScore(70, "B"),
      technicals: aspectScore(55, "C"),
    },
    composite: {
      score: 76,
      band: "B" as const,
      weights: {
        fundamentals: 20,
        valuation: 20,
        quality: 15,
        balanceSheet: 15,
        moat: 15,
        leadership: 10,
        technicals: 5,
      },
      methodology: "Route-adjusted weighted mean of the seven aspect scores.",
    },
    bandsVersion: "SCORE_BANDS_2026_01",
  };
}

function projPoint(period: string, value: number, unit = "USD") {
  return { period, value: num(value, unit) };
}

function projectionSeries(metric: "revenue" | "operatingMargin" | "fcf" | "epsDiluted" = "revenue") {
  return {
    metric,
    unit: "USD",
    historical: [projPoint("FY2024", 100), projPoint("FY2025", 110)],
    bull: [projPoint("FY2026", 130), projPoint("FY2027", 150)],
    base: [projPoint("FY2026", 121), projPoint("FY2027", 133)],
    bear: [projPoint("FY2026", 112), projPoint("FY2027", 118)],
    weighted: [projPoint("FY2026", 121), projPoint("FY2027", 133)],
    assumptions: ["Revenue fades from the analyst-anchored near-term growth toward terminal growth."],
    disclosures: [],
  };
}

function projections() {
  return {
    horizonYears: 5,
    scenarioWeights: { bull: 0.25, base: 0.5, bear: 0.25 },
    weightsVersion: "PROJECTION_WEIGHTS_2026_01",
    series: [projectionSeries("revenue"), projectionSeries("epsDiluted")],
    notApplicableReason: null as string | null,
  };
}

describe("report schema — 1.1.0 additions", () => {
  it("a report WITHOUT scores/projections (1.0.0 shape) still validates", () => {
    const parsed = ReportSchema.safeParse(makeReport());
    expect(parsed.success).toBe(true);
  });

  it("a report WITH scores + projections + interpretation + executiveSummary validates", () => {
    const r = makeReport();
    r.scores = scoring();
    r.projections = projections();
    r.verdict.executiveSummary = [claim("The composite grade reflects durable returns above cost of capital.")];
    r.verdict.gradeStrip.balanceSheet = gradeBlock("B");
    r.balanceSheet.graded = gradeBlock("B");
    r.fundamentals.graded.interpretation =
      "Growth is decelerating but remains well above the cost of capital, so the franchise still compounds.";
    const parsed = ReportSchema.safeParse(r);
    if (!parsed.success) console.error(parsed.error.message);
    expect(parsed.success).toBe(true);
  });

  it("AspectScoreSchema enforces 0..100 and 0..1 completeness", () => {
    expect(AspectScoreSchema.safeParse(aspectScore(50)).success).toBe(true);
    expect(AspectScoreSchema.safeParse({ ...aspectScore(), score: 101 }).success).toBe(false);
    expect(AspectScoreSchema.safeParse({ ...aspectScore(), dataCompleteness: 1.5 }).success).toBe(false);
    // notApplicable path: null score + null band is valid.
    expect(
      AspectScoreSchema.safeParse({
        ...aspectScore(),
        score: null,
        band: null,
        notApplicableReason: "Altman/DCF suppressed for banks.",
      }).success,
    ).toBe(true);
  });

  it("ScoringSchema round-trips a full scoring object", () => {
    expect(ScoringSchema.safeParse(scoring()).success).toBe(true);
  });

  it("scenario priceTarget is nullable (suppressed target) yet a legacy numeric value still parses", () => {
    // Backward-compat: persisted pre-checkpoint reports carry a numeric target.
    expect(ScenarioSchema.safeParse(scenario("base", 0.5, 240)).success).toBe(true);
    // New: a suppressed target is null — "unavailable", not a fabricated zero.
    const suppressed = { ...scenario("base", 0.5, 240), priceTarget: null };
    expect(ScenarioSchema.safeParse(suppressed).success).toBe(true);
  });

  it("DCF perShare is nullable (suppressed fair value) yet a legacy numeric value still parses", () => {
    const r = makeReport();
    // Backward-compat: persisted pre-checkpoint reports carry a numeric DCF perShare.
    expect(ReportSchema.safeParse(r).success).toBe(true);
    // New: a suppressed DCF fair value is null — "unavailable", not a fabricated zero.
    const suppressed = JSON.parse(JSON.stringify(r)) as Report;
    suppressed.valuation.dcf.perShare = null;
    suppressed.valuation.dcf.upsidePct = null;
    expect(ReportSchema.safeParse(suppressed).success).toBe(true);
  });

  it("FairValueSchema round-trips available and suppressed blocks; a report parses with or without it", () => {
    const available = {
      status: "available" as const,
      method: "fcff-dcf" as const,
      methodVersion: "FAIR_VALUE_2026_07",
      perShare: num(250),
      upsidePct: 4,
      basis: ["Intrinsic value per share = the deterministic FCFF DCF."],
      reasons: [],
    };
    expect(FairValueSchema.safeParse(available).success).toBe(true);
    expect(FairValueSchema.safeParse({ ...available, method: "excess-return" as const }).success).toBe(true);

    const suppressed = {
      status: "suppressed" as const,
      method: null,
      methodVersion: "FAIR_VALUE_2026_07",
      perShare: null,
      upsidePct: null,
      basis: ["Intrinsic value per share unavailable."],
      reasons: [{ field: "valuation.dcf.perShare", reason: "equity bridge suppressed", severity: "warn" as const }],
    };
    expect(FairValueSchema.safeParse(suppressed).success).toBe(true);

    const withBlock = makeReport();
    withBlock.fairValue = available;
    expect(ReportSchema.safeParse(withBlock).success).toBe(true);
  });

  it("ScenarioTargetsSchema round-trips available and suppressed blocks; a report parses with or without it", () => {
    const available = {
      status: "available" as const,
      method: "dcf-dispersion",
      methodVersion: "SCENARIO_TARGETS_2026_07",
      basis: ["base target = the deterministic DCF fair value"],
      dispersion: { growthSigmaPp: 8, marginSigmaPp: 3, sigmaSource: "own-history" as const },
      targets: [
        { name: "bull" as const, perShare: num(305), upsidePct: 22, growthDeltaPp: 8, marginDeltaPp: 3 },
        { name: "base" as const, perShare: num(250), upsidePct: 0, growthDeltaPp: 0, marginDeltaPp: 0 },
        { name: "bear" as const, perShare: null, upsidePct: null, growthDeltaPp: -8, marginDeltaPp: -3 },
      ],
      missingReasons: [],
    };
    expect(ScenarioTargetsSchema.safeParse(available).success).toBe(true);

    const suppressed = {
      status: "suppressed" as const,
      method: "dcf-dispersion",
      methodVersion: "SCENARIO_TARGETS_2026_07",
      basis: ["Scenario price targets unavailable: the base DCF per-share is not computable."],
      dispersion: null,
      targets: [],
      missingReasons: [{ field: "valuation.scenarioTargets", reason: "base DCF per-share unavailable", severity: "warn" as const }],
    };
    expect(ScenarioTargetsSchema.safeParse(suppressed).success).toBe(true);

    // Pre-checkpoint report (no block) still validates; with the block validates.
    expect(ReportSchema.safeParse(makeReport()).success).toBe(true);
    const withBlock = makeReport();
    withBlock.scenarioTargets = available;
    expect(ReportSchema.safeParse(withBlock).success).toBe(true);
  });

  it("ProjectionsSchema round-trips; notApplicableReason may be set", () => {
    expect(ProjectionsSchema.safeParse(projections()).success).toBe(true);
    expect(
      ProjectionsSchema.safeParse({
        horizonYears: 0,
        scenarioWeights: { bull: 0.25, base: 0.5, bear: 0.25 },
        weightsVersion: "PROJECTION_WEIGHTS_2026_01",
        series: [],
        notApplicableReason: "Projections suppressed for the bank route.",
      }).success,
    ).toBe(true);
  });

  it("rejects projection scenario arrays with mismatched horizons", () => {
    const bad = projectionSeries();
    bad.bull = bad.bull.slice(0, 1);
    expect(ProjectionSeriesSchema.safeParse(bad).success).toBe(false);

    const misaligned = projectionSeries();
    misaligned.bear[0]!.period = "FY2099";
    expect(ProjectionSeriesSchema.safeParse(misaligned).success).toBe(false);
  });

  it("rating-safe guard applies to the new free-text fields", () => {
    // AspectScore.note is rating-safe.
    expect(AspectScoreSchema.safeParse({ ...aspectScore(), note: "Strong Buy on valuation." }).success).toBe(false);
    // ProjectionSeries.assumptions are rating-safe.
    const bad = projectionSeries();
    bad.assumptions = ["We would sell into strength."];
    expect(ProjectionSeriesSchema.safeParse(bad).success).toBe(false);
    // GradeBlock.interpretation is rating-safe, but "buyback" is allowed vocabulary.
    expect(GradeBlockSchema.safeParse({ ...gradeBlock(), interpretation: "Sell the position." }).success).toBe(false);
    expect(
      GradeBlockSchema.safeParse({ ...gradeBlock(), interpretation: "Buybacks shrink the share count steadily." }).success,
    ).toBe(true);
  });

  it("scores/projections are optional but strict when present", () => {
    const r = makeReport() as Record<string, unknown>;
    r.scores = { ...scoring(), unexpected: 1 };
    expect(ReportSchema.safeParse(r).success).toBe(false);
  });
});
