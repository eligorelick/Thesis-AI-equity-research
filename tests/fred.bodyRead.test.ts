import { describe, expect, it, vi } from "vitest";

import { series } from "@/providers/fred";

/**
 * A mid-body failure — the per-attempt timeout aborting after headers arrive,
 * a connection reset while streaming, a decompression error — must behave like
 * the transport failure it is. `finnhubRequest` and `finraRequest` both retry
 * on an unreadable body; FRED must not silently convert one into a successful
 * empty response, because that skips the retries AND, on the keyed path,
 * strands the request before the keyless fredgraph.csv fallback.
 */
function unreadableBody(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => {
      throw new Error("body unavailable");
    },
  } as unknown as Response;
}

function csvResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/csv" },
  });
}

const NO_THROTTLE = { minRequestIntervalMs: 0, timeoutMs: 0 } as const;

describe("FRED unreadable response bodies", () => {
  it("retries a mid-body read failure instead of accepting an empty success", async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      if (fetchImpl.mock.calls.length === 1) return unreadableBody();
      return csvResponse(
        `observation_date,DGS10\n2026-08-28,4.25\n`.replace("DGS10", String(input).includes("id=") ? "DGS10" : "DGS10"),
      );
    });

    const result = await series(
      "DGS10",
      {},
      { ...NO_THROTTLE, retryDelaysMs: [0], fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true });
  });

  it("falls back to keyless fredgraph.csv when the keyed body cannot be read", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("api.stlouisfed.org")) return unreadableBody();
      return csvResponse(`observation_date,DGS10\n2026-08-28,4.25\n`);
    });

    const result = await series(
      "DGS10",
      {},
      {
        ...NO_THROTTLE,
        apiKey: "FRED-KEY",
        retryDelaysMs: [],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(urls.some((u) => u.includes("fredgraph.csv"))).toBe(true);
    expect(result).toMatchObject({ ok: true });
  });

  it("propagates a caller abort that surfaces as an unreadable body", async () => {
    const abort = new AbortController();
    const fetchImpl = vi.fn(async () => {
      abort.abort(new Error("job cancelled"));
      return unreadableBody();
    });

    await expect(
      series(
        "DGS10",
        {},
        {
          ...NO_THROTTLE,
          retryDelaysMs: [],
          signal: abort.signal,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/job cancelled/);
  });
});
