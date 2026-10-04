// Semantic/lazy table views in both existing designs; keyboard state tested in browser.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UiDesignProvider } from "@/appearance/UiDesignProvider";
import { ChartDataDisclosure, ChartDataTable } from "@/components/charts/ChartDataDisclosure";

function render(design: "current" | "workspace", child: ReactNode) {
  return renderToStaticMarkup(createElement(UiDesignProvider, { initialDesign: design }, child));
}
const rows = Array.from({ length: 65 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  values: [i === 64 ? 123.123456789 : i, i === 64 ? null : 0],
}));
const columns = ["Close (price units)", "Volume"];
const caption = "Daily price observations; currency not recorded";
const noop = () => {};

describe.each(["current", "workspace"] as const)("accessible chart data in %s", (design) => {
  it("keeps the initial closed disclosure native and avoids mounting all data rows", () => {
    const html = render(design, createElement(ChartDataDisclosure, { label: "Price data", columns, rows, caption,
      basis: "OHLC and volume as plotted" }));
    expect(html).toMatch(/<details\b/);
    expect(html).toMatch(/<summary[^>]*>.*?Price data/s);
    expect(html).not.toContain("<table");
    expect(html).not.toContain("123.123456789");
    expect(html).not.toMatch(/<details[^>]*\bopen=/);
  });
  it("shows the most recent 30 exact observations with semantic headers and explicit missing cells", () => {
    const html = render(design, createElement(ChartDataTable, { columns, rows, caption, page: 0, onPageChange: noop }));
    expect(html).toContain("<caption");
    expect(html).toContain(caption);
    expect(html.match(/scope="row"/g)).toHaveLength(30);
    expect(html.match(/scope="col"/g)).toHaveLength(3);
    expect(html).toContain("123.123456789");
    expect(html).toContain("unavailable");
    expect(html).toContain("Rows 36–65 of 65");
    expect(html).toContain(rows[35]!.date);
    expect(html).toContain(rows[64]!.date);
    expect(html).not.toContain(rows[34]!.date);
    expect(html).toContain("Older");
    expect(html).toContain("Newer");
    expect(html).toMatch(/tabindex="0"/); // labeled horizontal-overflow region for keyboard scrolling
  });
  it("makes the oldest remainder reachable without duplication or a false row count", () => {
    const html = render(design, createElement(ChartDataTable, { columns, rows, caption, page: 2, onPageChange: noop }));
    expect(html.match(/scope="row"/g)).toHaveLength(5);
    expect(html).toContain("Rows 1–5 of 65");
    expect(html).toContain(rows[0]!.date);
    expect(html).toContain(rows[4]!.date);
    expect(html).not.toContain(rows[5]!.date);
    // Button callbacks/pagination and disabled boundaries verified in browser
    // via native keyboard activation; complete pure view disabled assertions once exact markup lands.
  });
  it("preserves zero while making empty histories explicit", () => {
    const zero = render(design, createElement(ChartDataTable, { columns, rows: [rows[0]!], caption, page: 0, onPageChange: noop }));
    expect(zero).not.toContain("unavailable");
    expect(zero).toContain(">0<");
    const empty = render(design, createElement(ChartDataDisclosure, { label: "Relative-strength data", columns,
      rows: [], caption: "Indexed to 100", basis: "No usable baseline observations" }));
    expect(empty).toMatch(/no .*observations|unavailable/i);
    expect(empty).not.toContain("<tbody");
  });
  it("escapes recorded series labels and caption text without evaluating markup", () => {
    const html = render(design, createElement(ChartDataTable, { columns: ['<img src=x onerror="alert(1)">', "BENCH"],
      rows: [rows[0]!], caption: '<script>alert("caption")</script>', page: 0, onPageChange: noop }));
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
  });
});
