import { describe, expect, it } from "vitest";

import {
  commonStartDate,
  rebasedLineData,
} from "@/components/charts/RelativeStrengthChart";

/**
 * A relative-strength chart exists to compare series. Rebasing each line to 100
 * at its OWN first bar makes that comparison false whenever the histories differ
 * in length: both start at 100, but on different dates, so the divergence is
 * measured from unrelated origins. Every line must share one origin.
 */
const stock = {
  rows: [
    { date: "2025-01-01", close: 50 },
    { date: "2025-06-01", close: 75 },
  ],
};
const benchmark = {
  rows: [
    { date: "2024-01-01", close: 100 },
    { date: "2025-01-01", close: 200 },
    { date: "2025-06-01", close: 220 },
  ],
};

describe("relative strength shares one rebasing origin", () => {
  it("picks the latest first-usable date across series", () => {
    expect(commonStartDate([stock, benchmark])).toBe("2025-01-01");
  });

  it("indexes every series to 100 on that same date", () => {
    const start = commonStartDate([stock, benchmark]);

    const s = rebasedLineData(stock.rows, start);
    const b = rebasedLineData(benchmark.rows, start);

    expect(s[0]).toMatchObject({ time: "2025-01-01", value: 100 });
    expect(b[0]).toMatchObject({ time: "2025-01-01", value: 100 });
  });

  it("measures both series over the same window", () => {
    const start = commonStartDate([stock, benchmark]);

    const s = rebasedLineData(stock.rows, start);
    const b = rebasedLineData(benchmark.rows, start);

    // Stock 50 -> 75 = +50%; benchmark 200 -> 220 = +10% over the SAME window.
    expect(s[s.length - 1].value).toBeCloseTo(150, 9);
    expect(b[b.length - 1].value).toBeCloseTo(110, 9);
    // The benchmark's pre-2025 doubling must not leak into the comparison.
    expect(b.some((p) => p.time === "2024-01-01")).toBe(false);
  });

  it("without a shared origin the benchmark would start a year earlier", () => {
    const b = rebasedLineData(benchmark.rows);
    expect(b[0]).toMatchObject({ time: "2024-01-01", value: 100 });
    // …and would show +120% against the stock's +50% over unequal windows.
    expect(b[b.length - 1].value).toBeCloseTo(220, 9);
  });

  it("returns null when no series has usable data", () => {
    expect(commonStartDate([{ rows: [] }, { rows: [{ date: "2025-01-01", close: 0 }] }])).toBeNull();
  });
});
