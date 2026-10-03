/**
 * Stock splits: which ones happened, WHEN each one changed the share basis,
 * and whether a given share count can be put on the basis a given price is on.
 *
 * Companyfacts stores every fact AS FILED. Under ASC 260 a filing made after a
 * split restates its comparatives to the post-split share basis, so a period
 * that reappears in a later filing is picked up post-split by the max(filed)
 * dedup — but a period reported only in pre-split filings keeps its original
 * per-share and share-count figures forever. Apple's FY2016 diluted EPS is the
 * live example: 8.31 as filed (2016-2018), against 7.46 for FY2025 after the
 * 4-for-1 split of 2020, which read as a NEGATIVE ten-year EPS CAGR.
 *
 * A split has several dates and they are not interchangeable:
 *
 *  - the ANNOUNCEMENT (the earliest filing that tags it, here `announced`);
 *  - the RECORD date and the LEGAL-EFFECTIVE moment (NVIDIA's 10-for-1 of 2024
 *    was legally effective on 2024-06-07 at 4:01 p.m. Eastern) — neither is in
 *    companyfacts as a machine-readable date;
 *  - the FIRST SPLIT-ADJUSTED TRADING SESSION (NVIDIA: 2024-06-10), the date a
 *    price's share basis turns on;
 *  - the XBRL CONTEXT DATE of `us-gaap:StockholdersEquityNoteStockSplitConversionRatio1`,
 *    which filers set to whichever of these they choose (NVIDIA tagged
 *    2024-06-07 and 2024-06-10 in different filings). It is an accounting
 *    context and is never taken as proof of any of the others.
 *
 * The first split-adjusted session comes only from a price vendor's split
 * events (src/providers/splitEvents.ts). Without one it is bounded to a window
 * around the context dates, and a price or share count inside that window is
 * withheld rather than guessed. The legal-effective moment decides a filing's
 * basis (a filing made after it states the post-split basis); it is bounded
 * below by the earliest context date and by the first session less
 * `LEGAL_BEFORE_SESSION_MAX_DAYS`, and a filing between that bound and the first
 * session is withheld.
 *
 * The ratio comes from the filer's equity note, checked against the share
 * counts later filings actually restated (its documentation is ambiguous for a
 * reverse split, and filers tag a 1-for-8 as 8 or as 0.125), and against the
 * vendor's numerator/denominator when there is one. A split the vendor lists
 * and companyfacts does not (the ratio is usually tagged only in the next
 * periodic report) is applied from the vendor's event; a split both describe is
 * applied once.
 *
 * A vendor list that was not retrieved establishes nothing: without one, no
 * share count is put on any price's basis, because a split since the count was
 * filed cannot be ruled out.
 *
 * The module is pure: no network, no clock, no environment.
 */

import { conceptFactsSchema, filterToCoreForms, parseFactPoints, type CompanyFacts, type FactPoint } from "@/edgar/xbrl";
import type { VendorSplitCoverage, VendorSplitEvidence, VendorSplitEvent, VendorSplitObservation } from "@/providers/splitEvents";

/** The equity-note concept that carries a split's conversion ratio. */
export const SPLIT_RATIO_TAG = "StockholdersEquityNoteStockSplitConversionRatio1";

/**
 * Share-count concepts whose restatement across a split date confirms the
 * tagged ratio. Weighted averages first: they are always filed with the income
 * statement and restated in every subsequent comparative.
 */
const SHARE_EVIDENCE_TAGS = [
  "WeightedAverageNumberOfDilutedSharesOutstanding",
  "WeightedAverageNumberOfSharesOutstandingBasic",
  "CommonStockSharesOutstanding",
] as const;

/** Relative tolerance when matching restated share counts (or a vendor's ratio) to a tagged ratio. */
const EVIDENCE_TOLERANCE = 0.03;
/**
 * Two tagged dates this close with the same ratio are one split whose context
 * date differs between filings (approval or record date in one, distribution
 * date in another — NVIDIA's 2021 split is tagged 2021-06-03 in two 10-Qs and
 * 2021-07-19 in the 10-K, 46 days apart), not two splits.
 */
const SAME_SPLIT_WINDOW_DAYS = 60;
/**
 * A filer that repeats the ratio in later filings with each period end as the
 * context would otherwise look like a split every quarter. A repeat carries the
 * same ratio within this window and no restatement of its own.
 */
const REPEAT_TAG_WINDOW_DAYS = 550;

