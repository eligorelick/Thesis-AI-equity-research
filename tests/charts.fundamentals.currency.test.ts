/**
 * The fundamentals charts print revenue and free cash flow. Their labels used
 * a hard-coded "$", so a TWD reporter's revenue read "$3.8T" on the company
 * page while its stored report said "3.81T TWD". The chart title now names
 * the currency the bars are in whenever it is not USD, including when no
 * currency is known.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FcfChart, RevenueTrendChart } from "@/components/charts/FundamentalsCharts";

const revenue = [{ period: "2024-12-31", revenue: 3.81e12, yoyGrowthPct: 10 }];
const fcf = [{ period: "2024-12-31", fcf: 1e12, conversionPct: 90 }];

describe("fundamentals chart titles name the reporting currency", () => {
  it("names a non-USD code", () => {
    const html = renderToStaticMarkup(createElement(RevenueTrendChart, { rows: revenue, currency: "TWD" }));
    expect(html).toContain("revenue (TWD)");
    expect(html).not.toContain("$");
    expect(renderToStaticMarkup(createElement(FcfChart, { rows: fcf, currency: "TWD" }))).toContain("(TWD)");
  });

  it("says the currency is unknown rather than implying dollars", () => {
    expect(renderToStaticMarkup(createElement(RevenueTrendChart, { rows: revenue, currency: null }))).toContain(
      "revenue (currency unknown)",
    );
    expect(renderToStaticMarkup(createElement(FcfChart, { rows: fcf, currency: null }))).toContain("(currency unknown)");
  });

  it("control: a USD chart keeps its plain title", () => {
    const html = renderToStaticMarkup(createElement(RevenueTrendChart, { rows: revenue, currency: "USD" }));
    expect(html).toContain("revenue &amp; yoy growth");
    expect(html).not.toContain("currency unknown");
  });
});
