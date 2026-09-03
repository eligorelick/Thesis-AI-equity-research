// src/edgar/successor.ts
/**
 * Successor registrants.
 *
 * A holding-company reorganization creates a NEW SEC registrant that takes over
 * the listed ticker and files a Form 8-K12B ("registration of a successor
 * issuer"). ExxonMobil Holdings Corp did this in July 2026: CIK 2115436 now
 * carries the XOM ticker, and its `companyfacts` payload starts at the
 * reorganization — a hundred years of Exxon Mobil Corp's filings sit under CIK
 * 34088, and neither `submissions` nor `companyfacts` links the two.
 *
 * The consequence for a report was severe and silent: every long-window growth
 * rate, every multi-year average and every trend for such an issuer measured a
 * few months of history, or produced nothing at all, without saying why.
 *
 * The link is machine-readable, but NOT where this module first looked. The
 * 8-K12B says the registrant is a successor; it does not necessarily say whose.
 * ExxonMobil Holdings' own 8-K12B (0001193125-26-291990, filed 2026-07-01,
 * recorded under `fixtures/edgar/`) carries a single FILER block — itself. The
 * co-registration appears on the filings the two entities made JOINTLY after
 * the reorganization: the 10-Q of 2026-08-03 and the POSASR of 2026-07-01 each
 * name both CIKs. So the 8-K12B is the trigger, and the predecessor is resolved
 * by scanning a short, ranked list of the successor's filings for a submission
 * header that co-registers exactly one other party.
 *
 * This module is the pure half — rank the filings worth reading, pick the
 * predecessor out of the FILER blocks, and word the disclosure. Fetching is the
 * caller's job, and it is capped.
 */
import type { ManifestEntry } from "@/types/core";
import type { FilingFiler } from "@/providers/edgar";
import type { CompanyFacts } from "@/edgar/xbrl";

/** The form a successor issuer files to register under the predecessor's listing. */
export const SUCCESSOR_FORM = "8-K12B";

/** Periodic reports, which a successor and its predecessor file jointly for a time. */
const PERIODIC_FORM = /^10-[KQ](\/A)?$/;

/** A post-effective amendment to an employee-plan registration. */
const EMPLOYEE_PLAN_FORM = "S-8 POS";

/**
 * A file number of the form `333-293558-01`: this filing rides on ANOTHER
 * registrant's registration statement and the filer is co-registrant 01. The
 * plain form (`001-43384`) is the registrant's own.
 */
export function hasCoRegistrantFileNumber(fileNumber: string | undefined): boolean {
  return fileNumber !== undefined && /^\d{3}-\d{2,6}-\d{2}$/.test(fileNumber.trim());
}

/** The filing fields candidate ranking reads; a subset of `EdgarFiling`. */
export interface CandidateFiling {
  accessionNumber: string;
  form: string;
  filingDate: string;
  fileNumber?: string;
}

/**
 * The successor's filings worth reading a submission header for, best first,
 * capped at `limit`.
 *
 * Ranked, and each rank is evidence rather than taste:
 *
 *   0. the 8-K12B itself — it co-registers for some issuers, and it is the one
 *      filing whose whole purpose is the succession;
 *   1. periodic reports, newest first — while the two entities file jointly,
 *      every 10-K and 10-Q names both (this is what resolves ExxonMobil);
 *   2. anything else riding on another registrant's registration statement,
 *      newest first — a POSASR or S-3ASR amended by the successor names the
 *      predecessor whose shelf it is;
 *   3. the same, but employee-plan amendments (`S-8 POS`), which in the one
 *      recorded case name only the successor. Last, and only if the cap allows.
 *
 * Everything else is never fetched: a filing with no co-registrant file number
 * that is not periodic has no reason to name a second party, and each header is
 * a live SEC request.
 */
export function predecessorCandidates(
  filings: readonly CandidateFiling[],
  limit: number,
): CandidateFiling[] {
  const rank = (filing: CandidateFiling): number => {
    const form = filing.form.trim();
    if (form === SUCCESSOR_FORM) return 0;
    if (PERIODIC_FORM.test(form)) return 1;
    if (!hasCoRegistrantFileNumber(filing.fileNumber)) return Number.POSITIVE_INFINITY;
    return form === EMPLOYEE_PLAN_FORM ? 3 : 2;
  };
  return filings
    .map((filing) => ({ filing, rank: rank(filing) }))
    .filter((entry) => Number.isFinite(entry.rank))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.filing.filingDate.localeCompare(a.filing.filingDate) ||
        b.filing.accessionNumber.localeCompare(a.filing.accessionNumber),
    )
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.filing);
}

