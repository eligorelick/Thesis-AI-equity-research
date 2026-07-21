import { describe, expect, it } from "vitest";
import type { Sourced } from "@/types/core";
import type { EdgarFiling, EdgarSubmissions } from "@/providers/edgar";
import { selectAnnualFiling, selectInterimFiling } from "@/pipeline/dataBundle";

function filing(form: string): EdgarFiling {
  return {
    accessionNumber: "0001234567-26-000001",
    form,
    filingDate: "2026-03-01",
    reportDate: "2025-12-31",
    primaryDocument: "annual.htm",
  };
}

function submissions(forms: string[]): Sourced<EdgarSubmissions> {
  return {
    data: {
      cik: "0001234567",
      name: "Foreign Issuer",
      sic: null,
      sicDescription: null,
      fiscalYearEnd: "1231",
      stateOfIncorporation: null,
      tickers: ["TSM"],
      exchanges: ["NYSE"],
      recentFilings: forms.map(filing),
      olderPages: [],
    },
    asOf: "2026-03-01",
    source: "edgar",
    endpoint: "submissions/CIK0001234567.json",
    fetchedAt: "2026-03-01T00:00:00.000Z",
  };
}

describe("selectAnnualFiling", () => {
  it("uses Form 20-F as the annual primary filing for an ADR without a 10-K", () => {
    const result = selectAnnualFiling(submissions(["20-F", "6-K"]), "TSM");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.form).toBe("20-F");
  });

  it("uses the SEC-reported 20-F even when the profile ADR flag is absent", () => {
    const result = selectAnnualFiling(submissions(["20-F"]), "FOREIGN");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.form).toBe("20-F");
  });

  it("prefers a 10-K when an ADR files both annual forms", () => {
    const result = selectAnnualFiling(submissions(["20-F", "10-K"]), "DUAL");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.form).toBe("10-K");
  });
});

describe("selectInterimFiling", () => {
  it("uses Form 6-K as provenance when a foreign issuer has no 10-Q", () => {
    const result = selectInterimFiling(submissions(["6-K"]), "TSM");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.form).toBe("6-K");
  });

  it("prefers a standardized 10-Q over Form 6-K", () => {
    const result = selectInterimFiling(submissions(["6-K", "10-Q"]), "DUAL");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.form).toBe("10-Q");
  });
});
