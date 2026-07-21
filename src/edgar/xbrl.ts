/**
 * SEC EDGAR XBRL companyfacts processing: concept tag-fallback chains, the
 * critical form-filtered dedup rule, period-scoped lookups, and the FMP
 * cross-check comparator.
 *
 * Research basis (all live-verified 2026-07-05):
 *   - the EDGAR extraction contract §4 (companyfacts structure, dedup, revenue pitfall)
 *   - the EDGAR extraction contract §4 (JPM bank chains, F14 DEF 14A trap)
 *   - the bank-filing extraction contract §2.6-2.8 (BAC/WFC/C matrix,
 *     F22-F25, revised chains)
 *
 * THE CRITICAL DEDUP RULE (F14 + F24): filter facts to audited/core forms
 * 10-K / 10-Q / 10-K/A / 10-Q/A / 20-F / 20-F/A BEFORE deduping, then group
 * by period (start,end | end) and take max(filed). DEF 14A points can carry `frame`
 * plus a ROUNDED value (JPM FY2025 NetIncomeLoss: 57,048,000,000 in the 10-K
 * vs 57,000,000,000 in the DEF 14A filed later), 6-K points are not standardized,
 * and 8-K points exist (Citi).
 * `fy`/`fp` can be null — never assume ints.
 *
 * This module is pure (no network); the companyfacts JSON comes from
 * src/providers/edgar.ts.
 */

import { z } from "zod";
import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";

// ---------------------------------------------------------------------------
// Types & schemas
// ---------------------------------------------------------------------------

/** One companyfacts datapoint. Duration concepts carry `start`; instants do not. */
export const factPointSchema = z.looseObject({
  start: z.string().optional(),
  end: z.string(),
  val: z.number(),
  accn: z.string(),
  /** fy/fp describe the FILING the fact came from, not the fact's own period; null on DEF 14A points. */
  fy: z.number().nullish(),
  fp: z.string().nullish(),
  form: z.string(),
  filed: z.string(),
  frame: z.string().optional(),
});
export type FactPoint = z.infer<typeof factPointSchema>;

export const conceptFactsSchema = z.looseObject({
  label: z.string().nullish(),
  description: z.string().nullish(),
  units: z.record(z.string(), z.array(z.unknown())),
});
export type ConceptFacts = z.infer<typeof conceptFactsSchema>;

/** Shape of https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json */
export interface CompanyFacts {
  cik: number;
  entityName: string;
  /** namespace (us-gaap, dei, srt, ...) -> tag -> concept facts */
  facts: Record<string, Record<string, unknown>>;
}

export const companyFactsSchema = z.looseObject({
  cik: z.number(),
  entityName: z.string(),
  facts: z.record(z.string(), z.record(z.string(), z.unknown())),
});

/**
 * Forms whose facts are trusted for dedup. Form 20-F is the audited annual
 * counterpart to a 10-K for foreign private issuers; 6-K remains excluded
 * because its interim content is not a standardized quarterly statement.
 */
export const CORE_FACT_FORMS = new Set(["10-K", "10-Q", "10-K/A", "10-Q/A", "20-F", "20-F/A"]);

// ---------------------------------------------------------------------------
// Concept chains
// ---------------------------------------------------------------------------

export type ChainStep =
  | { kind: "tag"; tag: string; unit?: string }
  | { kind: "sum"; tags: string[]; unit?: string; label: string };

export type ConceptName =
  | "revenue"
  | "netIncome"
  | "assets"
  | "equity"
  | "deposits"
  | "provisionForCreditLosses"
  | "netInterestIncome"
  | "noninterestIncome"
  | "noninterestExpense"
  | "dilutedEps";

const t = (tag: string, unit?: string): ChainStep => ({ kind: "tag", tag, unit });

/**
 * Per-concept fallback chains. Resolution is PERIOD-SCOPED: the first step
 * that yields a fact for the requested period wins, so stale-but-present tags
 * (WFC `Revenues`, last point 2020-09-30) fall through naturally.
 *
 * Chain evidence: the bank-filing extraction contract §2.6-2.7 and
 * fixtures/edgar/bank_xbrl_tag_matrix.json.
 */
