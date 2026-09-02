# Keyless Data Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A complete deterministic report for any US-listed SEC registrant with no paid data subscription, by filling every core bundle member FMP cannot serve from SEC EDGAR (statements, shares, registrant identity) and Yahoo's keyless chart endpoint (prices, quote), with full provenance and disclosed gaps.

**Architecture:** FMP stays the primary source. After its calls settle, `applyKeylessFallbacks` (new, `src/pipeline/keyless.ts`) replaces each core member that is a gap or empty with a keyless equivalent built by four new pure modules (`src/edgar/statements.ts`, `src/edgar/sic.ts`, `src/providers/yahoo.ts`, `src/pipeline/stageB/betaEstimate.ts`), stamps `Sourced.source` as `edgar`/`yahoo`/`computed`, and records a `keyless.<member>` manifest entry. Fallbacks run only when EDGAR confirms the issuer — an EDGAR-sourced CIK, or a registrant whose tickers include the requested symbol — and never in fixture mode, so the fictional fixtures stay byte-identical. Stage A's XBRL cross-check treats XBRL-sourced statements as an identity pass.

**Tech Stack:** TypeScript 6, Node 24, Zod 4, Vitest 4, existing `fetchWithPolicy` transport, existing `cachedFetch` SQLite cache, existing `src/edgar/xbrl.ts` fact helpers.

**Spec:** `docs/superpowers/specs/2026-09-02-keyless-data-path-design.md`

## Global Constraints

- Nothing throws for missing data: every failure is a `ManifestEntry` gap (`{ field, reason, severity, attemptedSources? }`), the application contract §3 rule #4.
- Missing values are `null`, never `0`; computed fields exist only when every operand is present (sum-of-optional-components fields require at least one present component, and say so in the note).
- Sign conventions match FMP: `capitalExpenditure`, `commonStockRepurchased`, `netDividendsPaid`, `commonDividendsPaid`, `preferredDividendsPaid`, `acquisitionsNet` are NEGATIVE outflows; `interestExpense` and `incomeTaxExpense` are POSITIVE.
- Row arrays are date DESC (newest first), `date` is `YYYY-MM-DD`.
- Provenance: every `Sourced` value carries `source` (`"edgar" | "yahoo" | "computed"`), `endpoint`, `asOf`, `fetchedAt`.
- New source files under `src/providers/` and `src/edgar/` and `src/pipeline/keyless.ts` join `RISK_SOURCE_MANIFEST` in `vitest.shared.ts` and must meet 85 % statements / 75 % branches / 85 % functions / 85 % lines per file. `src/pipeline/stageB/betaEstimate.ts` falls under the core thresholds (90/84/95/93 aggregate).
- Tracked Markdown must be listed in `ALLOWED_MARKDOWN` in `tests/repository.release.test.ts`.
- Run the full gate before every commit: `npm run lint && npx tsc --noEmit && npx vitest run --config vitest.config.ts`.
- Yahoo requests always send a `User-Agent`; without one the endpoint returns 429.
- The audit fixture comparison (`tests/audit.fixtureComparison.test.ts`) must stay byte-identical: `DEMO`/`DBNK` never reach the keyless layer.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/edgar/sic.ts` (new) | SIC code → FMP-taxonomy `{ sector, industry }` |
| `src/pipeline/stageB/betaEstimate.ts` (new) | OLS beta from monthly returns of two close series |
| `src/providers/yahoo.ts` (new) | Keyless daily history, quote and meta via the chart endpoint |
| `src/edgar/statements.ts` (new) | XBRL companyfacts → FMP-shaped income / balance / cash-flow rows, annual and quarterly |
| `src/pipeline/keyless.ts` (new) | Per-member fallback orchestration: profile, quote, statements, prices, EV, market-cap history, float |
| `src/types/core.ts` | `DataSource` gains `"yahoo"` |
| `src/pipeline/types.ts` | `EdgarBundle.registrant` (plain object, not a `FetchResult`) |
| `src/pipeline/dataBundle.ts` | Await the EDGAR bundle, then apply fallbacks; `yahoo` and `keyless` options; `makeYahooCachedFetch` |
| `src/pipeline/stageA/validate.ts` | XBRL identity pass when statements are EDGAR-sourced |
| `src/app/company/[symbol]/page.tsx` | Keyless unknown symbol → not found |
| `vitest.shared.ts` | Risk manifest additions |
| `tests/repository.release.test.ts` | Allowlist the spec and this plan |
| `README.md`, `.env.example` | Keyless operation documented |

---

### Task 1: SIC → sector / industry

**Files:**
- Create: `src/edgar/sic.ts`
- Test: `tests/edgar.sic.test.ts`

**Interfaces:**
- Produces: `sectorIndustryForSic(sic: string | number | null | undefined): { sector: string | null; industry: string | null; sic: number | null }`. Sector strings are FMP's taxonomy exactly as `SECTOR_ETF_MAP` / `FMP_SECTOR_TO_GICS` in `src/pipeline/dataBundle.ts` expect (`Technology`, `Financial Services`, `Healthcare`, `Consumer Cyclical`, `Consumer Defensive`, `Industrials`, `Basic Materials`, `Energy`, `Utilities`, `Real Estate`, `Communication Services`). Industry strings for financials start with the exact prefixes `routeCompany` matches: `Banks`, `Insurance`, `REIT` (see `src/pipeline/stageB/sectorRouting.ts:232-247`).

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts tests/edgar.sic.test.ts`
Expected: FAIL — cannot resolve `@/edgar/sic`.

- [ ] **Step 3: Write the implementation**

```ts
// src/edgar/sic.ts
/**
 * SEC Standard Industrial Classification → FMP-taxonomy sector and industry.
 *
 * Keyless profiles have no vendor sector/industry; the SIC on the EDGAR
 * submissions payload is the only classification a registrant supplies.
 * The sector strings below are FMP's exactly, so `SECTOR_ETF_MAP`,
 * `FMP_SECTOR_TO_GICS` and the payload's sector routing keep working; the
 * financial industry strings start with the prefixes `routeCompany` matches
 * (`Banks`, `Insurance`, `REIT`), everything else is descriptive.
 *
 * Specific four-digit codes win over their two-digit major group.
 */

export interface SicClassification {
  sic: number | null;
  sector: string | null;
  industry: string | null;
}

const SPECIFIC: Readonly<Record<number, readonly [string, string]>> = {
  // --- Financials: the routing-decisive codes -------------------------------
  6021: ["Financial Services", "Banks - Diversified"],
  6022: ["Financial Services", "Banks - Regional"],
  6029: ["Financial Services", "Banks - Regional"],
  6035: ["Financial Services", "Banks - Regional"],
  6036: ["Financial Services", "Banks - Regional"],
  6099: ["Financial Services", "Credit Services"],
  6111: ["Financial Services", "Credit Services"],
  6141: ["Financial Services", "Credit Services"],
  6153: ["Financial Services", "Credit Services"],
  6159: ["Financial Services", "Credit Services"],
  6162: ["Financial Services", "Mortgage Finance"],
  6163: ["Financial Services", "Mortgage Finance"],
  6199: ["Financial Services", "Credit Services"],
  6200: ["Financial Services", "Capital Markets"],
  6211: ["Financial Services", "Capital Markets"],
  6221: ["Financial Services", "Capital Markets"],
  6282: ["Financial Services", "Asset Management"],
  6311: ["Financial Services", "Insurance - Life"],
  6321: ["Financial Services", "Insurance - Life"],
  6324: ["Financial Services", "Insurance - Life"],
  6331: ["Financial Services", "Insurance - Property & Casualty"],
  6351: ["Financial Services", "Insurance - Specialty"],
  6361: ["Financial Services", "Insurance - Specialty"],
  6399: ["Financial Services", "Insurance - Diversified"],
  6411: ["Financial Services", "Insurance - Brokers"],
  6770: ["Financial Services", "Shell Companies"],
  6798: ["Real Estate", "REIT - Diversified"],
  // --- Technology ------------------------------------------------------------
  3571: ["Technology", "Computer Hardware"],
  3572: ["Technology", "Computer Hardware"],
  3576: ["Technology", "Communication Equipment"],
  3577: ["Technology", "Computer Hardware"],
  3578: ["Technology", "Computer Hardware"],
  3661: ["Technology", "Communication Equipment"],
  3663: ["Technology", "Communication Equipment"],
  3672: ["Technology", "Electronic Components"],
  3674: ["Technology", "Semiconductors"],
  3679: ["Technology", "Electronic Components"],
  3825: ["Technology", "Scientific & Technical Instruments"],
  3826: ["Technology", "Scientific & Technical Instruments"],
  3827: ["Technology", "Scientific & Technical Instruments"],
  3829: ["Technology", "Scientific & Technical Instruments"],
  7370: ["Technology", "Software - Infrastructure"],
  7371: ["Technology", "Information Technology Services"],
  7372: ["Technology", "Software - Application"],
  7373: ["Technology", "Information Technology Services"],
  7374: ["Technology", "Information Technology Services"],
  // --- Healthcare ------------------------------------------------------------
  2833: ["Healthcare", "Drug Manufacturers - Specialty & Generic"],
  2834: ["Healthcare", "Drug Manufacturers - General"],
  2835: ["Healthcare", "Diagnostics & Research"],
  2836: ["Healthcare", "Biotechnology"],
  3841: ["Healthcare", "Medical Devices"],
  3842: ["Healthcare", "Medical Instruments & Supplies"],
  3843: ["Healthcare", "Medical Instruments & Supplies"],
  3844: ["Healthcare", "Medical Devices"],
  3845: ["Healthcare", "Medical Devices"],
  3851: ["Healthcare", "Medical Instruments & Supplies"],
  5047: ["Healthcare", "Medical Distribution"],
  5122: ["Healthcare", "Medical Distribution"],
  8011: ["Healthcare", "Medical Care Facilities"],
  8062: ["Healthcare", "Medical Care Facilities"],
  8071: ["Healthcare", "Diagnostics & Research"],
  8082: ["Healthcare", "Medical Care Facilities"],
  8090: ["Healthcare", "Medical Care Facilities"],
  8093: ["Healthcare", "Medical Care Facilities"],
  8731: ["Healthcare", "Biotechnology"],
  // --- Consumer --------------------------------------------------------------
  3711: ["Consumer Cyclical", "Auto Manufacturers"],
  3714: ["Consumer Cyclical", "Auto Parts"],
  3716: ["Consumer Cyclical", "Recreational Vehicles"],
  3751: ["Consumer Cyclical", "Recreational Vehicles"],
  5311: ["Consumer Cyclical", "Department Stores"],
  5331: ["Consumer Defensive", "Discount Stores"],
  5411: ["Consumer Defensive", "Grocery Stores"],
  5412: ["Consumer Defensive", "Grocery Stores"],
  5500: ["Consumer Cyclical", "Auto & Truck Dealerships"],
  5531: ["Consumer Cyclical", "Auto Parts"],
  5661: ["Consumer Cyclical", "Footwear & Accessories"],
  5812: ["Consumer Cyclical", "Restaurants"],
  5912: ["Consumer Defensive", "Pharmaceutical Retailers"],
  5940: ["Consumer Cyclical", "Specialty Retail"],
  5961: ["Consumer Cyclical", "Internet Retail"],
  5990: ["Consumer Cyclical", "Specialty Retail"],
  7011: ["Consumer Cyclical", "Lodging"],
  7990: ["Consumer Cyclical", "Leisure"],
  7993: ["Consumer Cyclical", "Gambling"],
  // --- Communication ---------------------------------------------------------
  4813: ["Communication Services", "Telecom Services"],
  4822: ["Communication Services", "Telecom Services"],
  4832: ["Communication Services", "Broadcasting"],
  4833: ["Communication Services", "Entertainment"],
  4841: ["Communication Services", "Entertainment"],
  4899: ["Communication Services", "Telecom Services"],
  7310: ["Communication Services", "Advertising Agencies"],
  7311: ["Communication Services", "Advertising Agencies"],
  7812: ["Communication Services", "Entertainment"],
  7819: ["Communication Services", "Entertainment"],
  7830: ["Communication Services", "Entertainment"],
  7841: ["Communication Services", "Entertainment"],
  // --- Industrials -----------------------------------------------------------
  3720: ["Industrials", "Aerospace & Defense"],
  3721: ["Industrials", "Aerospace & Defense"],
  3724: ["Industrials", "Aerospace & Defense"],
  3728: ["Industrials", "Aerospace & Defense"],
  3760: ["Industrials", "Aerospace & Defense"],
  3812: ["Industrials", "Aerospace & Defense"],
  4011: ["Industrials", "Railroads"],
  4213: ["Industrials", "Trucking"],
  4412: ["Industrials", "Marine Shipping"],
  4512: ["Industrials", "Airlines"],
  4513: ["Industrials", "Integrated Freight & Logistics"],
  4522: ["Industrials", "Airlines"],
  4731: ["Industrials", "Integrated Freight & Logistics"],
  7359: ["Industrials", "Rental & Leasing Services"],
  7361: ["Industrials", "Staffing & Employment Services"],
  7363: ["Industrials", "Staffing & Employment Services"],
  7381: ["Industrials", "Security & Protection Services"],
  7389: ["Industrials", "Specialty Business Services"],
  8711: ["Industrials", "Engineering & Construction"],
  8741: ["Industrials", "Consulting Services"],
  8742: ["Industrials", "Consulting Services"],
  // --- Energy / materials / utilities ----------------------------------------
  1311: ["Energy", "Oil & Gas E&P"],
  1381: ["Energy", "Oil & Gas Drilling"],
  1382: ["Energy", "Oil & Gas Equipment & Services"],
  1389: ["Energy", "Oil & Gas Equipment & Services"],
  2911: ["Energy", "Oil & Gas Refining & Marketing"],
  4610: ["Energy", "Oil & Gas Midstream"],
  4922: ["Energy", "Oil & Gas Midstream"],
  4923: ["Utilities", "Utilities - Regulated Gas"],
  4924: ["Utilities", "Utilities - Regulated Gas"],
  4911: ["Utilities", "Utilities - Regulated Electric"],
  4931: ["Utilities", "Utilities - Diversified"],
  4932: ["Utilities", "Utilities - Regulated Gas"],
  4941: ["Utilities", "Utilities - Regulated Water"],
  4991: ["Utilities", "Utilities - Renewable"],
  1040: ["Basic Materials", "Gold"],
  1000: ["Basic Materials", "Other Industrial Metals & Mining"],
  3312: ["Basic Materials", "Steel"],
  3334: ["Basic Materials", "Aluminum"],
};

/** Two-digit SIC major group → sector and a descriptive industry. */
const MAJOR_GROUP: Readonly<Record<number, readonly [string, string]>> = {
  1: ["Consumer Defensive", "Farm Products"],
  2: ["Consumer Defensive", "Farm Products"],
  7: ["Consumer Defensive", "Farm Products"],
  8: ["Basic Materials", "Lumber & Wood Production"],
  9: ["Consumer Defensive", "Farm Products"],
  10: ["Basic Materials", "Other Industrial Metals & Mining"],
  12: ["Energy", "Thermal Coal"],
  13: ["Energy", "Oil & Gas E&P"],
  14: ["Basic Materials", "Building Materials"],
  15: ["Consumer Cyclical", "Residential Construction"],
  16: ["Industrials", "Engineering & Construction"],
  17: ["Industrials", "Engineering & Construction"],
  20: ["Consumer Defensive", "Packaged Foods"],
  21: ["Consumer Defensive", "Tobacco"],
  22: ["Consumer Cyclical", "Textile Manufacturing"],
  23: ["Consumer Cyclical", "Apparel Manufacturing"],
  24: ["Basic Materials", "Lumber & Wood Production"],
  25: ["Consumer Cyclical", "Furnishings, Fixtures & Appliances"],
  26: ["Basic Materials", "Paper & Paper Products"],
  27: ["Communication Services", "Publishing"],
  28: ["Basic Materials", "Chemicals"],
  29: ["Energy", "Oil & Gas Refining & Marketing"],
  30: ["Basic Materials", "Specialty Chemicals"],
  31: ["Consumer Cyclical", "Footwear & Accessories"],
  32: ["Basic Materials", "Building Materials"],
  33: ["Basic Materials", "Steel"],
  34: ["Industrials", "Metal Fabrication"],
  35: ["Industrials", "Specialty Industrial Machinery"],
  36: ["Technology", "Electronic Components"],
  37: ["Industrials", "Aerospace & Defense"],
  38: ["Technology", "Scientific & Technical Instruments"],
  39: ["Consumer Cyclical", "Leisure"],
  40: ["Industrials", "Railroads"],
  41: ["Industrials", "Trucking"],
  42: ["Industrials", "Trucking"],
  44: ["Industrials", "Marine Shipping"],
  45: ["Industrials", "Airlines"],
  46: ["Energy", "Oil & Gas Midstream"],
  47: ["Industrials", "Integrated Freight & Logistics"],
  48: ["Communication Services", "Telecom Services"],
  49: ["Utilities", "Utilities - Diversified"],
  50: ["Industrials", "Industrial Distribution"],
  51: ["Consumer Defensive", "Food Distribution"],
  52: ["Consumer Cyclical", "Home Improvement Retail"],
  53: ["Consumer Cyclical", "Department Stores"],
  54: ["Consumer Defensive", "Grocery Stores"],
  55: ["Consumer Cyclical", "Auto & Truck Dealerships"],
  56: ["Consumer Cyclical", "Apparel Retail"],
  57: ["Consumer Cyclical", "Specialty Retail"],
  58: ["Consumer Cyclical", "Restaurants"],
  59: ["Consumer Cyclical", "Specialty Retail"],
  60: ["Financial Services", "Banks - Regional"],
  61: ["Financial Services", "Credit Services"],
  62: ["Financial Services", "Capital Markets"],
  63: ["Financial Services", "Insurance - Diversified"],
  64: ["Financial Services", "Insurance - Brokers"],
  65: ["Real Estate", "Real Estate Services"],
  67: ["Financial Services", "Asset Management"],
  70: ["Consumer Cyclical", "Lodging"],
  72: ["Consumer Cyclical", "Personal Services"],
  73: ["Industrials", "Specialty Business Services"],
  75: ["Consumer Cyclical", "Auto & Truck Dealerships"],
  76: ["Consumer Cyclical", "Personal Services"],
  78: ["Communication Services", "Entertainment"],
  79: ["Consumer Cyclical", "Leisure"],
  80: ["Healthcare", "Medical Care Facilities"],
  81: ["Industrials", "Specialty Business Services"],
  82: ["Consumer Defensive", "Education & Training Services"],
  83: ["Healthcare", "Medical Care Facilities"],
  86: ["Industrials", "Specialty Business Services"],
  87: ["Industrials", "Consulting Services"],
  89: ["Industrials", "Specialty Business Services"],
};

/** Parse a four-digit code out of "6021" or "6021 NATIONAL COMMERCIAL BANKS". */
export function parseSicCode(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 9999 ? value : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{4})\b/.exec(value);
  return match ? Number(match[1]) : null;
}

export function sectorIndustryForSic(value: string | number | null | undefined): SicClassification {
  const sic = parseSicCode(value);
  if (sic === null) return { sic: null, sector: null, industry: null };
  const specific = SPECIFIC[sic];
  if (specific !== undefined) return { sic, sector: specific[0], industry: specific[1] };
  const group = MAJOR_GROUP[Math.floor(sic / 100)];
  if (group !== undefined) return { sic, sector: group[0], industry: group[1] };
  return { sic, sector: null, industry: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.config.ts tests/edgar.sic.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/edgar/sic.ts tests/edgar.sic.test.ts
git commit -m "feat(edgar): map SIC codes to FMP-taxonomy sector and industry"
```

