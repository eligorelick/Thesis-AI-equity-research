/**
 * Stage A validation (the application contract §3) — pure, deterministic, no network/db/LLM.
 *
 * Four validation families, all report-renderable:
 *  1. Balance-sheet identity |assets − (liabilities + equity)| / assets ≤ 0.5%
 *     on the latest 4 annual periods (per-period pass/fail + delta).
 *  2. FMP ↔ EDGAR XBRL cross-check on revenue + netIncome for the latest FY
 *     and latest quarter, via src/edgar/xbrl.ts concept chains (bank chains
 *     included) with the critical form-filtered dedup. Tolerance 0.5%.
 *  3. Staleness flags per DATA_MAP §3 TTL expectations: fundamentals more than
 *     ~120 d behind the expected quarter end, stale quotes, 13F older than the
 *     latest quarter whose 45-day deadline has passed.
 *  4. Zero-as-null sweep: implausible FMP zeros (interestExpense, SG&A) are
 *     marked as undisclosed (DATA_MAP §1.1) — recorded, never silently used.
 *
 * Every house-rule threshold is annotated in the returned `flags` array
 * rather than silently applied. Missing inputs produce "skipped" checks and
 * ManifestEntry gaps — never throws.
 *
 * The module defines its OWN narrow input interfaces (design rule); the full
 * DataBundle from src/pipeline/types.ts satisfies them structurally.
 */

import type { FetchResult, ManifestEntry } from "@/types/core";
import {
  crossCheck,
  getConcept,
  latestFactEnd,
  looksLikeBankTagging,
  type CompanyFacts,
  type ConceptName,
} from "@/edgar/xbrl";
import {
  latestQuarterEndOnOrBefore,
  resolve13FQuarter,
} from "@/pipeline/types";

// ---------------------------------------------------------------------------
// House-rule constants (every one surfaced in flags when applied)
// ---------------------------------------------------------------------------

/** Balance-sheet identity tolerance, percent of total assets (SPEC §3). */
export const IDENTITY_TOLERANCE_PCT = 0.5;
/** Annual periods the identity check covers. */
export const IDENTITY_PERIODS = 4;
/** FMP↔XBRL cross-check tolerance, percent (DATA_MAP §2.3). */
export const CROSS_CHECK_TOLERANCE_PCT = 0.5;
/** Fundamentals staleness: newest statement should cover the latest calendar
 * quarter that ended ≥ this many days ago (10-Q deadline ≈ 40–45 d + slack). */
export const FUNDAMENTALS_STALE_LAG_DAYS = 120;
/** Slack for 52/53-week fiscal calendars when comparing period ends. */
export const FISCAL_CALENDAR_SLACK_DAYS = 10;
/** Quote asOf older than this (calendar days) is flagged. */
export const QUOTE_STALE_DAYS = 7;
/** Fields where an FMP `0` is implausible and means "not disclosed". */
export const IMPLAUSIBLE_ZERO_FIELDS = [
  "interestExpense",
  "sellingGeneralAndAdministrativeExpenses",
] as const;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Input interfaces (narrow; DataBundle satisfies them structurally)
// ---------------------------------------------------------------------------

/** Income-statement row fields the validator reads (FMP field names). */
export interface ValidateIncomeRow {
  [key: string]: unknown;
  date?: string;
  period?: string;
  fiscalYear?: string;
  revenue?: number;
  netIncome?: number;
  interestExpense?: number;
  sellingGeneralAndAdministrativeExpenses?: number;
  reportedCurrency?: string | null;
}

/** Balance-sheet row fields the validator reads (FMP field names). */
export interface ValidateBalanceRow {
  [key: string]: unknown;
  date?: string;
  period?: string;
  fiscalYear?: string;
  totalAssets?: number;
  totalLiabilities?: number;
  totalEquity?: number;
  totalStockholdersEquity?: number;
  minorityInterest?: number;
}

export interface ValidateDatedRow {
  [key: string]: unknown;
  date?: string;
}

/** Company-profile fields the validator reads (FMP field names). */
export interface ValidateProfileRow {
  [key: string]: unknown;
  sector?: string | null;
  industry?: string | null;
}