/**
 * Without a vendor session, the first split-adjusted session is taken to lie
 * between this many days before the earliest context date (a filer that tags
 * the distribution or payable date) and `SESSION_AFTER_CONTEXT_MAX_DAYS` after
 * the latest one (a filer that tags the board approval: NVIDIA's 2021 approval
 * was tagged 47 days before the first split-adjusted session). Both are stated
 * assumptions; a vendor session replaces them.
 */
export const SESSION_BEFORE_CONTEXT_MAX_DAYS = 7;
export const SESSION_AFTER_CONTEXT_MAX_DAYS = SAME_SPLIT_WINDOW_DAYS;
/**
 * Legal effectiveness precedes the first split-adjusted session by at most this
 * many days: the exchanges begin split-adjusted trading on the first business
 * day after the distribution (NVIDIA: effective Friday 2024-06-07 4:01 p.m.,
 * first session Monday 2024-06-10, three days). A stated assumption: a filing
 * made in the days between is withheld, never assigned a basis.
 */
export const LEGAL_BEFORE_SESSION_MAX_DAYS = 7;
/**
 * Vendor split events this close together are descriptions of one split. Two
 * that differ in ratio or session are a conflict, never two splits: applying
 * both would compound them (a 4-for-1 and a 5-for-1 read as ×20).
 */
export const VENDOR_SAME_SPLIT_DAYS = LEGAL_BEFORE_SESSION_MAX_DAYS;

const DAY_MS = 86_400_000;

export interface SplitEvent {
  /** The date the split is keyed and reported by: its earliest XBRL context date, else its first split-adjusted session. */
  date: string;
  /** Post-split shares per pre-split share; below 1 for a reverse split. */
  ratio: number;
  /** The ratio exactly as the filer tagged it; null for a split only the vendor lists. */
  tagged: number | null;
  /** The restated-share-count factor that confirmed it; null when none was available. */
  evidence: number | null;
  /** XBRL context dates the filer tagged: accounting context only, never a trading date. */
  contextDates: string[];
  /** Earliest filing that tagged the ratio; null for a vendor-only split. */
  announced: string | null;
  /** First session on the post-split basis, from the vendor's split event; null when no vendor session pins it. */
  firstAdjustedSession: string | null;
  /** Sessions the first split-adjusted session can fall in (one day when pinned). */
  sessionWindow: { from: string; to: string };
  /** Earliest date legal effectiveness can fall on: a filing before it is on the pre-split basis. */
  legalFrom: string;
  sources: ("edgar" | "vendor")[];
}

/**
 * A split whose ratio or timing could not be established: a disputed or
 * contradicted ratio, or filings and vendor disagreeing. Any share count filed
 * before `to` is of unknown basis on any day from `from` on.
 */
export interface UnresolvedSplit {
  from: string;
  to: string;
  reason: string;
}

export interface SplitNote {
  /** The split's key date the note is about (or the analysis date for a note about the evidence itself). */
  date: string;
  text: string;
  /**
   * `warn` for a split that was NOT applied or whose timing is unknown, and for
   * missing vendor evidence: figures resting on it are withheld. `info`
   * otherwise.
   */
  severity: "info" | "warn";
}

/** The resolved splits, as plain data (it travels in the data bundle). */
export interface StockSplits {
  /** The analysis date the resolution was made on. */
  asOf: string;
  /** The vendor split list the resolution rests on. */
  vendor: { status: "retrieved"; source: string } | { status: "unavailable"; source: string; reason: string };
  /** Sessions the vendor list covers, merged; empty when unavailable. */
  coverage: VendorSplitCoverage[];
  /** Splits applied (with their timing), oldest first. */
  events: SplitEvent[];
  unresolved: UnresolvedSplit[];
  /** One note per split, applied or not, plus one about missing vendor evidence. */
  notes: SplitNote[];
}

export type Basis = { factor: number } | { withheld: string };

interface Candidate {
  /** Earliest tagged context date in the group. */
  date: string;
  /** Latest tagged context date in the group. */
  last: string;
  contexts: string[];
  announced: string;
  values: number[];
}

function dateMs(d: string): number {
  return Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
}

function daysBetween(a: string, b: string): number {
  return (dateMs(b) - dateMs(a)) / DAY_MS;
}

