import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isValidElement,
  type FunctionComponent,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type { Report } from "@/report/schema";

const harness = vi.hoisted(() => ({
  buildDataBundle: vi.fn(),
  getLatestDoneReport: vi.fn(),
  getReportByIdForSymbol: vi.fn(),
  runStageB: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/pipeline/dataBundle", () => ({
  buildDataBundle: harness.buildDataBundle,
}));
vi.mock("@/pipeline/stageA/validate", () => ({
  validateBundle: vi.fn(() => ({ checks: [], flags: [], gaps: [] })),
}));
vi.mock("@/pipeline/compute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/compute")>();
  return { ...actual, runStageB: harness.runStageB };
});
vi.mock("@/pipeline/stageB/instrumentSupport", () => ({
  classifyInstrumentSupport: vi.fn(() => ({ supported: true, kind: "company" })),
}));
vi.mock("@/components/charts/map", () => ({
  fundamentalsChartDataFromBundle: vi.fn(() => ({ series: [] })),
  priceChartPropsFromBundle: vi.fn(() => ({ rows: [{ time: "2026-08-07" }], crosses: [] })),
  relativeStrengthSeriesFromBundle: vi.fn(() => []),
}));
vi.mock("@/report/query", () => ({
  getLatestDoneReport: harness.getLatestDoneReport,
}));
vi.mock("@/report/history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/report/history")>();
  return { ...actual, getReportByIdForSymbol: harness.getReportByIdForSymbol };
});
vi.mock("@/app/company/[symbol]/GenerateReport", () => ({
  GenerateReport: () => null,
}));

import { CompanyBody } from "@/app/company/[symbol]/page";
import { ReportTabs } from "@/app/company/[symbol]/ReportTabs";
import SavedReportPage from "@/app/company/[symbol]/report/[reportId]/page";
import { FundamentalsChartGrid, TechnicalsChartPanel } from "@/components/charts/lazy";
import { ReportView } from "@/components/report/ReportView";
import { ReportSchema } from "@/report/schema";

type Props = Record<string, unknown> & { children?: ReactNode };
type PersistedReportViewExport =
  typeof import("@/components/report/PersistedReportView")["PersistedReportView"];

function elementsWithin(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elementsWithin);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...elementsWithin(element.props.children)];
}

function structuralText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(structuralText).join("");
  if (!isValidElement(node)) return "";
  return structuralText((node as ReactElement<Props>).props.children);
}

function invoke(element: ReactElement<Props>): ReactElement<Props> {
  expect(typeof element.type).toBe("function");
  return (element.type as FunctionComponent<Props>)(element.props) as ReactElement<Props>;
}

const report = ReportSchema.parse(
  JSON.parse(
    readFileSync(path.join(process.cwd(), "fixtures", "report", "DEMO-sample.json"), "utf8"),
  ),
);

const bundle = {
  symbol: "DEMO",
  builtAt: "2026-08-07T00:00:00.000Z",
  profile: {
    ok: true,
    value: {
      data: { rows: [{ symbol: "DEMO", companyName: "Demo Systems" }], raw: {} },
      asOf: "2026-08-07",
      source: "fmp",
      endpoint: "profile",
      fetchedAt: "2026-08-07T00:00:00.000Z",
      stale: false,
    },
  },
  statements: {
    incomeAnnual: {
      ok: true,
      value: {
        data: { rows: [], raw: {} },
        asOf: "2025-12-31",
        source: "fmp",
        endpoint: "income-statement",
        fetchedAt: "2026-08-07T00:00:00.000Z",
        stale: false,
      },
    },
  },
};

const computed = {
  growth: {
    revenueCagrs: [],
    epsDilutedCagrs: [],
    fcfCagrs: [],
    margins: {
      gross: { series: [], slopePctPtsPerYear: null },
      operating: { series: [], slopePctPtsPerYear: null },
      net: { series: [], slopePctPtsPerYear: null },
    },
    revenueAcceleration: {
      latestYoyPct: null,
      threeYearCagrPct: null,
      accelerating: null,
    },
    notes: [],
  },
  technicals: {
    asOf: "2026-08-06",
    lastClose: 100,
    smaCross: { sma50: 99, sma200: 95, state: "golden" },
    rsi14: 55,
    macd: { histogram: 1, state: "bullish" },
    range52w: { low52w: 70, high52w: 110, positionPct: 75 },
    atr14: { atrPctOfClose: 2 },
    read: {
      trend: "uptrend",
      momentum: "bullish",
      relativeStrength: "outperforming",
      flags: [],
    },
  },
};