export const CONCEPT_CHAINS: Record<ConceptName, ChainStep[]> = {
  revenue: [
    // Post-ASC-606 industrials (AAPL). us-gaap:Revenues alone silently stops at FY2018 for AAPL.
    t("RevenueFromContractWithCustomerExcludingAssessedTax"),
    t("RevenueFromContractWithCustomerIncludingAssessedTax"),
    // Banks: JPM tags total net revenue under Revenues (annual only) AND RevenuesNetOfInterestExpense.
    t("Revenues"),
    t("RevenuesNetOfInterestExpense"),
    // Bank computed fallback — identity verified exactly at JPM/BAC/WFC/C.
    { kind: "sum", tags: ["InterestIncomeExpenseNet", "NoninterestIncome"], label: "NII+NonII" },
    // Deprecated pre-2018 tag, last resort for old filers.
    t("SalesRevenueNet"),
    // NOTE: InterestAndDividendIncomeOperating is deliberately EXCLUDED — it is
    // GROSS interest income at BAC/WFC/C and would overstate revenue (research §2.7).
  ],
  netIncome: [t("NetIncomeLoss"), t("ProfitLoss")],
  assets: [t("Assets")],
  equity: [
    t("StockholdersEquity"),
    t("StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"),
  ],
  deposits: [t("Deposits"), { kind: "sum", tags: ["DepositsDomestic", "DepositsForeign"], label: "Domestic+Foreign" }],
  provisionForCreditLosses: [
    t("ProvisionForLoanLeaseAndOtherLosses"), // JPM, WFC current
    t("ProvisionForLoanLossesExpensed"), // C current
    t("ProvisionForCreditLossExpenseReversal"), // absent at all 4 majors; kept for regionals
    // BAC F25: standard P&L provision tag is an extension tag; computed sum verified 5,595+80=5,675 $M FY2025.
    {
      kind: "sum",
      tags: [
        "FinancingReceivableExcludingAccruedInterestCreditLossExpenseReversal",
        "OffBalanceSheetCreditLossLiabilityCreditLossExpenseReversal",
      ],
      label: "FinRecCLExp+OffBSCLExp",
    },
    t("ProvisionForLoanAndLeaseLosses"), // legacy
  ],
  netInterestIncome: [t("InterestIncomeExpenseNet")],
  noninterestIncome: [t("NoninterestIncome")],
  noninterestExpense: [t("NoninterestExpense")],
  dilutedEps: [t("EarningsPerShareDiluted", "USD/shares")],
};

/**
 * Bank/financial revenue chain (finding L1). Total-revenue bank tags come
 * FIRST so a bank that ALSO tags entity-level ASC-606 fee revenue under
 * RevenueFromContractWithCustomer* is not mis-resolved to that FEE-ONLY figure
 * (which excludes net interest income and understates a bank's revenue by the
 * whole NII line). The default CONCEPT_CHAINS.revenue (RFC first) is correct
 * for non-financials; getConcept switches to this chain only when the caller
 * passes `bankRevenue: true` (validate.ts routes it by sector / bank tagging).
 * RFC tags remain as a trailing fallback for financials that report no bank
 * total-revenue tag at all. Order matches research §2.6-2.7 (Revenues /
 * RevenuesNetOfInterestExpense / NII+NonII are the verified total-revenue tags).
 */
export const BANK_REVENUE_CHAIN: ChainStep[] = [
  t("Revenues"),
  t("RevenuesNetOfInterestExpense"),
  { kind: "sum", tags: ["InterestIncomeExpenseNet", "NoninterestIncome"], label: "NII+NonII" },
  t("RevenueFromContractWithCustomerExcludingAssessedTax"),
  t("RevenueFromContractWithCustomerIncludingAssessedTax"),
  t("SalesRevenueNet"),
];

// ---------------------------------------------------------------------------
// Point selection
// ---------------------------------------------------------------------------

export interface PeriodQuery {
  /** Fact period end (fiscal period end). Matched within ±toleranceDays (52/53-week calendars). */
  end: string;
  /** Fact period start for duration concepts; disambiguates quarter vs YTD rows. */
  start?: string;
  /** When `start` is unknown: "FY" prefers ~annual durations, "Q" ~quarterly. */
  durationHint?: "FY" | "Q";
  /** Days of slack on period matching (default 3 — 52/53-week fiscal calendars). */
  toleranceDays?: number;
}

const DAY_MS = 86_400_000;