function addDays(d: string, n: number): string {
  return new Date(dateMs(d) + n * DAY_MS).toISOString().slice(0, 10);
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

function conceptPoints(facts: CompanyFacts, namespace: string, tag: string): { unit: string; points: FactPoint[] }[] {
  const concepts = facts.facts[namespace];
  if (concepts === undefined || concepts === null || typeof concepts !== "object") return [];
  const raw = (concepts as Record<string, unknown>)[tag];
  if (raw === undefined) return [];
  const parsed = conceptFactsSchema.safeParse(raw);
  if (!parsed.success) return [];
  const out: { unit: string; points: FactPoint[] }[] = [];
  for (const [unit, rawPoints] of Object.entries(parsed.data.units)) {
    if (!Array.isArray(rawPoints)) continue;
    out.push({ unit, points: parseFactPoints(rawPoints) });
  }
  return out;
}

/**
 * Tagged ratios grouped by context date, oldest first. Any form counts: the
 * ratio is a disclosure, not a statement value, and an 8-K may be the only
 * place a filer tagged it. Dates within `SAME_SPLIT_WINDOW_DAYS` of each other
 * are one candidate keyed by the earliest date.
 */
function tagCandidates(facts: CompanyFacts): Candidate[] {
  const byDate = new Map<string, { values: number[]; filed: string }>();
  for (const { points } of conceptPoints(facts, "us-gaap", SPLIT_RATIO_TAG)) {
    for (const p of points) {
      if (!Number.isFinite(p.val) || p.val <= 0 || p.val === 1) continue;
      const entry = byDate.get(p.end) ?? { values: [], filed: p.filed };
      entry.values.push(p.val);
      if (p.filed < entry.filed) entry.filed = p.filed;
      byDate.set(p.end, entry);
    }
  }
  const dates = [...byDate.keys()].sort();
  const candidates: Candidate[] = [];
  for (const date of dates) {
    const { values, filed } = byDate.get(date) as { values: number[]; filed: string };
    const last = candidates[candidates.length - 1];
    if (last !== undefined && daysBetween(last.date, date) <= SAME_SPLIT_WINDOW_DAYS) {
      last.values.push(...values);
      last.last = date;
      last.contexts.push(date);
      if (filed < last.announced) last.announced = filed;
      continue;
    }
    candidates.push({ date, last: date, contexts: [date], announced: filed, values: [...values] });
  }
  return candidates;
}

function distinct(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function matches(observed: number, expected: number): boolean {
  return Math.abs(observed / expected - 1) <= EVIDENCE_TOLERANCE;
}

/**
 * The factor by which share counts for one period moved between a filing made
 * before `date` (and after `previous`) and a filing made at or after `date`
 * (and before `next`): the restatement this split caused, isolated from any
 * other. Null when no period was filed on both sides.
 */
function restatementFactor(
  shares: readonly FactPoint[],
  date: string,
  previous: string | null,
  next: string | null,
): number | null {
  const before = new Map<string, FactPoint>();
  const after = new Map<string, FactPoint>();
  for (const p of shares) {
    if (!Number.isFinite(p.val) || p.val <= 0) continue;
    const key = `${p.start ?? ""}|${p.end}`;
    if (p.filed < date) {
      if (previous !== null && p.filed < previous) continue;
      const cur = before.get(key);
      if (cur === undefined || p.filed > cur.filed) before.set(key, p);
    } else {
      if (next !== null && p.filed >= next) continue;
      const cur = after.get(key);
      if (cur === undefined || p.filed > cur.filed) after.set(key, p);
    }
  }
  const factors: number[] = [];
  for (const [key, b] of before) {
    const a = after.get(key);
    if (a !== undefined) factors.push(a.val / b.val);
  }
  // Weighted averages are rounded to thousands as filed, so a 4-for-1 shows
  // up as 3.99999978; four decimals is the precision a split ratio carries.
  return factors.length === 0 ? null : Number(median(factors).toFixed(4));
}

/** "4-for-1" for a ratio of 4; "1-for-8" for 0.125. */
export function describeSplitRatio(ratio: number): string {
  if (ratio >= 1) return `${formatRatio(ratio)}-for-1`;
  return `1-for-${formatRatio(1 / ratio)}`;
}

function formatRatio(x: number): string {
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(4)));
}

const APPLIES_TO = "per-share and share-count facts filed before its legal effect are carried to the post-split basis";
const LEFT_AS_FILED = "per-share and share-count facts filed before it are withheld wherever they would meet a price";

/** An EDGAR candidate after the ratio decision, before the vendor is consulted. */
type EdgarDecision =
  | { kind: "applied"; cand: Candidate; ratio: number; tagged: number; evidence: number | null; text: string }
  | { kind: "unresolved"; cand: Candidate };

/**
 * The ratio decision for every tagged candidate: apply (with the ratio the
 * restatement evidence fixes), leave unresolved, or recognise a re-tag of an
 * earlier split. Notes are pushed as decided.
 */