---

### Task 2: Beta estimate from monthly returns

**Files:**
- Create: `src/pipeline/stageB/betaEstimate.ts`
- Test: `tests/stageB.betaEstimate.test.ts`

**Interfaces:**
- Consumes: close series as `{ date: string; close: number }[]` in any order.
- Produces: `estimateBeta(symbolCloses, benchmarkCloses, opts?: { maxMonths?: number; minMonths?: number }): BetaEstimate` where

```ts
export interface BetaEstimate {
  beta: number | null;
  months: number;
  windowStart: string | null;
  windowEnd: string | null;
  rSquared: number | null;
  note: string;
  gap: ManifestEntry | null;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/stageB.betaEstimate.test.ts
import { describe, expect, it } from "vitest";
import { estimateBeta, monthEndCloses } from "@/pipeline/stageB/betaEstimate";

/** Daily closes for `months` months where the symbol's monthly log return is beta × benchmark's. */
function series(months: number, beta: number, start = "2021-01-04") {
  const symbol: { date: string; close: number }[] = [];
  const bench: { date: string; close: number }[] = [];
  let s = 100;
  let b = 100;
  const d = new Date(`${start}T00:00:00Z`);
  for (let m = 0; m < months; m++) {
    const benchReturn = ((m % 5) - 2) * 0.02; // −4%, −2%, 0, +2%, +4% pattern
    for (let day = 0; day < 20; day++) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const iso = d.toISOString().slice(0, 10);
      symbol.push({ date: iso, close: s });
      bench.push({ date: iso, close: b });
    }
    b *= Math.exp(benchReturn);
    s *= Math.exp(beta * benchReturn);
    // advance to the next month
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
  }
  return { symbol, bench };
}

describe("estimateBeta", () => {
  it("recovers a known slope from monthly log returns", () => {
    const { symbol, bench } = series(40, 1.3);
    const result = estimateBeta(symbol, bench);
    expect(result.beta).not.toBeNull();
    expect(result.beta!).toBeCloseTo(1.3, 6);
    expect(result.rSquared!).toBeCloseTo(1, 6);
    expect(result.months).toBe(39); // 40 month-ends → 39 returns
    expect(result.gap).toBeNull();
    expect(result.note).toMatch(/39 monthly/);
  });

  it("uses at most 60 months and reports the window it measured", () => {
    const { symbol, bench } = series(80, 0.8);
    const result = estimateBeta(symbol, bench);
    expect(result.months).toBe(60);
    expect(result.beta!).toBeCloseTo(0.8, 6);
    expect(result.windowStart! < result.windowEnd!).toBe(true);
  });

  it("refuses fewer than 24 months and says so", () => {
    const { symbol, bench } = series(18, 1.1);
    const result = estimateBeta(symbol, bench);
    expect(result.beta).toBeNull();
    expect(result.gap?.field).toBe("profile.beta");
    expect(result.gap?.reason).toMatch(/17 monthly returns.*24/);
  });

  it("aligns on shared month-ends and ignores months only one series has", () => {
    const { symbol, bench } = series(40, 1.0);
    const trimmedBench = bench.filter((row) => row.date >= "2021-06-01");
    const result = estimateBeta(symbol, trimmedBench);
    expect(result.beta!).toBeCloseTo(1.0, 6);
    expect(result.months).toBeLessThan(39);
  });

  it("returns null beta with a gap when the benchmark has no variance", () => {
    const { symbol } = series(30, 1.0);
    const flat = symbol.map((row) => ({ date: row.date, close: 100 }));
    const result = estimateBeta(symbol, flat);
    expect(result.beta).toBeNull();
    expect(result.gap?.reason).toMatch(/variance/);
  });

  it("monthEndCloses keeps the last trading day of each month, newest first", () => {
    const { symbol } = series(3, 1.0);
    const ends = monthEndCloses(symbol);
    expect(ends).toHaveLength(3);
    expect(ends[0]!.date > ends[1]!.date).toBe(true);
    for (const end of ends) expect(symbol.some((r) => r.date === end.date)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts tests/stageB.betaEstimate.test.ts`
Expected: FAIL — cannot resolve `@/pipeline/stageB/betaEstimate`.

- [ ] **Step 3: Write the implementation**

```ts
// src/pipeline/stageB/betaEstimate.ts
/**
 * Levered beta from monthly log returns — the keyless replacement for the
 * vendor profile beta.
 *
 * Method: ordinary least squares of the symbol's monthly log return on the
 * benchmark's over the last `maxMonths` (60) month-ends both series share,
 * i.e. the same 5-year-monthly convention vendors publish. Fewer than
 * `minMonths` (24) shared returns is a disclosed gap, not a number.
 * Pure and deterministic.
 */
import type { ManifestEntry } from "@/types/core";

export interface ClosePoint {
  date: string;
  close: number;
}

export interface BetaEstimate {
  beta: number | null;
  months: number;
  windowStart: string | null;
  windowEnd: string | null;
  rSquared: number | null;
  note: string;
  gap: ManifestEntry | null;
}

export const BETA_MAX_MONTHS = 60;
export const BETA_MIN_MONTHS = 24;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Last observation of each calendar month, newest first. */
export function monthEndCloses(points: readonly ClosePoint[]): ClosePoint[] {
  const byMonth = new Map<string, ClosePoint>();
  for (const point of points) {
    if (!isFiniteNumber(point.close) || point.close <= 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date)) continue;
    const key = point.date.slice(0, 7);
    const current = byMonth.get(key);
    if (current === undefined || point.date > current.date) byMonth.set(key, point);
  }
  return [...byMonth.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function estimateBeta(
  symbolCloses: readonly ClosePoint[],
  benchmarkCloses: readonly ClosePoint[],
  opts: { maxMonths?: number; minMonths?: number } = {},
): BetaEstimate {
  const maxMonths = opts.maxMonths ?? BETA_MAX_MONTHS;
  const minMonths = opts.minMonths ?? BETA_MIN_MONTHS;
  const symbolEnds = monthEndCloses(symbolCloses);
  const benchByMonth = new Map(monthEndCloses(benchmarkCloses).map((p) => [p.date.slice(0, 7), p]));
  // Shared month-ends, newest first, at most maxMonths + 1 levels (→ maxMonths returns).
  const shared = symbolEnds
    .filter((p) => benchByMonth.has(p.date.slice(0, 7)))
    .slice(0, maxMonths + 1)
    .reverse(); // oldest → newest for return construction
  const returns: { s: number; b: number }[] = [];
  for (let i = 1; i < shared.length; i++) {
    const s0 = shared[i - 1]!;
    const s1 = shared[i]!;
    const b0 = benchByMonth.get(s0.date.slice(0, 7))!;
    const b1 = benchByMonth.get(s1.date.slice(0, 7))!;
    returns.push({ s: Math.log(s1.close / s0.close), b: Math.log(b1.close / b0.close) });
  }
  const months = returns.length;
  const windowStart = shared[0]?.date ?? null;
  const windowEnd = shared[shared.length - 1]?.date ?? null;
  const fail = (reason: string): BetaEstimate => ({
    beta: null,
    months,
    windowStart,
    windowEnd,
    rSquared: null,
    note: `beta not estimated: ${reason}`,
    gap: { field: "profile.beta", reason, severity: "warn", attemptedSources: ["computed:beta(monthly OLS vs SPY)"] },
  });
  if (months < minMonths) {
    return fail(`only ${months} monthly returns shared with the benchmark; ${minMonths} required for a beta estimate`);
  }
  const meanS = returns.reduce((a, r) => a + r.s, 0) / months;
  const meanB = returns.reduce((a, r) => a + r.b, 0) / months;
  let cov = 0;
  let varB = 0;
  let varS = 0;
  for (const r of returns) {
    cov += (r.s - meanS) * (r.b - meanB);
    varB += (r.b - meanB) ** 2;
    varS += (r.s - meanS) ** 2;
  }
  if (varB <= 0) return fail("benchmark returns have zero variance over the window");
  const beta = cov / varB;
  const rSquared = varS > 0 ? (cov * cov) / (varB * varS) : null;
  return {
    beta,
    months,
    windowStart,
    windowEnd,
    rSquared,
    note: `beta ${beta.toFixed(3)} from ${months} monthly log returns vs the benchmark (${windowStart} → ${windowEnd}), OLS slope; vendor betas use the same 5-year-monthly convention`,
    gap: null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.config.ts tests/stageB.betaEstimate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/stageB/betaEstimate.ts tests/stageB.betaEstimate.test.ts
git commit -m "feat(stageB): estimate beta from monthly returns for keyless profiles"
```

---

### Task 3: Yahoo chart client

**Files:**
- Create: `src/providers/yahoo.ts`
- Modify: `src/types/core.ts:23-30` (add `"yahoo"` to `DataSource`)
- Modify: `vitest.shared.ts` (add `"src/providers/yahoo.ts"` to `RISK_SOURCE_MANIFEST` after `"src/providers/http.ts"`)
- Test: `tests/yahoo.client.test.ts`

**Interfaces:**
- Consumes: `fetchWithPolicy`, `makeLimiter`, `TokenBucketLimiter`, `HttpTransportError` from `@/providers/http`; `FmpEodBarRow`, `FmpQuoteRow`, `FmpPayload`, `CachedFetchFn`, `CachedFetchResult`, `deriveAsOf` from `@/providers/fmp`; `FetchResult`, `Sourced` from `@/types/core`.
- Produces:

