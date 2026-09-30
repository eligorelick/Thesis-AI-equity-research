/**
 * Stock-split discovery for the SEC companyfacts path.
 *
 * Companyfacts stores every fact AS FILED. Under ASC 260 a filing made after a
 * split restates its comparatives to the post-split share basis, so a period
 * that reappears in a later filing is picked up post-split by the max(filed)
 * dedup — but a period reported only in pre-split filings keeps its original
 * per-share and share-count figures forever. Apple's FY2016 diluted EPS is the
 * live example: 8.31 as filed (2016-2018), against 7.46 for FY2025 after the
 * 4-for-1 split of 2020-08-28, which read as a NEGATIVE ten-year EPS CAGR. FMP
 * publishes split-adjusted statements, so every Stage B growth, dilution and
 * per-share figure assumes one share basis across the whole series.
 *
 * The split events come from the filer's own equity note
 * (`us-gaap:StockholdersEquityNoteStockSplitConversionRatio1`, an instant fact
 * whose context date is the split date). Its documentation is ambiguous for a
 * reverse split — "one share converted to two or two shares converted to one" —
 * and filers tag a 1-for-8 as 8 or as 0.125, so each tagged ratio is checked
 * against the share counts the next filings actually restated across that
 * date: the same period filed before and after the split, divided. That
 * evidence fixes the direction; a ratio it contradicts is not applied at all,
 * and the reason is named so nothing is silently guessed.
 *
 * Every decision is made AS OF a date the caller supplies. A split is an event
 * with an effective date, and a filer can tag it before that date arrives (an
 * 8-K announcing a split effective next quarter). Until the effective date the
 * market still trades on the pre-split basis — prices, cover counts and every
 * filed per-share figure agree with each other — so a split dated after
 * `asOf` is recorded as pending and applied to nothing.
 *
 * The module is pure: no network, no clock, no environment.
 */

import { conceptFactsSchema, filterToCoreForms, parseFactPoints, type CompanyFacts, type FactPoint } from "@/edgar/xbrl";

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

/** Relative tolerance when matching restated share counts to a tagged ratio. */
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

const DAY_MS = 86_400_000;

export interface SplitEvent {
  /** ISO date the split took effect (the tagged context date). */
  date: string;
  /** Post-split shares per pre-split share; below 1 for a reverse split. */
  ratio: number;
  /** The ratio exactly as the filer tagged it. */
  tagged: number;
  /** The restated-share-count factor that confirmed it; null when none was available. */
  evidence: number | null;
}

export interface SplitNote {
  /** The tagged split date the note is about. */
  date: string;
  text: string;
  /**
   * `warn` for a tagged ratio that was NOT applied (filings disagree, or the
   * restated share counts contradict it): the series may then mix share bases,
   * which a reader has to be warned about. `info` otherwise.
   */
  severity: "info" | "warn";
}

/** A tagged split dated after `asOf`: announced, not yet in effect, applied to nothing. */
export interface PendingSplit {
  date: string;
  /** The ratio exactly as the filer tagged it; its direction is not yet evidenced. */
  tagged: number;
}

/**
 * A tagged split that was NOT applied and whose effect on the share basis at
 * `asOf` is therefore unknown: a disputed or contradicted ratio, or tagged
 * dates on both sides of `asOf`. `from`..`to` spans its tagged dates.
 */
export interface UnresolvedSplit {
  from: string;
  to: string;
}

export interface StockSplits {
  /** The date the share basis is fixed at: splits dated after it are pending. */
  asOf: string;
  /** Applied events (dated on or before `asOf`), oldest first. */
  events: SplitEvent[];
  /** Splits tagged for a date after `asOf`, oldest first. */
  pending: PendingSplit[];
  /** Splits whose effect on the `asOf` share basis could not be established. */
  unresolved: UnresolvedSplit[];
  /** One note per tagged split, applied or not, in date order. */
  notes: SplitNote[];
  /**
   * The factor that carries a fact filed on `filed` to the share basis of
   * `asOf`: the product of the ratios of every applied split dated after that
   * filing. Multiply a share count by it; divide a per-share amount by it.
   * Pending splits never contribute.
   */
  factorFor(filed: string): number;
  /**
   * Why a share count filed on `filed` cannot be put on the `asOf` basis by
   * `factorFor`, or null when it can. `measured` is the date the count was
   * TAKEN when that differs from a restated statement figure — the cover-page
   * count is a point-in-time count as of its own date, not an ASC 260 / SAB
   * Topic 4C figure a later filing restates — so a count measured before a
   * split and filed after it could be on either basis. Pass null for a
   * statement figure (weighted average, balance-sheet count), which a filing
   * made after the split states on the post-split basis.
   */
  shareCountBasisIssue(measured: string | null, filed: string): string | null;
  /**
   * Why a figure that its source split-adjusted as of `day` — a price series
   * retrieved that day, a vendor statement row, or a quote for that session —
   * is not on the `asOf` share basis, or null when it is. Price vendors restate
   * history only for splits that have happened by the time they serve it.
   */
  sourceBasisIssue(day: string): string | null;
}