function decideEdgar(facts: CompanyFacts, candidates: Candidate[], notes: SplitNote[]): EdgarDecision[] {
  const shares: FactPoint[] = [];
  for (const tag of SHARE_EVIDENCE_TAGS) {
    for (const { unit, points } of conceptPoints(facts, "us-gaap", tag)) {
      if (unit !== "shares") continue;
      shares.push(...filterToCoreForms(points));
    }
  }
  const decisions: EdgarDecision[] = [];
  const applied: { date: string; ratio: number; tagged: number }[] = [];
  /** The most recent context date each tagged ratio appeared with. */
  const lastTaggedAt = new Map<number, string>();
  for (let i = 0; i < candidates.length; i += 1) {
    const cand = candidates[i] as Candidate;
    const date = cand.date;
    const info = (text: string): void => {
      notes.push({ date, text, severity: "info" });
    };
    const unresolved = (text: string): void => {
      notes.push({ date, text, severity: "warn" });
      decisions.push({ kind: "unresolved", cand });
    };
    const values = distinct(cand.values);
    const tagged = values[0] as number;
    const previous = i > 0 ? (candidates[i - 1] as Candidate).date : null;
    const next = i + 1 < candidates.length ? (candidates[i + 1] as Candidate).date : null;
    const where = `${date} (${SPLIT_RATIO_TAG})`;
    // The ratio decision's text; the note is written once the timing is known.
    const apply = (ratio: number, evidence: number | null, text: string): void => {
      decisions.push({ kind: "applied", cand, ratio, tagged, evidence, text });
      applied.push({ date, ratio, tagged });
    };

    if (values.length > 1) {
      unresolved(
        `stock split ratio tagged for ${where} NOT applied: filings disagree on the ratio (${values.map(formatRatio).join(", ")}); ${LEFT_AS_FILED}`,
      );
      continue;
    }

    const evidence = restatementFactor(shares, date, previous, next);
    // A repeat is measured from the LAST time this ratio was tagged, applied
    // or not: a filer that keeps re-tagging its split in every later filing
    // would otherwise walk out of the window and have the same split applied
    // a second time, compounding every earlier share count.
    const lastTagged = lastTaggedAt.get(tagged);
    const priorEvent = applied.find((e) => e.tagged === tagged);
    const repeatOf =
      priorEvent !== undefined && lastTagged !== undefined && daysBetween(lastTagged, date) <= REPEAT_TAG_WINDOW_DAYS
        ? priorEvent
        : undefined;
    lastTaggedAt.set(tagged, date);
    const repeatNote = (of: { date: string; ratio: number }): string =>
      `stock split ratio ${formatRatio(tagged)} tagged again for ${where} is the ${describeSplitRatio(of.ratio)} split of ${of.date} restated, not a further split; not applied again`;

    if (evidence === null) {
      if (repeatOf !== undefined) {
        info(repeatNote(repeatOf));
        continue;
      }
      if (priorEvent !== undefined) {
        // The same ratio again, long after the last tag, with no restated
        // share count on either side of it: a further split and a stale
        // re-tag of the earlier one look identical here, and applying the
        // wrong one rescales every earlier per-share figure.
        unresolved(
          `stock split ratio ${formatRatio(tagged)} tagged for ${where} NOT applied: the same ratio was already applied for ${priorEvent.date} and no share count was restated across ${date} to show whether this is a further split or a re-tag of that one; ${LEFT_AS_FILED}`,
        );
        continue;
      }
      apply(tagged, null, `stock split ${describeSplitRatio(tagged)} tagged for ${where}, no restated share count to confirm the ratio; ${APPLIES_TO}`);
      continue;
    }

    if (matches(evidence, tagged)) {
      apply(
        tagged,
        evidence,
        `stock split ${describeSplitRatio(tagged)} tagged for ${where}, confirmed by restated share counts ×${formatRatio(evidence)}; ${APPLIES_TO}`,
      );
      continue;
    }
    if (matches(evidence, 1 / tagged)) {
      const ratio = 1 / tagged;
      apply(
        ratio,
        evidence,
        `stock split ${describeSplitRatio(ratio)} tagged for ${where}: tagged as ${formatRatio(tagged)}, restated share counts show ×${formatRatio(evidence)}, so the ratio is read as ${formatRatio(ratio)}; ${APPLIES_TO}`,
      );
      continue;
    }
    if (repeatOf !== undefined && matches(evidence, 1)) {
      info(repeatNote(repeatOf));
      continue;
    }
    unresolved(
      `stock split ratio ${formatRatio(tagged)} tagged for ${where} NOT applied: share counts restated across that date moved by ×${formatRatio(evidence)}, which matches neither ${formatRatio(tagged)} nor 1/${formatRatio(tagged)}; ${LEFT_AS_FILED}`,
    );
  }
  return decisions;
}