export interface ValidatableBundle {
  symbol: string;
  quote: FetchResult<unknown>;
  /** Company profile (optional): drives bank-revenue routing for the cross-check (L1). */
  profile?: FetchResult<{ rows: ValidateProfileRow[] }>;
  statements: {
    incomeAnnual: FetchResult<{ rows: ValidateIncomeRow[] }>;
    incomeQuarterly: FetchResult<{ rows: ValidateIncomeRow[] }>;
    balanceAnnual: FetchResult<{ rows: ValidateBalanceRow[] }>;
  };
  institutional: {
    year: number;
    quarter: number;
    quarterEnd: string;
    positionsSummary: FetchResult<{ rows: ValidateDatedRow[] }>;
  };
  edgar: {
    companyFacts: FetchResult<CompanyFacts>;
  };
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ValidationCheck {
  /** Stable id, e.g. "balanceSheetIdentity.2025-09-27". */
  id: string;
  name: string;
  status: "pass" | "fail" | "warn" | "skipped";
  /** Human-readable detail with the actual numbers (report-renderable). */
  detail: string;
  /** Percent deviation where meaningful (full precision — round at display). */
  deltaPct?: number;
  /** Period/date the check is about. */
  asOf?: string;
}

export interface ValidationReport {
  checks: ValidationCheck[];
  flags: string[];
  gaps: ManifestEntry[];
}

export interface ValidateOptions {
  /** Injectable clock for deterministic staleness checks. Default: new Date(). */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Collector {
  checks: ValidationCheck[];
  flags: string[];
  gaps: ManifestEntry[];
}

function addFlag(c: Collector, flag: string): void {
  if (!c.flags.includes(flag)) c.flags.push(flag);
}

function gapEntry(
  field: string,
  reason: string,
  severity: ManifestEntry["severity"],
  attemptedSources?: string[],
): ManifestEntry {
  const entry: ManifestEntry = { field, reason, severity };
  if (attemptedSources !== undefined) entry.attemptedSources = attemptedSources;
  return entry;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Rows sorted date DESC (defensive — the bundle already sorts). */
function byDateDesc<T extends { date?: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const da = typeof a.date === "string" ? a.date : "";
    const db = typeof b.date === "string" ? b.date : "";
    return da < db ? 1 : da > db ? -1 : 0;
  });
}

function parseDateMs(d: string): number {
  return Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
}

// ---------------------------------------------------------------------------
// 1. Balance-sheet identity
// ---------------------------------------------------------------------------

/**
 * Equity for the identity: totalEquity (includes minority interest) preferred;
 * FMP-zero (undisclosed) falls back to totalStockholdersEquity + minorityInterest.
 * Note: legitimately negative equity is accepted — only 0/missing is treated
 * as undisclosed (DATA_MAP §1.1 zero-vs-undisclosed).
 */
function pickEquity(row: ValidateBalanceRow): { value: number; basis: string } | null {
  if (isFiniteNumber(row.totalEquity) && row.totalEquity !== 0) {
    return { value: row.totalEquity, basis: "totalEquity" };
  }
  if (isFiniteNumber(row.totalStockholdersEquity) && row.totalStockholdersEquity !== 0) {
    const mi = isFiniteNumber(row.minorityInterest) ? row.minorityInterest : 0;
    return {
      value: row.totalStockholdersEquity + mi,
      basis: mi !== 0 ? "totalStockholdersEquity+minorityInterest" : "totalStockholdersEquity",
    };
  }
  return null;
}

function checkBalanceSheetIdentity(bundle: ValidatableBundle, c: Collector): void {
  const balance = bundle.statements.balanceAnnual;
  if (!balance.ok) {
    c.checks.push({
      id: "balanceSheetIdentity",
      name: "Balance-sheet identity (assets = liabilities + equity)",
      status: "skipped",
      detail: `annual balance sheet unavailable: ${balance.gap.reason}`,
    });
    c.gaps.push(
      gapEntry(
        "validation.balanceSheetIdentity",
        `identity check skipped — annual balance sheet unavailable (${balance.gap.reason})`,
        "warn",
      ),
    );
    return;
  }

  addFlag(
    c,
    `House rule: balance-sheet identity tolerance ${IDENTITY_TOLERANCE_PCT}% of total assets, latest ${IDENTITY_PERIODS} annual periods (SPEC §3).`,
  );

  const rows = byDateDesc(balance.value.data.rows).slice(0, IDENTITY_PERIODS);
  if (rows.length === 0) {
    c.checks.push({
      id: "balanceSheetIdentity",
      name: "Balance-sheet identity (assets = liabilities + equity)",
      status: "skipped",
      detail: "annual balance sheet returned zero rows",
    });
    c.gaps.push(
      gapEntry("validation.balanceSheetIdentity", "identity check skipped — zero balance-sheet rows", "warn"),
    );
    return;
  }

  for (const row of rows) {
    const date = typeof row.date === "string" ? row.date.slice(0, 10) : "unknown-date";
    const id = `balanceSheetIdentity.${date}`;
    const name = `Balance-sheet identity ${date}`;

    const assets = row.totalAssets;
    const liabilities = row.totalLiabilities;
    const equity = pickEquity(row);

    if (!isFiniteNumber(assets) || assets <= 0) {
      c.checks.push({
        id,
        name,
        status: "skipped",
        detail: `totalAssets missing/zero (${String(assets)}) — cannot form the identity denominator`,
        asOf: date,
      });
      c.gaps.push(
        gapEntry(`validation.${id}`, "totalAssets missing or zero — identity not checkable", "warn"),
      );
      continue;
    }
    if (!isFiniteNumber(liabilities) || equity === null) {
      c.checks.push({
        id,
        name,
        status: "skipped",
        detail: `totalLiabilities (${String(liabilities)}) or equity (totalEquity/totalStockholdersEquity) missing/zero`,
        asOf: date,
      });
      c.gaps.push(
        gapEntry(`validation.${id}`, "liabilities or equity undisclosed — identity not checkable", "warn"),
      );
      continue;
    }

    const deltaPct = (Math.abs(assets - (liabilities + equity.value)) / assets) * 100;
    const pass = deltaPct <= IDENTITY_TOLERANCE_PCT;

    // FMP uses literal zero for both a genuinely unlevered issuer and an
    // undisclosed liabilities field.  Preserve a passing identity when the
    // zero is internally consistent, but do not manufacture a hard failure
    // from an ambiguous zero-liability operand when the identity cannot be
    // evaluated reliably.
    if (liabilities === 0 && !pass) {
      c.checks.push({
        id,
        name,
        status: "skipped",
        detail:
          `totalLiabilities is zero and assets ${assets} do not reconcile to equity ${equity.value} ` +
          `(${equity.basis}) — zero may be an undisclosed sentinel; identity is ambiguous`,
        deltaPct,
        asOf: date,
      });
      c.gaps.push(
        gapEntry(
          `validation.${id}`,
          `totalLiabilities is zero and identity is ambiguous at ${date} — check skipped rather than reported as a statement failure`,
          "warn",
        ),
      );
      continue;
    }

    c.checks.push({
      id,
      name,
      status: pass ? "pass" : "fail",
      detail:
        `assets ${assets} vs liabilities ${liabilities} + equity ${equity.value} ` +
        `(${equity.basis}); Δ ${deltaPct}% (tolerance ${IDENTITY_TOLERANCE_PCT}%)`,
      deltaPct,
      asOf: date,
    });
    if (!pass) {
      c.gaps.push(
        gapEntry(
          `validation.${id}`,
          `balance-sheet identity broke by ${deltaPct}% at ${date} — statement data suspect`,
          "warn",
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. FMP ↔ XBRL cross-check
// ---------------------------------------------------------------------------

interface CrossSpec {
  concept: ConceptName;
  fmpField: "revenue" | "netIncome";
}

const CROSS_SPECS: CrossSpec[] = [
  { concept: "revenue", fmpField: "revenue" },
  { concept: "netIncome", fmpField: "netIncome" },
];

/**
 * Whether the company routes as a financial (bank/insurer) for revenue-tag
 * purposes (finding L1). Lightweight mirror of the base-route rules in
 * stageB/sectorRouting.ts (industry prefix first, then sector) — it only
 * decides whether the FMP↔XBRL revenue cross-check should prefer total-revenue
 * bank tags over ASC-606 RFC fee tags. Insurance BROKERS are fee-based and
 * route GENERAL (sectorRouting §3), so they are excluded here too.
 */
function routesAsFinancial(bundle: ValidatableBundle): boolean {
  const res = bundle.profile;
  if (res === undefined || !res.ok) return false;
  const row = res.value.data.rows[0];
  if (row === undefined) return false;
  const industry = typeof row.industry === "string" ? row.industry.toLowerCase() : null;
  const sector = typeof row.sector === "string" ? row.sector.toLowerCase() : null;
  if (industry !== null) {
    if (industry.startsWith("banks")) return true;
    if (industry.startsWith("insurance")) return !industry.includes("broker");
    // Any other KNOWN industry (brokers, payment networks, asset managers,
    // exchanges, credit services…) is not a deposit-funded balance sheet —
    // the bank revenue chain must not engage merely because the SECTOR is
    // Financial Services (fix-review). Mislabeled/missing-profile banks are
    // still caught by the looksLikeBankTagging OR at the caller.
    return false;
  }
  return sector === "financial services" || sector === "financial";
}

function crossCheckRow(
  facts: CompanyFacts,
  row: ValidateIncomeRow,
  periodLabel: "FY" | "Q",
  bankRevenue: boolean,
  c: Collector,
): void {
  const end = typeof row.date === "string" ? row.date.slice(0, 10) : null;
  if (end === null) {
    c.checks.push({
      id: `xbrlCrossCheck.${periodLabel}`,
      name: `FMP↔XBRL cross-check (latest ${periodLabel})`,
      status: "skipped",
      detail: "FMP statement row has no date — cannot scope the XBRL period",
    });
    return;
  }

  for (const spec of CROSS_SPECS) {
    const id = `xbrlCrossCheck.${spec.fmpField}.${periodLabel}.${end}`;
    const name = `FMP↔XBRL ${spec.fmpField} (${periodLabel} ${end})`;
    const fmpValue = row[spec.fmpField];

    if (!isFiniteNumber(fmpValue) || fmpValue === 0) {
      c.checks.push({
        id,
        name,
        status: "skipped",
        detail: `FMP ${spec.fmpField} is ${String(fmpValue)} — zero/missing treated as undisclosed, nothing to cross-check`,
        asOf: end,
      });
      c.gaps.push(
        gapEntry(
          `validation.${id}`,
          `FMP ${spec.fmpField} missing/zero for ${periodLabel} ${end} — cross-check not possible`,
          "info",
        ),
      );
      continue;
    }

    const concept = getConcept(facts, spec.concept, {
      period: { end, durationHint: periodLabel },
      bankRevenue: spec.concept === "revenue" ? bankRevenue : false,
    });
    if (!concept.ok) {
      // No XBRL fact resolved for this exact period/duration — the cross-check
      // simply cannot run. This is NOT-CHECKABLE, not a disagreement: the FMP
      // figure still stands (it is the source). Report it as a skipped check
      // with an INFO gap, mirroring the sibling "FMP value missing" case above
      // — never a warn "FMP and XBRL disagree" (finding M7: a quarter with only
      // an annual XBRL duration must not be forced into a numeric mismatch).
      c.checks.push({
        id,
        name,
        status: "skipped",
        detail: `no XBRL fact resolved for ${periodLabel} ${end} — cross-check not checkable: ${concept.gap.reason}`,
        asOf: end,
      });
      c.gaps.push({
        ...concept.gap,
        field: `validation.${id}`,
        severity: "info",
        reason: `FMP↔XBRL ${spec.fmpField} cross-check not checkable for ${periodLabel} ${end} — no XBRL fact resolved for that period (${concept.gap.reason})`,
      });
      continue;
    }

    const v = concept.value.data;
    const statementCurrency = normCurrency(row.reportedCurrency);
    const xbrlCurrency = normCurrency(v.unit.split("/")[0]);
    if (statementCurrency !== null && xbrlCurrency !== null && statementCurrency !== xbrlCurrency) {
      c.checks.push({
        id,
        name,
        status: "skipped",
        detail:
          `statement reportedCurrency ${statementCurrency} differs from XBRL unit ${xbrlCurrency} ` +
          `— numeric cross-check suppressed to avoid comparing mixed currencies`,
        asOf: end,
      });
      c.gaps.push(
        gapEntry(
          `validation.${id}`,
          `FMP↔XBRL ${spec.fmpField} cross-check skipped: statement currency ${statementCurrency} != XBRL unit ${xbrlCurrency}`,
          "info",
        ),
      );
      continue;
    }
    const result = crossCheck(fmpValue, v.value, CROSS_CHECK_TOLERANCE_PCT);
    // ProfitLoss (the netIncome fallback tag, tried only when NetIncomeLoss
    // isn't resolved for this period) is a CONSOLIDATED us-gaap figure that can
    // legitimately include noncontrolling interests, diverging from FMP's
    // (attributable-to-common) netIncome by more than the strict tolerance —
    // a known taxonomy nuance, not a data-integrity failure. Downgrade ONLY
    // this specific case from "fail" to a disclosed "warn"; NetIncomeLoss
    // resolutions (no such taxonomy excuse) keep the strict fail. The
    // tolerance NUMBER itself is unchanged for every case.
    const isNetIncomeFallback = spec.concept === "netIncome" && v.tag === "ProfitLoss";
    const status: ValidationCheck["status"] = result.match ? "pass" : isNetIncomeFallback ? "warn" : "fail";
    const fallbackNote = isNetIncomeFallback
      ? " NOTE: resolved via the ProfitLoss fallback (NetIncomeLoss not found for this period) — ProfitLoss is " +
        "a CONSOLIDATED figure that can include noncontrolling interests; a tolerance-exceeding delta is " +
        "downgraded to a disclosed warn, not treated as a data-integrity failure."
      : "";
    const detail =
      `FMP ${fmpValue} vs XBRL ${v.value} (${v.tag}${v.computed ? ", computed sum" : ""}, ` +
      `${v.form} filed ${v.filed}, accn ${v.accn}); Δ ${result.deltaPct}% ` +
      `(tolerance ${CROSS_CHECK_TOLERANCE_PCT}%)${v.note !== undefined ? `; note: ${v.note}` : ""}${fallbackNote}`;
    c.checks.push({
      id,
      name,
      status,
      detail,
      deltaPct: result.deltaPct,
      asOf: end,
    });
    if (!result.match) {
      c.gaps.push(
        gapEntry(
          `validation.${id}`,
          `FMP and XBRL disagree on ${spec.fmpField} by ${result.deltaPct}% for ${periodLabel} ${end} (FMP ${fmpValue}, XBRL ${v.value} via ${v.tag})` +
            `${isNetIncomeFallback ? " — netIncome resolved via ProfitLoss fallback; may reflect consolidated-vs-attributable (NCI) differences rather than a data error" : ""}`,
          "warn",
        ),
      );
    }
  }
}

function checkFmpXbrlCross(bundle: ValidatableBundle, c: Collector): void {
  const factsRes = bundle.edgar.companyFacts;
  if (!factsRes.ok) {
    c.checks.push({
      id: "xbrlCrossCheck",
      name: "FMP↔XBRL cross-check",
      status: "skipped",
      detail: `companyfacts unavailable: ${factsRes.gap.reason}`,
    });
    c.gaps.push(
      gapEntry(
        "validation.xbrlCrossCheck",
        `FMP↔XBRL cross-check skipped — companyfacts unavailable (${factsRes.gap.reason})`,
        "warn",
      ),
    );
    return;
  }
  const facts = factsRes.value.data;

  addFlag(
    c,
    `House rule: FMP↔XBRL cross-check tolerance ${CROSS_CHECK_TOLERANCE_PCT}% on revenue and net income, latest FY + latest quarter (DATA_MAP §2.3).`,
  );

  // Bank-revenue routing (L1): prefer total-revenue bank tags over ASC-606 RFC
  // fee tags when the company routes as a financial (by sector/industry) OR its
  // XBRL is tagged bank-style. routesAsFinancial catches the regional-bank case
  // that ALSO tags fee revenue under RFC (which looksLikeBankTagging cannot, as
  // it requires RFC to be absent); looksLikeBankTagging catches profile-missing
  // banks. For non-financials both are false, so the default RFC-first chain
  // stands.
  const bankStyleTagging = looksLikeBankTagging(facts);
  const bankRevenue = routesAsFinancial(bundle) || bankStyleTagging;
  if (bankStyleTagging) {
    addFlag(
      c,
      "Bank-style XBRL tagging detected — revenue resolved via the bank chain (RevenuesNetOfInterestExpense / Revenues / NII+NonII computed sum).",
    );
  }
  if (bankRevenue) {
    addFlag(
      c,
      "Financial-sector routing — revenue cross-check uses the bank revenue chain: total-revenue tags " +
        "(Revenues / RevenuesNetOfInterestExpense / NII+NonII) are preferred over the ASC-606 " +
        "RevenueFromContractWithCustomer fee tags, which exclude net interest income and would understate a bank's revenue (L1).",
    );
  }

  const annual = bundle.statements.incomeAnnual;
  if (annual.ok && annual.value.data.rows.length > 0) {
    crossCheckRow(facts, byDateDesc(annual.value.data.rows)[0], "FY", bankRevenue, c);
  } else {
    c.checks.push({
      id: "xbrlCrossCheck.FY",
      name: "FMP↔XBRL cross-check (latest FY)",
      status: "skipped",
      detail: annual.ok ? "annual income statement returned zero rows" : `annual income statement unavailable: ${annual.gap.reason}`,
    });
  }

  const quarterly = bundle.statements.incomeQuarterly;
  if (quarterly.ok && quarterly.value.data.rows.length > 0) {
    crossCheckRow(facts, byDateDesc(quarterly.value.data.rows)[0], "Q", bankRevenue, c);
  } else {
    c.checks.push({
      id: "xbrlCrossCheck.Q",
      name: "FMP↔XBRL cross-check (latest quarter)",
      status: "skipped",
      detail: quarterly.ok
        ? "quarterly income statement returned zero rows"
        : `quarterly income statement unavailable: ${quarterly.gap.reason}`,
    });
  }

  // Freshness probe (Citi F23): companyfacts can lag filings by months.
  const newestFact = latestFactEnd(facts, [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "RevenuesNetOfInterestExpense",
    "InterestIncomeExpenseNet",
    "NetIncomeLoss",
    "Assets",
  ]);
  if (annual.ok || quarterly.ok) {
    const newestStatement = newestStatementEnd(bundle);
    if (
      newestFact !== null &&
      newestStatement !== null &&
      parseDateMs(newestStatement) - parseDateMs(newestFact) > 45 * DAY_MS
    ) {
      addFlag(
        c,
        `XBRL companyfacts lags FMP statements: newest fact period end ${newestFact} vs newest statement ${newestStatement} — cross-check may reflect an older filing (Citi-F23 pattern).`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Staleness
// ---------------------------------------------------------------------------

function newestStatementEnd(bundle: ValidatableBundle): string | null {
  let newest: string | null = null;
  for (const res of [bundle.statements.incomeAnnual, bundle.statements.incomeQuarterly]) {
    if (!res.ok) continue;
    for (const row of res.value.data.rows) {
      if (typeof row.date === "string") {
        const d = row.date.slice(0, 10);
        if (newest === null || d > newest) newest = d;
      }
    }
  }
  return newest;
}

function checkStaleness(bundle: ValidatableBundle, now: Date, c: Collector): void {
  // -- fundamentals cadence ---------------------------------------------------
  const newest = newestStatementEnd(bundle);
  if (newest !== null) {
    addFlag(
      c,
      `House rule: fundamentals flagged stale when the newest statement period end predates the latest calendar quarter end ≥${FUNDAMENTALS_STALE_LAG_DAYS} days old (10-Q deadline + slack; ±${FISCAL_CALENDAR_SLACK_DAYS} d for 52/53-week fiscal calendars).`,
    );
    const cutoff = new Date(now.getTime() - FUNDAMENTALS_STALE_LAG_DAYS * DAY_MS);
    const expectedEnd = latestQuarterEndOnOrBefore(cutoff);
    const slackMs = FISCAL_CALENDAR_SLACK_DAYS * DAY_MS;
    const stale = parseDateMs(newest) < parseDateMs(expectedEnd) - slackMs;
    c.checks.push({
      id: "staleness.fundamentals",
      name: "Fundamentals filing cadence",
      status: stale ? "fail" : "pass",
      detail: `newest statement period end ${newest}; expected coverage through calendar quarter end ${expectedEnd}`,
      asOf: newest,
    });
    if (stale) {
      c.flags.push(
        `STALE FUNDAMENTALS: newest statement period end ${newest} is more than one filing cycle behind expected quarter end ${expectedEnd}.`,
      );
      c.gaps.push(
        gapEntry(
          "validation.staleness.fundamentals",
          `fundamentals stale — newest statement ${newest} vs expected quarter end ${expectedEnd}`,
          "warn",
        ),
      );
    }
  } else {
    c.checks.push({
      id: "staleness.fundamentals",
      name: "Fundamentals filing cadence",
      status: "skipped",
      detail: "no dated income-statement rows available",
    });
  }

  // -- quote --------------------------------------------------------------------
  if (bundle.quote.ok) {
    const q = bundle.quote.value;
    const asOfMs = parseDateMs(q.asOf);
    const tooOld = Number.isFinite(asOfMs) && now.getTime() - asOfMs > QUOTE_STALE_DAYS * DAY_MS;
    const servedStale = q.stale === true;
    c.checks.push({
      id: "staleness.quote",
      name: "Quote freshness",
      status: servedStale || tooOld ? "fail" : "pass",
      detail:
        `quote asOf ${q.asOf}, fetchedAt ${q.fetchedAt}` +
        (servedStale ? " (served past TTL — stale-while-revalidate)" : "") +
        (tooOld ? ` (asOf older than ${QUOTE_STALE_DAYS} days)` : ""),
      asOf: q.asOf,
    });
    if (servedStale || tooOld) {
      c.flags.push(
        `STALE QUOTE: ${bundle.symbol} quote asOf ${q.asOf}${servedStale ? " was served past its TTL" : ""} — render with its as-of date.`,
      );
    }
  } else {
    c.checks.push({
      id: "staleness.quote",
      name: "Quote freshness",
      status: "skipped",
      detail: `quote unavailable: ${bundle.quote.gap.reason}`,
    });
  }

  // -- 13F cycle ------------------------------------------------------------------
  const expected13F = resolve13FQuarter(now);
  const inst = bundle.institutional;
  if (inst.positionsSummary.ok) {
    const stale = inst.quarterEnd < expected13F.quarterEnd;
    c.checks.push({
      id: "staleness.institutional13F",
      name: "13F reporting cycle",
      status: stale ? "fail" : "pass",
      detail:
        `bundle holds 13F for ${inst.year} Q${inst.quarter} (quarter end ${inst.quarterEnd}); ` +
        `expected latest filed cycle is ${expected13F.year} Q${expected13F.quarter} (quarter end ${expected13F.quarterEnd}, deadline = quarter end + 45 d)`,
      asOf: inst.quarterEnd,
    });
    if (stale) {
      c.flags.push(
        `STALE 13F: institutional data covers ${inst.year} Q${inst.quarter} but the ${expected13F.year} Q${expected13F.quarter} filing deadline has passed.`,
      );
      c.gaps.push(
        gapEntry(
          "validation.staleness.institutional13F",
          `13F data covers ${inst.quarterEnd} while the ${expected13F.quarterEnd} cycle should be available`,
          "info",
        ),
      );
    }
    addFlag(
      c,
      "13F holdings inherently lag the covered quarter by up to 45 days — label with the reporting quarter, not the fetch date.",
    );
  } else {
    c.checks.push({
      id: "staleness.institutional13F",
      name: "13F reporting cycle",
      status: "skipped",
      detail: `13F positions summary unavailable: ${inst.positionsSummary.gap.reason}`,
    });
  }
}

// ---------------------------------------------------------------------------
// 4. Zero-as-null sweep
// ---------------------------------------------------------------------------

function sweepImplausibleZeros(bundle: ValidatableBundle, c: Collector): void {
  const targets: { label: string; res: FetchResult<{ rows: ValidateIncomeRow[] }> }[] = [
    { label: "incomeAnnual", res: bundle.statements.incomeAnnual },
    { label: "incomeQuarterly", res: bundle.statements.incomeQuarterly },
  ];

  let sweptAny = false;
  for (const t of targets) {
    if (!t.res.ok) continue;
    const rows = byDateDesc(t.res.value.data.rows);
    const latest = rows[0];
    if (latest === undefined) continue;
    sweptAny = true;
    const date = typeof latest.date === "string" ? latest.date.slice(0, 10) : "unknown-date";
    for (const field of IMPLAUSIBLE_ZERO_FIELDS) {
      const v = latest[field];
      if (v === 0) {
        c.gaps.push(
          gapEntry(
            `statements.${t.label}[${date}].${field}`,
            `FMP reported 0 for ${field} — treated as undisclosed (null), not a real zero (DATA_MAP §1.1 zero-vs-undisclosed policy); do not use as a ratio input`,
            "info",
          ),
        );
        c.checks.push({
          id: `zeroAsNull.${t.label}.${field}.${date}`,
          name: `Zero-as-null: ${field} (${t.label} ${date})`,
          status: "fail",
          detail: `${field} = 0 is implausible for a filer — marked undisclosed`,
          asOf: date,
        });
      }
    }
  }
  if (sweptAny) {
    addFlag(
      c,
      `House rule: FMP zeros treated as undisclosed (null) for implausible-zero fields: ${IMPLAUSIBLE_ZERO_FIELDS.join(", ")} (DATA_MAP §1.1).`,
    );
  }
}

// ---------------------------------------------------------------------------
// validateBundle
// ---------------------------------------------------------------------------

/**
 * Run every Stage A validation family over the bundle. Pure and deterministic
 * given `opts.now`. Never throws for missing data — inputs that cannot be
 * validated yield "skipped" checks plus manifest gaps.
 */
/** Uppercased non-empty currency code, or null. */
function normCurrency(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toUpperCase();
  return t.length > 0 ? t : null;
}

/**
 * Reporting-vs-trading currency consistency (audit 2026-07-11 #6).
 *
 * A mismatch (typical of ADRs / foreign issuers) means per-share and multiples
 * figures mix currencies. This is a READ-ONLY Stage-A disclosure: it surfaces
 * the condition in the integrity panel and the manifest but applies NO numeric
 * suppression — Stage B already suppresses the DCF family and flags multiples on
 * the same reportedCurrency≠quoteCurrency signal (valuation.ts). Adding a second
 * suppression here would double-flag; withholding the disclosure would leave the
 * ADR condition visible only in the computed sections, not the integrity panel.
 */
function checkCurrencyConsistency(bundle: ValidatableBundle, c: Collector): void {
  const profileRow = bundle.profile?.ok ? bundle.profile.value.data.rows[0] : undefined;
  const tradingCurrency = normCurrency(profileRow?.currency);

  const income = bundle.statements.incomeAnnual.ok
    ? byDateDesc(bundle.statements.incomeAnnual.value.data.rows)[0]
    : undefined;
  const reportingCurrency = normCurrency(income?.reportedCurrency);

  if (tradingCurrency === null || reportingCurrency === null) {
    c.checks.push({
      id: "currencyConsistency",
      name: "Reporting vs trading currency",
      status: "skipped",
      detail:
        "currency consistency not checkable — " +
        `${tradingCurrency === null ? "profile trading currency" : "statement reporting currency"} unavailable`,
    });
    return;
  }

  const mismatch = tradingCurrency !== reportingCurrency;
  c.checks.push({
    id: "currencyConsistency",
    name: "Reporting vs trading currency",
    status: mismatch ? "warn" : "pass",
    detail: mismatch
      ? `statements reported in ${reportingCurrency} but the security trades in ${tradingCurrency} — per-share/multiples figures mix currencies (ADR/foreign issuer). Stage B suppresses the DCF family on this signal; read multiples with FX caveats.`
      : `statements and quote are both in ${tradingCurrency}.`,
  });

  if (mismatch) {
    addFlag(
      c,
      `CURRENCY MISMATCH: ${bundle.symbol} reports in ${reportingCurrency} but trades in ${tradingCurrency} — FX caveats apply (ADR/foreign issuer).`,
    );
    c.gaps.push(
      gapEntry(
        "validation.currencyMismatch",
        `reporting currency ${reportingCurrency} ≠ trading currency ${tradingCurrency} — per-share/multiples figures mix currencies; the DCF family is suppressed downstream`,
        "warn",
      ),
    );
  }
}

export function validateBundle(
  bundle: ValidatableBundle,
  opts: ValidateOptions = {},
): ValidationReport {
  const now = opts.now ?? new Date();
  const c: Collector = { checks: [], flags: [], gaps: [] };

  checkBalanceSheetIdentity(bundle, c);
  checkFmpXbrlCross(bundle, c);
  checkStaleness(bundle, now, c);
  sweepImplausibleZeros(bundle, c);
  checkCurrencyConsistency(bundle, c);

  return { checks: c.checks, flags: c.flags, gaps: c.gaps };
}
