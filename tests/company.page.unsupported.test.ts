import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pageHarness = vi.hoisted(() => ({
  bundle: null as unknown,
  runStageB: vi.fn(),
  generateReport: vi.fn(() => null),
  getLatestDoneReport: vi.fn(() => null),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/pipeline/dataBundle", () => ({
  buildDataBundle: vi.fn(async () => pageHarness.bundle),
}));
vi.mock("@/pipeline/stageA/validate", () => ({
  validateBundle: vi.fn(() => ({ checks: [], flags: [], gaps: [] })),
}));
vi.mock("@/pipeline/compute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/compute")>();
  return { ...actual, runStageB: pageHarness.runStageB };
});
vi.mock("@/report/query", () => ({
  getLatestDoneReport: pageHarness.getLatestDoneReport,
}));
vi.mock("@/app/company/[symbol]/GenerateReport", () => ({
  GenerateReport: pageHarness.generateReport,
}));

import { CompanyBody } from "@/app/company/[symbol]/page";

describe("company page — unsupported instruments", () => {
  beforeEach(() => {
    pageHarness.runStageB.mockClear();
    pageHarness.generateReport.mockClear();
    pageHarness.getLatestDoneReport.mockClear();
    pageHarness.bundle = {
      symbol: "SPY",
      builtAt: "2026-08-07T00:00:00.000Z",
      profile: {
        ok: true,
        value: {
          data: {
            rows: [
              {
                symbol: "SPY",
                companyName: "SPDR S&P 500 ETF Trust",
                isEtf: true,
                isFund: false,
              },
            ],
            raw: {},
          },
          asOf: "2026-08-07",
          source: "fmp",
          endpoint: "profile",
          fetchedAt: "2026-08-07T00:00:00.000Z",
          stale: false,
        },
      },
    };
  });

  it("renders the company-only explanation before Stage B, old reports, charts, or GenerateReport", async () => {
    const html = renderToStaticMarkup(await CompanyBody({ symbol: "SPY" }));

    expect(html).toMatch(/SPY/);
    expect(html).toMatch(/not supported/i);
    expect(html).toMatch(/individual compan/i);
    expect(pageHarness.runStageB).not.toHaveBeenCalled();
    expect(pageHarness.getLatestDoneReport).not.toHaveBeenCalled();
    expect(pageHarness.generateReport).not.toHaveBeenCalled();
  });
});