/**
 * Coverage spans merged where they overlap or touch (the next begins the day
 * after the last ends). A gap of any length stays a gap: the vendor did not
 * answer for those days, and a weekend or holiday is not assumed.
 */
function mergeCoverage(spans: readonly VendorSplitCoverage[]): VendorSplitCoverage[] {
  const sorted = [...spans].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out: VendorSplitCoverage[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && span.from <= addDays(last.to, 1)) {
      if (span.to > last.to) last.to = span.to;
      continue;
    }
    out.push({ ...span });
  }
  return out;
}

/** True when every day from `from` to `to` lies in one merged coverage span. */
function covers(coverage: readonly VendorSplitCoverage[], from: string, to: string): boolean {
  return coverage.some((c) => c.from <= from && c.to >= to);
}

/**
 * The part of `window` the vendor did NOT cover: where a split it does not
 * list can still have first traded. Null when it covered all of it.
 */
function uncoveredPart(window: { from: string; to: string }, coverage: readonly VendorSplitCoverage[]): { from: string; to: string } | null {
  let from = window.from;
  let to = window.to;
  for (const c of coverage) {
    if (c.from <= from && c.to >= to) return null;
    // Covered at the start: the split first traded after the coverage ends.
    if (c.from <= from && c.to >= from) from = addDays(c.to, 1);
    // Covered at the end: it first traded before the coverage begins.
    if (c.to >= to && c.from <= to) to = addDays(c.from, -1);
  }
  return from <= to ? { from, to } : null;
}

function describeWindow(w: { from: string; to: string }): string {
  return w.from === w.to ? w.from : `${w.from} … ${w.to}`;
}

/** Vendor events with exact duplicates (same session and ratio) dropped, oldest first. */
function distinctVendorEvents(events: readonly VendorSplitEvent[]): VendorSplitEvent[] {
  const byKey = new Map<string, VendorSplitEvent>();
  for (const e of events) byKey.set(`${e.session}|${Number(e.ratio.toFixed(6))}`, e);
  return [...byKey.values()].sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
}

/** An answer covering a session but omitting this event contradicts it, at any date distance. */
function vendorDisagreement(event: VendorSplitEvent, observations: readonly VendorSplitObservation[]): string | null {
  const listsEvent = (answer: VendorSplitObservation): boolean => answer.events.some(
    (e) => e.session === event.session && e.ratio.toFixed(6) === event.ratio.toFixed(6),
  );
  const opposing = observations.filter(
    (answer) => answer.coverage.some((c) => c.from <= event.session && event.session <= c.to) && !listsEvent(answer),
  );
  if (opposing.length === 0) return null;
  const supporting = observations.filter(listsEvent).map((answer) => answer.source);
  return `${supporting.join(" + ")} lists ${describeSplitRatio(event.ratio)} first traded ${event.session}, but ${opposing.map((answer) => answer.source).join(" + ")} covers that session and omits that event`;
}

/**
 * Indices of `events` (oldest first) grouped into descriptions of one split:
 * each event within `VENDOR_SAME_SPLIT_DAYS` of the previous one joins its group.
 */
function clusterVendorEvents(events: readonly VendorSplitEvent[]): number[][] {
  const clusters: number[][] = [];
  for (const [i, e] of events.entries()) {
    const last = clusters[clusters.length - 1];
    const prev = last === undefined ? undefined : events[last[last.length - 1] as number];
    if (last !== undefined && prev !== undefined && daysBetween(prev.session, e.session) <= VENDOR_SAME_SPLIT_DAYS) {
      last.push(i);
      continue;
    }
    clusters.push([i]);
  }
  return clusters;
}

/**
 * Discover the splits the filer tagged, reconcile them with the vendor's split
 * events, and fix each split's timing. Pure and total.
 */
