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

export interface StockSplits {
  /** Applied events, oldest first. */
  events: SplitEvent[];
  /** One note per tagged split, applied or not, in date order. */
  notes: SplitNote[];
  /**
   * The factor that carries a fact filed on `filed` to the current share
   * basis: the product of the ratios of every applied split dated after that
   * filing. Multiply a share count by it; divide a per-share amount by it.
   */
  factorFor(filed: string): number;
}

function noSplits(): StockSplits {
  return { events: [], notes: [], factorFor: () => 1 };
}

interface Candidate {
  date: string;
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
      continue;
    }
    candidates.push({ date, values: [...values] });
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
 * Discover the splits a filer tagged and decide which to apply. Pure and
 * total: a payload with no split concept yields no events, no notes and a
 * factor of 1 everywhere.
 */
export function discoverStockSplits(facts: CompanyFacts): StockSplits {
  const candidates = tagCandidates(facts);
  if (candidates.length === 0) return noSplits();

  const shares: FactPoint[] = [];
  for (const tag of SHARE_EVIDENCE_TAGS) {
    for (const { unit, points } of conceptPoints(facts, "us-gaap", tag)) {
      if (unit !== "shares") continue;
      shares.push(...filterToCoreForms(points));
    }
  }

  const events: SplitEvent[] = [];
  const notes: SplitNote[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i] as Candidate;
    const date = candidate.date;
    const info = (text: string): void => {
      notes.push({ date, text, severity: "info" });
    };
    const warn = (text: string): void => {
      notes.push({ date, text, severity: "warn" });
    };
    const values = distinct(candidate.values);
    const tagged = values[0] as number;
    const previous = i > 0 ? (candidates[i - 1] as Candidate).date : null;
    const next = i + 1 < candidates.length ? (candidates[i + 1] as Candidate).date : null;
    const where = `${date} (${SPLIT_RATIO_TAG})`;

    if (values.length > 1) {
      warn(
        `stock split ratio tagged for ${where} NOT applied: filings disagree on the ratio (${values.map(formatRatio).join(", ")}); ${LEFT_AS_FILED}`,
      );
      continue;
    }

    const evidence = restatementFactor(shares, date, previous, next);
    const repeatOf = events.find((e) => e.tagged === tagged && daysBetween(e.date, date) <= REPEAT_TAG_WINDOW_DAYS);
    const repeatNote = (of: SplitEvent): string =>
      `stock split ratio ${formatRatio(tagged)} tagged again for ${where} is the ${describeSplitRatio(of.ratio)} split of ${of.date} restated, not a further split; not applied again`;

    if (evidence === null) {
      if (repeatOf !== undefined) {
        info(repeatNote(repeatOf));
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

  if (events.length === 0) return { events, notes, factorFor: () => 1 };
  return {
    events,
    notes,
    factorFor(filed: string): number {
      let factor = 1;
      for (const e of events) if (e.date > filed) factor *= e.ratio;
      return factor;
    },
  };
}
