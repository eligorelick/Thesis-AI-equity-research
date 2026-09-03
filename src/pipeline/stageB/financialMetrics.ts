/**
 * Stage B — route metrics for financial companies (WS5, D-17).
 *
 * PURE, deterministic TypeScript: no network, no db, no LLM. Reads the
 * bundle's EDGAR companyfacts READ-ONLY for the line items a financial
 * statement carries but a vendor income statement does not (noninterest
 * expense, premiums earned, incurred claims, interest expense on deposits),
 * and takes ordinary FMP-shaped balance/income rows for the generic figures.
 *
 * The metric lists in `BASE_POLICIES.lead` named NIM, the efficiency ratio,
 * the combined ratio, book value per share, the net interest spread and
 * leverage for years while nothing computed any of them, so a bank report led
 * with metrics it did not have. This module computes each one where the filer's
 * tags allow it and WITHHOLDS it with a stated reason otherwise — it never
 * approximates a named metric under that name.
 *
 * Two rules the module keeps throughout:
 *
 * 1. A named metric is computed only from the figures its definition calls for.
 *    A true net interest margin divides net interest income by average EARNING
 *    assets; us-gaap has no standard earning-assets concept, and total assets
 *    (which include premises, goodwill and other non-earning items) would
 *    overstate the denominator and understate the margin. So `nim` is withheld
 *    unless the filer tags earning assets, and the honest denominator that IS
 *    available is published beside it under its own name,
 *    `niiToAverageAssets` — never as NIM.
 *
 * 2. A proxy is labeled a proxy. CET1 is a risk-weighted regulatory ratio; when
 *    the filer tags none, tangible common equity over tangible assets is shown
 *    as `tangibleLeverage` with the difference stated. It is a leverage ratio,
 *    not a capital-adequacy ratio, and the report says so.
 *
 * Every value carries the tags that produced it, its formula and its as-of
 * date; every withheld value carries the reason, which reaches the notes and
 * the missing-data manifest.
 */

import { getConcept, type ChainStep, type CompanyFacts } from "@/edgar/xbrl";
import type { FetchResult, ManifestEntry, SectorRoute } from "@/types/core";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type RouteMetricUnit = "%" | "x" | "currency" | "currency/share";

/** One route metric: a value with its provenance, or a withholding with its reason. */
export interface RouteMetric {
  /** Stable id, matching the `lead` ids in the routing metric policy. */
  key: string;
  /** Display name exactly as the report should render it. */
  label: string;
  value: number | null;
  unit: RouteMetricUnit;
  /** Formula and the inputs that produced it (or would have). */
  basis: string;
  /** Source paths for every input, e.g. "edgar:companyfacts us-gaap/Deposits". */
  sources: string[];
  /** Period end the figure is measured at. */
  asOf: string | null;
  /** Non-null when the metric was withheld; the reason reaches the manifest. */
  withheldReason: string | null;
  /**
   * True when the figure is a deliberate stand-in for a metric the filer does
   * not tag (e.g. tangible leverage where CET1 is unavailable). Proxies are
   * always published under their OWN name, never the name they stand in for.
   */
  proxy: boolean;
}

export interface FinancialMetricsResult {
  route: SectorRoute;
  metrics: RouteMetric[];
  notes: string[];
  gaps: ManifestEntry[];
  /** Newest period end any metric was measured at. */
  asOf: string | null;
}

/** Balance-sheet slice (FMP field names; the same rows Stage B already builds). */
export interface FinancialMetricsBalanceRow {
  date: string;
  totalAssets?: number | null;
  totalStockholdersEquity?: number | null;
  totalEquity?: number | null;
  goodwill?: number | null;
  intangibleAssets?: number | null;
  preferredStock?: number | null;
}

/** Income slice (FMP field names). */
export interface FinancialMetricsIncomeRow {
  date: string;
  revenue?: number | null;
  netIncome?: number | null;
  interestIncome?: number | null;
  interestExpense?: number | null;
  netInterestIncome?: number | null;
}

export interface FinancialMetricsInputs {
  /** EDGAR companyfacts, read-only. Null/failed ⇒ tag-level metrics withheld. */
  companyFacts: FetchResult<CompanyFacts> | null | undefined;
  /** Annual balance rows, NEWEST FIRST (index 1 supplies the prior balance for averages). */
  balance: readonly FinancialMetricsBalanceRow[];
  /** Annual income rows, NEWEST FIRST. */
  income: readonly FinancialMetricsIncomeRow[];
  /** Share count for per-share metrics (diluted or outstanding). */
  shares?: number | null;
  /** What `shares` is, for the basis string. */
  sharesBasis?: string | null;
}

// ---------------------------------------------------------------------------
// Tag chains. Each entry lists the us-gaap elements that carry one figure,
// most specific first. Exported so the tests pin the vocabulary.
// ---------------------------------------------------------------------------

export const NET_INTEREST_INCOME_TAGS = ["InterestIncomeExpenseNet"] as const;
export const NONINTEREST_INCOME_TAGS = ["NoninterestIncome"] as const;
export const NONINTEREST_EXPENSE_TAGS = ["NoninterestExpense"] as const;
/**
 * Average earning assets. us-gaap carries no standard concept for these; the
 * few filers that tag one use these elements. When none resolves, NIM is
 * withheld rather than computed on total assets.
 */
export const EARNING_ASSETS_TAGS = [
  "InterestEarningAssets",
  "AverageEarningAssets",
  "InterestBearingAssets",
] as const;
export const LOANS_TAGS = [
  "LoansAndLeasesReceivableNetReportedAmount",
  "FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss",
  "LoansAndLeasesReceivableGrossCarryingAmount",
  "FinancingReceivableExcludingAccruedInterestBeforeAllowanceForCreditLoss",
] as const;
export const NONACCRUAL_LOAN_TAGS = [
  "FinancingReceivableExcludingAccruedInterestNonaccrualStatus",
  "FinancingReceivableRecordedInvestmentNonaccrualStatus",
  "LoansAndLeasesReceivableNonaccrualStatus",
  "FinancingReceivableExcludingAccruedInterestNonaccrualStatusWithAllowanceForCreditLoss",
] as const;
export const PROVISION_TAGS = [
  "ProvisionForLoanLeaseAndOtherLosses",
  "ProvisionForLoanLossesExpensed",
  "ProvisionForCreditLossExpenseReversal",
  "ProvisionForLoanAndLeaseLosses",
] as const;
export const DEPOSITS_TAGS = ["Deposits"] as const;
export const INTEREST_EXPENSE_DEPOSITS_TAGS = [
  "InterestExpenseDeposits",
  "InterestExpenseDomesticDeposits",
] as const;
export const CET1_TAGS = [
  "CommonEquityTierOneCapitalToRiskWeightedAssets",
  "TierOneCommonCapitalToRiskWeightedAssets",
  "BankingRegulatoryCommonEquityTierOneRiskBasedCapitalToRiskWeightedAssets",
] as const;