export function discoverStockSplits(
  facts: CompanyFacts,
  opts: { asOf: string; vendor: VendorSplitEvidence },
): StockSplits {
  const notes: SplitNote[] = [];
  const decisions = decideEdgar(facts, tagCandidates(facts), notes);
  const vendor = opts.vendor;
  const coverage = vendor.status === "retrieved" ? mergeCoverage(vendor.coverage) : [];
  const vendorEvents = distinctVendorEvents(vendor.status === "retrieved" ? vendor.events : []);
  const observations = vendor.status === "retrieved" ? vendor.observations ?? [vendor] : [];
  const disagreements = vendorEvents.map((e) => vendorDisagreement(e, observations));
  const clusters = clusterVendorEvents(vendorEvents);
  const clusterOf = new Map<number, number[]>(clusters.flatMap((c) => c.map((i) => [i, c] as const)));
  const consumed = new Set<number>();
  const events: SplitEvent[] = [];
  const unresolved: UnresolvedSplit[] = [];
  const source = vendor.source;

  // Every description of a split one of whose descriptions falls in the
  // window: a conflicting description just outside it is the same split.
  const inWindow = (w: { from: string; to: string }): number[] => {
    const hits = new Set<number>();
    for (const [i, e] of vendorEvents.entries()) {
      if (e.session < w.from || e.session > w.to) continue;
      for (const j of clusterOf.get(i) ?? [i]) if (!consumed.has(j)) hits.add(j);
    }
    return [...hits].sort((a, b) => a - b);
  };

  for (const d of decisions) {
    const cand = d.cand;
    const window = {
      from: addDays(cand.date, -SESSION_BEFORE_CONTEXT_MAX_DAYS),
      to: addDays(cand.last, SESSION_AFTER_CONTEXT_MAX_DAYS),
    };
    const nearby = inWindow(window);
    const unresolve = (reason: string): void => {
      notes.push({ date: cand.date, text: reason, severity: "warn" });
      unresolved.push({ from: addDays(window.from, -LEGAL_BEFORE_SESSION_MAX_DAYS), to: window.to, reason });
    };
    if (d.kind === "unresolved") {
      // The vendor's event near a disputed tag is the same split: consumed so
      // it is never applied a second time as a vendor-only split.
      for (const i of nearby) consumed.add(i);
      unresolved.push({
        from: addDays(window.from, -LEGAL_BEFORE_SESSION_MAX_DAYS),
        to: window.to,
        reason: `the split tagged ${describeWindow({ from: cand.date, to: cand.last })} was not applied (see its note)`,
      });
      continue;
    }
    for (const i of nearby) consumed.add(i);
    const fits = (e: VendorSplitEvent): boolean =>
      matches(e.ratio, d.ratio) || (d.evidence === null && (matches(e.ratio, d.tagged) || matches(e.ratio, 1 / d.tagged)));
    const base = {
      date: cand.date,
      tagged: d.tagged,
      evidence: d.evidence,
      contextDates: [...cand.contexts],
      announced: cand.announced,
    };
    const contexts = cand.contexts.join(", ");
    if (nearby.length > 0) {
      const hit = nearby.length === 1 ? (vendorEvents[nearby[0] as number] as VendorSplitEvent) : null;
      const conflicts = nearby.flatMap((i) => disagreements[i] ?? []);
      if (hit === null || !fits(hit) || conflicts.length > 0) {
        const listed = nearby.map((i) => {
          const e = vendorEvents[i] as VendorSplitEvent;
          return `${describeSplitRatio(e.ratio)} first traded ${e.session}`;
        });
        unresolve(
          `${d.text} — but NOT applied: ${source} lists ${listed.join(" and ")} within ${describeWindow(window)}, which does not match or is disputed${conflicts.length > 0 ? ` (${conflicts.join("; ")})` : ""}; ${LEFT_AS_FILED}`,
        );
        continue;
      }
      const session = hit.session;
      // The vendor's numerator/denominator fixes the direction when no
      // restatement did (a 1-for-8 tagged as 8).
      const ratio = d.evidence === null ? hit.ratio : d.ratio;
      const legalFrom = minDate(cand.date, addDays(session, -LEGAL_BEFORE_SESSION_MAX_DAYS));
      events.push({ ...base, ratio, firstAdjustedSession: session, sessionWindow: { from: session, to: session }, legalFrom, sources: ["edgar", "vendor"] });
      notes.push({
        date: cand.date,
        severity: "info",
        text: `${d.evidence === null && ratio !== d.ratio ? `stock split ${describeSplitRatio(ratio)} tagged for ${cand.date} (${SPLIT_RATIO_TAG}) as ${formatRatio(d.tagged)}, read as ${formatRatio(ratio)} from ${source}'s ${hit.numerator}:${hit.denominator}; ${APPLIES_TO}` : d.text}. First split-adjusted session ${session} per ${source}; the XBRL context date(s) ${contexts} are accounting context only; first tagged in a filing of ${cand.announced}; legal effectiveness is not in companyfacts and is taken to fall between ${legalFrom} and ${session}, so a share count filed in that interval is withheld`,
      });
      continue;
    }
    const open = vendor.status === "retrieved" ? uncoveredPart(window, coverage) : window;
    if (open === null) {
      unresolve(
        `${d.text} — but NOT applied: ${source} covers every session from ${window.from} to ${window.to} and lists no split in them; ${LEFT_AS_FILED}`,
      );
      continue;
    }
    const legalFrom = minDate(cand.date, addDays(open.from, -LEGAL_BEFORE_SESSION_MAX_DAYS));
    events.push({ ...base, ratio: d.ratio, firstAdjustedSession: null, sessionWindow: open, legalFrom, sources: ["edgar"] });
    notes.push({
      date: cand.date,
      severity: "info",
      text: `${d.text}. No vendor session pins its first split-adjusted session (${vendor.status === "retrieved" ? `${source} lists none in the sessions it covers` : `${source} unavailable`}); from the XBRL context date(s) ${contexts} it is taken to fall within ${describeWindow(open)}, and a price dated or a share count filed inside that window is withheld`,
    });
  }

  // A split the vendor lists and companyfacts does not carry yet: the filer
  // tags the ratio only in its next periodic report, months after the event.
  for (const cluster of clusters) {
    if (cluster.some((i) => consumed.has(i))) continue;
    const conflicts = cluster.flatMap((i) => disagreements[i] ?? []);
    if (cluster.length > 1 || conflicts.length > 0) {
      // Descriptions of one split that disagree on its ratio or its session.
      const listed = cluster.map((i) => {
        const e = vendorEvents[i] as VendorSplitEvent;
        return `${describeSplitRatio(e.ratio)} first traded ${e.session} (${e.numerator}:${e.denominator})`;
      });
      const first = (vendorEvents[cluster[0] as number] as VendorSplitEvent).session;
      const last = (vendorEvents[cluster[cluster.length - 1] as number] as VendorSplitEvent).session;
      const reason = `stock split around ${describeWindow({ from: first, to: last })} NOT applied: ${source} describes it as ${listed.join(" and ")}; ${conflicts.length > 0 ? conflicts.join("; ") : "these descriptions disagree and do not establish separate splits to compound"}; ${LEFT_AS_FILED}`;
      notes.push({ date: first, text: reason, severity: "warn" });
      unresolved.push({ from: addDays(first, -LEGAL_BEFORE_SESSION_MAX_DAYS), to: last, reason });
      continue;
    }
    const e = vendorEvents[cluster[0] as number] as VendorSplitEvent;
    const legalFrom = addDays(e.session, -LEGAL_BEFORE_SESSION_MAX_DAYS);
    events.push({
      date: e.session,
      ratio: e.ratio,
      tagged: null,
      evidence: null,
      contextDates: [],
      announced: null,
      firstAdjustedSession: e.session,
      sessionWindow: { from: e.session, to: e.session },
      legalFrom,
      sources: ["vendor"],
    });
    notes.push({
      date: e.session,
      severity: "info",
      text: `stock split ${describeSplitRatio(e.ratio)} first traded ${e.session} per ${source} (${e.numerator}:${e.denominator}); companyfacts carries no ${SPLIT_RATIO_TAG} for it, so it is applied from the vendor's event: a share count filed before ${legalFrom} is carried to the post-split basis, and one filed between ${legalFrom} and ${e.session} is withheld`,
    });
  }

  if (vendor.status === "unavailable") {
    notes.push({
      date: opts.asOf,
      severity: "warn",
      text: `no vendor split list (${vendor.source}: ${vendor.reason}): a split since any share count was filed cannot be ruled out, so no filed share count or per-share figure is put on a price's basis`,
    });
  }

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  notes.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    asOf: opts.asOf,
    vendor: vendor.status === "retrieved" ? { status: "retrieved", source } : { status: "unavailable", source, reason: vendor.reason },
    coverage,
    events,
    unresolved,
    notes,
  };
}

