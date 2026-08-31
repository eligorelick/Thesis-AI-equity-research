import { describe, expect, it } from "vitest";

import {
  contiguousQuarterWindows,
  normalizeQuarterRows,
  quarterWindowViolation,
  type FiscalDatedRow,
} from "@/pipeline/stageB/quarterWindows";

interface TestQuarter extends FiscalDatedRow {
  id: string;
  value?: number;
}

function calendarQuarterEnds(count: number): string[] {
  const suffixes = ["12-31", "09-30", "06-30", "03-31"] as const;
  return Array.from({ length: count }, (_, index) => {
    const year = 2026 - Math.floor(index / 4);
    return `${year}-${suffixes[index % 4]}`;
  });
}

function quarters(count: number): TestQuarter[] {
  return calendarQuarterEnds(count).map((date, index) => ({ date, id: `q${index}`, value: index }));
}

describe("normalizeQuarterRows", () => {
  it("sorts real Gregorian fiscal dates newest-first without mutating rows or input order", () => {
    const oldest = Object.freeze<TestQuarter>({ date: "2024-02-29", id: "leap" });
    const newest = Object.freeze<TestQuarter>({ date: "2025-03-31", id: "newest" });
    const middle = Object.freeze<TestQuarter>({ date: "2024-12-31", id: "middle" });
    const input = Object.freeze([oldest, newest, middle] as const);

    const normalized = normalizeQuarterRows(input);

    expect(normalized.rows.map((row) => row.id)).toEqual(["newest", "middle", "leap"]);
    expect(normalized.rows[0]).toBe(newest);
    expect(input.map((row) => row.id)).toEqual(["leap", "newest", "middle"]);
    expect(normalized.rejected).toEqual([]);
  });

  it.each([
    ["non-leap February 29", "2025-02-29"],
    ["April 31", "2025-04-31"],
    ["date suffix", "2025-03-31junk"],
    ["timestamp instead of a fiscal day", "2025-03-31T00:00:00Z"],
    ["blank", ""],
    ["non-string", 20_250_331],
    ["missing", null],
  ])("rejects %s rather than letting Date.parse coerce it", (_label, date) => {
    const result = normalizeQuarterRows([{ id: "bad", date }]);

    expect(result.rows).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/invalid.*fiscal.*date/i);
  });

  it("selects the uniquely latest whole duplicate row by canonical FMP acceptedDate", () => {
    const older: TestQuarter = {
      date: "2025-12-31",
      acceptedDate: "2026-02-15 15:59:59",
      filingDate: "2026-02-15",
      id: "older",
      value: 10,
    };
    const latest: TestQuarter = {
      date: "2025-12-31",
      acceptedDate: "2026-02-15 16:00:00",
      filingDate: "2026-02-15",
      id: "latest",
      value: 20,
    };

    const result = normalizeQuarterRows([older, latest]);

    expect(result.rows).toEqual([latest]);
    expect(result.rows[0].value).toBe(20);
    expect(result.rejected).toEqual([]);
  });

  it("selects a duplicate by a provably later filing day when acceptedDate is absent", () => {
    const later: TestQuarter = {
      date: "2025-12-31",
      filingDate: "2026-02-16",
      id: "later",
    };
    const earlier: TestQuarter = {
      date: "2025-12-31",
      filingDate: "2026-02-15",
      id: "earlier",
    };

    const result = normalizeQuarterRows([later, earlier]);

    expect(result.rows).toEqual([later]);
    expect(result.rejected).toEqual([]);
  });

  it("accepts a unique latest candidate even when two older candidates tie", () => {
    const result = normalizeQuarterRows<TestQuarter>([
      { date: "2025-12-31", acceptedDate: "2026-02-15 16:00:00", id: "latest" },
      { date: "2025-12-31", acceptedDate: "2026-02-15 15:00:00", id: "old-a" },
      { date: "2025-12-31", acceptedDate: "2026-02-15 15:00:00", id: "old-b" },
    ]);

    expect(result.rows.map((row) => row.id)).toEqual(["latest"]);
    expect(result.rejected).toEqual([]);
  });

  it.each([
    {
      label: "tied accepted timestamps",
      rows: [
        { date: "2025-12-31", acceptedDate: "2026-02-15 16:00:00", id: "a" },
        { date: "2025-12-31", acceptedDate: "2026-02-15 16:00:00", id: "b" },
      ],
    },
    {
      label: "one missing recency value",
      rows: [
        { date: "2025-12-31", acceptedDate: "2026-02-15 16:00:00", id: "a" },
        { date: "2025-12-31", id: "b" },
      ],
    },
    {
      label: "one invalid accepted timestamp",
      rows: [
        { date: "2025-12-31", acceptedDate: "2026-02-15 16:00:00", id: "a" },
        { date: "2025-12-31", acceptedDate: "2026-02-30 16:00:00", filingDate: "2026-03-01", id: "b" },
      ],
    },
    {
      label: "recency metadata before the fiscal period end",
      rows: [
        { date: "2025-12-31", acceptedDate: "2026-02-15 16:00:00", id: "a" },
        { date: "2025-12-31", filingDate: "2025-12-30", id: "b" },
      ],
    },
    {
      label: "same-day mixed timestamp and day precision",
      rows: [
        { date: "2025-12-31", acceptedDate: "2026-02-15 16:00:00", id: "a" },
        { date: "2025-12-31", filingDate: "2026-02-15", id: "b" },
      ],
    },
  ])("rejects the whole duplicate period when recency is ambiguous: $label", ({ rows }) => {
    const result = normalizeQuarterRows(rows);

    expect(result.rows).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].period).toBe("2025-12-31");
    expect(result.rejected[0].reason).toMatch(/duplicate|recency|ambiguous|invalid/i);
  });

  it("proves mixed-precision recency when the candidate days do not overlap", () => {
    const later: TestQuarter = {
      date: "2025-12-31",
      acceptedDate: "2026-02-16 00:00:00",
      id: "later",
    };
    const earlier: TestQuarter = {
      date: "2025-12-31",
      filingDate: "2026-02-15",
      id: "earlier",
    };

    expect(normalizeQuarterRows([earlier, later])).toEqual({ rows: [later], rejected: [] });
  });
});