/** The predecessor registrant a successor's 8-K12B co-registered. */
export interface PredecessorRegistrant {
  cik10: string;
  name: string | null;
}

/** A predecessor's facts, once fetched, with the provenance of both hops. */
export interface PredecessorFacts extends PredecessorRegistrant {
  facts: CompanyFacts;
  /** The companyfacts endpoint the facts came from. */
  endpoint: string;
  /**
   * The filing whose submission header named the predecessor — often NOT the
   * 8-K12B, so the form is carried with it — and the 8-K12B that made the
   * registrant a successor in the first place.
   */
  via: { accession: string; form: string; filed: string | null; successorFormAccession: string };
  fetchedAt: string;
}

/**
 * The predecessor among one filing's FILER blocks: the co-registrant that is
 * not the successor itself. A header naming only the successor yields null —
 * the common case, including ExxonMobil's own 8-K12B — and the caller moves on
 * to the next candidate. Guessing a CIK from a company NAME would be a
 * fabricated identity, so it is never done.
 */
export function predecessorFromFilers(
  filers: readonly FilingFiler[] | undefined,
  successorCik10: string,
): PredecessorRegistrant | null {
  if (filers === undefined) return null;
  const others = filers.filter((filer) => filer.cik10 !== successorCik10);
  // More than one co-registrant is ambiguous (a multi-entity registration);
  // taking the first would be a coin flip, so the caller discloses instead.
  if (others.length !== 1) return null;
  const [predecessor] = others;
  return { cik10: predecessor!.cik10, name: predecessor!.name };
}

/** How many us-gaap concepts a payload carries — 0 means no usable history. */
export function usGaapConceptCount(facts: CompanyFacts | null): number {
  if (facts === null) return 0;
  return Object.keys(facts.facts["us-gaap"] ?? {}).length;
}

/**
 * The manifest entry a report carries when a predecessor's filings supplied
 * the history. `info` and `expected`: a reorganization is a corporate event,
 * not a data outage, but a reader must be told that the older periods were
 * filed by a DIFFERENT legal entity under a different CIK.
 */
export function predecessorManifestEntry(
  predecessor: PredecessorFacts,
  successorCik10: string,
  periods: number,
  oldest: string,
  newest: string,
): ManifestEntry {
  const name = predecessor.name ?? `CIK ${predecessor.cik10}`;
  return {
    field: "edgar.predecessor",
    reason:
      `this registrant (CIK ${successorCik10}) is a SUCCESSOR issuer: it filed Form ${SUCCESSOR_FORM} ` +
      `(${predecessor.via.successorFormAccession}), and its ${predecessor.via.form} ` +
      `${predecessor.via.accession}${predecessor.via.filed === null ? "" : `, filed ${predecessor.via.filed}`} ` +
      `co-registers ${name}, CIK ${predecessor.cik10}. Its own companyfacts payload begins at the reorganization. ` +
      `${periods} older period(s), ${oldest} to ${newest}, were taken from the predecessor's filings and each row is ` +
      'tagged `predecessor: true` with that CIK. They were filed by a different legal entity, so a change of ' +
      "accounting policy, perimeter or fiscal calendar at the reorganization would not be visible as a restatement.",
    severity: "info",
    attemptedSources: [`edgar:companyfacts CIK${predecessor.cik10}`, predecessor.endpoint],
    expected: true,
  };
}

/** The gap when a successor was identified but its predecessor could not be. */
export function predecessorUnresolvedEntry(
  successorCik10: string,
  accession: string | null,
  reason: string,
): ManifestEntry {
  return {
    field: "edgar.predecessor",
    reason:
      `this registrant (CIK ${successorCik10}) is a successor issuer (Form ${SUCCESSOR_FORM}` +
      `${accession === null ? "" : ` ${accession}`}) whose own filings begin at the reorganization, and the ` +
      `predecessor's CIK could not be resolved: ${reason}. Every multi-year figure in this report therefore ` +
      "measures only the successor's own filing history.",
    severity: "warn",
    attemptedSources: [
      accession === null
        ? `edgar:filingIndexHeaders(${successorCik10})`
        : `edgar:filingIndexHeaders(${successorCik10}, ${accession})`,
    ],
  };
}