/** Whether the split had first traded by the session `day`. */
function tradedBy(e: SplitEvent, day: string): boolean | null {
  if (day >= e.sessionWindow.to) return true;
  if (day < e.sessionWindow.from) return false;
  return null;
}

/**
 * Which side of the split a filed share count is stated on. A statement figure
 * (weighted average, balance-sheet count) filed after legal effectiveness is
 * restated to it (ASC 260, SAB Topic 4C), so its filing date decides. A
 * cover-page count is a count AS OF its own date (`measured`): one taken
 * before the split and filed after it could be stated either way.
 */
function countSide(e: SplitEvent, filed: string, measured: string | null): "pre" | "post" | null {
  const postFrom = e.sessionWindow.to;
  if (measured === null) {
    if (filed < e.legalFrom) return "pre";
    if (filed >= postFrom) return "post";
    return null;
  }
  if (measured >= postFrom) return "post";
  if (measured < e.legalFrom && filed < e.legalFrom) return "pre";
  return null;
}

function splitName(e: SplitEvent): string {
  return `${describeSplitRatio(e.ratio)} split ${e.firstAdjustedSession !== null ? `first traded ${e.firstAdjustedSession}` : `whose first split-adjusted session falls within ${describeWindow(e.sessionWindow)}`}`;
}

