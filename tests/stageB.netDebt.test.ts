import { describe, expect, it } from "vitest";

import {
  NET_DEBT_RESOLVER_VERSION,
  resolveNetDebt,
} from "@/pipeline/stageB/netDebt";

describe("resolveNetDebt — one house convention", () => {
  it("uses total debt minus the combined cash-and-short-term-investments field", () => {
    const result = resolveNetDebt({
      date: "2025-12-31",
      totalDebt: 600,
      cashAndCashEquivalents: 100,
      cashAndShortTermInvestments: 150,
      vendorNetDebt: 500,
    });
    expect(result.value).toBe(450);
    expect(result.version).toBe(NET_DEBT_RESOLVER_VERSION);
    expect(result.cashBasis).toBe("combined-field");
    expect(result.asOf).toBe("2025-12-31");
  });

  it("sums separately reported cash and short-term investments", () => {
    const result = resolveNetDebt({
      date: "2025-12-31",
      totalDebt: 600,
      cashAndCashEquivalents: 100,
      shortTermInvestments: 50,
    });
    expect(result.value).toBe(450);
    expect(result.cashBasis).toBe("component-sum");
  });

  it("fails closed when short-term investments are unknown and ignores vendor cash-only net debt", () => {
    const result = resolveNetDebt({
      date: "2025-12-31",
      totalDebt: 600,
      cashAndCashEquivalents: 100,
      vendorNetDebt: 500,
    });
    expect(result.value).toBeNull();
    expect(result.cashBasis).toBeNull();
    expect(result.reason).toMatch(/short-term investments|combined cash/i);
  });

  it("treats an explicitly reported zero short-term-investment balance as known", () => {
    const result = resolveNetDebt({
      date: "2025-12-31",
      totalDebt: 600,
      cashAndCashEquivalents: 100,
      shortTermInvestments: 0,
    });
    expect(result.value).toBe(500);
  });

  it("rejects a NEGATIVE total debt as invalid data instead of subtracting it into the bridge", () => {
    // A negative FMP totalDebt is corrupt (interest income netted / sign flip). Pre-
    // fix this returned value = −500 − 150 = −650 (a spurious negative net debt that
    // silently ADDS |debt|+cash to the DCF equity bridge). Fail closed, matching
    // compute.ts totalDebtSnapshot / returns.ts investedCapital.
    const result = resolveNetDebt({
      date: "2025-12-31",
      totalDebt: -500,
      cashAndCashEquivalents: 100,
      cashAndShortTermInvestments: 150,
    });
    expect(result.value).toBeNull();
    expect(result.cashBasis).toBeNull();
    expect(result.reason).toMatch(/negative/i);
  });

  it("rejects negative total debt on the component-sum path too", () => {
    const result = resolveNetDebt({
      date: "2025-12-31",
      totalDebt: -500,
      cashAndCashEquivalents: 100,
      shortTermInvestments: 50,
    });
    expect(result.value).toBeNull();
    expect(result.cashBasis).toBeNull();
  });
});
