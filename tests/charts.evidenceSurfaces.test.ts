import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UiDesignProvider } from "@/appearance/UiDesignProvider";
import { PriceChart } from "@/components/charts/PriceChart";
import { RelativeStrengthChart } from "@/components/charts/RelativeStrengthChart";

describe.each(["current", "workspace"] as const)("chart evidence controls in %s", (design) => {
  it("offers native price/relative-strength data controls without mounting the closed tables", () => {
    const html = renderToStaticMarkup(createElement(UiDesignProvider, { initialDesign: design },
      createElement("div", null,
        createElement(PriceChart, { rows: [{ date: "2026-01-02", open: 1, high: 3, low: 0, close: 2, volume: null }] }),
        createElement(RelativeStrengthChart, { series: [{ label: "DEMO", rows: [{ date: "2026-01-02", close: 2 }] }] }))));
    expect(html).toMatch(/<summary[^>]*>.*?Price data/s);
    expect(html).toMatch(/<summary[^>]*>.*?Relative-strength data/s);
    expect(html).toContain("aria-describedby=");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<tbody");
  });
});