describe("persisted report presentation", () => {
  beforeEach(() => {
    harness.buildDataBundle.mockReset();
    harness.buildDataBundle.mockResolvedValue(bundle);
    harness.runStageB.mockReset();
    harness.runStageB.mockReturnValue(computed);
    harness.getLatestDoneReport.mockReset();
    harness.getLatestDoneReport.mockReturnValue({
      reportId: 42,
      createdAt: "2026-07-01T12:00:00.000Z",
      report,
    });
    harness.getReportByIdForSymbol.mockReset();
    harness.getReportByIdForSymbol.mockReturnValue({
      row: {
        id: 42,
        createdAt: "2026-07-01T12:00:00.000Z",
        model: "claude-opus-4-8",
        status: "done",
        verificationRate: 1,
        costUsd: 1,
      },
      report,
    });
  });

  it("delegates both persisted routes to one exact report-only boundary", async () => {
    expectTypeOf<PersistedReportViewExport>()
      .parameter(0)
      .toEqualTypeOf<{ report: Report }>();

    const companyTree = await CompanyBody({ symbol: "DEMO" });
    const tabs = elementsWithin(companyTree).find((element) => element.type === ReportTabs);
    expect(tabs).toBeDefined();
    const companyPersisted = tabs!.props.report as ReactElement<Props>;

    const savedTree = await SavedReportPage({
      params: Promise.resolve({ symbol: "DEMO", reportId: "42" }),
    });
    const savedPersisted = elementsWithin(savedTree).find(
      (element) => element.props.report === report,
    );
    expect(savedPersisted).toBeDefined();

    expect(Object.keys(companyPersisted.props)).toEqual(["report"]);
    expect(Object.keys(savedPersisted!.props)).toEqual(["report"]);
    expect(companyPersisted.type).toBe(savedPersisted!.type);
    const { PersistedReportView } = await import(
      "@/components/report/PersistedReportView"
    );
    expect(companyPersisted.type).toBe(PersistedReportView);

    const reportNode = invoke(companyPersisted);
    expect(reportNode.type).toBe(ReportView);
    expect(Object.keys(reportNode.props)).toEqual(["report"]);
    expect(elementsWithin(reportNode).some((element) => element.type === TechnicalsChartPanel)).toBe(false);
    expect(elementsWithin(reportNode).some((element) => element.type === FundamentalsChartGrid)).toBe(false);
  });

  it("owns the current bundle timestamp only inside live analysis", async () => {
    const companyTree = await CompanyBody({ symbol: "DEMO" });
    const tabs = elementsWithin(companyTree).find((element) => element.type === ReportTabs)!;
    const currentBundleLabel = "built 2026-08-07 00:00:00Z";

    expect(structuralText(tabs.props.analysis as ReactNode)).toContain(currentBundleLabel);
    expect(structuralText(companyTree)).not.toContain(currentBundleLabel);
    expect(structuralText(tabs.props.report as ReactNode)).not.toContain(currentBundleLabel);
  });

  it("keeps both current charts and their explicit as-of labels in live analysis", async () => {
    const companyTree = await CompanyBody({ symbol: "DEMO" });
    const tabs = elementsWithin(companyTree).find((element) => element.type === ReportTabs)!;
    const analysis = tabs.props.analysis as ReactNode;
    const panelElements = elementsWithin(analysis);
    const fundamentals = panelElements.find((element) => "chartData" in element.props)!;
    const technicals = panelElements.find((element) => "priceProps" in element.props)!;

    const fundamentalsRoot = invoke(fundamentals);
    const technicalsRoot = invoke(technicals);

    expect(elementsWithin(fundamentalsRoot).some((element) => element.type === FundamentalsChartGrid)).toBe(true);
    expect(elementsWithin(technicalsRoot).some((element) => element.type === TechnicalsChartPanel)).toBe(true);
    expect(renderToStaticMarkup(fundamentalsRoot.props.right as ReactElement)).toMatch(/as of.*2025-12-31/i);
    expect(renderToStaticMarkup(technicalsRoot.props.right as ReactElement)).toMatch(/as of.*2026-08-06/i);
  });
});
