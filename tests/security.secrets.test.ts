/**
 * Security regression (audit 2026-07-11 #8): API keys must never leak into a
 * persisted cache key, a provenance `endpoint` annotation, or any string the
 * report renders. FMP/Finnhub/FINRA use header auth and the query-string/cache-
 * key builders exclude the key; these tests pin that a future change which
 * accidentally threads an `apikey`-shaped param through cannot leak it into the
 * SQLite api_cache or the appendix sources.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EDGAR_USER_AGENT, resolveEdgarUserAgent } from "@/providers/edgar";
import { fmpQueryString, fmpCacheKey } from "@/providers/fmp";
import { YAHOO_DEFAULT_USER_AGENT } from "@/providers/yahoo";

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

/**
 * `EDGAR_CONTACT` is the operator's real name and email address, declared to
 * SEC for its fair-access policy. It is owed to SEC and to nobody else: the
 * data bundle used to put it in Yahoo's `User-Agent`, sending personal data to
 * a provider that never asked for it and that docs/PRIVACY.md does not list as
 * a recipient.
 */
describe("the declared EDGAR contact stays on the SEC channel", () => {
  const dataBundle = readFileSync(path.join(process.cwd(), "src", "pipeline", "dataBundle.ts"), "utf8");

  it("carries no personal identity in Yahoo's default User-Agent", () => {
    expect(YAHOO_DEFAULT_USER_AGENT).not.toContain("@");
    expect(YAHOO_DEFAULT_USER_AGENT).toMatch(/^Mozilla\/5\.0 /);
  });

  it("never threads the EDGAR contact into the Yahoo client", () => {
    // `createYahooClient({...})` in the bundle must configure no `userAgent` at
    // all, so the client's own neutral default applies — and the bundle must
    // not reach for the contact resolver anywhere.
    const call = /createYahooClient\(\{[\s\S]*?\n {4}\}\)/.exec(dataBundle)?.[0] ?? "";
    expect(call).not.toBe("");
    expect(call).not.toMatch(/userAgent/);
    expect(dataBundle).not.toMatch(/resolveEdgarUserAgent/);
  });

  it("still declares that contact to SEC", () => {
    expect(EDGAR_USER_AGENT).toBe(resolveEdgarUserAgent());
    expect(EDGAR_USER_AGENT.length).toBeGreaterThan(0);
  });
});
