// Rendered provenance controls in both existing designs; no invented source/date.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UiDesignProvider } from "@/appearance/UiDesignProvider";
import { GradeReasoning, TracedStat } from "@/components/report/primitives";
import { ValuationSection } from "@/components/report/sections";
import type { GradeBlock, TracedNumber } from "@/report/schema";
import { loadTask28Fixture } from "./helpers/task28Report";

function render(design: "current" | "workspace", child: ReactNode) {
  return renderToStaticMarkup(createElement(UiDesignProvider, { initialDesign: design }, child));
}
function text(html: string) { return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "); }
const input: TracedNumber = { value: 10.125, unit: "percent", period: "FY2025",
  sourceId: "grade-input:wacc:recorded", source: "computed.costOfCapital.wacc",
  asOf: "2026-09-30", verified: true, verificationNote: "Recorded citation coverage only" };
function block(keyNumbers: TracedNumber[]): GradeBlock {
  return { grade: "B", confidence: "medium", oneLineWhy: "Recorded inputs support the grade",
    reasoning: [], keyNumbers };
}

describe.each(["current", "workspace"] as const)("recorded grade/DCF evidence in %s", (design) => {
  it("makes WACC, ROIC and debt coverage identities and periods inspectable beyond hover", () => {
    const numbers = [input, { ...input, value: 14.25, sourceId: "grade-input:roic", source: "computed.returns.roic" },
      { ...input, value: 3.2, unit: "multiple", sourceId: "grade-input:interestCoverage", source: "computed.debt.interestCoverage" }];
    const html = render(design, createElement(GradeReasoning, { title: "recorded drivers", block: block(numbers), defaultOpen: true }));
    const visible = text(html);
    for (const n of numbers) for (const field of [n.sourceId!, n.source, n.period!, n.asOf!]) expect(visible).toContain(field);
    expect(html.match(/<summary\b/g)?.length).toBe(4); // reasoning plus three native source disclosures
    expect(visible).toContain("traceability, not correctness");
    expect(visible).not.toMatch(/most influential|accuracy rate/i);
  });
  it("does not infer legacy source identity, period or observation date and preserves zero", () => {
    const n = { ...input, value: 0, sourceId: undefined, period: null, asOf: null, verified: null };
    const visible = text(render(design, createElement(GradeReasoning, { title: "legacy", block: block([n]), defaultOpen: true })));
    expect(visible).toMatch(/source id not recorded/);
    expect(visible).toMatch(/period not recorded/);
    expect(visible).toMatch(/as of not recorded/);
    expect(visible).toContain("0.0%");
    expect(visible).not.toContain("2026-09-30");
  });
  it("does not add dense source controls to unrelated stat callers by default", () => {
    const html = render(design, createElement(TracedStat, { label: "ordinary stat", n: input }));
    expect(html).not.toContain("<summary");
  });
  it("describes an unresolved provided citation without claiming the value was uncited", () => {
    const visible = text(render(design, createElement(GradeReasoning, { title: "unresolved", block: block([{ ...input, verified: false }]), defaultOpen: true })));
    expect(visible).toContain(input.sourceId!);
    expect(visible).toContain("citation status not citation-traced");
    expect(visible).not.toContain("citation status uncited");
  });
  it("exposes DCF recorded identity and period, then suppresses its provenance when value is absent", () => {
    const valuation = loadTask28Fixture().valuation;
    valuation.dcf.perShare = { ...input, value: 123.456, unit: "USD/share", currency: "USD", sourceId: "dcf:canonical", period: "FY2037" };
    const html = render(design, createElement(ValuationSection, { valuation, index: 6 }));
    const visible = text(html);
    expect(html).toMatch(/<summary[^>]*>.*?DCF provenance/s);
    for (const field of ["dcf:canonical", "FY2037", "2026-09-30", "USD/share"]) expect(visible).toContain(field);
    expect(visible).toContain("$123.46");
    valuation.dcf.perShare = null;
    const absent = text(render(design, createElement(ValuationSection, { valuation, index: 6 })));
    expect(absent).toContain("unavailable");
    expect(absent).not.toContain("DCF provenance");
  });
  it("renders source metadata as escaped text rather than executable markup or an invented link", () => {
    const n = { ...input, sourceId: '<img src=x onerror="alert(1)">', source: '<script>alert("source")</script>' };
    const html = render(design, createElement(GradeReasoning, { title: "escaped", block: block([n]), defaultOpen: true }));
    expect(text(html)).toContain("&lt;img");
    expect(text(html)).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="');
  });
});
