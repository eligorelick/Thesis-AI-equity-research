import { describe, expect, it } from "vitest";

import { selectAltmanVariant } from "@/pipeline/stageB/forensics";
import type { CompanyRoute } from "@/types/core";

/**
 * Altman's variant selection is SIC-decisive, and the SIC never arrived.
 *
 * `compute.ts` passed neither `sic` to `routeCompany` nor `sicCode` to the
 * forensics classification, and FMP's profile carries no SIC at all — so
 * `sicRaw` was permanently null, the SIC branch was dead code, and every
 * company fell through to a sector/industry STRING heuristic
 * (["industrials","basic materials"] or /manufactur/i).
 *
 * That is not a cosmetic mis-label. The original 1968 Z (Altman, Journal of
 * Finance 23(4)) is estimated on publicly traded MANUFACTURERS and puts the
 * MARKET value of equity in X4; Z" (Altman 1983 / Altman-Hartzell-Peck 1995)
 * drops X5 and substitutes BOOK equity. Picking the wrong one swaps the single
 * largest term in the score.
 *
 * The SIC now comes from the EDGAR submissions payload, which the bundle
 * already fetched and then discarded.
 */
const route = (
  base: CompanyRoute["base"],
  sector: string | null,
  industry: string | null,
  sic: string | null = null,
): CompanyRoute => ({
  base,
  overlays: [],
  evidence: { sector, industry, ...(sic === null ? {} : { sic }) },
});

describe("Altman variant selection uses the SIC when it is available", () => {
  it("routes a SIC 2000-3999 manufacturer to the original 1968 Z", () => {
    // Philip Morris: SIC 2111 (Cigarettes). Sector/industry strings match
    // neither heuristic branch, so before the SIC arrived this fell to Z".
    const sel = selectAltmanVariant(
      route("general", "Consumer Defensive", "Tobacco", "2111"),
      { sector: "Consumer Defensive", industry: "Tobacco", sicCode: "2111" },
      false,
    );

    expect(sel.variant).toBe("original");
  });

  it("routes Apple's SIC 3571 to the original 1968 Z despite a Technology sector", () => {
    const sel = selectAltmanVariant(
      route("general", "Technology", "Consumer Electronics", "3571"),
      { sector: "Technology", industry: "Consumer Electronics", sicCode: "3571" },
      false,
    );

    expect(sel.variant).toBe("original");
  });

  it("keeps a non-manufacturer SIC on the Z-double-prime map", () => {
    // SIC 7372 (prepackaged software) is outside 2000-3999.
    const sel = selectAltmanVariant(
      route("general", "Technology", "Software - Infrastructure", "7372"),
      { sector: "Technology", industry: "Software - Infrastructure", sicCode: "7372" },
      false,
    );

    expect(sel.variant).not.toBe("original");
  });

  it("still falls back to the sector/industry heuristic when no SIC exists", () => {
    const sel = selectAltmanVariant(
      route("general", "Industrials", "Farm & Heavy Construction Machinery"),
      { sector: "Industrials", industry: "Farm & Heavy Construction Machinery" },
      false,
    );

    expect(sel.variant).toBe("original");
    expect(sel.notes.join(" ")).toMatch(/heuristic|no SIC/i);
  });

  it("suppresses the model for a financial SIC regardless of sector strings", () => {
    const sel = selectAltmanVariant(
      route("general", "Financial Services", "Asset Management", "6282"),
      { sector: "Financial Services", industry: "Asset Management", sicCode: "6282" },
      false,
    );

    expect(sel.variant).toBeNull();
  });
});
