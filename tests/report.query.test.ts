/**
 * Tests for src/report/query.ts (getLatestDoneReport) against an in-memory
 * better-sqlite3 database (createDatabase(":memory:") + setDbForTests — the
 * same harness as the API-route tests). No network.
 *
 * Coverage:
 *   - happy path: returns the latest `done` row by createdAt with the parsed,
 *     schema-validated Report attached;
 *   - non-done rows (running/error) are ignored even when newer;
 *   - null when no done row exists for the symbol;
 *   - documented never-throws degradation: a done row whose reportJson is
 *     malformed JSON OR schema-invalid → metadata returned with report: null;
 *   - reportJson NULL (generation persisted no body) → report: null;
 *   - symbol matching is exact/case-sensitive (runner stores uppercase; the
 *     caller uppercases before querying);
 *   - createdAt-tie behavior pinned AS IT CURRENTLY EXISTS (no id tiebreak in
 *     the query — see the test comment).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// query.ts imports the `server-only` shim (absent under the plain-node
// runner). Stub it to a no-op, same as api.routes.report.test.ts.
vi.mock("server-only", () => ({}));

import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { reports } from "@/db/schema";
import {
  DISCLAIMER_TEXT,
  FRED_ATTRIBUTION_TEXT,
  REPORT_SPEC_VERSION,
  ReportSchema,
  type Report,
} from "@/report/schema";
import { getLatestDoneReport } from "@/report/query";

/* ------------------------------------------------------------------------ *
 * Fixture: a minimal fully-valid Report (mirrors tests/report.schema.test.ts's
 * makeReport — duplicated here because test files do not export fixtures).
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

function scenario(name: "bull" | "base" | "bear", probability: number, target: number) {
  return {
    name,
    probability,
    priceTarget: num(target),
    horizon: "12 months",
    assumptions: ["Margins stay firm on operating leverage."],
    whatWouldHaveToBeTrue: ["Cloud growth stays above 20%."],
  };
}

function makeReport(): Report {
  return {
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
      synthesis: "A cash-generative franchise with a wide moat and steady buybacks.",
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
        { name: "P/E", current: 28, peerMedian: 24, own5yPercentile: 0.7, sectorAppropriate: true },
      ],
      scenarios: [scenario("bull", 0.3, 240), scenario("base", 0.5, 190), scenario("bear", 0.2, 140)],
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
          evidence: { guidanceVsActuals: [claim("Beat guidance 9 of last 12 quarters.")] },
        },
      ],
      insiderSummary: [claim("Net insider selling, mostly 10b5-1.")],
      governanceNotes: [claim("Independent board majority.")],
    },
    competitive: {
      moatGraded: gradeBlock("A"),
      peerTable: [{ name: "Samsung", symbol: null, metrics: [num(1.5, "P/S")] }],
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
        { field: "leadership.cet1Ratio", reason: "Not a financial; N/A.", severity: "info" as const },
      ],
      verificationRate: null,
      costBreakdown: [{ step: "synthesize", model: "claude-opus-4-8", costUsd: 1.2 }],
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
}

/* ------------------------------------------------------------------------ *
 * Harness
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

interface SeedRow {
  symbol?: string;
  createdAt?: string;
  model?: string;
  status?: string;
  reportJson?: string | null;
  verificationRate?: number | null;
  costUsd?: number | null;
  specVersion?: string | null;
}

/** Insert a reports row and return its autoincrement id. */
function seedReport(row: SeedRow = {}): number {
  const result = handle.db
    .insert(reports)
    .values({
      symbol: row.symbol ?? "AAPL",
      createdAt: row.createdAt ?? "2026-07-01T00:00:00.000Z",
      model: row.model ?? "claude-opus-4-8",
      status: row.status ?? "done",
      reportJson: row.reportJson === undefined ? JSON.stringify(makeReport()) : row.reportJson,
      verificationRate: row.verificationRate ?? 0.9,
      costUsd: row.costUsd ?? 2.1,
      specVersion: row.specVersion ?? REPORT_SPEC_VERSION,
    })
    .run();
  return Number(result.lastInsertRowid);
}

/* ------------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------------ */

