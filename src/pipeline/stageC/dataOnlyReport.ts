/**
 * Data-only report enrichment — the deterministic Stage B content a report
 * carries when the LLM passes do not run.
 *
 * Before this module, `buildDataOnlyReport` persisted a stub whose every
 * analytical section was empty and whose every grade was a placeholder "F",
 * even though `runStageB` had already computed growth, returns, capital
 * structure, forensics, technicals, the DCF, the reverse DCF, multiples,
 * scenario targets, projections and the deterministic aspect scores. The
 * company page rendered those numbers live and the persisted report — the
 * thing history, Markdown export and print actually show — threw them away.
 *
 * Rules, in order of precedence:
 *   1. Nothing here is authored: every number is a Stage B output carrying the
 *      same `computed.*` source ids the LLM payload registers, and every prose
 *      string is a template over those numbers. No judgment is manufactured.
 *   2. The report says plainly, in the synthesis and in every graded block,
 *      that no analyst pass ran. Letter grades are the deterministic score
 *      bands — the same reproducible anchor the judge is prompted to align to.
 *   3. Sections the pipeline cannot fill deterministically (catalysts, risks,
 *      outlook narratives, executive credibility, moat sources) stay empty and
 *      say so; they are never padded.
 *
 * Pure: no clock, no network, no DB. Importable from the job runner without
 * pulling in a provider client.
 */

import { routeMetricsBlock, type ComputedMetrics } from "@/pipeline/compute";
import type { DataBundle } from "@/pipeline/types";
import type { ForensicFlag } from "@/pipeline/stageB/forensics";
import { scoreToBand } from "@/pipeline/stageB/grading";
import { CORE_SERIES } from "@/providers/fred";
import {
  applyDcfDisplay,
  applyFairValue,
  applyForensicScores,
  applyMultiples,
  applyReverseDcf,
  applyScenarioTargets,
  collectTracedNumbers,
} from "@/pipeline/stageC/passes";
import type {
  AspectScore,
  GradeBlock,
  MetricRow,
  ProvenanceCoverage,
  Report,
  ScoreAspect,
  SourcedClaim,
  TracedNumber,
} from "@/report/schema";

/* ------------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------------ */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Strict calendar date or null — never a datetime, never a partial. */
function isoDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number);
  const parsed = new Date(Date.UTC(y!, m! - 1, d!));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m! - 1 && parsed.getUTCDate() === d
    ? day
    : null;
}

function isoCurrency(value: unknown): string | null {
  const currency = typeof value === "string" ? value.trim().toUpperCase() : null;
  return currency !== null && /^[A-Z]{3}$/.test(currency) ? currency : null;
}

const round = (v: number, dp: number): number => Number(v.toFixed(dp));

interface TracedOptions {
  currency?: string | null;
  period?: string | null;
}

/**
 * A Stage B number as a TracedNumber. `verified: true` because the value was
 * computed by the pipeline from sourced inputs — the same status the LLM path
 * gives the deterministic score drivers. Monetary units require a currency;
 * without one the figure is withheld rather than mislabelled (the currency
 * audit's standing rule).
 */
function traced(
  value: number | null | undefined,
  unit: string,
  source: string,
  asOf: string | null,
  options: TracedOptions = {},
): TracedNumber | null {
  if (!isNum(value)) return null;
  const monetary = unit === "currency" || unit === "currency/share";
  const currency = options.currency ?? null;
  if (monetary && currency === null) return null;
  return {
    value: round(value, 6),
    unit,
    ...(currency === null ? {} : { currency }),
    ...(options.period === undefined || options.period === null ? {} : { period: options.period }),
    source,
    asOf: isoDay(asOf),
    verified: true,
  };
}

function fact(text: string, source: string, asOf: string | null): SourcedClaim {
  return { text, label: "FACT", source, asOf: isoDay(asOf) };
}

function fmtNum(v: number, dp = 2): string {
  return v.toLocaleString("en-US", { maximumFractionDigits: dp, minimumFractionDigits: 0 });
}

function fmtPct(v: number, dp = 1): string {
  return `${fmtNum(v, dp)}%`;
}

function fmtSignedPp(v: number, dp = 1): string {
  return `${v >= 0 ? "+" : "−"}${fmtNum(Math.abs(v), dp)}pp`;
}

/** Compact money: 1.23B / 456.7M / 12.3K, with the currency code. */
function fmtMoney(v: number, currency: string): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  const scaled =
    abs >= 1e12 ? `${fmtNum(abs / 1e12, 2)}T`
    : abs >= 1e9 ? `${fmtNum(abs / 1e9, 2)}B`
    : abs >= 1e6 ? `${fmtNum(abs / 1e6, 1)}M`
    : abs >= 1e3 ? `${fmtNum(abs / 1e3, 1)}K`
    : fmtNum(abs, 2);
  return `${sign}${scaled} ${currency}`;
}

