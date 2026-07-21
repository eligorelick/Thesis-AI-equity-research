"use client";

/**
 * Lazy (code-split) wrappers for the heavy client chart components. Importing
 * from HERE instead of the component modules directly keeps recharts (~100kb gz,
 * via FundamentalsCharts + ProjectionFanChart) and lightweight-charts (~45kb gz,
 * via TechnicalsChartPanel → PriceChart + RelativeStrengthChart) OUT of the
 * initial JS bundle of every page that shows a report. The libraries load on
 * demand when a chart actually mounts.
 *
 * `ssr: false` is safe for all three: they render nothing on the server anyway
 * (recharts' ResponsiveContainer measures its parent at mount; lightweight-charts
 * builds entirely inside useEffect), and the print / markdown export paths render
 * their own text and never touch these components. The only visible effect is a
 * brief loading skeleton, sized to the real chart to avoid layout shift.
 *
 * This module is a Client Component ("use client") because `next/dynamic` with
 * `{ ssr: false }` is illegal inside a Server Component in Next 16 — the server
 * pages import the already-wrapped components from here.
 */

import dynamic from "next/dynamic";

/** Neutral placeholder sized to the real chart, shown while its module loads. */
function ChartSkeleton({ height }: { height: number }) {
  return (
    <div
      className="animate-pulse border border-edge bg-raised"
      style={{ height }}
      aria-hidden
    />
  );
}

export const FundamentalsChartGrid = dynamic(
  () => import("./FundamentalsCharts").then((m) => m.FundamentalsChartGrid),
  { ssr: false, loading: () => <ChartSkeleton height={470} /> },
);

export const TechnicalsChartPanel = dynamic(
  () => import("./TechnicalsChartPanel").then((m) => m.TechnicalsChartPanel),
  { ssr: false, loading: () => <ChartSkeleton height={620} /> },
);

export const ProjectionFanChart = dynamic(
  () => import("./ProjectionFanChart").then((m) => m.ProjectionFanChart),
  { ssr: false, loading: () => <ChartSkeleton height={320} /> },
);
