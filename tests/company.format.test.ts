import { describe, expect, it } from "vitest";

import * as CompanyFormat from "@/app/company/[symbol]/format";

type FractionPctFormatter = (
  value: number | null | undefined,
  digits?: number,
) => string;

const fmtFractionPct = (
  CompanyFormat as unknown as { fmtFractionPct?: FractionPctFormatter }
).fmtFractionPct;

describe("fmtFractionPct", () => {
  it("is exported as the company-page formatter for fractional ratios", () => {
    expect(fmtFractionPct).toBeTypeOf("function");
  });

  it("renders missing and non-finite fractions as n/a before scaling", () => {
    for (const value of [null, undefined, Number.NaN, Infinity, -Infinity]) {
      expect(fmtFractionPct?.(value)).toBe("n/a");
    }
    expect(fmtFractionPct?.(Number.MAX_VALUE)).toBe("n/a");
  });

  it("scales finite fractions to percent while preserving literal zero", () => {
    expect(fmtFractionPct?.(0.25)).toBe("25.0%");
    expect(fmtFractionPct?.(0)).toBe("0.0%");
    expect(fmtFractionPct?.(-0.125)).toBe("-12.5%");
    expect(fmtFractionPct?.(0.12345, 2)).toBe("12.35%");
  });
});