/** The statements' own reporting currency — never the profile's trading one. */
function statementCurrency(bundle: DataBundle): string | null {
  const row = bundle.statements.incomeAnnual.ok
    ? bundle.statements.incomeAnnual.value.data.rows[0]
    : undefined;
  return isoCurrency(row?.reportedCurrency);
}

function tradingCurrency(bundle: DataBundle): string | null {
  const row = bundle.profile.ok ? bundle.profile.value.data.rows[0] : undefined;
  return isoCurrency(row?.currency);
}

function quotePrice(bundle: DataBundle): { price: number; asOf: string | null } | null {
  const row = bundle.quote.ok ? bundle.quote.value.data.rows[0] : undefined;
  return isNum(row?.price) && row.price > 0
    ? { price: row.price, asOf: bundle.quote.ok ? bundle.quote.value.asOf : null }
    : null;
}

/* ------------------------------------------------------------------------ *
 * Grades — deterministic bands, stated as such
 * ------------------------------------------------------------------------ */

/**
 * The composite regularizes missing evidence toward this midpoint (grading.ts),
 * so an aspect with no route-applicable evidence is shown at the same neutral
 * point rather than at "F", which would read as a failing assessment that
 * nobody made.
 */
export const NEUTRAL_MIDPOINT_SCORE = 50;

const ASPECT_LABEL: Record<ScoreAspect, string> = {
  fundamentals: "fundamentals",
  valuation: "valuation",
  quality: "quality",
  balanceSheet: "balance sheet",
  moat: "moat",
  leadership: "leadership",
  technicals: "technicals",
};

function gradeBlock(
  key: ScoreAspect,
  aspect: AspectScore,
  asOf: string | null,
  flagClaim: SourcedClaim,
): GradeBlock {
  const source = `computed.scores.${key}`;
  if (aspect.score === null || aspect.band === null) {
    const reason = aspect.notApplicableReason ?? "no applicable signals for this route";
    return {
      grade: scoreToBand(NEUTRAL_MIDPOINT_SCORE),
      oneLineWhy: `Not scored — ${reason}. Shown at the neutral midpoint, not as an assessment; no analyst pass ran.`,
      reasoning: [
        fact(`Deterministic ${ASPECT_LABEL[key]} score unavailable: ${reason}.`, source, asOf),
        flagClaim,
      ],
      confidence: "low",
      keyNumbers: aspect.drivers,
    };
  }
  const completenessPct = Math.round(aspect.dataCompleteness * 100);
  return {
    grade: aspect.band,
    oneLineWhy: `Deterministic score ${fmtNum(aspect.score, 1)}/100 (band ${aspect.band}) on ${completenessPct}% of intended signals; no analyst pass ran.`,
    reasoning: [
      fact(
        `Deterministic ${ASPECT_LABEL[key]} score ${fmtNum(aspect.score, 2)}/100 maps to band ${aspect.band} under the versioned house band table; ${completenessPct}% of the aspect's intended signal weight had data. ${aspect.note}`,
        source,
        asOf,
      ),
      flagClaim,
    ],
    confidence: aspect.dataCompleteness >= 0.75 ? "medium" : "low",
    keyNumbers: aspect.drivers,
    interpretation:
      "This is the pipeline's reproducible score band, the same anchor the analyst pass is prompted to align its letter to. It is not an analyst grade: no bull, bear or synthesis pass ran on this report.",
  };
}

/* ------------------------------------------------------------------------ *
 * Fundamentals
 * ------------------------------------------------------------------------ */

function cagrRow(
  label: string,
  points: ComputedMetrics["growth"]["revenueCagrs"],
  source: string,
): MetricRow | null {
  const values: MetricRow["values"] = [];
  for (const point of points) {
    const value = traced(point.cagrPct, "%", source, point.endDate, {
      period: `${point.windowYears}y`,
    });
    if (value === null) continue;
    const spanNote =
      isNum(point.actualYears) && Math.abs(point.actualYears - point.windowYears) > 0.25
        ? ` (measured over ${fmtNum(point.actualYears, 1)}y)`
        : "";
    values.push({ period: `${point.windowYears}y CAGR${spanNote}`, value });
  }
  return values.length > 0 ? { label, values } : null;
}

function seriesRow(
  label: string,
  points: readonly { date: string; value: number | null }[],
  unit: string,
  source: string,
  currency: string | null,
): MetricRow | null {
  const values: MetricRow["values"] = [];
  for (const point of points) {
    const value = traced(point.value, unit, source, point.date, { currency, period: point.date });
    if (value !== null) values.push({ period: point.date, value });
  }
  return values.length > 0 ? { label, values } : null;
}

