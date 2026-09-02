import { describe, expect, it } from "vitest";

import { newestBalanceRow, pickBalanceAnchor } from "@/pipeline/compute";

/**
 * The runway model anchors liquidity on one balance row. Preferring the
 * quarterly row unconditionally used stale cash whenever the newest annual row
 * was more recent — the ordinary case once a 10-K is filed but the matching
 * quarter is not yet published, or when quarterly coverage lags.
 */
const row = (date: string, cash: number) => ({ date, cashAndCashEquivalents: cash });

describe("runway liquidity anchor", () => {
  it("uses the annual row when it is newer than the newest quarter", () => {
    const picked = newestBalanceRow(row("2025-06-30", 10), row("2025-12-31", 90));
    expect(picked?.date).toBe("2025-12-31");
    expect(picked?.cashAndCashEquivalents).toBe(90);
  });

  it("uses the quarterly row when it is newer", () => {
    const picked = newestBalanceRow(row("2026-03-31", 55), row("2025-12-31", 90));
    expect(picked?.date).toBe("2026-03-31");
  });

  it("keeps the quarterly row when both cover the same period end", () => {
    const picked = newestBalanceRow(row("2025-12-31", 55), row("2025-12-31", 90));
    expect(picked?.cashAndCashEquivalents).toBe(55);
  });

  it("falls back to whichever row exists", () => {
    expect(newestBalanceRow(undefined, row("2025-12-31", 90))?.date).toBe("2025-12-31");
    expect(newestBalanceRow(row("2026-03-31", 55), undefined)?.date).toBe("2026-03-31");
    expect(newestBalanceRow(undefined, undefined)).toBeUndefined();
  });

  it("tolerates a missing or non-string date without throwing", () => {
    // FMP rows reach compute.ts loosely typed, so a row can arrive undated.
    const undated: { date?: string; cashAndCashEquivalents: number } = {
      cashAndCashEquivalents: 5,
    };
    const dated: { date?: string; cashAndCashEquivalents: number } = {
      date: "2025-12-31",
      cashAndCashEquivalents: 90,
    };

    expect(newestBalanceRow(undated, dated)?.date).toBe("2025-12-31");
    expect(newestBalanceRow(dated, undated)?.date).toBe("2025-12-31");
  });
});


describe("valuation balance anchor", () => {
  type Row = { date: string; totalDebt: number | null; totalStockholdersEquity: number | null; cashAndShortTermInvestments: number | null };
  const complete = (date: string): Row => ({ date, totalDebt: 43_330, totalStockholdersEquity: 21_318, cashAndShortTermInvestments: 9_980 });
  const bare = (date: string): Row => ({ date, totalDebt: null, totalStockholdersEquity: null, cashAndShortTermInvestments: null });

  it("prefers the newer row when it carries the anchor fields", () => {
    const picked = pickBalanceAnchor(complete("2026-06-30"), complete("2025-12-31"));
    expect(picked).toMatchObject({ basis: "quarter", fallback: null });
    expect(picked.row?.date).toBe("2026-06-30");
  });

  it("falls back to the older whole row when the newest lacks a field, and names what it lacks", () => {
    // Caterpillar's 10-Q balance sheet tags no us-gaap debt line at all; its
    // 10-K carries the debt through the maturity schedule.
    const partial: Row = { date: "2026-06-30", totalDebt: null, totalStockholdersEquity: 19_395, cashAndShortTermInvestments: 6_713 };
    const picked = pickBalanceAnchor(partial, complete("2025-12-31"));
    expect(picked.basis).toBe("annual");
    expect(picked.row?.date).toBe("2025-12-31");
    expect(picked.fallback).toBe(
      "balance anchor: the newest balance row (quarter 2026-06-30) lacks totalDebt, so net debt, invested capital and the EV bridge use the annual row as of 2025-12-31, the newest row carrying totalDebt, totalStockholdersEquity and cashAndShortTermInvestments",
    );
  });

  it("lists every lacking field when the newest row carries none of them", () => {
    const picked = pickBalanceAnchor(bare("2026-06-30"), complete("2025-12-31"));
    expect(picked.basis).toBe("annual");
    expect(picked.fallback).toContain("lacks totalDebt, totalStockholdersEquity and cashAndShortTermInvestments, so");
  });

  it("keeps the newest row when the older row is not whole either (fields are never mixed across periods)", () => {
    const olderPartial: Row = { date: "2025-12-31", totalDebt: 43_330, totalStockholdersEquity: 21_318, cashAndShortTermInvestments: null };
    const picked = pickBalanceAnchor(bare("2026-06-30"), olderPartial);
    expect(picked).toMatchObject({ basis: "quarter", fallback: null });
  });

  it("keeps the newest row when both are bare", () => {
    const picked = pickBalanceAnchor(bare("2026-06-30"), bare("2025-12-31"));
    expect(picked).toMatchObject({ basis: "quarter", fallback: null });
  });

  it("uses whichever row exists", () => {
    expect(pickBalanceAnchor(null, complete("2025-12-31")).basis).toBe("annual");
    expect(pickBalanceAnchor(complete("2026-06-30"), null).basis).toBe("quarter");
    expect(pickBalanceAnchor(null, null)).toEqual({ row: null, basis: undefined, fallback: null });
  });
});
