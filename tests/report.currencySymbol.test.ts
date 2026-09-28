import { describe, expect, it } from "vitest";

import { formatFinancialValue, formatMoneyAmount, formatTracedValue } from "@/report/format";
import type { TracedNumber } from "@/report/schema";

/**
 * Every monetary figure was rendered with a hardcoded "$": `formatTracedValue`
 * called `formatFinancialValue(value, unit)` and discarded `TracedNumber.currency`
 * entirely. A TSM or Nestlé report — statements in TWD or CHF — printed its
 * revenue, book value and per-share figures as dollars, which is not a
 * formatting nit but a false statement of fact about the number.
 *
 * The currency IS carried: TracedNumber.currency is a validated ISO-4217 code
 * and Stage C populates it from the statements' reportedCurrency.
 */
const traced = (over: Partial<TracedNumber> = {}): TracedNumber =>
  ({
    value: 1234.5,
    unit: "usd",
    source: "computed.test",
    asOf: "2025-12-31",
    verified: true,
    ...over,
  }) as TracedNumber;

describe("monetary formatting respects the reported currency", () => {
  it("renders USD with the dollar sign", () => {
    expect(formatTracedValue(traced({ currency: "USD" }))).toBe("$1,234.50");
  });

  it("does NOT render a non-USD figure as dollars", () => {
    const out = formatTracedValue(traced({ currency: "TWD" }));

    expect(out).not.toContain("$");
    expect(out).toContain("TWD");
  });

  it("does not assume dollars for a stored figure that never stated its currency", () => {
    // A report written before TracedNumber.currency existed parses with the
    // field ABSENT. The lowercase unit "usd" is a historical name for "some
    // currency", so nothing establishes USD; an explicit "USD" unit does.
    expect(formatTracedValue(traced())).toBe("1,234.50 (currency unknown)");
    expect(formatTracedValue(traced({ unit: "USD" }))).toBe("$1,234.50");
  });

  it("never renders a currency the pipeline recorded as unknown (null) as dollars", () => {
    for (const out of [
      formatTracedValue(traced({ currency: null })),
      formatTracedValue(traced({ value: 13_500_000_000, currency: null })),
      formatTracedValue(traced({ value: 42.5, unit: "usd/share", currency: null })),
      formatMoneyAmount(42.5, null),
    ]) {
      expect(out).not.toContain("$");
      expect(out).toContain("currency unknown");
    }
    expect(formatTracedValue(traced({ value: 13_500_000_000, currency: null }))).toContain("13.50B");
  });

  it("carries the currency through the large-magnitude path", () => {
    const out = formatTracedValue(traced({ value: 13_500_000_000, currency: "TWD" }));

    expect(out).toContain("13.50B");
    expect(out).toContain("TWD");
    expect(out).not.toContain("$");
  });

  it("carries the currency through the per-share path", () => {
    const out = formatTracedValue(traced({ value: 42.5, unit: "usd/share", currency: "CHF" }));

    expect(out).toContain("CHF");
    expect(out).not.toContain("$");
  });

  it("leaves non-monetary units untouched", () => {
    expect(formatTracedValue(traced({ value: 12.3, unit: "%", currency: "TWD" }))).toBe("12.3%");
    expect(formatTracedValue(traced({ value: 2.5, unit: "x", currency: "TWD" }))).toBe("2.5×");
  });

  it("formatFinancialValue takes the currency from the field or an explicit ISO unit only", () => {
    expect(formatFinancialValue(1234.5, "usd")).toBe("1,234.50 (currency unknown)");
    expect(formatFinancialValue(1234.5, "USD")).toBe("$1,234.50");
    expect(formatFinancialValue(1234.5, "usd", "JPY")).toContain("JPY");
  });
});
