/**
 * Manual normalized filing excerpts, not raw SEC companyfacts or tag-parser coverage.
 * Expected values are independent literals. No DEMO bundle or live data is used.
 * Source units, table positions, accounting bases and reference arithmetic are
 * documented in the fixture; no ignored-only tool is needed to reproduce it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeGrowth } from "@/pipeline/stageB/growth";
import { deriveFcf } from "@/pipeline/stageB/financialValues";
import { normalizeQuarterRows } from "@/pipeline/stageB/quarterWindows";
import { computeDupont } from "@/pipeline/stageB/returns";
import { routeCompany, metricPolicy, type RoutingProfile } from "@/pipeline/stageB/sectorRouting";

interface Row {
  date: string;
  revenue: number;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number;
  epsDiluted: number;
  totalAssets: number;
  totalStockholdersEquity: number;
  operatingCashFlow: number | null;
  capitalExpenditure: number | null;
}
interface Reference {
  symbol: string;
  category: string;
  currency: string;
  multiplier: number;
  source: string;
  profile: Omit<RoutingProfile, "isEtf" | "isFund" | "ipoDate">;
  expectedRoute: { base: string; overlays: string[]; suppress: string[]; mustNotSuppress: string[]; reitSubmap?: string };
  rows: Row[];
  expected: {
    revenueYoyPct: number;
    epsYoyPct: number | null;
    fcfYoyPct: number | null;
    periods: { date: string; revenueBaseAmount: number; grossMarginPct: number | null; operatingMarginPct: number | null; netMarginPct: number; fcf: number | null }[];
    dupontLatest: { netMargin: number; assetTurnover: number; leverage: number; roePct: number };
  };
}
const { cohort } = JSON.parse(readFileSync(new URL("../fixtures/financial/annual-reference-cohort.json", import.meta.url), "utf8")) as { cohort: Reference[] };

// A documented manual normalization boundary: source statement units become
// base currency amounts; EPS keeps its source currency/share basis.
// This is NOT a raw-provider/SEC parser or an FX/ADR conversion.
function normalizedRows(ref: Reference): Row[] {
  const amount = (n: number | null) => n === null ? null : n * ref.multiplier;
  return ref.rows.map(row => ({
    date: row.date,
    revenue: row.revenue * ref.multiplier,
    grossProfit: amount(row.grossProfit),
    operatingIncome: amount(row.operatingIncome),
    netIncome: row.netIncome * ref.multiplier,
    epsDiluted: row.epsDiluted,
    totalAssets: row.totalAssets * ref.multiplier,
    totalStockholdersEquity: row.totalStockholdersEquity * ref.multiplier,
    operatingCashFlow: amount(row.operatingCashFlow),
    capitalExpenditure: amount(row.capitalExpenditure),
  }));
}
function match(actual: number | null | undefined, expected: number | null): void {
  if (expected === null) expect(actual).toBeNull();
  else expect(actual).toBeCloseTo(expected, 8);
}

describe.each(cohort)("$symbol ($category) independent filing references", ref => {
  it.each(ref.expected.periods)("$date margins and FCF match independent literals", period => {
    const rows = normalizedRows(ref);
    const growth = computeGrowth(rows, rows, { period: "annual" });
    const byDate = (series: { date: string; pct: number | null }[]) => series.find(point => point.date === period.date)?.pct;
    match(byDate(growth.margins.gross.series), period.grossMarginPct);
    match(byDate(growth.margins.operating.series), period.operatingMarginPct);
    match(byDate(growth.margins.net.series), period.netMarginPct);
    const row = rows.find(r => r.date === period.date)!;
    match(deriveFcf(row.operatingCashFlow, row.capitalExpenditure), period.fcf === null ? null : period.fcf * ref.multiplier);
  });

  it("normalizes annual order and matches growth without inventing a three-year benchmark", () => {
    const rows = normalizedRows(ref);
    const normalization = normalizeQuarterRows(rows);
    expect(normalization.rejected).toEqual([]);
    expect(normalization.rows.map(r => r.date)).toEqual(ref.rows.map(r => r.date).toReversed());
    const growth = computeGrowth(rows, rows, { period: "annual" });
    const yoy = growth.revenueCagrs.find(point => point.windowYears === 1);
    expect(yoy?.startValue).toBe(ref.expected.periods[0].revenueBaseAmount);
    expect(yoy?.endValue).toBe(ref.expected.periods[1].revenueBaseAmount);
    match(growth.revenueCagrs.find(point => point.windowYears === 1)?.cagrPct, ref.expected.revenueYoyPct);
    match(growth.epsDilutedCagrs.find(point => point.windowYears === 1)?.cagrPct, ref.expected.epsYoyPct);
    match(growth.fcfCagrs.find(point => point.windowYears === 1)?.cagrPct, ref.expected.fcfYoyPct);
    expect(growth.revenueAcceleration.threeYearCagrPct).toBeNull();
    expect(growth.revenueAcceleration.deltaPctPts).toBeNull();
  });

  it("matches independently calculated fiscal-endpoint-average DuPont ratios", () => {
    const rows = normalizedRows(ref);
    const latest = computeDupont(rows, rows).latest;
    expect(latest?.date).toBe(ref.rows.at(-1)?.date);
    for (const key of ["netMargin", "assetTurnover", "leverage", "roePct"] as const) {
      match(latest?.[key], ref.expected.dupontLatest[key]);
    }
    // The older reference has no opening balance. Do not imply it is an average-
    // balance issuer-published ROE (bank common ROE differs too).
    const oldest = computeDupont(rows, rows).series[0];
    expect(oldest.notes.join(" ")).toContain("single-period value used");
  });

  it("uses fresh issuer inputs for sector/overlay suppression", () => {
    const latest = normalizedRows(ref).at(-1)!;
    const route = routeCompany({ ...ref.profile, isEtf: false, isFund: false, ipoDate: null }, {
      incomeTtm: null,
      incomeAnnual: { date: latest.date, revenue: latest.revenue, netIncome: latest.netIncome, reportedCurrency: ref.currency },
      cashflowTtm: null,
      cashflowAnnual: { date: latest.date, operatingCashFlow: latest.operatingCashFlow },
      availableQuarters: null,
    }, { today: "2026-10-04" });
    expect(route.base).toBe(ref.expectedRoute.base);
    expect(route.overlays).toEqual(ref.expectedRoute.overlays);
    if (ref.expectedRoute.reitSubmap) expect(route.reitSubmap).toBe(ref.expectedRoute.reitSubmap);
    const policy = metricPolicy(route);
    if (ref.expectedRoute.suppress.length > 0) expect(policy.suppress).toEqual(expect.arrayContaining(ref.expectedRoute.suppress));
    // Positive eligibility checks are load-bearing on general/ADR routes:
    // an empty suppress subset alone would accept every policy regression.
    for (const metric of ref.expectedRoute.mustNotSuppress) expect(policy.suppress).not.toContain(metric);
  });
});
