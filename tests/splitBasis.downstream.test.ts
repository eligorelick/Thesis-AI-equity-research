/**
 * Share-basis uncertainty reaches every dependent calculation.
 *
 * A split the report knows of (the vendor lists a 4-for-1 first traded
 * 2026-06-15) postdates every statement period in the fixture, and no filed
 * count is available to show the vendor's rows were restated for it. The
 * keyless guard (`guardVendorShareFields`) therefore withholds each row's EPS
 * and share counts. This suite runs the REAL Stage B and payload assembly on
 * the guarded bundle and checks that nothing downstream reconstructs a
 * share-based figure from another path — price × shares for a REIT, price /
 * EPS, a fallback share count — while the figures whose inputs are unaffected
 * (revenue, margins, free cash flow) come out exactly as in the control.
 */
import { describe, expect, it } from "vitest";
import { discoverStockSplits } from "@/edgar/splits";
import { runStageB } from "@/pipeline/compute";
import { guardVendorShareFields } from "@/pipeline/keyless";
import type { ValidationReport } from "@/pipeline/stageA/validate";
import { assembleContextPayload, serializePayloadForPrompt } from "@/pipeline/stageC/payload";
import type { DataBundle } from "@/pipeline/types";
import type { FmpPayload, FmpRawRow } from "@/providers/fmp";
import type { FetchResult } from "@/types/core";

import { completeCurrencyBundle } from "./helpers/currencyBundle";

const VALIDATION = { checks: [], flags: [], gaps: [] } as unknown as ValidationReport;

/** A 4-for-1 the vendor lists; companyfacts carries nothing to test the vendor's rows against. */
const SPLITS = discoverStockSplits(
  { cik: 1, entityName: "Test General Co", facts: { "us-gaap": {}, dei: {} } },
  {
    asOf: "2026-09-30",
    vendor: {
      status: "retrieved",
      source: "test:vendor",
      events: [{ session: "2026-06-15", ratio: 4, numerator: 4, denominator: 1 }],
      coverage: [{ from: "1995-01-01", to: "2026-09-30" }],
    },
  },
);

function guardMember<T extends FmpRawRow>(member: FetchResult<FmpPayload<T>>): FetchResult<FmpPayload<T>> {
  if (!member.ok) return member;
  const guarded = guardVendorShareFields(member.value.data.rows, [], SPLITS, "2026-09-30");
  return { ok: true, value: { ...member.value, data: { ...member.value.data, rows: guarded.rows } } };
}

/** The bundle as the keyless layer leaves it when the rows' split basis cannot be established. */
function guarded(bundle: DataBundle, opts: { dropMarketCaps?: boolean } = {}): DataBundle {
  const dropCap = <T extends FmpRawRow>(member: FetchResult<FmpPayload<T>>): FetchResult<FmpPayload<T>> =>
    !member.ok
      ? member
      : {
          ok: true,
          value: {
            ...member.value,
            data: { ...member.value.data, rows: member.value.data.rows.map((r) => ({ ...r, marketCap: undefined })) },
          },
        };
  return {
    ...bundle,
    statements: {
      ...bundle.statements,
      incomeAnnual: guardMember(bundle.statements.incomeAnnual),
      incomeQuarterly: guardMember(bundle.statements.incomeQuarterly),
    },
    ...(opts.dropMarketCaps === true ? { quote: dropCap(bundle.quote), profile: dropCap(bundle.profile) } : {}),
  };
}

type Anyish = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function multiple(c: Anyish, key: string): number | null {
  return (c.valuation.multiples.multiples as { key: string; current: number | null }[]).find((m) => m.key === key)?.current ?? null;
}

