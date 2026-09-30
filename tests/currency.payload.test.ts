/**
 * The AI context payload and its provenance registry state each monetary
 * figure in the currency ITS OWN evidence establishes — never a universal
 * listing-currency default:
 *
 *  - the quote and price technicals: the listing's trading currency;
 *  - Stage B values computed from the statements (FCF, DCF / excess-return per
 *    share, projections): the statements' / model's currency;
 *  - analyst estimates and price targets carry no currency of their own. The
 *    provider states them either in the listing or in the reporting currency,
 *    so a code is established only when the two agree;
 *  - anything else stays unknown.
 *
 * An unknown currency stays unknown through assembly, registration (a monetary
 * figure without a currency is not registered, so it cannot verify), the
 * verify pass (a citation of it is stored with no currency) and rendering.
 * Real Stage B + payload assembly + verify pass over tests/helpers/currencyBundle.ts.
 */
import { describe, expect, it } from "vitest";

import { runStageB, type ComputedMetrics } from "@/pipeline/compute";
import { buildDataOnlyReport } from "@/pipeline/jobRunner";
import type { ValidationReport } from "@/pipeline/stageA/validate";
import { assembleContextPayload, serializePayloadForPrompt, type ContextPayload } from "@/pipeline/stageC/payload";
import { collectTracedNumbers, runVerifyPass, type PassDeps } from "@/pipeline/stageC/passes";
import type { DataBundle } from "@/pipeline/types";
import { formatTracedValue } from "@/report/format";
import type { JudgeOutput } from "@/report/schema";

import { M, completeCurrencyBundle as payloadBundle, type CurrencyBundleOptions } from "./helpers/currencyBundle";

const UNLABELLED = [null, null, null, null] as const;
const VALIDATION: ValidationReport = { checks: [], flags: [], gaps: [] } as unknown as ValidationReport;

interface Assembled {
  bundle: DataBundle;
  computed: ComputedMetrics;
  payload: ContextPayload;
}

function assemble(opts: CurrencyBundleOptions): Assembled {
  const bundle = payloadBundle(opts);
  const computed = runStageB(bundle);
  return { bundle, computed, payload: assembleContextPayload(bundle, computed, VALIDATION) };
}

/** Every payload figure (sections only) with this label. */
function figure(payload: ContextPayload, label: string) {
  const sections = [payload.quote, ...payload.computed, payload.estimates];
  const found = sections.flatMap((s) => s.figures).find((f) => f.label === label);
  if (found === undefined) throw new Error(`no payload figure "${label}"`);
  return found;
}

function record(payload: ContextPayload, label: string) {
  const id = figure(payload, label).provenanceId;
  return id === undefined ? undefined : payload.provenanceRegistry!.find((r) => r.id === id);
}

function dcfPerShare(computed: ComputedMetrics): number {
  if (computed.valuation.kind !== "dcf" || computed.valuation.dcf?.perShare == null) {
    throw new Error("fixture must produce a DCF per share");
  }
  return computed.valuation.dcf.perShare;
}

const USD = { profileCurrency: "USD", annualCurrency: "USD" } as const;
const JPY = { profileCurrency: "JPY", annualCurrency: "JPY" } as const;
/** A USD listing whose statements carry no currency anywhere. */
const UNKNOWN_STATEMENTS = { profileCurrency: "USD", annualCurrency: null, quarterCurrencies: UNLABELLED } as const;
/** An ADR: USD listing, TWD statements. */
const ADR = { profileCurrency: "USD", annualCurrency: "TWD" } as const;
/** USD statements, listing currency explicitly unknown. */
const UNKNOWN_LISTING = { profileCurrency: null, annualCurrency: "USD" } as const;