```ts
export interface YahooMeta {
  symbol: string;
  currency: string | null;
  exchangeName: string | null;
  fullExchangeName: string | null;
  longName: string | null;
  instrumentType: string | null;      // "EQUITY" | "ETF" | ...
  firstTradeDate: string | null;      // YYYY-MM-DD
  regularMarketPrice: number | null;
  regularMarketTime: string | null;   // ISO datetime
  regularMarketDayHigh: number | null;
  regularMarketDayLow: number | null;
  regularMarketVolume: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  chartPreviousClose: number | null;
}
export interface YahooClientConfig {
  fetchImpl?: typeof fetch; limiter?: TokenBucketLimiter; cachedFetch?: CachedFetchFn;
  now?: () => Date; userAgent?: string; timeoutMs?: number; signal?: AbortSignal; baseUrl?: string;
}
export class YahooClient {
  dailyHistory(symbol: string, from: string, to: string): Promise<FetchResult<FmpPayload<FmpEodBarRow>>>;
  quote(symbol: string): Promise<FetchResult<FmpPayload<FmpQuoteRow>>>;
  meta(symbol: string): Promise<FetchResult<YahooMeta>>;
}
export function createYahooClient(config?: YahooClientConfig): YahooClient;
export function yahooSymbol(symbol: string): string;      // "brk.b" → "BRK-B"
export const YAHOO_TTLS = { history: 24 * 3600 * 1000, quote: 15 * 60 * 1000 } as const;
export const YAHOO_DEFAULT_USER_AGENT: string;
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/yahoo.client.test.ts
import { describe, expect, it } from "vitest";
import { createYahooClient, yahooSymbol, YAHOO_TTLS } from "@/providers/yahoo";
import { makeLimiter } from "@/providers/http";
import type { CachedFetchFn } from "@/providers/fmp";

/** A chart payload the way Yahoo serves it: session-open timestamps, exchange offset, null bars possible. */
function chart(overrides: Partial<{ symbol: string; bars: number; nullAt: number[]; error: { code: string; description: string } | null; gmtoffset: number }> = {}) {
  const symbol = overrides.symbol ?? "AAPL";
  const bars = overrides.bars ?? 5;
  const nullAt = new Set(overrides.nullAt ?? []);
  const gmtoffset = overrides.gmtoffset ?? -14400;
  const start = Date.UTC(2026, 7, 24, 13, 30) / 1000; // 2026-08-24 09:30 New York
  const timestamp: number[] = [];
  const open: (number | null)[] = [];
  const high: (number | null)[] = [];
  const low: (number | null)[] = [];
  const close: (number | null)[] = [];
  const volume: (number | null)[] = [];
  const adjclose: (number | null)[] = [];
  for (let i = 0; i < bars; i++) {
    timestamp.push(start + i * 86400);
    const isNull = nullAt.has(i);
    open.push(isNull ? null : 100 + i);
    high.push(isNull ? null : 101 + i);
    low.push(isNull ? null : 99 + i);
    close.push(isNull ? null : 100.5 + i);
    volume.push(isNull ? null : 1000 + i);
    adjclose.push(isNull ? null : 100.4 + i);
  }
  return {
    chart: {
      result: overrides.error
        ? null
        : [
            {
              meta: {
                currency: "USD",
                symbol,
                exchangeName: "NMS",
                fullExchangeName: "NasdaqGS",
                instrumentType: "EQUITY",
                firstTradeDate: 345479400,
                regularMarketTime: start + (bars - 1) * 86400 + 23400,
                gmtoffset,
                regularMarketPrice: 100.5 + bars - 1,
                regularMarketDayHigh: 101 + bars - 1,
                regularMarketDayLow: 99 + bars - 1,
                regularMarketVolume: 1000 + bars - 1,
                fiftyTwoWeekHigh: 130,
                fiftyTwoWeekLow: 80,
                chartPreviousClose: 99.5,
                longName: "Apple Inc.",
                shortName: "Apple Inc.",
              },
              timestamp,
              indicators: { quote: [{ open, high, low, close, volume }], adjclose: [{ adjclose }] },
            },
          ],
      error: overrides.error ?? null,
    },
  };
}

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    calls.push({ url, headers });
    const { status, body } = handler(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(fetchImpl: typeof fetch, cachedFetch?: CachedFetchFn) {
  return createYahooClient({
    fetchImpl,
    limiter: makeLimiter(1000, 1000),
    now: () => new Date("2026-09-01T00:00:00Z"),
    ...(cachedFetch ? { cachedFetch } : {}),
  });
}

describe("yahooSymbol", () => {
  it("uppercases and maps FMP class separators to Yahoo's", () => {
    expect(yahooSymbol("brk.b")).toBe("BRK-B");
    expect(yahooSymbol("AAPL")).toBe("AAPL");
    expect(yahooSymbol(" spy ")).toBe("SPY");
  });
});

describe("YahooClient.dailyHistory", () => {
  it("returns FMP-shaped bars newest first, dated in the exchange's calendar, split-adjusted close", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: chart({ bars: 5 }) }));
    const res = await client(impl).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rows = res.value.data.rows;
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ symbol: "AAPL", date: "2026-08-28", open: 104, high: 105, low: 103, close: 104.5, volume: 1004, adjClose: 104.4 });
    expect(rows[4]!.date).toBe("2026-08-24");
    expect(res.value.source).toBe("yahoo");
    expect(res.value.endpoint).toBe("/v8/finance/chart/AAPL?interval=1d&period1=2026-08-20&period2=2026-09-01");
    expect(res.value.asOf).toBe("2026-08-28");
    // The request itself: epoch bounds, a User-Agent, one call.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/AAPL\?/);
    expect(calls[0]!.url).toContain("interval=1d");
    expect(calls[0]!.url).toContain("period1=1787270400");
    expect(calls[0]!.headers["user-agent"]).toMatch(/Mozilla/);
  });

  it("drops null bars instead of emitting zeros", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: chart({ bars: 4, nullAt: [1] }) }));
    const res = await client(impl).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data.rows.map((r) => r.date)).toEqual(["2026-08-27", "2026-08-26", "2026-08-24"]);
  });

  it("dates bars by the exchange offset so an Asian session does not land on the prior UTC day", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: chart({ bars: 1, gmtoffset: 32400, symbol: "7203.T" }) }));
    const res = await client(impl).dailyHistory("7203.T", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data.rows[0]!.date).toBe("2026-08-24");
  });

  it("turns a Yahoo error envelope into a disclosed gap, not an exception", async () => {
    const { impl } = fakeFetch(() => ({ status: 404, body: chart({ error: { code: "Not Found", description: "No data found, symbol may be delisted" } }) }));
    const res = await client(impl).dailyHistory("ZZZZ", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.field).toBe("yahoo.dailyHistory(ZZZZ)");
    expect(res.gap.reason).toMatch(/No data found/);
    expect(res.gap.attemptedSources).toEqual(["/v8/finance/chart/ZZZZ?interval=1d&period1=2026-08-20&period2=2026-09-01"]);
  });

  it("turns a 429 (missing or blocked User-Agent) into a gap after the transport's retries", async () => {
    let calls = 0;
    const { impl } = fakeFetch(() => {
      calls++;
      return { status: 429, body: "Too Many Requests" };
    });
    const res = await createYahooClient({ fetchImpl: impl, limiter: makeLimiter(1000, 1000), now: () => new Date("2026-09-01T00:00:00Z") }).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.reason).toMatch(/429/);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("rejects a schema-drifted body as a gap and never caches it", async () => {
    let cacheWrites = 0;
    const cachedFetch: CachedFetchFn = async (_key, _ttl, loader) => {
      const value = await loader();
      cacheWrites++;
      return { value };
    };
    const { impl } = fakeFetch(() => ({ status: 200, body: { chart: { result: [{ meta: {}, timestamp: "no" }], error: null } } }));
    const res = await client(impl, cachedFetch).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.reason).toMatch(/schema/i);
    expect(cacheWrites).toBe(0);
  });

  it("keys the cache by the exact request and uses the history TTL", async () => {
    const keys: { key: string; ttl: number }[] = [];
    const cachedFetch: CachedFetchFn = async (key, ttl, loader) => {
      keys.push({ key, ttl });
      return { value: await loader() };
    };
    const { impl } = fakeFetch(() => ({ status: 200, body: chart() }));
    await client(impl, cachedFetch).dailyHistory("AAPL", "2026-08-20", "2026-09-01");
    expect(keys).toEqual([{ key: "yahoo:/v8/finance/chart/AAPL?interval=1d&period1=2026-08-20&period2=2026-09-01", ttl: YAHOO_TTLS.history }]);
  });
});

describe("YahooClient.quote and meta", () => {
  it("builds an FMP-shaped quote from the chart meta", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: chart({ bars: 3 }) }));
    const res = await client(impl).quote("AAPL");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.value.data.rows[0]!;
    expect(row).toMatchObject({
      symbol: "AAPL",
      name: "Apple Inc.",
      price: 102.5,
      dayHigh: 103,
      dayLow: 101,
      yearHigh: 130,
      yearLow: 80,
      previousClose: 99.5,
      volume: 1002,
      exchange: "NMS",
      currency: "USD",
    });
    expect(row.marketCap).toBeNull();
    expect(typeof row.timestamp).toBe("number");
    expect(res.value.asOf).toBe("2026-08-26");
    expect(calls[0]!.url).toContain("range=5d");
  });

  it("exposes the meta needed for a keyless profile", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: chart() }));
    const res = await client(impl).meta("AAPL");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data).toMatchObject({
      symbol: "AAPL",
      currency: "USD",
      exchangeName: "NMS",
      fullExchangeName: "NasdaqGS",
      longName: "Apple Inc.",
      instrumentType: "EQUITY",
      firstTradeDate: "1980-12-12",
      regularMarketPrice: 104.5,
    });
  });

  it("reports a missing price as a gap rather than a zero quote", async () => {
    const body = chart({ bars: 2 });
    (body.chart.result![0]!.meta as { regularMarketPrice: number | null }).regularMarketPrice = null;
    const { impl } = fakeFetch(() => ({ status: 200, body }));
    const res = await client(impl).quote("AAPL");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap.reason).toMatch(/regularMarketPrice/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts tests/yahoo.client.test.ts`
Expected: FAIL — cannot resolve `@/providers/yahoo`.

- [ ] **Step 3: Add `"yahoo"` to `DataSource` and the risk manifest**

In `src/types/core.ts` change the union to:

```ts
export type DataSource =
  | "fmp"
  | "edgar"
  | "finra"
  | "fred"
  | "finnhub"
  | "yahoo"
  | "anthropic"
  | "computed";
```

In `vitest.shared.ts`, insert `"src/providers/yahoo.ts",` after `"src/providers/http.ts",` in `RISK_SOURCE_MANIFEST`.

- [ ] **Step 4: Write the implementation**

```ts
// src/providers/yahoo.ts
/**
 * Yahoo Finance chart endpoint — the keyless price source.
 *
 * Used only for members FMP could not serve (no key, empty, 402, refused
 * symbol) and only after EDGAR resolved the ticker to a real registrant. The
 * endpoint is unofficial: requests carry a browser-style User-Agent (the
 * server answers 429 without one), are rate-limited to 2/s, cached in the
 * durable api_cache, and every failure degrades to a disclosed gap.
 *
 * Contract with the rest of the pipeline: rows are FMP-shaped
 * (FmpEodBarRow / FmpQuoteRow) so Stage B is source-agnostic. `close` is the
 * split-adjusted close (Yahoo's `close` series) to match FMP's
 * "split-adjusted close only" contract; the dividend-adjusted `adjclose` is
 * carried as `adjClose` and not consumed.
 */
import { z } from "zod";
import {
  fetchWithPolicy,
  HttpTransportError,
  type TokenBucketLimiter,
  type FetchPolicy,
} from "@/providers/http";
import {
  deriveAsOf,
  type CachedFetchFn,
  type CachedFetchResult,
  type FmpEodBarRow,
  type FmpPayload,
  type FmpQuoteRow,
} from "@/providers/fmp";
import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";

const DEFAULT_BASE_URL = "https://query1.finance.yahoo.com";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const YAHOO_TTLS = { history: 24 * HOUR, quote: 15 * MINUTE } as const;
export const YAHOO_DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Thesis-research/1.0 (local-first equity research; keyless price fallback)";

export interface YahooMeta {
  symbol: string;
  currency: string | null;
  exchangeName: string | null;
  fullExchangeName: string | null;
  longName: string | null;
  instrumentType: string | null;
  firstTradeDate: string | null;
  regularMarketPrice: number | null;
  regularMarketTime: string | null;
  regularMarketDayHigh: number | null;
  regularMarketDayLow: number | null;
  regularMarketVolume: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  chartPreviousClose: number | null;
}

export interface YahooClientConfig {
  fetchImpl?: typeof fetch;
  limiter?: TokenBucketLimiter;
  cachedFetch?: CachedFetchFn;
  now?: () => Date;
  userAgent?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  baseUrl?: string;
}

/** FMP spells share classes "BRK.B"; Yahoo spells them "BRK-B". */
export function yahooSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\./g, "-");
}

const nullableNumber = z.number().finite().nullish();
const metaSchema = z.looseObject({
  symbol: z.string(),
  currency: z.string().nullish(),
  exchangeName: z.string().nullish(),
  fullExchangeName: z.string().nullish(),
  instrumentType: z.string().nullish(),
  firstTradeDate: nullableNumber,
  regularMarketTime: nullableNumber,
  gmtoffset: nullableNumber,
  regularMarketPrice: nullableNumber,
  regularMarketDayHigh: nullableNumber,
  regularMarketDayLow: nullableNumber,
  regularMarketVolume: nullableNumber,
  fiftyTwoWeekHigh: nullableNumber,
  fiftyTwoWeekLow: nullableNumber,
  chartPreviousClose: nullableNumber,
  longName: z.string().nullish(),
  shortName: z.string().nullish(),
});
const seriesSchema = z.array(z.number().finite().nullable());
const chartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.looseObject({
          meta: metaSchema,
          timestamp: z.array(z.number()).optional(),
          indicators: z.looseObject({
            quote: z.array(
              z.looseObject({
                open: seriesSchema.optional(),
                high: seriesSchema.optional(),
                low: seriesSchema.optional(),
                close: seriesSchema.optional(),
                volume: seriesSchema.optional(),
              }),
            ),
            adjclose: z.array(z.looseObject({ adjclose: seriesSchema.optional() })).optional(),
          }),
        }),
      )
      .nullable(),
    error: z.looseObject({ code: z.string().nullish(), description: z.string().nullish() }).nullable(),
  }),
});
type Chart = z.infer<typeof chartSchema>;
type ChartResult = NonNullable<Chart["chart"]["result"]>[number];

class YahooResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooResponseError";
  }
}

function gap<T>(field: string, reason: string, attemptedSources: string[], severity: ManifestEntry["severity"] = "warn"): FetchResult<T> {
  return { ok: false, gap: { field, reason, severity, attemptedSources } };
}

/** Calendar date of a session in the exchange's own offset (never the UTC date). */
function sessionDate(epochSeconds: number, gmtoffset: number | null | undefined): string {
  return new Date((epochSeconds + (gmtoffset ?? 0)) * 1000).toISOString().slice(0, 10);
}

function epochSeconds(isoDay: string): number {
  return Math.floor(Date.parse(`${isoDay}T00:00:00Z`) / 1000);
}

function metaOf(result: ChartResult): YahooMeta {
  const m = result.meta;
  const num = (v: number | null | undefined): number | null => (typeof v === "number" ? v : null);
  return {
    symbol: m.symbol,
    currency: m.currency ?? null,
    exchangeName: m.exchangeName ?? null,
    fullExchangeName: m.fullExchangeName ?? null,
    longName: m.longName ?? m.shortName ?? null,
    instrumentType: m.instrumentType ?? null,
    firstTradeDate: typeof m.firstTradeDate === "number" ? sessionDate(m.firstTradeDate, m.gmtoffset) : null,
    regularMarketPrice: num(m.regularMarketPrice),
    regularMarketTime: typeof m.regularMarketTime === "number" ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    regularMarketDayHigh: num(m.regularMarketDayHigh),
    regularMarketDayLow: num(m.regularMarketDayLow),
    regularMarketVolume: num(m.regularMarketVolume),
    fiftyTwoWeekHigh: num(m.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(m.fiftyTwoWeekLow),
    chartPreviousClose: num(m.chartPreviousClose),
  };
}

export class YahooClient {
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly limiter: TokenBucketLimiter | undefined;
  private readonly cachedFetch: CachedFetchFn;
  private readonly now: () => Date;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly baseUrl: string;

  constructor(config: YahooClientConfig = {}) {
    this.fetchImpl = config.fetchImpl;
    this.limiter = config.limiter;
    this.cachedFetch = config.cachedFetch ?? (async (_key, _ttl, loader) => ({ value: await loader() }));
    this.now = config.now ?? (() => new Date());
    this.userAgent = config.userAgent ?? YAHOO_DEFAULT_USER_AGENT;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.signal = config.signal;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  private async chart(
    symbol: string,
    query: string,
    ttlMs: number,
  ): Promise<{ ok: true; result: ChartResult; endpoint: string; fetchedAt: string } | { ok: false; reason: string; endpoint: string }> {
    const ySymbol = yahooSymbol(symbol);
    const endpoint = `/v8/finance/chart/${encodeURIComponent(ySymbol)}?${query}`;
    const url = `${this.baseUrl}${endpoint}`;
    const cacheKey = `yahoo:${endpoint}`;
    let exchange: CachedFetchResult<{ result: ChartResult; fetchedAt: string }>;
    try {
      exchange = await this.cachedFetch(cacheKey, ttlMs, async () => {
        const policy: FetchPolicy = {
          provider: "yahoo",
          timeoutMs: this.timeoutMs,
          signal: this.signal,
          ...(this.limiter ? { limiter: this.limiter } : {}),
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        };
        const res = await fetchWithPolicy(url, { headers: { "user-agent": this.userAgent, accept: "application/json" } }, policy);
        let body: unknown;
        try {
          body = res.bodyText.length > 0 ? (JSON.parse(res.bodyText) as unknown) : null;
        } catch {
          throw new YahooResponseError(`Yahoo returned unparseable body (HTTP ${res.status}) for ${endpoint}: ${res.bodyText.slice(0, 200)}`);
        }
        const parsed = chartSchema.safeParse(body);
        if (!parsed.success) {
          throw new YahooResponseError(`Yahoo provider schema drift for ${endpoint}: ${parsed.error.issues[0]?.message ?? "invalid body"} (HTTP ${res.status})`);
        }
        const chart = parsed.data.chart;
        if (chart.error) {
          throw new YahooResponseError(`Yahoo error for ${endpoint}: ${chart.error.code ?? "?"}: ${chart.error.description ?? "no description"} (HTTP ${res.status})`);
        }
        if (!res.ok) throw new YahooResponseError(`Yahoo HTTP ${res.status} for ${endpoint}: ${res.bodyText.slice(0, 200)}`);
        const result = chart.result?.[0];
        if (result === undefined) throw new YahooResponseError(`Yahoo returned no chart result for ${endpoint}`);
        return { result, fetchedAt: this.now().toISOString() };
      });
    } catch (err) {
      if (err instanceof YahooResponseError) return { ok: false, reason: err.message, endpoint };
      if (err instanceof HttpTransportError) return { ok: false, reason: `Yahoo transport failure for ${endpoint}: ${err.message}`, endpoint };
      throw err;
    }
    return { ok: true, result: exchange.value.result, endpoint, fetchedAt: exchange.fetchedAt ?? exchange.value.fetchedAt };
  }

  async dailyHistory(symbol: string, from: string, to: string): Promise<FetchResult<FmpPayload<FmpEodBarRow>>> {
    const field = `yahoo.dailyHistory(${symbol.trim().toUpperCase()})`;
    // Yahoo's period2 is exclusive; include the `to` session by adding a day.
    const query = `interval=1d&period1=${from}&period2=${to}`;
    const wire = `interval=1d&period1=${epochSeconds(from)}&period2=${epochSeconds(to) + 86_400}&events=div%2Csplits`;
    const fetched = await this.chartWithDisplayQuery(symbol, wire, query, YAHOO_TTLS.history);
    if (!fetched.ok) return gap(field, fetched.reason, [fetched.endpoint]);
    const { result, endpoint, fetchedAt } = fetched;
    const quote = result.indicators.quote[0];
    const stamps = result.timestamp ?? [];
    const adj = result.indicators.adjclose?.[0]?.adjclose ?? [];
    const rows: FmpEodBarRow[] = [];
    const ySymbol = yahooSymbol(symbol);
    for (let i = 0; i < stamps.length; i++) {
      const close = quote?.close?.[i] ?? null;
      const open = quote?.open?.[i] ?? null;
      const high = quote?.high?.[i] ?? null;
      const low = quote?.low?.[i] ?? null;
      const volume = quote?.volume?.[i] ?? null;
      if (close === null || open === null || high === null || low === null) continue;
      rows.push({
        symbol: ySymbol,
        date: sessionDate(stamps[i]!, result.meta.gmtoffset),
        open,
        high,
        low,
        close,
        volume: volume ?? 0,
        adjClose: adj[i] ?? null,
      });
    }
    if (rows.length === 0) return gap(field, `Yahoo returned no daily bars for ${endpoint}`, [endpoint], "warn");
    rows.sort((a, b) => (a.date! < b.date! ? 1 : a.date! > b.date! ? -1 : 0));
    const sourced: Sourced<FmpPayload<FmpEodBarRow>> = {
      data: { rows, raw: null },
      asOf: deriveAsOf(rows, fetchedAt),
      source: "yahoo",
      endpoint,
      fetchedAt,
    };
    return { ok: true, value: sourced };
  }

  /** Same as chart(), but the endpoint recorded in provenance/cache uses the readable ISO query. */
  private async chartWithDisplayQuery(symbol: string, wireQuery: string, displayQuery: string, ttlMs: number) {
    const ySymbol = yahooSymbol(symbol);
    const displayEndpoint = `/v8/finance/chart/${encodeURIComponent(ySymbol)}?${displayQuery}`;
    const fetched = await this.chartRaw(ySymbol, wireQuery, displayEndpoint, ttlMs);
    return fetched;
  }

  private async chartRaw(ySymbol: string, wireQuery: string, displayEndpoint: string, ttlMs: number) {
    // Implementation detail: identical to chart() except the wire query differs
    // from the endpoint string used for the cache key and provenance.
    const url = `${this.baseUrl}/v8/finance/chart/${encodeURIComponent(ySymbol)}?${wireQuery}`;
    const cacheKey = `yahoo:${displayEndpoint}`;
    let exchange: CachedFetchResult<{ result: ChartResult; fetchedAt: string }>;
    try {
      exchange = await this.cachedFetch(cacheKey, ttlMs, async () => {
        const policy: FetchPolicy = {
          provider: "yahoo",
          timeoutMs: this.timeoutMs,
          signal: this.signal,
          ...(this.limiter ? { limiter: this.limiter } : {}),
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        };
        const res = await fetchWithPolicy(url, { headers: { "user-agent": this.userAgent, accept: "application/json" } }, policy);
        let body: unknown;
        try {
          body = res.bodyText.length > 0 ? (JSON.parse(res.bodyText) as unknown) : null;
        } catch {
          throw new YahooResponseError(`Yahoo returned unparseable body (HTTP ${res.status}) for ${displayEndpoint}: ${res.bodyText.slice(0, 200)}`);
        }
        const parsed = chartSchema.safeParse(body);
        if (!parsed.success) {
          throw new YahooResponseError(`Yahoo provider schema drift for ${displayEndpoint}: ${parsed.error.issues[0]?.message ?? "invalid body"} (HTTP ${res.status})`);
        }
        const chart = parsed.data.chart;
        if (chart.error) {
          throw new YahooResponseError(`Yahoo error for ${displayEndpoint}: ${chart.error.code ?? "?"}: ${chart.error.description ?? "no description"} (HTTP ${res.status})`);
        }
        if (!res.ok) throw new YahooResponseError(`Yahoo HTTP ${res.status} for ${displayEndpoint}: ${res.bodyText.slice(0, 200)}`);
        const result = chart.result?.[0];
        if (result === undefined) throw new YahooResponseError(`Yahoo returned no chart result for ${displayEndpoint}`);
        return { result, fetchedAt: this.now().toISOString() };
      });
    } catch (err) {
      if (err instanceof YahooResponseError) return { ok: false as const, reason: err.message, endpoint: displayEndpoint };
      if (err instanceof HttpTransportError) return { ok: false as const, reason: `Yahoo transport failure for ${displayEndpoint}: ${err.message}`, endpoint: displayEndpoint };
      throw err;
    }
    return { ok: true as const, result: exchange.value.result, endpoint: displayEndpoint, fetchedAt: exchange.fetchedAt ?? exchange.value.fetchedAt };
  }

  async meta(symbol: string): Promise<FetchResult<YahooMeta>> {
    const field = `yahoo.meta(${symbol.trim().toUpperCase()})`;
    const fetched = await this.chartRaw(yahooSymbol(symbol), "range=5d&interval=1d", `/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?range=5d&interval=1d`, YAHOO_TTLS.quote);
    if (!fetched.ok) return gap(field, fetched.reason, [fetched.endpoint]);
    const meta = metaOf(fetched.result);
    const asOf = meta.regularMarketTime !== null ? sessionDate(Math.floor(Date.parse(meta.regularMarketTime) / 1000), fetched.result.meta.gmtoffset) : fetched.fetchedAt.slice(0, 10);
    return { ok: true, value: { data: meta, asOf, source: "yahoo", endpoint: fetched.endpoint, fetchedAt: fetched.fetchedAt } };
  }

  async quote(symbol: string): Promise<FetchResult<FmpPayload<FmpQuoteRow>>> {
    const field = `yahoo.quote(${symbol.trim().toUpperCase()})`;
    const metaRes = await this.meta(symbol);
    if (!metaRes.ok) return { ok: false, gap: { ...metaRes.gap, field } };
    const m = metaRes.value.data;
    if (m.regularMarketPrice === null || m.regularMarketPrice <= 0) {
      return gap(field, `Yahoo chart meta carried no regularMarketPrice for ${m.symbol}`, [metaRes.value.endpoint]);
    }
    const row: FmpQuoteRow = {
      symbol: m.symbol,
      name: m.longName,
      price: m.regularMarketPrice,
      change: m.chartPreviousClose !== null ? m.regularMarketPrice - m.chartPreviousClose : null,
      changePercentage: m.chartPreviousClose !== null && m.chartPreviousClose > 0 ? ((m.regularMarketPrice / m.chartPreviousClose) - 1) * 100 : null,
      volume: m.regularMarketVolume,
      dayLow: m.regularMarketDayLow,
      dayHigh: m.regularMarketDayHigh,
      yearHigh: m.fiftyTwoWeekHigh,
      yearLow: m.fiftyTwoWeekLow,
      marketCap: null,
      exchange: m.exchangeName,
      previousClose: m.chartPreviousClose,
      currency: m.currency,
      timestamp: m.regularMarketTime !== null ? Math.floor(Date.parse(m.regularMarketTime) / 1000) : null,
    };
    return {
      ok: true,
      value: { data: { rows: [row], raw: null }, asOf: metaRes.value.asOf, source: "yahoo", endpoint: metaRes.value.endpoint, fetchedAt: metaRes.value.fetchedAt },
    };
  }
}

export function createYahooClient(config: YahooClientConfig = {}): YahooClient {
  return new YahooClient(config);
}
```