describe("getLatestDoneReport", () => {
  it("fixture sanity: the seeded reportJson is schema-valid", () => {
    // Guards against fixture rot: if this fails, the happy-path expectations
    // below are testing the fixture, not the query.
    const parsed = ReportSchema.safeParse(makeReport());
    expect(parsed.success).toBe(true);
  });

  it("returns null when no report exists for the symbol", () => {
    expect(getLatestDoneReport("AAPL")).toBeNull();
    seedReport({ symbol: "MSFT" });
    expect(getLatestDoneReport("AAPL")).toBeNull();
  });

  it("happy path: returns the latest done row by createdAt with the parsed Report", () => {
    const olderId = seedReport({ createdAt: "2026-07-01T00:00:00.000Z" });
    const newerId = seedReport({
      createdAt: "2026-07-05T00:00:00.000Z",
      verificationRate: 0.95,
      costUsd: 2.5,
    });

    const latest = getLatestDoneReport("AAPL");
    expect(latest).not.toBeNull();
    expect(latest!.reportId).toBe(newerId);
    expect(latest!.reportId).not.toBe(olderId);
    expect(latest!.symbol).toBe("AAPL");
    expect(latest!.createdAt).toBe("2026-07-05T00:00:00.000Z");
    expect(latest!.model).toBe("claude-opus-4-8");
    expect(latest!.status).toBe("done");
    expect(latest!.costUsd).toBe(2.5);
    expect(latest!.verificationRate).toBe(0.95);
    expect(latest!.specVersion).toBe(REPORT_SPEC_VERSION);
    // Parsed + schema-validated body attached.
    expect(latest!.report).not.toBeNull();
    expect(latest!.report!.meta.symbol).toBe("AAPL");
  });

  it("ignores non-done rows even when they are newer", () => {
    const doneId = seedReport({ createdAt: "2026-07-01T00:00:00.000Z", status: "done" });
    seedReport({ createdAt: "2026-07-08T00:00:00.000Z", status: "running", reportJson: null });
    seedReport({ createdAt: "2026-07-09T00:00:00.000Z", status: "error", reportJson: null });

    const latest = getLatestDoneReport("AAPL");
    expect(latest!.reportId).toBe(doneId);
    expect(latest!.status).toBe("done");
  });

  it("never throws on malformed reportJson: metadata returned with report: null", () => {
    seedReport({ reportJson: "{ not valid json" });
    const latest = getLatestDoneReport("AAPL");
    expect(latest).not.toBeNull();
    expect(latest!.report).toBeNull();
    expect(latest!.symbol).toBe("AAPL"); // metadata still usable
  });

  it("schema-invalid (but parseable) reportJson also degrades to report: null", () => {
    seedReport({ reportJson: JSON.stringify({ meta: { symbol: "AAPL" } }) });
    const latest = getLatestDoneReport("AAPL");
    expect(latest).not.toBeNull();
    expect(latest!.report).toBeNull();
  });

  it("reportJson NULL degrades to report: null", () => {
    seedReport({ reportJson: null });
    const latest = getLatestDoneReport("AAPL");
    expect(latest).not.toBeNull();
    expect(latest!.report).toBeNull();
  });

  it("symbol matching is exact (case-sensitive at the query layer)", () => {
    seedReport({ symbol: "AAPL" });
    // The runner stores uppercase and callers uppercase before querying; the
    // query itself does NOT case-fold.
    expect(getLatestDoneReport("aapl")).toBeNull();
    expect(getLatestDoneReport("AAPL")).not.toBeNull();
  });

  it("createdAt tie: pins CURRENT behavior — the higher-id (later-inserted) row wins", () => {
    // NOTE: the query orders by createdAt DESC only, with NO explicit id
    // tiebreak. With better-sqlite3 the (symbol, createdAt) index is scanned
    // descending, so among equal createdAt values the larger rowid surfaces
    // first. This test pins that observed behavior; it is an implementation
    // detail, not a documented contract (an explicit `desc(reports.id)`
    // tiebreak in src/report/query.ts would make it contractual).
    const tieIso = "2026-07-10T00:00:00.000Z";
    const firstId = seedReport({ createdAt: tieIso, costUsd: 1.0 });
    const secondId = seedReport({ createdAt: tieIso, costUsd: 2.0 });
    expect(secondId).toBeGreaterThan(firstId);

    const latest = getLatestDoneReport("AAPL");
    expect(latest!.reportId).toBe(secondId);
    expect(latest!.costUsd).toBe(2.0);
  });
});
