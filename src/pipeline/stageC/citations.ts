/** Canonical citation identity used at Stage C boundaries. */
export interface CitationRef {
  sourceId: string;
  asOf: string | null;
}

export interface CitationCarrier {
  sourceId?: string | null;
  /** Legacy persisted field. */
  source?: string | null;
  asOf?: string | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEPARATOR = " · ";

function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day)
  );
}

function normalizeSourceId(value: string): string | null {
  const sourceId = value.trim();
  if (!sourceId || sourceId.includes("·") || /[\[\]\r\n]/.test(sourceId)) return null;
  return sourceId;
}

/** Render a citation once. Dates remain a separate field in structured JSON. */
export function serializeCitationRef(ref: CitationRef): string {
  const sourceId = normalizeSourceId(ref.sourceId);
  if (sourceId === null) throw new TypeError("Invalid citation sourceId");
  if (ref.asOf !== null && !isIsoDate(ref.asOf)) {
    throw new TypeError("Invalid citation asOf date");
  }
  return `[${sourceId}${ref.asOf === null ? "" : `${SEPARATOR}${ref.asOf}`}]`;
}

/**
 * Strict compatibility parser for legacy rendered citation tokens. It accepts
 * a bare source id, or exactly one source/date pair, and refuses ambiguity.
 */
export function parseCitationRef(value: string): CitationRef | null {
  let raw = value.trim();
  const starts = raw.startsWith("[");
  const ends = raw.endsWith("]");
  if (starts !== ends) return null;
  if (starts && ends) raw = raw.slice(1, -1).trim();
  if (!raw || raw.includes("[") || raw.includes("]")) return null;

  const parts = raw.split(SEPARATOR);
  if (parts.length === 1) {
    const sourceId = normalizeSourceId(parts[0]);
    return sourceId === null ? null : { sourceId, asOf: null };
  }
  if (parts.length !== 2) return null;
  const sourceId = normalizeSourceId(parts[0]);
  const asOf = parts[1].trim();
  if (sourceId === null || !isIsoDate(asOf)) return null;
  return { sourceId, asOf };
}

/** Read a new structured source id or an unambiguous legacy source field. */
export function citationSourceId(value: CitationCarrier): string | null {
  if (typeof value.sourceId === "string") return normalizeSourceId(value.sourceId);
  if (typeof value.source !== "string") return null;
  const parsed = parseCitationRef(value.source);
  if (parsed === null) return null;
  if (parsed.asOf !== null && value.asOf != null && parsed.asOf !== value.asOf) return null;
  return parsed.sourceId;
}

/** Resolve the independent as-of field without duplicating a rendered token. */
export function citationAsOf(value: CitationCarrier): string | null {
  if (value.asOf != null) return isIsoDate(value.asOf) ? value.asOf : null;
  if (typeof value.source !== "string") return null;
  return parseCitationRef(value.source)?.asOf ?? null;
}

/**
 * Correct the one legacy display defect that is deterministic: the same ISO
 * date rendered twice inside a bracketed citation. Different or malformed
 * dates remain untouched because choosing between them would be ambiguous.
 */
export function collapseDuplicateLegacyCitationDates(value: string): string {
  return value.replace(
    /\[([^\[\]\r\n·]+?)\s+·\s+(\d{4}-\d{2}-\d{2})\s+·\s+\2\]/g,
    (match, sourceId: string, asOf: string) => {
      if (!isIsoDate(asOf)) return match;
      const normalized = normalizeSourceId(sourceId);
      return normalized === null ? match : serializeCitationRef({ sourceId: normalized, asOf });
    },
  );
}