function singleRow(
  label: string,
  period: string,
  value: number | null,
  unit: string,
  source: string,
  asOf: string | null,
  currency: string | null = null,
): MetricRow | null {
  const number = traced(value, unit, source, asOf, { currency, period });
  return number === null ? null : { label, values: [{ period, value: number }] };
}

function present<T>(rows: (T | null)[]): T[] {
  return rows.filter((row): row is T => row !== null);
}

function fundamentalsSections(
  computed: ComputedMetrics,
  currency: string | null,
): Pick<Report["fundamentals"], "growthTable" | "marginTrend" | "returns" | "fcf"> {
  const g = computed.growth;
  const r = computed.returns;
  const cap = computed.capital;

  const growthTable = present([
    cagrRow("Revenue CAGR", g.revenueCagrs, "computed.growth.revenueCagrs"),
    cagrRow("Diluted EPS CAGR", g.epsDilutedCagrs, "computed.growth.epsDilutedCagrs"),
    cagrRow("Free cash flow CAGR", g.fcfCagrs, "computed.growth.fcfCagrs"),
    singleRow("Revenue growth, latest year", "latest YoY", g.revenueAcceleration.latestYoyPct, "%", "computed.growth.revenueAcceleration", g.asOf),
    singleRow("Revenue acceleration (YoY − 3y CAGR)", "latest", g.revenueAcceleration.deltaPctPts, "pp", "computed.growth.revenueAcceleration", g.asOf),
  ]);

  const marginSeries = (trend: ComputedMetrics["growth"]["margins"]["gross"]) =>
    trend.series.map((point) => ({ date: point.date, value: point.pct }));
  const marginTrend = present([
    seriesRow("Gross margin", marginSeries(g.margins.gross), "%", "computed.growth.margins.gross", null),
    seriesRow("Operating margin", marginSeries(g.margins.operating), "%", "computed.growth.margins.operating", null),
    seriesRow("Net margin", marginSeries(g.margins.net), "%", "computed.growth.margins.net", null),
    singleRow("Gross margin slope", "trend", g.margins.gross.slopePctPtsPerYear, "pp/yr", "computed.growth.margins.gross", g.asOf),
    singleRow("Operating margin slope", "trend", g.margins.operating.slopePctPtsPerYear, "pp/yr", "computed.growth.margins.operating", g.asOf),
    singleRow("Net margin slope", "trend", g.margins.net.slopePctPtsPerYear, "pp/yr", "computed.growth.margins.net", g.asOf),
  ]);

  const returns = present([
    seriesRow("ROIC", r.roic.series.map((y) => ({ date: y.date, value: y.roicPct })), "%", "computed.returns.roic", null),
    seriesRow("Return on tangible common equity", r.rote.series.map((y) => ({ date: y.date, value: y.rotePct })), "%", "computed.returns.rote", null),
    seriesRow("ROE (DuPont)", r.dupont.series.map((y) => ({ date: y.date, value: y.roePct })), "%", "computed.returns.dupont", null),
    singleRow("WACC", "latest", r.wacc.waccPct, "%", "computed.returns.wacc", r.wacc.asOf?.statements ?? null),
    singleRow("Cost of equity", "latest", r.wacc.costOfEquityPct, "%", "computed.returns.wacc.costOfEquity", r.wacc.asOf?.riskFreeRate ?? null),
    singleRow("Pre-tax cost of debt", "latest", r.wacc.costOfDebtPct, "%", `computed.returns.wacc.costOfDebt(${r.wacc.costOfDebtMethod})`, r.wacc.asOf?.statements ?? null),
    singleRow("ROIC − WACC spread", "latest", r.roicVsWacc.spreadPctPts, "pp", "computed.returns.roicVsWacc", r.roic.asOf),
  ]);

  const fcf = present([
    seriesRow("Free cash flow", cap.fcf.series.map((y) => ({ date: y.date, value: y.fcf })), "currency", "computed.capital.fcf", currency),
    seriesRow("FCF conversion (FCF / net income)", cap.fcf.series.map((y) => ({ date: y.date, value: y.fcfConversion })), "x", "computed.capital.fcf.conversion", null),
    seriesRow("Capex / revenue", cap.capexIntensity.series.map((y) => ({ date: y.date, value: y.capexToRevenuePct })), "%", "computed.capital.capexIntensity", null),
  ]);

  return { growthTable, marginTrend, returns, fcf };
}

/* ------------------------------------------------------------------------ *
 * Balance sheet & capital
 * ------------------------------------------------------------------------ */

