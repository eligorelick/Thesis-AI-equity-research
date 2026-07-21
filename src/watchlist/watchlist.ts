/**
 * Watchlist data layer — server-only (the application contract §8: sidebar watchlist with
 * add/remove; last report date, grade chips, price snapshot, next earnings).
 *
 * Two responsibilities:
 *   1. Raw persistence over the `watchlist` table (add / remove / list). Symbols
 *      are normalized to UPPERCASE on write so the primary key is canonical and
 *      add/remove are idempotent.
 *   2. Enrichment: {@link getWatchlistView} joins each watched symbol against
 *      (a) the latest `done` report (grade strip + as-of + verification rate),
 *      (b) a live FMP quote (price + change%, fixture-mode aware), and
 *      (c) the next future earnings date (FMP earnings). Every external lookup
 *      degrades to a `null` field plus a `gaps[]` entry rather than throwing —
 *      in fixture mode (no FMP key) price/earnings are expected gaps.
 *
 * Server-only: imports @/db and provider clients. NEVER import into a client
 * component — the Sidebar server component calls this and passes plain data down
 * as props to the small client controls. (`import "server-only"` matches the
 * rest of the data layer; the plain-node test runner stubs it via vi.mock.)
 */

import "server-only";

import { asc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { watchlist, type WatchlistRow } from "@/db/schema";
import { getConfig } from "@/config/env";
import { makeFmpCachedFetch } from "@/pipeline/dataBundle";
import { createFmpClient, type FmpClient } from "@/providers/fmp";
import { getLatestDoneReport } from "@/report/query";
import { listRunRefsForSymbol, type RunRef } from "@/report/history";
import type { Grade } from "@/types/core";

/* ------------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------------ */

export type WatchlistEntry = WatchlistRow;

/** The six graded sections of the verdict strip (the application contract §7.1). */
export interface WatchlistGrades {
  fundamentals: Grade;
  valuation: Grade;
  technicals: Grade;
  quality: Grade;
  leadership: Grade;
  moat: Grade;
}

/**
 * One enriched sidebar row. Every enrichment field is nullable — a missing
 * quote / report / earnings date degrades the field to null and records the
 * reason in `gaps` (never throws).
 */
export interface WatchlistRowView {
  symbol: string;
  companyName?: string;
  price?: number | null;
  changePct?: number | null;
  /** as-of date of the price snapshot (ISO), when available. */
  asOf?: string | null;
  /** Verdict grade strip from the latest done report, or null when none. */
  grades?: WatchlistGrades | null;
  /** ISO createdAt of the latest done report, or null. */
  lastReportAt?: string | null;
  /** Verification rate of the latest done report (0..1), or null. */
  verificationRate?: number | null;
  /** Next future earnings date (ISO YYYY-MM-DD), or null. */
  nextEarnings?: string | null;
  /** Every saved run for the symbol (newest-first), for the sidebar disclosure. */
  runs: RunRef[];
  /** Degradation notes — one line per field that could not be resolved. */
  gaps: string[];
}

/* ------------------------------------------------------------------------ *
 * Raw persistence
 * ------------------------------------------------------------------------ */

/** Normalize a user-supplied ticker to the canonical stored form. */
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Add a symbol to the watchlist (idempotent — re-adding keeps the original
 * addedAt). Returns the normalized symbol that was stored.
 */
export function addToWatchlist(symbol: string): string {
  const normalized = normalizeSymbol(symbol);
  if (normalized.length === 0) {
    throw new Error("addToWatchlist: symbol is empty");
  }
  getDb()
    .insert(watchlist)
    .values({ symbol: normalized, addedAt: new Date().toISOString() })
    .onConflictDoNothing({ target: watchlist.symbol })
    .run();
  return normalized;
}

/** Remove a symbol from the watchlist (idempotent — no-op when absent). */
export function removeFromWatchlist(symbol: string): void {
  const normalized = normalizeSymbol(symbol);
  getDb().delete(watchlist).where(eq(watchlist.symbol, normalized)).run();
}

/** Raw watchlist rows, oldest-added first. */
export function listWatchlist(): WatchlistEntry[] {
  return getDb().select().from(watchlist).orderBy(asc(watchlist.addedAt)).all();
}

/* ------------------------------------------------------------------------ *
 * Enrichment
 * ------------------------------------------------------------------------ */

/** Options for {@link getWatchlistView} — the FMP client is injectable for tests. */
export interface WatchlistViewOptions {
  /** Override the FMP client (tests). Defaults to a cache-wired live/fixture client. */
  fmp?: FmpClient;
  /** Clock override (tests) — used to compute the earnings "from" window. */
  now?: () => Date;
}

/**
 * Build the enriched sidebar view for every watched symbol. Runs the three
 * enrichments per symbol concurrently; a failure in any one degrades that field
 * to null + a gap note and never rejects the whole view.
 *
 * Fixture mode (no FMP key) is expected: price/change/earnings become gaps, the
 * report join still works from the local DB.
 */
export async function getWatchlistView(
  options: WatchlistViewOptions = {},
): Promise<WatchlistRowView[]> {
  const entries = listWatchlist();
  const now = options.now ?? (() => new Date());
  const fmp = options.fmp ?? defaultFmpClient();

  return Promise.all(entries.map((entry) => enrichSymbol(entry.symbol, fmp, now)));
}

/**
 * Cache-wired FMP client (live when a key is present, fixtures otherwise).
 *
 * Uses the pipeline's canonical `makeFmpCachedFetch` bridge so watchlist reads
 * share the exact cache semantics of Stage A — including the M6 rule (a
 * transient empty FMP body never overwrites a good cached row) and the
 * provider max-stale ceiling. The watchlist hits the same api_cache rows the
 * pipeline reads, so a divergent bridge here could clobber pipeline inputs.
 */
function defaultFmpClient(): FmpClient {
  const config = getConfig();
  return createFmpClient({
    ...(config.fmpApiKey ? { apiKey: config.fmpApiKey } : {}),
    cachedFetch: makeFmpCachedFetch(),
  });
}

async function enrichSymbol(
  symbol: string,
  fmp: FmpClient,
  now: () => Date,
): Promise<WatchlistRowView> {
  const gaps: string[] = [];

  const [priceData, report, nextEarnings] = await Promise.all([
    loadPrice(symbol, fmp, gaps),
    loadReport(symbol, gaps),
    loadNextEarnings(symbol, fmp, now, gaps),
  ]);

  const runs = loadRuns(symbol, gaps);

  return {
    symbol,
    ...(priceData.companyName !== undefined ? { companyName: priceData.companyName } : {}),
    ...(report.companyName !== undefined && priceData.companyName === undefined
      ? { companyName: report.companyName }
      : {}),
    price: priceData.price,
    changePct: priceData.changePct,
    asOf: priceData.asOf,
    grades: report.grades,
    lastReportAt: report.lastReportAt,
    verificationRate: report.verificationRate,
    nextEarnings,
    runs,
    gaps,
  };
}

/** All saved run refs for the symbol (newest-first); degrades to [] + a note. */
function loadRuns(symbol: string, gaps: string[]): RunRef[] {
  try {
    return listRunRefsForSymbol(symbol);
  } catch (err) {
    gaps.push(`runs: ${errText(err)}`);
    return [];
  }
}

interface PriceEnrichment {
  price: number | null;
  changePct: number | null;
  asOf: string | null;
  companyName?: string;
}

/** FMP quote → price + change%; any gap/exception degrades to nulls + note. */
async function loadPrice(
  symbol: string,
  fmp: FmpClient,
  gaps: string[],
): Promise<PriceEnrichment> {
  try {
    const result = await fmp.quote(symbol);
    if (!result.ok) {
      gaps.push(`price: ${result.gap.reason}`);
      return { price: null, changePct: null, asOf: null };
    }
    const row = result.value.data.rows[0];
    if (row === undefined) {
      gaps.push("price: quote returned no rows");
      return { price: null, changePct: null, asOf: null };
    }
    const price = typeof row.price === "number" ? row.price : null;
    const changePct =
      typeof row.changePercentage === "number" ? row.changePercentage : null;
    if (price === null) gaps.push("price: quote row has no price");
    return {
      price,
      changePct,
      asOf: result.value.asOf,
      ...(typeof row.name === "string" && row.name.length > 0
        ? { companyName: row.name }
        : {}),
    };
  } catch (err) {
    gaps.push(`price: ${errText(err)}`);
    return { price: null, changePct: null, asOf: null };
  }
}

interface ReportEnrichment {
  grades: WatchlistGrades | null;
  lastReportAt: string | null;
  verificationRate: number | null;
  companyName?: string;
}

/** Latest done report → grade strip + as-of + verification rate. */
function loadReport(symbol: string, gaps: string[]): ReportEnrichment {
  try {
    const latest = getLatestDoneReport(symbol);
    if (latest === null) {
      return { grades: null, lastReportAt: null, verificationRate: null };
    }
    const grades = latest.report ? extractGrades(latest.report.verdict.gradeStrip) : null;
    if (latest.report === null) {
      gaps.push("report: stored JSON unreadable — grades unavailable");
    }
    return {
      grades,
      lastReportAt: latest.createdAt,
      verificationRate: latest.verificationRate,
      ...(latest.report?.meta.companyName
        ? { companyName: latest.report.meta.companyName }
        : {}),
    };
  } catch (err) {
    gaps.push(`report: ${errText(err)}`);
    return { grades: null, lastReportAt: null, verificationRate: null };
  }
}

/** Pull the six section grades out of a validated report's grade strip. */
function extractGrades(strip: {
  fundamentals: { grade: Grade };
  valuation: { grade: Grade };
  technicals: { grade: Grade };
  quality: { grade: Grade };
  leadership: { grade: Grade };
  moat: { grade: Grade };
}): WatchlistGrades {
  return {
    fundamentals: strip.fundamentals.grade,
    valuation: strip.valuation.grade,
    technicals: strip.technicals.grade,
    quality: strip.quality.grade,
    leadership: strip.leadership.grade,
    moat: strip.moat.grade,
  };
}

/**
 * Next future earnings date from FMP `earnings` (past + future rows; future
 * rows carry epsActual=null). We pick the earliest row dated on/after today.
 * Any gap/exception degrades to null + a note.
 */
async function loadNextEarnings(
  symbol: string,
  fmp: FmpClient,
  now: () => Date,
  gaps: string[],
): Promise<string | null> {
  try {
    const result = await fmp.earnings(symbol);
    if (!result.ok) {
      gaps.push(`earnings: ${result.gap.reason}`);
      return null;
    }
    const todayIso = now().toISOString().slice(0, 10);
    let next: string | null = null;
    for (const row of result.value.data.rows) {
      const date = typeof row.date === "string" ? row.date.slice(0, 10) : null;
      if (date === null || date.length < 10) continue;
      if (date < todayIso) continue;
      if (next === null || date < next) next = date;
    }
    if (next === null) gaps.push("earnings: no future earnings date found");
    return next;
  } catch (err) {
    gaps.push(`earnings: ${errText(err)}`);
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
