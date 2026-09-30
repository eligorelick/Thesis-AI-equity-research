/**
 * The live company page's money cells: the quote in its TRADING currency, the
 * model's per-share values in the currency the model ran in (the statements'),
 * and "currency unknown" wherever neither is established — never a "$" by
 * default. Real Stage B over tests/helpers/currencyBundle.ts; only data loading
 * and unrelated page chrome are mocked.
 */
import {
  isValidElement,
  type FunctionComponent,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { currencyBundle, type CurrencyBundleOptions } from "./helpers/currencyBundle";

const harness = vi.hoisted(() => ({ buildDataBundle: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/pipeline/dataBundle", () => ({ buildDataBundle: harness.buildDataBundle }));
vi.mock("@/pipeline/stageA/validate", () => ({
  validateBundle: vi.fn(() => ({ checks: [], flags: [], gaps: [] })),
}));
vi.mock("@/report/query", () => ({ getLatestDoneReport: vi.fn(() => null) }));
vi.mock("@/app/company/[symbol]/GenerateReport", () => ({ GenerateReport: () => null }));
vi.mock("@/components/watchlist/Sidebar", () => ({ WatchlistSidebar: () => null }));
vi.mock("@/components/charts/lazy", () => ({
  FundamentalsChartGrid: () => null,
  TechnicalsChartPanel: () => null,
}));

import { CompanyBody } from "@/app/company/[symbol]/page";

type Props = Record<string, unknown> & { children?: ReactNode };

function elementsWithin(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elementsWithin);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Props>;
  const nested = [element.props.children, ...Object.values(element.props).filter(isValidElement)];
  return [element, ...nested.flatMap(elementsWithin)];
}

/** Render the named live panels of the company page for a bundle. */
async function panels(opts: CurrencyBundleOptions): Promise<Record<string, string>> {
  harness.buildDataBundle.mockResolvedValue(currencyBundle(opts));
  const tree = await CompanyBody({ symbol: opts.symbol ?? (opts.bank ? "BNK" : "GEN") });
  const out: Record<string, string> = {};
  for (const name of ["QuoteHeader", "TechnicalsPanel", "ValuationPanel"]) {
    const element = elementsWithin(tree).find(
      (e) => typeof e.type === "function" && (e.type as FunctionComponent).name === name,
    );
    if (element === undefined) throw new Error(`panel ${name} not rendered`);
    out[name] = renderToStaticMarkup(element);
  }
  return out;
}

/** The text of the stat cell labelled `label` (StatCell renders label then value). */
function cell(html: string, label: string): string {
  const text = html.replace(/<[^>]+>/g, "|").replace(/&amp;/g, "&").replace(/\|+/g, "|");
  const match = new RegExp(`\\|${label.replace(/[/]/g, "\\/")}\\|([^|]+)\\|`).exec(text);
  if (!match) throw new Error(`no cell "${label}" in: ${text.slice(0, 400)}`);
  return match[1]!.trim();
}

/** The per-share amounts printed in the sensitivity heatmap's cell titles. */
function heatmapAmounts(html: string): string[] {
  return [...html.matchAll(/WACC [\d.]+% growth [\d.]+%: ([^"]+?) per share/g)].map((m) => m[1]!);
}

beforeEach(() => harness.buildDataBundle.mockReset());

describe("company page money cells", () => {
  it("control: a USD listing reporting in USD keeps the dollar sign", async () => {
    const p = await panels({});
    expect(cell(p.QuoteHeader!, "price")).toBe("$100.00");
    expect(cell(p.TechnicalsPanel!, "last close")).toMatch(/^\$/);
    expect(cell(p.ValuationPanel!, "dcf / share")).toMatch(/^\$/);
    expect(heatmapAmounts(p.ValuationPanel!).every((a) => a.startsWith("$"))).toBe(true);
  });

  it("states an explicit non-USD listing and model currency, with no dollar sign", async () => {
    const p = await panels({ profileCurrency: "JPY", annualCurrency: "JPY" });
    expect(cell(p.QuoteHeader!, "price")).toBe("100.00 JPY");
    expect(cell(p.TechnicalsPanel!, "last close")).toMatch(/ JPY$/);
    expect(cell(p.ValuationPanel!, "dcf / share")).toMatch(/ JPY$/);
    const grid = heatmapAmounts(p.ValuationPanel!);
    expect(grid.length).toBeGreaterThan(0);
    expect(grid.every((a) => a.endsWith(" JPY"))).toBe(true);
    for (const html of Object.values(p)) expect(html).not.toContain("$");
  });

  it("prices the quote in its trading currency and withholds a model whose statements establish no currency", async () => {
    // Statements carry no currency: the quote is still USD. The DCF combines
    // statements and years, which needs one established currency, so it is
    // withheld — never shown in the listing's dollars. (Until 2026-09-30 it
    // ran and was labelled "currency unknown".)
    const p = await panels({ debt: 0, profileCurrency: "USD", annualCurrency: null, quarterCurrencies: [null, null, null, null] });
    expect(cell(p.QuoteHeader!, "price")).toBe("$100.00");
    expect(cell(p.ValuationPanel!, "dcf / share")).toBe("n/a");
    expect(heatmapAmounts(p.ValuationPanel!)).toEqual([]);
    expect(p.ValuationPanel).not.toContain("$");
  });

  it("says currency unknown when neither the listing nor the statements establish one", async () => {
    const p = await panels({ debt: 0, profileCurrency: null, annualCurrency: null, quarterCurrencies: [null, null, null, null] });
    expect(cell(p.QuoteHeader!, "price")).toBe("100.00 (currency unknown)");
    expect(cell(p.TechnicalsPanel!, "last close")).toMatch(/\(currency unknown\)$/);
    // No established statement currency: the DCF is withheld, not labelled.
    expect(cell(p.ValuationPanel!, "dcf / share")).toBe("n/a");
    for (const html of Object.values(p)) expect(html).not.toContain("$");
  });

  it("compares the DCF with the price only when both are in one known currency", async () => {
    const usd = await panels({ debt: 0 });
    expect(cell(usd.ValuationPanel!, "vs price")).toMatch(/^[+-]\d+\.\d%$/);
    const unknownModel = await panels({ debt: 0, annualCurrency: null, quarterCurrencies: [null, null, null, null] });
    expect(cell(unknownModel.ValuationPanel!, "dcf / share")).toBe("n/a");
    expect(cell(unknownModel.ValuationPanel!, "vs price")).toBe("n/a");
    const unknownQuote = await panels({ debt: 0, profileCurrency: null });
    expect(cell(unknownQuote.ValuationPanel!, "vs price")).toBe("n/a");
  });

  it("states a bank's excess-return value per share in its statements' currency", async () => {
    const p = await panels({ bank: true, profileCurrency: "EUR", annualCurrency: "EUR" });
    expect(cell(p.ValuationPanel!, "value / share")).toMatch(/ EUR$/);
    expect(p.ValuationPanel).not.toContain("$");
  });
});
