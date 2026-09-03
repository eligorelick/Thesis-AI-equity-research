/**
 * WS7 (D-20) — the deterministic, no-model checks the verification pass runs on
 * the prose around each cited figure, and the restriction on claims that name a
 * person.
 *
 * Before this, verification measured CITATION COVERAGE only: could each figure
 * be traced to the registry record it cites. A sentence could therefore say a
 * metric "rose" while citing a negative change, name "Q3 2024" while citing an
 * FY2025 record, or write "bps" about a dollar figure, and count as fully cited.
 *
 * These tests pin four things, in this order of importance:
 *
 *  1. A genuine contradiction FAILS, with the sentence, the cited figure and a
 *     reason a reader can act on.
 *  2. Correct prose PASSES — the checks must not punish good writing. Several
 *     cases below exist only to pin a NON-failure that a naive implementation
 *     would get wrong ("growth slowed to 4%" against a +4 record; a sentence
 *     that mentions a second figure's unit; a comparison naming two years).
 *  3. What cannot be located is reported as NOT CHECKED rather than guessed at,
 *     which is why `checked` is published beside `coverage` and never merged
 *     into it.
 *  4. A claim naming a person that rests on a web-search result is rejected AND
 *     stops counting as supported — a coverage number that still counted it
 *     would say the opposite of the finding printed beside it.
 *
 * No network, no model: runVerifyPass is deterministic and the consistency
 * module is pure.
 */

import { describe, expect, it } from "vitest";

import type {
  CitationProvenanceRecord,
  NumericProvenanceRecord,
} from "@/pipeline/stageC/provenance";
import type { SourcedClaim } from "@/report/schema";
import {
  collectPersonNames,
  consistencyManifestEntries,
  emptyConsistencyChecks,
  isCredibilityPath,
  isDeltaRecord,
  isFilingOrTranscriptSource,
  namesIndividual,
  runConsistencyChecks,
  type ConsistencyClaimRef,
} from "@/pipeline/stageC/consistency";
import { runVerifyPass, type PassDeps } from "@/pipeline/stageC/passes";
import type { ContextPayload } from "@/pipeline/stageC/payload";
import { buildLeadershipGuidance } from "@/pipeline/stageC/prompts";

/* ------------------------------------------------------------------------ *
 * Fixtures — a hand-built registry so each check has an exact record to hit.
 * ------------------------------------------------------------------------ */

function numeric(over: Partial<NumericProvenanceRecord>): NumericProvenanceRecord {
  return {
    id: "computed.growth.revenue-growth-yoy",
    kind: "computed",
    value: 6.4,
    unit: "percent",
    currency: null,
    period: null,
    asOf: "2025-09-27",
    origin: "computed.growth",
    formulaVersion: "stage-b-v1",
    displayPrecision: 4,
    ...over,
  };
}

function claim(text: string, source: string, over: Partial<SourcedClaim> = {}): SourcedClaim {
  return { text, label: "FACT", source, asOf: "2025-09-27", ...over };
}

function refs(...claims: SourcedClaim[]): ConsistencyClaimRef[] {
  return claims.map((c, index) => ({ claim: c, path: `fundamentals.commentary[${index}]` }));
}

function run(
  claims: ConsistencyClaimRef[],
  registry: NumericProvenanceRecord[],
  over: {
    citationRegistry?: CitationProvenanceRecord[];
    fetchedUrls?: string[];
    personNames?: string[];
  } = {},
) {
  return runConsistencyChecks({
    claims,
    registry,
    citationRegistry: over.citationRegistry ?? [],
    fetchedUrls: new Set(over.fetchedUrls ?? []),
    personNames: over.personNames ?? [],
  });
}

/* ------------------------------------------------------------------------ *
 * (d) Direction
 * ------------------------------------------------------------------------ */

