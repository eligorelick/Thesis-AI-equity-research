import { describe, expect, it } from "vitest";

import { range52w } from "@/pipeline/stageB/technicals";
import { metricPolicy } from "@/pipeline/stageB/sectorRouting";

/**
 * `range52w` filtered to the trailing 12 months but never checked that 12
 * months of history EXIST, so a stock with three months of trading reported a
 * three-month high/low labelled "52-week" — and `positionPct` feeds a
 * 0.25-weight momentum signal, so the fake range was scored.
 *
 * `maxDrawdown` in the same module already had exactly this guard
 * (`rows[0].date > cutoff`), which is what makes the omission a bug rather than
 * a design choice.
 *
 * Separately, the recent-ipo route lists "fiftyTwoWeekRange" in its suppress
 * set — but no signal carried that tag, so the policy was inert.
 */
const bar = (date: string, price: number) => ({
  date,
  open: price,
  high: price + 1,
  low: price - 1,
  close: price,
  volume: 1_000,
});

/** Daily-ish bars spanning `months` back from 2026-06-30. */
function history(months: number) {
  const rows = [];
  const end = Date.parse("2026-06-30T00:00:00Z");
  for (let d = months * 30; d >= 0; d -= 5) {
    const iso = new Date(end - d * 86_400_000).toISOString().slice(0, 10);
    rows.push(bar(iso, 100 + (d % 17)));
  }
  return rows;
}

describe("range52w requires a full year of history", () => {
  it("reports the range when history spans more than 12 months", () => {
    const r = range52w(history(18));

    expect(r.insufficientHistory).toBe(false);
    expect(r.high52w).not.toBeNull();
    expect(r.low52w).not.toBeNull();
    expect(r.positionPct).not.toBeNull();
  });

  it("does NOT present a three-month range as a 52-week range", () => {
    const r = range52w(history(3));

    expect(r.insufficientHistory).toBe(true);
    expect(r.high52w).toBeNull();
    expect(r.low52w).toBeNull();
    // The graded signal must not band a window shorter than its own label.
    expect(r.positionPct).toBeNull();
    // The observation date is still reported.
    expect(r.asOf).not.toBeNull();
  });

  it("tolerates a first bar a few days inside the boundary (weekends/holidays)", () => {
    const rows = history(12);
    const r = range52w(rows);

    expect(r.insufficientHistory).toBe(false);
  });

  it("returns the empty shape for no rows", () => {
    const r = range52w([]);

    expect(r.insufficientHistory).toBe(false);
    expect(r.high52w).toBeNull();
  });
});

describe("the recent-ipo 52-week suppression is actually wired", () => {
  it("suppresses fiftyTwoWeekRange, which a graded signal now carries", () => {
    const recentIpo = metricPolicy({
      base: "general",
      overlays: ["recent-ipo"],
      evidence: { sector: "Technology", industry: "Software" },
    });

    expect(recentIpo.suppress).toContain("fiftyTwoWeekRange");
    // A seasoned issuer is still scored on its 52-week position.
    expect(metricPolicy("general").suppress).not.toContain("fiftyTwoWeekRange");
  });
});
