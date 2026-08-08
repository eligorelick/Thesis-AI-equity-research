export type UnsupportedInstrumentKind = "etf" | "fund" | "etf-fund";

export type InstrumentSupport =
  | { supported: true; kind: "company" }
  | { supported: false; kind: UnsupportedInstrumentKind; reason: string };

export class UnsupportedInstrumentError extends Error {
  readonly support: Extract<InstrumentSupport, { supported: false }>;

  constructor(support: Extract<InstrumentSupport, { supported: false }>) {
    super(support.reason);
    this.name = "UnsupportedInstrumentError";
    this.support = support;
  }
}

const UNSUPPORTED_REASON: Record<UnsupportedInstrumentKind, string> = {
  etf: "ETF analysis is not supported; this research workflow analyzes individual companies only.",
  fund: "Fund analysis is not supported; this research workflow analyzes individual companies only.",
  "etf-fund":
    "ETF and fund analysis is not supported; this research workflow analyzes individual companies only.",
};

export function classifyInstrumentSupport(
  input: { isEtf?: boolean | null; isFund?: boolean | null } | null,
): InstrumentSupport {
  const isEtf = input?.isEtf === true;
  const isFund = input?.isFund === true;
  if (!isEtf && !isFund) return { supported: true, kind: "company" };

  const kind: UnsupportedInstrumentKind = isEtf && isFund ? "etf-fund" : isEtf ? "etf" : "fund";
  return { supported: false, kind, reason: UNSUPPORTED_REASON[kind] };
}
