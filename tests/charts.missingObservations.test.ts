import { isValidElement, type ReactNode } from "react";
import { Area, ComposedChart, Line } from "recharts";
import { describe, expect, it } from "vitest";

import { FcfChart, MarginTrendChart, RevenueTrendChart } from "@/components/charts/FundamentalsCharts";
import { ProjectionFanChart } from "@/components/charts/ProjectionFanChart";
import type { ProjectionSeries } from "@/report/schema";

// Inspect our chart boundary, without replacing Recharts or React. The props
// sent to Recharts determine whether its paths bridge unavailable observations.
function chartProps(node: ReactNode, type: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap((child) => chartProps(child, type));
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [
    ...(node.type === type ? [node.props as Record<string, unknown>] : []),
    ...chartProps(node.props.children, type),
  ];
}

describe("chart missing observations", () => {
  it("keeps missing fundamentals rows and does not bridge null growth, margin or conversion values", () => {
    const revenue = [
      { period: "2023-12-31", revenue: 10, yoyGrowthPct: 2 },
      { period: "2024-12-31", revenue: null, yoyGrowthPct: null },
      { period: "2025-12-31", revenue: 12, yoyGrowthPct: 3 },
    ];
    const margin = revenue.map((row) => ({ period: row.period,
      grossPct: row.revenue, operatingPct: row.revenue, netPct: row.revenue }));
    const fcf = revenue.map((row) => ({ period: row.period,
      fcf: row.revenue, conversionPct: row.yoyGrowthPct }));
    const charts = [RevenueTrendChart({ rows: revenue, currency: "USD" }),
      MarginTrendChart({ rows: margin }), FcfChart({ rows: fcf, currency: "USD" })];
    for (const chart of charts) {
      const lines = chartProps(chart, Line);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.connectNulls).not.toBe(true);
        // [known, missing, known] has no line segments; dots must retain the
        // isolated known observations rather than visually erasing them.
        expect(line.dot).toMatchObject({ r: 2 });
      }
      expect((chartProps(chart, ComposedChart)[0]!.data as unknown[])).toHaveLength(3);
    }
  });

  it("keeps wholly unavailable historical and forward projection periods as visible gaps", () => {
    const point = (period: string, value: number | null) => ({ period,
      value: { value, unit: "USD", source: "computed", asOf: "2025-12-31" } });
    const historical = [point("FY2023", 10), point("FY2024", null), point("FY2025", 12)];
    const forward = [point("FY2026", 14), point("FY2027", null), point("FY2028", 18)];
    const series = { metric: "revenue", unit: "USD", historical, bull: forward,
      base: forward, bear: forward, weighted: forward } as ProjectionSeries;
    const chart = ProjectionFanChart({ series });
    for (const path of [...chartProps(chart, Line), ...chartProps(chart, Area)]) {
      expect(path.connectNulls).not.toBe(true);
    }
    for (const line of chartProps(chart, Line)) expect(line.dot).toMatchObject({ r: 2 });
    const data = chartProps(chart, ComposedChart)[0]!.data as Array<Record<string, unknown>>;
    expect(data.map((row) => row.period)).toEqual(["FY2023", "FY2024", "FY2025", "FY2026", "FY2027", "FY2028"]);
    expect(data.find((row) => row.period === "FY2024")).toMatchObject({ hist: null, weighted: null, band: null });
    expect(data.find((row) => row.period === "FY2027")).toMatchObject({ hist: null, weighted: null, band: null });
  });
});
