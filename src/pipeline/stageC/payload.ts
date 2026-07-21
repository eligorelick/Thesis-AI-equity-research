/**
 * Stage C — Context payload assembly (the application contract §5).
 *
 * assembleContextPayload(bundle, computed, validation) produces a DETERMINISTIC,
 * cache-friendly structured object containing EVERYTHING the LLM is allowed to
 * use, and NOTHING else. serializePayloadForPrompt(payload) renders it to a
 * clean, sectioned, LLM-readable text block where every number carries its
 * "[source · as-of]" provenance tag — this is the exact string that gets
 * prompt-cached and cited/traced by the verifier.
 *
 * Determinism is load-bearing for prompt caching and the Anthropic API
 * contract: NO Date.now(), NO UUIDs, NO timestamps sourced from the
 * clock, stable key order everywhere. The payload's own `builtAt`-derived asOf
 * dates come from the bundle (fiscal period ends), not from wall-clock reads
 * here. Given identical (bundle, computed, validation) inputs, this module
 * emits byte-identical output and a stable {@link payloadFingerprint}.
 *
 * Provenance is the whole point (the application contract §1 rules #1 and #5): every figure in
 * the serialized payload appears as `value [source · as-of]` so the LLM can
 * cite it and the verification pass can trace it back. This module is the
 * single authority on WHAT the model may see; the prompts (prompts.ts) enforce
 * HOW it must use it.
 *
 * Pure: no network, no DB, no LLM, no clock. Server-safe (imports only Stage A/B
 * types + the report schema types), but importable anywhere since it never
 * touches provider clients.
 */

import type { ManifestEntry } from "@/types/core";
import type { DataBundle } from "@/pipeline/types";
import type { ComputedMetrics } from "@/pipeline/compute";
import type { ValidationReport } from "@/pipeline/stageA/validate";
import type { DegradationPlan } from "@/pipeline/stageB/sectorRouting";
import type { TracedNumber } from "@/report/schema";
import {
  canonicalizeTracedUnit,
  validateCitationRegistry,
  validateProvenanceRegistry,
  type CitationProvenanceRecord,
  type NumericProvenanceRecord,
} from "@/pipeline/stageC/provenance";
import type {
  FmpBalanceSheetRow,
  FmpCashFlowRow,
  FmpIncomeStatementRow,
  FmpRawRow,
} from "@/providers/fmp";

/* ------------------------------------------------------------------------ *
 * Token budgets (char-based approximations — cheap, deterministic).
 *
 * We budget by CHARACTER count, not tokens: a token count would require a
 * model-specific tokenizer (unavailable offline) and would make the payload
 * model-dependent, breaking determinism. ~4 chars/token is the standard rough
 * ratio, so a 60K-char transcript budget ≈ 15K tokens — matching the SPEC's
 * "~15-20k chars" transcript budget. Every truncation is DISCLOSED inline.
 * ------------------------------------------------------------------------ */

export const PAYLOAD_BUDGETS = {
  /** Latest earnings-call transcript text (SPEC §5: ~15-20k chars). */
  transcriptChars: 18_000,
  /** Annual risk-factors excerpt: 10-K Item 1A or 20-F Item 3.D. */
  item1aChars: 14_000,
  /** Annual review excerpt: 10-K Item 7 or 20-F Item 5. */
  mdnaChars: 14_000,
  /** 10-Q Part I Item 2 (MD&A) excerpt. */
  tenQMdnaChars: 8_000,
  /** Free-text news/press snippet total (many small rows). */
  newsChars: 6_000,
  /** Annual statement periods kept in the compact extract (SPEC §5: last 5). */
  annualPeriods: 5,
  /** Quarterly statement periods kept in the compact extract (SPEC §5: last 4). */
  quarterlyPeriods: 4,
  /** Rows kept for list-shaped sources (insiders, holders, peers, estimates). */
  listRows: 12,
} as const;

/** Marker appended when a text field was truncated to its budget. */
export const TRUNCATION_MARKER = "…[TRUNCATED";

/* ------------------------------------------------------------------------ *
 * Payload types
 * ------------------------------------------------------------------------ */

/**
 * A single figure with its provenance. `source` is a payload path or provider
 * tag the verifier can trace (e.g. "computed.growth.revenueCagr5y",
 * "fmp:income-statement", "edgar:10-K item1A", "fred:DGS10"); `asOf` is the ISO
 * date the figure is as-of, or null for a timeless/derived quantity.
 */
export interface PayloadFigure {
  /** Exact registry ID for numeric figures emitted by payload assembly. */
  provenanceId?: string;
  label: string;
  value: number | string | null;
  unit: string;
  source: string;
  asOf: string | null;
}

/** A labelled group of figures rendered as one block in the prompt. */
export interface PayloadSection {
  title: string;
  /** Stable-ordered figures. */
  figures: PayloadFigure[];
  /** Optional free-text notes (methodology/gaps) rendered under the figures. */
  notes: string[];
}

/** A compact statement extract: one line item across periods. */
export interface StatementLineExtract {
  lineItem: string;
  unit: string;
  source: string;
  /** period label (fiscal period end ISO) -> value; null when undisclosed. */
  byPeriod: { period: string; value: number | null; provenanceId?: string }[];
}

export interface StatementExtractBlock {
  title: string;
  /** Fiscal period ends covered (newest first), for the header. */
  periods: string[];
  lineItems: StatementLineExtract[];
  notes: string[];
}

/** A budgeted text excerpt with its provenance and truncation disclosure. */
export interface TextExcerpt {
  title: string;
  text: string;
  source: string;
  asOf: string | null;
  /** True when {@link PAYLOAD_BUDGETS} forced a truncation (disclosed inline). */
  truncated: boolean;
  /** Original character length before truncation (0 when absent). */
  originalChars: number;
}

/**
 * The complete context payload. Field order is fixed and every array is
 * deterministically ordered by the assembler, so `JSON.stringify(payload)` and
 * {@link serializePayloadForPrompt} are byte-stable for identical inputs.
 */
export interface ContextPayload {
  /** Spec-pinned payload format version (bump on shape changes). */
  payloadVersion: string;
  /** Exact numeric evidence available to the deterministic verifier. */
  provenanceRegistry?: NumericProvenanceRecord[];
  /** Exact non-numeric payload source/date tags available for prose claims. */
  citationRegistry?: CitationProvenanceRecord[];
  symbol: string;
  companyName: string | null;
  /** Sector route + overlays (drives which metrics are meaningful). */
  route: {
    base: string;
    overlays: string[];
    sector: string | null;
    industry: string | null;
  };
  /** Quote snapshot (price + as-of) — the anchor for all valuation framing. */
  quote: PayloadSection;
  /** Every Stage B computed metric block, with provenance/as-of. */
  computed: PayloadSection[];
  /** Compact statement extracts (annual + quarterly key line items). */
  statements: StatementExtractBlock[];
  /** Analyst estimates / price-target consensus / grades summary. */
  estimates: PayloadSection;
  /** Peer set (symbol + name + headline size). */
  peers: PayloadSection;
  /** Insider trades + insider statistics + Finnhub MSPR sentiment. */
  insiders: PayloadSection;
  /** 13F institutional positions summary + top holders. */
  institutional: PayloadSection;
  /** Executives + compensation (leadership-grading inputs). */
  leadership: PayloadSection;
  /** Short interest + days-to-cover. */
  shortInterest: PayloadSection;
  /** Segmentation (product + geographic), as-reported free-text keys. */
  segments: PayloadSection;
  /** Macro series latest values (core + sector-mapped). */
  macro: PayloadSection;
  /** Latest earnings-call transcript (budgeted). */
  transcript: TextExcerpt | null;
  /** Annual risk/review + 10-Q MD&A excerpts (budgeted). */
  filings: TextExcerpt[];
  /** Recent news / press-release snippets (budgeted, for catalyst context). */
  news: PayloadSection;
  /** Stage A validation checks that failed or were skipped (data-quality signal). */
  validationFlags: string[];
  /** The missing-data manifest — gaps are DISCLOSED, never filled (rule #4). */
  missingData: ManifestEntry[];
  /** Provider provenance for the appendix (dot-path -> as-of). */
  asOfMap: Record<string, string>;
}

/** Current payload format version. */
export const PAYLOAD_VERSION = "1.2.0" as const;