describe("payload registration: each figure's own currency evidence", () => {
  it("control: a USD listing reporting in USD registers every money figure in USD at its computed value", () => {
    const { computed, payload } = assemble(USD);
    expect(record(payload, "price")).toMatchObject({ value: 100, currency: "USD", unit: "currency-per-share" });
    expect(record(payload, "DCF per share")).toMatchObject({ value: dcfPerShare(computed), currency: "USD" });
    expect(record(payload, "latest FCF (after SBC, house default)")).toMatchObject({
      value: computed.capital.fcf.latestFcf,
      currency: "USD",
    });
    // FY2025: OCF 220 + capex -40 - SBC 10.
    expect(computed.capital.fcf.latestFcf).toBe(170 * M);
    expect(record(payload, "est revenue 2026-12-31")).toMatchObject({ value: 1300 * M, currency: "USD" });
    expect(record(payload, "est EPS 2026-12-31")).toMatchObject({ value: 1.9, currency: "USD" });
    expect(record(payload, "price target consensus")).toMatchObject({ value: 120, currency: "USD" });
  });

  it("control: a JPY listing reporting in JPY registers JPY and nothing in USD", () => {
    const { computed, payload } = assemble(JPY);
    expect(record(payload, "price")?.currency).toBe("JPY");
    expect(record(payload, "DCF per share")).toMatchObject({ value: dcfPerShare(computed), currency: "JPY" });
    expect(record(payload, "est revenue 2026-12-31")?.currency).toBe("JPY");
    expect(payload.provenanceRegistry!.filter((r) => r.currency === "USD")).toEqual([]);
  });

  it("does not stamp the listing currency on statement-derived values whose currency is unknown", () => {
    const { payload } = assemble(UNKNOWN_STATEMENTS);
    // The quote is still in its trading currency.
    expect(record(payload, "price")).toMatchObject({ value: 100, currency: "USD" });
    expect(record(payload, "last close")?.currency).toBe("USD");
    // No statement row establishes a currency, so the DCF and FCF (which
    // combine statements and years) are withheld rather than stated in USD.
    // (Until 2026-09-30 they ran and were registered as currency unknown.)
    for (const label of ["DCF per share", "latest FCF (after SBC, house default)"]) {
      expect(figure(payload, label).value).toBeNull();
      expect(record(payload, label)).toBeUndefined();
    }
    // Nothing statement-derived is registered in USD: only the quote and the
    // price technicals carry the listing's currency.
    const usdRecords = payload.provenanceRegistry!.filter((r) => r.currency === "USD").map((r) => r.id);
    expect(usdRecords.length).toBeGreaterThan(0);
    for (const id of usdRecords) expect(id).toMatch(/^(payload\.quote\.|computed\.technicals)/);
    // Estimates: the listing says USD, the statements say nothing — unknown.
    expect(figure(payload, "est revenue 2026-12-31").currency).toBeNull();
    expect(record(payload, "est revenue 2026-12-31")).toBeUndefined();
    expect(record(payload, "price target consensus")).toBeUndefined();
  });

  it("an ADR's estimates stay unknown; its model values are in the statements' currency", () => {
    const { computed, payload } = assemble(ADR);
    expect(record(payload, "price")?.currency).toBe("USD");
    // Statements in TWD vs a USD quote: the DCF is withheld for a known mismatch
    // (the ADR rule), so check the statement-derived FCF instead.
    expect(record(payload, "latest FCF (after SBC, house default)")).toMatchObject({
      value: computed.capital.fcf.latestFcf,
      currency: "TWD",
    });
    for (const label of ["est revenue 2026-12-31", "est EPS 2026-12-31", "price target consensus"]) {
      expect(figure(payload, label).currency).toBeNull();
      expect(record(payload, label)).toBeUndefined();
    }
  });

  it("keeps an explicitly unknown listing currency unknown", () => {
    const { computed, payload } = assemble(UNKNOWN_LISTING);
    expect(figure(payload, "price").currency).toBeNull();
    expect(record(payload, "price")).toBeUndefined();
    expect(record(payload, "last close")).toBeUndefined();
    expect(record(payload, "DCF per share")).toMatchObject({ value: dcfPerShare(computed), currency: "USD" });
    expect(record(payload, "est revenue 2026-12-31")).toBeUndefined();
  });
});

