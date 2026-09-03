/**
 * Stage B — sector-routing evidence from EDGAR XBRL companyfacts (WS5, D-16).
 *
 * PURE, deterministic, read-only: reads the bundle's companyfacts payload and
 * reports which balance-sheet and income-statement tags a filer carries. The
 * routing layer (`routeCompany`) combines this with the vendor industry string
 * and the SEC SIC code; this module never decides a route on its own.
 *
 * Evidence rules (the WS5 methodology, "Routing evidence"):
 * - deposits AND (loans OR net interest income)      → bank
 * - premiums earned/written AND loss/policy reserves → insurer
 * - RealEstateInvestmentPropertyNet (or at cost)     → equity REIT
 * - mortgage-backed securities or loans held for investment WITHOUT investment
 *   property                                          → mortgage REIT
 *
 * The mortgage-REIT rule is the one rule that fires on a single tag group, so
 * its elements must be specific to that business model (they are: every tag
 * below names mortgage-backed securities or mortgage loans) AND the routing
 * layer requires corroboration — repo funding, or an already-financial SIC or
 * sector — before the tags alone may set a base route. Uncorroborated, the
 * disagreement is disclosed as a routing-evidence conflict instead.
 *
 * A tag counts as present only when it carries a non-zero core-form fact whose
 * period end is within `recencyMonths` of the newest evidence fact on file, so
 * a legacy tag a filer stopped using a decade ago cannot classify it today.
 * Every signal records the tag, the value and the period end that decided it,
 * so the routing note can state the evidence used.
 */

import {
  dedupFactPoints,
  tagPoints,
  type CompanyFacts,
  type FactPoint,
} from "@/edgar/xbrl";
import type { FetchResult } from "@/types/core";

/** One tag that contributed to the routing evidence. */
export interface EvidenceSignal {
  tag: string;
  value: number;
  unit: string;
  /** Period end of the fact (instant date, or duration end). */
  end: string;
  /** Duration start when the fact is a flow; absent for instants. */
  start?: string;
  form: string;
  accn: string;
}

export type EvidenceClass = "bank" | "insurer" | "reit" | "reit-mortgage";

export interface RoutingEvidence {
  /** True when a companyfacts payload was available to read. */
  available: boolean;
  /** Why no evidence could be read (companyfacts gap reason), else null. */
  unavailableReason: string | null;
  /** Newest period end across every evidence tag found (as-of of the evidence). */
  asOf: string | null;
  bank: EvidenceSignal[];
  insurer: EvidenceSignal[];
  equityReit: EvidenceSignal[];
  mortgageReit: EvidenceSignal[];
  /**
   * Repo funding (`SecuritiesSoldUnderAgreementsToRepurchase`) on its own, so
   * the routing layer can ask whether anything CORROBORATES a mortgage-asset
   * read before letting it set a base route. These signals are also included in
   * `mortgageReit` when that group fires; this field is populated whenever the
   * tag is present and recent, even when it does not.
   */
  mortgageFunding: EvidenceSignal[];
  /**
   * The base route the tags alone support, in precedence order bank > insurer
   * > equity REIT > mortgage REIT; null when no financial tags are present.
   */
  suggests: EvidenceClass | null;
  /**
   * The REIT sub-map the tags support: "equity" when investment property is
   * tagged, "mortgage" when MBS / loans-held-for-investment are tagged without
   * investment property, null when neither.
   */
  reitSubmap: "equity" | "mortgage" | null;
  /** Plain-English statement of the rule that produced `suggests`. */
  basis: string | null;
  /** Provenance of every signal. */
  source: string;
}

export const ROUTING_EVIDENCE_SOURCE = "edgar:companyfacts us-gaap";

/** Months of slack between the newest evidence fact and a tag's own newest fact. */
export const ROUTING_EVIDENCE_RECENCY_MONTHS = 24;

// ---------------------------------------------------------------------------
// Tag sets. Each group lists the us-gaap elements that evidence one activity;
// alternate spellings across taxonomy vintages are listed together. Order is
// the reporting order in notes only — presence of ANY tag in a group counts.
// ---------------------------------------------------------------------------

export const BANK_DEPOSIT_TAGS = [
  "Deposits",
  "DepositsDomestic",
  "DepositsForeign",
  "InterestBearingDepositLiabilities",
  "NoninterestBearingDepositLiabilities",
] as const;

export const BANK_LOAN_TAGS = [
  "LoansAndLeasesReceivableNetReportedAmount",
  "LoansAndLeasesReceivableGrossCarryingAmount",
  "FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss",
  "FinancingReceivableExcludingAccruedInterestBeforeAllowanceForCreditLoss",
  "NotesReceivableGross",
] as const;

export const BANK_NII_TAGS = ["InterestIncomeExpenseNet", "InterestIncomeExpenseAfterProvisionForLoanLoss"] as const;

