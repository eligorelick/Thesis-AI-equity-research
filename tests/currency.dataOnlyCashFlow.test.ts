/**
 * The data-only report (no AI pass) states each cash-flow figure in the
 * currency of ITS OWN cash-flow row — never the latest income statement's —
 * and never prints a history that mixes currencies: the series runs back
 * from the newest year only while the years share one established currency.
 * An unknown year is withheld, not labelled. Rendering (web view, Markdown,
 * print HTML) shows exactly those labels.
 *
 * Expected values from tests/helpers/currencyBundle.ts (millions), FCF after
 * SBC = operating cash flow − capex − SBC:
 *   FY2025: 220 − 40 − 10 = 170   FY2024: 205 − 38 − 9 = 158   FY2023: 190 − 35 − 8 = 147
 * Repurchases: 20 + 30 + 13 = 63.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ReportView } from "@/components/report/ReportView";
import { runStageB, type ComputedMetrics } from "@/pipeline/compute";
import { buildDataOnlyReport } from "@/pipeline/jobRunner";
import type { ValidationReport } from "@/pipeline/stageA/validate";
import type { DataBundle } from "@/pipeline/types";
import { reportToMarkdown } from "@/report/export/markdown";
import { reportToPrintBody } from "@/report/export/printHtml";
import type { Report, TracedNumber } from "@/report/schema";

import { M, completeCurrencyBundle, type CurrencyBundleOptions } from "./helpers/currencyBundle";

const VALIDATION = { checks: [], flags: [], gaps: [] } as unknown as ValidationReport;
/** The reviewer's rows: FY2025 JPY, FY2024 EUR, FY2023 with no label; income USD. */
const REVIEWED_CASH_FLOWS = ["JPY", "EUR", null] as const;
const FCF_LABEL = "Free cash flow (after SBC, house default)";

function report(bundle: DataBundle, computed: ComputedMetrics = runStageB(bundle)): Report {
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

function bundleOf(opts: CurrencyBundleOptions): DataBundle {
  return completeCurrencyBundle({ debt: 300, ...opts });
}

function fcfValues(r: Report): { period: string; value: TracedNumber }[] {
  return r.fundamentals.fcf.find((row) => row.label === FCF_LABEL)?.values ?? [];
}

function buybackSentence(r: Report): string | undefined {
  return r.balanceSheet.capitalAllocation.find((c) => /^Repurchased /.test(c.text))?.text;
}

describe("control: cash flows in the statements' one currency", () => {
  it("states every year's FCF in USD at its own value", () => {
    const r = report(bundleOf({}));
    expect(fcfValues(r).map((v) => [v.period, v.value.value, v.value.currency])).toEqual([
      ["2023-12-31", 147 * M, "USD"],
      ["2024-12-31", 158 * M, "USD"],
      ["2025-12-31", 170 * M, "USD"],
    ]);
    expect(buybackSentence(r)).toMatch(/^Repurchased 63(\.0)?M USD of stock/);
  });

  it("control: JPY cash flows with JPY statements are stated in JPY", () => {
    const r = report(bundleOf({ profileCurrency: "JPY", annualCurrency: "JPY" }));
    expect(fcfValues(r).map((v) => v.value.currency)).toEqual(["JPY", "JPY", "JPY"]);
  });
});

describe("the reviewer's rows: FY2025 JPY, FY2024 EUR, FY2023 unknown, income USD", () => {
  const bundle = bundleOf({ cashflowAnnualCurrencies: REVIEWED_CASH_FLOWS });

  it("states no cash-flow figure in the income statement's USD", () => {
    const r = report(bundle);
    for (const v of fcfValues(r)) expect(v.value.currency).not.toBe("USD");
    expect(buybackSentence(r) ?? "").not.toMatch(/USD/);
  });

  it("labels each year from its own row when the report is handed the full series", () => {
    // Stage B already withholds these rows from its calculations (they are not
    // in the model's USD); here the report layer is handed the series a USD
    // twin produced, so it alone decides each year's label.
    const usdTwin = runStageB(bundleOf({}));
    const r = report(bundle, usdTwin);
    const values = fcfValues(r);
    // FY2025 in its own JPY; FY2024 (EUR) breaks the history, so FY2024 and
    // the unknown FY2023 are not set beside it.
    expect(values.map((v) => [v.period, v.value.value, v.value.currency])).toEqual([["2025-12-31", 170 * M, "JPY"]]);
    // The repurchase total spans years in three currencies: no sum is stated.
    expect(buybackSentence(r)).toBeUndefined();
  });

  it("renders those labels in the web view and both exports", () => {
    const r = report(bundle, runStageB(bundleOf({})));
    for (const text of [
      renderToStaticMarkup(createElement(ReportView, { report: r })),
      reportToMarkdown(r),
      reportToPrintBody(r),
    ]) {
      const fcfLines = text.split(/\n|<tr/).filter((line) => line.includes("Free cash flow (after SBC"));
      expect(fcfLines.join("\n")).toMatch(/170(\.00?)?M JPY/);
      expect(fcfLines.join("\n")).not.toMatch(/USD|\$|EUR|158|147/);
    }
  });
});

describe("the FCF's own evidence is enough", () => {
  it("states USD cash flows in USD even when the annual income statement carries no label", () => {
    // Quarters in USD make the model USD; the cash-flow rows say USD
    // themselves. The income statement's missing label says nothing about them.
    const r = report(
      bundleOf({
        annualCurrency: "USD",
        incomeAnnualCurrencies: [null, null, null, null],
        quarterCurrencies: ["USD", "USD", "USD", "USD"],
      }),
    );
    const values = fcfValues(r);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v.value.currency).toBe("USD");
  });
});
