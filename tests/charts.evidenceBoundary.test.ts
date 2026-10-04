import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PriceChart } from "@/components/charts/PriceChart";
import { RelativeStrengthChart } from "@/components/charts/RelativeStrengthChart";
import { preparePricePlotData, prepareRelativeStrengthPlotData } from "@/components/charts/plotData";

// Exercise actual component effects through a tiny canvas boundary, without a
// browser/canvas dependency. Pure preparation is not mocked or duplicated.
const recorded = vi.hoisted(() => ({ effects: [] as EffectCallback[], submissions: [] as Array<{ kind: string; points: unknown }> }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: EffectCallback) => { recorded.effects.push(effect); },
  useRef: (initial: unknown) => ({ current: initial ?? { clientWidth: 640 } }),
}));
vi.mock("lightweight-charts", () => ({
  CandlestickSeries: { name: "candles" }, HistogramSeries: { name: "volume" }, LineSeries: { name: "line" },
  ColorType: { Solid: "solid" }, CrosshairMode: { Normal: 0 }, LineStyle: { Dotted: 1, Dashed: 2 },
  createSeriesMarkers: vi.fn(),
  createChart: () => ({
    addSeries: (definition: { name: string }) => ({ setData: (points: unknown) => recorded.submissions.push({ kind: definition.name, points }) }),
    priceScale: () => ({ applyOptions: () => {} }), timeScale: () => ({ fitContent: () => {} }),
    applyOptions: () => {}, remove: () => {},
  }),
}));
beforeEach(() => {
  recorded.effects.length = 0; recorded.submissions.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());
function runEffects() {
  for (const effect of recorded.effects) { const dispose = effect(); if (typeof dispose === "function") dispose(); }
}

describe("actual chart setData boundary", () => {
  it("submits exactly the candles, volume and enabled SMA observations represented by the price table model", () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      open: i + 1, high: i + 3, low: i, close: i + 2.123456789, volume: i % 4 === 0 ? null : i }));
    renderToStaticMarkup(createElement(PriceChart, { rows })); runEffects();
    const model = preparePricePlotData(rows);
    expect(recorded.submissions[0]).toEqual({ kind: "candles", points: model.candles });
    const volume = recorded.submissions.find((item) => item.kind === "volume")!.points as Array<{ time: string; value: number }>;
    expect(volume.map(({ time, value }) => ({ time, value }))).toEqual(model.volume);
    expect(recorded.submissions.filter((item) => item.kind === "line").map((item) => item.points)).toEqual([model.sma50, model.sma200]);
  });
  it("submits the same sparse relative-strength values displayed at their actual baseline/date, skipping empty lines", () => {
    const series = [
      { label: "DEMO", rows: [{ date: "2026-01-01", close: 9 }, { date: "2026-01-05", close: 12 }] },
      { label: "BENCH", rows: [{ date: "2026-01-03", close: 10 }, { date: "2026-01-04", close: Number.NaN }, { date: "2026-01-05", close: 11 }] },
      { label: "legacy", rows: [] },
    ];
    renderToStaticMarkup(createElement(RelativeStrengthChart, { series })); runEffects();
    const model = prepareRelativeStrengthPlotData(series);
    expect(recorded.submissions.map((item) => item.points)).toEqual(model.series.filter((item) => item.data.length).map((item) => item.data));
    expect(model.series.map((item) => item.baseDate)).toEqual(["2026-01-05", "2026-01-03", null]);
    expect(model.rows.find((row) => row.date === "2026-01-04")!.values).toEqual([null, null, null]);
  });
});
