import { describe, expect, it } from "vitest";

import { latestOnOrBeforeWithin } from "@/pipeline/stageB/asOfSelection";

interface TestRow {
  date: string;
  value: number | null;
}

describe("latestOnOrBeforeWithin", () => {
  it("chooses the latest prior row instead of a closer future row", () => {
    const prior = { date: "2025-03-28", value: 28 };
    const future = { date: "2025-04-01", value: 1 };

    expect(latestOnOrBeforeWithin([future, prior], "2025-03-31", 45)).toBe(prior);
  });

  it("returns null when every valid candidate is after the as-of date", () => {
    expect(
      latestOnOrBeforeWithin(
        [
          { date: "2025-04-01", value: 1 },
          { date: "2025-04-02", value: 2 },
        ],
        "2025-03-31",
        45,
      ),
    ).toBeNull();
  });

  it("accepts an exact same-day observation", () => {
    const sameDay = { date: "2025-03-31", value: 31 };
    expect(latestOnOrBeforeWithin([sameDay], "2025-03-31", 45)).toBe(sameDay);
  });

  it("accepts the 45-day boundary and rejects 46 days", () => {
    const day45 = { date: "2025-02-14", value: 45 };
    const day46 = { date: "2025-02-13", value: 46 };

    expect(latestOnOrBeforeWithin([day46, day45], "2025-03-31", 45)).toBe(day45);
    expect(latestOnOrBeforeWithin([day46], "2025-03-31", 45)).toBeNull();
  });

  it("is order-independent for unsorted distinct dates", () => {
    const latest = { date: "2025-03-29", value: 29 };
    const rows = [
      { date: "2025-02-20", value: 20 },
      latest,
      { date: "2025-03-01", value: 1 },
    ];

    expect(latestOnOrBeforeWithin(rows, "2025-03-31", 45)).toBe(latest);
  });

  it("selects the latest eligible prior date rather than the first eligible row", () => {
    const latest = { date: "2025-03-30", value: 30 };
    expect(
      latestOnOrBeforeWithin(
        [
          { date: "2025-03-01", value: 1 },
          { date: "2025-03-28", value: 28 },
          latest,
        ],
        "2025-03-31",
        45,
      ),
    ).toBe(latest);
  });

  it("preserves the first input row when the selected date is duplicated", () => {
    const first = { date: "2025-03-28", value: 1 };
    const second = { date: "2025-03-28", value: 2 };

    expect(latestOnOrBeforeWithin([first, second], "2025-03-31", 45)).toBe(first);
  });

  it("ignores impossible, timestamp-suffixed, and locale-formatted candidate dates", () => {
    const valid = { date: "2025-03-28", value: 28 };
    expect(
      latestOnOrBeforeWithin(
        [
          { date: "2025-02-30", value: 230 },
          { date: "2025-03-30T00:00:00Z", value: 300 },
          { date: "03/30/2025", value: 330 },
          valid,
        ],
        "2025-03-31",
        45,
      ),
    ).toBe(valid);
  });

  it.each(["2025-02-30", "2025-03-31T00:00:00Z", "03/31/2025", ""])(
    "fails closed for invalid as-of date %j",
    (asOf) => {
      expect(latestOnOrBeforeWithin([{ date: "2025-03-28", value: 28 }], asOf, 45)).toBeNull();
    },
  );

  it("uses a zero-day tolerance for same-day rows only", () => {
    const sameDay = { date: "2025-03-31", value: 31 };
    expect(latestOnOrBeforeWithin([sameDay], "2025-03-31", 0)).toBe(sameDay);
    expect(
      latestOnOrBeforeWithin([{ date: "2025-03-30", value: 30 }], "2025-03-31", 0),
    ).toBeNull();
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE])(
    "fails closed for invalid or overflowing maxAgeDays %s",
    (maxAgeDays) => {
      expect(
        latestOnOrBeforeWithin([{ date: "2025-03-31", value: 31 }], "2025-03-31", maxAgeDays),
      ).toBeNull();
    },
  );

  it("accepts a real leap day and ignores an impossible non-leap day", () => {
    const leapDay = { date: "2024-02-29", value: 29 };
    expect(
      latestOnOrBeforeWithin(
        [
          { date: "2023-02-29", value: 2023 },
          leapDay,
        ],
        "2024-02-29",
        45,
      ),
    ).toBe(leapDay);
  });

  it("does not mutate the input array or its rows", () => {
    const rows: TestRow[] = [
      { date: "2025-03-30", value: 30 },
      { date: "2025-03-01", value: 1 },
      { date: "2025-03-28", value: 28 },
    ];
    const orderBefore = [...rows];
    const bytesBefore = JSON.stringify(rows);

    latestOnOrBeforeWithin(rows, "2025-03-31", 45);

    expect(rows).toEqual(orderBefore);
    expect(rows.every((row, index) => row === orderBefore[index])).toBe(true);
    expect(JSON.stringify(rows)).toBe(bytesBefore);
  });

  it("selects the latest eligible row even when its financial value is null", () => {
    const latest: TestRow = { date: "2025-03-30", value: null };
    const older: TestRow = { date: "2025-03-28", value: 28 };

    expect(latestOnOrBeforeWithin([older, latest], "2025-03-31", 45)).toBe(latest);
  });
});
