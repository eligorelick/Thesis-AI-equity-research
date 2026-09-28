/**
 * Currency integrity in stored reports and their exports.
 *
 * A figure's currency is ESTABLISHED by its own `currency` field or by an
 * explicit ISO unit ("USD", "TWD/share"). Nothing else establishes one: the
 * lowercase canonical names ("usd", "usd_large", "currency", "currency/share")
 * are historical spellings of "some currency", no report spec version was ever
 * a USD-only contract, and a report carries no report-level currency. So an
 * absent currency on a generic unit is "currency unknown" — not a legacy
 * dollar. Stored values are rendered, never rewritten.
 *
 * Both shapes are covered: the older sample report exactly as stored (no
 * currency fields; money in "usd" and "USD" units), and the same report as the
 * current pipeline writes it (explicit currency fields).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ReportView } from "@/components/report/ReportView";
import { reportToMarkdown } from "@/report/export/markdown";
import { reportToPrintHtml } from "@/report/export/printHtml";
import { formatTracedValue } from "@/report/format";
import { ReportSchema, type Report, type TracedNumber } from "@/report/schema";

const SAMPLE = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures", "report", "DEMO-sample.json"), "utf8"),
) as Record<string, unknown>;

/** The fields of the raw stored JSON these tests read or edit before parsing. */
interface RawSample {
  valuation: { dcf: { perShare: Record<string, unknown> } };
  projections: { series: { bull: { value: unknown }[] }[] };
  routeMetrics?: unknown;
}

function sampleWith(mutate: (raw: RawSample) => void = () => {}): Report {
  const raw = structuredClone(SAMPLE) as unknown as RawSample;
  mutate(raw);
  return ReportSchema.parse(raw);
}

const traced = (over: Partial<TracedNumber>): TracedNumber =>
  ({ value: 1234.5, unit: "usd", source: "computed.test", asOf: "2025-12-31", verified: true, ...over }) as TracedNumber;

/** Every per-share amount a rendering printed for the DCF sensitivity grid. */
function markdownGrid(md: string): string[] {
  const start = md.indexOf("### Sensitivity (per share");
  expect(start).toBeGreaterThanOrEqual(0);
  const block = md.slice(start).split("\n\n").slice(0, 2).join("\n");
  return block
    .split("\n")
    .filter((line) => /^\|\s*[\d.]+%/.test(line))
    .flatMap((line) => line.split("|").slice(2, -1).map((cell) => cell.trim()));
}

function htmlGrid(html: string): string[] {
  const start = html.indexOf("Sensitivity (per share");
  expect(start).toBeGreaterThanOrEqual(0);
  const table = html.slice(start, html.indexOf("</table>", start));
  return [...table.matchAll(/<span class="mono">([^<]*)<\/span>/g)]
    .map((m) => m[1]!)
    .filter((cell) => !/%$/.test(cell));
}

