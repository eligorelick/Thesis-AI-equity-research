/**
 * Reserved fixture symbols (D-11).
 *
 * `DEMO` and `DBNK` are the two fictional issuers the app ships fixtures for.
 * They are RESERVED: no provider is ever asked about them — not FMP, not SEC
 * EDGAR, not Yahoo, FRED, Finnhub or FINRA — whatever keys are configured.
 *
 * Before this rule they were only "fixtures while no FMP key is set", which had
 * two consequences. A fixture run still sent the synthetic CIK `0000000000` to
 * data.sec.gov on every report, and a run WITH an FMP key sent the names to a
 * paid vendor and rendered whatever came back — so if a real ticker `DEMO` or
 * `DBNK` were ever listed, a demo report would silently become a report about
 * that company. Reserving the two strings makes that collision impossible by
 * construction rather than by the absence of a key.
 *
 * Pure: no network, no environment, no imports beyond the manifest type.
 */

import type { ManifestEntry } from "@/types/core";

/** The reserved strings, uppercase and canonical. */
export const RESERVED_FIXTURE_SYMBOLS = ["DEMO", "DBNK"] as const;

export type ReservedFixtureSymbol = (typeof RESERVED_FIXTURE_SYMBOLS)[number];

const RESERVED = new Set<string>(RESERVED_FIXTURE_SYMBOLS);

/** True for a reserved fixture symbol, in any spelling or casing. */
export function isReservedFixtureSymbol(symbol: string | null | undefined): boolean {
  return typeof symbol === "string" && RESERVED.has(symbol.trim().toUpperCase());
}

/** True when any of the symbols in a multi-symbol request is reserved. */
export function anyReservedFixtureSymbol(symbols: readonly (string | null | undefined)[]): boolean {
  return symbols.some((symbol) => isReservedFixtureSymbol(symbol));
}

/** The providers a reserved symbol short-circuits, named in the disclosure. */
export const RESERVED_SHORT_CIRCUITED_PROVIDERS = [
  "fmp",
  "edgar",
  "yahoo",
  "fred",
  "finnhub",
  "finra",
] as const;

export const RESERVED_FIXTURE_MANIFEST_FIELD = "fixture.reserved";

/**
 * The manifest entry every reserved-symbol run carries. `info` and `expected`:
 * serving a reserved symbol from fixtures is the designed behaviour, not an
 * incident, but a reader still has to be told that none of these figures came
 * from a provider.
 */
export function reservedFixtureManifestEntry(symbol: string): ManifestEntry {
  const sym = symbol.trim().toUpperCase();
  return {
    field: `${RESERVED_FIXTURE_MANIFEST_FIELD}(${sym})`,
    reason:
      `${sym} is a reserved fixture symbol: it is served entirely from the synthetic contract fixtures in ` +
      `fixtures/fmp and no request was made to ${RESERVED_SHORT_CIRCUITED_PROVIDERS.join(", ")}, whatever API keys are ` +
      "configured. Every figure in this report is invented demonstration data for a fictional issuer, and the reserved " +
      "strings cannot resolve to a real ticker.",
    severity: "info",
    attemptedSources: [`fixture:fixtures/fmp/**/${sym}.json`],
    expected: true,
  };
}

/** The gap a short-circuited provider member carries, naming the reserved rule. */
export function reservedProviderGap(field: string, symbol: string, attemptedSources?: string[]): ManifestEntry {
  const sym = symbol.trim().toUpperCase();
  const gap: ManifestEntry = {
    field,
    reason: `${sym} is a reserved fixture symbol — no provider request was made (D-11); this member has no fixture, so it is disclosed absent`,
    severity: "info",
    expected: true,
  };
  if (attemptedSources !== undefined) gap.attemptedSources = attemptedSources;
  return gap;
}
