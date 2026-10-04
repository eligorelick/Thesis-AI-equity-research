import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { RemoveButtonView, requestWatchlistRemoval } from "@/components/watchlist/RemoveButton";

describe("watchlist remove feedback", () => {
  it.each([403, 500])("rejects HTTP %i with a safe, actionable removal error", async (status) => {
    const request = async () => new Response("private server detail", { status });
    await expect(requestWatchlistRemoval("DEMO", request)).rejects.toThrow(/DEMO.*try again/i);
  });

  it("replaces transport details with the same actionable removal error", async () => {
    const request = async () => { throw new Error("private transport detail"); };
    await expect(requestWatchlistRemoval("DBNK", request)).rejects.toThrow(/DBNK.*try again/i);
  });

  it("sends the selected symbol to the deletion boundary and accepts success", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const request: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(null, { status: 204 });
    };
    await expect(requestWatchlistRemoval("DEMO", request)).resolves.toBeUndefined();
    expect(calls).toEqual([{ input: "/api/watchlist", init: {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: '{"symbol":"DEMO"}',
    } }]);
  });

  it("renders announced failure feedback while leaving removal available to retry", () => {
    const html = renderToStaticMarkup(createElement(RemoveButtonView, {
      symbol: "DEMO", busy: false, error: "Could not remove DEMO. Try again.", onRemove: () => {},
    }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not remove DEMO");
    expect(html).toContain('aria-label="remove DEMO"');
    expect(html).not.toContain("disabled");
  });

  it("disables duplicate removal while a request or refresh is pending", () => {
    const html = renderToStaticMarkup(createElement(RemoveButtonView, {
      symbol: "DEMO", busy: true, error: null, onRemove: () => {},
    }));
    expect(html).toContain("disabled");
    expect(html).not.toContain('role="alert"');
  });
});
