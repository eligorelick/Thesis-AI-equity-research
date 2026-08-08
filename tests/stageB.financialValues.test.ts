import { describe, expect, it } from "vitest";

import { deriveFcf } from "@/pipeline/stageB/financialValues";

describe("deriveFcf", () => {
  it.each([
    { operatingCashFlow: 6_000, capitalExpenditure: -1_000, expected: 5_000 },
    { operatingCashFlow: 0, capitalExpenditure: 0, expected: 0 },
  ])(
    "adds finite FMP operating cash flow and negative capex",
    ({ operatingCashFlow, capitalExpenditure, expected }) => {
      expect(deriveFcf(operatingCashFlow, capitalExpenditure)).toBe(expected);
    },
  );

  it.each([
    { operatingCashFlow: 6_000, capitalExpenditure: null },
    { operatingCashFlow: 6_000, capitalExpenditure: undefined },
    { operatingCashFlow: null, capitalExpenditure: -1_000 },
    { operatingCashFlow: undefined, capitalExpenditure: -1_000 },
    { operatingCashFlow: Number.NaN, capitalExpenditure: -1_000 },
    { operatingCashFlow: Number.POSITIVE_INFINITY, capitalExpenditure: -1_000 },
    { operatingCashFlow: 6_000, capitalExpenditure: Number.NaN },
    { operatingCashFlow: 6_000, capitalExpenditure: Number.NEGATIVE_INFINITY },
    { operatingCashFlow: Number.MAX_VALUE, capitalExpenditure: Number.MAX_VALUE },
  ])(
    "returns null unless both inputs and their sum are finite",
    ({ operatingCashFlow, capitalExpenditure }) => {
      expect(deriveFcf(operatingCashFlow, capitalExpenditure)).toBeNull();
    },
  );
});
