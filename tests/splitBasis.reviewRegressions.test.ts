import { describe, expect, it } from "vitest";
import { discoverStockSplits, shareCountOnBasis } from "@/edgar/splits";
import { guardVendorShareFields } from "@/pipeline/keyless";
import { runStageB } from "@/pipeline/compute";
import { mergeSplitEvidence, type VendorSplitEvidence } from "@/providers/splitEvents";
import type { CompanyFacts } from "@/edgar/xbrl";
import type { FmpIncomeStatementRow, FmpPayload } from "@/providers/fmp";
import type { FetchResult } from "@/types/core";
import { completeCurrencyBundle } from "./helpers/currencyBundle";

const facts: CompanyFacts = { cik: 1, entityName: "Independent review", facts: { "us-gaap": {}, dei: {} } };
const asOf = "2026-09-30";
function evidence(source: string, events: { session: string; ratio: number }[]): VendorSplitEvidence {
  return { status: "retrieved", source,
    coverage: [{ from: "1995-01-01", to: asOf }],
    events: events.map(e => ({ ...e, numerator: e.ratio, denominator: 1 })) };
}
function resolve(parts: VendorSplitEvidence[]) {
  return discoverStockSplits(facts, { asOf, vendor: mergeSplitEvidence(parts) });
}
const split = resolve([evidence("full", [{session: "2026-06-15", ratio: 4}])]);