/* ------------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------------ */

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function numOrNull(v: unknown): number | null {
  return isNum(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isoDay(v: unknown): string | null {
  const s = strOrNull(v);
  return s ? s.slice(0, 10) : null;
}

/** Round a number to at most `dp` decimals without trailing-zero noise. */
function round(v: number, dp = 4): number {
  return Number(v.toFixed(dp));
}

/**
 * Truncate `text` to `maxChars`, appending a disclosure marker that states how
 * many characters were dropped. Deterministic — no clock, no randomness.
 */
export function truncateWithDisclosure(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; originalChars: number } {
  const originalChars = text.length;
  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars };
  }
  const dropped = originalChars - maxChars;
  const marker = `\n\n${TRUNCATION_MARKER} ${dropped} of ${originalChars} chars omitted to fit the payload budget]`;
  // Reserve room for the marker so the total stays within budget.
  const keep = Math.max(0, maxChars - marker.length);
  return { text: text.slice(0, keep) + marker, truncated: true, originalChars };
}

/** Render a figure's provenance tag: "[source · as-of]" or "[source]". */
export function provenanceTag(source: string, asOf: string | null): string {
  return asOf ? `[${source} · ${asOf}]` : `[${source}]`;
}

/**
 * Render one figure as `label: value unit [source · as-of]`. Null values are
 * rendered as `n/a` (a disclosed gap, not an omission) so the model never sees
 * a fabricated number in place of a real absence.
 */
export function formatFigure(f: PayloadFigure): string {
  const val =
    f.value === null
      ? "n/a"
      : typeof f.value === "number"
        ? String(round(f.value))
        : f.value;
  const unit = f.unit && f.value !== null ? ` ${f.unit}` : "";
  return `${f.label}: ${val}${unit} ${provenanceTag(f.provenanceId ?? f.source, f.asOf)}`;
}

/* ------------------------------------------------------------------------ *
 * Bundle unwrap helpers (every bundle member is a FetchResult<...>)
 * ------------------------------------------------------------------------ */

function rowsOf<TRow extends FmpRawRow>(f: {
  ok: boolean;
  value?: { data: { rows: TRow[] } };
}): TRow[] {
  return f.ok && f.value ? f.value.data.rows : [];
}