function balanceSheetSection(
  computed: ComputedMetrics,
  currency: string | null,
  flagClaim: SourcedClaim,
): Report["balanceSheet"] {
  const cap = computed.capital;
  const nd = cap.netDebtToEbitda;
  const debtNumbers = present([
    traced(nd.value, "x", "computed.capital.netDebtToEbitda", nd.asOf, { period: "net debt / EBITDA" }),
    traced(nd.netDebt, "currency", "computed.capital.netDebtToEbitda.netDebt", nd.asOf, { currency, period: "net debt" }),
    traced(nd.ebitda, "currency", "computed.capital.netDebtToEbitda.ebitda", nd.asOf, { currency, period: "EBITDA" }),
  ]);
  const coverageNumbers = present([
    traced(cap.interestCoverage.value, "x", "computed.capital.interestCoverage", cap.asOf, { period: "EBIT / interest" }),
    traced(cap.interestCoverage.ebit, "currency", "computed.capital.interestCoverage.ebit", cap.asOf, { currency, period: "EBIT" }),
    traced(cap.interestCoverage.interestExpense, "currency", "computed.capital.interestCoverage.interestExpense", cap.asOf, { currency, period: "interest expense" }),
  ]);
  const capexNumbers = present([
    traced(cap.capexIntensity.latestPct, "%", "computed.capital.capexIntensity", cap.asOf, { period: "capex / revenue, latest" }),
    traced(cap.capexIntensity.slopePctPtsPerYear, "pp/yr", "computed.capital.capexIntensity", cap.asOf, { period: "capex / revenue slope" }),
    traced(cap.maintenanceVsGrowthCapex.capexToDALatest, "x", "computed.capital.maintenanceVsGrowthCapex", cap.asOf, { period: "capex / D&A, latest" }),
    traced(cap.maintenanceVsGrowthCapex.capexToDA5yAvg, "x", "computed.capital.maintenanceVsGrowthCapex", cap.asOf, { period: "capex / D&A, 5y average" }),
  ]);

  const debtCommentary: SourcedClaim[] = [flagClaim];
  if (isNum(nd.value)) {
    debtCommentary.push(
      fact(
        `Net debt is ${fmtNum(nd.value, 2)}x EBITDA (cash basis: ${nd.resolution.cashBasis ?? "unresolved"}).`,
        "computed.capital.netDebtToEbitda",
        nd.asOf,
      ),
    );
  }
  if (nd.note) debtCommentary.push(fact(nd.note, "computed.capital.netDebtToEbitda", nd.asOf));

  const coverageCommentary: SourcedClaim[] = [];
  if (isNum(cap.interestCoverage.value)) {
    coverageCommentary.push(
      fact(`EBIT covers interest expense ${fmtNum(cap.interestCoverage.value, 1)} times.`, "computed.capital.interestCoverage", cap.asOf),
    );
  }
  if (cap.interestCoverage.note) {
    coverageCommentary.push(fact(cap.interestCoverage.note, "computed.capital.interestCoverage", cap.asOf));
  }

  const capexCommentary: SourcedClaim[] = [];
  if (isNum(cap.capexIntensity.latestPct)) {
    const slope = cap.capexIntensity.slopePctPtsPerYear;
    capexCommentary.push(
      fact(
        `Capex runs at ${fmtPct(cap.capexIntensity.latestPct)} of revenue${isNum(slope) ? `, trending ${fmtSignedPp(slope)} per year` : ""}.`,
        "computed.capital.capexIntensity",
        cap.asOf,
      ),
    );
  }
  capexCommentary.push(fact(cap.maintenanceVsGrowthCapex.note, "computed.capital.maintenanceVsGrowthCapex", cap.asOf));

  const allocation: SourcedClaim[] = [];
  const sc = cap.shareCount;
  if (isNum(sc.trendPct) && sc.startDate && sc.endDate) {
    allocation.push(
      fact(
        `Diluted share count changed ${fmtPct(sc.trendPct)} between ${sc.startDate} and ${sc.endDate}${isNum(sc.annualizedPct) ? ` (${fmtPct(sc.annualizedPct)} annualized` : ""}${sc.direction ? `${isNum(sc.annualizedPct) ? "; " : " ("}${sc.direction})` : isNum(sc.annualizedPct) ? ")" : ""}.`,
        "computed.capital.shareCount",
        sc.endDate,
      ),
    );
  }
  if (isNum(cap.sbc.pctOfRevenue)) {
    allocation.push(
      fact(
        `Stock-based compensation is ${fmtPct(cap.sbc.pctOfRevenue)} of revenue${isNum(cap.sbc.pctOfFcf) ? ` and ${fmtPct(cap.sbc.pctOfFcf)} of free cash flow` : ""}.`,
        "computed.capital.sbc",
        cap.asOf,
      ),
    );
  }
  const bb = cap.buybackPriceAnalysis;
  if (bb.totalRepurchased > 0 && currency !== null) {
    const priceNote = isNum(bb.premiumDiscountPct)
      ? ` at an average price proxy ${fmtPct(Math.abs(bb.premiumDiscountPct))} ${bb.premiumDiscountPct >= 0 ? "below" : "above"} the current price`
      : "";
    allocation.push(
      fact(`Repurchased ${fmtMoney(bb.totalRepurchased, currency)} of stock across the analysed years${priceNote}.`, "computed.capital.buybackPriceAnalysis", cap.asOf),
    );
  }
  if (bb.note) allocation.push(fact(bb.note, "computed.capital.buybackPriceAnalysis", cap.asOf));

  return {
    debtProfile: { commentary: debtCommentary, numbers: debtNumbers },
    coverage: { commentary: coverageCommentary, numbers: coverageNumbers },
    capexTrajectory: { commentary: capexCommentary, numbers: capexNumbers },
    capitalAllocation: allocation,
  };
}

