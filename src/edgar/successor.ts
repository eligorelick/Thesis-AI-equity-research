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
 * The link exists in exactly one machine-readable place: the 8-K12B's
 * submission header co-registers the predecessor, so its FILER blocks name both
 * CIKs. This module is the pure half — pick the predecessor out of those
 * blocks, and word the disclosure. Fetching is the caller's job.
 */
import type { ManifestEntry } from "@/types/core";
import type { FilingFiler } from "@/providers/edgar";
import type { CompanyFacts } from "@/edgar/xbrl";

/** The form a successor issuer files to register under the predecessor's listing. */
export const SUCCESSOR_FORM = "8-K12B";

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
  /** The 8-K12B accession that named the predecessor, and when it was filed. */
  via: { accession: string; filed: string | null };
  fetchedAt: string;
}

/**
 * The predecessor among a Form 8-K12B's FILER blocks: the co-registrant that
 * is not the successor itself. A header naming only the successor yields null
 * — that is an 8-K12B filed without co-registration, and guessing a CIK from a
 * company NAME would be a fabricated identity.
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
      `this registrant (CIK ${successorCik10}) is a SUCCESSOR issuer: its Form ${SUCCESSOR_FORM} ` +
      `(${predecessor.via.accession}${predecessor.via.filed === null ? "" : `, filed ${predecessor.via.filed}`}) ` +
      `co-registers ${name}, CIK ${predecessor.cik10}, and its own companyfacts payload begins at the reorganization. ` +
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