function firstRow<TRow extends FmpRawRow>(f: {
  ok: boolean;
  value?: { data: { rows: TRow[] } };
}): TRow | null {
  const rows = rowsOf(f);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------------ *
 * Section builders — each returns a deterministically ordered PayloadSection.
 * ------------------------------------------------------------------------ */

function quoteSection(bundle: DataBundle): PayloadSection {
  const q = firstRow(bundle.quote);
  const asOf = bundle.quote.ok ? bundle.quote.value.asOf : null;
  const figures: PayloadFigure[] = [
    { label: "price", value: numOrNull(q?.price), unit: "currency/share", source: "fmp:quote", asOf },
    { label: "marketCap", value: numOrNull(q?.marketCap), unit: "currency", source: "fmp:quote", asOf },
    { label: "dayLow", value: numOrNull(q?.dayLow), unit: "currency/share", source: "fmp:quote", asOf },
    { label: "dayHigh", value: numOrNull(q?.dayHigh), unit: "currency/share", source: "fmp:quote", asOf },
    { label: "yearLow", value: numOrNull(q?.yearLow), unit: "currency/share", source: "fmp:quote", asOf },
    { label: "yearHigh", value: numOrNull(q?.yearHigh), unit: "currency/share", source: "fmp:quote", asOf },
    { label: "volume", value: numOrNull(q?.volume), unit: "shares", source: "fmp:quote", asOf },
  ];
  return { title: "Quote", figures, notes: [] };
}

/** Stage B computed-metrics sections — the analytical spine of the payload. */
function computedSections(computed: ComputedMetrics): PayloadSection[] {
  const sections: PayloadSection[] = [];
  const g = computed.growth;
  const gAsOf = g.asOf;

  // --- Growth --------------------------------------------------------------
  const growthFigures: PayloadFigure[] = [];
  for (const c of g.revenueCagrs) {
    growthFigures.push({
      label: `revenue CAGR ${c.windowYears}y`,
      value: c.cagrPct,
      unit: "%",
      source: "computed.growth.revenueCagrs",
      asOf: c.endDate,
    });
  }
  for (const c of g.epsDilutedCagrs) {
    growthFigures.push({
      label: `diluted EPS CAGR ${c.windowYears}y`,
      value: c.cagrPct,
      unit: "%",
      source: "computed.growth.epsDilutedCagrs",
      asOf: c.endDate,
    });
  }
  for (const c of g.fcfCagrs) {
    growthFigures.push({
      label: `FCF CAGR ${c.windowYears}y`,
      value: c.cagrPct,
      unit: "%",
      source: "computed.growth.fcfCagrs",
      asOf: c.endDate,
    });
  }
  growthFigures.push(
    { label: "gross margin slope", value: g.margins.gross.slopePctPtsPerYear, unit: "pp/yr", source: "computed.growth.margins.gross", asOf: gAsOf },
    { label: "operating margin slope", value: g.margins.operating.slopePctPtsPerYear, unit: "pp/yr", source: "computed.growth.margins.operating", asOf: gAsOf },
    { label: "net margin slope", value: g.margins.net.slopePctPtsPerYear, unit: "pp/yr", source: "computed.growth.margins.net", asOf: gAsOf },
    { label: "latest revenue YoY", value: g.revenueAcceleration.latestYoyPct, unit: "%", source: "computed.growth.revenueAcceleration", asOf: gAsOf },
    { label: "revenue accel (YoY − 3y CAGR)", value: g.revenueAcceleration.deltaPctPts, unit: "pp", source: "computed.growth.revenueAcceleration", asOf: gAsOf },
  );
  // Latest margin levels (newest point of each series).
  const lastGross = g.margins.gross.series.at(-1);
  const lastOper = g.margins.operating.series.at(-1);
  const lastNet = g.margins.net.series.at(-1);
  if (lastGross) growthFigures.push({ label: "gross margin (latest)", value: lastGross.pct, unit: "%", source: "computed.growth.margins.gross", asOf: lastGross.date });
  if (lastOper) growthFigures.push({ label: "operating margin (latest)", value: lastOper.pct, unit: "%", source: "computed.growth.margins.operating", asOf: lastOper.date });
  if (lastNet) growthFigures.push({ label: "net margin (latest)", value: lastNet.pct, unit: "%", source: "computed.growth.margins.net", asOf: lastNet.date });
  sections.push({ title: "Growth & margins (computed)", figures: growthFigures, notes: g.notes });

  // --- Returns (WACC / ROIC / DuPont) --------------------------------------
  const r = computed.returns;
  const returnsFigures: PayloadFigure[] = [
    { label: "WACC", value: r.wacc.waccPct, unit: "%", source: "computed.returns.wacc", asOf: r.wacc.asOf?.statements ?? null },
    { label: "cost of equity", value: r.wacc.costOfEquityPct, unit: "%", source: "computed.returns.wacc.costOfEquity", asOf: r.wacc.asOf?.riskFreeRate ?? null },
    { label: "cost of debt (pre-tax)", value: r.wacc.costOfDebtPct, unit: "%", source: `computed.returns.wacc.costOfDebt(${r.wacc.costOfDebtMethod})`, asOf: r.wacc.asOf?.statements ?? null },
    { label: "risk-free rate", value: r.wacc.riskFreePct, unit: "%", source: "computed.returns.wacc.riskFree(fred:DGS10)", asOf: r.wacc.asOf?.riskFreeRate ?? null },
    { label: "ERP used", value: r.wacc.erpPct, unit: "%", source: "computed.returns.wacc.erp", asOf: null },
    { label: "beta (final)", value: r.wacc.betaFinal, unit: "x", source: "computed.returns.wacc.beta", asOf: null },
    { label: "ROIC (latest)", value: r.roic.latestRoicPct, unit: "%", source: "computed.returns.roic", asOf: r.roic.asOf },
    { label: "ROE (latest, DuPont)", value: r.dupont.latest?.roePct ?? null, unit: "%", source: "computed.returns.dupont", asOf: r.dupont.asOf },
    { label: "ROIC − WACC spread", value: r.roicVsWacc.spreadPctPts, unit: "pp", source: "computed.returns.roicVsWacc", asOf: r.roic.asOf },
  ];
  // clampsApplied is folded into the section notes so a bound WACC/beta/tax is
  // visible to the model (audit 2026-07-11 #5); material clamps ALSO surface as
  // manifest gaps (returns.ts), but immaterial ones would otherwise have no
  // consumer at all.
  sections.push({
    title: "Returns (computed)",
    figures: returnsFigures,
    notes: [...r.wacc.notes, ...r.wacc.clampsApplied, ...r.notes],
  });

  // --- Capital -------------------------------------------------------------
  const cap = computed.capital;
  const capFigures: PayloadFigure[] = [
    { label: "latest FCF", value: cap.fcf.latestFcf, unit: "currency", source: "computed.capital.fcf", asOf: cap.asOf },
    { label: "FCF conversion (latest)", value: cap.fcf.latestConversion, unit: "x", source: "computed.capital.fcf.conversion", asOf: cap.asOf },
    { label: "capex/revenue (latest)", value: cap.capexIntensity.latestPct, unit: "%", source: "computed.capital.capexIntensity", asOf: cap.asOf },
    { label: "capex/revenue slope", value: cap.capexIntensity.slopePctPtsPerYear, unit: "pp/yr", source: "computed.capital.capexIntensity", asOf: cap.asOf },
    { label: "capex/D&A (latest)", value: cap.maintenanceVsGrowthCapex.capexToDALatest, unit: "x", source: "computed.capital.maintenanceVsGrowthCapex", asOf: cap.asOf },
    { label: "net debt/EBITDA", value: cap.netDebtToEbitda.value, unit: "x", source: "computed.capital.netDebtToEbitda", asOf: cap.netDebtToEbitda.asOf },
    { label: "interest coverage", value: cap.interestCoverage.value, unit: "x", source: "computed.capital.interestCoverage", asOf: cap.asOf },
    { label: "SBC % revenue", value: cap.sbc.pctOfRevenue, unit: "%", source: "computed.capital.sbc", asOf: cap.asOf },
    { label: "SBC % FCF", value: cap.sbc.pctOfFcf, unit: "%", source: "computed.capital.sbc", asOf: cap.asOf },
    { label: "diluted share count trend (5y)", value: cap.shareCount.trendPct, unit: "%", source: "computed.capital.shareCount", asOf: cap.shareCount.endDate },
    { label: "buyback price vs current", value: cap.buybackPriceAnalysis.premiumDiscountPct, unit: "%", source: "computed.capital.buybackPriceAnalysis", asOf: cap.asOf },
  ];
  sections.push({ title: "Capital & cash (computed)", figures: capFigures, notes: cap.notes });

  // --- Forensics -----------------------------------------------------------
  const fx = computed.forensics;
  const forensicFigures: PayloadFigure[] = [
    { label: `Altman ${fx.altman?.variant ?? "Z"}`, value: fx.altman?.score ?? null, unit: "score", source: "computed.forensics.altman", asOf: fx.altman?.asOf.balanceSheet ?? null },
    { label: "Altman zone", value: fx.altman?.zone ?? null, unit: "", source: "computed.forensics.altman.zone", asOf: fx.altman?.asOf.balanceSheet ?? null },
    { label: "Beneish M", value: fx.beneish?.score ?? null, unit: "score", source: "computed.forensics.beneish", asOf: fx.beneish?.asOf.current ?? null },
    { label: "Beneish verdict", value: fx.beneish?.verdict ?? null, unit: "", source: "computed.forensics.beneish.verdict", asOf: fx.beneish?.asOf.current ?? null },
    { label: `Piotroski F (/${fx.piotroski?.outOf ?? 9})`, value: fx.piotroski?.score ?? null, unit: "score", source: "computed.forensics.piotroski", asOf: fx.piotroski?.asOf.current ?? null },
    { label: "accrual ratio (cash-flow)", value: fx.accruals?.cashFlowAccrualRatio ?? null, unit: "x", source: "computed.forensics.accruals", asOf: fx.accruals?.asOf.current ?? null },
    { label: "accrual band", value: fx.accruals?.band ?? null, unit: "", source: "computed.forensics.accruals.band", asOf: fx.accruals?.asOf.current ?? null },
  ];
  const forensicNotes = [...fx.notes];
  for (const flag of fx.flags) {
    forensicNotes.push(`FLAG [${flag.severity}] ${flag.message} (rule: ${flag.rule})`);
  }
  sections.push({ title: "Forensics (computed)", figures: forensicFigures, notes: forensicNotes });

  // --- Technicals ----------------------------------------------------------
  const t = computed.technicals;
  const techFigures: PayloadFigure[] = [
    { label: "last close", value: t.lastClose, unit: "currency/share", source: "computed.technicals", asOf: t.asOf },
    { label: "SMA50", value: t.smaCross.sma50, unit: "currency/share", source: "computed.technicals.smaCross", asOf: t.asOf },
    { label: "SMA200", value: t.smaCross.sma200, unit: "currency/share", source: "computed.technicals.smaCross", asOf: t.asOf },
    { label: "RSI-14", value: t.rsi14, unit: "", source: "computed.technicals.rsi14", asOf: t.asOf },
    { label: "MACD histogram", value: t.macd.histogram, unit: "", source: "computed.technicals.macd", asOf: t.asOf },
    { label: "52w high", value: t.range52w.high52w, unit: "currency/share", source: "computed.technicals.range52w", asOf: t.asOf },
    { label: "52w low", value: t.range52w.low52w, unit: "currency/share", source: "computed.technicals.range52w", asOf: t.asOf },
    { label: "% from 52w high", value: t.range52w.pctFromHigh, unit: "%", source: "computed.technicals.range52w", asOf: t.asOf },
    { label: "trend read", value: t.read.trend, unit: "", source: "computed.technicals.read", asOf: t.asOf },
    { label: "momentum read", value: t.read.momentum, unit: "", source: "computed.technicals.read", asOf: t.asOf },
  ];
  sections.push({ title: "Technicals (computed)", figures: techFigures, notes: t.notes });

  // --- Valuation -----------------------------------------------------------
  const val = computed.valuation;
  const valFigures: PayloadFigure[] = [{ label: "valuation model", value: val.kind, unit: "", source: "computed.valuation.kind", asOf: null }];
  if (val.kind === "dcf") {
    valFigures.push(
      { label: "DCF per share", value: val.dcf?.perShare ?? null, unit: "currency/share", source: "computed.valuation.dcf", asOf: null },
      { label: "DCF terminal value share", value: val.dcf?.terminalShare ?? null, unit: "fraction", source: "computed.valuation.dcf.terminalShare", asOf: null },
      { label: "reverse-DCF implied revenue growth", value: val.reverseDcf?.impliedRevenueGrowthPct ?? null, unit: "%", source: "computed.valuation.reverseDcf", asOf: null },
      { label: "reverse-DCF implied terminal margin", value: val.reverseDcf?.impliedTerminalMarginPct ?? null, unit: "%", source: "computed.valuation.reverseDcf", asOf: null },
    );
  } else if (val.kind === "excess-return") {
    valFigures.push({ label: "excess-return per share", value: val.excessReturn.perShare ?? null, unit: "currency/share", source: "computed.valuation.excessReturn", asOf: null });
  } else if (val.kind === "reit") {
    valFigures.push(
      { label: "REIT P/FFO", value: val.reit.pToFfo ?? null, unit: "x", source: "computed.valuation.reit", asOf: val.reit.asOf },
      { label: "REIT P/AFFO", value: val.reit.pToAffo ?? null, unit: "x", source: "computed.valuation.reit", asOf: val.reit.asOf },
    );
  }
  for (const m of val.kind === "pre-revenue" ? [] : val.multiples.multiples) {
    valFigures.push({
      label: `${m.key} (current)`,
      value: m.current,
      unit: "x",
      source: `computed.valuation.multiples.${m.key}`,
      asOf: val.kind === "pre-revenue" ? null : val.multiples.asOf.quote,
    });
    if (m.peers) {
      valFigures.push({
        label: `${m.key} peer median`,
        value: m.peers.median,
        unit: "x",
        source: `computed.valuation.multiples.${m.key}.peers`,
        asOf: null,
      });
    }
  }
  sections.push({ title: "Valuation (computed)", figures: valFigures, notes: val.notes });

  // --- Deterministic aspect scores (feature 1.1.0) -------------------------
  if (computed.scores) {
    const sc = computed.scores;
    const scoreFigures: PayloadFigure[] = [
      { label: "COMPOSITE score", value: sc.composite.score, unit: "0-100", source: "computed.scores.composite", asOf: null },
      { label: "COMPOSITE grade", value: sc.composite.band, unit: "", source: "computed.scores.composite", asOf: null },
    ];
    for (const key of Object.keys(sc.aspects) as (keyof typeof sc.aspects)[]) {
      const a = sc.aspects[key];
      scoreFigures.push({
        label: `${key} score`,
        value: a.score,
        unit: `0-100 (grade ${a.band ?? "n/a"}, completeness ${a.dataCompleteness})`,
        source: `computed.scores.${key}`,
        asOf: null,
      });
    }
    sections.push({
      title: "Deterministic aspect scores (computed — ANCHOR your A–F letter grades to these bands; justify any deviation)",
      figures: scoreFigures,
      notes: [sc.composite.methodology, `band table: ${sc.bandsVersion}`],
    });
  }

  // --- Weighted projections (feature 1.1.0) --------------------------------
  if (computed.projections && computed.projections.series.length > 0) {
    const pr = computed.projections;
    const projFigures: PayloadFigure[] = [];
    for (const s of pr.series) {
      const w = s.weighted;
      const bull = s.bull;
      const bear = s.bear;
      const at = (arr: typeof w, i: number) => arr[i];
      const y5 = w.length - 1;
      const idxs = [0, Math.min(2, y5), y5];
      for (const i of idxs) {
        const pt = at(w, i);
        if (pt) projFigures.push({ label: `${s.metric} weighted ${pt.period}`, value: pt.value.value, unit: s.unit, source: `computed.projections.${s.metric}.weighted`, asOf: null });
      }
      const b5 = at(bull, y5);
      const be5 = at(bear, y5);
      if (b5) projFigures.push({ label: `${s.metric} bull ${b5.period}`, value: b5.value.value, unit: s.unit, source: `computed.projections.${s.metric}.bull`, asOf: null });
      if (be5) projFigures.push({ label: `${s.metric} bear ${be5.period}`, value: be5.value.value, unit: s.unit, source: `computed.projections.${s.metric}.bear`, asOf: null });
    }
    sections.push({
      title: `Weighted projections (computed — ${pr.horizonYears}y forward, prob-weighted ${pr.scenarioWeights.bull}/${pr.scenarioWeights.base}/${pr.scenarioWeights.bear} bull/base/bear; ESTIMATE, interpret — never restate as fact)`,
      figures: projFigures,
      notes: pr.series[0]?.assumptions ?? [],
    });
  } else if (computed.projections && computed.projections.notApplicableReason) {
    sections.push({
      title: "Weighted projections (computed)",
      figures: [],
      notes: [`not applicable: ${computed.projections.notApplicableReason}`],
    });
  }

  // --- Runway (overlay-gated) ----------------------------------------------
  if (computed.runway) {
    const rw = computed.runway;
    sections.push({
      title: "Runway (computed — pre-revenue/unprofitable overlay)",
      figures: [
        { label: "avg quarterly burn", value: rw.avgQuarterlyBurn, unit: "currency", source: "computed.runway", asOf: rw.liquidAssetsAsOf },
        { label: "liquid assets", value: rw.liquidAssets, unit: "currency", source: "computed.runway.liquidAssets", asOf: rw.liquidAssetsAsOf },
        { label: "runway (quarters)", value: rw.runwayQuarters, unit: "quarters", source: "computed.runway", asOf: rw.liquidAssetsAsOf },
        { label: "estimated exhaustion date", value: rw.estimatedExhaustionDate, unit: "", source: "computed.runway", asOf: rw.liquidAssetsAsOf },
      ],
      notes: rw.notes,
    });
  }

  // --- Suppressed metrics (disclose why a figure is absent) ----------------
  if (computed.suppressed.length > 0) {
    sections.push({
      title: "Suppressed metrics (sector policy)",
      figures: computed.suppressed.map((s) => ({
        label: s.key,
        value: "suppressed",
        unit: "",
        source: "computed.suppressed",
        asOf: null,
      })),
      notes: computed.suppressed.map((s) => `${s.key}: ${s.reason}`),
    });
  }

  return sections;
}

/* ------------------------------------------------------------------------ *
 * Statement extracts — compact (last N annual + M quarterly key line items)
 * ------------------------------------------------------------------------ */

/** Key income-statement line items kept in the compact extract. */
const INCOME_LINE_ITEMS: { key: keyof FmpIncomeStatementRow; label: string; unit: string }[] = [
  { key: "revenue", label: "revenue", unit: "currency" },
  { key: "grossProfit", label: "gross profit", unit: "currency" },
  { key: "operatingIncome", label: "operating income", unit: "currency" },
  { key: "ebit", label: "EBIT", unit: "currency" },
  { key: "netIncome", label: "net income", unit: "currency" },
  { key: "epsDiluted", label: "diluted EPS", unit: "currency/share" },
  { key: "weightedAverageShsOutDil", label: "diluted shares", unit: "shares" },
  { key: "interestExpense", label: "interest expense", unit: "currency" },
];

const BALANCE_LINE_ITEMS: { key: keyof FmpBalanceSheetRow; label: string; unit: string }[] = [
  { key: "totalAssets", label: "total assets", unit: "currency" },
  { key: "totalLiabilities", label: "total liabilities", unit: "currency" },
  { key: "totalStockholdersEquity", label: "stockholders equity", unit: "currency" },
  { key: "totalDebt", label: "total debt", unit: "currency" },
  { key: "netDebt", label: "net debt", unit: "currency" },
  { key: "cashAndShortTermInvestments", label: "cash + STI", unit: "currency" },
];

const CASHFLOW_LINE_ITEMS: { key: keyof FmpCashFlowRow; label: string; unit: string }[] = [
  { key: "operatingCashFlow", label: "operating cash flow", unit: "currency" },
  { key: "capitalExpenditure", label: "capex (negative)", unit: "currency" },
  { key: "freeCashFlow", label: "free cash flow", unit: "currency" },
  { key: "stockBasedCompensation", label: "stock-based comp", unit: "currency" },
  { key: "commonStockRepurchased", label: "buybacks (negative)", unit: "currency" },
];

function extractStatement<TRow extends FmpRawRow>(
  title: string,
  rows: TRow[],
  periods: number,
  lineItems: { key: keyof TRow; label: string; unit: string }[],
  source: string,
): StatementExtractBlock | null {
  const kept = rows.slice(0, periods);
  if (kept.length === 0) return null;
  const periodLabels = kept.map((r) => isoDay(r.date) ?? "unknown");
  const lines: StatementLineExtract[] = lineItems.map((li) => ({
    lineItem: li.label,
    unit: li.unit,
    source,
    byPeriod: kept.map((r, i) => ({
      period: periodLabels[i],
      value: numOrNull(r[li.key]),
    })),
  }));
  return { title, periods: periodLabels, lineItems: lines, notes: [] };
}

function statementExtracts(bundle: DataBundle): StatementExtractBlock[] {
  const blocks: StatementExtractBlock[] = [];
  const A = PAYLOAD_BUDGETS.annualPeriods;
  const Q = PAYLOAD_BUDGETS.quarterlyPeriods;
  const push = (b: StatementExtractBlock | null): void => {
    if (b) blocks.push(b);
  };
  push(extractStatement("Income statement — annual", rowsOf(bundle.statements.incomeAnnual), A, INCOME_LINE_ITEMS, "fmp:income-statement(annual)"));
  push(extractStatement("Income statement — quarterly", rowsOf(bundle.statements.incomeQuarterly), Q, INCOME_LINE_ITEMS, "fmp:income-statement(quarter)"));
  push(extractStatement("Balance sheet — annual", rowsOf(bundle.statements.balanceAnnual), A, BALANCE_LINE_ITEMS, "fmp:balance-sheet(annual)"));
  push(extractStatement("Balance sheet — quarterly", rowsOf(bundle.statements.balanceQuarterly), Q, BALANCE_LINE_ITEMS, "fmp:balance-sheet(quarter)"));
  push(extractStatement("Cash flow — annual", rowsOf(bundle.statements.cashflowAnnual), A, CASHFLOW_LINE_ITEMS, "fmp:cash-flow(annual)"));
  push(extractStatement("Cash flow — quarterly", rowsOf(bundle.statements.cashflowQuarterly), Q, CASHFLOW_LINE_ITEMS, "fmp:cash-flow(quarter)"));
  return blocks;
}

/* ------------------------------------------------------------------------ *
 * List-shaped sections (estimates, peers, insiders, holders, executives, …)
 * ------------------------------------------------------------------------ */

function estimatesSection(bundle: DataBundle): PayloadSection {
  const figures: PayloadFigure[] = [];
  const notes: string[] = [];
  const estAsOf = bundle.analystEstimates.ok ? bundle.analystEstimates.value.asOf : null;
  const est = rowsOf(bundle.analystEstimates).slice(0, PAYLOAD_BUDGETS.listRows);
  for (const e of est) {
    const period = isoDay(e.date) ?? "unknown";
    figures.push(
      { label: `est revenue ${period}`, value: numOrNull(e.revenueAvg), unit: "currency", source: "fmp:analyst-estimates", asOf: period },
      { label: `est EPS ${period}`, value: numOrNull(e.epsAvg), unit: "currency/share", source: "fmp:analyst-estimates", asOf: period },
    );
  }
  const ptc = firstRow(bundle.priceTargetConsensus);
  const ptcAsOf = bundle.priceTargetConsensus.ok ? bundle.priceTargetConsensus.value.asOf : null;
  if (ptc) {
    figures.push(
      { label: "price target consensus", value: numOrNull(ptc.targetConsensus), unit: "currency/share", source: "fmp:price-target-consensus", asOf: ptcAsOf },
      { label: "price target high", value: numOrNull(ptc.targetHigh), unit: "currency/share", source: "fmp:price-target-consensus", asOf: ptcAsOf },
      { label: "price target low", value: numOrNull(ptc.targetLow), unit: "currency/share", source: "fmp:price-target-consensus", asOf: ptcAsOf },
    );
  }
  const grades = firstRow(bundle.gradesConsensus);
  if (grades) {
    notes.push(
      `analyst grades consensus string (NOT a rating we adopt): ${strOrNull(grades.consensus) ?? "n/a"} ` +
        `(strongBuy ${numOrNull(grades.strongBuy) ?? "n/a"}, buy ${numOrNull(grades.buy) ?? "n/a"}, hold ${numOrNull(grades.hold) ?? "n/a"}, sell ${numOrNull(grades.sell) ?? "n/a"}, strongSell ${numOrNull(grades.strongSell) ?? "n/a"})`,
    );
  }
  void estAsOf;
  return { title: "Analyst estimates & targets", figures, notes };
}

function peersSection(bundle: DataBundle): PayloadSection {
  const peers = rowsOf(bundle.peers).slice(0, PAYLOAD_BUDGETS.listRows);
  const asOf = bundle.peers.ok ? bundle.peers.value.asOf : null;
  const figures: PayloadFigure[] = peers.map((p) => ({
    label: `${strOrNull(p.symbol) ?? "?"} — ${strOrNull(p.companyName) ?? "?"}`,
    value: numOrNull(p.mktCap),
    unit: "currency mkt cap",
    source: "fmp:stock-peers",
    asOf,
  }));
  return { title: "Peers", figures, notes: [] };
}

function insidersSection(bundle: DataBundle): PayloadSection {
  const figures: PayloadFigure[] = [];
  const notes: string[] = [];
  const stats = firstRow(bundle.insiderStats);
  const statsAsOf = bundle.insiderStats.ok ? bundle.insiderStats.value.asOf : null;
  if (stats) {
    figures.push(
      { label: "insider total purchases", value: numOrNull(stats.totalPurchases), unit: "shares", source: "fmp:insider-statistics", asOf: statsAsOf },
      { label: "insider total sales", value: numOrNull(stats.totalSales), unit: "shares", source: "fmp:insider-statistics", asOf: statsAsOf },
      { label: "acquired/disposed ratio", value: numOrNull(stats.acquiredDisposedRatio), unit: "x", source: "fmp:insider-statistics", asOf: statsAsOf },
    );
  }
  const trades = rowsOf(bundle.insiderTrades).slice(0, PAYLOAD_BUDGETS.listRows);
  for (const tr of trades) {
    const d = isoDay(tr.transactionDate) ?? isoDay(tr.filingDate) ?? "unknown";
    notes.push(
      `${d} ${strOrNull(tr.reportingName) ?? "?"} (${strOrNull(tr.typeOfOwner) ?? "?"}): ` +
        `${strOrNull(tr.transactionType) ?? "?"} ${numOrNull(tr.securitiesTransacted) ?? "?"} @ ${numOrNull(tr.price) ?? "?"} [fmp:insider-trades · ${d}]`,
    );
  }
  // Finnhub MSPR insider sentiment.
  if (bundle.insiderSentiment.ok) {
    const months = bundle.insiderSentiment.value.data.slice(-6);
    for (const m of months) {
      figures.push({
        label: `MSPR ${m.year}-${String(m.month).padStart(2, "0")}`,
        value: m.mspr,
        unit: "",
        source: "finnhub:insider-sentiment",
        asOf: `${m.year}-${String(m.month).padStart(2, "0")}`,
      });
    }
  }
  return { title: "Insider activity & sentiment", figures, notes };
}

function institutionalSection(bundle: DataBundle): PayloadSection {
  const inst = bundle.institutional;
  const figures: PayloadFigure[] = [];
  const summary = firstRow(inst.positionsSummary);
  if (summary) {
    figures.push(
      { label: "investors holding", value: numOrNull(summary.investorsHolding), unit: "count", source: "fmp:13f-positions-summary", asOf: inst.quarterEnd },
      { label: "ownership %", value: numOrNull(summary.ownershipPercent), unit: "%", source: "fmp:13f-positions-summary", asOf: inst.quarterEnd },
      { label: "new positions", value: numOrNull(summary.newPositions), unit: "count", source: "fmp:13f-positions-summary", asOf: inst.quarterEnd },
      { label: "closed positions", value: numOrNull(summary.closedPositions), unit: "count", source: "fmp:13f-positions-summary", asOf: inst.quarterEnd },
      { label: "put/call ratio", value: numOrNull(summary.putCallRatio), unit: "x", source: "fmp:13f-positions-summary", asOf: inst.quarterEnd },
    );
  }
  const holders = rowsOf(inst.topHolders).slice(0, PAYLOAD_BUDGETS.listRows);
  for (const h of holders) {
    figures.push({
      label: `holder ${strOrNull(h.investorName) ?? "?"}`,
      value: numOrNull(h.sharesNumber),
      unit: "shares",
      source: "fmp:13f-holders",
      asOf: inst.quarterEnd,
    });
  }
  return {
    title: `Institutional (13F ${inst.year} Q${inst.quarter}, quarter end ${inst.quarterEnd})`,
    figures,
    notes: [`13F data inherently lags the covered quarter by up to 45 days — label with the reporting quarter end ${inst.quarterEnd}, not the fetch date.`],
  };
}

function leadershipSection(bundle: DataBundle): PayloadSection {
  const figures: PayloadFigure[] = [];
  const notes: string[] = [];
  const execAsOf = bundle.executives.ok ? bundle.executives.value.asOf : null;
  const execs = rowsOf(bundle.executives).slice(0, PAYLOAD_BUDGETS.listRows);
  for (const e of execs) {
    notes.push(
      `${strOrNull(e.name) ?? "?"} — ${strOrNull(e.title) ?? "?"}` +
        `${e.titleSince ? ` (since ${isoDay(e.titleSince)})` : ""}` +
        `${isNum(e.pay) ? `, pay ${e.pay} ${strOrNull(e.currencyPay) ?? ""}` : ""} [fmp:key-executives]`,
    );
  }
  const comp = rowsOf(bundle.compensation).slice(0, PAYLOAD_BUDGETS.listRows);
  for (const c of comp) {
    figures.push({
      label: `comp ${strOrNull(c.nameAndPosition) ?? "?"} FY${numOrNull(c.year) ?? "?"}`,
      value: numOrNull(c.total),
      unit: "currency",
      source: "fmp:executive-compensation",
      asOf: isoDay(c.filingDate),
    });
  }
  void execAsOf;
  return { title: "Leadership & compensation", figures, notes };
}

function shortInterestSection(bundle: DataBundle): PayloadSection {
  const figures: PayloadFigure[] = [];
  if (bundle.shortInterest.ok) {
    const si = bundle.shortInterest.value.data;
    figures.push(
      { label: "short position", value: numOrNull(si.currentShortPositionQuantity), unit: "shares", source: "finra:short-interest", asOf: si.settlementDate },
      { label: "days to cover", value: si.daysToCoverQuantity, unit: "days", source: "finra:short-interest", asOf: si.settlementDate },
      { label: "avg daily volume", value: si.averageDailyVolumeQuantity, unit: "shares", source: "finra:short-interest", asOf: si.settlementDate },
    );
  }
  return { title: "Short interest", figures, notes: [] };
}

function segmentsSection(bundle: DataBundle): PayloadSection {
  const figures: PayloadFigure[] = [];
  const build = (
    res: DataBundle["segmentation"]["product"],
    kind: string,
  ): void => {
    const latest = firstRow(res);
    const asOf = isoDay(latest?.date);
    const data = latest?.data;
    if (data && typeof data === "object") {
      // Deterministic ordering: sort segment keys alphabetically.
      for (const key of Object.keys(data).sort()) {
        figures.push({
          label: `${kind}: ${key}`,
          value: numOrNull(data[key]),
          unit: "currency",
          source: `fmp:revenue-${kind}-segmentation`,
          asOf,
        });
      }
    }
  };
  build(bundle.segmentation.product, "product");
  build(bundle.segmentation.geographic, "geographic");
  return {
    title: "Revenue segmentation (as-reported keys — never hard-coded)",
    figures,
    notes: [],
  };
}

function macroSection(bundle: DataBundle): PayloadSection {
  const figures: PayloadFigure[] = [];
  const emit = (record: Record<string, { ok: boolean; value?: { data: unknown } }>, tag: string): void => {
    // Deterministic ordering: sort series ids.
    for (const seriesId of Object.keys(record).sort()) {
      const res = record[seriesId];
      if (res.ok && res.value) {
        const obs = res.value.data as { date: string; value: number }[];
        const last = obs[obs.length - 1];
        if (last) {
          figures.push({
            label: `${seriesId}${tag}`,
            value: numOrNull(last.value),
            unit: "",
            source: `fred:${seriesId}`,
            asOf: last.date,
          });
        }
      }
    }
  };
  emit(bundle.macro.core as Record<string, { ok: boolean; value?: { data: unknown } }>, " (core)");
  emit(bundle.macro.sector as Record<string, { ok: boolean; value?: { data: unknown } }>, " (sector)");
  return {
    title: "Macro (FRED latest values)",
    figures,
    notes: [bundle.macro.attribution],
  };
}

function newsSection(bundle: DataBundle): PayloadSection {
  const figures: PayloadFigure[] = [];
  const notes: string[] = [];
  let used = 0;
  const budget = PAYLOAD_BUDGETS.newsChars;
  const addRows = (rows: FmpRawRow[], tag: string): void => {
    for (const r of rows) {
      if (used >= budget) break;
      const d = isoDay(r.publishedDate) ?? "unknown";
      const title = strOrNull(r.title) ?? "";
      const text = strOrNull(r.text) ?? "";
      const line = `${d} [${tag}] ${strOrNull(r.publisher) ?? "?"}: ${title}${text ? ` — ${text}` : ""}`;
      const clipped = line.length + used > budget ? line.slice(0, Math.max(0, budget - used)) : line;
      notes.push(`${clipped} [fmp:${tag} · ${d}]`);
      used += clipped.length;
    }
  };
  addRows(rowsOf(bundle.news).slice(0, PAYLOAD_BUDGETS.listRows), "news");
  addRows(rowsOf(bundle.pressReleases).slice(0, PAYLOAD_BUDGETS.listRows), "press-release");
  return { title: "Recent news & press releases (snippets)", figures, notes };
}

/* ------------------------------------------------------------------------ *
 * Text excerpts (transcript + filings) — budgeted with disclosure
 * ------------------------------------------------------------------------ */

function transcriptExcerpt(bundle: DataBundle): TextExcerpt | null {
  const t = firstRow(bundle.transcript.latest);
  const content = strOrNull(t?.content);
  if (!content) return null;
  const asOf = isoDay(t?.date);
  const cut = truncateWithDisclosure(content, PAYLOAD_BUDGETS.transcriptChars);
  const period = strOrNull(t?.period);
  const year = numOrNull(t?.year);
  return {
    title: `Latest earnings-call transcript${period ? ` (${period}${year ? ` FY${year}` : ""})` : ""}`,
    text: cut.text,
    source: "fmp:earning-call-transcript",
    asOf,
    truncated: cut.truncated,
    originalChars: cut.originalChars,
  };
}

function filingExcerpts(bundle: DataBundle): TextExcerpt[] {
  const out: TextExcerpt[] = [];
  const add = (
    res: { ok: boolean; value?: { data: { text: string; reportDate: string; form: string; accession: string; marker?: string } } },
    title: (form: string) => string,
    budget: number,
    source: (form: string) => string,
  ): void => {
    if (!res.ok || !res.value) return;
    const sec = res.value.data;
    const cut = truncateWithDisclosure(sec.text, budget);
    const markerNote = sec.marker === "unchanged_from_10k" ? " [10-Q Item 1A: unchanged from the 10-K]" : "";
    out.push({
      title: `${title(sec.form)}${markerNote} (${sec.form} ${sec.accession})`,
      text: cut.text,
      source: source(sec.form),
      asOf: isoDay(sec.reportDate),
      truncated: cut.truncated,
      originalChars: cut.originalChars,
    });
  };
  add(
    bundle.edgar.item1a,
    (form) => (form === "20-F" ? "20-F Item 3.D — Risk Factors" : "10-K Item 1A — Risk Factors"),
    PAYLOAD_BUDGETS.item1aChars,
    (form) => (form === "20-F" ? "edgar:20-F item3D" : "edgar:10-K item1A"),
  );
  add(
    bundle.edgar.mdna,
    (form) => (form === "20-F" ? "20-F Item 5 — Operating and Financial Review and Prospects" : "10-K Item 7 — MD&A"),
    PAYLOAD_BUDGETS.mdnaChars,
    (form) => (form === "20-F" ? "edgar:20-F item5" : "edgar:10-K item7"),
  );
  add(bundle.edgar.tenQMdna, () => "10-Q Item 2 — MD&A", PAYLOAD_BUDGETS.tenQMdnaChars, () => "edgar:10-Q item2");
  return out;
}

/* ------------------------------------------------------------------------ *
 * Exact numeric provenance registry
 * ------------------------------------------------------------------------ */

type PayloadWithoutRegistry = Omit<ContextPayload, "provenanceRegistry" | "citationRegistry">;

function semanticSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "value";
}

