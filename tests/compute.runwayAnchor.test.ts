import { describe, expect, it } from "vitest";

import { newestBalanceRow } from "@/pipeline/compute";

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
