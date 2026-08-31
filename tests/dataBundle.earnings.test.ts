import { describe, expect, it } from "vitest";

import { deriveNextEarnings } from "@/pipeline/dataBundle";
import type { FetchResult, Sourced } from "@/types/core";
import type { FmpEarningsRow, FmpPayload } from "@/providers/fmp";

function earnings(rows: FmpEarningsRow[]): FetchResult<FmpPayload<FmpEarningsRow>> {
  const value: Sourced<FmpPayload<FmpEarningsRow>> = {
    data: { rows, raw: rows },
    asOf: "2026-07-05",
    source: "fmp",
    endpoint: "fmp://earnings",
    fetchedAt: "2026-07-05T00:00:00.000Z",
  };
  return { ok: true, value };
}

describe("deriveNextEarnings", () => {
  it("ignores malformed dates instead of treating them as future events", () => {
    const result = deriveNextEarnings(
      earnings([
        { date: "not-a-date", epsActual: null },
        { date: "2026-08-01T00:00:00Z", epsActual: null },
      ]),
      "2026-07-06",
      "AAPL",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The malformed row must not be selected — assert the SELECTED ROW, not the
    // envelope's asOf. Since 2026-08-31 `asOf` is the observation date the
    // derivation inherits from its parent envelope; the future event date lives
    // in the datum, so it is the datum that pins the selection.
    expect(result.value.data.date).toBe("2026-08-01T00:00:00Z");
    expect(result.value.asOf).toBe("2026-07-05");
  });

  it("does not accept impossible calendar dates", () => {
    const result = deriveNextEarnings(
      earnings([{ date: "9999-02-30", epsActual: null }]),
      "2026-07-06",
      "AAPL",
    );
    expect(result.ok).toBe(false);
  });
});
