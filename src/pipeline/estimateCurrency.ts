/**
 * The currency of an analyst estimate or a price target.
 *
 * FMP's /stable/analyst-estimates and /stable/price-target-consensus rows
 * carry no currency field, and FMP documents no convention for them: an
 * estimate for an ADR may be stated per ADR share in the listing currency or
 * in the issuer's reporting currency. A listing currency that happens to
 * match the statements' is therefore NOT evidence for an estimate — it would
 * only be a guess that turned out consistent. An estimate's currency is
 * established by its own row (a `reportedCurrency` or `currency` field) or by
 * a documented provider convention, and by nothing else; otherwise it is
 * unknown, and no calculation, registry record or verification uses it as
 * money.
 *
 * `ANALYST_ESTIMATE_PROVIDER_CONVENTION` is where a documented convention
 * would be recorded. There is none today.
 */
export const ANALYST_ESTIMATE_PROVIDER_CONVENTION: string | null = null;

function iso(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** The row's own currency, else the documented provider convention, else null. */
export function estimateCurrency(row: object | null | undefined): string | null {
  const fields = (row ?? {}) as { reportedCurrency?: unknown; currency?: unknown };
  return iso(fields.reportedCurrency) ?? iso(fields.currency) ?? ANALYST_ESTIMATE_PROVIDER_CONVENTION;
}