/* ------------------------------------------------------------------------ *
 * Valuation
 * ------------------------------------------------------------------------ */

function bestMeasuredCagr(points: ComputedMetrics["growth"]["revenueCagrs"]): { windowYears: number; cagrPct: number } | null {
  for (const window of [5, 3, 1]) {
    const point = points.find((p) => p.windowYears === window);
    if (point && isNum(point.cagrPct) && (!isNum(point.actualYears) || Math.abs(point.actualYears - window) <= 0.25)) {
      return { windowYears: window, cagrPct: point.cagrPct };
    }
  }
  return null;
}

function reverseDcfNarrative(computed: ComputedMetrics): string {
  const v = computed.valuation;
  if (v.kind !== "dcf" || v.reverseDcf === null || v.reverseDcf.method === "none") {
    return `Reverse DCF not computed on the ${v.kind} route; no narrative analysis ran on this data-only report.`;
  }
  const r = v.reverseDcf;
  if (r.method === "growth" && isNum(r.impliedRevenueGrowthPct)) {
    const achievable = bestMeasuredCagr(computed.growth.revenueCagrs);
    const compare = achievable
      ? ` The measured ${achievable.windowYears}-year revenue CAGR is ${fmtPct(achievable.cagrPct)}, a ${fmtSignedPp(r.impliedRevenueGrowthPct - achievable.cagrPct)} gap between what the price requires and what was delivered.`
      : "";
    return `The market price is consistent with ${fmtPct(r.impliedRevenueGrowthPct)} constant revenue growth over the explicit DCF horizon, with every other DCF input held at its base value.${compare} Deterministic solve; no narrative analysis ran.`;
  }
  if (r.method === "margin" && isNum(r.impliedTerminalMarginPct)) {
    return `The market price is consistent with a ${fmtPct(r.impliedTerminalMarginPct)} terminal EBIT margin, with growth held at its base path (margin-solve fallback). Deterministic solve; no narrative analysis ran.`;
  }
  return "Reverse DCF did not converge; see the missing-data manifest. No narrative analysis ran.";
}

function valuationSection(
  stub: Report["valuation"],
  computed: ComputedMetrics,
  graded: GradeBlock,
): Report["valuation"] {
  const targets = computed.scenarioTargets;
  const byName = new Map<string, { growthDeltaPp: number; marginDeltaPp: number }>();
  if (targets?.status === "available") {
    for (const target of targets.targets) byName.set(target.name, target);
  }
  const scenarios = stub.scenarios.map((scenario) => {
    const target = byName.get(scenario.name);
    return {
      ...scenario,
      horizon: target ? "explicit DCF horizon" : "n/a",
      assumptions: target
        ? [
            `Deterministic Stage B target (${targets?.method ?? "scenario-targets"} ${targets?.methodVersion ?? ""}): revenue growth ${fmtSignedPp(target.growthDeltaPp)} and operating margin ${fmtSignedPp(target.marginDeltaPp)} versus the base DCF path.`.replace("  ", " "),
            "Probability is not assigned: scenario odds are analyst judgments and no analyst pass ran.",
          ]
        : ["Deterministic scenario target unavailable for this route or inputs; see the missing-data manifest."],
      whatWouldHaveToBeTrue: [
        "Narrative scenario conditions require the analyst passes, which did not run on this data-only report.",
      ],
    };
  });
  const withTargets = applyScenarioTargets({ ...stub, graded, scenarios }, computed.scenarioTargets);
  const withFairValue = applyFairValue(withTargets, computed.fairValue);
  const withDisplay = applyDcfDisplay(withFairValue, computed.valuation);
  const withMultiples = applyMultiples(withDisplay, computed.valuation);
  const withReverse = applyReverseDcf(withMultiples, computed.valuation);
  return {
    ...withReverse,
    reverseDcf: { ...withReverse.reverseDcf, narrative: reverseDcfNarrative(computed) },
  };
}

