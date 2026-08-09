/**
 * Dependency-free, context-specific Markdown serializers.
 *
 * Every function accepts raw report data. Callers must serialize exactly once
 * at the final Markdown context boundary; the functions are intentionally not
 * idempotent.
 */

const BIDI_AND_FORMAT_CONTROLS = new Set([
  0x061c,
  0x200e,
  0x200f,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
  0x206a,
  0x206b,
  0x206c,
  0x206d,
  0x206e,
  0x206f,
  0xfeff,
]);

const INLINE_ESCAPES = new Set([
  "\\",
  "`",
  "*",
  "_",
  "~",
  "[",
  "]",
  "<",
  ">",
  "&",
  "#",
  "@",
]);

const ACTIVE_SCHEME = /(?:https?|ftp|mailto|javascript|data|vbscript):/giu;
const BARE_WWW = /www\./giu;

function visibleToken(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

function canonicalizeRaw(raw: string): string {
  let output = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);

    if (code === 0x0d) {
      if (raw.charCodeAt(index + 1) === 0x0a) index += 1;
      output += " ";
      continue;
    }
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0b ||
      code === 0x0c ||
      code === 0x85 ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      output += " ";
      continue;
    }
    if (code === 0) {
      output += "\ufffd";
      continue;
    }
    if (
      (code >= 0x01 && code <= 0x08) ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f) ||
      BIDI_AND_FORMAT_CONTROLS.has(code)
    ) {
      output += visibleToken(code);
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = raw.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        output += raw[index] + raw[index + 1];
        index += 1;
      } else {
        output += visibleToken(code);
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      output += visibleToken(code);
      continue;
    }
    output += raw[index];
  }
  return output;
}

function structuralEscapeIndexes(value: string): Set<number> {
  const indexes = new Set<number>();
  const indent = value.match(/^ {0,3}/)?.[0].length ?? 0;
  const rest = value.slice(indent);

  if (/^(?:[-+](?:\s|$)|\d{1,9}[.)](?:\s|$))/u.test(rest)) {
    const marker = rest.match(/^(?:[-+]|\d{1,9}([.)]))/u)?.[0] ?? "";
    const punctuationOffset = /^\d/u.test(marker) ? marker.length - 1 : 0;
    indexes.add(indent + punctuationOffset);
  }
  if (/^=+\s*$/u.test(rest)) indexes.add(indent);
  if (/^-+\s*$/u.test(rest) || /^(?:-\s*){3,}$/u.test(rest)) indexes.add(indent);

  return indexes;
}

function inlineEscape(raw: string, tableCell: boolean): string {
  let value = canonicalizeRaw(raw);
  if (!tableCell && /[^ ] {2,}$/u.test(value)) {
    value = `${value.slice(0, -1)}\u00a0`;
  }
  if (/^ {4}/u.test(value)) value = `\u00a0${value.slice(1)}`;

  const extraEscapes = structuralEscapeIndexes(value);
  for (const match of value.matchAll(ACTIVE_SCHEME)) {
    extraEscapes.add(match.index + match[0].length - 1);
  }
  for (const match of value.matchAll(BARE_WWW)) {
    extraEscapes.add(match.index + match[0].length - 1);
  }

  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (INLINE_ESCAPES.has(char) || extraEscapes.has(index) || (tableCell && char === "|")) {
      output += "\\";
    }
    output += char;
  }
  return tableCell ? output.trim() : output;
}

export function markdownProse(raw: string): string {
  return inlineEscape(raw, false);
}

export function markdownHeading(raw: string): string {
  return inlineEscape(raw, false);
}

export function markdownListItem(raw: string): string {
  return inlineEscape(raw, false);
}

export function markdownBlockquote(raw: string): string {
  return inlineEscape(raw, false);
}

export function markdownTableCell(raw: string): string {
  return inlineEscape(raw, true);
}

export function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const head = `| ${headers.map(markdownTableCell).join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.length === 0
    ? [`| ${headers.map((_, index) => index === 0 ? "—" : "").join(" | ")} |`]
    : rows.map((row) => `| ${row.map(markdownTableCell).join(" | ")} |`);
  return [head, separator, ...body].join("\n");
}

export function markdownCodeSpan(raw: string): string {
  const value = canonicalizeRaw(raw);
  const longestRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/gu), (match) => match[0].length),
  );
  const fence = "`".repeat(longestRun + 1);
  if (value.length === 0) return `${fence} ${fence}`;

  const allSpaces = !/[^ ]/u.test(value);
  const needsPadding =
    value.startsWith("`") ||
    value.endsWith("`") ||
    (!allSpaces && value.startsWith(" ") && value.endsWith(" "));
  return needsPadding
    ? `${fence} ${value} ${fence}`
    : `${fence}${value}${fence}`;
}

export function markdownSourceLabel(raw: string): string {
  return markdownCodeSpan(raw);
}