export const PREMIUMS_EARNED_TAGS = [
  "PremiumsEarnedNet",
  "PremiumsEarnedNetPropertyAndCasualty",
  "PremiumsEarnedNetLife",
] as const;
export const INCURRED_CLAIMS_TAGS = [
  "PolicyholderBenefitsAndClaimsIncurredNet",
  "PolicyholderBenefitsAndClaimsIncurredHealthCare",
  "LiabilityForClaimsAndClaimsAdjustmentExpenseIncurredClaims",
] as const;
/**
 * The two components a GAAP underwriting-expense figure is made of. BOTH are
 * required before an expense ratio is published — see `insurerMetrics`.
 *
 * `InsuranceCommissionsAndFees` used to sit here and does not belong: it is a
 * credit-balance REVENUE element (commission and fee income an insurer earns),
 * so adding it inflated both the expense ratio and the combined ratio. us-gaap
 * carries no unambiguous single underwriting-expense total to fall back on, so
 * there is no third "total" element in this list.
 */
export const UNDERWRITING_EXPENSE_TAGS = [
  "OtherUnderwritingExpense",
  "DeferredPolicyAcquisitionCostAmortizationExpense",
] as const;
export const PRIOR_YEAR_DEVELOPMENT_TAGS = [
  "LiabilityForUnpaidClaimsAndClaimsAdjustmentExpenseIncurredClaimsPriorYears",
  "LiabilityForClaimsAndClaimsAdjustmentExpenseIncurredClaimsPriorYears",
] as const;

export const REPO_FUNDING_TAGS = ["SecuritiesSoldUnderAgreementsToRepurchase"] as const;
export const INTEREST_INCOME_OPERATING_TAGS = [
  "InterestAndDividendIncomeOperating",
  "InterestIncomeOperating",
  "InterestAndFeeIncomeLoansAndLeases",
] as const;
export const INTEREST_EXPENSE_TAGS = [
  "InterestExpense",
  "InterestExpenseBorrowings",
  "InterestExpenseDebt",
] as const;

/** NAREIT FFO components (criterion e). */
export const REAL_ESTATE_DEPRECIATION_TAGS = [
  "RealEstateInvestmentPropertyAccumulatedDepreciationPeriodIncreaseDecrease",
  "DepreciationAndAmortizationRealEstate",
  "RealEstateDepreciation",
] as const;
/**
 * Gains on property sales, which NAREIT subtracts from net income.
 * `GainsLossesOnSalesOfInvestmentRealEstate` is the element most equity REITs
 * use and was missing, so a REIT with a 300m disposition gain had FFO
 * overstated by that amount while the note said only "none tagged; treated as
 * zero". `GainLossOnDispositionOfAssets1` is gone: it covers disposals of any
 * asset, and NAREIT excludes gains on sales of DEPRECIABLE REAL ESTATE, not
 * gains on selling a subsidiary or a piece of equipment.
 */
export const PROPERTY_SALE_GAIN_TAGS = [
  "GainLossOnSaleOfPropertiesNetOfApplicableIncomeTaxes",
  "GainLossOnSaleOfProperties",
  "GainsLossesOnSalesOfInvestmentRealEstate",
  "GainLossOnSaleOfRealEstate",
] as const;
/**
 * Impairments NAREIT adds back: those attributable to DEPRECIABLE REAL ESTATE.
 * A goodwill or securities write-down is not one of them, which is why
 * `AssetImpairmentCharges` is no longer chained in here and
 * `ImpairmentOfInvestments` is gone entirely.
 */
export const REAL_ESTATE_IMPAIRMENT_TAGS = ["ImpairmentOfRealEstate"] as const;
/**
 * The generic charge, used only as a labeled stand-in when the real-estate
 * element is untagged — it may carry goodwill or other non-real-estate
 * write-downs, so adding it back puts FFO at or ABOVE the definition, the same
 * direction the total-D&A stand-in errs in.
 */
export const GENERIC_IMPAIRMENT_TAGS = ["AssetImpairmentCharges"] as const;
export const STRAIGHT_LINE_RENT_TAGS = [
  "StraightLineRent",
  "AmortizationOfDeferredLeasingFeesAndStraightLineRent",
] as const;
export const RECURRING_CAPEX_TAGS = [
  "PaymentsForCapitalImprovements",
  "PaymentsToDevelopRealEstateAssets",
] as const;
export const DEPRECIATION_AMORTIZATION_TAGS = [
  "DepreciationDepletionAndAmortization",
  "DepreciationAndAmortization",
] as const;
export const NET_INCOME_TAGS = ["NetIncomeLoss", "ProfitLoss"] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

const pos = (v: number | null | undefined): number | null => (isNum(v) && v > 0 ? v : null);

function tagPath(tag: string): string {
  return `edgar:companyfacts us-gaap/${tag}`;
}

interface TagHit {
  value: number;
  tag: string;
  end: string;
  sourcePath: string;
}

/** Resolve the first tag in `tags` carrying a fact for the period, or null. */
function resolveTag(
  facts: CompanyFacts | null,
  tags: readonly string[],
  period: { end: string; durationHint?: "FY" | "Q" },
): TagHit | null {
  if (facts === null) return null;
  const chain: ChainStep[] = tags.map((tag) => ({ kind: "tag", tag }));
  const r = getConcept(facts, chain, { period });
  if (!r.ok) return null;
  const v = r.value.data;
  return { value: v.value, tag: v.tag, end: v.period.end, sourcePath: tagPath(v.tag) };
}

/** Sum every tag in `tags` that resolves; null when none does. */
function resolveSum(
  facts: CompanyFacts | null,
  tags: readonly string[],
  period: { end: string; durationHint?: "FY" | "Q" },
): { value: number; hits: TagHit[] } | null {
  if (facts === null) return null;
  const hits: TagHit[] = [];
  for (const tag of tags) {
    const hit = resolveTag(facts, [tag], period);
    if (hit !== null) hits.push(hit);
  }
  if (hits.length === 0) return null;
  return { value: hits.reduce((s, h) => s + h.value, 0), hits };
}

function metric(init: Partial<RouteMetric> & Pick<RouteMetric, "key" | "label" | "unit">): RouteMetric {
  return {
    value: null,
    basis: "",
    sources: [],
    asOf: null,
    withheldReason: null,
    proxy: false,
    ...init,
  };
}

/** A withheld metric: value null, reason stated. */
function withheld(
  key: string,
  label: string,
  unit: RouteMetricUnit,
  reason: string,
  basis: string,
  sources: string[] = [],
): RouteMetric {
  return metric({ key, label, unit, withheldReason: reason, basis, sources });
}

/** Average of a current and prior balance; falls back to the single point. */
function average(current: number | null, prior: number | null): { value: number | null; basis: string } {
  if (current === null) return { value: null, basis: "no current balance" };
  if (prior === null) return { value: current, basis: "single period-end balance (no prior year on file)" };
  return { value: (current + prior) / 2, basis: "average of the current and prior period-end balances" };
}

function tangible(row: FinancialMetricsBalanceRow | undefined): {
  equity: number | null;
  assets: number | null;
} {
  if (row === undefined) return { equity: null, assets: null };
  const goodwill = isNum(row.goodwill) ? row.goodwill : 0;
  const intangibles = isNum(row.intangibleAssets) ? row.intangibleAssets : 0;
  const preferred = isNum(row.preferredStock) ? row.preferredStock : 0;
  const equityRaw = isNum(row.totalStockholdersEquity) ? row.totalStockholdersEquity : null;
  const assetsRaw = isNum(row.totalAssets) ? row.totalAssets : null;
  return {
    equity: equityRaw === null ? null : equityRaw - goodwill - intangibles - preferred,
    assets: assetsRaw === null ? null : assetsRaw - goodwill - intangibles,
  };
}

