/**
 * Stock-split events as a PRICE vendor reports them, and the span of sessions
 * the report covers.
 *
 * A vendor split event is dated by the first session that traded on the
 * post-split basis — the date the vendor's own split-adjusted price series
 * pivots on. That is the date a price's share basis turns on, and it is
 * different from the dates a filer's XBRL carries (see src/edgar/splits.ts):
 * NVIDIA's 10-for-1 of 2024 became legally effective on 2024-06-07 at 4:01 p.m.
 * Eastern, and the first split-adjusted session was 2024-06-10.
 *
 * The evidence is either `retrieved` — the vendor answered for the stated
 * coverage, so a split absent from `events` inside it is a split the vendor
 * does not know of — or `unavailable`, which establishes nothing: a failed or
 * never-made request is never read as "no splits".
 */

export interface VendorSplitEvent {
  /** First session on the post-split basis (exchange-local calendar date). */
  session: string;
  /** Post-split shares per pre-split share: numerator / denominator (below 1 for a reverse split). */
  ratio: number;
  numerator: number;
  denominator: number;
}

export interface VendorSplitCoverage {
  from: string;
  to: string;
}

export type VendorSplitEvidence =
  | {
      status: "retrieved";
      source: string;
      events: VendorSplitEvent[];
      /** Sessions the answer covers; there may be several (daily history, recent quote, full history). */
      coverage: VendorSplitCoverage[];
    }
  | { status: "unavailable"; source: string; reason: string };

export function unavailableSplitEvidence(source: string, reason: string): VendorSplitEvidence {
  return { status: "unavailable", source, reason };
}

/**
 * Merge several vendor answers. Events describing the same session and ratio
 * are one event; the coverage is the union. Any retrieved answer makes the
 * merge retrieved (its coverage says how far it reaches); only when none was
 * retrieved is the merge unavailable, naming every reason.
 */
export function mergeSplitEvidence(parts: readonly VendorSplitEvidence[]): VendorSplitEvidence {
  const retrieved = parts.filter((p): p is Extract<VendorSplitEvidence, { status: "retrieved" }> => p.status === "retrieved");
  if (retrieved.length === 0) {
    const reasons = parts.map((p) => (p.status === "unavailable" ? `${p.source}: ${p.reason}` : p.source));
    return unavailableSplitEvidence(
      [...new Set(parts.map((p) => p.source))].join(" + ") || "none",
      reasons.length === 0 ? "no vendor split list was requested" : reasons.join("; "),
    );
  }
  const events = new Map<string, VendorSplitEvent>();
  for (const part of retrieved) {
    for (const e of part.events) events.set(`${e.session}|${Number(e.ratio.toFixed(6))}`, e);
  }
  return {
    status: "retrieved",
    source: [...new Set(retrieved.map((p) => p.source))].join(" + "),
    events: [...events.values()].sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0)),
    coverage: retrieved.flatMap((p) => p.coverage),
  };
}
