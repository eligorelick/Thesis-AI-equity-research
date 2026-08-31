import { describe, expect, it } from "vitest";

import { currencyAxisTick } from "@/components/charts/format";

/**
 * Axis ticks land on values like 1.5e9 as often as on round ones. Rounding the
 * label to whole units printed that gridline as "$2B" — a label that misstates
 * the line it sits on — and made neighbouring ticks collide on one label.
 */
describe("currency axis tick labels", () => {
  it("labels a half-unit gridline with its real value", () => {
    expect(currencyAxisTick(1.5e9)).toBe("$1.5B");
    expect(currencyAxisTick(4.5e9)).toBe("$4.5B");
  });

  it("gives a realistic tick sequence distinct labels", () => {
    const ticks = [0, 1.5e9, 3e9, 4.5e9, 6e9].map(currencyAxisTick);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it("keeps each scale suffix", () => {
    expect(currencyAxisTick(2.5e12)).toBe("$2.5T");
    expect(currencyAxisTick(2.5e6)).toBe("$2.5M");
    expect(currencyAxisTick(2.5e3)).toBe("$2.5K");
  });

  it("keeps the sign and handles missing values", () => {
    expect(currencyAxisTick(-1.5e9)).toBe("-$1.5B");
    expect(currencyAxisTick(null)).toBe("—");
    expect(currencyAxisTick(Number.NaN)).toBe("—");
  });
});