describe("share-basis uncertainty in Stage B, the grades and the AI payload", () => {
  const control = completeCurrencyBundle({ debt: 300 });
  const c0 = runStageB(control) as unknown as Anyish;
  const c1 = runStageB(guarded(control)) as unknown as Anyish;

  it("the guard withholds the share fields of every pre-split vendor row and nothing else", () => {
    const g = guarded(control);
    const before = control.statements.incomeAnnual.ok ? control.statements.incomeAnnual.value.data.rows : [];
    const after = g.statements.incomeAnnual.ok ? g.statements.incomeAnnual.value.data.rows : [];
    expect(before.some((r) => typeof r.epsDiluted === "number")).toBe(true);
    for (const r of after) {
      expect(r.epsDiluted).toBeUndefined();
      expect(r.weightedAverageShsOutDil).toBeUndefined();
      expect(r.weightedAverageShsOut).toBeUndefined();
    }
    expect(after.map((r) => r.revenue)).toEqual(before.map((r) => r.revenue));
  });

  it("control: the share-based figures exist", () => {
    expect(c0.growth.epsDilutedCagrs.some((x: Anyish) => typeof x.cagrPct === "number")).toBe(true);
    expect(typeof c0.valuation.dcf.perShare).toBe("number");
    expect(typeof c0.capital.shareCount.trendPct).toBe("number");
    expect(multiple(c0, "peTtm")).toBeCloseTo(55.5556, 3);
  });

  it("EPS growth, DCF per share, reverse DCF, share-count trend and dilution are withheld, not rebuilt", () => {
    expect(c1.growth.epsDilutedCagrs.every((x: Anyish) => x.cagrPct === null)).toBe(true);
    expect(c1.valuation.dcf.perShare ?? null).toBeNull();
    expect((c1.valuation.sensitivity?.perShare ?? []).flat().every((v: number | null) => v === null)).toBe(true);
    expect(c1.capital.shareCount?.trendPct ?? null).toBeNull();
    expect(c1.capital.dilution?.dilutedShares ?? null).toBeNull();
    expect(c1.fairValue?.perShare ?? null).toBeNull();
  });

  it("P/E never divides the price by an unverified EPS", () => {
    // With EPS withheld, P/E can only be the vendor's own market cap over net
    // income (a vendor figure on its own basis; this fixture's two agree).
    // With the market caps withheld too (the keyless route), nothing stands in.
    const keyless = runStageB(guarded(control, { dropMarketCaps: true })) as unknown as Anyish;
    expect(multiple(keyless, "peTtm")).toBeNull();
    expect(multiple(keyless, "evToEbitda")).toBeNull();
    expect(multiple(keyless, "priceToFcf")).toBeNull();
  });

  it("the grades lose exactly the share-based signals", () => {
    const drivers = (c: Anyish, aspect: string): string[] =>
      (c.scores.aspects[aspect].drivers as { source: string; value: number | null }[])
        .filter((d) => d.value !== null)
        .map((d) => d.source.split(".").pop() ?? "");
    expect(drivers(c0, "fundamentals")).toContain("epsCagr");
    expect(drivers(c1, "fundamentals")).not.toContain("epsCagr");
    expect(drivers(c1, "valuation")).not.toContain("dcfUpside");
    expect(drivers(c1, "balanceSheet")).not.toContain("shareCountTrend");
  });

  it("preserves every calculation whose inputs are unaffected", () => {
    expect(c1.growth.revenueCagrs).toEqual(c0.growth.revenueCagrs);
    expect(c1.growth.margins).toEqual(c0.growth.margins);
    expect(c1.capital.fcf).toEqual(c0.capital.fcf);
    expect(c1.capital.capexIntensity).toEqual(c0.capital.capexIntensity);
    expect(multiple(c1, "evToSales")).toBeCloseTo(multiple(c0, "evToSales")!, 9);
  });

  it("a REIT cannot rebuild its market cap as price × shares", () => {
    const reit = completeCurrencyBundle({ reit: true, debt: 300 });
    const r0 = runStageB(reit) as unknown as Anyish;
    const r1 = runStageB(guarded(reit, { dropMarketCaps: true })) as unknown as Anyish;
    expect(r0.valuation.reit.pToFfo).toBe(50);
    expect(r0.valuation.reit.ffoPerShare).toBe(2);
    expect(r1.valuation.reit.pToFfo).toBeNull();
    expect(r1.valuation.reit.pToAffo).toBeNull();
    expect(r1.valuation.reit.ffoPerShare).toBeNull();
    expect(r1.valuation.reit.affoPerShare).toBeNull();
  });

  it("the AI payload states no withheld EPS or share count and registers none", () => {
    const bundle = guarded(control, { dropMarketCaps: true });
    const payload = assembleContextPayload(bundle, runStageB(bundle), VALIDATION);
    const registry = payload.provenanceRegistry ?? [];
    const controlPayload = assembleContextPayload(control, runStageB(control), VALIDATION);
    const shareIds = (r: { id: string }[]) => r.filter((x) => /epsDiluted|weightedAverageShsOut|dcf\.perShare|marketCap/i.test(x.id)).map((x) => x.id);
    expect(shareIds(controlPayload.provenanceRegistry ?? []).length).toBeGreaterThan(0);
    expect(shareIds(registry)).toEqual([]);
    const text = serializePayloadForPrompt(payload);
    // Every value on the EPS, diluted-share and market-cap lines reads n/a.
    const values = text
      .split("\n")
      .filter((l) => /^- (diluted EPS|diluted shares|marketCap)/.test(l))
      .flatMap((l) => l.replace(/\s*\[[^\]]*\]\s*$/, "").split(/: |=| \| /).slice(1))
      .filter((v) => !/^\d{4}-\d{2}-\d{2}$/.test(v) && !/^\(/.test(v));
    expect(values.length).toBeGreaterThanOrEqual(21);
    expect(new Set(values.map((v) => v.trim()))).toEqual(new Set(["n/a"]));
  });
});