Implementation notes for the engineer: `chart()` above duplicates `chartRaw()`; keep ONLY `chartRaw()` and delete `chart()` and `chartWithDisplayQuery()` once `dailyHistory` calls `chartRaw(yahooSymbol(symbol), wire, displayEndpoint, ttl)` directly — the plan shows both so the intent is unambiguous, the final file has one fetch path. `FmpQuoteRow` and `FmpEodBarRow` have index signatures, so `adjClose`, `currency`, `changePercentage` are legal extra keys; check the exact optional field names in `src/providers/fmp.ts:92-112` and `546-559` and use those spellings (`changePercentage`, `dayLow`, `dayHigh`, `yearHigh`, `yearLow`, `previousClose`, `timestamp`). `deriveAsOf(rows, fallbackIso)` is exported from `src/providers/fmp.ts`; confirm its signature before use. `FetchPolicy`'s `provider` is a plain string, so `"yahoo"` needs no change there; `getProviderLimiter("yahoo")` creates a default bucket — set the production limiter to `makeLimiter(2, 2)` inside `createYahooClient` when none is injected.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --config vitest.config.ts tests/yahoo.client.test.ts && npx tsc --noEmit`
Expected: PASS (11 tests); typecheck clean.

- [ ] **Step 6: Verify per-file coverage**

Run: `npx vitest run --config vitest.risk.config.ts --coverage tests/yahoo.client.test.ts 2>&1 | grep -E "yahoo.ts|ERROR"`
Expected: `yahoo.ts` ≥ 85 / 75 / 85 / 85. Add tests for any uncovered branch (transport error path: make `fetchImpl` throw a `HttpTransportError` after retries by returning status 500 repeatedly with `maxRetries` exhausted, or reject the promise).

- [ ] **Step 7: Commit**

```bash
git add src/providers/yahoo.ts src/types/core.ts vitest.shared.ts tests/yahoo.client.test.ts
git commit -m "feat(providers): keyless Yahoo chart client for prices and quotes"
```

---

### Task 4: XBRL companyfacts → statements

**Files:**
- Create: `src/edgar/statements.ts`
- Modify: `vitest.shared.ts` (add `"src/edgar/statements.ts"` and `"src/edgar/sic.ts"` after `"src/edgar/xbrl.ts"`)
- Test: `tests/edgar.statements.test.ts`

**Interfaces:**
- Consumes from `@/edgar/xbrl`: `CompanyFacts`, `FactPoint`, `parseFactPoints`, `dedupFactPoints`, `conceptFactsSchema`, `looksLikeBankTagging`, `CORE_FACT_FORMS`.
- Produces:

```ts
export interface StatementBuildOptions {
  symbol: string;
  cik: string | null;               // 10-digit or raw; copied onto rows
  annualPeriods: number;            // e.g. 10
  quarterlyPeriods: number;         // e.g. 24
}
export type Derivation = "ytd-difference" | "fy-minus-ytd" | "fy-minus-quarters";
export interface StatementRowsResult<TRow> {
  rows: TRow[];                     // date DESC
  notes: string[];
  gaps: ManifestEntry[];
}
export interface BuiltStatements {
  incomeAnnual: StatementRowsResult<FmpIncomeStatementRow>;
  incomeQuarterly: StatementRowsResult<FmpIncomeStatementRow>;
  balanceAnnual: StatementRowsResult<FmpBalanceSheetRow>;
  balanceQuarterly: StatementRowsResult<FmpBalanceSheetRow>;
  cashflowAnnual: StatementRowsResult<FmpCashFlowRow>;
  cashflowQuarterly: StatementRowsResult<FmpCashFlowRow>;
  /** Latest cover-page shares outstanding and public float from `dei`. */
  shares: { outstanding: { value: number; asOf: string } | null; publicFloat: { value: number; asOf: string } | null };
  reportedCurrency: string | null;
  /** True when at least one 20-F point was used (foreign private issuer). */
  filesTwentyF: boolean;
}
export function buildStatementsFromCompanyFacts(facts: CompanyFacts, opts: StatementBuildOptions): BuiltStatements;
```

Every row carries `symbol`, `cik`, `date`, `reportedCurrency`, `fiscalYear`, `period` (`"FY" | "Q1" | "Q2" | "Q3" | "Q4"`), `filingDate`, `acceptedDate` and, on derived quarterly rows, `derivation: Derivation` plus `derivedFrom: string[]`.

**Concept chains** (first tag with a point for the period wins; `sum` steps need every listed component; `sumAny` steps need at least one and treat absent components as 0 with a note):

| Field | Chain |
| --- | --- |
| income.revenue | `RevenueFromContractWithCustomerExcludingAssessedTax`, `Revenues`, `SalesRevenueNet`, `RevenueFromContractWithCustomerIncludingAssessedTax`, `RevenuesNetOfInterestExpense`; bank tagging (`looksLikeBankTagging`): `Revenues`, `RevenuesNetOfInterestExpense`, sum(`InterestIncomeExpenseNet`+`NoninterestIncome`), then the RFC tags |
| income.costOfRevenue | `CostOfRevenue`, `CostOfGoodsAndServicesSold`, `CostOfGoodsSold`, `CostOfServices` |
| income.grossProfit | `GrossProfit`; else revenue − costOfRevenue |
| income.researchAndDevelopmentExpenses | `ResearchAndDevelopmentExpense`, `ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost` |
| income.sellingGeneralAndAdministrativeExpenses | `SellingGeneralAndAdministrativeExpense`; else sum(`SellingAndMarketingExpense` + `GeneralAndAdministrativeExpense`) |
| income.operatingExpenses | `OperatingExpenses`; else sumAny(R&D, SG&A) |
| income.operatingIncome | `OperatingIncomeLoss` |
| income.interestExpense | `InterestExpense`, `InterestExpenseNonoperating`, `InterestExpenseDebt`, `InterestAndDebtExpense` |
| income.interestIncome | `InvestmentIncomeInterest`, `InvestmentIncomeInterestAndDividend`, `InterestAndDividendIncomeOperating` |
| income.netInterestIncome | `InterestIncomeExpenseNet` |
| income.incomeBeforeTax | `IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest`, `IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments` |
| income.incomeTaxExpense | `IncomeTaxExpenseBenefit` |
| income.netIncome | `NetIncomeLoss`, `ProfitLoss`, `NetIncomeLossAvailableToCommonStockholdersBasic` |
| income.eps / epsDiluted (unit `USD/shares`, any `*/shares`) | `EarningsPerShareBasic` / `EarningsPerShareDiluted` |
| income.weightedAverageShsOut / Dil (unit `shares`) | `WeightedAverageNumberOfSharesOutstandingBasic` / `WeightedAverageNumberOfDilutedSharesOutstanding` |
| income.depreciationAndAmortization | `DepreciationDepletionAndAmortization`, `DepreciationAndAmortization`, `DepreciationAmortizationAndAccretionNet` |
| income.ebitda | operatingIncome + depreciationAndAmortization |
| income.ebit | incomeBeforeTax + interestExpense; else operatingIncome |
| balance.cashAndCashEquivalents | `CashAndCashEquivalentsAtCarryingValue`, `Cash`, `CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents` |
| balance.shortTermInvestments | `ShortTermInvestments`, `MarketableSecuritiesCurrent`, `AvailableForSaleSecuritiesDebtSecuritiesCurrent` |
| balance.cashAndShortTermInvestments | `CashCashEquivalentsAndShortTermInvestments`; else cash + shortTermInvestments |
| balance.netReceivables | `AccountsReceivableNetCurrent`, `ReceivablesNetCurrent` |
| balance.inventory | `InventoryNet` |
| balance.totalCurrentAssets | `AssetsCurrent` |
| balance.propertyPlantEquipmentNet | `PropertyPlantAndEquipmentNet`, `PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization` |
| balance.goodwill | `Goodwill` |
| balance.intangibleAssets | `IntangibleAssetsNetExcludingGoodwill`, `FiniteLivedIntangibleAssetsNet` |
| balance.totalAssets | `Assets` |
| balance.shortTermDebt | `DebtCurrent`; else sumAny(`LongTermDebtCurrent`, `ShortTermBorrowings`, `CommercialPaper`) |
| balance.longTermDebt | `LongTermDebtNoncurrent`, `LongTermDebtAndCapitalLeaseObligations`, `LongTermDebt` |
| balance.totalCurrentLiabilities | `LiabilitiesCurrent` |
| balance.totalLiabilities | `Liabilities`; else totalAssets − totalEquity |
| balance.deferredRevenue | `ContractWithCustomerLiabilityCurrent`, `DeferredRevenueCurrent` |
| balance.capitalLeaseObligations | `FinanceLeaseLiability`, `CapitalLeaseObligations` |
| balance.preferredStock | `PreferredStockValue` |
| balance.commonStock | `CommonStockValue` |
| balance.retainedEarnings | `RetainedEarningsAccumulatedDeficit` |
| balance.accumulatedOtherComprehensiveIncomeLoss | `AccumulatedOtherComprehensiveIncomeLossNetOfTax` |
| balance.totalStockholdersEquity | `StockholdersEquity` |
| balance.minorityInterest | `MinorityInterest` |
| balance.totalEquity | `StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest`; else stockholdersEquity + minorityInterest (only when both present) |
| balance.deposits | `Deposits` (extra key; banks) |
| balance.totalDebt | shortTermDebt + longTermDebt (sumAny: at least one) |
| balance.netDebt | totalDebt − cashAndCashEquivalents |
| cashflow.netIncome | `NetIncomeLoss`, `ProfitLoss` |
| cashflow.depreciationAndAmortization | as income |
| cashflow.stockBasedCompensation | `ShareBasedCompensation`, `AllocatedShareBasedCompensationExpense` |
| cashflow.changeInWorkingCapital | −`IncreaseDecreaseInOperatingCapital` |
| cashflow.operatingCashFlow and netCashProvidedByOperatingActivities | `NetCashProvidedByUsedInOperatingActivities`, `NetCashProvidedByUsedInOperatingActivitiesContinuingOperations` |
| cashflow.capitalExpenditure and investmentsInPropertyPlantAndEquipment | −(`PaymentsToAcquirePropertyPlantAndEquipment`, `PaymentsToAcquireProductiveAssets`) |
| cashflow.acquisitionsNet | −`PaymentsToAcquireBusinessesNetOfCashAcquired` |
| cashflow.netDebtIssuance | `ProceedsFromIssuanceOfLongTermDebt` − `RepaymentsOfLongTermDebt` (both) |
| cashflow.netStockIssuance | `ProceedsFromIssuanceOfCommonStock` − `PaymentsForRepurchaseOfCommonStock` (both) |
| cashflow.commonStockRepurchased | −`PaymentsForRepurchaseOfCommonStock` |
| cashflow.netDividendsPaid and commonDividendsPaid | −(`PaymentsOfDividends`, `PaymentsOfDividendsCommonStock`) |
| cashflow.preferredDividendsPaid | −`PaymentsOfDividendsPreferredStockAndPreferenceStock` |
| cashflow.freeCashFlow | operatingCashFlow + capitalExpenditure |
| cashflow.incomeTaxesPaid | `IncomeTaxesPaidNet`, `IncomeTaxesPaid` |
| cashflow.interestPaid | `InterestPaidNet`, `InterestPaid` |
| cashflow.investingCashFlow / financingCashFlow (extra keys) | `NetCashProvidedByUsedInInvestingActivities` / `NetCashProvidedByUsedInFinancingActivities` |

