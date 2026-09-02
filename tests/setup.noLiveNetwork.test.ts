/**
 * Pins the global no-live-network guard (`tests/setup/noLiveNetwork.ts`), which
 * every vitest config installs through `setupFiles`. The pass-through cases use
 * a stub in place of the real fetch so the assertions never open a socket.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  createNoLiveNetworkFetch,
  isLoopbackUrl,
  installNoLiveNetworkGuard,
} from "./setup/noLiveNetwork";

type FetchFn = typeof globalThis.fetch;

function stubFetch(): { fn: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fn = ((input: Parameters<FetchFn>[0]) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response("stub"));
  }) as FetchFn;
  return { fn, calls };
}

describe("no-live-network guard", () => {
  const originalSmoke = process.env.EDGAR_LIVE_SMOKE;

  afterEach(() => {
    if (originalSmoke === undefined) delete process.env.EDGAR_LIVE_SMOKE;
    else process.env.EDGAR_LIVE_SMOKE = originalSmoke;
  });

  it("rejects a non-loopback request naming the method and URL", async () => {
    const { fn, calls } = stubFetch();
    const guarded = createNoLiveNetworkFetch(fn);
    await expect(guarded("https://example.invalid/quote?symbol=AAPL")).rejects.toThrow(
      "live network is disabled in the test suite: GET https://example.invalid/quote?symbol=AAPL",
    );
    expect(calls).toEqual([]);
  });

  it("names the request method from a Request object", async () => {
    const { fn } = stubFetch();
    const guarded = createNoLiveNetworkFetch(fn);
    await expect(
      guarded(new Request("https://query1.finance.yahoo.com/v8/finance/chart/AAPL", { method: "POST" })),
    ).rejects.toThrow(
      "live network is disabled in the test suite: POST https://query1.finance.yahoo.com/v8/finance/chart/AAPL",
    );
  });

  it("passes a 127.0.0.1 URL through to the underlying fetch", async () => {
    const { fn, calls } = stubFetch();
    const guarded = createNoLiveNetworkFetch(fn);
    const res = await guarded("http://127.0.0.1:3000/api/report");
    expect(await res.text()).toBe("stub");
    expect(calls).toEqual(["http://127.0.0.1:3000/api/report"]);
  });

  it("treats localhost and ::1 as loopback and everything else as live", () => {
    expect(isLoopbackUrl("http://localhost:3000/x")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:3000/x")).toBe(true);
    expect(isLoopbackUrl("http://LOCALHOST/x")).toBe(true);
    expect(isLoopbackUrl("https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json")).toBe(false);
    // Fails closed: an unparseable target is not waved through.
    expect(isLoopbackUrl("/api/report")).toBe(false);
    expect(isLoopbackUrl("http://localhost.evil.example/x")).toBe(false);
  });

  it("stands aside when the EDGAR live smoke opt-in is set", async () => {
    process.env.EDGAR_LIVE_SMOKE = "1";
    const { fn, calls } = stubFetch();
    const guarded = createNoLiveNetworkFetch(fn);
    await guarded("https://www.sec.gov/cgi-bin/browse-edgar");
    expect(calls).toEqual(["https://www.sec.gov/cgi-bin/browse-edgar"]);
  });

  it("is installed on globalThis and installs at most once", async () => {
    const installed = globalThis.fetch;
    await expect(globalThis.fetch("https://example.invalid/")).rejects.toThrow(
      "live network is disabled in the test suite",
    );
    installNoLiveNetworkGuard();
    expect(globalThis.fetch).toBe(installed);
  });
});
