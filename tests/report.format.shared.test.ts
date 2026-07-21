import { describe, expect, it } from "vitest";

import {
  formatCostUsd,
  formatFinancialValue,
  formatVerificationClaim,
  roundedDisplayedCostTotal,
} from "@/report/format";

describe("shared report formatting", () => {
  it.each([
    [60_958_000_000, "USD", "$60.96B"],
    [3_450_000_000, "currency", "$3.45B"],
    [274.125, "USD/share", "$274.13"],
    [18.234, "%", "18.2%"],
    [1.82, "x", "1.8×"],
  ])("formats %s %s as %s", (value, unit, expected) => {
    expect(formatFinancialValue(value as number, unit as string)).toBe(expected);
  });

  it("makes displayed step costs add exactly to the displayed total", () => {
    const rows = [0.1111114, 0.2222226, 0.3333337];
    expect(rows.map(formatCostUsd)).toEqual(["$0.111111", "$0.222223", "$0.333334"]);
    expect(formatCostUsd(roundedDisplayedCostTotal(rows))).toBe("$0.666668");
  });

  it("formats legacy verification claims without raw USD or duplicate dates", () => {
    expect(formatVerificationClaim(
      "60958000000 USD [payload.segments.product · 2025-12-31 · 2025-12-31]",
    )).toBe("$60.96B [payload.segments.product · 2025-12-31]");
  });
});