**Period algorithm** (implement exactly; every step deterministic):

1. Index: for each `us-gaap` tag in any chain, parse `units` → `parseFactPoints` → `dedupFactPoints` (core forms only, max `filed` per period). Keep the unit key alongside each point; monetary fields accept only three-letter uppercase units, EPS accepts units ending in `/shares`, share counts accept `shares`.
2. Fiscal-year ends: from the ANCHOR concepts `Assets` (instants), `Revenues`/RFC revenue and `NetIncomeLoss` (durations 300–400 days) on forms `10-K`, `10-K/A`, `20-F`, `20-F/A`: the set of `end` dates. Sort DESC, keep `annualPeriods`. For each FY end `E`, the FY start `S` is the anchor duration point's `start`.
3. Annual income/cash-flow row at `E`: each field resolved by `findDuration(points, S, E)` = the deduped point whose `start` is within 3 days of `S` and `end` within 3 days of `E`; else, when no `S` is known, any point ending within 3 days of `E` with duration 300–400 days. Balance row at `E`: `findInstant(points, E)` = point with no `start` and `end` within 3 days of `E`.
4. Quarter ends: the set of `end` dates of `Assets` instant points on `10-Q`/`10-Q/A` plus every FY end. Sort DESC, keep `quarterlyPeriods` (+ one headroom). For each quarter end `Q`:
   - `fyStart(Q)` = the `start` of the FY (or YTD) duration point of the anchor revenue/net-income concept whose `[start, end]` contains `Q` (`start ≤ Q ≤ end`, `end − start ≤ 400 d`); fall back to the latest YTD point ending at `Q`'s own `start`.
   - `previousQuarterEnd(Q)` = the nearest earlier quarter end in the set within 70–110 days.
   - Income field value: (a) 3-month point: `start` within 3 days of `previousQuarterEnd(Q) + 1 day` … accept any point ending at `Q` with duration 70–110 days; (b) else YTD difference: `ytd(Q)` = point with `start` ≈ `fyStart(Q)` and `end` ≈ `Q`; `ytd(P)` = point with the same `start` and `end` ≈ `previousQuarterEnd(Q)`; value = `ytd(Q) − ytd(P)` (`"ytd-difference"`); when `Q` is the first quarter of the fiscal year (`Q − fyStart ≤ 110 d`), the YTD point IS the quarter; (c) when `Q` is an FY end: `fy − ytd(P)` where `ytd(P)` has the FY's own `start` (`"fy-minus-ytd"`); else `fy − (q1 + q2 + q3)` when all three 3-month points exist (`"fy-minus-quarters"`).
   - EPS and weighted-share fields: (a) only, plus the FY-minus-YTD rule for the fourth quarter of EPS only (FMP convention); weighted shares are never subtracted.
   - Cash-flow fields: 10-Q cash-flow facts are YTD, so apply (b) for every quarter (the first quarter's YTD is the quarter) and (c) for the fourth.
   - Balance: `findInstant(points, Q)`.
5. Emit a row only when its anchor resolved: income needs `revenue` or `netIncome`; balance needs `totalAssets`; cash flow needs `operatingCashFlow`. Missing anchors for a period produce a note, not a row, and a gap when ALL periods are missing (`edgar.statements.<statement>(<symbol>,<annual|quarter>)`).
6. Labels: `fiscalYear` = the `fy` of the anchor point when its `fp` is `FY` or the point came from a 10-K, else the FY end's year; `period` = `"FY"` for annual rows, and for quarterly rows the anchor point's `fp` when it is `Q1`/`Q2`/`Q3`, `"Q4"` for FY-end quarters, otherwise the ordinal of `Q` within its fiscal year. `filingDate`/`acceptedDate` = the anchor point's `filed`. `reportedCurrency` = the anchor point's unit.
7. `shares.outstanding` = latest `dei:EntityCommonStockSharesOutstanding` point (unit `shares`, core forms) by `end` (cover date); `shares.publicFloat` = latest `dei:EntityPublicFloat`. `filesTwentyF` = any used anchor point's form starts with `20-F`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/edgar.statements.test.ts
import { describe, expect, it } from "vitest";
import { buildStatementsFromCompanyFacts } from "@/edgar/statements";
import type { CompanyFacts } from "@/edgar/xbrl";

interface Pt { start?: string; end: string; val: number; form?: string; fy?: number; fp?: string; filed?: string; accn?: string }

/** Build a companyfacts payload from `{ tag: [points] }` (unit USD unless the tag says otherwise). */
function facts(usGaap: Record<string, Pt[]>, dei: Record<string, Pt[]> = {}, units: Record<string, string> = {}): CompanyFacts {
  const toConcept = (tag: string, points: Pt[]) => ({
    label: tag,
    units: {
      [units[tag] ?? (tag.startsWith("EarningsPerShare") ? "USD/shares" : /Shares/.test(tag) ? "shares" : "USD")]: points.map((p, i) => ({
        start: p.start,
        end: p.end,
        val: p.val,
        accn: p.accn ?? `0000000000-26-${String(i).padStart(6, "0")}`,
        fy: p.fy ?? Number(p.end.slice(0, 4)),
        fp: p.fp ?? (p.start === undefined || dur(p) > 300 ? "FY" : "Q1"),
        form: p.form ?? (p.start === undefined || dur(p) > 300 ? "10-K" : "10-Q"),
        filed: p.filed ?? `${Number(p.end.slice(0, 4)) + (p.end >= `${p.end.slice(0, 4)}-10` ? 1 : 0)}-02-01`,
      })),
    },
  });
  return {
    cik: 320193,
    entityName: "Test Corp",
    facts: {
      "us-gaap": Object.fromEntries(Object.entries(usGaap).map(([t, p]) => [t, toConcept(t, p)])),
      dei: Object.fromEntries(Object.entries(dei).map(([t, p]) => [t, toConcept(t, p)])),
    },
  };
}
const dur = (p: Pt) => (p.start ? (Date.parse(p.end) - Date.parse(p.start)) / 86_400_000 : 0);

/** A September fiscal year like Apple's: FY2025 = 2024-09-29..2025-09-27, three 10-Qs with 3-month + YTD income and YTD-only cash flow. */
function appleLike(): CompanyFacts {
  const fyStart = "2024-09-29";
  const fyEnd = "2025-09-27";
  const q1 = "2024-12-28";
  const q2 = "2025-03-29";
  const q3 = "2025-06-28";
  return facts(
    {
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        { start: fyStart, end: fyEnd, val: 400, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 120, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q2, val: 210, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: "2024-12-29", end: q2, val: 90, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: fyStart, end: q3, val: 300, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { start: "2025-03-30", end: q3, val: 90, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        // prior year, for the annual list
        { start: "2023-10-01", end: "2024-09-28", val: 380, form: "10-K", fp: "FY", fy: 2024, filed: "2024-11-01" },
      ],
      NetIncomeLoss: [
        { start: fyStart, end: fyEnd, val: 100, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 30, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q2, val: 55, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: "2024-12-29", end: q2, val: 25, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: fyStart, end: q3, val: 78, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { start: "2025-03-30", end: q3, val: 23, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { start: "2023-10-01", end: "2024-09-28", val: 90, form: "10-K", fp: "FY", fy: 2024, filed: "2024-11-01" },
      ],
      CostOfRevenue: [{ start: fyStart, end: fyEnd, val: 220, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      OperatingIncomeLoss: [{ start: fyStart, end: fyEnd, val: 130, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      DepreciationDepletionAndAmortization: [{ start: fyStart, end: fyEnd, val: 12, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      InterestExpense: [{ start: fyStart, end: fyEnd, val: 4, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: [{ start: fyStart, end: fyEnd, val: 128, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      EarningsPerShareDiluted: [
        { start: fyStart, end: fyEnd, val: 7.5, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 2.3, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q3, val: 5.9, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { start: "2025-03-30", end: q3, val: 1.7, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      WeightedAverageNumberOfDilutedSharesOutstanding: [
        { start: fyStart, end: fyEnd, val: 15_000, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: "2025-03-30", end: q3, val: 14_900, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      Assets: [
        { end: fyEnd, val: 360, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { end: q1, val: 340, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { end: q2, val: 345, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { end: q3, val: 350, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { end: "2024-09-28", val: 365, form: "10-K", fp: "FY", fy: 2024, filed: "2024-11-01" },
      ],
      StockholdersEquity: [{ end: fyEnd, val: 65, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      Liabilities: [{ end: fyEnd, val: 295, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      CashAndCashEquivalentsAtCarryingValue: [{ end: fyEnd, val: 30, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      ShortTermInvestments: [{ end: fyEnd, val: 25, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      LongTermDebtNoncurrent: [{ end: fyEnd, val: 80, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      LongTermDebtCurrent: [{ end: fyEnd, val: 10, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      CommercialPaper: [{ end: fyEnd, val: 5, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      NetCashProvidedByUsedInOperatingActivities: [
        { start: fyStart, end: fyEnd, val: 110, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 50, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q2, val: 80, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: fyStart, end: q3, val: 95, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      PaymentsToAcquirePropertyPlantAndEquipment: [
        { start: fyStart, end: fyEnd, val: 12, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 2, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q2, val: 5, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: fyStart, end: q3, val: 8, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      PaymentsForRepurchaseOfCommonStock: [{ start: fyStart, end: fyEnd, val: 90, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      PaymentsOfDividends: [{ start: fyStart, end: fyEnd, val: 15, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
    },
    {
      EntityCommonStockSharesOutstanding: [
        { end: "2025-10-17", val: 14_776, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { end: "2025-07-18", val: 14_900, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      EntityPublicFloat: [{ end: "2025-03-28", val: 3_000_000, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
    },
  );
}

const OPTS = { symbol: "AAPL", cik: "0000320193", annualPeriods: 10, quarterlyPeriods: 24 };

describe("buildStatementsFromCompanyFacts — annual rows", () => {
  it("builds FMP-shaped annual income rows newest first with computed totals only from present operands", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    const rows = built.incomeAnnual.rows;
    expect(rows.map((r) => r.date)).toEqual(["2025-09-27", "2024-09-28"]);
    const fy25 = rows[0]!;
    expect(fy25).toMatchObject({
      symbol: "AAPL",
      cik: "0000320193",
      reportedCurrency: "USD",
      fiscalYear: "2025",
      period: "FY",
      filingDate: "2025-10-31",
      revenue: 400,
      costOfRevenue: 220,
      grossProfit: 180,
      operatingIncome: 130,
      depreciationAndAmortization: 12,
      ebitda: 142,
      interestExpense: 4,
      incomeBeforeTax: 128,
      ebit: 132,
      netIncome: 100,
      epsDiluted: 7.5,
      weightedAverageShsOutDil: 15_000,
    });
    expect(fy25.incomeTaxExpense).toBeNull();
    // FY2024 has revenue and net income only: nothing else is invented.
    expect(rows[1]).toMatchObject({ revenue: 380, netIncome: 90, grossProfit: null, ebitda: null, ebit: null });
  });

  it("builds balance rows from instants and derives debt, net debt and cash totals per the rules", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    const fy25 = built.balanceAnnual.rows.find((r) => r.date === "2025-09-27")!;
    expect(fy25).toMatchObject({
      totalAssets: 360,
      totalStockholdersEquity: 65,
      totalLiabilities: 295,
      cashAndCashEquivalents: 30,
      shortTermInvestments: 25,
      cashAndShortTermInvestments: 55,
      longTermDebt: 80,
      shortTermDebt: 15, // LongTermDebtCurrent 10 + CommercialPaper 5 (sumAny)
      totalDebt: 95,
      netDebt: 65,
    });
    expect(fy25.totalEquity).toBeNull(); // MinorityInterest absent → not invented
    expect(built.balanceAnnual.notes.some((n) => /shortTermDebt.*sum of present components/.test(n))).toBe(true);
    const fy24 = built.balanceAnnual.rows.find((r) => r.date === "2024-09-28")!;
    expect(fy24.totalAssets).toBe(365);
    expect(fy24.totalDebt).toBeNull();
  });

  it("builds cash-flow rows with FMP sign conventions and free cash flow", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    const fy25 = built.cashflowAnnual.rows[0]!;
    expect(fy25).toMatchObject({
      date: "2025-09-27",
      netIncome: 100,
      operatingCashFlow: 110,
      netCashProvidedByOperatingActivities: 110,
      capitalExpenditure: -12,
      investmentsInPropertyPlantEquipment: -12,
      freeCashFlow: 98,
      commonStockRepurchased: -90,
      netDividendsPaid: -15,
      commonDividendsPaid: -15,
    });
  });
});

describe("buildStatementsFromCompanyFacts — quarterly rows", () => {
  it("uses tagged 3-month income facts, derives the missing quarter from YTD and the fourth from FY − YTD", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    const rows = built.incomeQuarterly.rows;
    expect(rows.map((r) => r.date)).toEqual(["2025-09-27", "2025-06-28", "2025-03-29", "2024-12-28"]);
    const [q4, q3, q2, q1] = rows as [typeof rows[0], typeof rows[0], typeof rows[0], typeof rows[0]];
    expect(q1).toMatchObject({ period: "Q1", revenue: 120, netIncome: 30, fiscalYear: "2025" });
    expect(q1.derivation).toBeUndefined();
    expect(q2).toMatchObject({ period: "Q2", revenue: 90, netIncome: 25 }); // tagged 3-month
    expect(q3).toMatchObject({ period: "Q3", revenue: 90, netIncome: 23, epsDiluted: 1.7, weightedAverageShsOutDil: 14_900 });
    expect(q4).toMatchObject({ period: "Q4", revenue: 100, netIncome: 22, derivation: "fy-minus-ytd", epsDiluted: 1.6 });
    expect(q4.weightedAverageShsOutDil).toBeNull(); // share counts are never subtracted
    expect(q4.derivedFrom).toEqual(expect.arrayContaining([expect.stringMatching(/2025-09-27/), expect.stringMatching(/2025-06-28/)]));
    expect(built.incomeQuarterly.notes.some((n) => /Q4.*FY − YTD/.test(n))).toBe(true);
  });

  it("derives every cash-flow quarter after the first from year-to-date differences", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    const rows = built.cashflowQuarterly.rows;
    expect(rows.map((r) => [r.date, r.operatingCashFlow, r.capitalExpenditure, r.freeCashFlow, r.derivation ?? null])).toEqual([
      ["2025-09-27", 15, -4, 11, "fy-minus-ytd"],
      ["2025-06-28", 15, -3, 12, "ytd-difference"],
      ["2025-03-29", 30, -3, 27, "ytd-difference"],
      ["2024-12-28", 50, -2, 48, null],
    ]);
  });

  it("builds a balance row at every quarter end and the fiscal year end", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    expect(built.balanceQuarterly.rows.map((r) => [r.date, r.totalAssets, r.period])).toEqual([
      ["2025-09-27", 360, "Q4"],
      ["2025-06-28", 350, "Q3"],
      ["2025-03-29", 345, "Q2"],
      ["2024-12-28", 340, "Q1"],
      ["2024-09-28", 365, "Q4"],
    ]);
  });

  it("never derives a quarter when an operand is missing", () => {
    const f = appleLike();
    // Remove the Q2 YTD net-income point: Q2 net income is still tagged 3-month, but Q3's derivation is unaffected;
    // remove the 3-month Q2 revenue and its YTD to force a gap for Q2 revenue.
    const rev = (f.facts["us-gaap"]!.RevenueFromContractWithCustomerExcludingAssessedTax as { units: { USD: { start?: string; end: string }[] } }).units.USD;
    const kept = rev.filter((p) => !(p.end === "2025-03-29"));
    (f.facts["us-gaap"]!.RevenueFromContractWithCustomerExcludingAssessedTax as { units: { USD: unknown[] } }).units.USD = kept;
    const built = buildStatementsFromCompanyFacts(f, OPTS);
    const q2 = built.incomeQuarterly.rows.find((r) => r.date === "2025-03-29")!;
    expect(q2.revenue).toBeNull();
    expect(q2.netIncome).toBe(25);
    // Q3 revenue had its own 3-month point, so it survives.
    expect(built.incomeQuarterly.rows.find((r) => r.date === "2025-06-28")!.revenue).toBe(90);
  });

  it("keeps the latest filing's value for a restated period and prefers an amendment on a tie", () => {
    const f = appleLike();
    const ni = (f.facts["us-gaap"]!.NetIncomeLoss as { units: { USD: { start?: string; end: string; val: number; form: string; filed: string }[] } }).units.USD;
    ni.push({ start: "2024-09-29", end: "2025-09-27", val: 101, form: "10-K/A", filed: "2025-10-31" } as never);
    ni.push({ start: "2024-09-29", end: "2025-09-27", val: 99, form: "10-K", filed: "2025-09-30" } as never);
    const built = buildStatementsFromCompanyFacts(f, OPTS);
    expect(built.incomeAnnual.rows[0]!.netIncome).toBe(101);
  });
});

describe("buildStatementsFromCompanyFacts — edge cases", () => {
  it("tolerates a 53-week year and a quarter end shifted by up to three days", () => {
    const f = appleLike();
    const assets = (f.facts["us-gaap"]!.Assets as { units: { USD: { end: string }[] } }).units.USD;
    assets.find((p) => p.end === "2025-06-28")!.end = "2025-06-30"; // instant reported two days later
    const built = buildStatementsFromCompanyFacts(f, OPTS);
    expect(built.balanceQuarterly.rows.some((r) => r.date === "2025-06-30" && r.totalAssets === 350)).toBe(true);
    // The income 3-month point still attaches to that quarter end.
    expect(built.incomeQuarterly.rows.find((r) => r.date === "2025-06-30")?.revenue ?? built.incomeQuarterly.rows.find((r) => r.date === "2025-06-28")?.revenue).toBe(90);
  });

  it("uses the bank revenue chain for bank-style tagging", () => {
    const f = facts({
      InterestIncomeExpenseNet: [{ start: "2025-01-01", end: "2025-12-31", val: 90, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
      NoninterestIncome: [{ start: "2025-01-01", end: "2025-12-31", val: 60, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
      NetIncomeLoss: [{ start: "2025-01-01", end: "2025-12-31", val: 50, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
      Assets: [{ end: "2025-12-31", val: 4000, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
      Deposits: [{ end: "2025-12-31", val: 2500, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
    });
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "BANK" });
    expect(built.incomeAnnual.rows[0]).toMatchObject({ revenue: 150, netInterestIncome: 90, netIncome: 50 });
    expect(built.balanceAnnual.rows[0]).toMatchObject({ deposits: 2500 });
    expect(built.incomeAnnual.notes.some((n) => /bank revenue chain/.test(n))).toBe(true);
  });

  it("reports currency from the fact unit and flags a 20-F filer", () => {
    const f = facts(
      {
        Revenues: [{ start: "2025-01-01", end: "2025-12-31", val: 500, form: "20-F", fp: "FY", fy: 2025, filed: "2026-03-20" }],
        NetIncomeLoss: [{ start: "2025-01-01", end: "2025-12-31", val: 40, form: "20-F", fp: "FY", fy: 2025, filed: "2026-03-20" }],
        Assets: [{ end: "2025-12-31", val: 900, form: "20-F", fp: "FY", fy: 2025, filed: "2026-03-20" }],
      },
      {},
      { Revenues: "EUR", NetIncomeLoss: "EUR", Assets: "EUR" },
    );
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "SAP" });
    expect(built.incomeAnnual.rows[0]!.reportedCurrency).toBe("EUR");
    expect(built.reportedCurrency).toBe("EUR");
    expect(built.filesTwentyF).toBe(true);
    expect(built.incomeQuarterly.rows).toEqual([]);
    expect(built.incomeQuarterly.gaps[0]?.reason).toMatch(/no quarterly/i);
  });

  it("exposes cover-page shares and float, newest first, and returns empty results with gaps for an empty payload", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    expect(built.shares).toEqual({
      outstanding: { value: 14_776, asOf: "2025-10-17" },
      publicFloat: { value: 3_000_000, asOf: "2025-03-28" },
    });
    const empty = buildStatementsFromCompanyFacts({ cik: 1, entityName: "Empty", facts: {} }, OPTS);
    expect(empty.incomeAnnual.rows).toEqual([]);
    expect(empty.incomeAnnual.gaps[0]).toMatchObject({ field: "edgar.statements.income(AAPL,annual)", severity: "warn" });
    expect(empty.shares).toEqual({ outstanding: null, publicFloat: null });
  });

  it("ignores facts from non-core forms and honours the period limits", () => {
    const f = appleLike();
    const rev = (f.facts["us-gaap"]!.RevenueFromContractWithCustomerExcludingAssessedTax as { units: { USD: { form: string; end: string; val: number }[] } }).units.USD;
    rev.push({ start: "2022-10-02", end: "2023-09-30", val: 370, form: "8-K", filed: "2023-11-01" } as never);
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, annualPeriods: 1, quarterlyPeriods: 2 });
    expect(built.incomeAnnual.rows.map((r) => r.date)).toEqual(["2025-09-27"]);
    expect(built.incomeQuarterly.rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts tests/edgar.statements.test.ts`
Expected: FAIL — cannot resolve `@/edgar/statements`.

- [ ] **Step 3: Write the implementation**

Structure the module as: (1) the chain tables from the concept-chain table above as `const INCOME_CHAINS`, `BALANCE_CHAINS`, `CASHFLOW_CHAINS` typed `Record<string, ChainSpec>` where

```ts
type ChainSpec =
  | { kind: "first"; tags: string[]; unit: "money" | "perShare" | "shares"; sign?: -1 }
  | { kind: "sum"; tags: string[]; unit: "money" }        // every component required
  | { kind: "sumAny"; tags: string[]; unit: "money" }     // at least one component
  | { kind: "diff"; plus: string; minus: string; unit: "money" }; // both required
```

(2) an index `Map<tag, { unit: string; points: FactPoint[] }[]>` built once per call from `facts.facts["us-gaap"]` and `facts.facts["dei"]` with `conceptFactsSchema.safeParse` → `parseFactPoints` → `dedupFactPoints`; (3) period resolvers `findInstant`, `findDuration`, `findByDurationDays` implementing the tolerances in the algorithm; (4) `resolveField(spec, period)` returning `{ value, point, unit } | null`; (5) the annual builder, the quarterly builder (income + cash-flow variants share one function parameterised by `ytdOnly: boolean` and `epsRule`), the balance builder; (6) the computed-field pass (`grossProfit`, `ebitda`, `ebit`, `cashAndShortTermInvestments`, `totalEquity`, `totalLiabilities`, `totalDebt`, `netDebt`, `freeCashFlow`) that only fills a field when it is still `null`; (7) row labelling and sorting; (8) `dei` shares.

Write every value as `number | null`; every row must satisfy the `FmpIncomeStatementRow`/`FmpBalanceSheetRow`/`FmpCashFlowRow` interfaces (index signatures allow the extra keys `derivation`, `derivedFrom`, `deposits`, `investingCashFlow`, `financingCashFlow`). Keep the file focused on statements; the SIC map lives in `sic.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.config.ts tests/edgar.statements.test.ts && npx tsc --noEmit`
Expected: PASS (13 tests); typecheck clean.

- [ ] **Step 5: Verify per-file coverage; add tests for uncovered branches**

Run: `npx vitest run --config vitest.risk.config.ts --coverage tests/edgar.statements.test.ts tests/edgar.sic.test.ts 2>&1 | grep -E "statements.ts|sic.ts|ERROR"`
Expected: both ≥ 85 / 75 / 85 / 85.

- [ ] **Step 6: Commit**

```bash
git add src/edgar/statements.ts vitest.shared.ts tests/edgar.statements.test.ts
git commit -m "feat(edgar): build FMP-shaped statements from XBRL companyfacts"
```

---

### Task 5: Keyless fallback orchestration

**Files:**
- Create: `src/pipeline/keyless.ts`
- Modify: `src/pipeline/types.ts:117-135` (`EdgarBundle` gains `registrant`)
- Modify: `vitest.shared.ts` (add `"src/pipeline/keyless.ts"` after `"src/pipeline/dataBundle.ts"`)
- Test: `tests/keyless.test.ts`

**Interfaces:**
- Consumes: `buildStatementsFromCompanyFacts` (Task 4), `sectorIndustryForSic` (Task 1), `estimateBeta` (Task 2), `YahooClient` (Task 3), `EdgarSubmissions`/`CikMapping` from `@/providers/edgar`, `CompanyFacts` from `@/edgar/xbrl`, FMP row types.
- Produces:

```ts
// src/pipeline/types.ts — add to EdgarBundle (plain object: NOT a FetchResult, so the
// producer registry and the audit fixture projection are unchanged):
export interface EdgarRegistrant {
  name: string;
  cik10: string;
  sic: string | null;
  sicDescription: string | null;
  exchanges: string[];
  tickers: string[];
  fiscalYearEnd: string | null;
  stateOfIncorporation: string | null;
  /** Distinct form types among recent filings (e.g. ["10-K","10-Q","8-K"]). */
  forms: string[];
}
// EdgarBundle: registrant: EdgarRegistrant | null;

// src/pipeline/keyless.ts
export interface KeylessMembers {
  profile: FetchResult<FmpPayload<FmpProfileRow>>;
  quote: FetchResult<FmpPayload<FmpQuoteRow>>;
  incomeAnnual: FetchResult<FmpPayload<FmpIncomeStatementRow>>;
  incomeQuarterly: FetchResult<FmpPayload<FmpIncomeStatementRow>>;
  balanceAnnual: FetchResult<FmpPayload<FmpBalanceSheetRow>>;
  balanceQuarterly: FetchResult<FmpPayload<FmpBalanceSheetRow>>;
  cashflowAnnual: FetchResult<FmpPayload<FmpCashFlowRow>>;
  cashflowQuarterly: FetchResult<FmpPayload<FmpCashFlowRow>>;
  eodPrices: FetchResult<FmpPayload<FmpEodBarRow>>;
  spy: FetchResult<FmpPayload<FmpEodBarRow>>;
  sectorEtf: FetchResult<FmpPayload<FmpEodBarRow>>;
  enterpriseValues: FetchResult<FmpPayload<FmpEnterpriseValuesRow>>;
  marketCapHistory: FetchResult<FmpPayload<FmpMarketCapRow>>;
  sharesFloat: FetchResult<FmpPayload<FmpSharesFloatRow>>;
}
export interface KeylessInputs {
  symbol: string;
  today: string;                 // YYYY-MM-DD
  eodFrom: string;               // YYYY-MM-DD
  sectorEtfSymbol: string | null; // resolved by the caller from the FMP sector, or null
  fmp: KeylessMembers;           // FMP's results (ok, gap, or ok-but-empty)
  fmpKeyless: boolean;           // no FMP key configured → gaps are `expected`
  edgar: { cik: FetchResult<CikMapping>; registrant: EdgarRegistrant | null; companyFacts: FetchResult<CompanyFacts> };
  yahoo: YahooClient;
  annualPeriods: number;
  quarterlyPeriods: number;
  now: () => Date;
}
export interface KeylessOutcome {
  members: KeylessMembers;
  /** Sector ETF symbol resolved from the keyless profile when FMP had none. */
  sectorEtfSymbol: string | null;
  gaps: ManifestEntry[];
  notes: string[];
  /** Members actually replaced, for progress logging. */
  replaced: (keyof KeylessMembers)[];
}
export async function applyKeylessFallbacks(inputs: KeylessInputs): Promise<KeylessOutcome>;
export function needsFallback<T>(result: FetchResult<FmpPayload<T>>): boolean; // gap OR ok with zero rows
```

Rules:

- If `inputs.edgar.cik` is not ok → return the inputs unchanged with one note `"keyless fallbacks skipped: EDGAR did not resolve <symbol> to a registrant"` and no gaps.
- Only members where `needsFallback(fmp.<member>)` is true are replaced; an FMP result with rows is never overwritten.
- Statements: build once from `companyFacts` (gap → all six statement members keep their FMP gap with `attemptedSources` extended by `"edgar:companyfacts"` and the reason appended). Each ok statement member: `source: "edgar"`, `endpoint: "companyfacts→income-statement(annual)"` (and the five siblings), `asOf` = newest row date, `data: { rows, raw: null }`.
- Yahoo history for the symbol, SPY and the sector ETF (`sectorEtfSymbol` from the caller, else from the keyless profile's sector via `resolveSectorEtf` imported from `@/pipeline/dataBundle` — to avoid a circular import, accept `resolveSectorEtf` as `inputs.resolveSectorEtf: (sector: string | null) => string | null`) — add that field to `KeylessInputs`.
- Profile row (only when FMP's profile needs a fallback and `registrant` is non-null): `symbol`, `companyName` = registrant.name (Yahoo `longName` when the registrant name is all caps and Yahoo has one), `cik`, `sector`/`industry` from `sectorIndustryForSic(registrant.sic)`, `exchange` = Yahoo `exchangeName` ?? registrant.exchanges[0], `exchangeFullName` = Yahoo `fullExchangeName`, `currency` = Yahoo currency ?? statements currency, `country` = `"US"` when `stateOfIncorporation` is a two-letter US state/DC/territory code, else null, `ipoDate` = Yahoo `firstTradeDate`, `price` = Yahoo price, `marketCap` = price × shares.outstanding (null when either missing), `beta` = `estimateBeta(symbol closes, SPY closes).beta`, `isEtf: false`, `isFund: false`, `isAdr: filesTwentyF`, `isActivelyTrading: true`, `description: null`, `ceo: null`, `website: null`, `fullTimeEmployees: null`. `source: "computed"`, `endpoint: "derived:profile(edgar:submissions + yahoo:chart + dei:shares)"`. The beta gap (if any) is appended to `gaps`.
- Quote: Yahoo quote with `marketCap` filled from shares; `source: "yahoo"`.
- Enterprise values: for each quarterly balance row (from whichever balance source is in effect after fallback) with `date`, `stockPrice` = last close on or before `date` from the (post-fallback) `eodPrices` rows, `numberOfShares` = that quarter's income row `weightedAverageShsOutDil` else the dei share count with the nearest cover date on or before `date + 60 days`, `marketCapitalization` = price × shares, `addTotalDebt` = `totalDebt`, `minusCashAndCashEquivalents` = `cashAndCashEquivalents`, `enterpriseValue` = marketCap + debt − cash (all four required, else skip the row with a note). `source: "computed"`, `endpoint: "derived:enterprise-values(balance×close×shares)"`.
- Market-cap history: every `eodPrices` row × the dei share count whose cover date is the latest on or before the row date (rows before the earliest cover date use the earliest); `source: "computed"`.
- Shares float: `{ symbol, date: shares.outstanding.asOf, outstandingShares, floatShares: publicFloat / price when both present, freeFloat: floatShares / outstanding × 100, source: "edgar" }`.
- Every replacement pushes `{ field: "keyless.<member>", reason: "served by <source> (<endpoint>) because FMP <original reason or 'returned no rows'>", severity: "info", expected: inputs.fmpKeyless }`. A keyless failure leaves the FMP result in place and pushes the keyless gap with `field: "keyless.<member>"`, `severity: "warn"`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/keyless.test.ts
import { describe, expect, it } from "vitest";
import { applyKeylessFallbacks, needsFallback, type KeylessInputs, type KeylessMembers } from "@/pipeline/keyless";
import { createYahooClient } from "@/providers/yahoo";
import { makeLimiter } from "@/providers/http";
import type { CompanyFacts } from "@/edgar/xbrl";
import type { FetchResult } from "@/types/core";
import type { FmpPayload } from "@/providers/fmp";

const NOW = new Date("2026-09-01T00:00:00Z");
const gap = <T>(field: string, reason = "no API key + no fixture"): FetchResult<FmpPayload<T>> => ({ ok: false, gap: { field, reason, severity: "warn" } });
const okRows = <T>(rows: T[], endpoint = "/stable/x"): FetchResult<FmpPayload<T>> => ({ ok: true, value: { data: { rows, raw: null }, asOf: "2026-09-01", source: "fmp", endpoint, fetchedAt: NOW.toISOString() } });

function allGaps(): KeylessMembers {
  return {
    profile: gap("fmp.profile(AAPL)"),
    quote: gap("fmp.quote(AAPL)"),
    incomeAnnual: gap("fmp.incomeStatement(AAPL,annual)"),
    incomeQuarterly: gap("fmp.incomeStatement(AAPL,quarter)"),
    balanceAnnual: gap("fmp.balanceSheet(AAPL,annual)"),
    balanceQuarterly: gap("fmp.balanceSheet(AAPL,quarter)"),
    cashflowAnnual: gap("fmp.cashFlow(AAPL,annual)"),
    cashflowQuarterly: gap("fmp.cashFlow(AAPL,quarter)"),
    eodPrices: gap("fmp.historicalPriceEodFull(AAPL)"),
    spy: gap("fmp.historicalPriceEodFull(SPY)"),
    sectorEtf: gap("fmp.historicalPriceEodFull(XLK)", "FMP returned unparseable body (HTTP 402): symbol not available"),
    enterpriseValues: gap("fmp.enterpriseValues(AAPL,quarter)"),
    marketCapHistory: gap("fmp.historicalMarketCap(AAPL)"),
    sharesFloat: gap("fmp.sharesFloat(AAPL)"),
  };
}

/** Minimal Apple-like facts: two fiscal years, one 10-Q quarter, dei shares. Reuse the shape from tests/edgar.statements.test.ts. */
function appleFacts(): CompanyFacts { /* copy the `facts`/`appleLike` helpers from tests/edgar.statements.test.ts verbatim */ return appleLike(); }

/** Yahoo fake serving 5y of synthetic daily bars for any symbol and a quote meta. */
function fakeYahoo(opts: { fail?: Set<string> } = {}) {
  const impl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const symbol = /chart\/([^?]+)/.exec(url)![1]!;
    if (opts.fail?.has(symbol)) return new Response("Too Many Requests", { status: 429 });
    const isQuote = url.includes("range=5d");
    const start = Date.UTC(2021, 8, 1, 13, 30) / 1000;
    const n = isQuote ? 5 : 1250;
    const timestamp = Array.from({ length: n }, (_, i) => start + i * 86400);
    const close = timestamp.map((_, i) => (symbol === "SPY" ? 400 : 150) * Math.exp(0.0002 * i));
    return new Response(JSON.stringify({ chart: { result: [{ meta: { currency: "USD", symbol, exchangeName: "NMS", fullExchangeName: "NasdaqGS", instrumentType: "EQUITY", firstTradeDate: 345479400, regularMarketTime: timestamp[n - 1]! + 23400, gmtoffset: -14400, regularMarketPrice: close[n - 1], regularMarketDayHigh: 1, regularMarketDayLow: 1, regularMarketVolume: 5, fiftyTwoWeekHigh: 1, fiftyTwoWeekLow: 1, chartPreviousClose: 1, longName: "Apple Inc." }, timestamp, indicators: { quote: [{ open: close, high: close, low: close, close, volume: close.map(() => 1000) }], adjclose: [{ adjclose: close }] } }], error: null } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return createYahooClient({ fetchImpl: impl, limiter: makeLimiter(1000, 1000), now: () => NOW });
}

function inputs(over: Partial<KeylessInputs> = {}): KeylessInputs {
  return {
    symbol: "AAPL",
    today: "2026-09-01",
    eodFrom: "2021-09-01",
    sectorEtfSymbol: null,
    fmp: allGaps(),
    fmpKeyless: true,
    edgar: {
      cik: { ok: true, value: { data: { cik10: "0000320193", cik: 320193, ticker: "AAPL", title: "Apple Inc." }, asOf: "2026-09-01", source: "edgar", endpoint: "company_tickers.json", fetchedAt: NOW.toISOString() } },
      registrant: { name: "Apple Inc.", cik10: "0000320193", sic: "3571", sicDescription: "ELECTRONIC COMPUTERS", exchanges: ["Nasdaq"], tickers: ["AAPL"], fiscalYearEnd: "0927", stateOfIncorporation: "CA", forms: ["10-K", "10-Q", "8-K"] },
      companyFacts: { ok: true, value: { data: appleFacts(), asOf: "2025-09-27", source: "edgar", endpoint: "companyfacts", fetchedAt: NOW.toISOString() } },
    },
    yahoo: fakeYahoo(),
    annualPeriods: 10,
    quarterlyPeriods: 24,
    now: () => NOW,
    resolveSectorEtf: (sector) => (sector === "Technology" ? "XLK" : null),
    ...over,
  };
}

describe("needsFallback", () => {
  it("is true for a gap or an empty ok result and false for rows", () => {
    expect(needsFallback(gap("x"))).toBe(true);
    expect(needsFallback(okRows([]))).toBe(true);
    expect(needsFallback(okRows([{ a: 1 }]))).toBe(false);
  });
});

describe("applyKeylessFallbacks", () => {
  it("fills every core member from EDGAR and Yahoo with provenance and expected info gaps", async () => {
    const out = await applyKeylessFallbacks(inputs());
    const m = out.members;
    expect(m.profile.ok && m.profile.value.source).toBe("computed");
    if (!m.profile.ok) return;
    const profile = m.profile.value.data.rows[0]!;
    expect(profile).toMatchObject({ symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology", industry: "Computer Hardware", currency: "USD", country: "US", isEtf: false, isFund: false, isAdr: false, ipoDate: "1980-12-12", cik: "0000320193" });
    expect(profile.price).toBeGreaterThan(0);
    expect(profile.marketCap).toBeCloseTo(profile.price! * 14_776, 3);
    expect(typeof profile.beta).toBe("number");
    expect(m.quote.ok && m.quote.value.source).toBe("yahoo");
    expect(m.incomeAnnual.ok && m.incomeAnnual.value.source).toBe("edgar");
    expect(m.incomeAnnual.ok && m.incomeAnnual.value.endpoint).toBe("companyfacts→income-statement(annual)");
    expect(m.incomeAnnual.ok && m.incomeAnnual.value.data.rows[0]!.revenue).toBe(400);
    expect(m.balanceQuarterly.ok && m.balanceQuarterly.value.data.rows.length).toBeGreaterThan(0);
    expect(m.eodPrices.ok && m.eodPrices.value.data.rows.length).toBeGreaterThan(1000);
    expect(m.spy.ok && m.spy.value.source).toBe("yahoo");
    expect(m.sectorEtf.ok && m.sectorEtf.value.source).toBe("yahoo");
    expect(out.sectorEtfSymbol).toBe("XLK");
    expect(m.enterpriseValues.ok && m.enterpriseValues.value.source).toBe("computed");
    if (m.enterpriseValues.ok) {
      const ev = m.enterpriseValues.value.data.rows[0]!;
      expect(ev.enterpriseValue).toBeCloseTo(ev.marketCapitalization! + ev.addTotalDebt! - ev.minusCashAndCashEquivalents!, 6);
    }
    expect(m.marketCapHistory.ok && m.marketCapHistory.value.data.rows.length).toBeGreaterThan(1000);
    expect(m.sharesFloat.ok && m.sharesFloat.value.data.rows[0]).toMatchObject({ outstandingShares: 14_776 });
    expect(out.replaced.sort()).toEqual(Object.keys(allGaps()).sort());
    const fields = out.gaps.map((g) => g.field);
    expect(fields).toContain("keyless.incomeAnnual");
    expect(out.gaps.every((g) => g.severity === "info" && g.expected === true)).toBe(true);
    expect(out.gaps.find((g) => g.field === "keyless.profile")?.reason).toMatch(/served by computed .* because FMP no API key \+ no fixture/);
  });

  it("never overwrites an FMP member that has rows, and marks gaps as unexpected on a keyed plan", async () => {
    const fmp = allGaps();
    fmp.incomeAnnual = okRows([{ date: "2025-09-27", revenue: 1 }]);
    const out = await applyKeylessFallbacks(inputs({ fmp, fmpKeyless: false }));
    expect(out.members.incomeAnnual).toBe(fmp.incomeAnnual);
    expect(out.replaced).not.toContain("incomeAnnual");
    expect(out.gaps.every((g) => g.expected === undefined || g.expected === false)).toBe(true);
    expect(out.gaps.find((g) => g.field === "keyless.sectorEtf")?.reason).toMatch(/HTTP 402/);
  });

  it("leaves the FMP gap in place and records the keyless failure when Yahoo is unavailable", async () => {
    const out = await applyKeylessFallbacks(inputs({ yahoo: fakeYahoo({ fail: new Set(["AAPL", "SPY", "XLK"]) }) }));
    expect(out.members.eodPrices.ok).toBe(false);
    if (out.members.eodPrices.ok) return;
    expect(out.members.eodPrices.gap.reason).toBe("no API key + no fixture");
    expect(out.members.eodPrices.gap.attemptedSources).toEqual(expect.arrayContaining([expect.stringMatching(/yahoo/)]));
    expect(out.gaps.find((g) => g.field === "keyless.eodPrices")?.severity).toBe("warn");
    // Statements still come from EDGAR; the profile still exists but without price-derived fields.
    expect(out.members.incomeAnnual.ok).toBe(true);
    expect(out.members.profile.ok && out.members.profile.value.data.rows[0]!.price).toBeNull();
    expect(out.members.enterpriseValues.ok).toBe(false);
  });

  it("does nothing when EDGAR did not resolve the ticker", async () => {
    const fmp = allGaps();
    const out = await applyKeylessFallbacks(inputs({ fmp, edgar: { cik: { ok: false, gap: { field: "edgar.cik(DEMO)", reason: 'ticker "DEMO" not in SEC company_tickers.json', severity: "warn" } }, registrant: null, companyFacts: { ok: false, gap: { field: "x", reason: "n/a", severity: "warn" } } } }));
    expect(out.members).toEqual(fmp);
    expect(out.replaced).toEqual([]);
    expect(out.gaps).toEqual([]);
    expect(out.notes[0]).toMatch(/skipped/);
  });

  it("flags a 20-F filer as an ADR and leaves country null for a foreign incorporation", async () => {
    const facts = appleFacts();
    for (const concept of Object.values(facts.facts["us-gaap"]!)) {
      for (const pts of Object.values((concept as { units: Record<string, { form: string }[]> }).units)) for (const p of pts) if (p.form === "10-K") p.form = "20-F";
    }
    const out = await applyKeylessFallbacks(inputs({ edgar: { ...inputs().edgar, registrant: { ...inputs().edgar.registrant!, stateOfIncorporation: "L3", forms: ["20-F", "6-K"] }, companyFacts: { ok: true, value: { data: facts, asOf: "2025-09-27", source: "edgar", endpoint: "companyfacts", fetchedAt: NOW.toISOString() } } } }));
    expect(out.members.profile.ok && out.members.profile.value.data.rows[0]).toMatchObject({ isAdr: true, country: null });
  });
});
```

The `appleLike()` helper must be copied into this test file (tests do not import from each other in this repo); keep the copy identical.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts tests/keyless.test.ts`
Expected: FAIL — cannot resolve `@/pipeline/keyless`.

- [ ] **Step 3: Add `registrant` to `EdgarBundle`**

In `src/pipeline/types.ts`, define `EdgarRegistrant` (above) and add `registrant: EdgarRegistrant | null;` to `EdgarBundle` with the comment: "Plain object, deliberately not a FetchResult: the producer registry discovers FetchResult members and the audit fixture pins their gaps." Then in `src/pipeline/dataBundle.ts` `buildEdgarBundle`: set `registrant: null` on the CIK-failure return, and when `sub.ok`, build it from `sub.value.data` (`name`, `cik10` from `cikRes.value.data.cik10`, `sic`, `sicDescription`, `exchanges.filter(Boolean)`, `tickers`, `fiscalYearEnd`, `stateOfIncorporation`, `forms` = distinct `recentFilings.map(f => f.form)`), else `null`. Run `npx tsc --noEmit` and fix every place that constructs an `EdgarBundle` literal (grep `xbrlSummary:` in `src/` and `tests/` — test fixtures that build bundles with `as unknown as DataBundle` need no change; typed literals need `registrant: null`).

- [ ] **Step 4: Write the implementation**

Implement `src/pipeline/keyless.ts` per the rules above. Key helpers to write (all pure, exported for tests where marked):

```ts
export function needsFallback<T>(r: FetchResult<FmpPayload<T>>): boolean { return !r.ok || r.value.data.rows.length === 0; }
function fmpReason<T>(r: FetchResult<FmpPayload<T>>): string { return r.ok ? "returned no rows" : r.gap.reason; }
function sourced<T>(rows: T[], source: DataSource, endpoint: string, asOf: string, fetchedAt: string): FetchResult<FmpPayload<T>>;
export function lastCloseOnOrBefore(rowsDesc: FmpEodBarRow[], date: string): number | null;
export function sharesOnOrBefore(points: { value: number; asOf: string }[], date: string): number | null; // latest asOf ≤ date, else earliest
export function isUsJurisdiction(code: string | null): boolean; // 50 states + DC + PR/VI/GU/AS/MP
```

Yahoo calls run concurrently (`Promise.all` over symbol/SPY/sectorEtf history + quote) but only for members that need a fallback. Never let a rejected promise escape: wrap each in `settle`-style try/catch → gap.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run --config vitest.config.ts tests/keyless.test.ts tests/dataBundle.producerRegistry.test.ts tests/audit.fixtureComparison.test.ts && npx tsc --noEmit`
Expected: PASS; the fixture comparison unchanged (no new FetchResult member).

- [ ] **Step 6: Coverage and commit**

Run: `npx vitest run --config vitest.risk.config.ts --coverage tests/keyless.test.ts 2>&1 | grep -E "keyless.ts|ERROR"` — ≥ 85 / 75 / 85 / 85; add branch tests as needed (missing dei shares, missing quote, empty balance rows).

```bash
git add src/pipeline/keyless.ts src/pipeline/types.ts src/pipeline/dataBundle.ts vitest.shared.ts tests/keyless.test.ts
git commit -m "feat(pipeline): keyless fallbacks for profile, quote, statements, prices and derived capitalization"
```

---

### Task 6: Bundle wiring, XBRL identity pass, unknown-symbol page

**Files:**
- Modify: `src/pipeline/dataBundle.ts` (options, `makeYahooCachedFetch`, await EDGAR before fallbacks, apply outcome, register gaps, progress line)
- Modify: `src/pipeline/stageA/validate.ts:517-600` (`checkFmpXbrlCross`)
- Modify: `src/app/company/[symbol]/page.tsx:96-99` (`isConfirmedUnknownProfile`)
- Test: `tests/dataBundle.keyless.test.ts`, `tests/stageA.validate.test.ts` (add one case), `tests/company.page.unsupported.test.ts` (add one case)

**Interfaces:**
- `BuildDataBundleOptions` gains `yahoo?: YahooClient` and `keyless?: boolean` (default `true`).
- `makeYahooCachedFetch(): CachedFetchFn` mirrors `makeFmpCachedFetch` with `provider: "yahoo"` and the same `isEmptyBody` guard replaced by `(value) => value === null`.

- [ ] **Step 1: Write the failing bundle test**

```ts
// tests/dataBundle.keyless.test.ts
import { describe, expect, it } from "vitest";
import { buildDataBundle } from "@/pipeline/dataBundle";
import { createEdgarClient, type EdgarTransport, type EdgarTransportResponse } from "@/providers/edgar";
import { createFmpClient } from "@/providers/fmp";
import { createYahooClient } from "@/providers/yahoo";
import { makeLimiter } from "@/providers/http";
import type { FinraConfig } from "@/providers/finra";
import type { FinnhubConfig } from "@/providers/finnhub";
import type { FredConfig } from "@/providers/fred";

const NOW = new Date("2026-09-01T00:00:00.000Z");

/** EDGAR transport serving company_tickers.json, submissions and companyfacts for AAPL; 404 otherwise. */
function edgarTransport(): EdgarTransport {
  return {
    fetchText(url: string): Promise<EdgarTransportResponse> {
      const ok = (body: unknown): EdgarTransportResponse => ({ status: 200, body: JSON.stringify(body), fetchedAt: NOW.toISOString(), fromCache: false, stale: false });
      if (url.includes("company_tickers.json")) return Promise.resolve(ok({ "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }));
      if (url.includes("submissions/CIK0000320193.json")) return Promise.resolve(ok({ cik: "320193", name: "Apple Inc.", sic: "3571", sicDescription: "ELECTRONIC COMPUTERS", fiscalYearEnd: "0927", stateOfIncorporation: "CA", tickers: ["AAPL"], exchanges: ["Nasdaq"], filings: { recent: { accessionNumber: ["0000320193-25-000079"], filingDate: ["2025-10-31"], reportDate: ["2025-09-27"], form: ["10-K"], primaryDocument: ["aapl-20250927.htm"] }, files: [] } }));
      if (url.includes("companyfacts/CIK0000320193.json")) return Promise.resolve(ok(appleFacts()));
      return Promise.resolve({ status: 404, body: "not found", fetchedAt: NOW.toISOString(), fromCache: false, stale: false });
    },
  };
}
// appleFacts(): the same appleLike() companyfacts helper as tests/edgar.statements.test.ts (copy verbatim).
// fakeYahoo(): the same helper as tests/keyless.test.ts (copy verbatim).

function noNetworkConfigs(): { fred: FredConfig; finnhub: FinnhubConfig; finra: FinraConfig } {
  const unavailable = () => Promise.resolve(new Response("not available", { status: 404 }));
  return {
    fred: { fetchImpl: unavailable, retryDelaysMs: [], minRequestIntervalMs: 0 },
    finnhub: { apiKey: "TEST-KEY", fetchImpl: unavailable, retryDelaysMs: [] },
    finra: { fetchImpl: unavailable, retryDelaysMs: [], minRequestIntervalMs: 0 },
  };
}

describe("buildDataBundle without an FMP key", () => {
  it("serves profile, quote, statements, prices and derived capitalization from EDGAR and Yahoo", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now: () => NOW,
      fmp: createFmpClient({ apiKey: "", fixturesDir: "fixtures/fmp" }),
      edgar: createEdgarClient({ transport: edgarTransport() }),
      yahoo: fakeYahoo(),
      ...noNetworkConfigs(),
    });
    expect(bundle.profile.ok && bundle.profile.value.source).toBe("computed");
    expect(bundle.profile.ok && bundle.profile.value.data.rows[0]).toMatchObject({ companyName: "Apple Inc.", sector: "Technology" });
    expect(bundle.quote.ok && bundle.quote.value.source).toBe("yahoo");
    expect(bundle.statements.incomeAnnual.ok && bundle.statements.incomeAnnual.value.source).toBe("edgar");
    expect(bundle.statements.incomeAnnual.ok && bundle.statements.incomeAnnual.value.data.rows[0]!.revenue).toBe(400);
    expect(bundle.eodPrices.ok && bundle.eodPrices.value.source).toBe("yahoo");
    expect(bundle.benchmarkPrices.spy.ok).toBe(true);
    expect(bundle.benchmarkPrices.sectorEtfSymbol).toBe("XLK");
    expect(bundle.benchmarkPrices.sectorEtf.ok).toBe(true);
    expect(bundle.enterpriseValues.ok && bundle.enterpriseValues.value.source).toBe("computed");
    expect(bundle.edgar.registrant?.sic).toBe("3571");
    expect(bundle.sourceManifest["statements.incomeAnnual"]?.provider).toBe("edgar");
    expect(bundle.sourceManifest["eodPrices"]?.provider).toBe("yahoo");
    const keyless = bundle.gaps.filter((g) => g.field.startsWith("keyless."));
    expect(keyless.length).toBeGreaterThanOrEqual(10);
    expect(keyless.every((g) => g.severity === "info" && g.expected === true)).toBe(true);
    // The original "no API key + no fixture" gaps for replaced members are gone.
    expect(bundle.gaps.some((g) => g.field === "fmp.incomeStatement(AAPL,annual)")).toBe(false);
  });

  it("respects keyless: false", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now: () => NOW,
      fmp: createFmpClient({ apiKey: "", fixturesDir: "fixtures/fmp" }),
      edgar: createEdgarClient({ transport: edgarTransport() }),
      yahoo: fakeYahoo(),
      keyless: false,
      ...noNetworkConfigs(),
    });
    expect(bundle.statements.incomeAnnual.ok).toBe(false);
    expect(bundle.gaps.some((g) => g.field.startsWith("keyless."))).toBe(false);
  });

  it("serves a refused sector ETF from Yahoo on a keyed plan while keeping FMP statements", async () => {
    // FMP fake: statements + profile + AAPL prices OK, XLK refused with the plan's 402 text.
    const fmpFetch: typeof fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const endpoint = /\/stable\/(.+)$/.exec(url.pathname)![1]!;
      const symbol = url.searchParams.get("symbol");
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (endpoint === "profile") return json([{ symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology", industry: "Consumer Electronics", price: 300, marketCap: 4e12, beta: 1.1, currency: "USD", country: "US", cik: "0000320193", isEtf: false, isFund: false, isAdr: false }]);
      if (endpoint === "quote") return json([{ symbol: "AAPL", price: 300, marketCap: 4e12, timestamp: 1756684800 }]);
      if (endpoint === "income-statement") return json([{ symbol: "AAPL", date: "2025-09-27", revenue: 400e9, reportedCurrency: "USD" }]);
      if (endpoint === "historical-price-eod/full" && symbol === "XLK") return new Response("Premium Query Parameter: 'Special Endpoint : This value set for 'symbol' is not available under your current subscription", { status: 402 });
      if (endpoint === "historical-price-eod/full") return json([{ symbol, date: "2026-09-01", open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
      return json({ "Error Message": "not in this test" }, 401);
    }) as unknown as typeof fetch;
    const bundle = await buildDataBundle("AAPL", {
      now: () => NOW,
      eodYears: 0,
      fmp: createFmpClient({ apiKey: "KEYED", fetchImpl: fmpFetch, limiter: makeLimiter(1e6, 1e6), now: () => NOW }),
      edgar: createEdgarClient({ transport: edgarTransport() }),
      yahoo: fakeYahoo(),
      ...noNetworkConfigs(),
    });
    expect(bundle.statements.incomeAnnual.ok && bundle.statements.incomeAnnual.value.source).toBe("fmp");
    expect(bundle.benchmarkPrices.sectorEtf.ok && bundle.benchmarkPrices.sectorEtf.value.source).toBe("yahoo");
    const g = bundle.gaps.find((x) => x.field === "keyless.sectorEtf");
    expect(g?.expected).toBeUndefined();
    expect(g?.reason).toMatch(/HTTP 402/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts tests/dataBundle.keyless.test.ts`
Expected: FAIL — `yahoo`/`keyless` options unknown; members stay gaps.

- [ ] **Step 3: Wire the bundle**

In `src/pipeline/dataBundle.ts`:

1. Import `createYahooClient, type YahooClient` from `@/providers/yahoo` and `applyKeylessFallbacks` from `@/pipeline/keyless`.
2. Add `makeYahooCachedFetch()` next to `makeFmpCachedFetch()` (provider `"yahoo"`, `isEmptyBody: (value) => value === null`).
3. Add to `BuildDataBundleOptions`: `yahoo?: YahooClient;` and `keyless?: boolean;` (doc: "Fill core members FMP cannot serve from EDGAR + Yahoo once a CIK resolves. Default true.").
4. After `const fmp = …`: `const yahoo = opts.yahoo ?? createYahooClient({ cachedFetch: makeYahooCachedFetch(), signal: opts.signal, userAgent: cfg.edgarContact ? \`Mozilla/5.0 Thesis-research/1.0 (${cfg.edgarContact})\` : undefined });` — check `getConfig()` for the actual contact field name (grep `edgarContact` in `src/config/env.ts`).
5. Move `const edgarBundle = await pEdgar;` (find where `pEdgar` is awaited) to BEFORE the statement/quote/price members are assembled, then, when `opts.keyless !== false`:

```ts
  const keyless = await applyKeylessFallbacks({
    symbol: sym,
    today,
    eodFrom,
    sectorEtfSymbol,
    fmp: {
      profile, quote,
      incomeAnnual: statements.incomeAnnual, incomeQuarterly: statements.incomeQuarterly,
      balanceAnnual: statements.balanceAnnual, balanceQuarterly: statements.balanceQuarterly,
      cashflowAnnual: statements.cashflowAnnual, cashflowQuarterly: statements.cashflowQuarterly,
      eodPrices, spy: spyPrices, sectorEtf: sectorEtfPrices, enterpriseValues, marketCapHistory, sharesFloat,
    },
    fmpKeyless: fmp.fixtureMode,
    edgar: { cik: edgarBundle.cik, registrant: edgarBundle.registrant, companyFacts: edgarBundle.companyFacts },
    yahoo,
    annualPeriods: ANNUAL_PERIODS,
    quarterlyPeriods: QUARTERLY_PERIODS,
    now,
    resolveSectorEtf,
  });
```

   then reassign each member from `keyless.members` (statements via `sortRows`), set `benchmarkPrices.sectorEtfSymbol = keyless.sectorEtfSymbol ?? sectorEtfSymbol`, push `keyless.gaps` into the manifest merge (they are `ManifestEntry`s; add them to the `mergeManifest` call alongside the plan-limit entries), and log `progress(\`keyless: replaced ${keyless.replaced.join(", ") || "nothing"}\`)`. Note `profile` is read early for `sectorName`/`profileCik`; when the profile is replaced, recompute `sectorName`, `gicsSector` is used for FRED sector routing which already ran — leave FRED as is (macro sector series stay unavailable keylessly for that run; record a note `"keyless profile resolved after macro routing; sector FRED overlay not fetched"` only when `gicsSector` was null and the keyless sector maps to one).
6. Because the FMP profile is fetched first for `profileCik`, keep that; EDGAR's own ticker lookup is the primary keyless path anyway.

- [ ] **Step 4: XBRL identity pass in `validate.ts`**

In `checkFmpXbrlCross`, before `crossCheckRow(...)` for each of FY and Q: if the statement result is ok and `.value.source === "edgar"`, push

```ts
c.checks.push({ id: "xbrlCrossCheck.FY", name: "FMP↔XBRL cross-check (latest FY)", status: "passed", detail: "statements are XBRL-sourced (EDGAR companyfacts); the cross-check is an identity" });
```

(and the `Q` twin) and skip `crossCheckRow`. Add to `tests/stageA.validate.test.ts` a case that builds a bundle whose `statements.incomeAnnual.value.source === "edgar"` and asserts the check is `passed`, no `validation.xbrlCrossCheck*` gap is emitted, and `buildDataCompleteness(gaps).xbrl === "checked"` — find the existing helper the file uses to build a `ValidatableBundle` and reuse it.

- [ ] **Step 5: Unknown symbol on the company page**

In `src/app/company/[symbol]/page.tsx` replace `isConfirmedUnknownProfile` with:

```ts
function isConfirmedUnknownProfile(bundle: DataBundle): boolean {
  if (bundle.profile.ok) return bundle.profile.value.data.rows.length === 0;
  if (bundle.profile.gap.reason === FMP_EMPTY_ARRAY_REASON) return true;
  // Keyless: FMP had nothing (no key, no fixture) AND EDGAR's ticker table has no such registrant.
  const edgarMiss = !bundle.edgar.cik.ok && /not in SEC company_tickers\.json/.test(bundle.edgar.cik.gap.reason);
  return edgarMiss && /no API key/.test(bundle.profile.gap.reason);
}
```

Add a case to `tests/company.page.unsupported.test.ts` (follow its existing bundle-stubbing pattern) asserting that a keyless bundle with that EDGAR miss renders the not-found path, and that a keyless bundle with an EDGAR 403 cooldown does NOT (it renders the disclosed-gap page).

- [ ] **Step 6: Run the suite and typecheck**

Run: `npm run lint && npx tsc --noEmit && npx vitest run --config vitest.config.ts`
Expected: all pass, including `tests/audit.fixtureComparison.test.ts` (DEMO resolves no CIK → no keyless gaps → projection byte-identical) and `tests/dataBundle.producerRegistry.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/dataBundle.ts src/pipeline/stageA/validate.ts "src/app/company/[symbol]/page.tsx" tests/dataBundle.keyless.test.ts tests/stageA.validate.test.ts tests/company.page.unsupported.test.ts
git commit -m "feat(bundle): fill members FMP cannot serve from EDGAR and Yahoo; XBRL identity pass"
```

---

### Task 7: Documentation, allowlist, live verification

**Files:**
- Modify: `README.md` (Quick start, Configuration table row for `FMP_API_KEY`, new "Without an FMP subscription" section, Limitations)
- Modify: `.env.example` (FMP key comment)
- Modify: `tests/repository.release.test.ts` (`ALLOWED_MARKDOWN` += the spec and this plan)
- Modify: `docs/superpowers/specs/2026-09-02-keyless-data-path-design.md` (status line: implemented, commits)

- [ ] **Step 1: Allowlist the two documents and run the release test**

Add `"docs/superpowers/plans/2026-09-02-keyless-data-path.md"` and `"docs/superpowers/specs/2026-09-02-keyless-data-path-design.md"` to `ALLOWED_MARKDOWN`. Run `npx vitest run --config vitest.config.ts tests/repository.release.test.ts` — PASS.

- [ ] **Step 2: README**

Replace the `FMP_API_KEY` row's "Behavior when absent" with: "Real tickers are served from SEC EDGAR and Yahoo (see *Without an FMP subscription*); `DEMO`/`DBNK` use the fictional fixtures". Add after the Configuration table:

```markdown
### Without an FMP subscription

Set only `EDGAR_CONTACT`. For any US-listed SEC registrant the pipeline then
serves the profile (name, SIC-derived sector and industry, exchange, listing
date), the quote, ten fiscal years and twenty-four quarters of income
statement, balance sheet and cash flow, five years of daily prices for the
symbol, SPY and its sector ETF, quarterly enterprise values, daily market
capitalization and the public float from two keyless sources:

| Member | Source | Provenance |
| --- | --- | --- |
| Statements, shares outstanding, public float | SEC EDGAR XBRL company facts | `edgar` |
| Registrant name, SIC, exchange, fiscal year end | SEC EDGAR submissions | `edgar` |
| Daily prices, quote, listing date | Yahoo Finance chart endpoint | `yahoo` |
| Beta, market cap, enterprise values | computed from the above | `computed` |

Quarterly cash-flow figures and any quarter a filer reports only year-to-date
are derived by subtraction and marked `derivation` on the row. Analyst
estimates, price targets, peers, insider and institutional ownership, news,
transcripts, executive compensation and segment revenue have no keyless
source and stay disclosed gaps. Every replaced member is recorded in the
missing-data manifest as `keyless.<member>` with the reason FMP could not
serve it.

The Yahoo endpoint is unofficial and best-effort: requests carry a
User-Agent, are rate-limited and cached, and any failure becomes a disclosed
gap rather than an error. The same fallback also fills members an entry-tier
FMP plan refuses, such as sector-ETF price history.
```

Update Quick start to say a key is optional and `EDGAR_CONTACT` is what keyless mode needs. In Limitations, add: "Keyless statements are derived from XBRL tags; a filer that uses extension tags for a line item yields `null` for that field, never a guess."

- [ ] **Step 3: `.env.example`**

Extend the FMP comment: "Without a key, real tickers are served from SEC EDGAR (statements, shares) and Yahoo's chart endpoint (prices); set EDGAR_CONTACT below. DEMO/DBNK stay fixtures."

- [ ] **Step 4: Live verification (isolated data directory)**

```bash
npm run build
FMP_API_KEY="" ANTHROPIC_API_KEY="" THESIS_DATA_DIR=<scratch> EDGAR_CONTACT="<name email>" npx next start -H 127.0.0.1 -p 3002
curl -s -X POST http://127.0.0.1:3002/api/report -H "Origin: http://127.0.0.1:3002" -H "Content-Type: application/json" -d '{"symbol":"AAPL"}'
# poll /api/report/<jobId> until done, then inspect the persisted report:
# statements from edgar, prices from yahoo, composite score present, DCF present, manifest has keyless.* info entries.
# Repeat for JPM (bank route: revenue via the bank chain, ROTE scored) and for a fictional ticker (404 not-found page).
```

Record the observed gap counts and the grade strip in the spec's status section.

- [ ] **Step 5: Final gate and commit**

Run: `npm run verify` (all nine gates). Then:

```bash
git add README.md .env.example tests/repository.release.test.ts docs/superpowers/specs/2026-09-02-keyless-data-path-design.md docs/superpowers/plans/2026-09-02-keyless-data-path.md
git commit -m "docs: keyless operation without an FMP subscription"
```

---

## Self-review

- Spec coverage: sources table → Tasks 3, 4, 5; per-member fallback → Task 5/6; components 1–5 → Tasks 1–5; bundle wiring, validate, page → Task 6; configuration/docs and live verification → Task 7; testing list → each task's test file plus Task 6's validate/page cases; coverage manifest → Tasks 3, 4, 5.
- Type consistency: `applyKeylessFallbacks(inputs: KeylessInputs): Promise<KeylessOutcome>` with `resolveSectorEtf` on the inputs (Task 5 and Task 6 agree); `EdgarRegistrant` defined in Task 5 and consumed in Task 6; `YahooClient.dailyHistory/quote/meta` as defined in Task 3 and consumed in Task 5.
- Placeholders: the Yahoo implementation shows two fetch paths for clarity and instructs collapsing to one; every other step carries the concrete code or an exact rule.