/**
 * Whether the vendor list establishes every split between `from` and `to`.
 * Null when it does; the reason otherwise.
 */
function completenessIssue(s: StockSplits, from: string, to: string): string | null {
  if (s.vendor.status === "unavailable") {
    return `no vendor split list is available (${s.vendor.source}: ${s.vendor.reason}), so a split between ${from} and ${to} cannot be ruled out`;
  }
  if (covers(s.coverage, from, to)) return null;
  const spans = s.coverage.map(describeWindow).join(", ") || "no sessions";
  return `${s.vendor.source} covers ${spans}, not every session from ${from} to ${to}, so a split in between cannot be ruled out`;
}

/**
 * The factor that puts a share count filed on `filed` (and, for a cover-page
 * count, measured on `measured`) on the share basis of the session `day`:
 * multiply a count by it, divide a per-share amount by it. Withheld, with the
 * reason, whenever any split's side of either date cannot be established.
 */
export function shareBasisFactor(s: StockSplits, filed: string, measured: string | null, day: string): Basis {
  if (filed > day) return { withheld: `the figure was filed ${filed}, after the session ${day} whose basis it is needed on` };
  const incomplete = completenessIssue(s, filed, day);
  if (incomplete !== null) return { withheld: incomplete };
  for (const u of s.unresolved) {
    if (day >= u.from && filed < u.to) {
      return { withheld: `the figure was filed ${filed}, before an unresolved split (${u.reason}), so its basis on ${day} is unknown` };
    }
    // Filing after a disputed event does not establish the basis of a count
    // measured earlier (for example a cover-page count).
    if (day >= u.from && measured !== null && measured < u.to) {
      return { withheld: `the count was measured ${measured}, before an unresolved split (${u.reason}), and filed ${filed}, so its basis on ${day} is unknown` };
    }
  }
  let factor = 1;
  for (const e of s.events) {
    const traded = tradedBy(e, day);
    if (traded === null) {
      return { withheld: `the session ${day} falls within ${describeWindow(e.sessionWindow)}, where the ${describeSplitRatio(e.ratio)} split's first split-adjusted session is not pinned by a vendor event` };
    }
    const side = countSide(e, filed, measured);
    if (side === null) {
      return {
        withheld:
          measured !== null && measured < e.legalFrom && filed >= e.sessionWindow.to
            ? `the count was measured ${measured}, before the ${splitName(e)}, and filed ${filed}, after it, so whether it is stated on the pre- or post-split basis cannot be established`
            : `the figure was ${measured !== null ? `measured ${measured} and ` : ""}filed ${filed}, between the earliest legal effectiveness (${e.legalFrom}) and the first split-adjusted session of the ${splitName(e)}, so its side of the split cannot be established`,
      };
    }
    if (traded && side === "pre") factor *= e.ratio;
    if (!traded && side === "post") {
      return { withheld: `the figure is on the post-split basis of the ${splitName(e)}, but the session ${day} traded before it` };
    }
  }
  return { factor };
}

/** A share count put on the basis of `day` (rounded to whole shares), or the reason it cannot be. */
export function shareCountOnBasis(
  s: StockSplits,
  value: number,
  filed: string,
  measured: string | null,
  day: string,
): { value: number } | { withheld: string } {
  const basis = shareBasisFactor(s, filed, measured, day);
  return "withheld" in basis ? basis : { value: Math.round(value * basis.factor) };
}

/**
 * Whether two sessions share one split basis (every split first traded before
 * both or after both, with nothing unresolved between). Null when they do.
 */
export function sameShareBasis(s: StockSplits, a: string, b: string): string | null {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  if (lo === hi) return null;
  const incomplete = completenessIssue(s, lo, hi);
  if (incomplete !== null) return incomplete;
  for (const u of s.unresolved) {
    if (u.from <= hi && u.to > lo) return `an unresolved split (${u.reason}) falls between ${lo} and ${hi}`;
  }
  for (const e of s.events) {
    const x = tradedBy(e, lo);
    const y = tradedBy(e, hi);
    if (x === null || y === null) {
      return `the ${splitName(e)} may have first traded between ${lo} and ${hi}`;
    }
    if (x !== y) return `the ${splitName(e)} first traded between ${lo} and ${hi}, so the two are on different share bases`;
  }
  return null;
}

/** The splits applied to figures filed before them, for a one-line note. */
export function describeSplits(s: StockSplits): string {
  return s.events.map((e) => splitName(e)).join("; ");
}