export const INSURER_PREMIUM_TAGS = [
  "PremiumsEarnedNet",
  "PremiumsEarnedNetPropertyAndCasualty",
  "PremiumsEarnedNetLife",
  "PremiumsWrittenNet",
  "PremiumsWrittenGross",
] as const;

export const INSURER_RESERVE_TAGS = [
  "LiabilityForClaimsAndClaimsAdjustmentExpense",
  "LiabilityForUnpaidClaimsAndClaimsAdjustmentExpenseNet",
  "LiabilityForFuturePolicyBenefits",
  "PolicyholderBenefitsAndClaimsIncurredNet",
  "LiabilityForFuturePolicyBenefitsAndUnpaidClaimsAndClaimsAdjustmentExpense",
] as const;

export const EQUITY_REIT_PROPERTY_TAGS = [
  "RealEstateInvestmentPropertyNet",
  "RealEstateInvestmentPropertyAtCost",
  "RealEstateAccumulatedDepreciation",
] as const;

/**
 * Mortgage-backed securities. Every element here NAMES mortgage-backed
 * securities: a generic debt-securities element
 * (`AvailableForSaleSecuritiesDebtSecurities`,
 * `DebtSecuritiesAvailableForSaleExcludingAccruedInterest`,
 * `AvailableForSaleSecuritiesDebtSecuritiesAmortizedCostBasis`) is what an
 * ordinary corporate treasury tags for its bond portfolio, so those three used
 * to route Apple, Alphabet or Microsoft to the mortgage-REIT map. Evidence
 * about a business model has to be specific to that business model.
 */
export const MORTGAGE_REIT_MBS_TAGS = [
  "MortgageBackedSecuritiesAvailableForSaleFairValueDisclosure",
  "MortgageBackedSecuritiesHeldToMaturityFairValueDisclosure",
  "MortgageBackedSecuritiesIssuedByUSGovernmentSponsoredEnterprisesFairValueDisclosure",
  "MortgageBackedSecuritiesIssuedByPrivateEnterprisesFairValueDisclosure",
] as const;

/**
 * Loans a mortgage REIT holds for investment. The generic receivable elements
 * that used to sit here — `NotesReceivableNet`,
 * `LoansAndLeasesReceivableNetReportedAmount`,
 * `FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss` —
 * are what any manufacturer with vendor financing tags, and any bank; none of
 * them is mortgage-REIT-specific. They stay in {@link BANK_LOAN_TAGS}, where a
 * deposit tag has to accompany them before they classify anything.
 */
export const MORTGAGE_REIT_LOAN_TAGS = [
  "LoansReceivableHeldForInvestmentNet",
  "MortgageLoansOnRealEstate",
  "MortgageLoansOnRealEstateCarryingAmountOfMortgages",
  "MortgageLoansOnRealEstateCommercialAndConsumer",
] as const;

/** Repo funding is the hallmark mortgage-REIT liability; supporting evidence only. */
export const MORTGAGE_REIT_FUNDING_TAGS = ["SecuritiesSoldUnderAgreementsToRepurchase"] as const;

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const shifted = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
  return shifted.toISOString().slice(0, 10);
}

/** Newest deduped core-form point of a tag with a finite non-zero value, or null. */
function newestPoint(facts: CompanyFacts, tag: string): { point: FactPoint; unit: string } | null {
  const tp = tagPoints(facts, tag);
  if (tp === null) return null;
  let best: FactPoint | null = null;
  for (const p of dedupFactPoints(tp.points)) {
    if (!Number.isFinite(p.val) || p.val === 0) continue;
    if (best === null || p.end > best.end || (p.end === best.end && p.filed > best.filed)) best = p;
  }
  return best === null ? null : { point: best, unit: tp.unit };
}

function toSignal(tag: string, hit: { point: FactPoint; unit: string }): EvidenceSignal {
  const { point, unit } = hit;
  return {
    tag,
    value: point.val,
    unit,
    end: point.end,
    ...(point.start !== undefined ? { start: point.start } : {}),
    form: point.form,
    accn: point.accn,
  };
}

function empty(reason: string | null, available: boolean): RoutingEvidence {
  return {
    available,
    unavailableReason: reason,
    asOf: null,
    bank: [],
    insurer: [],
    equityReit: [],
    mortgageReit: [],
    mortgageFunding: [],
    suggests: null,
    reitSubmap: null,
    basis: null,
    source: ROUTING_EVIDENCE_SOURCE,
  };
}

/** Human-readable "Tag value (end)" list for routing notes. */
export function describeSignals(signals: readonly EvidenceSignal[]): string {
  return signals.map((s) => `${s.tag} ${s.value} ${s.unit} (${s.end})`).join(", ");
}

/**
 * Read the routing evidence from a companyfacts FetchResult. Never throws for
 * missing data: an absent or failed payload yields `available: false` with the
 * gap reason so the routing layer can disclose it.
 */