describe("Independent review of fa37016", () => {
  it("withholds when complete overlapping answers disagree on the date of their sole split by ten days", () => {
    // Each answer says there was ONE 4:1 split across the same full interval.
    // Their union does not establish TWO genuine splits.
    const result = resolve([
      evidence("daily", [{session: "2026-06-15", ratio: 4}]),
      evidence("full", [{session: "2026-06-25", ratio: 4}]),
    ]);
    const count = shareCountOnBasis(result, 10_000_000, "2026-02-01", null, asOf);
    expect(count).toHaveProperty("withheld");
    expect(result.events).toEqual([]);
    expect(result.notes.some(n => n.severity === "warn" && n.text.includes("daily") && n.text.includes("full"))).toBe(true);
  });

  it("control: identical answers apply one split", () => {
    const result = resolve([
      evidence("daily", [{session: "2026-06-15", ratio: 4}]),
      evidence("full", [{session: "2026-06-15", ratio: 4}]),
    ]);
    expect(shareCountOnBasis(result, 10_000_000, "2026-02-01", null, asOf)).toEqual({value:40_000_000});
  });

  it("control: one answer explicitly establishes two separate splits", () => {
    const result = resolve([evidence("full", [
      {session:"2021-07-20", ratio:2}, {session:"2026-06-15", ratio:3},
    ])]);
    expect(shareCountOnBasis(result, 10_000_000, "2021-02-01", null, asOf)).toEqual({value:60_000_000});
  });

  it("does not certify fourfold pre-split EPS solely because the error is below one cent", () => {
    const result = guardVendorShareFields(
      [{date:"2025-12-31",epsDiluted:0.01,weightedAverageShsOutDil:40_000_000}],
      [{date:"2025-12-31",epsDiluted:0.0025,weightedAverageShsOutDil:40_000_000}],
      split, asOf,
    );
    expect(result.rows[0]?.weightedAverageShsOutDil).toBe(40_000_000);
    expect(result.rows[0]?.epsDiluted).toBeUndefined();
  });

  it("control: ordinary rounding does not remove accurately adjusted EPS", () => {
    const result=guardVendorShareFields([{date:"2025-12-31",epsDiluted:2.5}], [{date:"2025-12-31",epsDiluted:2.4975}], split,asOf);
    expect(result.withheld).toEqual([]);
    expect(result.rows[0]?.epsDiluted).toBe(2.5);
  });

  it("full Stage B does not use the tiny pre-split EPS to divide P/E by four", () => {
    const control = completeCurrencyBundle({debt:300});
    type Member = FetchResult<FmpPayload<FmpIncomeStatementRow>>;
    const filedMember = (m:Member, eps:number):Member => !m.ok ? m : ({ok:true,value:{...m.value,data:{...m.value.data,rows:m.value.data.rows.map(r=>({...r,epsDiluted:eps,netIncome:eps*100_000_000}))}}});
    control.statements.incomeAnnual=filedMember(control.statements.incomeAnnual,0.01);
    control.statements.incomeQuarterly=filedMember(control.statements.incomeQuarterly,0.0025);
    const pe = (bundle:typeof control) => (runStageB(bundle) as unknown as {valuation:{multiples:{multiples:{key:string;current:number|null}[]}}}).valuation.multiples.multiples.find(m=>m.key==="peTtm")!.current;
    // Four quarters * 0.0025 = 0.01, and 100 / 0.01 = 10,000.
    expect(pe(control)).toBeCloseTo(10_000,6);
    const vendorMember=(m:Member):Member=>{
      if(!m.ok)return m;
      const vendor=m.value.data.rows.map(r=>({...r,epsDiluted:(r.epsDiluted as number)*4}));
      const guarded=guardVendorShareFields(vendor,m.value.data.rows,split,asOf);
      return {ok:true,value:{...m.value,data:{...m.value.data,rows:guarded.rows}}};
    };
    const vendor={...control,statements:{...control.statements,incomeAnnual:vendorMember(control.statements.incomeAnnual),incomeQuarterly:vendorMember(control.statements.incomeQuarterly)}};
    const actual=pe(vendor);
    expect(actual).toBeCloseTo(10_000,6);
  });

  it("retains an empty covering answer's contradiction through nested merges", () => {
    const present = evidence("daily", [{session:"2026-06-15", ratio:4}]);
    const nested = mergeSplitEvidence([mergeSplitEvidence([present, evidence("full", [])]), present]);
    const result = resolve([nested]);
    expect(shareCountOnBasis(result, 10_000_000, "2026-02-01", null, asOf)).toHaveProperty("withheld");
    expect(result.events).toEqual([]);
    // An already post-split filing does not cross the disputed event.
    expect(shareCountOnBasis(result, 40_000_000, "2026-08-01", null, asOf)).toEqual({value:40_000_000});
  });

  it("does not treat a request with no coverage of the event as a contradiction", () => {
    const result = resolve([
      evidence("full", [{session:"2026-06-15", ratio:4}]),
      {status:"retrieved", source:"recent", events:[], coverage:[{from:"2026-07-01",to:asOf}]},
      {status:"unavailable", source:"failed", reason:"not retrieved"},
    ]);
    expect(shareCountOnBasis(result, 10_000_000, "2026-02-01", null, asOf)).toEqual({value:40_000_000});
  });

  it("withholds a count measured before a disputed split even when filed afterward", () => {
    const result = resolve([
      evidence("daily", [{session:"2026-06-15",ratio:4}]), evidence("full",[]),
    ]);
    expect(shareCountOnBasis(result, 10_000_000, "2026-08-01", "2026-06-01", asOf)).toHaveProperty("withheld");
    // A measurement and filing both after the dispute remain on the current basis.
    expect(shareCountOnBasis(result, 40_000_000, "2026-08-01", "2026-07-20", asOf)).toEqual({value:40_000_000});
  });

  it("keeps separate splits when overlapping responses agree within their own coverage", () => {
    const result = resolve([
      evidence("full", [{session:"2021-07-20",ratio:2},{session:"2026-06-15",ratio:3}]),
      {status:"retrieved",source:"daily",events:[{session:"2026-06-15",ratio:3,numerator:3,denominator:1}],coverage:[{from:"2026-01-01",to:asOf}]},
    ]);
    expect(shareCountOnBasis(result, 10_000_000, "2021-02-01", null, asOf)).toEqual({value:60_000_000});
  });

  it("does not let an EDGAR tag certify a vendor event another covering answer denies", () => {
    const tagged: CompanyFacts = {...facts, facts:{"us-gaap":{
      StockholdersEquityNoteStockSplitConversionRatio1:{label:"ratio",units:{pure:[{
        end:"2026-06-15",val:4,accn:"a",fy:2026,fp:"Q2",form:"10-Q",filed:"2026-08-05",
      }]}},
    },dei:{}}};
    const result = discoverStockSplits(tagged, {asOf, vendor:mergeSplitEvidence([
      evidence("daily",[{session:"2026-06-15",ratio:4}]), evidence("full",[]),
    ])});
    expect(result.events).toEqual([]);
    expect(shareCountOnBasis(result, 10_000_000, "2026-02-01", null, asOf)).toHaveProperty("withheld");
  });

  it.each([
    {filer:-0.0025,vendor:-0.01,keep:false},
    {filer:0.0025,vendor:0,keep:false},
    {filer:0,vendor:0.001,keep:false},
    {filer:0.0025,vendor:-0.0025,keep:false},
    {filer:0,vendor:0,keep:true},
    {filer:0.0025,vendor:0.0025,keep:true},
    {filer:-2.4975,vendor:-2.5,keep:true},
  ])("checks basic and diluted EPS proportionally: $vendor against $filer", ({filer,vendor,keep}) => {
    const result = guardVendorShareFields(
      [{date:"2025-12-31",eps:vendor,epsDiluted:vendor}],
      [{date:"2025-12-31",eps:filer,epsDiluted:filer}], split, asOf,
    );
    expect(result.rows[0]?.eps).toBe(keep ? vendor : undefined);
    expect(result.rows[0]?.epsDiluted).toBe(keep ? vendor : undefined);
    expect(result.withheld).toHaveLength(keep ? 0 : 2);
  });
});