interface Candidate {
  /** Earliest tagged date in the group: the date the split is keyed and applied by. */
  date: string;
  /** Latest tagged date in the group. */
  last: string;
  values: number[];
}

function dateMs(d: string): number {
  return Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
}

function daysBetween(a: string, b: string): number {
  return (dateMs(b) - dateMs(a)) / DAY_MS;
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
 * Tagged ratios grouped by split date, oldest first. Any form counts: the
 * ratio is a disclosure, not a statement value, and an 8-K may be the only
 * place a filer tagged it. Dates within `SAME_SPLIT_WINDOW_DAYS` of each other
 * are one candidate keyed by the earliest date.
 */
function tagCandidates(facts: CompanyFacts): Candidate[] {
  const byDate = new Map<string, number[]>();
  for (const { points } of conceptPoints(facts, "us-gaap", SPLIT_RATIO_TAG)) {
    for (const p of points) {
      if (!Number.isFinite(p.val) || p.val <= 0 || p.val === 1) continue;
      const list = byDate.get(p.end) ?? [];
      list.push(p.val);
      byDate.set(p.end, list);
    }
  }
  const dates = [...byDate.keys()].sort();
  const candidates: Candidate[] = [];
  for (const date of dates) {
    const values = byDate.get(date) as number[];
    const last = candidates[candidates.length - 1];
    if (last !== undefined && daysBetween(last.date, date) <= SAME_SPLIT_WINDOW_DAYS) {
      last.values.push(...values);
      last.last = date;
      continue;
    }
    candidates.push({ date, last: date, values: [...values] });
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

const APPLIES_TO = "per-share and share-count facts filed before that date are restated to the post-split basis";
const LEFT_AS_FILED = "per-share and share-count facts filed before it are left as filed";

/**
 * Discover the splits a filer tagged and decide which to apply as of `asOf`
 * (ISO date; the analysis date). Pure and total: a payload with no split
 * concept yields no events, no notes and a factor of 1 everywhere.
 */
export function discoverStockSplits(facts: CompanyFacts, asOf: string): StockSplits {
  const candidates = tagCandidates(facts);
  if (candidates.length === 0) return assemble(asOf, [], [], [], []);

  const shares: FactPoint[] = [];
  for (const tag of SHARE_EVIDENCE_TAGS) {
    for (const { unit, points } of conceptPoints(facts, "us-gaap", tag)) {
      if (unit !== "shares") continue;
      shares.push(...filterToCoreForms(points));
    }
  }

  const events: SplitEvent[] = [];
  const pending: PendingSplit[] = [];
  const unresolved: UnresolvedSplit[] = [];
  const notes: SplitNote[] = [];
  /** The most recent context date each tagged ratio appeared with. */
  const lastTaggedAt = new Map<string | number, string>();
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i] as Candidate;
    const date = candidate.date;
    const info = (text: string): void => {
      notes.push({ date, text, severity: "info" });
    };
    /** Not applied, and its effect on the share basis is unknown. */
    const warn = (text: string): void => {
      notes.push({ date, text, severity: "warn" });
      unresolved.push({ from: date, to: candidate.last });
    };
    const values = distinct(candidate.values);
    const tagged = values[0] as number;
    const previous = i > 0 ? (candidates[i - 1] as Candidate).date : null;
    const next = i + 1 < candidates.length ? (candidates[i + 1] as Candidate).date : null;
    const where = `${date} (${SPLIT_RATIO_TAG})`;

    if (date > asOf) {
      // Filed ahead of its effective date. Every figure filed so far, and every
      // price up to `asOf`, is still on the pre-split basis: applying it would
      // multiply today's share count by a ratio the market has not seen yet.
      pending.push({ date, tagged });
      notes.push({
        date,
        severity: "info",
        text: `stock split ratio ${values.map(formatRatio).join(", ")} tagged for ${where} is not yet effective as of ${asOf}: not applied — share counts, per-share facts and prices stay on the pre-split basis until that date`,
      });
      continue;
    }
    if (candidate.last > asOf) {
      warn(
        `stock split ratio ${values.map(formatRatio).join(", ")} tagged for ${where} NOT applied: filings also date it ${candidate.last}, after ${asOf}, so whether it had taken effect by ${asOf} cannot be established; ${LEFT_AS_FILED}, and market values that combine a price with a share count across it are withheld`,
      );
      continue;
    }

    if (values.length > 1) {
      warn(
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
    const priorEvent = events.find((e) => e.tagged === tagged);
    const repeatOf =
      priorEvent !== undefined && lastTagged !== undefined && daysBetween(lastTagged, date) <= REPEAT_TAG_WINDOW_DAYS
        ? priorEvent
        : undefined;
    lastTaggedAt.set(tagged, date);
    const repeatNote = (of: SplitEvent): string =>
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
        warn(
          `stock split ratio ${formatRatio(tagged)} tagged for ${where} NOT applied: the same ratio was already applied for ${priorEvent.date} and no share count was restated across ${date} to show whether this is a further split or a re-tag of that one; ${LEFT_AS_FILED}`,
        );
        continue;
      }
      events.push({ date, ratio: tagged, tagged, evidence: null });
      info(`stock split ${describeSplitRatio(tagged)} on ${where}, applied as tagged — no restated share count to confirm it; ${APPLIES_TO}`);
      continue;
    }

    if (matches(evidence, tagged)) {
      events.push({ date, ratio: tagged, tagged, evidence });
      info(
        `stock split ${describeSplitRatio(tagged)} on ${date} (${SPLIT_RATIO_TAG}, confirmed by restated share counts ×${formatRatio(evidence)}): ${APPLIES_TO}`,
      );
      continue;
    }
    if (matches(evidence, 1 / tagged)) {
      const ratio = 1 / tagged;
      events.push({ date, ratio, tagged, evidence });
      info(
        `stock split ${describeSplitRatio(ratio)} on ${where}: tagged as ${formatRatio(tagged)}, restated share counts show ×${formatRatio(evidence)}, so the ratio is read as ${formatRatio(ratio)}; ${APPLIES_TO}`,
      );
      continue;
    }
    if (repeatOf !== undefined && matches(evidence, 1)) {
      info(repeatNote(repeatOf));
      continue;
    }
    warn(
      `stock split ratio ${formatRatio(tagged)} tagged for ${where} NOT applied: share counts restated across that date moved by ×${formatRatio(evidence)}, which matches neither ${formatRatio(tagged)} nor 1/${formatRatio(tagged)}; ${LEFT_AS_FILED}`,
    );
  }

  return assemble(asOf, events, pending, unresolved, notes);
}

function assemble(
  asOf: string,
  events: SplitEvent[],
  pending: PendingSplit[],
  unresolved: UnresolvedSplit[],
  notes: SplitNote[],
): StockSplits {
  const splitName = (e: SplitEvent): string => `${describeSplitRatio(e.ratio)} split of ${e.date}`;
  const unresolvedName = (u: UnresolvedSplit): string =>
    u.from === u.to ? `the split tagged ${u.from}` : `the split tagged ${u.from} and ${u.to}`;
  return {
    asOf,
    events,
    pending,
    unresolved,
    notes,
    factorFor(filed: string): number {
      let factor = 1;
      for (const e of events) if (e.date > filed) factor *= e.ratio;
      return factor;
    },
    shareCountBasisIssue(measured: string | null, filed: string): string | null {
      if (measured !== null) {
        const straddled = events.find((e) => measured < e.date && e.date <= filed);
        if (straddled !== undefined) {
          return `the share count was measured ${measured}, before the ${splitName(straddled)}, but filed ${filed}, after it, so whether it is stated on the pre- or post-split basis cannot be established`;
        }
      }
      const open = unresolved.find((u) => filed < u.to);
      return open === undefined
        ? null
        : `the share count was filed ${filed}, before ${unresolvedName(open)} (${SPLIT_RATIO_TAG}), whose ratio or effective date could not be established, so its share basis at ${asOf} is unknown`;
    },
    sourceBasisIssue(day: string): string | null {
      const missed = events.find((e) => day < e.date);
      if (missed !== undefined) {
        return `the source figure is split-adjusted only as of ${day}, before the ${splitName(missed)}, while the share counts are on the post-split basis of ${asOf}`;
      }
      const open = unresolved.find((u) => day < u.to);
      return open === undefined
        ? null
        : `the source figure is split-adjusted only as of ${day}, before ${unresolvedName(open)} (${SPLIT_RATIO_TAG}), whose ratio or effective date could not be established`;
    },
  };
}
