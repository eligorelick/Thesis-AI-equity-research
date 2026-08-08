import { PassThrough } from "node:stream";
import { createElement } from "react";
import { renderToPipeableStream, renderToStaticMarkup } from "react-dom/server";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchlistRowView } from "@/watchlist/watchlist";

vi.mock("server-only", () => ({}));
vi.mock("@/config/env", () => ({
  getConfig: () => ({
    fixtureMode: true,
    hasFmpKey: false,
    hasFinnhubKey: false,
    hasFredKey: false,
    hasAnthropicKey: false,
  }),
}));
vi.mock("@/components/watchlist/AddTicker", () => ({ AddTicker: () => null }));
vi.mock("@/components/watchlist/RemoveButton", () => ({ RemoveButton: () => null }));
vi.mock("@/components/watchlist/RunsDisclosure", () => ({ RunsDisclosure: () => null }));

const WATCH_ROW = {
  symbol: "AAPL",
  companyName: "Apple Inc.",
  price: 211.5,
  changePct: 1.23,
  asOf: "2026-08-08",
  grades: {
    fundamentals: "A",
    valuation: "B",
    technicals: "C",
    balanceSheet: "D",
    quality: "F",
    leadership: "D",
    moat: "A",
  },
  lastReportAt: "2026-08-08T00:00:00.000Z",
  verificationRate: 0.9,
  nextEarnings: "2026-10-30",
  runs: [],
  gaps: [],
} as const satisfies WatchlistRowView;

function legacyGrades(): WatchlistRowView["grades"] {
  const grades: WatchlistRowView["grades"] = { ...WATCH_ROW.grades };
  delete grades.balanceSheet;
  return grades;
}

vi.mock("@/watchlist/watchlist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/watchlist/watchlist")>();
  return {
    ...actual,
    getWatchlistView: vi.fn(async () => [WATCH_ROW]),
  };
});

import Home from "@/app/page";
import { Sidebar } from "@/components/watchlist/Sidebar";
import { getWatchlistView } from "@/watchlist/watchlist";

const EXPECTED_TITLES = ["F: A", "V: B", "T: C", "BS: D", "Q: F", "L: D", "M: A"];

function expectCanonicalGradeTitles(html: string): void {
  let cursor = -1;
  for (const title of EXPECTED_TITLES) {
    const next = html.indexOf(`title="${title}"`, cursor + 1);
    expect(next, title).toBeGreaterThan(cursor);
    cursor = next;
  }
}

function renderAsync(node: ReturnType<typeof createElement>): Promise<string> {
  return new Promise((resolve, reject) => {
    let html = "";
    const destination = new PassThrough();
    destination.setEncoding("utf8");
    destination.on("data", (chunk: string) => { html += chunk; });
    destination.on("end", () => resolve(html));
    destination.on("error", reject);
    const stream = renderToPipeableStream(node, {
      onAllReady: () => stream.pipe(destination),
      onError: reject,
    });
  });
}

describe("manifest-driven watchlist renderers", () => {
  beforeEach(() => {
    vi.mocked(getWatchlistView).mockResolvedValue([WATCH_ROW]);
  });

  it("renders all seven persisted grades through the actual Sidebar in canonical order", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, {
      rows: [WATCH_ROW],
    }));
    expectCanonicalGradeTitles(html);
    expect(html.match(/title="BS: D"/g)).toHaveLength(1);
  });

  it("omits optional balance only for a legacy Sidebar row without a placeholder", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, {
      rows: [{ ...WATCH_ROW, grades: legacyGrades() }],
    }));
    expect(html).not.toContain("BS:");
    expect(html).not.toContain("balanceSheet");
    for (const title of EXPECTED_TITLES.filter((title) => !title.startsWith("BS:"))) {
      expect(html).toContain(`title="${title}"`);
    }
  });

  it("renders all seven grades through both actual Home watchlist surfaces", async () => {
    const html = await renderAsync(await Home());
    expect(html.match(/title="BS: D"/g) ?? []).toHaveLength(2);
    expect([...html.matchAll(/title="(F: A|V: B|T: C|BS: D|Q: F|L: D|M: A)"/g)]
      .map((match) => match[1])).toEqual([...EXPECTED_TITLES, ...EXPECTED_TITLES]);
  });

  it("renders a legacy Home through both surfaces without fabricating optional balance", async () => {
    vi.mocked(getWatchlistView).mockResolvedValue([{ ...WATCH_ROW, grades: legacyGrades() }]);
    const html = await renderAsync(await Home());
    expect(html).not.toContain("BS:");
    expect(html).not.toContain("balanceSheet");
    for (const title of EXPECTED_TITLES.filter((title) => !title.startsWith("BS:"))) {
      expect(html.match(new RegExp(`title="${title}"`, "g")) ?? []).toHaveLength(2);
    }
  });
});