function viewGrid(html: string): string[] {
  return [...html.matchAll(/WACC [\d.]+% growth [\d.]+%: ([^"]+?) per share/g)].map((m) => m[1]!);
}

function renderAll(report: Report): { md: string; html: string; view: string } {
  return {
    md: reportToMarkdown(report),
    html: reportToPrintHtml(report),
    view: renderToStaticMarkup(createElement(ReportView, { report })),
  };
}

describe("which evidence establishes a figure's currency", () => {
  it.each([
    ["explicit non-USD field", { currency: "TWD" }, "1,234.50 TWD"],
    ["explicit USD field (control)", { currency: "USD" }, "$1,234.50"],
    ["explicit unknown (null)", { currency: null }, "1,234.50 (currency unknown)"],
    ["absent, generic unit", {}, "1,234.50 (currency unknown)"],
    ["absent, generic per-share unit", { unit: "usd/share" }, "1,234.50 (currency unknown)"],
    ["absent, explicit USD unit", { unit: "USD" }, "$1,234.50"],
    ["absent, explicit USD per-share unit", { unit: "USD/share" }, "$1,234.50"],
    ["absent, explicit TWD per-share unit", { unit: "TWD/share" }, "1,234.50 TWD/share"],
    ["field and unit disagree", { unit: "USD", currency: "TWD" }, "1,234.50 (currency unknown)"],
  ] as const)("%s", (_label, over, expected) => {
    expect(formatTracedValue(traced(over as Partial<TracedNumber>))).toBe(expected);
  });
});

describe("the older stored report shape (no currency fields)", () => {
  const stored = sampleWith();

  it("renders its generic-unit DCF value and grid as currency unknown, in every surface", () => {
    expect(stored.valuation.dcf.perShare).toMatchObject({ unit: "usd" });
    expect(stored.valuation.dcf.perShare).not.toHaveProperty("currency");
    const { md, html, view } = renderAll(stored);
    for (const grid of [markdownGrid(md), htmlGrid(html), viewGrid(view)]) {
      expect(grid.length).toBeGreaterThan(0);
      for (const amount of grid) expect(amount).not.toContain("$");
    }
    expect(md).not.toContain("$48.00");
    expect(md).toContain("48.00 (currency unknown)");
  });

  it("keeps the dollar sign where the stored unit itself says USD", () => {
    // Projected revenue is stored with the unit "USD" itself.
    const revenue = (SAMPLE as unknown as RawSample).projections.series[0]!.bull[0]!.value;
    expect(revenue).toMatchObject({ value: 13_800_000_000, unit: "USD" });
    const { md } = renderAll(stored);
    expect(md).toContain("$13.80B");
  });
});

describe("the current report shape (explicit currency fields)", () => {
  const withDcf = (unit: string, currency: string | null) =>
    sampleWith((raw) => {
      raw.valuation.dcf.perShare = { ...raw.valuation.dcf.perShare, unit, currency };
    });

  it("states an explicit non-USD grid in its currency", () => {
    const { md, html, view } = renderAll(withDcf("TWD/share", "TWD"));
    for (const grid of [markdownGrid(md), htmlGrid(html), viewGrid(view)]) {
      expect(grid.length).toBeGreaterThan(0);
      for (const amount of grid) expect(amount).toMatch(/ TWD$/);
    }
  });

  it("states a grid recorded as unknown without any currency sign", () => {
    const { md, html, view } = renderAll(withDcf("currency/share", null));
    for (const grid of [markdownGrid(md), htmlGrid(html), viewGrid(view)]) {
      for (const amount of grid) expect(amount).not.toContain("$");
    }
  });

  it("control: a USD grid keeps the dollar sign", () => {
    const { md, html, view } = renderAll(withDcf("currency/share", "USD"));
    for (const grid of [markdownGrid(md), htmlGrid(html), viewGrid(view)]) {
      expect(grid.length).toBeGreaterThan(0);
      for (const amount of grid) expect(amount).toMatch(/^\$/);
    }
  });
});

describe("route-metric money", () => {
  const routeReport = (currency?: string | null) =>
    sampleWith((raw) => {
      raw.routeMetrics = {
        route: "mortgage-reit",
        asOf: "2025-12-31",
        notes: [],
        metrics: [
          {
            key: "bookValuePerShare",
            label: "book value per share",
            value: 25,
            unit: "currency/share",
            ...(currency === undefined ? {} : { currency }),
            basis: "equity / shares",
            sources: ["statements:balance"],
            asOf: "2025-12-31",
            withheldReason: null,
            proxy: false,
          },
        ],
      };
    });

  it("states a route metric in the currency the report recorded for it", () => {
    const { md, html, view } = renderAll(routeReport("JPY"));
    for (const out of [md, html, view]) expect(out).toContain("25.00 JPY");
  });

  it("an older route metric with no currency reads currency unknown, not dollars", () => {
    const { md, html, view } = renderAll(routeReport());
    for (const out of [md, html, view]) {
      expect(out).toContain("25.00 (currency unknown)");
      expect(out).not.toContain("$25.00");
    }
  });
});
