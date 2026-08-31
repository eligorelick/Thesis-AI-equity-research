/**
 * Server-only report queries. Reads persisted reports (src/db/schema.ts `reports`)
 * for the UI surfaces — currently the latest completed report for a symbol, which
 * the /company/[symbol] page renders in full via ReportView.
 *
 * Defensive: a malformed stored reportJson degrades to `report: null` rather than
 * throwing, so the caller can fall back to the compact/generate flow.
 */

import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { reports } from "@/db/schema";
import type { Report } from "@/report/schema";
import { parseStoredReport } from "@/report/history";
import { canonicalEntitySymbol } from "@/symbol";

export interface LatestReport {
  reportId: number;
  symbol: string;
  createdAt: string;
  model: string;
  status: string;
  costUsd: number | null;
  verificationRate: number | null;
  specVersion: string | null;
  /** Parsed + schema-validated Report, or null when the stored JSON is unusable. */
  report: Report | null;
}

/**
 * The most recent `done` report for a symbol (case-insensitive on the caller's
 * side — symbols are stored uppercased by the runner). Returns null when none
 * exists. Never throws on a malformed row: `report` is null in that case.
 */
export function getLatestDoneReport(symbol: string): LatestReport | null {
  // Match `listReportsForSymbol`: fold case and the dot/hyphen share-class alias
  // in SQL. Raw equality here made History list a report that this lookup — the
  // one the company page and the watchlist row use — reported as missing.
  const canonical = canonicalEntitySymbol(symbol);
  if (canonical === null) return null;
  const row = getDb()
    .select()
    .from(reports)
    .where(
      and(
        sql`upper(replace(${reports.symbol}, '-', '.')) = ${canonical}`,
        eq(reports.status, "done"),
      ),
    )
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .limit(1)
    .get();

  if (row === undefined) return null;

  // Single parse authority: history.parseStoredReport (strict parse with the
  // legacy-read fallback), so the watchlist join renders reports saved under
  // earlier spec versions exactly like the history/view surfaces do.
  const report: Report | null = parseStoredReport(row.reportJson);

  return {
    reportId: row.id,
    symbol: row.symbol,
    createdAt: row.createdAt,
    model: row.model,
    status: row.status,
    costUsd: row.costUsd,
    verificationRate: row.verificationRate,
    specVersion: row.specVersion,
    report,
  };
}
