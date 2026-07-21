/**
 * Versioned net-debt convention shared by capital scoring and every valuation
 * equity bridge. Pure and deterministic: no provider, clock, or persistence.
 */

export const NET_DEBT_RESOLVER_VERSION = "NET_DEBT_V1" as const;

export interface NetDebtInputs {
  date?: string | null;
  totalDebt?: number | null;
  cashAndCashEquivalents?: number | null;
  shortTermInvestments?: number | null;
  cashAndShortTermInvestments?: number | null;
  /** Accepted only for diagnostics; its cash-only convention is never used. */
  vendorNetDebt?: number | null;
}

export interface NetDebtResolution {
  version: typeof NET_DEBT_RESOLVER_VERSION;
  value: number | null;
  asOf: string | null;
  cashBasis: "combined-field" | "component-sum" | null;
  components: {
    totalDebt: number | null;
    cashAndCashEquivalents: number | null;
    shortTermInvestments: number | null;
    cashAndShortTermInvestments: number | null;
    vendorNetDebt: number | null;
  };
  reason: string;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveNetDebt(inputs: NetDebtInputs): NetDebtResolution {
  const totalDebt = finite(inputs.totalDebt);
  const cash = finite(inputs.cashAndCashEquivalents);
  const shortTermInvestments = finite(inputs.shortTermInvestments);
  const combinedCash = finite(inputs.cashAndShortTermInvestments);
  const vendorNetDebt = finite(inputs.vendorNetDebt);
  const components = {
    totalDebt,
    cashAndCashEquivalents: cash,
    shortTermInvestments,
    cashAndShortTermInvestments: combinedCash,
    vendorNetDebt,
  };
  const base = {
    version: NET_DEBT_RESOLVER_VERSION,
    asOf: typeof inputs.date === "string" && inputs.date.length > 0 ? inputs.date : null,
    components,
  };

  if (totalDebt === null) {
    return {
      ...base,
      value: null,
      cashBasis: null,
      reason: "total debt missing — house net debt unavailable",
    };
  }

  // A negative FMP totalDebt is invalid data (interest income netted, or a vendor
  // sign-convention flip) — the same class the WACC/ROIC paths already reject
  // (compute.ts totalDebtSnapshot, returns.ts investedCapital). Accepting it would
  // subtract a NEGATIVE debt, silently inflating the valuation equity bridge by
  // |totalDebt| + cash. Fail closed so the bridge suppresses rather than inflates.
  if (totalDebt < 0) {
    return {
      ...base,
      value: null,
      cashBasis: null,
      reason: "total debt is negative — invalid data; house net debt unavailable",
    };
  }

  if (combinedCash !== null) {
    if (cash !== null && shortTermInvestments !== null) {
      const componentSum = cash + shortTermInvestments;
      const tolerance = Math.max(1, Math.abs(combinedCash) * 1e-6);
      if (Math.abs(componentSum - combinedCash) > tolerance) {
        return {
          ...base,
          value: null,
          cashBasis: null,
          reason: "combined cash-and-short-term-investments conflicts with reported components",
        };
      }
    }
    return {
      ...base,
      value: totalDebt - combinedCash,
      cashBasis: "combined-field",
      reason: "total debt minus cash and short-term investments (combined field)",
    };
  }

  if (cash !== null && shortTermInvestments !== null) {
    return {
      ...base,
      value: totalDebt - cash - shortTermInvestments,
      cashBasis: "component-sum",
      reason: "total debt minus cash and separately reported short-term investments",
    };
  }

  return {
    ...base,
    value: null,
    cashBasis: null,
    reason:
      "combined cash-and-short-term-investments unavailable and one or more cash components missing; vendor cash-only net debt rejected",
  };
}
