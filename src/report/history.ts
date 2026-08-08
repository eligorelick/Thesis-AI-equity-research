/**
 * Server-only report history queries (the application contract §8 "Report history: all saved
 * reports per ticker; diff view between any two dates").
 *
 * Reads the persisted `reports` rows (src/db/schema.ts) and, where the full
 * report content is needed, parses + validates the stored `reportJson` through
 * {@link ReportSchema} — the exact contract the pipeline persists against.
 *
 * Everything here is defensive: a malformed `reportJson` degrades to `report:
 * null` (list) or a null result (pair) rather than throwing, so a single bad
 * row never takes down the history page.
 *
 * Companion to src/report/query.ts (latest-done report for the company page);
 * this module adds the *history* surface (all rows, oldest+newest pairing for
 * the diff view) that query.ts intentionally does not cover.
 */

import "server-only";

import { desc, eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { reports, type ReportRow } from "@/db/schema";
import { parseStoredReportWithSafety } from "@/report/legacyEntitySafety";
import type { Report } from "@/report/schema";
import {
  GRADE_SURFACE_ORDER,
  gradeSurfaceEntries,
  type GradeSurfaceKey,
} from "@/report/surfaceManifest";
import {
  canonicalEntitySymbol,
  normalizeSymbol,
  sameEntitySymbol,
} from "@/symbol";
import type { Grade } from "@/types/core";

/* ------------------------------------------------------------------------ *
 * Grade extraction — one compact strip summary per graded section.
 * ------------------------------------------------------------------------ */

/** The graded sections of the strip, in canonical surface order. */
export { GRADE_SURFACE_ORDER as GRADE_STRIP_KEYS };
export type GradeStripKey = GradeSurfaceKey;

/** One cell of the compact grade strip shown in the history table. */
export interface GradeStripCell {
  key: GradeStripKey;
  grade: Grade;
}

/**
 * Pull the present section grades off a parsed {@link Report}, in a fixed order.
 * Exported so the history page and diff page share one extraction path.
 */
export function extractGradeStrip(report: Report): GradeStripCell[] {
  return gradeSurfaceEntries(report.verdict.gradeStrip).map(({ descriptor, block }) => ({
    key: descriptor.key,
    grade: block.grade,
  }));
}

/* ------------------------------------------------------------------------ *
 * Data-only detection — identical rule to the view API and ReportView
 * (a data-only report carries an `analysis.llm` missing-data manifest entry).
 * ------------------------------------------------------------------------ */

export function isDataOnly(report: Report): boolean {
  return report.appendix.missingData.some((m) => m.field === "analysis.llm");
}

/* ------------------------------------------------------------------------ *
 * ReportSummary — the row the history table renders (no full report content).
 * ------------------------------------------------------------------------ */

export interface ReportSummary {
  id: number;
  symbol: string;
  createdAt: string;
  model: string;
  status: string;
  /** Fraction of numeric claims traced (0..1), or null when unrun/unavailable. */
  verificationRate: number | null;
  costUsd: number | null;
  specVersion: string | null;
  /**
   * True when the LLM analysis did not run for this report (data-only). Null
   * when the report content could not be parsed, so the flag is unknown.
   */
  dataOnly: boolean | null;
  /**
   * The present section grades for the compact strip, or null when the report
   * content is unparseable (a row with no/invalid reportJson).
   */
  gradeStrip: GradeStripCell[] | null;
}

/** Defensively parse + validate a stored reportJson; null on any failure. */
export function parseStoredReport(reportJson: string | null): Report | null {
  return parseStoredReportWithSafety(reportJson)?.report ?? null;
}

/** Row and embedded identities must both be valid and name the same entity. */
function rowMatchesEmbeddedReport(row: ReportRow, report: Report): boolean {
  return (
    normalizeSymbol(row.symbol) !== null &&
    normalizeSymbol(report.meta.symbol) !== null &&
    sameEntitySymbol(row.symbol, report.meta.symbol)
  );
}

/** Build a {@link ReportSummary} from a raw row, parsing its report content. */
function toSummary(row: ReportRow): ReportSummary {
  const parsed = parseStoredReport(row.reportJson);
  const report =
    parsed !== null && rowMatchesEmbeddedReport(row, parsed) ? parsed : null;
  return {
    id: row.id,
    symbol: row.symbol,
    createdAt: row.createdAt,
    model: row.model,
    status: row.status,
    verificationRate: row.verificationRate,
    costUsd: row.costUsd,
    specVersion: row.specVersion,
    dataOnly: report ? isDataOnly(report) : null,
    gradeStrip: report ? extractGradeStrip(report) : null,
  };
}

/**
 * All persisted reports for a symbol, newest-first. Symbols are stored
 * uppercased by the runner; the caller is expected to uppercase before calling
 * (the history page does). Never throws on a malformed row — its `gradeStrip`
 * / `dataOnly` are null but the row still lists (so the user can still open or
 * diff a partial row and see its metadata).
 */
export function listReportsForSymbol(symbol: string): ReportSummary[] {
  const canonical = canonicalEntitySymbol(symbol);
  if (canonical === null) return [];
  const rows = getDb()
    .select()
    .from(reports)
    .where(
      sql`upper(replace(${reports.symbol}, '-', '.')) = ${canonical}`,
    )
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .all();
  return rows.map(toSummary);
}

/* ------------------------------------------------------------------------ *
 * RunRef — a lightweight per-run reference for navigation surfaces (sidebar).
 * ------------------------------------------------------------------------ */

/** A lightweight reference to one saved run — no report content parsed. */
export interface RunRef {
  id: number;
  createdAt: string;
  status: string;
}

/**
 * Every saved run for a symbol, newest-first — id/createdAt/status only, with NO
 * reportJson parse — so the sidebar can list all runs cheaply even for a symbol
 * with many. Symbols are stored uppercased by the runner; callers uppercase.
 */
export function listRunRefsForSymbol(symbol: string): RunRef[] {
  const canonical = canonicalEntitySymbol(symbol);
  if (canonical === null) return [];
  return getDb()
    .select({ id: reports.id, createdAt: reports.createdAt, status: reports.status })
    .from(reports)
    .where(
      sql`upper(replace(${reports.symbol}, '-', '.')) = ${canonical}`,
    )
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .all();
}

/* ------------------------------------------------------------------------ *
 * parseReportId — the trust boundary for URL-supplied report ids.
 * ------------------------------------------------------------------------ */

/**
 * Strictly parse a URL-supplied report id (path segment or query param).
 * Accepts ONLY a plain run of 1–15 ASCII digits — no sign, no whitespace, no
 * decimal point, no exponent, no hex prefix — so lax inputs like "12abc",
 * "12.9" or "1e5" are rejected instead of silently resolving to a *different*
 * report (the old `Number.parseInt` behavior truncated them to 12 / 12 / 1).
 * The 15-digit cap keeps every accepted value comfortably inside
 * `Number.MAX_SAFE_INTEGER` (16 digits).
 */
export function parseReportId(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

/* ------------------------------------------------------------------------ *
 * getReportRecordById / getReportById — full parsed report + its row, for the
 * diff/view/export surfaces.
 * ------------------------------------------------------------------------ */

export interface LoadedReport {
  row: ReportRow;
  report: Report;
}

/**
 * Discriminated load result — distinguishes an id that does not exist from a
 * row that exists but whose stored content is missing or unparseable, so HTTP
 * callers can answer 404 vs 422 honestly.
 */
export type ReportRecordResult =
  | { kind: "missing" }
  | { kind: "unparseable"; row: ReportRow }
  | { kind: "ok"; row: ReportRow; report: Report };

/**
 * Load one report row by id and parse its content.
 *
 *   - `missing`     — no row with this id (or the id is not a safe non-negative
 *                     integer, which can never match a rowid);
 *   - `unparseable` — the row exists but its `reportJson` is null, invalid
 *                     JSON, or fails {@link ReportSchema} validation;
 *   - `ok`          — row + fully validated {@link Report}.
 *
 * Never throws on bad stored content.
 */
export function getReportRecordById(id: number): ReportRecordResult {
  if (!Number.isSafeInteger(id) || id < 0) return { kind: "missing" };
  const row = getDb().select().from(reports).where(eq(reports.id, id)).get();
  if (row === undefined) return { kind: "missing" };
  const report = parseStoredReport(row.reportJson);
  if (report === null) return { kind: "unparseable", row };
  return { kind: "ok", row, report };
}

/**
 * Load one report by id and parse its content. Returns null when the id is
 * unknown OR the stored JSON fails schema validation (the caller renders a
 * friendly "unavailable" state rather than a crash). Callers that need to
 * distinguish those two cases use {@link getReportRecordById}.
 */
export function getReportById(id: number): LoadedReport | null {
  const record = getReportRecordById(id);
  return record.kind === "ok" ? { row: record.row, report: record.report } : null;
}

/** Load one report only when it belongs to the requested URL/company symbol. */
export function getReportByIdForSymbol(id: number, symbol: string): LoadedReport | null {
  const expected = normalizeSymbol(symbol);
  if (expected === null) return null;
  const loaded = getReportById(id);
  if (loaded === null) return null;
  return (
    sameEntitySymbol(expected, loaded.row.symbol) &&
    sameEntitySymbol(expected, loaded.report.meta.symbol)
  )
    ? loaded
    : null;
}

/* ------------------------------------------------------------------------ *
 * loadReportPair — the two reports a diff compares.
 * ------------------------------------------------------------------------ */

export interface ReportPair {
  a: LoadedReport;
  b: LoadedReport;
}

/**
 * Load two reports for diffing. The caller supplies them in the intended
 * diff order (`aId` = older, `bId` = newer); this function does NOT reorder —
 * ordering is the page's responsibility so it can surface a clear message when
 * the user picked them out of chronological order. Returns null when either id
 * is unknown/unparseable. `aId === bId` is allowed here (both resolve to the
 * same report); the diff page decides whether to warn.
 */
export function loadReportPair(aId: number, bId: number): ReportPair | null {
  const a = getReportById(aId);
  const b = getReportById(bId);
  if (a === null || b === null) return null;
  if (
    !rowMatchesEmbeddedReport(a.row, a.report) ||
    !rowMatchesEmbeddedReport(b.row, b.report)
  ) {
    return null;
  }
  if (!sameEntitySymbol(a.row.symbol, b.row.symbol)) return null;
  return { a, b };
}

/**
 * Symbol-scoped {@link loadReportPair}: additionally requires BOTH reports to
 * belong to the given company symbol (case-normalized, same rule as
 * {@link getReportByIdForSymbol}), so a diff URL under /company/AAPL can never
 * render another company's report via a foreign id in `?a`/`?b`. Returns null
 * when either id is unknown/unparseable OR either report belongs to a
 * different symbol.
 */
export function loadReportPairForSymbol(
  aId: number,
  bId: number,
  symbol: string,
): ReportPair | null {
  const expected = normalizeSymbol(symbol);
  if (expected === null) return null;
  const pair = loadReportPair(aId, bId);
  if (pair === null) return null;
  if (
    !sameEntitySymbol(expected, pair.a.row.symbol) ||
    !sameEntitySymbol(expected, pair.a.report.meta.symbol) ||
    !sameEntitySymbol(expected, pair.b.row.symbol) ||
    !sameEntitySymbol(expected, pair.b.report.meta.symbol)
  ) {
    return null;
  }
  return pair;
}

/**
 * Ensure a pair is in chronological (older → newer) order by `createdAt`,
 * returning the reordered pair plus a flag saying whether a swap happened.
 * `diffReports` is defined as diff(older, newer); the diff page uses this so
 * the arrows/deltas read correctly regardless of which id the user put in `?a`.
 */
export function orderPairChronologically(
  pair: ReportPair,
): { older: LoadedReport; newer: LoadedReport; swapped: boolean } {
  const { a, b } = pair;
  // Compare by createdAt (ISO, lexicographically sortable); tiebreak on id.
  const aKey = `${a.row.createdAt}#${String(a.row.id).padStart(12, "0")}`;
  const bKey = `${b.row.createdAt}#${String(b.row.id).padStart(12, "0")}`;
  if (aKey <= bKey) {
    return { older: a, newer: b, swapped: false };
  }
  return { older: b, newer: a, swapped: true };
}
