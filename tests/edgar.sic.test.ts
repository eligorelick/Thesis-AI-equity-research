// tests/edgar.sic.test.ts
import { describe, expect, it } from "vitest";
import { sectorIndustryForSic } from "@/edgar/sic";

describe("sectorIndustryForSic", () => {
  it("maps the specific financial codes to routing-compatible industries", () => {
    expect(sectorIndustryForSic("6021")).toEqual({ sic: 6021, sector: "Financial Services", industry: "Banks - Diversified" });
    expect(sectorIndustryForSic(6022)).toEqual({ sic: 6022, sector: "Financial Services", industry: "Banks - Regional" });
    expect(sectorIndustryForSic("6035")).toMatchObject({ industry: "Banks - Regional" });
    expect(sectorIndustryForSic("6311")).toEqual({ sic: 6311, sector: "Financial Services", industry: "Insurance - Life" });
    expect(sectorIndustryForSic("6331")).toMatchObject({ industry: "Insurance - Property & Casualty" });
    expect(sectorIndustryForSic("6411")).toMatchObject({ industry: "Insurance - Brokers" });
    expect(sectorIndustryForSic("6798")).toEqual({ sic: 6798, sector: "Real Estate", industry: "REIT - Diversified" });
    expect(sectorIndustryForSic("6211")).toMatchObject({ industry: "Capital Markets" });
    expect(sectorIndustryForSic("6282")).toMatchObject({ industry: "Asset Management" });
    expect(sectorIndustryForSic("6162")).toMatchObject({ industry: "Mortgage Finance" });
    expect(sectorIndustryForSic("6141")).toMatchObject({ industry: "Credit Services" });
  });

  it("maps well-known operating companies through specific codes and major groups", () => {
    expect(sectorIndustryForSic("3571")).toEqual({ sic: 3571, sector: "Technology", industry: "Computer Hardware" });
    expect(sectorIndustryForSic("3674")).toMatchObject({ sector: "Technology", industry: "Semiconductors" });
    expect(sectorIndustryForSic("7372")).toMatchObject({ sector: "Technology", industry: "Software - Application" });
    expect(sectorIndustryForSic("2834")).toMatchObject({ sector: "Healthcare", industry: "Drug Manufacturers - General" });
    expect(sectorIndustryForSic("2836")).toMatchObject({ sector: "Healthcare", industry: "Biotechnology" });
    expect(sectorIndustryForSic("3841")).toMatchObject({ sector: "Healthcare", industry: "Medical Devices" });
    expect(sectorIndustryForSic("5411")).toMatchObject({ sector: "Consumer Defensive", industry: "Grocery Stores" });
    expect(sectorIndustryForSic("5812")).toMatchObject({ sector: "Consumer Cyclical", industry: "Restaurants" });
    expect(sectorIndustryForSic("3711")).toMatchObject({ sector: "Consumer Cyclical", industry: "Auto Manufacturers" });
    expect(sectorIndustryForSic("4911")).toMatchObject({ sector: "Utilities", industry: "Utilities - Regulated Electric" });
    expect(sectorIndustryForSic("1311")).toMatchObject({ sector: "Energy", industry: "Oil & Gas E&P" });
    expect(sectorIndustryForSic("2911")).toMatchObject({ sector: "Energy", industry: "Oil & Gas Refining & Marketing" });
    expect(sectorIndustryForSic("4813")).toMatchObject({ sector: "Communication Services", industry: "Telecom Services" });
    expect(sectorIndustryForSic("7370")).toMatchObject({ sector: "Technology" });
    expect(sectorIndustryForSic("3720")).toMatchObject({ sector: "Industrials", industry: "Aerospace & Defense" });
    expect(sectorIndustryForSic("4512")).toMatchObject({ sector: "Industrials", industry: "Airlines" });
  });

  it("accepts the '6021 NATIONAL COMMERCIAL BANKS' spelling and rejects garbage", () => {
    expect(sectorIndustryForSic("6021 NATIONAL COMMERCIAL BANKS")).toMatchObject({ sic: 6021, industry: "Banks - Diversified" });
    expect(sectorIndustryForSic(null)).toEqual({ sic: null, sector: null, industry: null });
    expect(sectorIndustryForSic(undefined)).toEqual({ sic: null, sector: null, industry: null });
    expect(sectorIndustryForSic("abc")).toEqual({ sic: null, sector: null, industry: null });
    expect(sectorIndustryForSic("9999")).toEqual({ sic: 9999, sector: null, industry: null });
    expect(sectorIndustryForSic("0100")).toMatchObject({ sic: 100, sector: "Consumer Defensive" });
  });

  it("never returns an industry that would misroute to a financial map for a non-financial", () => {
    for (const code of [3571, 7372, 2834, 5411, 4911, 1311, 8731, 7389]) {
      const { industry } = sectorIndustryForSic(code);
      expect(industry ?? "").not.toMatch(/^(banks|insurance|reit)/i);
    }
  });
});