/* ------------------------------------------------------------------------ *
 * Quality, technicals, leadership, competitive, macro, business
 * ------------------------------------------------------------------------ */

const FLAG_SEVERITY: Record<ForensicFlag["severity"], "high" | "medium" | "low"> = {
  flag: "high",
  warn: "medium",
  info: "low",
};

function qualitySection(stub: Report["quality"], computed: ComputedMetrics, graded: GradeBlock): Report["quality"] {
  const withScores = applyForensicScores({ ...stub, graded }, computed.forensics);
  const flags = computed.forensics.flags.map((flag) => ({
    severity: FLAG_SEVERITY[flag.severity],
    text: `${flag.message} (rule: ${flag.rule})`,
    source: `computed.forensics.flags.${flag.id}`,
  }));
  return { ...withScores, flags };
}

function technicalsSection(computed: ComputedMetrics, graded: GradeBlock, currency: string | null): Report["technicals"] {
  const t = computed.technicals;
  const asOf = t.asOf;
  const px = (label: string, value: number | null) => (isNum(value) ? `${label} ${fmtNum(value, 2)}` : `${label} n/a`);
  const rs6 = t.relativeStrength.benchmark.points.find((p) => p.months === 6)?.differentialPctPoints ?? null;
  const rs12 = t.relativeStrength.benchmark.points.find((p) => p.months === 12)?.differentialPctPoints ?? null;
  const indicators = present([
    traced(t.lastClose, "currency/share", "computed.technicals", asOf, { currency, period: "last close" }),
    traced(t.smaCross.sma50, "currency/share", "computed.technicals.smaCross", asOf, { currency, period: "SMA50" }),
    traced(t.smaCross.sma200, "currency/share", "computed.technicals.smaCross", asOf, { currency, period: "SMA200" }),
    traced(t.rsi14, "index", "computed.technicals.rsi14", asOf, { period: "RSI-14" }),
    traced(t.macd.histogram, "points", "computed.technicals.macd", asOf, { period: "MACD histogram" }),
    traced(t.range52w.high52w, "currency/share", "computed.technicals.range52w", asOf, { currency, period: "52-week high" }),
    traced(t.range52w.low52w, "currency/share", "computed.technicals.range52w", asOf, { currency, period: "52-week low" }),
    traced(t.range52w.pctFromHigh, "%", "computed.technicals.range52w", asOf, { period: "% from 52-week high" }),
    traced(t.range52w.positionPct, "%", "computed.technicals.range52w", asOf, { period: "position in 52-week range" }),
    traced(t.atr14.atrPctOfClose, "%", "computed.technicals.atr14", t.atr14.asOf, { period: "ATR-14 as % of close" }),
    traced(rs6, "pp", "computed.technicals.relativeStrength", asOf, { period: "6-month return vs benchmark" }),
    traced(rs12, "pp", "computed.technicals.relativeStrength", asOf, { period: "12-month return vs benchmark" }),
  ]);
  return {
    graded,
    read: {
      trend: `${t.read.trend} (deterministic SMA50/SMA200 read; no analyst pass ran)`,
      momentum: `${t.read.momentum} (deterministic RSI/MACD read)`,
      keyLevels: `${px("SMA50", t.read.keyLevels.sma50)} · ${px("SMA200", t.read.keyLevels.sma200)} · ${px("52-week high", t.read.keyLevels.high52w)} · ${px("52-week low", t.read.keyLevels.low52w)}`,
      relativeStrength: t.read.relativeStrength,
    },
    indicators,
    flags: t.read.flags.map((text) => ({
      severity: "medium" as const,
      text,
      source: "computed.technicals.read.flags",
    })),
  };
}

function leadershipSection(stub: Report["leadership"], bundle: DataBundle, graded: GradeBlock): Report["leadership"] {
  const notes: SourcedClaim[] = [...stub.governanceNotes];
  if (bundle.executives.ok) {
    const asOf = bundle.executives.value.asOf;
    const rows = bundle.executives.value.data.rows.slice(0, 8);
    for (const row of rows) {
      const name = typeof row.name === "string" && row.name.length > 0 ? row.name : null;
      const title = typeof row.title === "string" && row.title.length > 0 ? row.title : null;
      if (name === null || title === null) continue;
      const since = isoDay(row.titleSince);
      notes.push(fact(`${name} — ${title}${since ? ` (since ${since})` : ""}.`, "fmp:key-executives", asOf));
    }
  }
  return { ...stub, graded, governanceNotes: notes };
}

