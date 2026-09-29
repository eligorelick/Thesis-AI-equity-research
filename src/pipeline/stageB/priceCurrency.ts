/**
 * Whether a statement-derived value may be set against the quote.
 *
 * A per-share intrinsic value, earnings, book value, FFO or a debt balance is
 * in the statements' currency; a price or a market capitalisation is in the
 * listing (quote) currency. Setting one against the other — an upside, a
 * price multiple, a reverse valuation, a market-value weight — is only a
 * figure when both are in ONE KNOWN currency. Different currencies would need
 * an FX rate, which is never invented here; an unknown currency on either side
 * leaves the comparison unproven. Either way the comparison is withheld, and
 * everything that does not touch the quote stays.
 */
export type PriceComparison =
  | { comparable: true; currency: string }
  | { comparable: false; mismatch: boolean; reason: string };

function iso(value: string | null | undefined): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export function comparePriceCurrency(
  statementsCurrency: string | null | undefined,
  quoteCurrency: string | null | undefined,
): PriceComparison {
  const statements = iso(statementsCurrency);
  const quote = iso(quoteCurrency);
  if (statements !== null && quote !== null) {
    return statements === quote
      ? { comparable: true, currency: statements }
      : {
          comparable: false,
          mismatch: true,
          reason: `statements in ${statements}, quote in ${quote} — no FX conversion is attempted`,
        };
  }
  return {
    comparable: false,
    mismatch: false,
    reason:
      statements === null && quote === null
        ? "statements' currency unknown and quote currency unknown"
        : statements === null
          ? `statements' currency unknown (quote in ${quote})`
          : `quote currency unknown (statements in ${statements})`,
  };
}