describe("verification and rendering of an unknown-currency figure", () => {
  const deps = {} as PassDeps;

  async function verify(payload: ContextPayload, numbers: Record<string, unknown>[]) {
    const result = await runVerifyPass(deps, payload, { numbers } as unknown as JudgeOutput, { fetchedUrls: [] });
    return collectTracedNumbers(result.verifiedReport);
  }

  it("a model citation of an unknown-currency computed figure does not verify and is stored with no currency", async () => {
    // USD statements, listing currency unknown: the DCF is in the model's
    // USD; the last close is a computed price in the unknown listing currency.
    const usd = assemble(USD);
    const unknown = assemble(UNKNOWN_LISTING);
    const cite = (p: ContextPayload, label: string, currency?: string) => {
      const f = figure(p, label);
      return {
        value: f.value,
        unit: "currency/share",
        ...(currency === undefined ? {} : { currency }),
        source: f.provenanceId ?? `computed.valuation.${label}`,
        asOf: usd.payload.provenanceRegistry!.find((r) => r.id === figure(usd.payload, label).provenanceId)!.asOf,
        verified: null,
      };
    };
    const [usdDcf] = await verify(usd.payload, [cite(usd.payload, "DCF per share")]);
    expect(usdDcf).toMatchObject({ verified: true, currency: "USD" });

    const [omitted, claimedUsd, dcf] = await verify(unknown.payload, [
      cite(unknown.payload, "last close"),
      cite(unknown.payload, "last close", "USD"),
      cite(unknown.payload, "DCF per share"),
    ]);
    expect(figure(unknown.payload, "last close").currency).toBeNull();
    expect(omitted?.verified).toBe(false);
    expect(omitted?.currency ?? null).toBeNull();
    expect(formatTracedValue(omitted!)).toMatch(/\(currency unknown\)$/);
    expect(claimedUsd?.verified).toBe(false);
    // The model's value keeps its legitimate statement currency.
    expect(dcf).toMatchObject({ verified: true, currency: "USD" });
  });

  it("the prompt states each money figure's currency, and says unknown rather than implying one", () => {
    const usdPrompt = serializePayloadForPrompt(assemble(USD).payload);
    expect(usdPrompt).toMatch(/- DCF per share: [\d.]+ currency\/share \(USD\) \[/);
    expect(usdPrompt).toMatch(/- est revenue 2026-12-31: \d+ currency \(USD\) \[/);

    const prompt = serializePayloadForPrompt(assemble(UNKNOWN_STATEMENTS).payload);
    expect(prompt).toMatch(/- price: 100 currency\/share \(USD\) \[/);
    // Withheld, not stated in the listing's currency.
    expect(prompt).toMatch(/- DCF per share: n\/a \[/);
    expect(prompt).toMatch(/- est revenue 2026-12-31: \d+ currency \(currency unknown\) \[/);
    expect(prompt).not.toMatch(/DCF per share[^\n]*USD/);

    const listingPrompt = serializePayloadForPrompt(assemble(UNKNOWN_LISTING).payload);
    expect(listingPrompt).toMatch(/- last close: [\d.]+ currency\/share \(currency unknown\) \[/);
    expect(listingPrompt).toMatch(/- DCF per share: [\d.]+ currency\/share \(USD\) \[/);
  });
});

describe("data-only report", () => {
  function dataOnly(opts: CurrencyBundleOptions) {
    const { bundle, computed } = assemble(opts);
    return buildDataOnlyReport({
      symbol: bundle.symbol,
      companyName: "Test General Co",
      generatedAt: "2026-07-06T12:00:00.000Z",
      model: "none",
      costUsd: 0,
      bundle,
      validation: VALIDATION,
      computed,
      costBreakdown: [],
      reason: "no analysis",
    });
  }

  it("prices the technicals in the trading currency only, never the statements' by default", () => {
    const control = dataOnly(USD);
    const unknownListing = dataOnly(UNKNOWN_LISTING);
    const lastClose = (r: ReturnType<typeof dataOnly>) =>
      r.technicals.indicators.find((n) => /computed\.technicals$/.test(n.source));
    expect(lastClose(control)).toMatchObject({ currency: "USD" });
    // USD statements say nothing about the listing's currency: no last close in USD.
    expect(lastClose(unknownListing)).toBeUndefined();
  });
});
