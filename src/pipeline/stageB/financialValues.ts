/**
 * Derive FMP free cash flow without converting missing or invalid inputs to zero.
 * FMP reports capital expenditure as a negative cash outflow.
 */
export function deriveFcf(
  operatingCashFlow: number | null | undefined,
  capitalExpenditure: number | null | undefined,
): number | null {
  if (
    typeof operatingCashFlow !== "number" ||
    !Number.isFinite(operatingCashFlow) ||
    typeof capitalExpenditure !== "number" ||
    !Number.isFinite(capitalExpenditure)
  ) {
    return null;
  }

  const freeCashFlow = operatingCashFlow + capitalExpenditure;
  return Number.isFinite(freeCashFlow) ? freeCashFlow : null;
}