export function deriveRoutingEvidence(
  companyFacts: FetchResult<CompanyFacts> | null | undefined,
  opts: { recencyMonths?: number } = {},
): RoutingEvidence {
  if (companyFacts === null || companyFacts === undefined) {
    return empty("EDGAR companyfacts not fetched for this bundle", false);
  }
  if (!companyFacts.ok) {
    return empty(`EDGAR companyfacts unavailable: ${companyFacts.gap.reason}`, false);
  }
  const facts = companyFacts.value.data;
  const recencyMonths = opts.recencyMonths ?? ROUTING_EVIDENCE_RECENCY_MONTHS;

  const groups: Record<string, readonly string[]> = {
    deposits: BANK_DEPOSIT_TAGS,
    loans: BANK_LOAN_TAGS,
    nii: BANK_NII_TAGS,
    premiums: INSURER_PREMIUM_TAGS,
    reserves: INSURER_RESERVE_TAGS,
    property: EQUITY_REIT_PROPERTY_TAGS,
    mbs: MORTGAGE_REIT_MBS_TAGS,
    mortgageLoans: MORTGAGE_REIT_LOAN_TAGS,
    repo: MORTGAGE_REIT_FUNDING_TAGS,
  };

  // First pass: newest non-zero point per tag, and the newest end overall.
  const hits = new Map<string, EvidenceSignal>();
  let newestEnd: string | null = null;
  for (const tags of Object.values(groups)) {
    for (const tag of tags) {
      if (hits.has(tag)) continue;
      const hit = newestPoint(facts, tag);
      if (hit === null) continue;
      const signal = toSignal(tag, hit);
      hits.set(tag, signal);
      if (newestEnd === null || signal.end > newestEnd) newestEnd = signal.end;
    }
  }
  if (newestEnd === null) return { ...empty(null, true), asOf: null };

  // Second pass: keep only tags whose newest fact is recent relative to the
  // newest evidence fact, so retired tags cannot classify the filer.
  const cutoff = addMonths(newestEnd, -recencyMonths);
  const recent = (tags: readonly string[]): EvidenceSignal[] =>
    tags.map((t) => hits.get(t)).filter((s): s is EvidenceSignal => s !== undefined && s.end >= cutoff);

  const deposits = recent(groups.deposits);
  const loans = recent(groups.loans);
  const nii = recent(groups.nii);
  const premiums = recent(groups.premiums);
  const reserves = recent(groups.reserves);
  const property = recent(groups.property);
  const mbs = recent(groups.mbs);
  const mortgageLoans = recent(groups.mortgageLoans);
  const repo = recent(groups.repo);

  const bank = deposits.length > 0 && (loans.length > 0 || nii.length > 0) ? [...deposits, ...loans, ...nii] : [];
  const insurer = premiums.length > 0 && reserves.length > 0 ? [...premiums, ...reserves] : [];
  const equityReit = property;
  const mortgageReit = property.length === 0 && (mbs.length > 0 || mortgageLoans.length > 0)
    ? [...mbs, ...mortgageLoans, ...repo]
    : [];

  let suggests: EvidenceClass | null = null;
  let basis: string | null = null;
  if (bank.length > 0) {
    suggests = "bank";
    basis = `deposits (${describeSignals(deposits)}) with ${loans.length > 0 ? `loans (${describeSignals(loans)})` : ""}${
      loans.length > 0 && nii.length > 0 ? " and " : ""
    }${nii.length > 0 ? `net interest income (${describeSignals(nii)})` : ""} → bank`;
  } else if (insurer.length > 0) {
    suggests = "insurer";
    basis = `premiums (${describeSignals(premiums)}) with loss/policy reserves (${describeSignals(reserves)}) → insurer`;
  } else if (equityReit.length > 0) {
    suggests = "reit";
    basis = `investment property (${describeSignals(property)}) → equity REIT`;
  } else if (mortgageReit.length > 0) {
    suggests = "reit-mortgage";
    basis =
      `${mbs.length > 0 ? `mortgage-backed securities (${describeSignals(mbs)})` : ""}${mbs.length > 0 && mortgageLoans.length > 0 ? " and " : ""}` +
      `${mortgageLoans.length > 0 ? `loans held for investment (${describeSignals(mortgageLoans)})` : ""}` +
      `${repo.length > 0 ? `, repo funding (${describeSignals(repo)})` : ""} without RealEstateInvestmentPropertyNet → mortgage REIT`;
  }

  const reitSubmap: RoutingEvidence["reitSubmap"] =
    equityReit.length > 0 ? "equity" : mortgageReit.length > 0 ? "mortgage" : null;

  const all = [...bank, ...insurer, ...equityReit, ...mortgageReit];
  const asOf = all.reduce<string | null>((acc, s) => (acc === null || s.end > acc ? s.end : acc), null);

  return {
    available: true,
    unavailableReason: null,
    asOf,
    bank,
    insurer,
    equityReit,
    mortgageReit,
    mortgageFunding: repo,
    suggests,
    reitSubmap,
    basis,
    source: ROUTING_EVIDENCE_SOURCE,
  };
}