function macroSection(bundle: DataBundle, stub: Report["macro"]): Report["macro"] {
  const labels = new Map(CORE_SERIES.map((series) => [series.id, series.label]));
  const rows: Report["macro"]["relevantSeries"] = [];
  const emit = (
    record: Record<string, DataBundle["macro"]["core"][string]>,
    relevance: string,
  ): void => {
    for (const seriesId of Object.keys(record).sort()) {
      const result = record[seriesId];
      if (!result?.ok) continue;
      const observations = result.value.data;
      const last = observations[observations.length - 1];
      if (!last) continue;
      const latest = traced(last.value, "index", `fred:${seriesId}`, last.date);
      if (latest === null) continue;
      rows.push({ seriesId, name: labels.get(seriesId) ?? seriesId, latest, relevance });
    }
  };
  emit(bundle.macro.core, "Core macro series tracked for every issuer.");
  emit(
    bundle.macro.sector,
    bundle.macro.gicsSector
      ? `Sector-routed series for ${bundle.macro.gicsSector}.`
      : "Sector-routed series.",
  );
  return { ...stub, relevantSeries: rows };
}

function segmentRows(
  result: DataBundle["segmentation"]["product"],
  source: string,
  fallbackCurrency: string | null,
): Report["business"]["segments"]["product"] {
  if (!result.ok) return [];
  const latest = result.value.data.rows[0];
  const data = latest?.data;
  if (data === undefined || data === null || typeof data !== "object") return [];
  const asOf = isoDay(latest?.date);
  const currency = isoCurrency(latest?.reportedCurrency) ?? fallbackCurrency;
  const entries = Object.entries(data as Record<string, unknown>)
    .filter((entry): entry is [string, number] => isNum(entry[1]))
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((acc, [, value]) => acc + (value > 0 ? value : 0), 0);
  const rows: Report["business"]["segments"]["product"] = [];
  for (const [name, value] of entries) {
    const revenue = traced(value, "currency", source, asOf, { currency, period: asOf });
    if (revenue === null) continue;
    rows.push({
      name,
      revenue,
      sharePct: total > 0 && value > 0 ? round((value / total) * 100, 1) : null,
    });
  }
  return rows;
}

