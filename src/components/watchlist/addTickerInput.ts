import { normalizeSymbol } from "@/symbol";

export type TickerSubmissionPreparation =
  | { ok: true; symbol: string }
  | { ok: false; error: string };

/** Validate client input without case-folding an invalid Unicode ticker. */
export function prepareTickerSubmission(raw: string): TickerSubmissionPreparation {
  const symbol = normalizeSymbol(raw);
  return symbol === null
    ? { ok: false, error: "invalid ticker symbol" }
    : { ok: true, symbol };
}
