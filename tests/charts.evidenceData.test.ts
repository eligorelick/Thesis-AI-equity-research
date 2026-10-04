// Numeric chart/table preparation contract; preserves exact plotted values.
import { describe, expect, it } from "vitest";
import { preparePricePlotData, prepareRelativeStrengthPlotData } from "@/components/charts/plotData";

describe("one numeric model for plot and accessible data", () => {
  it("normalizes date/time aliases, excludes nonfinite OHLC, and never mutates the supplied bars", () => {
    const rows = [
      { time: "2026-01-03T14:30:00Z", open: 2, high: 4, low: 1, close: 3, volume: Number.NaN },
      { date: "2026-01-02", open: 1, high: 3, low: 0, close: 2, volume: 10 },
      { date: "2026-01-04", open: Number.NaN, high: 4, low: 1, close: 3, volume: 20 },
      { open: 1, high: 3, low: 0, close: 2, volume: 10 },
    ];
    const before = structuredClone(rows);
    const model = preparePricePlotData(rows);
    expect(model.rows.map((r) => r.date)).toEqual(["2026-01-02", "2026-01-03"]);
    expect(model.rows.map((r) => r.volume)).toEqual([10, null]);
    expect(rows).toEqual(before);
    expect(preparePricePlotData([]).rows).toEqual([]);
  });
  it("retains exact OHLC and valid zero volume; omits invalid volume without losing candles", () => {
    const model = preparePricePlotData([
      { date: "2026-01-03", open: 12.123456789, high: 14, low: 10, close: 13, volume: null },
      { date: "2026-01-02", open: 10, high: 12, low: 9, close: 11, volume: 0 },
      { date: "2026-01-02", open: 10, high: 13, low: 9, close: 12, volume: 0 },
      { date: "bad-date", open: 999, high: 999, low: 999, close: 999, volume: 999 },
      { date: "2026-01-04", open: 13, high: 15, low: 12, close: 14, volume: -1 },
    ], { showSma50: false, showSma200: false });
    expect(model.candles).toEqual([
      { time: "2026-01-02", open: 10, high: 13, low: 9, close: 12 },
      { time: "2026-01-03", open: 12.123456789, high: 14, low: 10, close: 13 },
      { time: "2026-01-04", open: 13, high: 15, low: 12, close: 14 },
    ]);
    expect(model.volume).toEqual([{ time: "2026-01-02", value: 0 }]);
    expect(model.rows.map((r) => r.volume)).toEqual([0, null, null]);
    for (const row of model.rows) {
      const candle = model.candles.find((point) => point.time === row.date)!;
      expect([row.open, row.high, row.low, row.close]).toEqual([candle.open, candle.high, candle.low, candle.close]);
      expect(row.volume).toBe(model.volume.find((point) => point.time === row.date)?.value ?? null);
    }
  });
  it("shows enabled SMA values from the exact submitted series and unavailable warm-up cells", () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      open: i + 1, high: i + 2, low: i, close: i + 1, volume: i }));
    const model = preparePricePlotData(rows, { showSma50: true, showSma200: true });
    expect(model.rows[48]!.sma50).toBeNull();
    expect(model.rows[49]!.sma50).toBe(25.5);
    expect(model.rows[198]!.sma200).toBeNull();
    expect(model.rows[199]!.sma200).toBe(100.5);
    for (const row of model.rows) {
      expect(row.sma50).toBe(model.sma50.find((point) => point.time === row.date)?.value ?? null);
      expect(row.sma200).toBe(model.sma200.find((point) => point.time === row.date)?.value ?? null);
    }
  });
  it("aligns exact relative-strength observations by date, preserves unavailable cells, and names actual bases", () => {
    const series = [
      { label: "DEMO", rows: [{ date: "2026-01-01", close: 40 }, { date: "2026-01-03", close: 60 }] },
      { label: "BENCH", rows: [{ date: "2025-12-31", close: 100 }, { date: "2026-01-01", close: 200 },
        { date: "2026-01-02", close: 220 }, { date: "2026-01-03", close: Number.NaN }] },
      { label: "no history", rows: [] },
    ];
    const model = prepareRelativeStrengthPlotData(series);
    expect(model.startDate).toBe("2026-01-01");
    expect(model.series.map((s) => s.baseDate)).toEqual(["2026-01-01", "2026-01-01", null]);
    expect(model.rows.map((r) => r.date)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(model.rows.find((r) => r.date === "2026-01-03")!.values).toEqual([150, null, null]);
    expect(model.rows.find((r) => r.date === "2026-01-02")!.values[0]).toBeNull();
    for (const row of model.rows) model.series.forEach((s, i) => {
      expect(row.values[i]).toBe(s.data.find((point) => point.time === row.date)?.value ?? null);
    });
    expect(model.rows.some((r) => r.date === "2025-12-31")).toBe(false);
  });
  it("does not claim a baseline quote on a date absent from one series", () => {
    const model = prepareRelativeStrengthPlotData([
      { label: "sparse", rows: [{ date: "2026-01-01", close: 50 }, { date: "2026-01-05", close: 75 }] },
      { label: "later", rows: [{ date: "2026-01-03", close: 100 }, { date: "2026-01-05", close: 110 }] },
    ]);
    expect(model.startDate).toBe("2026-01-03");
    expect(model.series.map((s) => s.baseDate)).toEqual(["2026-01-05", "2026-01-03"]);
    expect(model.rows.find((r) => r.date === "2026-01-03")!.values[0]).toBeNull();
  });
  it("returns no fabricated observations for wholly unusable histories", () => {
    const model = prepareRelativeStrengthPlotData([{ label: "legacy", rows: [{ date: "2026-01-01", close: 0 }] }]);
    expect(model.startDate).toBeNull();
    expect(model.series[0]!.baseDate).toBeNull();
    expect(model.series[0]!.data).toEqual([]);
    expect(model.rows.every((row) => row.values.every((v) => v === null))).toBe(true);
  });
  it("retains chart sorting/deduplication and actual index arithmetic without mutating source rows", () => {
    const rows = [{ date: "2026-01-03", close: 12 }, { date: "bad", close: 999 },
      { date: "2026-01-01T00:00:00Z", close: 8 }, { date: "2026-01-01", close: 9 }];
    const before = structuredClone(rows);
    const model = prepareRelativeStrengthPlotData([{ label: "duplicate", rows }]);
    expect(model.series[0]!.data).toEqual([{ time: "2026-01-01", value: 100 }, { time: "2026-01-03", value: 12 / 9 * 100 }]);
    expect(model.rows[1]!.values).toEqual([12 / 9 * 100]);
    expect(rows).toEqual(before);
    expect(prepareRelativeStrengthPlotData([])).toEqual({ startDate: null, series: [], rows: [] });
  });
});
