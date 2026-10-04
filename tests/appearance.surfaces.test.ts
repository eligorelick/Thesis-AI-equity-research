import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import RootLayout from "@/app/layout";
import { UiDesignProvider } from "@/appearance/UiDesignProvider";
import { AppearanceSettings, AppearanceSettingsView } from "@/app/settings/AppearanceSettings";
import { ReportView } from "@/components/report/ReportView";
import { chartPalette } from "@/components/charts/palette";
import { resolveSeriesColors } from "@/components/charts/RelativeStrengthChart";
import { toVolumeHistogramData } from "@/components/charts/PriceChart";
import { task28SentinelReport } from "./helpers/task28Report";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

describe("appearance surfaces", () => {
  beforeEach(() => {
    vi.mocked(cookies).mockResolvedValue({ get: () => undefined } as unknown as Awaited<ReturnType<typeof cookies>>);
  });

  it.each([undefined, "bad; unsafe=1", "workspace"])("aligns SSR body and selected design for cookie %s", async (value) => {
    vi.mocked(cookies).mockResolvedValue({ get: () => value === undefined ? undefined : { value } } as unknown as Awaited<ReturnType<typeof cookies>>);
    const html = renderToStaticMarkup(await RootLayout({ children: createElement(AppearanceSettings) }));
    const expected = value === "workspace" ? "workspace" : "current";
    expect(html).toContain(`data-ui-design="${expected}"`);
    expect(html).toMatch(new RegExp(`checked="" value="${expected}"`));
    expect(html).not.toContain("unsafe=1");
  });

  it("announces visit-only behavior when the browser cannot save", () => {
    const html = renderToStaticMarkup(createElement(AppearanceSettingsView, {
      design: "workspace", saved: false, onChange: () => {},
    }));
    expect(html).toContain('role="status"');
    expect(html).toMatch(/applied for this visit/i);
    expect(html).toMatch(/reload may restore/i);
    expect(html).not.toContain("Applied and saved");
  });

  it("preserves Current report markup without a rail, and adds recorded evidence only in workspace", () => {
    const report = task28SentinelReport();
    report.meta.asOfMap = { "quote-observed": "2025-12-31" };
    report.appendix.missingData = [{ field: "fixture.reserved(DEMO)", severity: "info", reason: "Synthetic omission", expected: true }];
    const current = renderToStaticMarkup(createElement(ReportView, { report }));
    const workspace = renderToStaticMarkup(createElement(UiDesignProvider, { initialDesign: "workspace" }, createElement(ReportView, { report })));
    expect(current).not.toContain('aria-label="Report evidence and gaps"');
    expect(workspace).toContain('aria-label="Report evidence and gaps"');
    expect(workspace).toContain("Recorded gaps (1)");
    expect(workspace).toContain("expected omission");
    expect(workspace).toContain("quote-observed");
    expect(workspace).toContain("2025-12-31");
    expect(workspace).toMatch(/traceability, not correctness/);
    expect(workspace).toContain('href="#report-appendix"');
  });

  it("changes canvas colors without changing financial points or the Current default", () => {
    const bars = [{ date: "2025-12-31", open: 39, high: 41, low: 38, close: 40, volume: 123 }];
    const current = toVolumeHistogramData(bars);
    const workspace = toVolumeHistogramData(bars, chartPalette("workspace"));
    expect(current).toEqual([{ time: "2025-12-31", value: 123, color: "#2ecc8f55" }]);
    expect(workspace).toEqual([{ time: "2025-12-31", value: 123, color: "#17624b55" }]);
    const series = [{ label: "DEMO", rows: [{ date: "2025-12-31", close: 40 }] }];
    expect(resolveSeriesColors(series)[0]!.color).toBe("#3ba7f5");
    expect(resolveSeriesColors(series, chartPalette("workspace"))[0]).toEqual({ ...series[0], color: "#0b6671" });
  });
});
