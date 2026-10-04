import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UiDesignProvider } from "@/appearance/UiDesignProvider";
import { ScenarioCard } from "@/components/report/primitives";
import { CatalystsRisksPanel } from "@/components/report/sections";
import type { CatalystsRisks, TracedNumber } from "@/report/schema";

function render(design: "current" | "workspace", child: ReactNode) {
  return renderToStaticMarkup(createElement(UiDesignProvider, { initialDesign: design }, child));
}
function text(html: string) { return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "); }
const target: TracedNumber = {
  value: 42, unit: "USD/share", currency: "USD", period: "FY2027", sourceId: "target:computed:base",
  source: "computed.scenarioTargets.base", asOf: "2026-09-30", verified: true,
};
function scenario(priceTarget: TracedNumber | null) {
  return createElement(ScenarioCard, { name: "base", probability: null, priceTarget, horizon: "3 years",
    assumptions: [], whatWouldHaveToBeTrue: [] });
}
function evidence(): CatalystsRisks {
  return { catalysts: [{ title: "Capacity expansion", expectedDate: "2027-Q2", direction: "mixed", significance: "high",
    reasoning: { text: "Execution remains uncertain", label: "JUDGMENT", sourceId: "claim:capacity", source: "filing.item1", asOf: "2026-09-15" } }],
  risks: [{ title: "Refinancing", severity: "high", probability: "medium", source: "filing.item1A",
    reasoning: { text: "Maturity pressure", label: "FACT", sourceId: "claim:debt", source: "filing.debtNote", asOf: "2026-08-31" } }] };
}

describe.each(["current", "workspace"] as const)("recorded report provenance in %s", (design) => {
  it("makes target source identity and observation date accessible beyond hover, separate from horizon", () => {
    const html = render(design, scenario(target));
    const visible = text(html);
    expect(html).toMatch(/<summary[^>]*>.*?Target provenance/s);
    for (const value of [target.sourceId!, target.source, target.asOf!, target.period!]) expect(visible).toContain(value);
    expect(visible).toContain("as of");
    expect(visible).toContain("3 years");
    expect(visible).toContain("traceability, not correctness");
  });
  it("discloses unrecorded legacy metadata without inventing a date or target", () => {
    const legacy = { ...target, asOf: null, period: undefined, sourceId: undefined };
    const visible = text(render(design, scenario(legacy)));
    expect(visible).toMatch(/as of not recorded/);
    expect(visible).toMatch(/period not recorded/);
    expect(visible).toMatch(/source id not recorded/);
    const absent = text(render(design, scenario(null)));
    expect(absent).toContain("target unavailable");
    expect(absent).not.toContain("Target provenance");
    expect(absent).not.toContain("2026-09-30");
  });
  it("exposes catalyst meaning and keeps expected event dates separate from reasoning dates", () => {
    const html = render(design, createElement(CatalystsRisksPanel, { catalystsRisks: evidence() }));
    const visible = text(html);
    for (const value of ["direction mixed", "significance high", "expected date 2027-Q2", "2026-09-15", "claim:capacity", "JUDGMENT"])
      expect(visible).toContain(value);
  });
  it("retains risk source separately from the reasoning citation and labels qualitative severity/probability", () => {
    const visible = text(render(design, createElement(CatalystsRisksPanel, { catalystsRisks: evidence() })));
    for (const value of ["risk source filing.item1A", "filing.debtNote", "claim:debt", "severity high", "probability medium", "2026-08-31"])
      expect(visible).toContain(value);
  });
  it("escapes recorded source strings and makes missing event/source metadata explicit", () => {
    const data = evidence();
    data.catalysts[0]!.expectedDate = null;
    data.risks[0]!.source = " ";
    const missing = text(render(design, createElement(CatalystsRisksPanel, { catalystsRisks: data })));
    expect(missing).toContain("expected date not recorded");
    expect(missing).toContain("risk source not recorded");
    data.risks[0]!.source = '<script>alert("source")</script>';
    const html = render(design, createElement(CatalystsRisksPanel, { catalystsRisks: data }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    const numberHtml = render(design, scenario({ ...target, sourceId: '<img src=x onerror="alert(1)">' }));
    expect(text(numberHtml)).toContain("&lt;img");
    expect(numberHtml).not.toContain("<img");
  });
});
