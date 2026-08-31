import { describe, expect, it } from "vitest";

import { computeGrowth } from "@/pipeline/stageB/growth";

/**
 * `computeGrowth` never collapsed duplicate/restated annual fiscal periods.
 * FMP can return the same fiscal year twice — an original and its restatement —
 * and both rows entered every series, so:
 *
 *   - an "N-year" CAGR window counted one fiscal year as two and therefore
 *     spanned N-1 actual years, and
 *   - the window could anchor on the SUPERSEDED figure rather than the
 *     restated one.
 *
 * The house rule already exists for quarters in `normalizeQuarterRows`: whole
 * row, provably-latest filing wins, ambiguous duplicates rejected rather than
 * guessed at. It is period-agnostic, so annual rows use it unchanged.
 */
const OPTIONS = { period: "annual" } as const;

const inc = (
  date: string,
  revenue: number,
  filed: string | null,
): Record<string, unknown> => ({
  date,
  revenue,
  netIncome: revenue * 0.1,
  epsDiluted: revenue * 0.001,
  ...(filed === null ? {} : { acceptedDate: filed, filingDate: filed }),
});

describe("computeGrowth collapses restated annual periods", () => {
  it("keeps one row per fiscal year and prefers the most recently filed", () => {
    const rows = [
      inc("2025-12-31", 1000, "2026-02-01"),
      // FY2024 appears twice. The SUPERSEDED original is listed first, so a
      // naive stable sort would anchor the window on it — that is exactly the
      // failure being guarded against, and it makes this test discriminating.
      inc("2024-12-31", 900, "2025-02-01"),
      inc("2024-12-31", 850, "2025-06-01"),
      inc("2023-12-31", 800, "2024-02-01"),
    ];

    const r = computeGrowth(rows as never, [], OPTIONS);
    const oneYear = r.revenueCagrs.find((c) => c.windowYears === 1);

    expect(oneYear).toBeDefined();
    expect(oneYear?.endDate).toBe("2025-12-31");
    expect(oneYear?.endValue).toBe(1000);
    // The one-year window must land on FY2024, spanning one actual year...
    expect(oneYear?.startDate).toBe("2024-12-31");
    expect(oneYear?.actualYears).toBe(1);
    // ...anchored on the RESTATED figure, not the superseded original.
    expect(oneYear?.startValue).toBe(850);
  });

  it("discloses the collapse in notes", () => {
    const rows = [
      inc("2025-12-31", 1000, "2026-02-01"),
      inc("2024-12-31", 850, "2025-06-01"),
      inc("2024-12-31", 900, "2025-02-01"),
    ];

    const r = computeGrowth(rows as never, [], OPTIONS);

    expect(r.notes.join(" ")).toMatch(/restated|collapsed|duplicate/i);
  });

  it("rejects an ambiguous duplicate rather than guessing which row is current", () => {
    // Neither row carries a filing date, so recency cannot be established.
    const rows = [
      inc("2025-12-31", 1000, "2026-02-01"),
      inc("2024-12-31", 850, null),
      inc("2024-12-31", 900, null),
    ];

    const r = computeGrowth(rows as never, [], OPTIONS);
    const oneYear = r.revenueCagrs.find((c) => c.windowYears === 1);

    // FY2024 is gone entirely rather than silently resolved to a guess.
    expect(oneYear?.startDate).not.toBe("2024-12-31");
    expect(r.gaps.some((g) => /ambiguous|duplicate/i.test(g.reason))).toBe(true);
  });

  it("leaves a clean series untouched", () => {
    const rows = [
      inc("2025-12-31", 1000, "2026-02-01"),
      inc("2024-12-31", 900, "2025-02-01"),
      inc("2023-12-31", 800, "2024-02-01"),
    ];

    const r = computeGrowth(rows as never, [], OPTIONS);
    const oneYear = r.revenueCagrs.find((c) => c.windowYears === 1);

    expect(oneYear?.startValue).toBe(900);
    expect(oneYear?.endValue).toBe(1000);
    expect(r.notes.join(" ")).not.toMatch(/collapsed/i);
  });
});