// ---------------------------------------------------------------------------
// Bank metrics
// ---------------------------------------------------------------------------

function bankMetrics(
  facts: CompanyFacts | null,
  inputs: FinancialMetricsInputs,
  factsReason: string | null,
): RouteMetric[] {
  const out: RouteMetric[] = [];
  const bal0 = inputs.balance[0];
  const bal1 = inputs.balance[1];
  const inc0 = inputs.income[0];
  const end = bal0?.date ?? inc0?.date ?? null;
  const flow = end === null ? null : { end, durationHint: "FY" as const };
  const instant = end === null ? null : { end };
  const priorInstant = bal1 === undefined ? null : { end: bal1.date };
  const noPeriod = "no annual statement period available — metric not computed";
  const noFacts = factsReason ?? "EDGAR companyfacts unavailable — XBRL line items could not be read";

  // --- net interest income (the numerator several metrics share)
  const nii =
    flow === null
      ? null
      : (resolveTag(facts, NET_INTEREST_INCOME_TAGS, flow) ??
        (isNum(inc0?.netInterestIncome)
          ? { value: inc0.netInterestIncome, tag: "netInterestIncome", end: inc0.date, sourcePath: "statements:income.netInterestIncome" }
          : null));

  // --- NIM: only on EARNING assets, never on total assets.
  const earning = instant === null ? null : resolveTag(facts, EARNING_ASSETS_TAGS, instant);
  const earningPrior = priorInstant === null ? null : resolveTag(facts, EARNING_ASSETS_TAGS, priorInstant);
  if (nii !== null && earning !== null) {
    const avg = average(earning.value, earningPrior?.value ?? null);
    const denom = pos(avg.value);
    out.push(
      denom === null
        ? withheld(
            "nim",
            "net interest margin",
            "%",
            "average earning assets are not positive — margin not computable",
            "net interest income / average earning assets",
            [nii.sourcePath, earning.sourcePath],
          )
        : metric({
            key: "nim",
            label: "net interest margin",
            unit: "%",
            value: (nii.value / denom) * 100,
            basis: `net interest income ${nii.value} / average earning assets ${denom} (${avg.basis}) × 100`,
            sources: [nii.sourcePath, earning.sourcePath, ...(earningPrior ? [earningPrior.sourcePath] : [])],
            asOf: end,
          }),
    );
  } else {
    out.push(
      withheld(
        "nim",
        "net interest margin",
        "%",
        nii === null
          ? `net interest income unavailable (${flow === null ? noPeriod : `no ${NET_INTEREST_INCOME_TAGS.join("/")} fact for ${end}`}) — NIM not computed`
          : "the filer tags no earning-assets element (us-gaap has no standard average-earning-assets concept), and total assets include premises, goodwill and other non-earning items — dividing by them would understate the margin, so NIM is withheld and net interest income / average TOTAL assets is published under its own name instead",
        "net interest income / average EARNING assets",
        [...(nii ? [nii.sourcePath] : []), ...EARNING_ASSETS_TAGS.map(tagPath)],
      ),
    );
    // The honest denominator that IS available, under its own name.
    const avgAssets = average(
      isNum(bal0?.totalAssets) ? bal0.totalAssets : null,
      isNum(bal1?.totalAssets) ? bal1.totalAssets : null,
    );
    const denom = pos(avgAssets.value);
    out.push(
      nii !== null && denom !== null
        ? metric({
            key: "niiToAverageAssets",
            label: "net interest income / average total assets",
            unit: "%",
            value: (nii.value / denom) * 100,
            basis:
              `net interest income ${nii.value} / average TOTAL assets ${denom} (${avgAssets.basis}) × 100. ` +
              "NOT the net interest margin: the denominator includes non-earning assets, so this figure sits BELOW a true NIM.",
            sources: [nii.sourcePath, "statements:balance.totalAssets"],
            asOf: end,
            proxy: true,
          })
        : withheld(
            "niiToAverageAssets",
            "net interest income / average total assets",
            "%",
            nii === null ? "net interest income unavailable" : "total assets unavailable or not positive",
            "net interest income / average total assets",
            [...(nii ? [nii.sourcePath] : []), "statements:balance.totalAssets"],
          ),
    );
  }

  // --- efficiency ratio = noninterest expense / (net interest income + noninterest income)
  const nonIntExp = flow === null ? null : resolveTag(facts, NONINTEREST_EXPENSE_TAGS, flow);
  const nonIntInc = flow === null ? null : resolveTag(facts, NONINTEREST_INCOME_TAGS, flow);
  if (nonIntExp !== null && nonIntInc !== null && nii !== null) {
    const revenue = nii.value + nonIntInc.value;
    out.push(
      pos(revenue) === null
        ? withheld(
            "efficiencyRatio",
            "efficiency ratio",
            "%",
            "net interest income plus noninterest income is not positive — ratio not meaningful",
            "noninterest expense / (net interest income + noninterest income)",
            [nonIntExp.sourcePath, nii.sourcePath, nonIntInc.sourcePath],
          )
        : metric({
            key: "efficiencyRatio",
            label: "efficiency ratio",
            unit: "%",
            value: (nonIntExp.value / revenue) * 100,
            basis:
              `noninterest expense ${nonIntExp.value} / (net interest income ${nii.value} + noninterest income ` +
              `${nonIntInc.value} = ${revenue}) × 100 — lower is better; revenue is net of interest expense, the ` +
              "denominator banks report it on",
            sources: [nonIntExp.sourcePath, nii.sourcePath, nonIntInc.sourcePath],
            asOf: end,
          }),
    );
  } else {
    const missing: string[] = [];
    if (nonIntExp === null) missing.push(NONINTEREST_EXPENSE_TAGS[0]);
    if (nonIntInc === null) missing.push(NONINTEREST_INCOME_TAGS[0]);
    if (nii === null) missing.push(NET_INTEREST_INCOME_TAGS[0]);
    out.push(
      withheld(
        "efficiencyRatio",
        "efficiency ratio",
        "%",
        flow === null
          ? noPeriod
          : facts === null
            ? `${noFacts} — the noninterest income/expense split exists only in the filings`
            : `the filer tags no ${missing.join(" / ")} fact for ${end} — the ratio needs the noninterest split and cannot be approximated from a vendor income statement`,
        "noninterest expense / (net interest income + noninterest income)",
        missing.map(tagPath),
      ),
    );
  }

  // --- CET1 (reported) or the labeled tangible-leverage proxy
  const cet1 = instant === null ? null : resolveTag(facts, CET1_TAGS, instant);
  if (cet1 !== null) {
    // Filers tag the ratio either as a fraction (0.15) or as a percent (15).
    const asPct = cet1.value <= 1 ? cet1.value * 100 : cet1.value;
    out.push(
      metric({
        key: "cet1Reported",
        label: "CET1 ratio (as reported)",
        unit: "%",
        value: asPct,
        basis: `company-reported common equity tier 1 capital / risk-weighted assets, tagged ${cet1.tag}${cet1.value <= 1 ? " (filed as a fraction, rendered as a percent)" : ""}`,
        sources: [cet1.sourcePath],
        asOf: cet1.end,
      }),
    );
  } else {
    out.push(
      withheld(
        "cet1Reported",
        "CET1 ratio (as reported)",
        "%",
        facts === null
          ? noFacts
          : "the filer tags no CET1 element in companyfacts (the ratio is commonly disclosed only in the regulatory-capital footnote text) — the tangible leverage ratio below is shown in its place, and is NOT a substitute",
        "company-reported CET1 capital / risk-weighted assets",
        CET1_TAGS.map(tagPath),
      ),
    );
    const t = tangible(bal0);
    const denom = pos(t.assets);
    out.push(
      t.equity !== null && denom !== null
        ? metric({
            key: "tangibleLeverage",
            label: "tangible common equity / tangible assets",
            unit: "%",
            value: (t.equity / denom) * 100,
            basis:
              `(equity − goodwill − other intangibles − preferred) ${t.equity} / (total assets − goodwill − other ` +
              `intangibles) ${denom} × 100. A LEVERAGE ratio standing in for CET1: it does not risk-weight assets, ` +
              "so it is not comparable to a regulatory capital ratio and is always the more conservative read.",
            sources: [
              "statements:balance.totalStockholdersEquity",
              "statements:balance.totalAssets",
              "statements:balance.goodwill",
              "statements:balance.intangibleAssets",
              "statements:balance.preferredStock",
            ],
            asOf: bal0?.date ?? null,
            proxy: true,
          })
        : withheld(
            "tangibleLeverage",
            "tangible common equity / tangible assets",
            "%",
            "total equity and/or total assets unavailable — the CET1 stand-in could not be computed either",
            "(equity − goodwill − intangibles − preferred) / (assets − goodwill − intangibles)",
            ["statements:balance.totalStockholdersEquity", "statements:balance.totalAssets"],
          ),
    );
  }

  // --- loans (denominator for NPL and provisions)
  const loans = instant === null ? null : resolveTag(facts, LOANS_TAGS, instant);

  // --- NPL ratio
  const nonaccrual = instant === null ? null : resolveTag(facts, NONACCRUAL_LOAN_TAGS, instant);
  out.push(
    nonaccrual !== null && loans !== null && pos(loans.value) !== null
      ? metric({
          key: "nplRatio",
          label: "nonperforming loan ratio",
          unit: "%",
          value: (nonaccrual.value / loans.value) * 100,
          basis: `nonaccrual loans ${nonaccrual.value} (${nonaccrual.tag}) / total loans ${loans.value} (${loans.tag}) × 100`,
          sources: [nonaccrual.sourcePath, loans.sourcePath],
          asOf: end,
        })
      : withheld(
          "nplRatio",
          "nonperforming loan ratio",
          "%",
          facts === null
            ? noFacts
            : nonaccrual === null
              ? "the filer reports nonaccrual loans only by loan class (a dimensional fact), and companyfacts carries no undimensioned total — the ratio would have to sum classes the payload does not expose"
              : "total loans unavailable or not positive — NPL denominator missing",
          "nonaccrual loans / total loans",
          [...NONACCRUAL_LOAN_TAGS.map(tagPath), ...LOANS_TAGS.slice(0, 1).map(tagPath)],
        ),
  );

  // --- provisions / loans
  const provision = flow === null ? null : resolveTag(facts, PROVISION_TAGS, flow);
  out.push(
    provision !== null && loans !== null && pos(loans.value) !== null
      ? metric({
          key: "provisionsToLoans",
          label: "provisions / loans",
          unit: "%",
          value: (provision.value / loans.value) * 100,
          basis: `provision for credit losses ${provision.value} (${provision.tag}) / total loans ${loans.value} (${loans.tag}) × 100 — the annual credit cost of the book`,
          sources: [provision.sourcePath, loans.sourcePath],
          asOf: end,
        })
      : withheld(
          "provisionsToLoans",
          "provisions / loans",
          "%",
          facts === null
            ? noFacts
            : provision === null
              ? `the filer tags no provision element for ${end} (some banks report it only as a sum of the financing-receivable and off-balance-sheet components)`
              : "total loans unavailable or not positive — provisions cannot be scaled",
          "provision for credit losses / total loans",
          [...PROVISION_TAGS.slice(0, 2).map(tagPath), ...LOANS_TAGS.slice(0, 1).map(tagPath)],
        ),
  );

  // --- deposit cost = interest expense on deposits / average deposits
  const depInterest = flow === null ? null : resolveTag(facts, INTEREST_EXPENSE_DEPOSITS_TAGS, flow);
  const deposits = instant === null ? null : resolveTag(facts, DEPOSITS_TAGS, instant);
  const depositsPrior = priorInstant === null ? null : resolveTag(facts, DEPOSITS_TAGS, priorInstant);
  if (depInterest !== null && deposits !== null) {
    const avg = average(deposits.value, depositsPrior?.value ?? null);
    const denom = pos(avg.value);
    out.push(
      denom === null
        ? withheld(
            "depositCost",
            "cost of deposits",
            "%",
            "average deposits are not positive — cost not computable",
            "interest expense on deposits / average deposits",
            [depInterest.sourcePath, deposits.sourcePath],
          )
        : metric({
            key: "depositCost",
            label: "cost of deposits",
            unit: "%",
            value: (depInterest.value / denom) * 100,
            basis: `interest expense on deposits ${depInterest.value} (${depInterest.tag}) / average deposits ${denom} (${avg.basis}) × 100`,
            sources: [depInterest.sourcePath, deposits.sourcePath, ...(depositsPrior ? [depositsPrior.sourcePath] : [])],
            asOf: end,
          }),
    );
  } else {
    out.push(
      withheld(
        "depositCost",
        "cost of deposits",
        "%",
        facts === null
          ? noFacts
          : depInterest === null
            ? `the filer tags no ${INTEREST_EXPENSE_DEPOSITS_TAGS[0]} fact for ${end} — total interest expense covers borrowings too and would overstate the deposit cost`
            : "deposits unavailable — denominator missing",
        "interest expense on deposits / average deposits",
        [...INTEREST_EXPENSE_DEPOSITS_TAGS.map(tagPath), ...DEPOSITS_TAGS.map(tagPath)],
      ),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Insurer metrics
// ---------------------------------------------------------------------------

function insurerMetrics(
  facts: CompanyFacts | null,
  inputs: FinancialMetricsInputs,
  factsReason: string | null,
): RouteMetric[] {
  const out: RouteMetric[] = [];
  const inc0 = inputs.income[0];
  const end = inc0?.date ?? inputs.balance[0]?.date ?? null;
  const flow = end === null ? null : { end, durationHint: "FY" as const };
  const noFacts = factsReason ?? "EDGAR companyfacts unavailable — XBRL line items could not be read";

  const premiums = flow === null ? null : resolveTag(facts, PREMIUMS_EARNED_TAGS, flow);
  const claims = flow === null ? null : resolveTag(facts, INCURRED_CLAIMS_TAGS, flow);
  // `resolveSum` returns a value as soon as ANY component resolves. A partial
  // component sum is not an underwriting-expense total: an insurer tagging only
  // its deferred-acquisition-cost amortisation would publish a 12% expense ratio
  // and a 77% combined ratio — an underwriter that does not exist — which is the
  // very failure the "combined ratio is withheld when either half is missing"
  // rule exists to prevent. Both components are required, and the withholding
  // names the one that is absent.
  const underwritingSum = flow === null ? null : resolveSum(facts, UNDERWRITING_EXPENSE_TAGS, flow);
  const underwritingMissing = UNDERWRITING_EXPENSE_TAGS.filter(
    (tag) => !(underwritingSum?.hits ?? []).some((h) => h.tag === tag),
  );
  const underwriting = underwritingMissing.length === 0 ? underwritingSum : null;

  const premiumBase = premiums === null ? null : pos(premiums.value);
  const denomNote =
    "denominator is GAAP premiums EARNED; a statutory expense ratio divides by premiums WRITTEN, so this figure is not directly comparable to a statutory filing";

  // --- loss ratio
  const lossRatio =
    claims !== null && premiumBase !== null ? (claims.value / premiumBase) * 100 : null;
  out.push(
    lossRatio !== null && claims !== null && premiums !== null
      ? metric({
          key: "lossRatio",
          label: "loss ratio",
          unit: "%",
          value: lossRatio,
          basis: `incurred claims ${claims.value} (${claims.tag}) / premiums earned ${premiumBase} (${premiums.tag}) × 100`,
          sources: [claims.sourcePath, premiums.sourcePath],
          asOf: end,
        })
      : withheld(
          "lossRatio",
          "loss ratio",
          "%",
          facts === null
            ? noFacts
            : claims === null
              ? `the filer tags no incurred-claims element for ${end}`
              : "premiums earned unavailable or not positive — loss ratio denominator missing",
          "incurred claims / premiums earned",
          [...INCURRED_CLAIMS_TAGS.slice(0, 1).map(tagPath), ...PREMIUMS_EARNED_TAGS.slice(0, 1).map(tagPath)],
        ),
  );

  // --- expense ratio
  const expenseRatio =
    underwriting !== null && premiumBase !== null ? (underwriting.value / premiumBase) * 100 : null;
  out.push(
    expenseRatio !== null && underwriting !== null && premiums !== null
      ? metric({
          key: "expenseRatio",
          label: "expense ratio",
          unit: "%",
          value: expenseRatio,
          basis:
            `underwriting expenses ${underwriting.value} (${underwriting.hits.map((h) => h.tag).join(" + ")}) / ` +
            `premiums earned ${premiumBase} (${premiums.tag}) × 100 — ${denomNote}`,
          sources: [...underwriting.hits.map((h) => h.sourcePath), premiums.sourcePath],
          asOf: end,
        })
      : withheld(
          "expenseRatio",
          "expense ratio",
          "%",
          facts === null
            ? noFacts
            : underwritingSum === null
              ? `the filer tags no underwriting-expense element for ${end} (acquisition costs and other underwriting expenses are often reported only in the expense footnote)`
              : underwritingMissing.length > 0
                ? `the filer tags ${underwritingSum.hits.map((h) => h.tag).join(" + ")} but not ${underwritingMissing.join(" or ")} for ${end} — a PARTIAL component sum is not an underwriting-expense total, and publishing it would understate the expense ratio and the combined ratio, so it is withheld`
                : "premiums earned unavailable or not positive — expense ratio denominator missing",
          "underwriting expenses / premiums earned",
          [...UNDERWRITING_EXPENSE_TAGS.map(tagPath), ...PREMIUMS_EARNED_TAGS.slice(0, 1).map(tagPath)],
        ),
  );

  // --- combined ratio = loss + expense; both halves required.
  out.push(
    lossRatio !== null && expenseRatio !== null
      ? metric({
          key: "combinedRatio",
          label: "combined ratio",
          unit: "%",
          value: lossRatio + expenseRatio,
          basis:
            `loss ratio ${lossRatio.toFixed(2)}% + expense ratio ${expenseRatio.toFixed(2)}%. Computed from XBRL, ` +
            `NOT the company-reported combined ratio, which is the gold standard: ${denomNote}. Above 100% means ` +
            "underwriting lost money before investment income.",
          sources: ["computed.financialMetrics.lossRatio", "computed.financialMetrics.expenseRatio"],
          asOf: end,
          proxy: true,
        })
      : withheld(
          "combinedRatio",
          "combined ratio",
          "%",
          `${lossRatio === null ? "loss ratio" : "expense ratio"} unavailable — a combined ratio missing either half would understate underwriting cost, so it is withheld rather than reported partial`,
          "loss ratio + expense ratio",
          ["computed.financialMetrics.lossRatio", "computed.financialMetrics.expenseRatio"],
        ),
  );

  // --- prior-year reserve development
  const development = flow === null ? null : resolveTag(facts, PRIOR_YEAR_DEVELOPMENT_TAGS, flow);
  out.push(
    development !== null
      ? metric({
          key: "reserveDevelopment",
          label: "prior-year reserve development",
          unit: "currency",
          value: development.value,
          basis:
            `incurred claims attributable to PRIOR accident years ${development.value} (${development.tag}). ` +
            "Positive = adverse development (reserves were too low); negative = favourable release.",
          sources: [development.sourcePath],
          asOf: end,
        })
      : withheld(
          "reserveDevelopment",
          "prior-year reserve development",
          "currency",
          facts === null
            ? noFacts
            : "the filer tags no prior-year development element (the claims-development table is usually filed as dimensional facts by accident year, which companyfacts does not expose as a single total)",
          "incurred claims attributable to prior accident years",
          PRIOR_YEAR_DEVELOPMENT_TAGS.map(tagPath),
        ),
  );

  return out;
}

// ---------------------------------------------------------------------------
// Mortgage-REIT metrics
// ---------------------------------------------------------------------------

function mortgageReitMetrics(
  facts: CompanyFacts | null,
  inputs: FinancialMetricsInputs,
  factsReason: string | null,
): RouteMetric[] {
  const out: RouteMetric[] = [];
  const bal0 = inputs.balance[0];
  const bal1 = inputs.balance[1];
  const inc0 = inputs.income[0];
  const end = bal0?.date ?? inc0?.date ?? null;
  const flow = end === null ? null : { end, durationHint: "FY" as const };
  const instant = end === null ? null : { end };
  const priorInstant = bal1 === undefined ? null : { end: bal1.date };
  const noFacts = factsReason ?? "EDGAR companyfacts unavailable — XBRL line items could not be read";

  // --- book value per share (common)
  const equity = isNum(bal0?.totalStockholdersEquity) ? bal0.totalStockholdersEquity : null;
  const preferred = isNum(bal0?.preferredStock) ? bal0.preferredStock : 0;
  const shares = pos(inputs.shares ?? null);
  out.push(
    equity !== null && shares !== null
      ? metric({
          key: "bookValuePerShare",
          label: "book value per share",
          unit: "currency/share",
          value: (equity - preferred) / shares,
          basis:
            `(total stockholders' equity ${equity} − preferred ${preferred}) / ${inputs.sharesBasis ?? "shares"} ` +
            `${shares}. Book value is the mortgage REIT's headline: its assets are marked securities, so equity is ` +
            "close to liquidation value and P/B is the primary multiple.",
          sources: [
            "statements:balance.totalStockholdersEquity",
            "statements:balance.preferredStock",
            inputs.sharesBasis ?? "statements:income.weightedAverageShsOutDil",
          ],
          asOf: bal0?.date ?? null,
        })
      : withheld(
          "bookValuePerShare",
          "book value per share",
          "currency/share",
          equity === null ? "total stockholders' equity unavailable" : "share count unavailable or not positive",
          "(total equity − preferred) / shares",
          ["statements:balance.totalStockholdersEquity", "statements:income.weightedAverageShsOutDil"],
        ),
  );

  // --- leverage = assets / equity
  const assets = isNum(bal0?.totalAssets) ? bal0.totalAssets : null;
  out.push(
    assets !== null && equity !== null && equity > 0
      ? metric({
          key: "leverageAssetsToEquity",
          label: "leverage (assets / equity)",
          unit: "x",
          value: assets / equity,
          basis: `total assets ${assets} / total stockholders' equity ${equity}. Repo-funded balance sheets commonly run 5-10x; the ratio is the risk the book carries, not a solvency verdict.`,
          sources: ["statements:balance.totalAssets", "statements:balance.totalStockholdersEquity"],
          asOf: bal0?.date ?? null,
        })
      : withheld(
          "leverageAssetsToEquity",
          "leverage (assets / equity)",
          "x",
          assets === null ? "total assets unavailable" : "total equity unavailable or not positive",
          "total assets / total equity",
          ["statements:balance.totalAssets", "statements:balance.totalStockholdersEquity"],
        ),
  );

  // --- net interest spread = asset yield − funding cost
  const intIncome =
    flow === null
      ? null
      : (resolveTag(facts, INTEREST_INCOME_OPERATING_TAGS, flow) ??
        (isNum(inc0?.interestIncome)
          ? { value: inc0.interestIncome, tag: "interestIncome", end: inc0.date, sourcePath: "statements:income.interestIncome" }
          : null));
  const intExpense =
    flow === null
      ? null
      : (resolveTag(facts, INTEREST_EXPENSE_TAGS, flow) ??
        (isNum(inc0?.interestExpense)
          ? { value: inc0.interestExpense, tag: "interestExpense", end: inc0.date, sourcePath: "statements:income.interestExpense" }
          : null));
  const repo = instant === null ? null : resolveTag(facts, REPO_FUNDING_TAGS, instant);
  const repoPrior = priorInstant === null ? null : resolveTag(facts, REPO_FUNDING_TAGS, priorInstant);

  const avgAssets = average(assets, isNum(bal1?.totalAssets) ? bal1.totalAssets : null);
  const assetDenom = pos(avgAssets.value);
  // The funding leg is averaged the same way the asset leg is. Dividing a
  // full-year interest expense by a period-END balance while the other leg used
  // an average made the two halves of the spread incomparable even before the
  // numerator problem below.
  const avgRepo = repo === null ? { value: null, basis: "" } : average(repo.value, repoPrior?.value ?? null);
  const fundingDenom = pos(avgRepo.value);

  // The NAMED metric is interest expense over average INTEREST-BEARING
  // LIABILITIES. companyfacts exposes only the repurchase-agreement balance,
  // while the interest-expense numerator covers every borrowing the REIT runs,
  // so the two do not match and the quotient overstates the cost of funds —
  // enough to flip the sign of the spread for a REIT with non-repo debt
  // (interest income 3.9bn on average assets 75bn against interest expense
  // 3.0bn over 50bn of repo printed -0.8% for a company reporting a positive
  // spread). The named figure is therefore WITHHELD and the repo-funded
  // computation is published under its own name, exactly as NIM is withheld in
  // favour of net interest income over average total assets.
  out.push(
    withheld(
      "netInterestSpread",
      "net interest spread",
      "%",
      "the definition divides interest expense by average INTEREST-BEARING LIABILITIES; companyfacts exposes only the repurchase-agreement balance while the interest-expense numerator covers every borrowing the REIT runs, so that quotient overstates the cost of funds and can flip the sign of the spread — the named metric is withheld and the repo-funded computation is published under its own name instead",
      "interest income / average earning assets − interest expense / average interest-bearing liabilities",
      [
        ...INTEREST_INCOME_OPERATING_TAGS.slice(0, 1).map(tagPath),
        ...INTEREST_EXPENSE_TAGS.slice(0, 1).map(tagPath),
        ...REPO_FUNDING_TAGS.map(tagPath),
      ],
    ),
  );

  if (
    intIncome !== null &&
    intExpense !== null &&
    assetDenom !== null &&
    fundingDenom !== null &&
    repo !== null
  ) {
    const yieldPct = (intIncome.value / assetDenom) * 100;
    const costPct = (Math.abs(intExpense.value) / fundingDenom) * 100;
    out.push(
      metric({
        key: "netInterestSpreadRepoFunded",
        label: "net interest spread (repo-funded)",
        unit: "%",
        value: yieldPct - costPct,
        basis:
          `asset yield (interest income ${intIncome.value} / average total assets ${assetDenom}, ${avgAssets.basis}) ` +
          `${yieldPct.toFixed(2)}% − funding cost (TOTAL interest expense ${Math.abs(intExpense.value)} / average ` +
          `repurchase agreements ${fundingDenom}, ${avgRepo.basis}) ${costPct.toFixed(2)}%. NOT the net interest ` +
          "spread: interest on any borrowing other than repo sits in the numerator with no matching balance in the " +
          "denominator, so the funding cost sits at or ABOVE a true cost of funds and this spread at or BELOW a true " +
          "net interest spread. A mortgage REIT's assets are interest-earning securities and loans, so total assets " +
          "is a fair yield denominator here — unlike at a bank.",
        sources: [
          intIncome.sourcePath,
          intExpense.sourcePath,
          repo.sourcePath,
          ...(repoPrior !== null ? [repoPrior.sourcePath] : []),
          "statements:balance.totalAssets",
        ],
        asOf: end,
        proxy: true,
      }),
    );
  } else {
    const missing: string[] = [];
    if (intIncome === null) missing.push("interest income");
    if (intExpense === null) missing.push("interest expense");
    if (assetDenom === null) missing.push("average total assets");
    if (fundingDenom === null) missing.push("repurchase-agreement funding balance");
    out.push(
      withheld(
        "netInterestSpreadRepoFunded",
        "net interest spread (repo-funded)",
        "%",
        facts === null && (intIncome === null || intExpense === null)
          ? noFacts
          : `${missing.join(", ")} unavailable — the spread needs both legs over their own average balances, and a one-legged figure would misstate it`,
        "interest income / average total assets − total interest expense / average repurchase agreements",
        [
          ...INTEREST_INCOME_OPERATING_TAGS.slice(0, 1).map(tagPath),
          ...INTEREST_EXPENSE_TAGS.slice(0, 1).map(tagPath),
          ...REPO_FUNDING_TAGS.map(tagPath),
        ],
      ),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Equity-REIT FFO / AFFO — the NAREIT definition (criterion e)
// ---------------------------------------------------------------------------

export interface NareitFfoResult {
  /** FFO in currency; null when withheld. */
  ffo: number | null;
  /** AFFO in currency; null when withheld. */
  affo: number | null;
  /**
   * True when a component stood in for the definition — total D&A where
   * real-estate D&A is untagged, or the generic asset-impairment charge where
   * the real-estate impairment is untagged. `ffoBasis` names which, and both
   * stand-ins err in the same direction: FFO sits at or ABOVE the definition.
   */
  ffoApproximate: boolean;
  /** True when AFFO could not subtract recurring capex / straight-line rent. */
  affoApproximate: boolean;
  ffoBasis: string;
  affoBasis: string;
  sources: string[];
  asOf: string | null;
  notes: string[];
  gaps: ManifestEntry[];
}

export interface NareitFfoInputs {
  companyFacts: FetchResult<CompanyFacts> | null | undefined;
  /**
   * Period end of the income statement FFO is computed for. Every XBRL
   * component resolves at this period end, so the fallbacks below MUST be from
   * the same period: a fiscal-year net income against trailing depreciation is
   * a hybrid of two periods, not a figure.
   */
  periodEnd: string | null;
  /** Net income fallback when the tag does not resolve — same period as `periodEnd`. */
  netIncome: number | null;
  /** Total D&A fallback — same period as `periodEnd`. */
  depreciationAndAmortization: number | null;
  /** Capex fallback (negative outflow) for the rough AFFO — same period as `periodEnd`. */
  capitalExpenditure?: number | null;
}

/**
 * FFO per the NAREIT definition: net income (GAAP) plus real-estate
 * depreciation and amortization, minus gains on property sales, plus
 * impairments of depreciable real estate.
 *
 * Real-estate D&A is the part of D&A NAREIT adds back; a diversified REIT's
 * corporate D&A is not supposed to be. Where the filer tags real-estate
 * depreciation separately the definition is applied exactly; where it does not,
 * total D&A stands in and the figure is labeled approximate rather than
 * published as if it were the definition.
 *
 * AFFO subtracts recurring capital expenditure and straight-line rent when the
 * filer tags them; otherwise it falls back to the existing rough treatment
 * (FFO − all capex) and says so.
 */
export function computeNareitFfo(inputs: NareitFfoInputs): NareitFfoResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const sources: string[] = [];
  const facts =
    inputs.companyFacts !== null && inputs.companyFacts !== undefined && inputs.companyFacts.ok
      ? inputs.companyFacts.value.data
      : null;
  const end = inputs.periodEnd;
  const flow = end === null ? null : { end, durationHint: "FY" as const };

  const netIncomeHit = flow === null ? null : resolveTag(facts, NET_INCOME_TAGS, flow);
  const netIncome = netIncomeHit?.value ?? (isNum(inputs.netIncome) ? inputs.netIncome : null);
  if (netIncomeHit !== null) sources.push(netIncomeHit.sourcePath);
  else if (netIncome !== null) sources.push("statements:income.netIncome");

  if (netIncome === null) {
    gaps.push({
      field: "valuation.reit.ffo",
      reason: "net income unavailable — FFO (which starts from GAAP net income) not computable",
      severity: "warn",
      attemptedSources: [...NET_INCOME_TAGS.map(tagPath), "statements:income.netIncome"],
    });
    return {
      ffo: null,
      affo: null,
      ffoApproximate: false,
      affoApproximate: false,
      ffoBasis: "not computed (no net income)",
      affoBasis: "not computed (no FFO)",
      sources,
      asOf: end,
      notes,
      gaps,
    };
  }

  const reDep = flow === null ? null : resolveTag(facts, REAL_ESTATE_DEPRECIATION_TAGS, flow);
  const totalDa = flow === null ? null : resolveTag(facts, DEPRECIATION_AMORTIZATION_TAGS, flow);
  const daValue =
    reDep?.value ?? totalDa?.value ?? (isNum(inputs.depreciationAndAmortization) ? inputs.depreciationAndAmortization : null);
  const daIsRealEstate = reDep !== null;
  if (reDep !== null) sources.push(reDep.sourcePath);
  else if (totalDa !== null) sources.push(totalDa.sourcePath);
  else if (daValue !== null) sources.push("statements:income.depreciationAndAmortization");

  if (daValue === null) {
    gaps.push({
      field: "valuation.reit.ffo",
      reason:
        "no depreciation and amortization figure available — FFO's defining add-back (real-estate depreciation) is missing",
      severity: "warn",
      attemptedSources: [
        ...REAL_ESTATE_DEPRECIATION_TAGS.map(tagPath),
        ...DEPRECIATION_AMORTIZATION_TAGS.map(tagPath),
      ],
    });
    return {
      ffo: null,
      affo: null,
      ffoApproximate: false,
      affoApproximate: false,
      ffoBasis: "not computed (no depreciation add-back)",
      affoBasis: "not computed (no FFO)",
      sources,
      asOf: end,
      notes,
      gaps,
    };
  }

  const gains = flow === null ? null : resolveTag(facts, PROPERTY_SALE_GAIN_TAGS, flow);
  // NAREIT adds back only impairments attributable to depreciable real estate.
  // The generic charge is a labeled stand-in, never the definition.
  const reImpairment = flow === null ? null : resolveTag(facts, REAL_ESTATE_IMPAIRMENT_TAGS, flow);
  const genericImpairment =
    flow === null || reImpairment !== null ? null : resolveTag(facts, GENERIC_IMPAIRMENT_TAGS, flow);
  const impairments = reImpairment ?? genericImpairment;
  const impairmentIsGeneric = reImpairment === null && genericImpairment !== null;
  if (gains !== null) sources.push(gains.sourcePath);
  if (impairments !== null) sources.push(impairments.sourcePath);

  const gainsValue = gains?.value ?? 0;
  const impairmentsValue = impairments?.value ?? 0;
  const ffo = netIncome + daValue - gainsValue + impairmentsValue;

  const ffoParts = [
    `net income ${netIncome}`,
    `+ ${daIsRealEstate ? "real-estate" : "total"} depreciation and amortization ${daValue}`,
    gains !== null
      ? `− gains on property sales ${gainsValue} (${gains.tag})`
      : "− gains on property sales (no property-sale-gain element tagged; treated as zero — a disposition gain the filer did not tag would leave FFO overstated by that gain)",
    impairments !== null
      ? `+ impairments ${impairmentsValue} (${impairments.tag})`
      : "+ impairments (none tagged; treated as zero)",
  ];
  const ffoApproximateReasons: string[] = [];
  if (!daIsRealEstate) {
    ffoApproximateReasons.push(
      "the filer does not tag real-estate depreciation separately, so TOTAL depreciation and amortization is added back — NAREIT adds back only the real-estate portion",
    );
  }
  if (impairmentIsGeneric) {
    ffoApproximateReasons.push(
      `the filer tags no ${REAL_ESTATE_IMPAIRMENT_TAGS[0]}, so the generic ${GENERIC_IMPAIRMENT_TAGS[0]} is added back — NAREIT adds back only impairments of depreciable real estate, and this charge may include goodwill or other non-real-estate write-downs`,
    );
  }
  const ffoBasis =
    `FFO (NAREIT) = ${ffoParts.join(" ")} = ${ffo}.` +
    (ffoApproximateReasons.length === 0
      ? ""
      : ` APPROXIMATE: ${ffoApproximateReasons.join("; and ")} — so this figure sits at or above the definition.`);
  if (impairmentIsGeneric) {
    notes.push(
      "FFO adds back the generic asset-impairment charge because the filer tags no real-estate impairment — labeled approximate: NAREIT adds back only impairments of depreciable real estate, so a goodwill or other non-real-estate write-down in that charge leaves FFO ABOVE the definition.",
    );
    gaps.push({
      field: "valuation.reit.ffo.realEstateImpairment",
      reason:
        "real-estate impairment is not separately tagged — FFO adds back the generic asset-impairment charge instead and is labeled approximate (the figure sits at or above the definition)",
      severity: "info",
      attemptedSources: REAL_ESTATE_IMPAIRMENT_TAGS.map(tagPath),
    });
  }
  if (!daIsRealEstate) {
    notes.push(
      "FFO uses total depreciation and amortization because the filer tags no separate real-estate depreciation — labeled approximate (NAREIT adds back only real-estate depreciation).",
    );
    gaps.push({
      field: "valuation.reit.ffo.realEstateDepreciation",
      reason:
        "real-estate depreciation is not separately tagged — FFO adds back total D&A instead and is labeled approximate",
      severity: "info",
      attemptedSources: REAL_ESTATE_DEPRECIATION_TAGS.map(tagPath),
    });
  }
  if (gains === null && impairments === null) {
    notes.push(
      "FFO netted no gains on property sales and no impairments: the filer tags neither for this period, so both are treated as zero rather than guessed.",
    );
  }

  // --- AFFO: recurring capex and straight-line rent when tagged.
  const recurringCapex = flow === null ? null : resolveSum(facts, RECURRING_CAPEX_TAGS, flow);
  const straightLineRent = flow === null ? null : resolveTag(facts, STRAIGHT_LINE_RENT_TAGS, flow);
  let affo: number | null = null;
  let affoBasis: string;
  let affoApproximate = false;
  if (recurringCapex !== null) {
    const capex = Math.abs(recurringCapex.value);
    const slr = straightLineRent?.value ?? 0;
    affo = ffo - capex - slr;
    affoBasis =
      `AFFO = FFO ${ffo} − recurring capital expenditure ${capex} ` +
      `(${recurringCapex.hits.map((h) => h.tag).join(" + ")})` +
      (straightLineRent !== null
        ? ` − straight-line rent ${slr} (${straightLineRent.tag})`
        : " (straight-line rent not tagged; not subtracted)") +
      ` = ${affo}.`;
    sources.push(...recurringCapex.hits.map((h) => h.sourcePath));
    if (straightLineRent !== null) sources.push(straightLineRent.sourcePath);
    if (straightLineRent === null) {
      affoApproximate = true;
      notes.push(
        "AFFO subtracts recurring capital expenditure but not straight-line rent, which the filer does not tag — labeled approximate.",
      );
    }
  } else if (isNum(inputs.capitalExpenditure)) {
    affo = ffo - Math.abs(inputs.capitalExpenditure);
    affoApproximate = true;
    affoBasis =
      `AFFO (rough) = FFO ${ffo} − ALL capital expenditure ${Math.abs(inputs.capitalExpenditure)}. APPROXIMATE: the ` +
      "filer tags no recurring/maintenance capital-expenditure element, so development spending is subtracted too — " +
      "this is a conservative floor, below a true AFFO.";
    sources.push("statements:cashFlow.capitalExpenditure");
    notes.push(
      "AFFO treats ALL capital expenditure as recurring because no maintenance-capex element is tagged — a conservative floor, disclosed as approximate.",
    );
    gaps.push({
      field: "valuation.reit.affo",
      reason:
        "recurring (maintenance) capital expenditure and straight-line rent are not tagged — AFFO subtracts total capex instead and is labeled approximate",
      severity: "info",
      attemptedSources: [...RECURRING_CAPEX_TAGS.map(tagPath), ...STRAIGHT_LINE_RENT_TAGS.map(tagPath)],
    });
  } else {
    affoBasis = "AFFO not computed: neither recurring capital expenditure nor a total capex figure is available.";
    gaps.push({
      field: "valuation.reit.affo",
      reason: "no capital-expenditure figure available — AFFO not computable",
      severity: "warn",
      attemptedSources: [...RECURRING_CAPEX_TAGS.map(tagPath), "statements:cashFlow.capitalExpenditure"],
    });
  }

  return {
    ffo,
    affo,
    ffoApproximate: ffoApproximateReasons.length > 0,
    affoApproximate,
    ffoBasis,
    affoBasis,
    sources,
    asOf: end,
    notes,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Route metrics for a financial company. Returns an empty metric list for
 * routes that have none (general, equity REIT — the latter's FFO/AFFO come
 * from {@link computeNareitFfo}).
 */
export function computeFinancialMetrics(
  route: SectorRoute,
  inputs: FinancialMetricsInputs,
): FinancialMetricsResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];

  const factsResult = inputs.companyFacts;
  const facts =
    factsResult !== null && factsResult !== undefined && factsResult.ok ? factsResult.value.data : null;
  const factsReason =
    factsResult === null || factsResult === undefined
      ? "EDGAR companyfacts not fetched for this bundle"
      : factsResult.ok
        ? null
        : `EDGAR companyfacts unavailable: ${factsResult.gap.reason}`;

  let metrics: RouteMetric[];
  if (route === "bank") {
    metrics = bankMetrics(facts, inputs, factsReason);
    notes.push(
      "Bank route metrics are computed from the filer's own XBRL tags. A named metric is published only when the " +
        "figures its definition calls for are on file; anything else is withheld with the reason, and a stand-in " +
        "(net interest income over average total assets, tangible leverage) is published under its own name, never " +
        "under the name of the metric it stands in for.",
    );
  } else if (route === "insurer") {
    metrics = insurerMetrics(facts, inputs, factsReason);
    notes.push(
      "Insurer route metrics are computed on GAAP premiums EARNED. The company-reported combined ratio remains the " +
        "gold standard; the computed one is labeled as a computation and is not directly comparable to a statutory " +
        "filing, which divides expenses by premiums WRITTEN.",
    );
  } else if (route === "reit-mortgage") {
    metrics = mortgageReitMetrics(facts, inputs, factsReason);
    notes.push(
      "Mortgage-REIT route metrics lead on book value: the assets are marked securities, so equity approximates " +
        "liquidation value. The spread and leverage figures describe the carry trade the book actually runs.",
    );
  } else {
    metrics = [];
  }

  if (factsReason !== null && metrics.length > 0) {
    notes.push(`${factsReason} — every metric needing an XBRL line item is withheld with its own reason.`);
  }

  for (const m of metrics) {
    if (m.withheldReason !== null) {
      gaps.push({
        field: `financialMetrics.${m.key}`,
        reason: `${m.label} withheld: ${m.withheldReason}`,
        severity: "info",
        attemptedSources: m.sources.length > 0 ? m.sources : undefined,
      });
    }
  }

  const asOf = metrics.reduce<string | null>(
    (acc, m) => (m.asOf !== null && (acc === null || m.asOf > acc) ? m.asOf : acc),
    null,
  );

  return { route, metrics, notes, gaps, asOf };
}