/** Stable IDs for deterministic Stage B values attached after the judge pass. */
export function projectionProvenanceId(
  metric: string,
  scenario: string,
  period: string,
): string {
  return `payload.computed.projections.${semanticSlug(metric)}.${semanticSlug(scenario)}.${semanticSlug(period)}`;
}

export function scenarioTargetProvenanceId(name: string): string {
  return `payload.computed.scenario-targets.${semanticSlug(name)}.per-share`;
}

export const FAIR_VALUE_PROVENANCE_ID =
  "payload.computed.fair-value.per-share" as const;

function periodFromLabel(label: string): string | null {
  return label.match(/\b(?:FY\d{4}|\d{4}-\d{2}-\d{2})\b/)?.[0] ?? null;
}

function isFullIsoDate(value: string | null): value is string {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function attachProvenanceRegistry(
  payload: PayloadWithoutRegistry,
  computed: ComputedMetrics,
  currency: string | null,
  fallbackAsOf: string,
): ContextPayload {
  const registry: NumericProvenanceRecord[] = [];
  const citationRegistry: CitationProvenanceRecord[] = [];
  const citationKeys = new Set<string>();
  const idCounts = new Map<string, number>();

  const registerCitation = (id: string, asOf: string | null, origin = id): void => {
    const key = `${id}\u0000${asOf ?? ""}`;
    if (!id.trim() || citationKeys.has(key)) return;
    citationKeys.add(key);
    citationRegistry.push({ id, kind: "payload-text", asOf, origin });
  };

  const uniqueId = (base: string): string => {
    const count = (idCounts.get(base) ?? 0) + 1;
    idCounts.set(base, count);
    return count === 1 ? base : `${base}.${count}`;
  };

  const registerFigure = (prefix: string, figure: PayloadFigure): void => {
    if (typeof figure.value !== "number" || !Number.isFinite(figure.value)) {
      if (figure.value !== null) {
        registerCitation(
          figure.source,
          isFullIsoDate(figure.asOf) ? figure.asOf : null,
        );
      }
      return;
    }
    const canonical = canonicalizeTracedUnit(figure.unit, currency);
    if (canonical === null) return;
    const { unit } = canonical;
    const monetary = unit === "currency" || unit === "currency-per-share";
    if (monetary && currency === null) return;

    const asOf = isFullIsoDate(figure.asOf) ? figure.asOf : fallbackAsOf;
    const id = uniqueId(`${prefix}.${semanticSlug(figure.label)}`);
    figure.provenanceId = id;
    figure.asOf = asOf;
    registry.push({
      id,
      kind: figure.source.startsWith("computed.") ? "computed" : "provider",
      value: figure.value,
      unit,
      currency: monetary ? (canonical.currency ?? currency) : null,
      period: periodFromLabel(figure.label),
      asOf,
      origin: figure.source,
      formulaVersion: figure.source.startsWith("computed.") ? "stage-b-v1" : null,
      displayPrecision: 4,
    });
  };

  const registerSection = (prefix: string, section: PayloadSection): void => {
    for (const figure of section.figures) registerFigure(prefix, figure);
  };

  const registerStageBNumber = (
    id: string,
    number: TracedNumber | null,
    period: string | null,
    formulaVersion: string,
  ): void => {
    if (number === null || !Number.isFinite(number.value) || !isFullIsoDate(number.asOf)) {
      return;
    }
    const canonical = canonicalizeTracedUnit(number.unit, number.currency);
    if (canonical === null) return;
    const monetary =
      canonical.unit === "currency" || canonical.unit === "currency-per-share";
    if (monetary && canonical.currency === null) return;
    registry.push({
      id,
      kind: "computed",
      value: number.value,
      unit: canonical.unit,
      currency: canonical.currency,
      period,
      asOf: number.asOf,
      origin: number.source,
      formulaVersion,
      displayPrecision: 4,
    });
  };

  registerSection("payload.quote", payload.quote);
  for (const section of payload.computed) {
    const sectionName = semanticSlug(section.title.split("(", 1)[0] ?? section.title);
    registerSection(`computed.${sectionName}`, section);
  }
  for (const block of payload.statements) {
    const blockName = semanticSlug(block.title);
    for (const line of block.lineItems) {
      for (const cell of line.byPeriod) {
        if (cell.value === null || !Number.isFinite(cell.value) || !isFullIsoDate(cell.period)) continue;
        const canonical = canonicalizeTracedUnit(line.unit, currency);
        if (canonical === null) continue;
        const { unit } = canonical;
        const monetary = unit === "currency" || unit === "currency-per-share";
        if (monetary && currency === null) continue;
        const id = uniqueId(
          `payload.statements.${blockName}.${cell.period}.${semanticSlug(line.lineItem)}`,
        );
        cell.provenanceId = id;
        registry.push({
          id,
          kind: "provider",
          value: cell.value,
          unit,
          currency: monetary ? (canonical.currency ?? currency) : null,
          period: cell.period,
          asOf: cell.period,
          origin: line.source,
          formulaVersion: null,
          displayPrecision: 4,
        });
      }
    }
  }

  const remainingSections: [string, PayloadSection][] = [
    ["payload.estimates", payload.estimates],
    ["payload.peers", payload.peers],
    ["payload.insiders", payload.insiders],
    ["payload.institutional", payload.institutional],
    ["payload.leadership", payload.leadership],
    ["payload.short-interest", payload.shortInterest],
    ["payload.segments", payload.segments],
    ["payload.macro", payload.macro],
    ["payload.news", payload.news],
  ];
  for (const [prefix, section] of remainingSections) registerSection(prefix, section);

  for (const excerpt of [payload.transcript, ...payload.filings]) {
    if (excerpt !== null) registerCitation(excerpt.source, excerpt.asOf, excerpt.source);
  }
  // News/press rows are rendered as inert text with one assembler-owned source
  // tag at the end. Parse only that final, allowlisted tag; never register a tag
  // embedded inside provider-controlled title/body text.
  for (const note of payload.news.notes) {
    const match = /\[(fmp:(?:news|press-release)) · (\d{4}-\d{2}-\d{2})\]$/.exec(note);
    if (match) registerCitation(match[1], match[2], match[1]);
  }
  // Insider-trade + key-executive rows render as inert text notes carrying one
  // assembler-owned tag at the END (like news). They are shown to the model as
  // citable, so register that final, ANCHORED, allowlisted tag — otherwise every
  // claim citing them fails unknown-source. Parse only the trailing tag; never a
  // tag embedded inside provider-controlled name/title/type text mid-note.
  for (const note of payload.insiders.notes) {
    const match = /\[(fmp:insider-trades) · (\d{4}-\d{2}-\d{2})\]$/.exec(note);
    if (match) registerCitation(match[1], match[2], match[1]);
  }
  for (const note of payload.leadership.notes) {
    const match = /\[(fmp:key-executives)\]$/.exec(note);
    if (match) registerCitation(match[1], null, match[1]);
  }

  // The full deterministic Stage B blocks are attached to the report only after
  // the judge returns. Register every TracedNumber here as trusted internal
  // evidence so the final-report verifier can trace those pipeline-owned values
  // without exposing hundreds of duplicate rows in the prompt prefix.
  const projections = computed.projections;
  if (projections) {
    const scenarios = ["historical", "bull", "base", "bear", "weighted"] as const;
    for (const series of projections.series) {
      for (const scenario of scenarios) {
        for (const point of series[scenario]) {
          registerStageBNumber(
            projectionProvenanceId(series.metric, scenario, point.period),
            point.value,
            point.period,
            projections.weightsVersion,
          );
        }
      }
    }
  }

  const scenarioTargets = computed.scenarioTargets;
  if (scenarioTargets?.status === "available") {
    for (const target of scenarioTargets.targets) {
      registerStageBNumber(
        scenarioTargetProvenanceId(target.name),
        target.perShare,
        null,
        scenarioTargets.methodVersion,
      );
    }
  }

  const fairValue = computed.fairValue;
  if (fairValue?.status === "available") {
    registerStageBNumber(
      FAIR_VALUE_PROVENANCE_ID,
      fairValue.perShare,
      null,
      fairValue.methodVersion,
    );
  }

  // Deterministic aspect-score DRIVERS (feature 1.1.0) are TracedNumbers the
  // pipeline COMPUTED (source "computed.scores.<aspect>.<signal>") and attaches
  // to report.scores AFTER the judge pass; the schema routes them through the
  // verify pass on purpose (schema.ts AspectScoreSchema.drivers). Register each
  // keyed on its own source id so the final-report verifier resolves them as
  // computed-derived provenance instead of "[unverified] unknown-source" — they
  // ARE provenance-bearing, so counting them as untraceable falsely caps
  // citation coverage. Dedup against ids already in the registry so a repeated
  // signal id can never throw out of validateProvenanceRegistry (invariant 7:
  // degraded paths never crash).
  const scores = computed.scores;
  if (scores) {
    const takenIds = new Set(registry.map((record) => record.id));
    for (const aspect of Object.keys(scores.aspects) as (keyof typeof scores.aspects)[]) {
      for (const driver of scores.aspects[aspect].drivers) {
        if (takenIds.has(driver.source)) continue;
        const before = registry.length;
        registerStageBNumber(driver.source, driver, driver.period ?? null, scores.bandsVersion);
        if (registry.length > before) takenIds.add(driver.source);
      }
    }
  }

  validateProvenanceRegistry(registry);
  validateCitationRegistry(citationRegistry);
  const { payloadVersion, ...rest } = payload;
  return { payloadVersion, provenanceRegistry: registry, citationRegistry, ...rest };
}

/* ------------------------------------------------------------------------ *
 * assembleContextPayload
 * ------------------------------------------------------------------------ */

/**
 * Assemble the deterministic context payload from Stage A/B outputs. Pure — no
 * clock, no network, no randomness. Given identical inputs the output is
 * byte-identical (drives the prompt cache).
 */
export function assembleContextPayload(
  bundle: DataBundle,
  computed: ComputedMetrics,
  validation: ValidationReport,
): ContextPayload {
  const profile = firstRow(bundle.profile);

  // Validation flags = failed/skipped checks + the flags array (data-quality
  // signals the model should weigh). Deterministically ordered.
  const validationFlags: string[] = [];
  for (const chk of validation.checks) {
    if (chk.status === "fail" || chk.status === "warn" || chk.status === "skipped") {
      validationFlags.push(`[${chk.status.toUpperCase()}] ${chk.name}: ${chk.detail}`);
    }
  }
  for (const flag of validation.flags) validationFlags.push(flag);

  // Missing-data manifest = computed gaps + validation gaps + degradation
  // disclosures (reduce-window / suppress / replace decisions), deduped by
  // field+reason, severity-ordered so critical gaps read first. The degradation
  // items/notes are info-severity disclosures (e.g. a recent-IPO's shortened
  // CAGR windows) that Stage B computes but that otherwise never reach the model
  // — surfacing them here keeps the prompt and the rendered appendix in agreement.
  const missingData = mergeManifest([
    computed.gaps,
    validation.gaps,
    degradationDisclosures(computed.degradation),
  ]);

  const payload: PayloadWithoutRegistry = {
    payloadVersion: PAYLOAD_VERSION,
    symbol: bundle.symbol,
    companyName: strOrNull(profile?.companyName),
    route: {
      base: computed.route.base,
      overlays: [...computed.route.overlays].sort(),
      sector: computed.route.evidence.sector,
      industry: computed.route.evidence.industry,
    },
    quote: quoteSection(bundle),
    computed: computedSections(computed),
    statements: statementExtracts(bundle),
    estimates: estimatesSection(bundle),
    peers: peersSection(bundle),
    insiders: insidersSection(bundle),
    institutional: institutionalSection(bundle),
    leadership: leadershipSection(bundle),
    shortInterest: shortInterestSection(bundle),
    segments: segmentsSection(bundle),
    macro: macroSection(bundle),
    transcript: transcriptExcerpt(bundle),
    filings: filingExcerpts(bundle),
    news: newsSection(bundle),
    validationFlags,
    missingData,
    // asOf map: bundle's own dot-path -> as-of, with stable key ordering.
    asOfMap: sortRecord(bundle.asOf),
  };
  const currency = strOrNull(profile?.currency)?.toUpperCase() ?? null;
  return attachProvenanceRegistry(
    payload,
    computed,
    currency,
    bundle.builtAt.slice(0, 10),
  );
}

/**
 * Convert a Stage B {@link DegradationPlan}'s items + notes into info-severity
 * {@link ManifestEntry} disclosures. The plan's `.gaps` already flow through
 * `computed.gaps`, but its `items[]` (per-target suppress/replace/annotate
 * decisions, e.g. a recent-IPO's shortened CAGR windows) and `notes[]` were
 * previously never surfaced to the prompt or the report. Deterministic order
 * (items in plan order first, then notes); a null/absent plan yields no rows.
 */
export function degradationDisclosures(degradation: DegradationPlan | undefined): ManifestEntry[] {
  if (!degradation) return [];
  const out: ManifestEntry[] = [];
  for (const item of degradation.items) {
    out.push({
      field: `degradation.${item.target}`,
      reason: `[${item.action}] ${item.disclosure}`,
      severity: "info",
    });
  }
  // Notes only accompany actual degradations. The empty-case note ("no
  // degradations: general route with no overlays.") is a SENTINEL, not a gap —
  // surfacing it into a missing-data manifest that every plain-vanilla report
  // renders would be misleading noise. Gate on items so a genuine future note
  // still surfaces while the empty-case sentinel never does.
  if (degradation.items.length > 0) {
    for (const note of degradation.notes) {
      out.push({ field: "degradation", reason: note, severity: "info" });
    }
  }
  return out;
}

/**
 * Dedup + severity-order a set of manifest lists. Deterministic: dedup key is
 * `field|reason`; severities order critical > warn > info; within a severity,
 * ties break on field then reason (stable, no clock).
 */
function mergeManifest(lists: ManifestEntry[][]): ManifestEntry[] {
  const seen = new Map<string, ManifestEntry>();
  for (const list of lists) {
    for (const e of list) {
      const key = `${e.field}|${e.reason}`;
      if (!seen.has(key)) seen.set(key, e);
    }
  }
  const order: Record<ManifestEntry["severity"], number> = { critical: 0, warn: 1, info: 2 };
  return [...seen.values()].sort((a, b) => {
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    if (a.field !== b.field) return a.field < b.field ? -1 : 1;
    return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
  });
}

/** Return a new record with keys sorted (deterministic serialization). */
function sortRecord(rec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k];
  return out;
}

