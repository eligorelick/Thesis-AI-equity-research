/**
 * Security regression (audit 2026-07-11 #8): API keys must never leak into a
 * persisted cache key, a provenance `endpoint` annotation, or any string the
 * report renders. FMP/Finnhub/FINRA use header auth and the query-string/cache-
 * key builders exclude the key; these tests pin that a future change which
 * accidentally threads an `apikey`-shaped param through cannot leak it into the
 * SQLite api_cache or the appendix sources.
 */
import { describe, expect, it } from "vitest";

import { fmpQueryString, fmpCacheKey } from "@/providers/fmp";

const SECRET = "sk-thesis-SUPERSECRET-0123456789";

describe("FMP cache keys / provenance never contain an API key (audit #8)", () => {
  it("fmpQueryString drops auth-like params so a key cannot enter a query string", () => {
    const qs = fmpQueryString({ symbol: "AAPL", period: "annual", apikey: SECRET });
    expect(qs).not.toContain(SECRET);
    expect(qs.toLowerCase()).not.toContain("apikey");
    // Legitimate params survive, deterministically ordered.
    expect(qs).toContain("symbol=AAPL");
    expect(qs).toContain("period=annual");
  });

  it("fmpQueryString drops every auth alias (api_key / token / apiKey / API_KEY)", () => {
    for (const key of ["api_key", "token", "apiKey", "API_KEY"]) {
      const qs = fmpQueryString({ symbol: "AAPL", [key]: SECRET });
      expect(qs).not.toContain(SECRET);
    }
  });

  it("fmpCacheKey never contains the key even if one is threaded through params", () => {
    const cacheKey = fmpCacheKey("profile", { symbol: "AAPL", apikey: SECRET });
    expect(cacheKey).not.toContain(SECRET);
    expect(cacheKey).toContain("fmp:/stable/profile");
  });
});