function dateMs(d: string): number {
  const ms = Date.parse(`${d}T00:00:00Z`);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

function withinDays(a: string, b: string, days: number): boolean {
  const am = dateMs(a);
  const bm = dateMs(b);
  if (Number.isNaN(am) || Number.isNaN(bm)) return false;
  return Math.abs(am - bm) <= days * DAY_MS;
}

/** Length of a fact's own period in days; null for instants (no `start`). */
function durationDays(p: FactPoint): number | null {
  return p.start !== undefined ? (dateMs(p.end) - dateMs(p.start)) / DAY_MS : null;
}

/**
 * Whether a fact's own period length is consistent with an FY/Q hint.
 * Instants (no `start` — balance-date concepts like Assets/StockholdersEquity)
 * are ALWAYS compatible: their length is unknowable, so the hint cannot reject
 * them. FY ≈ 300–400 d (52/53-week calendars), Q ≈ 70–110 d.
 */
function durationMatchesHint(p: FactPoint, hint: "FY" | "Q"): boolean {
  const dur = durationDays(p);
  if (dur === null) return true;
  return hint === "FY" ? dur >= 300 && dur <= 400 : dur >= 70 && dur <= 110;
}

/** Parse the raw unit array of a concept into validated FactPoints (invalid rows skipped). */
export function parseFactPoints(raw: unknown[]): FactPoint[] {
  const out: FactPoint[] = [];
  for (const r of raw) {
    const p = factPointSchema.safeParse(r);
    if (p.success) out.push(p.data);
  }
  return out;
}

/** Step 1 of the critical rule: drop every fact not filed on a core form. */
export function filterToCoreForms(points: FactPoint[]): FactPoint[] {
  return points.filter((p) => CORE_FACT_FORMS.has(p.form.trim()));
}

/**
 * Step 2: group by period (start|end for durations, end for instants) and keep
 * max(filed); ties prefer amendments, then lexicographically larger accession.
 * MUST be called on core-form-filtered points (use dedupFactPoints for both).
 */
export function dedupByPeriod(points: FactPoint[]): FactPoint[] {
  const groups = new Map<string, FactPoint>();
  for (const p of points) {
    const key = `${p.start ?? ""}|${p.end}`;
    const cur = groups.get(key);
    if (!cur) {
      groups.set(key, p);
      continue;
    }
    if (p.filed > cur.filed) groups.set(key, p);
    else if (p.filed === cur.filed) {
      const pAmend = p.form.endsWith("/A");
      const curAmend = cur.form.endsWith("/A");
      if (pAmend && !curAmend) groups.set(key, p);
      else if (pAmend === curAmend && p.accn > cur.accn) groups.set(key, p);
    }
  }
  return [...groups.values()];
}

/** The full critical dedup rule: core-form filter FIRST, then per-period max(filed). */
export function dedupFactPoints(points: FactPoint[]): FactPoint[] {
  return dedupByPeriod(filterToCoreForms(points));
}

/** Find the deduped point matching a period query, or null. */
export function findPointForPeriod(points: FactPoint[], q: PeriodQuery): { point: FactPoint | null; note?: string } {
  const tol = q.toleranceDays ?? 3;
  const deduped = dedupFactPoints(points);
  let matches = deduped.filter((p) => withinDays(p.end, q.end, tol));
  if (q.start !== undefined) {
    matches = matches.filter((p) => p.start !== undefined && withinDays(p.start, q.start as string, tol));
  }
  if (matches.length === 0) return { point: null };

  // Duration-hint gate (M7): when the caller supplies only an end + FY/Q hint
  // (no explicit start), a candidate whose OWN duration contradicts the hint
  // must NOT be returned — even when it is the sole candidate. Without this, a
  // quarterly cross-check on a Dec-FY filer whose only near-end fact is the
  // 12-month FY point would silently compare a quarter against a full year
  // (~300% spurious mismatch). Instants pass through (see durationMatchesHint);
  // a genuine no-match here is reported as NOT-CHECKABLE by the caller, never a
  // numeric disagreement.
  if (q.start === undefined && q.durationHint !== undefined) {
    const hint = q.durationHint;
    const compatible = matches.filter((p) => durationMatchesHint(p, hint));
    if (compatible.length === 0) {
      const lens = matches.map((p) => `${Math.round(durationDays(p) ?? 0)}d`).join(", ");
      return {
        point: null,
        note: `no ${hint}-length XBRL fact ends near ${q.end} (candidate durations: ${lens}); the ${
          hint === "Q" ? "quarter" : "fiscal year"
        } is not separately filed — cross-check not checkable`,
      };
    }
    matches = compatible;
  }

  if (matches.length === 1) return { point: matches[0] };

  // Multiple duration groups still share the end date.
  let note: string | undefined;
  if (q.start === undefined) {
    // Deterministic but flagged: prefer the longest duration (annual over quarter), then latest filed.
    matches = [...matches].sort((a, b) => {
      const da = a.start !== undefined ? dateMs(a.end) - dateMs(a.start) : -1;
      const db = b.start !== undefined ? dateMs(b.end) - dateMs(b.start) : -1;
      if (db !== da) return db - da;
      return b.filed.localeCompare(a.filed);
    });
    note = `ambiguous period match (${matches.length} duration groups end near ${q.end}); pass start or durationHint`;
  }
  return { point: matches[0], note };
}

// ---------------------------------------------------------------------------
// getConcept
// ---------------------------------------------------------------------------

export interface ConceptValue {
  value: number;
  /** Winning us-gaap tag, or "A+B" label for computed sums. */
  tag: string;
  computed: boolean;
  unit: string;
  period: { start?: string; end: string };
  accn: string;
  form: string;
  filed: string;
  fy: number | null;
  fp: string | null;
  /** For computed sums: the underlying component points. */
  components?: { tag: string; value: number; point: FactPoint }[];
  /** Set when period matching was ambiguous — treat with care. */
  note?: string;
}

function usGaap(facts: CompanyFacts): Record<string, unknown> {
  return facts.facts["us-gaap"] ?? {};
}

/** Get the validated points of one tag in one unit (default USD; falls back to sole unit). */
export function tagPoints(facts: CompanyFacts, tag: string, unit?: string): { unit: string; points: FactPoint[] } | null {
  const rawConcept = usGaap(facts)[tag];
  if (rawConcept === undefined) return null;
  const parsed = conceptFactsSchema.safeParse(rawConcept);
  if (!parsed.success) return null;
  const units = parsed.data.units;
  const unitKeys = Object.keys(units);
  const chosen = unit !== undefined && units[unit] !== undefined ? unit : units["USD"] !== undefined ? "USD" : unitKeys[0];
  if (chosen === undefined) return null;
  const arr = units[chosen];
  if (!Array.isArray(arr)) return null;
  return { unit: chosen, points: parseFactPoints(arr) };
}

function resolveTagStep(
  facts: CompanyFacts,
  tag: string,
  unit: string | undefined,
  q: PeriodQuery,
): { point: FactPoint; unit: string; note?: string } | null {
  const tp = tagPoints(facts, tag, unit);
  if (tp === null) return null;
  const { point, note } = findPointForPeriod(tp.points, q);
  if (point === null) return null;
  return { point, unit: tp.unit, note };
}

/**
 * Resolve a concept through its fallback chain for one period.
 * The first chain step producing a fact for the period wins; computed-sum
 * steps require every component to resolve for the same period.
 * Returns { ok:false, gap } when nothing matches — never throws for missing data.
 */
export function getConcept(
  facts: CompanyFacts,
  chain: ConceptName | ChainStep[],
  opts: { period: PeriodQuery; bankRevenue?: boolean },
): FetchResult<ConceptValue> {
  // L1: for the named "revenue" concept only, bank-mode reorders the chain so
  // total-revenue bank tags win over ASC-606 RFC fee tags. Every other concept
  // (and any custom ChainStep[] array) is unaffected.
  const steps = Array.isArray(chain)
    ? chain
    : chain === "revenue" && opts.bankRevenue === true
      ? BANK_REVENUE_CHAIN
      : CONCEPT_CHAINS[chain];
  const conceptLabel = Array.isArray(chain) ? "customChain" : chain;
  const q = opts.period;
  const attempted: string[] = [];

  for (const step of steps) {
    if (step.kind === "tag") {
      attempted.push(step.tag);
      const r = resolveTagStep(facts, step.tag, step.unit, q);
      if (r === null) continue;
      return ok(conceptLabel, {
        value: r.point.val,
        tag: step.tag,
        computed: false,
        unit: r.unit,
        period: { start: r.point.start, end: r.point.end },
        accn: r.point.accn,
        form: r.point.form,
        filed: r.point.filed,
        fy: r.point.fy ?? null,
        fp: r.point.fp ?? null,
        note: r.note,
      });
    } else {
      attempted.push(`sum(${step.tags.join("+")})`);
      const parts: { tag: string; value: number; point: FactPoint }[] = [];
      let unit = step.unit ?? "USD";
      let failed = false;
      for (const tag of step.tags) {
        const r = resolveTagStep(facts, tag, step.unit, q);
        if (r === null) {
          failed = true;
          break;
        }
        unit = r.unit;
        parts.push({ tag, value: r.point.val, point: r.point });
      }
      if (failed || parts.length === 0) continue;
      const first = parts[0].point;
      return ok(conceptLabel, {
        value: parts.reduce((s, p) => s + p.value, 0),
        tag: step.tags.join("+"),
        computed: true,
        unit,
        period: { start: first.start, end: first.end },
        accn: first.accn,
        form: first.form,
        filed: first.filed,
        fy: first.fy ?? null,
        fp: first.fp ?? null,
        components: parts,
      });
    }
  }

  const gap: ManifestEntry = {
    field: `xbrl.${conceptLabel}`,
    reason: `no XBRL fact matched period end=${q.end}${q.start !== undefined ? ` start=${q.start}` : ""} after core-form dedup; tried: ${attempted.join(", ")}`,
    severity: "warn",
    attemptedSources: attempted.map((a) => `companyfacts us-gaap/${a}`),
  };
  return { ok: false, gap };
}

function ok(conceptLabel: string, value: ConceptValue): FetchResult<ConceptValue> {
  const sourced: Sourced<ConceptValue> = {
    data: value,
    asOf: value.period.end,
    source: "edgar",
    endpoint: `xbrl/companyfacts us-gaap/${value.tag} (${conceptLabel})`,
    fetchedAt: new Date().toISOString(),
  };
  return { ok: true, value: sourced };
}

// ---------------------------------------------------------------------------
// Cross-check & helpers
// ---------------------------------------------------------------------------

export interface CrossCheckResult {
  match: boolean;
  /** Percent deviation of fmpValue from xbrlValue (100 = 100%). */
  deltaPct: number;
}

/**
 * Compare an FMP-reported value with the XBRL-filed value.
 * Default tolerance 0.5% (DATA_MAP §2.3; use 2% for bank provision lines).
 */
export function crossCheck(fmpValue: number, xbrlValue: number, tolerancePct = 0.5): CrossCheckResult {
  if (fmpValue === xbrlValue) return { match: true, deltaPct: 0 };
  const denom = Math.abs(xbrlValue) > 0 ? Math.abs(xbrlValue) : Math.abs(fmpValue);
  if (denom === 0) return { match: true, deltaPct: 0 };
  const deltaPct = (Math.abs(fmpValue - xbrlValue) / denom) * 100;
  return { match: deltaPct <= tolerancePct, deltaPct };
}

/**
 * Bank-tagging detection (re-confirmed at JPM/BAC/WFC/C):
 * RevenueFromContractWithCustomer* absent AND a bank revenue/NII tag present.
 */
export function looksLikeBankTagging(facts: CompanyFacts): boolean {
  const g = usGaap(facts);
  const hasRfc =
    g["RevenueFromContractWithCustomerExcludingAssessedTax"] !== undefined ||
    g["RevenueFromContractWithCustomerIncludingAssessedTax"] !== undefined;
  const hasBank = g["RevenuesNetOfInterestExpense"] !== undefined || g["InterestIncomeExpenseNet"] !== undefined;
  return !hasRfc && hasBank;
}

/**
 * Bank revenue identity check: NII + NonII must equal total net revenue
 * (held exactly at all four majors). Returns null when inputs are unavailable.
 */
export function checkBankRevenueIdentity(
  facts: CompanyFacts,
  period: PeriodQuery,
  tolerancePct = 0.1,
): { holds: boolean; revenue: number; nii: number; nonII: number; deltaPct: number } | null {
  const rev = getConcept(facts, "revenue", { period });
  const nii = getConcept(facts, "netInterestIncome", { period });
  const non = getConcept(facts, "noninterestIncome", { period });
  if (!rev.ok || !nii.ok || !non.ok) return null;
  const sum = nii.value.data.value + non.value.data.value;
  const { match, deltaPct } = crossCheck(sum, rev.value.data.value, tolerancePct);
  return { holds: match, revenue: rev.value.data.value, nii: nii.value.data.value, nonII: non.value.data.value, deltaPct };
}

/** Most recent fact period end across the given tags (freshness probe — Citi F23 lags months). */
export function latestFactEnd(facts: CompanyFacts, tags: string[]): string | null {
  let latest: string | null = null;
  for (const tag of tags) {
    const tp = tagPoints(facts, tag);
    if (tp === null) continue;
    for (const p of filterToCoreForms(tp.points)) {
      if (latest === null || p.end > latest) latest = p.end;
    }
  }
  return latest;
}