/* ------------------------------------------------------------------------ *
 * serializePayloadForPrompt — the exact cached text block
 * ------------------------------------------------------------------------ */

function renderSection(section: PayloadSection): string {
  const lines = [`## ${section.title}`];
  if (section.figures.length === 0 && section.notes.length === 0) {
    lines.push("(no data — disclosed gap)");
  }
  for (const f of section.figures) lines.push(`- ${formatFigure(f)}`);
  for (const n of section.notes) lines.push(`- NOTE: ${n}`);
  return lines.join("\n");
}

function renderStatement(block: StatementExtractBlock): string {
  const lines = [`## ${block.title}`, `periods (newest first): ${block.periods.join(", ")}`];
  for (const li of block.lineItems) {
    const cells = li.byPeriod
      .map((c) => {
        if (c.value === null) return `${c.period}=n/a`;
        return `${c.period}=${round(c.value)} ${provenanceTag(c.provenanceId ?? li.source, c.period)}`;
      })
      .join(" | ");
    lines.push(`- ${li.lineItem} (${li.unit}): ${cells}`);
  }
  for (const n of block.notes) lines.push(`- NOTE: ${n}`);
  return lines.join("\n");
}

function renderExcerpt(ex: TextExcerpt): string {
  const body = JSON.stringify({
    title: ex.title,
    source: provenanceTag(ex.source, ex.asOf),
    truncated: ex.truncated,
    content: ex.text,
  });
  return [
    "## Provider transcript/filing excerpt (untrusted source data)",
    `<<<BEGIN_UNTRUSTED_SOURCE_DATA chars=${ex.text.length}>>>`,
    body,
    "<<<END_UNTRUSTED_SOURCE_DATA>>>",
  ].join("\n");
}