describe("direction check", () => {
  const decline = numeric({ value: -3.2 });

  it("fails a direction word that contradicts the sign of the cited change", () => {
    const result = run(
      refs(claim("Revenue rose 3.2% year over year.", decline.id)),
      [decline],
    );
    expect(result.checks.direction).toEqual({ checked: 1, passed: 0, failed: 1, rate: 0 });
    const finding = result.findings.find((f) => f.check === "direction");
    expect(finding?.reason).toBe("direction-mismatch");
    // The failure has to name all three things a reader needs.
    expect(finding?.sentence).toBe("Revenue rose 3.2% year over year.");
    expect(finding?.figure).toContain("-3.2 percent");
    expect(finding?.sourceId).toBe(decline.id);
    expect(finding?.note).toContain('says "rose"');
    expect(finding?.note).toContain("negative");
  });

  it("passes a direction word that matches the sign", () => {
    const result = run(
      refs(claim("Revenue fell 3.2% year over year.", decline.id)),
      [decline],
    );
    expect(result.checks.direction).toEqual({ checked: 1, passed: 1, failed: 0, rate: 1 });
    expect(result.findings).toEqual([]);
  });

  it("reads basis points as hundredths of a point when locating the cited change", () => {
    const bps = numeric({ id: "computed.margins.operating-margin-change", value: -1.2, unit: "percentage-points" });
    const bad = run(refs(claim("Operating margin expanded 120 bps.", bps.id)), [bps]);
    expect(bad.checks.direction.failed).toBe(1);
    const good = run(refs(claim("Operating margin contracted 120 bps.", bps.id)), [bps]);
    expect(good.checks.direction).toEqual({ checked: 1, passed: 1, failed: 0, rate: 1 });
  });

  it("does not check a LEVEL figure — 'margin rose to 30%' says nothing about the sign of 30", () => {
    const level = numeric({ id: "computed.margins.operating-margin", origin: "computed.margins", value: 30 });
    expect(isDeltaRecord(level)).toBe(false);
    const result = run(refs(claim("Operating margin rose to 30% this year.", level.id)), [level]);
    expect(result.checks.direction.checked).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("does not read 'to' as a delta: 'growth fell to 4%' is not a claim that 4 is negative", () => {
    // The classic false positive. "fell" describes the growth RATE declining,
    // while the cited value (+4) is the rate itself.
    const growth = numeric({ value: 4 });
    const result = run(refs(claim("Revenue growth fell to 4% this year.", growth.id)), [growth]);
    expect(result.checks.direction.checked).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("ignores second-order words whose sign is about the rate of change, not the change", () => {
    const growth = numeric({ value: 4 });
    for (const sentence of [
      "Revenue growth slowed 4% versus last year.",
      "Revenue growth accelerated 4%.",
      "The spread narrowed 4%.",
    ]) {
      expect(run(refs(claim(sentence, growth.id)), [growth]).checks.direction.checked).toBe(0);
    }
  });

  it("ignores an evaluative word whose sign depends on whether the metric is good or bad", () => {
    // 2026-09 review: "improved"/"deteriorated" and their family sat in the
    // vocabulary with fixed signs, so every correct sentence about a
    // LOWER-IS-BETTER metric (leverage, churn, DSO, net debt, a cost ratio) was
    // filed as a direction mismatch. They are excluded for exactly the reason
    // the module docstring already gave for "widened"/"narrowed".
    const leverageFell = numeric({
      id: "computed.leverage.net-debt-to-ebitda-change",
      origin: "computed.leverage",
      value: -0.4,
      unit: "percentage-points",
    });
    const leverageRose = numeric({ ...leverageFell, value: 0.4 });
    for (const [sentence, record] of [
      ["Net leverage improved 0.4 points after the debt paydown.", leverageFell],
      ["Net leverage improvement of 0.4 points followed the paydown.", leverageFell],
      ["Days sales outstanding deteriorated 0.4 points on the quarter.", leverageRose],
      ["Cost coverage weakened 0.4 points on the quarter.", leverageRose],
      ["The cost ratio worsened 0.4 points on the quarter.", leverageRose],
      ["Coverage strengthened 0.4 points on the quarter.", leverageFell],
    ] as const) {
      const result = run(refs(claim(sentence, record.id)), [record]);
      expect(result.checks.direction.checked).toBe(0);
      expect(result.findings).toEqual([]);
    }
  });

  it("does not attach a direction word to a number that is not the cited figure", () => {
    const decline2 = numeric({ value: -3.2 });
    const result = run(
      refs(claim("Operating income rose 12.0% while revenue slipped 3.2%.", decline2.id)),
      [decline2],
    );
    // "slipped 3.2%" is the cited change and matches; "rose 12.0%" is a
    // different figure and must not be judged against this record.
    expect(result.checks.direction).toEqual({ checked: 1, passed: 1, failed: 0, rate: 1 });
  });
});

/* ------------------------------------------------------------------------ *
 * (d) Period
 * ------------------------------------------------------------------------ */

describe("period check", () => {
  const fy = numeric({
    id: "payload.statements.income-statement-annual.2025-09-27.revenue",
    kind: "provider",
    origin: "fmp:income-statement(annual)",
    formulaVersion: null,
    value: 416161000000,
    unit: "currency",
    currency: "USD",
    period: "2025-09-27",
  });

  it("fails a period phrase that names another year", () => {
    const result = run(refs(claim("Revenue reached $416.2 billion in FY2023.", fy.id)), [fy]);
    expect(result.checks.period).toEqual({ checked: 1, passed: 0, failed: 1, rate: 0 });
    const finding = result.findings.find((f) => f.check === "period");
    expect(finding?.reason).toBe("period-word-mismatch");
    expect(finding?.note).toContain('"FY2023"');
    expect(finding?.note).toContain("2025-09-27");
    expect(finding?.figure).toContain("416161000000 currency USD");
  });

  it("keeps the existing fiscal-spelling tolerance: FY2025 IS the 2025-09-27 column", () => {
    for (const phrase of ["FY2025", "fiscal 2025", "Q4 2025", "in 2025"]) {
      const result = run(refs(claim(`Revenue in ${phrase} was $416.2 billion.`, fy.id)), [fy]);
      expect(result.checks.period).toEqual({ checked: 1, passed: 1, failed: 0, rate: 1 });
    }
  });

  it("passes a comparison that names the cited year alongside another", () => {
    const result = run(
      refs(claim("Revenue grew from $391.0 billion in FY2024 to $416.2 billion in FY2025.", fy.id)),
      [fy],
    );
    expect(result.checks.period.failed).toBe(0);
  });

  it("does not check a bare quarter — no fiscal calendar, no verdict", () => {
    // Apple's Q3 FY2025 ends in June. Guessing which ISO period end "Q3" means
    // would fail correct sentences, so it is reported as not checked.
    const result = run(refs(claim("Revenue was strong in Q3.", fy.id)), [fy]);
    expect(result.checks.period.checked).toBe(0);
  });

  it("does not check a record the registry stored without a period", () => {
    const timeless = numeric({ period: null });
    const result = run(refs(claim("Growth was 6.4% in FY2025.", timeless.id)), [timeless]);
    expect(result.checks.period.checked).toBe(0);
  });

  it("does not read the number after a bare quarter as a two-digit year", () => {
    // 2026-09 review: the optional century let "Q1" swallow the number that
    // followed it, so "Q1 15% growth" claimed the sentence named the period
    // "Q1 15". The phrase starts at the Q, so the value-span guard could not
    // help; the pattern now requires the century.
    const dated = numeric({ value: 15, period: "2025-12-31" });
    const result = run(refs(claim("Q1 15% growth was reported.", dated.id)), [dated]);
    expect(result.checks.period.checked).toBe(0);
    expect(result.findings.some((f) => f.check === "period")).toBe(false);

    // A quarter that really does name a year is still checked, and still passes.
    const full = run(refs(claim("Q1 2025 growth was 15%.", dated.id)), [dated]);
    expect(full.checks.period).toEqual({ checked: 1, passed: 1, failed: 0, rate: 1 });
  });

  it("does not mistake a four-digit VALUE for a year", () => {
    const count = numeric({
      id: "payload.quote.volume",
      kind: "provider",
      origin: "fmp:quote",
      formulaVersion: null,
      value: 2025,
      unit: "count",
      period: "2026-03-28",
    });
    const result = run(refs(claim("The reading was 2025 units.", count.id)), [count]);
    expect(result.checks.period.checked).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * (d) Unit
 * ------------------------------------------------------------------------ */

describe("unit check", () => {
  const money = numeric({
    id: "payload.statements.income-statement-annual.2025-09-27.revenue",
    kind: "provider",
    origin: "fmp:income-statement(annual)",
    formulaVersion: null,
    value: 416161000000,
    unit: "currency",
    currency: "USD",
    period: "2025-09-27",
  });

  it("fails a monetary figure written as a percentage", () => {
    const result = run(refs(claim("Revenue was 416.2%.", money.id)), [money]);
    expect(result.checks.unit).toEqual({ checked: 1, passed: 0, failed: 1, rate: 0 });
    const finding = result.findings.find((f) => f.check === "unit");
    expect(finding?.reason).toBe("unit-word-mismatch");
    expect(finding?.note).toContain("percent units");
    expect(finding?.note).toContain("registry records it as currency (USD)");
  });

  it("fails a percentage figure written in dollars", () => {
    const pct = numeric({ value: 6.4 });
    const result = run(refs(claim("Growth was $6.4 billion.", pct.id)), [pct]);
    expect(result.checks.unit.checked).toBe(0); // $6.4bn does not locate a 6.4 value
    const scaled = run(refs(claim("Growth was $6.4 for the year.", pct.id)), [pct]);
    expect(scaled.checks.unit).toEqual({ checked: 1, passed: 0, failed: 1, rate: 0 });
  });

  it("passes the same figure written correctly, with or without the dollar sign", () => {
    for (const sentence of [
      "Revenue was $416.2 billion in FY2025.",
      "Revenue was 416.2 billion in FY2025.",
      "Revenue was 416,161,000,000 in FY2025.", // no unit token: not eligible
    ]) {
      expect(run(refs(claim(sentence, money.id)), [money]).checks.unit.failed).toBe(0);
    }
  });

  it("judges only the CITED figure's unit, not every unit in the sentence", () => {
    // A naive implementation flags this: the sentence contains "%" and the
    // record is currency. The percentage belongs to a different figure.
    const result = run(
      refs(claim("Revenue of $416.2 billion carried a 30.5% operating margin.", money.id)),
      [money],
    );
    expect(result.checks.unit).toEqual({ checked: 1, passed: 1, failed: 0, rate: 1 });
  });

  it("keeps only the best-scale match when a percentage coincides with a scaled value", () => {
    // 2026-09 review: the speculative display scales tried for a large-magnitude
    // record made "5.0%" locate a $5.0e9 record (5.0 × 1e9), so a correctly
    // written sentence failed the unit check on a figure it never cited. A
    // reading whose scale the sentence actually WROTE wins over a speculative
    // one, and only the winners are judged.
    const revenue = numeric({
      id: "payload.statements.income-statement-annual.2025-09-27.revenue",
      kind: "provider",
      origin: "fmp:income-statement(annual)",
      formulaVersion: null,
      value: 5_000_000_000,
      unit: "currency",
      currency: "USD",
      period: "2025-09-27",
    });
    const result = run(
      refs(claim("Revenue of $5.0 billion came with a 5.0% operating margin.", revenue.id)),
      [revenue],
    );
    expect(result.checks.unit).toEqual({ checked: 1, passed: 1, failed: 0, rate: 1 });
    expect(result.findings).toEqual([]);
  });

  it("does not invent a rule for dimensionless readings", () => {
    const score = numeric({ id: "computed.scores.quality", origin: "computed.scores", value: 72, unit: "score" });
    const result = run(refs(claim("The quality score was 72 out of 100.", score.id)), [score]);
    expect(result.checks.unit.checked).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * "checked" is reported separately from "coverage"
 * ------------------------------------------------------------------------ */

describe("checked vs coverage", () => {
  it("reports a null rate when nothing was eligible, never synthetic perfection", () => {
    const empty = emptyConsistencyChecks();
    for (const family of ["direction", "period", "unit", "namedIndividual"] as const) {
      expect(empty[family]).toEqual({ checked: 0, passed: 0, failed: 0, rate: null });
    }
    const result = run(refs(claim("A purely qualitative judgment.", "computed")), []);
    expect(result.checks.direction.rate).toBeNull();
    expect(result.checks.unit.rate).toBeNull();
  });

  it("counts a cited-but-contradicted sentence as CITED and FAILED at the same time", async () => {
    // The exact situation the split exists for: perfect provenance, wrong prose.
    const decline = numeric({ value: -3.2 });
    const payload = {
      provenanceRegistry: [decline],
      citationRegistry: [],
    } as unknown as ContextPayload;
    const report = {
      commentary: [claim("Revenue rose 3.2% year over year.", decline.id)],
    };

    const verify = await runVerifyPass({} as PassDeps, payload, report);
    expect(verify.coverage.factualClaims).toEqual({ supported: 1, total: 1, rate: 1 });
    expect(verify.checks.direction).toEqual({ checked: 1, passed: 0, failed: 1, rate: 0 });

    const checkEntry = verify.log.find((entry) => entry.check === "direction");
    expect(checkEntry?.outcome).toBe("unverified");
    expect(checkEntry?.reason).toBe("direction-mismatch");
    expect(checkEntry?.claim).toBe("Revenue rose 3.2% year over year.");
    expect(checkEntry?.note).toContain("Cited figure:");
    expect(checkEntry?.path).toBe("commentary[0]");
    // The coverage entry for the same claim stays a separate row.
    expect(verify.log.filter((entry) => entry.check === undefined).length).toBeGreaterThan(0);
  });

  it("discloses failing families in the missing-data manifest, and nothing when none fail", () => {
    // The verification log is long; the manifest is where a reader looks for
    // "what is wrong with this report", so a failure has to appear in both.
    const checks = emptyConsistencyChecks();
    expect(consistencyManifestEntries(checks)).toEqual([]);

    checks.direction = { checked: 4, passed: 3, failed: 1, rate: 0.75 };
    checks.namedIndividual = { checked: 2, passed: 0, failed: 2, rate: 0 };
    const entries = consistencyManifestEntries(checks);
    expect(entries.map((entry) => entry.field)).toEqual([
      "verify.check.direction",
      "verify.check.namedIndividual",
    ]);
    expect(entries.every((entry) => entry.severity === "warn")).toBe(true);
    expect(entries[0].reason).toContain("1 of 4 checked");
    expect(entries[0].reason).toContain("verification log");
    expect(entries[1].reason).toContain("2 of 2 checked");
  });
});

/* ------------------------------------------------------------------------ *
 * (e) Named individuals
 * ------------------------------------------------------------------------ */

describe("claims that name a person", () => {
  const transcript: CitationProvenanceRecord = {
    id: "fmp:earning-call-transcript",
    kind: "payload-text",
    asOf: "2026-05-01",
    origin: "fmp:earning-call-transcript",
  };
  const filing: CitationProvenanceRecord = {
    id: "edgar:10-K item7",
    kind: "payload-text",
    asOf: "2025-09-27",
    origin: "edgar:10-K item7",
  };
  const news: CitationProvenanceRecord = {
    id: "fmp:news",
    kind: "payload-text",
    asOf: "2026-07-03",
    origin: "fmp:news",
  };

  it("finds people from the payload's own rows, not from guesswork", () => {
    expect(
      collectPersonNames({
        leadershipNotes: ["Tim Cook — CEO (since 2011-08-24), pay 99000000 USD [fmp:key-executives]"],
        insiderNotes: ["2026-06-01 Katherine Adams (General Counsel): S-Sale 5000 @ 205 [fmp:insider-trades · 2026-06-01]"],
        executiveNames: ["Luca Maestri"],
      }),
    ).toEqual(expect.arrayContaining(["Tim Cook", "Katherine Adams", "Luca Maestri"]));
  });

  it("recognizes a person by name, honorific or role, and not a bare role", () => {
    expect(namesIndividual("Tim Cook said margins hold.", ["Tim Cook"])).toBe("Tim Cook");
    expect(namesIndividual("Dr. Rivera joined the board.", [])).toContain("Rivera");
    expect(namesIndividual("CEO Jane Roe reiterated guidance.", [])).toContain("Jane Roe");
    // No name: a claim about "the CEO" is a claim about the company's office.
    expect(namesIndividual("The CEO reiterated guidance.", [])).toBeNull();
    expect(namesIndividual("Free cash flow covered the dividend.", [])).toBeNull();
  });

  it("rejects a named-person claim sourced to a web-search result", async () => {
    const url = "https://example.com/interview";
    const payload = {
      provenanceRegistry: [],
      citationRegistry: [],
      leadership: { notes: ["Tim Cook — CEO [fmp:key-executives]"] },
    } as unknown as ContextPayload;
    const report = {
      governanceNotes: [claim("Tim Cook said the buyback pace continues.", `web:${url}`)],
    };

    const verify = await runVerifyPass({} as PassDeps, payload, report, { fetchedUrls: [url] });

    expect(verify.checks.namedIndividual).toEqual({ checked: 1, passed: 0, failed: 1, rate: 0 });
    const finding = verify.log.find((entry) => entry.check === "named-individual");
    expect(finding?.reason).toBe("named-individual-web-source");
    expect(finding?.note).toContain("Tim Cook");
    expect(finding?.note).toContain("restricted to filings and transcripts");
    // Rejected means it stops counting as supported — otherwise the coverage
    // number beside the finding would contradict it.
    expect(verify.coverage.factualClaims).toEqual({ supported: 0, total: 1, rate: 0 });
  });

  it("rejects a named-person claim with no source at all", () => {
    const result = run(
      refs(claim("Tim Cook has beaten guidance every quarter.", "analyst memory")),
      [],
      { personNames: ["Tim Cook"] },
    );
    expect(result.checks.namedIndividual.failed).toBe(1);
    expect(result.findings[0].reason).toBe("named-individual-unsourced");
  });

  it("accepts a named-person claim grounded in a transcript, a filing or a registry figure", () => {
    const figure = numeric({ id: "payload.leadership.comp-tim-cook-fy2025", value: 99000000, unit: "currency", currency: "USD" });
    for (const source of [transcript.id, filing.id, figure.id]) {
      const result = run(refs(claim("Tim Cook reiterated the margin target.", source)), [figure], {
        citationRegistry: [transcript, filing],
        personNames: ["Tim Cook"],
      });
      expect(result.checks.namedIndividual.passed).toBe(1);
      expect(result.findings).toEqual([]);
    }
  });

  it("restricts EVERY claim naming a person, not just the credibility section", () => {
    // 2026-09 review: the filing-or-transcript test ran on the credibility path
    // only, so an ordinary person-naming claim could cite anything in the
    // citation registry — a news item, a press release — while the prompt, the
    // module docstring, the README notes and the reader-facing table all said
    // "filings/transcripts only". Now they all say the same thing.
    const result = run(
      refs(claim("Tim Cook reiterated the margin target.", news.id)),
      [],
      { citationRegistry: [news, transcript], personNames: ["Tim Cook"] },
    );
    expect(result.checks.namedIndividual).toEqual({ checked: 1, passed: 0, failed: 1, rate: 0 });
    expect(result.findings[0].reason).toBe("named-individual-unsourced");
    expect(result.findings[0].note).toContain("Tim Cook");
    expect(result.findings[0].note).toContain("neither a registry figure nor a filing or transcript");
    expect(result.rejectedClaimPaths.has("fundamentals.commentary[0]")).toBe(true);
  });

  it("restricts the executive-credibility section to filings, transcripts and registry figures", () => {
    expect(isCredibilityPath("leadership.executives[0].reasoning[1]")).toBe(true);
    expect(isCredibilityPath("leadership.executives[2].evidence.guidanceVsActuals[0]")).toBe(true);
    expect(isCredibilityPath("outlook.guidanceCredibility[0]")).toBe(true);
    expect(isCredibilityPath("leadership.governanceNotes[0]")).toBe(false);
    expect(isFilingOrTranscriptSource("edgar:10-K item1A")).toBe(true);
    expect(isFilingOrTranscriptSource("fmp:earning-call-transcript")).toBe(true);
    expect(isFilingOrTranscriptSource("fmp:news")).toBe(false);

    // A news tag is a legitimate payload citation elsewhere, but not here.
    const credibility = [
      { claim: claim("Guidance was met in each of the last four quarters.", news.id), path: "outlook.guidanceCredibility[0]" },
    ];
    const rejected = runConsistencyChecks({
      claims: credibility,
      registry: [],
      citationRegistry: [news, transcript],
      fetchedUrls: new Set<string>(),
      personNames: [],
    });
    expect(rejected.checks.namedIndividual.failed).toBe(1);
    expect(rejected.findings[0].reason).toBe("credibility-source-restricted");
    expect(rejected.rejectedClaimPaths.has("outlook.guidanceCredibility[0]")).toBe(true);

    const accepted = runConsistencyChecks({
      claims: [{ ...credibility[0], claim: claim("Guidance was met in each of the last four quarters.", transcript.id) }],
      registry: [],
      citationRegistry: [news, transcript],
      fetchedUrls: new Set<string>(),
      personNames: [],
    });
    expect(accepted.checks.namedIndividual).toEqual({ checked: 1, passed: 1, failed: 0, rate: 1 });
  });

  it("tells the model the same rule the verifier enforces", () => {
    const guidance = buildLeadershipGuidance();
    expect(guidance).toContain("NAMED-INDIVIDUAL RULE");
    expect(guidance).toContain("A web-search result is NOT an acceptable source");
    expect(guidance).toContain("outlook.guidanceCredibility");
    // The old instruction pointed the model at web search for exactly this.
    expect(guidance).not.toContain("cited web-search results —");
  });
});
