/** Shared lexical validation for user/provider ticker symbols. */
export const SYMBOL_MAX_LENGTH = 12;
// Tickers may contain internal dots/hyphens (BRK.B, BF-B), but cannot begin
// or end with punctuation. This excludes path-like values such as . and ...
export const SYMBOL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,10}[A-Za-z0-9])?$/;

export function isValidSymbol(value: string): boolean {
  const symbol = value.trim();
  return symbol.length <= SYMBOL_MAX_LENGTH && SYMBOL_PATTERN.test(symbol);
}