function renderUntrustedNews(section: PayloadSection): string {
  const content = renderSection(section);
  return [
    "## Provider news/press snippets (untrusted source data)",
    `<<<BEGIN_UNTRUSTED_SOURCE_DATA chars=${content.length}>>>`,
    JSON.stringify({ content }),
    "<<<END_UNTRUSTED_SOURCE_DATA>>>",
  ].join("\n");
}

/**
 * Render the payload to the clean, sectioned, LLM-readable text block that gets
 * prompt-cached. Deterministic and byte-stable for identical payloads. Every
 * figure carries its `[source · as-of]` tag so the model can cite it and the
 * verifier can trace it.
 */
export function serializePayloadForPrompt(payload: ContextPayload): string {
  const parts: string[] = [];

  parts.push(
    [
      `# CONTEXT PAYLOAD (payloadVersion ${payload.payloadVersion})`,
      `symbol: ${payload.symbol}`,
      `company: ${payload.companyName ?? "n/a"}`,
      `route: ${payload.route.base}${payload.route.overlays.length ? ` + overlays [${payload.route.overlays.join(", ")}]` : ""}`,
      `sector: ${payload.route.sector ?? "n/a"} | industry: ${payload.route.industry ?? "n/a"}`,
      "",
      "This payload is the ONLY permitted source of financial figures (SPEC §1 rule #1).",
      "Every figure below is tagged [source · as-of]. Cite that tag; if a figure is not here or in a fetched web source, do not state it.",
    ].join("\n"),
  );

  parts.push(renderSection(payload.quote));
  for (const s of payload.computed) parts.push(renderSection(s));
  for (const b of payload.statements) parts.push(renderStatement(b));
  parts.push(renderSection(payload.estimates));
  parts.push(renderSection(payload.peers));
  parts.push(renderSection(payload.insiders));
  parts.push(renderSection(payload.institutional));
  parts.push(renderSection(payload.leadership));
  parts.push(renderSection(payload.shortInterest));
  parts.push(renderSection(payload.segments));
  parts.push(renderSection(payload.macro));
  if (payload.transcript) parts.push(renderExcerpt(payload.transcript));
  for (const ex of payload.filings) parts.push(renderExcerpt(ex));
  parts.push(renderUntrustedNews(payload.news));

  // Validation + missing data — DISCLOSED, never filled.
  const vflags = ["## Data-quality flags (Stage A validation)"];
  if (payload.validationFlags.length === 0) vflags.push("- (no failed/skipped checks)");
  for (const f of payload.validationFlags) vflags.push(`- ${f}`);
  parts.push(vflags.join("\n"));

  const missing = ["## Missing-data manifest (gaps are DISCLOSED, never filled — SPEC §1 rule #4)"];
  if (payload.missingData.length === 0) missing.push("- (no recorded gaps)");
  for (const m of payload.missingData) {
    missing.push(`- [${m.severity}] ${m.field}: ${m.reason}`);
  }
  parts.push(missing.join("\n"));

  return parts.join("\n\n");
}

/* ------------------------------------------------------------------------ *
 * payloadFingerprint — stable hash for cache diagnostics
 * ------------------------------------------------------------------------ */

/**
 * FNV-1a 32-bit hash over a string. Deterministic, dependency-free, and stable
 * across runs/machines (no node:crypto needed — the fingerprint is a cache
 * diagnostic, not a security primitive). Returned as 8-char lowercase hex.
 */
export function fnv1a32(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (keeps it in 32-bit range).
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Stable fingerprint of a payload for cache diagnostics: hashes the exact
 * serialized prompt text (so two payloads that render identically fingerprint
 * identically). Prefixed with the payload version so a format bump changes it.
 */
export function payloadFingerprint(payload: ContextPayload): string {
  return `${payload.payloadVersion}:${fnv1a32(serializePayloadForPrompt(payload))}`;
}