function businessSection(stub: Report["business"], bundle: DataBundle, currency: string | null): Report["business"] {
  return {
    ...stub,
    segments: {
      product: segmentRows(bundle.segmentation.product, "fmp:revenue-product-segmentation", currency),
      geographic: segmentRows(bundle.segmentation.geographic, "fmp:revenue-geographic-segmentation", currency),
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Synthesis + coverage
 * ------------------------------------------------------------------------ */

function synthesis(
  computed: ComputedMetrics,
  bundle: DataBundle,
  reason: string,
  currency: string | null,
  disclosedGaps: number,
): string {
  const parts: string[] = [
    `Data-only report: the grounded analyst passes did not run (${reason}), so there is no synthesis, no narrative scenarios and no analyst grades.`,
  ];
  const composite = computed.scores.composite;
  if (composite.score !== null && composite.band !== null) {
    const bands = (Object.keys(ASPECT_LABEL) as ScoreAspect[])
      .map((key) => {
        const aspect = computed.scores.aspects[key];
        return `${ASPECT_LABEL[key]} ${aspect.band ?? "n/s"}`;
      })
      .join(", ");
    parts.push(
      `The deterministic composite score is ${fmtNum(composite.score, 1)}/100 (band ${composite.band}); aspect bands — ${bands}.`,
    );
  }
  const fv = computed.fairValue;
  const quote = quotePrice(bundle);
  if (fv.status === "available" && fv.perShare !== null) {
    const fvCurrency = fv.perShare.currency ?? currency;
    const upside = isNum(fv.upsidePct) ? ` (${fmtSignedPp(fv.upsidePct).replace("pp", "%")} versus the quote)` : "";
    parts.push(
      `Deterministic ${fv.method ?? "fair-value"} model: ${fmtNum(fv.perShare.value, 2)}${fvCurrency ? ` ${fvCurrency}` : ""} per share${quote ? ` against a ${fmtNum(quote.price, 2)} quote` : ""}${upside}.`,
    );
  }
  const v = computed.valuation;
  if (v.kind === "dcf" && v.reverseDcf?.method === "growth" && isNum(v.reverseDcf.impliedRevenueGrowthPct)) {
    parts.push(
      `The price is consistent with ${fmtPct(v.reverseDcf.impliedRevenueGrowthPct)} constant revenue growth over the explicit DCF horizon.`,
    );
  }
  const flags = computed.forensics.flags.length;
  const gaps = disclosedGaps;
  parts.push(
    `${flags} forensic flag${flags === 1 ? "" : "s"} raised; ${gaps} data gap${gaps === 1 ? "" : "s"} disclosed in the appendix. Every figure below is a Stage B computation with its source; nothing was authored.`,
  );
  return parts.join(" ");
}

function provenanceCoverage(report: Report): ProvenanceCoverage {
  const numbers = collectTracedNumbers(report);
  const numericTotal = numbers.length;
  const numericSupported = numbers.filter((n) => n.verified === true).length;
  const claims = collectClaims(report);
  const facts = claims.filter((claim) => claim.label === "FACT");
  const judgments = claims.filter((claim) => claim.label === "JUDGMENT");
  const rate = (supported: number, total: number): number | null =>
    total === 0 ? null : round(supported / total, 4);
  return {
    numeric: { supported: numericSupported, total: numericTotal, rate: rate(numericSupported, numericTotal) },
    factualClaims: { supported: facts.length, total: facts.length, rate: rate(facts.length, facts.length) },
    judgments: { cited: judgments.length, total: judgments.length, rate: rate(judgments.length, judgments.length) },
  };
}

function collectClaims(root: unknown): SourcedClaim[] {
  const out: SourcedClaim[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (
      typeof record.text === "string" &&
      (record.label === "FACT" || record.label === "ESTIMATE" || record.label === "JUDGMENT") &&
      typeof record.source === "string"
    ) {
      out.push(record as unknown as SourcedClaim);
      return;
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(root);
  return out;
}

/* ------------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------------ */

export interface EnrichDataOnlyReportArgs {
  bundle: DataBundle;
  computed: ComputedMetrics;
  /** Why the LLM passes did not run — quoted in the synthesis. */
  reason: string;
}

/**
 * Fill a data-only report stub with the deterministic Stage B content. Every
 * section keeps its explicit "no analyst pass ran" disclosure; the numbers,
 * scores, fair value, scenario targets and projections are attached exactly as
 * the LLM path attaches them after the judge.
 */
export function enrichDataOnlyReport(stub: Report, args: EnrichDataOnlyReportArgs): Report {
  const { bundle, computed } = args;
  const routeMetrics = routeMetricsBlock(computed);
  const currency = statementCurrency(bundle);
  const priceCurrency = tradingCurrency(bundle) ?? currency;
  const asOf = computed.builtAt.slice(0, 10);
  const flagClaim =
    stub.fundamentals.commentary[0] ??
    ({ text: `LLM analysis did not run — ${args.reason}.`, label: "JUDGMENT", source: "pipeline", asOf: null } satisfies SourcedClaim);

  const block = (key: ScoreAspect): GradeBlock => gradeBlock(key, computed.scores.aspects[key], asOf, flagClaim);
  const fundamentalsGrade = block("fundamentals");
  const valuationGrade = block("valuation");
  const qualityGrade = block("quality");
  const balanceSheetGrade = block("balanceSheet");
  const moatGrade = block("moat");
  const leadershipGrade = block("leadership");
  const technicalsGrade = block("technicals");

  const candidate: Report = {
    ...stub,
    verdict: {
      synthesis: synthesis(computed, bundle, args.reason, currency, stub.appendix.missingData.length),
      gradeStrip: {
        fundamentals: fundamentalsGrade,
        valuation: valuationGrade,
        technicals: technicalsGrade,
        quality: qualityGrade,
        leadership: leadershipGrade,
        moat: moatGrade,
      },
    },
    business: businessSection(stub.business, bundle, currency),
    fundamentals: {
      ...stub.fundamentals,
      graded: fundamentalsGrade,
      ...fundamentalsSections(computed, currency),
    },
    balanceSheet: { graded: balanceSheetGrade, ...balanceSheetSection(computed, currency, flagClaim) },
    valuation: valuationSection(stub.valuation, computed, valuationGrade),
    quality: qualitySection(stub.quality, computed, qualityGrade),
    technicals: technicalsSection(computed, technicalsGrade, priceCurrency),
    leadership: leadershipSection(stub.leadership, bundle, leadershipGrade),
    competitive: {
      ...stub.competitive,
      moatGraded: moatGrade,
      marketShareDirection: "Not assessed: market-share direction is an analyst judgment and no analyst pass ran on this data-only report.",
    },
    macro: macroSection(bundle, stub.macro),
    scores: computed.scores,
    projections: computed.projections,
    scenarioTargets: computed.scenarioTargets,
    fairValue: computed.fairValue,
    // WS5 (D-17): the route metrics a financial report leads with, and the
    // P/TBV-against-ROTE reading, on the data-only surface too — this report
    // has no analyst pass to describe them in prose.
    ...(routeMetrics ? { routeMetrics } : {}),
  };

  const coverage = provenanceCoverage(candidate);
  return {
    ...candidate,
    meta: { ...candidate.meta, provenanceCoverage: coverage },
    appendix: { ...candidate.appendix, provenanceCoverage: coverage },
  };
}