describe("quarterWindowViolation", () => {
  const valid = ["2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30"].map((date) => ({ date }));

  it("requires exactly four rows", () => {
    expect(quarterWindowViolation(valid.slice(0, 3))).toMatch(/exactly 4|received 3/i);
    expect(quarterWindowViolation([...valid, { date: "2025-03-31" }])).toMatch(/exactly 4|received 5/i);
  });

  it("accepts ordinary and 53-week fiscal calendars", () => {
    expect(quarterWindowViolation(valid)).toBeNull();
    expect(
      quarterWindowViolation(
        ["2026-02-01", "2025-10-26", "2025-07-27", "2025-04-27"].map((date) => ({ date })),
      ),
    ).toBeNull();
  });

  it("rejects duplicates, out-of-order rows, impossible dates, missing quarters, and invalid total spans", () => {
    expect(quarterWindowViolation([{ date: "2026-03-31" }, { date: "2026-03-31" }, ...valid.slice(1, 3)])).toMatch(/duplicate/i);
    expect(quarterWindowViolation([...valid].reverse())).toMatch(/descending order/i);
    expect(quarterWindowViolation([{ date: "2025-04-31" }, ...valid.slice(1)])).toMatch(/invalid|unparseable/i);
    expect(
      quarterWindowViolation(
        ["2026-03-31", "2025-12-31", "2025-06-30", "2025-03-31"].map((date) => ({ date })),
      ),
    ).toMatch(/non-contiguous/i);
    expect(
      quarterWindowViolation(
        ["2026-03-31", "2026-01-20", "2025-11-10", "2025-09-01"].map((date) => ({ date })),
      ),
    ).toMatch(/span|trailing twelve/i);
  });
});

describe("contiguousQuarterWindows", () => {
  it("returns all nine rolling windows from twelve contiguous quarters", () => {
    const result = contiguousQuarterWindows(quarters(12), 20);

    expect(result.windows).toHaveLength(9);
    expect(result.windows.map((window) => window[0].date)).toEqual(calendarQuarterEnds(9));
    expect(result.rejected).toEqual([]);
  });

  it("returns five valid windows and three deterministic rejections after a middle quarter is removed", () => {
    const input = quarters(12).filter((_row, index) => index !== 5);
    const result = contiguousQuarterWindows(input, 20);

    expect(result.windows).toHaveLength(5);
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected.map((entry) => entry.anchor)).toEqual([
      "2026-06-30",
      "2026-03-31",
      "2025-12-31",
    ]);
    expect(result.rejected.every((entry) => /non-contiguous/i.test(entry.reason))).toBe(true);
  });

  it("scans beyond invalid early anchors until maxValid valid windows are found", () => {
    const input = quarters(27);
    input[5] = { ...input[5], date: "2024-09-31", id: "impossible" };
    const normalized = normalizeQuarterRows(input);
    const result = contiguousQuarterWindows(normalized.rows, 20);

    expect(normalized.rejected).toHaveLength(1);
    expect(result.windows).toHaveLength(20);
    expect(result.rejected).toHaveLength(3);
    expect(result.windows.at(-1)?.[0].date).toBe("2021-03-31");
  });

  it("honors a valid-window cap without letting rejected anchors consume it", () => {
    const input = quarters(12).filter((_row, index) => index !== 5);
    const result = contiguousQuarterWindows(input, 2);

    expect(result.windows).toHaveLength(2);
    expect(result.windows.map((window) => window[0].date)).toEqual(["2026-12-31", "2026-09-30"]);
    expect(contiguousQuarterWindows(input, 0)).toEqual({ windows: [], rejected: [] });
  });
});

/**
 * The gap checks validate the three intervals BETWEEN a window's four rows,
 * which proves internal spacing but says nothing about the duration of the
 * OLDEST quarter — that is the interval from the period before it. A
 * transition or stub period sitting in the oldest slot therefore entered the
 * TTM sum unchecked and understated every trailing-twelve-month figure.
 */
describe("the oldest quarter's own duration is validated when the prior row is known", () => {
  const row = (date: string) => ({ date });

  it("rejects a window whose oldest slot is a short transition period", () => {
    // 2025-02-28 sits only ~59 days after 2024-12-31: a stub, not a quarter.
    const window = [row("2025-11-30"), row("2025-08-31"), row("2025-05-31"), row("2025-02-28")];

    expect(quarterWindowViolation(window, row("2024-12-31"))).toMatch(/stub|transition|spans only/i);
  });

  it("accepts the same window when the prior row is a normal quarter", () => {
    const window = [row("2025-12-31"), row("2025-09-30"), row("2025-06-30"), row("2025-03-31")];

    expect(quarterWindowViolation(window, row("2024-12-31"))).toBeNull();
  });

  it("does NOT reject when earlier history is merely missing", () => {
    // A distant prior row means absent history, not a short quarter.
    const window = [row("2025-12-31"), row("2025-09-30"), row("2025-06-30"), row("2025-03-31")];

    expect(quarterWindowViolation(window, row("2022-12-31"))).toBeNull();
  });

  it("is unchanged when no prior row is supplied", () => {
    const window = [row("2025-12-31"), row("2025-09-30"), row("2025-06-30"), row("2025-03-31")];

    expect(quarterWindowViolation(window)).toBeNull();
  });
});
