import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteMatcher } from "next/dist/shared/lib/router/utils/route-matcher";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";

const historyHarness = vi.hoisted(() => ({
  listReportsForSymbol: vi.fn(() => []),
  loadReportPairForSymbol: vi.fn(() => null),
  orderPairChronologically: vi.fn(),
  parseReportId: vi.fn((value: unknown) =>
    typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : null,
  ),
  getReportByIdForSymbol: vi.fn(() => null),
}));

vi.mock("@/report/history", () => historyHarness);

import HistoryPage from "@/app/company/[symbol]/history/page";
import DiffPage from "@/app/company/[symbol]/history/diff/page";
import RunReportPage from "@/app/company/[symbol]/report/[reportId]/page";
import PrintReportPage from "@/app/company/[symbol]/report/[reportId]/print/page";

interface PersistedRoute {
  name: string;
  run(routeSymbol: string): Promise<unknown>;
  expectCanonical(expected: string): void;
}

const routes: PersistedRoute[] = [
  {
    name: "history",
    run: (symbol) => HistoryPage({ params: Promise.resolve({ symbol }) }),
    expectCanonical: (expected) =>
      expect(historyHarness.listReportsForSymbol).toHaveBeenCalledWith(expected),
  },
  {
    name: "history diff",
    run: (symbol) =>
      DiffPage({
        params: Promise.resolve({ symbol }),
        searchParams: Promise.resolve({ a: "1", b: "2" }),
      }),
    expectCanonical: (expected) =>
      expect(historyHarness.loadReportPairForSymbol).toHaveBeenCalledWith(1, 2, expected),
  },
  {
    name: "saved report",
    run: (symbol) =>
      RunReportPage({ params: Promise.resolve({ symbol, reportId: "1" }) }),
    expectCanonical: (expected) =>
      expect(historyHarness.getReportByIdForSymbol).toHaveBeenCalledWith(1, expected),
  },
  {
    name: "print report",
    run: (symbol) =>
      PrintReportPage({
        params: Promise.resolve({ symbol, reportId: "1" }),
        searchParams: Promise.resolve({}),
      }),
    expectCanonical: (expected) =>
      expect(historyHarness.getReportByIdForSymbol).toHaveBeenCalledWith(1, expected),
  },
];

const invalidRouteSymbols = [
  ["decoded Unicode ß", "ß"],
  ["decoded Unicode ſ", "ſ"],
  ["decoded Unicode ﬀ", "ﬀ"],
  ["encoded residue from a double-encoded URL", "%41APL"],
  ["stray percent residue", "%"],
] as const;

const validRouteSymbols = [
  ["AAPL (including a decoded single-encoded URL)", "AAPL", "AAPL"],
  ["lowercase aapl", "aapl", "AAPL"],
  ["dot class brk.b", "brk.b", "BRK.B"],
  ["hyphen class bf-b", "bf-b", "BF-B"],
] as const;

describe("persisted company route symbol ingress", () => {
  it("models Next's single decode before page params reach the symbol boundary", () => {
    const match = getRouteMatcher(getRouteRegex("/company/[symbol]"));
    expect(match("/company/%41APL")).toEqual({ symbol: "AAPL" });
    expect(match("/company/%2541APL")).toEqual({ symbol: "%41APL" });
  });

  beforeEach(() => {
    historyHarness.listReportsForSymbol.mockClear();
    historyHarness.loadReportPairForSymbol.mockClear();
    historyHarness.orderPairChronologically.mockClear();
    historyHarness.parseReportId.mockClear();
    historyHarness.getReportByIdForSymbol.mockClear();
  });

  for (const route of routes) {
    describe(route.name, () => {
      it.each(invalidRouteSymbols)("rejects %s before any persisted read", async (_label, raw) => {
        await expect(route.run(raw)).rejects.toMatchObject({
          digest: "NEXT_HTTP_ERROR_FALLBACK;404",
        });
        expect(historyHarness.listReportsForSymbol).not.toHaveBeenCalled();
        expect(historyHarness.loadReportPairForSymbol).not.toHaveBeenCalled();
        expect(historyHarness.getReportByIdForSymbol).not.toHaveBeenCalled();
      });

      it.each(validRouteSymbols)("accepts %s as %s", async (_label, raw, expected) => {
        await expect(route.run(raw)).resolves.toBeDefined();
        route.expectCanonical(expected);
      });
    });
  }
});
