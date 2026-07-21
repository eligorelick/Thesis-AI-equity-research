/**
 * 10-K / 10-Q section extraction — the 4-layer algorithm.
 *
 * Research basis (live-verified across AAPL, JPM, BAC, WFC, C, MXC, FRD,
 * Seneca; failure modes F1–F25):
 *   - the EDGAR extraction contract §3
 *   - the EDGAR extraction contract §3.4 (layered decision rule)
 *   - the bank-filing extraction contract §2 (bank modes, F15–F25)
 *
 * Layers:
 *   0. Citi mode — zero item headers anywhere; FORM 10-K CROSS-REFERENCE INDEX
 *      maps items → page ranges (possibly NON-contiguous); slice via the
 *      contents TOC whose link text is the page number (F20/F21).
 *   1. Row-scoped TOC-anchor slicing — merge fragmented adjacent same-href <a>
 *      runs (F1), dedupe shared targets (F2), bind item-number cell to the row
 *      title link (F3); targets may be <div id>, <span id> or <a name>.
 *   2. Hardened header regex on stripped text — optional interposed run before
 *      the title (BAC F15), cross-reference rejection (F7/F7b/F16), monotonic
 *      item ordering; LAST surviving match.
 *   3. MANDATORY stub detector (<2,500 chars OR incorporation phrasing in the
 *      first 400 chars) with redirects: same-doc mini-TOC (JPM), exhibit
 *      redirect signal targeting EX-13* (WFC/FRD; MD&A synonym "Financial
 *      Review"; quoted section names parsed from the stub), 10-Q Part II
 *      Item 1A → unchanged-from-10-K marker.
 *   4. Loud hard-fail — a stub is NEVER returned silently.
 *
 * This module is pure (no network). Exhibit redirects surface as a typed
 * error carrying everything the caller needs to fetch the EX-13 sibling via
 * providers/edgar.ts (filingIndexHeaders TYPE map — never filename/size, F17)
 * and finish with extractFromExhibit().
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SectionSpec {
  form: "10-K" | "10-Q" | "20-F";
  /**
   * 10-K: "1A" (Risk Factors) or "7" (MD&A).
   * 10-Q: "2" = Part I Item 2 (MD&A), "1A" = Part II Item 1A (Risk Factors).
   * 20-F: "3D" (Risk Factors) or "5" (Operating and Financial Review).
   */
  item: "1A" | "7" | "2" | "3D" | "5";
  /** 10-Q only; defaults: item "2" → part 1, item "1A" → part 2. */
  part?: 1 | 2;
}

export type ExtractMethod =
  | "toc-anchor"
  | "toc-title"
  | "header-regex"
  | "mini-toc-redirect"
  | "page-header-redirect"
  | "crossref-toc"
  | "exhibit-toc"
  | "exhibit-header"
  | "unchanged-from-10k";

export interface ExtractDiagnostics {
  layersTried: string[];
  tocEntryCount: number;
  itemEntryCount: number;
  notes: string[];
  stub?: { chars: number; excerpt: string };
}

export type ExtractionErrorKind = "no_section_found" | "stub_detected" | "not_required" | "exhibit_redirect";

export interface ExhibitRedirect {
  /** Section titles quoted inside the stub (e.g. "Financial Review"). */
  quotedTitles: string[];
  /** Exhibit TYPE prefix to resolve via the index-headers TYPE map. */
  exhibitTypePrefix: "EX-13";
  section: SectionKind;
  stubText: string;
}

export class ExtractionError extends Error {
  constructor(
    readonly kind: ExtractionErrorKind,
    message: string,
    readonly exhibit?: ExhibitRedirect,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

export type ExtractResult =
  | {
      ok: true;
      text: string;
      method: ExtractMethod;
      chars: number;
      /** Set when 10-Q Part II Item 1A merely refers back to the 10-K. */
      marker?: "unchanged_from_10k";
      diagnostics: ExtractDiagnostics;
    }
  | { ok: false; error: ExtractionError; diagnostics: ExtractDiagnostics };

export interface ParsedDocument {
  pre: string;
  entries: TocEntry[];
  fullText: string;
}

export interface ExtractOptions {
  /** Stub threshold; default 2,500 chars (stubs observed 252–399; real sections ≥18k). */
  stubMinChars?: number;
  /**
   * Pre-computed hidden-block-stripped/TOC/full-text structure from
   * `parseDocument(html)`. Callers extracting MULTIPLE sections from the SAME
   * fetched document (e.g. Item 1A + Item 7 of one 10-K) should parse once and
   * pass the result here instead of letting each call re-derive it — the parse
   * step is the expensive part of extraction on large filings. Must be derived
   * from the SAME `html` passed to this call; behavior is undefined otherwise.
   * Purely a performance option — output is identical whether supplied or not.
   */
  preparsed?: ParsedDocument;
}

export type SectionKind = "mdna" | "riskFactors";

// ---------------------------------------------------------------------------
// Text utilities (exported for tests)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  sect: "§",
  reg: "®",
  copy: "©",
  trade: "™",
};

/** Decode numeric (&#8217; / &#x2019;) and common named HTML entities. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(cp) ? whole : safeFromCodePoint(cp, whole);
    }
    if (body.startsWith("#")) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(cp) ? whole : safeFromCodePoint(cp, whole);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

function safeFromCodePoint(cp: number, fallback: string): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return fallback;
  }
}

/**
 * Remove iXBRL hidden content BEFORE any char counting (F13): <ix:header> /
 * <ix:hidden> blocks and inline style="display:none" elements (balanced scan;
 * self-closing tags handled).
 */
export function stripHiddenBlocks(html: string): string {
  const out = html
    .replace(/<ix:header\b[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<ix:hidden\b[\s\S]*?<\/ix:hidden>/gi, " ");

  const openRe = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*style\s*=\s*"[^"]*display\s*:\s*none[^"]*"[^>]*>/g;
  const parts: string[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(out)) !== null) {
    if (m.index < cursor) continue;
    parts.push(out.slice(cursor, m.index), " ");
    const tag = m[1].toLowerCase();
    const openEnd = m.index + m[0].length;
    if (/\/\s*>$/.test(m[0])) {
      cursor = openEnd;
      continue;
    }
    // Balanced scan for the matching close tag.
    const scanRe = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}\\s*>`, "gi");
    scanRe.lastIndex = openEnd;
    let depth = 1;
    let end = -1;
    let s: RegExpExecArray | null;
    while ((s = scanRe.exec(out)) !== null) {
      if (s[0].startsWith("</")) {
        depth--;
        if (depth === 0) {
          end = s.index + s[0].length;
          break;
        }
      } else if (s[1] !== "/") {
        depth++;
      }
    }
    if (end === -1) {
      // Unbalanced — drop just the open tag to avoid deleting the document.
      cursor = openEnd;
    } else {
      cursor = end;
    }
  }
  if (parts.length === 0) return out;
  parts.push(out.slice(cursor));
  return parts.join("");
}

/** Tags → spaces, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  const noBlocks = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const noTags = noBlocks.replace(/<[^>]*>/g, " ");
  return decodeEntities(noTags)
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercase, unify apostrophes/dashes/whitespace, strip trailing punctuation. */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .replace(/[.,:;"“”']+$/g, "")
    .replace(/^["“”']+/g, "")
    .trim();
}

export function isAllCaps(s: string): boolean {
  const letters = s.replace(/[^a-zA-Z]/g, "");
  return letters.length >= 3 && letters === letters.toUpperCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Anchor & TOC parsing
// ---------------------------------------------------------------------------

export interface MergedAnchor {
  target: string;
  text: string;
  /** Raw-HTML index of the first fragment. */
  index: number;
}

/**
 * Collect <a href="#..."> anchors, merging ADJACENT same-target runs (F1:
 * Workiva fragments one logical link across several <a> elements). Runs are
 * merged only when the gap contains no visible text and no cell boundary, so
 * separate item-number/title links in different cells stay distinct.
 */
export function mergedAnchors(html: string): MergedAnchor[] {
  const re = /<a\b[^>]*href\s*=\s*(?:"#([^"]*)"|'#([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  const raw: { target: string; text: string; index: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    raw.push({ target: m[1] ?? m[2] ?? "", text: htmlToText(m[3]), index: m.index, end: m.index + m[0].length });
  }
  const out: MergedAnchor[] = [];
  let lastEnd = -1;
  for (const a of raw) {
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (prev !== null && prev.target === a.target && lastEnd >= 0) {
      // True fragmentation ("Item 1" + "C" + ".") has NOTHING between the <a>
      // elements — no text, no entities, no cell boundary. Separate item/title
      // links to the same target (JPM main TOC) sit in different cells or have
      // spacing text between them, so they stay distinct.
      const gap = html.slice(lastEnd, a.index);
      const gapClean = gap.replace(/<[^>]*>/g, "");
      if (gap.length < 400 && gapClean.trim() === "" && !/&#?\w+;/.test(gapClean) && !/<\/?t[dh]\b/i.test(gap)) {
        prev.text = `${prev.text}${a.text}`.replace(/\s+/g, " ").trim();
        lastEnd = a.end;
        continue;
      }
    }
    out.push({ target: a.target, text: a.text, index: a.index });
    lastEnd = a.end;
  }
  return out;
}

/** Locate an anchor target: <div id>, <span id>, <a name>, etc. Returns tag-start index or -1. */
export function resolveAnchor(html: string, target: string): number {
  for (const pat of [`id="${target}"`, `id='${target}'`, `name="${target}"`, `name='${target}'`]) {
    const at = html.indexOf(pat);
    if (at !== -1) {
      const tagStart = html.lastIndexOf("<", at);
      return tagStart !== -1 ? tagStart : at;
    }
  }
  return -1;
}

export interface TocEntry {
  /** Normalized item number ("1A", "7") when the row carries one. */
  item?: string;
  title: string;
  target: string;
  /** 1|2 when a PART I/II marker row preceded this entry (10-Q); else null. */
  part: 1 | 2 | null;
  /** Raw-HTML position of the row (or anchor for standalone entries). */
  rowIndex: number;
  /** Printed page number when the row exposes one (Citi/WFC-style TOCs). */
  pageNo?: number;
}

const ITEM_CELL_RE = /^item\s+(\d{1,2}(?:\s*\.?\s*[a-dA-D])?)\s*[.:]?$/i;
const PART_ROW_RE = /^part\s+(i{1,3}|iv|[12])\b/i;

function normItem(s: string): string {
  return s.replace(/[.\s]/g, "").toUpperCase();
}

function partFromMarker(s: string): 1 | 2 | null {
  const u = s.toUpperCase();
  if (u === "I" || u === "1") return 1;
  if (u === "II" || u === "2") return 2;
  return null;
}

/**
 * Row-scoped TOC parse (F2/F3/F21): one entry per distinct anchor in a row;
 * the item-number cell binds to the row's first anchor; titles come from the
 * anchor text or the nearest non-numeric cell; page numbers from numeric link
 * text or numeric cells. A whole-document pass over item-numbered anchor text
 * (AAPL style) fills anything rows missed.
 */
export function parseTocEntries(html: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const seenRowTargets = new Set<string>();
  let currentPart: 1 | 2 | null = null;

  const rowRe = /<tr\b[\s\S]*?<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html)) !== null) {
    const rowHtml = row[0];
    const quickAnchor = rowHtml.includes('href="#') || rowHtml.includes("href='#");
    const quickPart = /part(?:&#160;|&nbsp;|\s|<[^>]*>)+(?:i|1)/i.test(rowHtml);
    if (!quickAnchor && !quickPart) continue;

    // Cells with their raw-HTML spans so anchors can be bound by ADJACENCY —
    // one <tr> may carry several TOC entries and cell order varies (F21).
    const cells: { start: number; end: number; text: string }[] = [];
    const cellRe = /<t[dh]\b[^>]*\/>|<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(rowHtml)) !== null) cells.push({ start: c.index, end: c.index + c[0].length, text: htmlToText(c[0]).trim() });
    const rowText = cells.length > 0 ? cells.map((x) => x.text).join(" ").replace(/\s+/g, " ").trim() : htmlToText(rowHtml);

    const partM = PART_ROW_RE.exec(rowText);
    if (partM !== null) {
      const p = partFromMarker(partM[1]);
      if (p !== null) currentPart = p;
    }

    const anchors = mergedAnchors(rowHtml);
    if (anchors.length === 0) continue;

    // Item number from a dedicated cell (binds to the row's FIRST anchor).
    let rowItem: string | undefined;
    for (const cell of cells) {
      const im = ITEM_CELL_RE.exec(cell.text);
      if (im !== null) {
        rowItem = normItem(im[1]);
        break;
      }
    }

    const isNumericText = (t: string): boolean => /^\d{1,4}$/.test(t);
    const isTitleText = (t: string): boolean => t !== "" && !isNumericText(t) && ITEM_CELL_RE.exec(t) === null;
    const cellIndexOf = (pos: number): number => cells.findIndex((cell) => pos >= cell.start && pos < cell.end);
    /** Nearest cell (own, then left/right alternating) whose text satisfies pred. */
    const nearestCellText = (fromIdx: number, pred: (t: string) => boolean): string | undefined => {
      if (fromIdx === -1) return cells.find((cell) => pred(cell.text))?.text;
      if (pred(cells[fromIdx].text)) return cells[fromIdx].text;
      for (let d = 1; d < cells.length; d++) {
        const left = fromIdx - d;
        const right = fromIdx + d;
        if (left >= 0 && pred(cells[left].text)) return cells[left].text;
        if (right < cells.length && pred(cells[right].text)) return cells[right].text;
      }
      return undefined;
    };

    const distinctTargets = new Set<string>();
    for (const a of anchors) {
      if (distinctTargets.has(a.target)) continue;
      distinctTargets.add(a.target);
      const anchorText = a.text.trim();
      const anchorIsNumeric = isNumericText(anchorText);
      const anchorItem = ITEM_CELL_RE.exec(anchorText);
      const ownCell = cellIndexOf(a.index);

      let title = "";
      if (isTitleText(anchorText) && anchorItem === null) title = anchorText;
      else title = nearestCellText(ownCell, (t) => isTitleText(t) && !(anchorText !== "" && t === anchorText)) ?? "";

      let pageNo: number | undefined;
      if (anchorIsNumeric) pageNo = Number.parseInt(anchorText, 10);
      else {
        const num = nearestCellText(ownCell, isNumericText);
        if (num !== undefined) pageNo = Number.parseInt(num, 10);
      }

      const item = distinctTargets.size === 1 ? (rowItem ?? (anchorItem !== null ? normItem(anchorItem[1]) : undefined)) : anchorItem !== null ? normItem(anchorItem[1]) : undefined;
      entries.push({ item, title, target: a.target, part: currentPart, rowIndex: row.index, pageNo });
      seenRowTargets.add(a.target);
    }
  }

  // Whole-document standalone pass (AAPL-style TOC links, fragmented runs).
  const cap = Math.max(200_000, Math.floor(html.length * 0.4));
  const all = mergedAnchors(html.slice(0, cap));
  const haveItems = new Set(entries.filter((e) => e.item !== undefined).map((e) => `${e.item}|${e.part ?? ""}`));
  for (const a of all) {
    const im = ITEM_CELL_RE.exec(a.text.trim());
    if (im === null) continue;
    const item = normItem(im[1]);
    if (haveItems.has(`${item}|`) || [...haveItems].some((k) => k.startsWith(`${item}|`))) continue;
    if (seenRowTargets.has(a.target)) continue;
    entries.push({ item, title: a.text.trim(), target: a.target, part: null, rowIndex: a.index });
    haveItems.add(`${item}|`);
  }

  entries.sort((a, b) => a.rowIndex - b.rowIndex);
  return entries;
}

// ---------------------------------------------------------------------------
// Section metadata
// ---------------------------------------------------------------------------

interface ItemDef {
  id: string;
  title: RegExp;
}

const APO = "['’‘]";

const TENK_SEQUENCE: ItemDef[] = [
  { id: "1", title: /Business/i },
  { id: "1A", title: /Risk[\s]+Factors/i },
  { id: "1B", title: /Unresolved[\s]+Staff/i },
  { id: "1C", title: /Cybersecurity/i },
  { id: "2", title: /Properties/i },
  { id: "3", title: /Legal[\s]+Proceedings/i },
  { id: "4", title: /Mine[\s]+Safety/i },
  { id: "5", title: /Market[\s]+for/i },
  { id: "6", title: /(?:\[?Reserved\]?|Selected[\s]+Financial)/i },
  { id: "7", title: new RegExp(`Management${APO}?s?[\\s]+Discussion[\\s]+and[\\s]+Analysis`, "i") },
  { id: "7A", title: /Quantitative[\s]+and[\s]+Qualitative/i },
  { id: "8", title: /Financial[\s]+Statements[\s]+and[\s]+Supplementary/i },
  { id: "9", title: /Changes[\s]+in[\s]+and[\s]+Disagreements/i },
];

const TENQ_P1_SEQUENCE: ItemDef[] = [
  { id: "1", title: /(?:Condensed[\s]+)?(?:Consolidated[\s]+)?Financial[\s]+Statements/i },
  { id: "2", title: new RegExp(`Management${APO}?s?[\\s]+Discussion`, "i") },
  { id: "3", title: /Quantitative[\s]+and[\s]+Qualitative/i },
  { id: "4", title: /Controls[\s]+and[\s]+Procedures/i },
];

const TENQ_P2_SEQUENCE: ItemDef[] = [
  { id: "1", title: /Legal[\s]+Proceedings/i },
  { id: "1A", title: /Risk[\s]+Factors/i },
  { id: "2", title: /Unregistered[\s]+Sales/i },
  { id: "3", title: /Defaults/i },
  { id: "4", title: /Mine[\s]+Safety/i },
  { id: "5", title: /Other[\s]+Information/i },
  { id: "6", title: /Exhibits/i },
];

/** Form 20-F annual-report sequence needed to bound the foreign-filer slices. */
const TWENTY_F_SEQUENCE: ItemDef[] = [
  { id: "1", title: /Identity[\s]+of[\s]+Directors/i },
  { id: "2", title: /Offer[\s]+Statistics/i },
  { id: "3", title: /Key[\s]+Information/i },
  { id: "3D", title: /Risk[\s]+Factors/i },
  { id: "4", title: /Information[\s]+on[\s]+the[\s]+Company/i },
  { id: "4A", title: /Unresolved[\s]+Staff/i },
  { id: "5", title: /Operating[\s]+and[\s]+Financial[\s]+Review[\s]+and[\s]+Prospects/i },
  { id: "6", title: /Directors,[\s]+Senior[\s]+Management[\s]+and[\s]+Employees/i },
  { id: "7", title: /Major[\s]+Shareholders/i },
];

const SECTION_KIND: Record<string, SectionKind> = {
  "10-K:1A": "riskFactors",
  "10-K:7": "mdna",
  "10-Q:2": "mdna",
  "10-Q:1A": "riskFactors",
  "20-F:3D": "riskFactors",
  "20-F:5": "mdna",
};

const TITLE_SYNONYMS: Record<SectionKind, string[]> = {
  mdna: ["management's discussion and analysis", "financial review", "management's discussion & analysis", "operating and financial review and prospects"],
  riskFactors: ["risk factors"],
};

/** Contents-TOC entries that terminate a redirected section slice. */
const BOUNDARY_SYNONYMS: Record<SectionKind, string[]> = {
  mdna: [
    "management's report on internal control",
    "report of independent registered public accounting",
    "consolidated financial statements",
    "financial statements and notes",
    "audited financial statements",
    "controls and procedures",
    "quantitative and qualitative disclosures",
    "risk factors",
    "consolidated balance sheet",
    "directors, senior management and employees",
    // NOTE: "capital resources" is deliberately absent — "Liquidity and
    // Capital Resources" is a common MD&A SUBSECTION and would truncate it.
  ],
  riskFactors: [
    "controls and procedures",
    "management's report on internal control",
    "report of independent registered public accounting",
    "consolidated financial statements",
    "sustainability",
    "human capital",
    "supervision and regulation",
    "management's discussion and analysis",
    "financial review",
  ],
};

function specKind(spec: SectionSpec): SectionKind {
  return SECTION_KIND[`${spec.form}:${spec.item}`] ?? "mdna";
}

function specPart(spec: SectionSpec): 1 | 2 {
  if (spec.part !== undefined) return spec.part;
  return spec.item === "2" ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Layer 1 — TOC-anchor slicing
// ---------------------------------------------------------------------------

interface SliceResult {
  text: string;
  method: ExtractMethod;
  startTarget?: string;
}

function anchorPositions(html: string, entries: TocEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries) {
    if (!map.has(e.target)) map.set(e.target, resolveAnchor(html, e.target));
  }
  return map;
}

function layer1Slice(html: string, entries: TocEntry[], spec: SectionSpec, notes: string[]): SliceResult | null {
  const itemEntries = entries.filter((e) => e.item !== undefined);
  const pos = anchorPositions(html, entries);

  let candidate: TocEntry | undefined;
  const wanted = normItem(spec.item);

  if (itemEntries.length > 0) {
    const matches = itemEntries.filter((e) => e.item === wanted && pos.get(e.target) !== undefined && (pos.get(e.target) as number) >= 0);
    if (spec.form === "10-Q") {
      const part = specPart(spec);
      const partMatches = matches.filter((e) => e.part === part);
      if (partMatches.length > 0) candidate = partMatches[0];
      else if (matches.length > 0) {
        // No part markers — fall back to title/position heuristics.
        const kind = specKind(spec);
        const byTitle = matches.filter((e) => titleMatchesKind(e.title, kind));
        if (byTitle.length > 0) candidate = byTitle[0];
        else candidate = part === 1 ? matches[0] : matches[matches.length - 1];
        notes.push(`10-Q part disambiguation used ${byTitle.length > 0 ? "title" : "position"} heuristic for Item ${wanted}`);
      }
    } else {
      candidate = matches[0];
    }
    if (candidate !== undefined) {
      const start = pos.get(candidate.target) as number;
      // Boundary: next ITEM entry at a strictly greater anchor position (F2:
      // duplicate targets collapse; next *distinct* anchor bounds the slice).
      let end = html.length;
      for (const e of itemEntries) {
        const p = pos.get(e.target);
        if (p !== undefined && p > start && p < end) end = p;
      }
      const text = htmlToText(html.slice(start, end));
      if (text.length > 0) return { text, method: "toc-anchor", startTarget: candidate.target };
      return null;
    }
  }

  // Title-only TOC variant (MXC): no item-numbered links anywhere.
  const kind = specKind(spec);
  const titleEntries = entries.filter((e) => e.item === undefined && e.title !== "");
  const cand = titleEntries.find((e) => titleMatchesKind(e.title, kind) && (pos.get(e.target) ?? -1) >= 0);
  if (cand === undefined) return null;
  const start = pos.get(cand.target) as number;
  const ordered = titleEntries.filter((e) => (pos.get(e.target) ?? -1) >= 0).sort((a, b) => (pos.get(a.target) as number) - (pos.get(b.target) as number));
  let end = html.length;
  for (const e of ordered) {
    const p = pos.get(e.target) as number;
    if (p > start) {
      end = p;
      break;
    }
  }
  const text = htmlToText(html.slice(start, end));
  if (text.length === 0) return null;
  notes.push("layer 1 used title-only TOC links (no item-numbered links found)");
  return { text, method: "toc-title", startTarget: cand.target };
}

function titleMatchesKind(title: string, kind: SectionKind): boolean {
  const n = normalizeTitle(title);
  if (n === "") return false;
  // One-way containment only: the entry title must CONTAIN the synonym.
  // (The reverse would make a "Financial Review" entry match the quoted
  // composite "Financial Review – Risk Factors" and hijack Risk Factors.)
  return TITLE_SYNONYMS[kind].some((syn) => n.includes(syn));
}

// ---------------------------------------------------------------------------
// Layer 2 — hardened header regex
// ---------------------------------------------------------------------------

interface HeaderCandidate {
  index: number;
  matchText: string;
}

/** SEC headings write lettered items both as 1A and as 1.A / 3.D. */
function itemIdHeaderPattern(id: string): string {
  const lettered = /^(\d+)([a-z])$/i.exec(id);
  return lettered === null
    ? escapeRegExp(id)
    : escapeRegExp(lettered[1]) + "[\\s.]*" + escapeRegExp(lettered[2]);
}

const REJECT_BEFORE_RE = /(see|refer(?:s|red)?[\s]+to|described[\s]+in|discussed[\s]+in|under|in[\s]+part[\s]+[ivx\d])[\s]*["“”'(‘’]*[\s]*$/i;
// NOTE: stub markers ("can be found in", "incorporated by reference") are
// deliberately NOT candidate rejecters — they follow REAL headers on WFC/FRD
// wrapper stubs, and rejecting those would leave zero candidates and skip the
// exhibit-redirect path. They are handled by the Layer-3 stub detector.
// "above|below" gets a TIGHT window: cross-references put it immediately after
// the quoted title (MXC: «"Item 1A. Risk Factors" above»), while real headers
// can legitimately say "The discussion below addresses..." (BAC F16) further out.
const REJECT_AFTER_100_RE = /^[\s\S]{0,100}?\b((?:in|of)[\s]+this[\s]+(?:form|report|annual[\s]+report)|for[\s]+(?:a[\s]+)?discussion)\b/i;
const REJECT_AFTER_10_RE = /^[\s\S]{0,10}?\b(above|below)\b/i;
const REJECT_AFTER_60_RE = /^[\s\S]{0,60}?\bon[\s]+page[s]?[\s]+\d/i;

/**
 * Find surviving header candidates for one item on stripped text.
 * Pattern: Item <N>[.:]? + optional interposed run ≤120 chars (F15) + title.
 * Rejects cross-reference contexts (F7/F7b/F16).
 */
export function findHeaderCandidates(fullText: string, def: ItemDefLike, windowStart = 0, windowEnd = Number.MAX_SAFE_INTEGER): HeaderCandidate[] {
  const re = new RegExp(`\\bItem[\\s]+${itemIdHeaderPattern(def.id)}\\b[.:]?[\\s\\S]{0,120}?(?:${def.title.source})`, "gi");
  const out: HeaderCandidate[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    if (m.index < windowStart || m.index > windowEnd) continue;
    const before = fullText.slice(Math.max(0, m.index - 40), m.index);
    if (REJECT_BEFORE_RE.test(before)) continue;
    const after = fullText.slice(m.index + m[0].length, m.index + m[0].length + 130);
    if (REJECT_AFTER_100_RE.test(after) || REJECT_AFTER_60_RE.test(after) || REJECT_AFTER_10_RE.test(after)) continue;
    out.push({ index: m.index, matchText: m[0] });
  }
  return out;
}

export interface ItemDefLike {
  id: string;
  title: RegExp;
}

function layer2Slice(fullText: string, spec: SectionSpec, notes: string[]): { text: string; zeroCandidates: boolean } | null {
  let seq: ItemDef[];
  let winStart = 0;
  let winEnd = fullText.length;

  if (spec.form === "10-K") {
    seq = TENK_SEQUENCE;
  } else if (spec.form === "20-F") {
    seq = TWENTY_F_SEQUENCE;
  } else {
    const part = specPart(spec);
    seq = part === 1 ? TENQ_P1_SEQUENCE : TENQ_P2_SEQUENCE;
    // Part-aware segmentation: "Item 2." appears in both parts of a 10-Q.
    const partIIPositions: number[] = [];
    const pRe = /\bPART[\s]+II\b/gi;
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(fullText)) !== null) partIIPositions.push(pm.index);
    if (partIIPositions.length > 0) {
      // Body Part II header is the LAST occurrence (TOC rows come first).
      const bodyPartII = partIIPositions[partIIPositions.length - 1];
      if (part === 1) winEnd = bodyPartII;
      else winStart = bodyPartII;
    } else if (part === 2) {
      notes.push("10-Q Part II marker not found; searching whole document");
    }
  }

  const idx = seq.findIndex((d) => d.id === normItem(spec.item));
  if (idx === -1) return null;
  const target = seq[idx];
  const targetCands = findHeaderCandidates(fullText, target, winStart, winEnd);
  if (targetCands.length === 0) return { text: "", zeroCandidates: true };

  const boundaryCands: HeaderCandidate[] = [];
  for (const bd of seq.slice(idx + 1, idx + 5)) {
    boundaryCands.push(...findHeaderCandidates(fullText, bd, winStart, winEnd));
  }
  if (spec.form === "10-Q" && specPart(spec) === 1 && winEnd < fullText.length) {
    boundaryCands.push({ index: winEnd, matchText: "PART II" });
  }
  boundaryCands.sort((a, b) => a.index - b.index);

  // Monotonic rule: LAST target candidate that still has a boundary after it.
  let chosen: HeaderCandidate | null = null;
  let end = winEnd;
  for (let i = targetCands.length - 1; i >= 0; i--) {
    const c = targetCands[i];
    const b = boundaryCands.find((bc) => bc.index > c.index);
    if (b !== undefined) {
      chosen = c;
      end = b.index;
      break;
    }
  }
  if (chosen === null) {
    chosen = targetCands[targetCands.length - 1];
    notes.push(`layer 2: no boundary header after Item ${target.id}; sliced to window end`);
  }
  return { text: fullText.slice(chosen.index, end).trim(), zeroCandidates: false };
}

// ---------------------------------------------------------------------------
// Layer 3 — stub detection & redirects
// ---------------------------------------------------------------------------

export const STUB_MIN_CHARS = 2500;

const STUB_PHRASE_RE = new RegExp(
  [
    "incorporated[\\s]+(?:herein[\\s]+)?(?:into[\\s]+this[\\s]+item[\\s]+)?by[\\s]+reference",
    "appears?[\\s]+on[\\s]+pages?",
    "refer[\\s]+to[\\s]+(?:the[\\s]+)?(?:part|pages?|item|information|market[\\s]+risk)",
    "can[\\s]+be[\\s]+found[\\s]+in",
    "information[\\s]+in[\\s]+response[\\s]+to[\\s]+this[\\s]+item",
    "see[\\s]+[\\s\\S]{0,60}?on[\\s]+page",
  ].join("|"),
  "i",
);

/** Layer-3 stub test: short OR incorporation phrasing in the first 400 chars. */
export function detectStub(text: string, minChars = STUB_MIN_CHARS): { isStub: boolean; reason: string } {
  if (text.length < minChars) return { isStub: true, reason: `only ${text.length} chars (<${minChars})` };
  const head = text.slice(0, 400);
  if (STUB_PHRASE_RE.test(head)) return { isStub: true, reason: "incorporation/cross-reference phrasing in first 400 chars" };
  return { isStub: false, reason: "" };
}

const NOT_REQUIRED_RE = /(?:^|[.\s])(not[\s]+required|none|not[\s]+applicable)[.\s]*$/i;
const UNCHANGED_10K_RE = /refer[\s]+to[\s\S]{0,220}?(?:form[\s]+10-?k|annual[\s]+report[\s]+on[\s]+form[\s]+10-?k)|no[\s]+material[\s]+changes[\s\S]{0,220}?10-?k/i;
const EXHIBIT_PHRASE_RE = /annual[\s]+report[\s]+to[\s]+(?:share|stock)holders|exhibit[\s]+13|(?:attached|included)[\s]+as[\s]+exhibit/i;

/** Section titles quoted inside a stub (WFC names its EX-13 target "Financial Review"). */
export function parseQuotedTitles(stub: string): string[] {
  const out: string[] = [];
  const re = /[“"']([^“”"']{3,140})[”"']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stub)) !== null) {
    const t = m[1].trim();
    if (/[a-zA-Z]{3,}/.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Same-doc redirect (JPM bank mode): find the annual-report contents TOC entry
 * whose TITLE matches the section, slice its anchor → the next major-boundary
 * entry's anchor. The bare title also appears 50+ times as a running page
 * header — never bound by title occurrence, only by TOC anchors (F12).
 */
function tryMiniTocRedirect(
  html: string,
  entries: TocEntry[],
  kind: SectionKind,
  excludeTargets: Set<string>,
  minChars: number,
): string | null {
  const titleEntries = entries.filter((e) => e.item === undefined && e.title !== "" && !excludeTargets.has(e.target));
  if (titleEntries.length === 0) return null;
  const pos = anchorPositions(html, titleEntries);

  const start = titleEntries.find((e) => titleMatchesKind(e.title, kind) && (pos.get(e.target) ?? -1) >= 0);
  if (start === undefined) return null;
  const startPos = pos.get(start.target) as number;

  const boundaries = BOUNDARY_SYNONYMS[kind];
  let endPos = html.length;
  let found = false;
  for (const e of titleEntries) {
    const p = pos.get(e.target);
    if (p === undefined || p <= startPos || e.target === start.target) continue;
    const n = normalizeTitle(e.title);
    const isBoundary = boundaries.some((b) => n.includes(b)) || (isAllCaps(start.title) && isAllCaps(e.title));
    if (isBoundary && p < endPos) {
      endPos = p;
      found = true;
    }
  }
  if (!found) {
    // No recognizable boundary in the contents TOC: slicing to EOF inside a
    // primary document would swallow the financial statements — refuse.
    return null;
  }
  const text = htmlToText(html.slice(startPos, endPos));
  return text.length >= minChars ? text : null;
}

/**
 * JPM-style filings can embed the full annual report after the short Item 7
 * wrapper without an anchorable mini-TOC. The annual-report pages repeat a
 * "Form 10-K <page> Management's discussion and analysis" header, which is a
 * stronger redirect signal than a bare title occurrence. Bound the slice at
 * the internal-control / financial-statement transition; never fall back to
 * EOF, which could swallow the audited statements.
 */
function tryAnnualReportPageHeaderRedirect(
  fullText: string,
  stubText: string,
  kind: SectionKind,
  minChars: number,
): string | null {
  if (kind !== "mdna") return null;
  const stubAt = fullText.indexOf(stubText);
  if (stubAt < 0) return null;

  const headerRe = /\bForm\s+10-K\s+\d+\s+Management[\u0027\u2019]s\s+discussion\s+and\s+analysis\b/gi;
  headerRe.lastIndex = stubAt + stubText.length;
  const header = headerRe.exec(fullText);
  if (header === null) return null;

  const boundaryRe = /Management[\u0027\u2019]s\s+Report\s+on\s+Internal\s+Control/gi;
  boundaryRe.lastIndex = header.index + header[0].length;
  const boundary = boundaryRe.exec(fullText);
  if (boundary === null) return null;

  const text = fullText.slice(header.index, boundary.index).trim();
  return text.length >= minChars ? text : null;
}

// ---------------------------------------------------------------------------
// Layer 0 — Citi cross-reference-index mode
// ---------------------------------------------------------------------------

export interface CrossRefEntry {
  item: string;
  title: string;
  pages: [number, number][];
  notApplicable: boolean;
}

const PAGE_RANGES_RE = /^\d{1,4}(?:[\s]*[–—-][\s]*\d{1,4})?(?:[,;][\s]*\d{1,4}(?:[\s]*[–—-][\s]*\d{1,4})?)*[,;]?$/;

function parsePageRanges(s: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of s.split(/[,;]/)) {
    const p = part.trim();
    if (p === "") continue;
    const m = /^(\d{1,4})(?:[\s]*[–—-][\s]*(\d{1,4}))?$/.exec(p);
    if (m === null) continue;
    const a = Number.parseInt(m[1], 10);
    const b = m[2] !== undefined ? Number.parseInt(m[2], 10) : a;
    out.push([a, b]);
  }
  return out;
}

/**
 * Parse the FORM 10-K CROSS-REFERENCE INDEX (item cells like "7." + title cell
 * + page-range cell, ranges possibly continued on following rows; rows carry
 * NO anchors) — F20.
 */
export function parseCrossRefIndex(html: string): CrossRefEntry[] {
  // Scope row scanning to the region after the index heading so page-range-like
  // cells in unrelated financial tables cannot pollute the parse.
  const markerAt = html.search(/CROSS[-\s]?REFERENCE[\s&#;a-z0-9]{0,24}INDEX/i);
  const region = markerAt >= 0 ? html.slice(markerAt, markerAt + 400_000) : html;
  const entries: CrossRefEntry[] = [];
  const rowRe = /<tr\b[\s\S]*?<\/tr>/gi;
  let row: RegExpExecArray | null;
  let current: CrossRefEntry | null = null;
  while ((row = rowRe.exec(region)) !== null) {
    const rowHtml = row[0];
    if (rowHtml.includes('href="#')) {
      current = null;
      continue; // crossref rows have no links
    }
    const cellTexts: string[] = [];
    const cellRe = /<t[dh]\b[^>]*\/>|<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(rowHtml)) !== null) cellTexts.push(htmlToText(c[0]).trim());
    const nonEmpty = cellTexts.filter((t) => t !== "");
    if (nonEmpty.length === 0) continue;

    const itemCell = nonEmpty.find((t) => /^\d{1,2}[A-C]?\.$/i.test(t));
    const naCell = nonEmpty.find((t) => /^not[\s]+applicable$/i.test(t));
    const pageCell = nonEmpty.find((t) => PAGE_RANGES_RE.test(t));

    if (itemCell !== undefined) {
      const title = nonEmpty.filter((t) => t !== itemCell && t !== pageCell && t !== naCell).reduce((a, b) => (b.length > a.length ? b : a), "");
      current = {
        item: normItem(itemCell.replace(/\.$/, "")),
        title,
        pages: pageCell !== undefined ? parsePageRanges(pageCell) : [],
        notApplicable: naCell !== undefined,
      };
      entries.push(current);
    } else if (current !== null && pageCell !== undefined && nonEmpty.every((t) => t === pageCell || PAGE_RANGES_RE.test(t) || t === "")) {
      current.pages.push(...parsePageRanges(pageCell));
    } else if (nonEmpty.some((t) => t.length > 3 && !PAGE_RANGES_RE.test(t))) {
      current = null;
    }
  }
  return entries;
}

function layer0Citi(
  html: string,
  entries: TocEntry[],
  fullText: string,
  spec: SectionSpec,
  notes: string[],
): { text: string } | { notRequired: true } | null {
  if (!/CROSS[-\s]?REFERENCE[\s]+INDEX/i.test(fullText.slice(0, 200_000)) && !/CROSS[-\s]?REFERENCE[\s]+INDEX/i.test(fullText)) return null;
  const crossRef = parseCrossRefIndex(html);
  const wanted = normItem(spec.item);
  const entry = crossRef.find((e) => e.item === wanted);
  if (entry === undefined) return null;
  if (entry.notApplicable) return { notRequired: true };
  if (entry.pages.length === 0) return null;

  // Contents-TOC entries: title + page number + anchor (Citi: page number is the link text).
  const paged = entries.filter((e) => e.pageNo !== undefined && e.title !== "");
  if (paged.length === 0) return null;
  const pos = anchorPositions(html, paged);
  const ordered = paged.filter((e) => (pos.get(e.target) ?? -1) >= 0).sort((a, b) => a.rowIndex - b.rowIndex);

  const pieces: string[] = [];
  for (const [a, b] of entry.pages) {
    const startIdx = ordered.findIndex((e) => (e.pageNo as number) >= a && (e.pageNo as number) <= b);
    if (startIdx === -1) {
      notes.push(`citi-mode: no contents-TOC entry for page range ${a}-${b}`);
      continue;
    }
    const start = ordered[startIdx];
    const startPos = pos.get(start.target) as number;
    // End: first later TOP-LEVEL (all-caps) entry reaching page >= b, else first entry past b.
    let endPos = html.length;
    let fallbackEnd = html.length;
    for (let i = startIdx + 1; i < ordered.length; i++) {
      const e = ordered[i];
      const p = pos.get(e.target) as number;
      if (p <= startPos) continue;
      if ((e.pageNo as number) > b && p < fallbackEnd) fallbackEnd = p;
      if (isAllCaps(e.title) && (e.pageNo as number) >= b && e.target !== start.target) {
        endPos = p;
        break;
      }
    }
    if (endPos === html.length) endPos = fallbackEnd;
    const text = htmlToText(html.slice(startPos, endPos));
    if (text.length > 0) pieces.push(text);
  }
  if (pieces.length === 0) return null;
  notes.push(`citi-mode: assembled ${pieces.length}/${entry.pages.length} page range(s) for Item ${wanted}`);
  return { text: pieces.join("\n\n") };
}

/**
 * Hidden-block strip + TOC/anchor parse + flattened text — the expensive,
 * whole-document part of extraction. Callers extracting multiple sections
 * from the same fetched document should call this once and pass the result
 * to `extractSection` via `ExtractOptions.preparsed` instead of paying the
 * full-document parse cost once per section.
 */
export function parseDocument(html: string): ParsedDocument {
  const pre = stripHiddenBlocks(html);
  const entries = parseTocEntries(pre);
  const fullText = htmlToText(pre);
  return { pre, entries, fullText };
}

// ---------------------------------------------------------------------------
// extractSection — main entry
// ---------------------------------------------------------------------------

export function extractSection(html: string, spec: SectionSpec, opts: ExtractOptions = {}): ExtractResult {
  const minChars = opts.stubMinChars ?? STUB_MIN_CHARS;
  const notes: string[] = [];
  const layersTried: string[] = [];

  const { pre, entries, fullText } = opts.preparsed ?? parseDocument(html);
  const diagnostics: ExtractDiagnostics = {
    layersTried,
    tocEntryCount: entries.length,
    itemEntryCount: entries.filter((e) => e.item !== undefined).length,
    notes,
  };

  let sectionText: string | null = null;
  let method: ExtractMethod = "toc-anchor";
  let startTarget: string | undefined;
  let zeroCandidates = true;

  // Layer 0 FIRST for Citi-mode documents: zero item-numbered TOC entries plus
  // a FORM 10-K CROSS-REFERENCE INDEX (F20). This must precede the title-only
  // Layer-1 variant, because on Citi that variant would silently return a
  // PARTIAL Item 7 (the cross-reference index maps it to NON-contiguous page
  // ranges that only layer 0 can assemble).
  const hasItemEntries = entries.some((e) => e.item !== undefined);
  if (!hasItemEntries && /CROSS[-\s]?REFERENCE[\s]+INDEX/i.test(fullText)) {
    layersTried.push("layer0-crossref-index");
    const citi = layer0Citi(pre, entries, fullText, spec, notes);
    if (citi !== null) {
      if ("notRequired" in citi) {
        return fail(diagnostics, new ExtractionError("not_required", `Item ${spec.item} is marked Not Applicable in the cross-reference index`));
      }
      const citiStub = detectStub(citi.text, minChars);
      if (!citiStub.isStub) return ok(citi.text, "crossref-toc", diagnostics);
      diagnostics.stub = { chars: citi.text.length, excerpt: citi.text.slice(0, 300) };
      notes.push(`citi-mode slice was a stub: ${citiStub.reason}`);
    }
  }

  layersTried.push("layer1-toc-anchor");
  const l1 = layer1Slice(pre, entries, spec, notes);
  if (l1 !== null) {
    sectionText = l1.text;
    method = l1.method;
    startTarget = l1.startTarget;
    zeroCandidates = false;
  } else {
    layersTried.push("layer2-header-regex");
    const l2 = layer2Slice(fullText, spec, notes);
    if (l2 !== null && !l2.zeroCandidates) {
      sectionText = l2.text;
      method = "header-regex";
      zeroCandidates = false;
    } else if (l2 !== null) {
      zeroCandidates = true;
    }
  }

  if (sectionText === null) {
    // Late Layer-0 retry: docs whose item entries were all bogus/unresolvable
    // but that do carry a cross-reference index (not attempted above).
    if (zeroCandidates && hasItemEntries) {
      layersTried.push("layer0-crossref-index");
      const citi = layer0Citi(pre, entries, fullText, spec, notes);
      if (citi !== null) {
        if ("notRequired" in citi) {
          return fail(diagnostics, new ExtractionError("not_required", `Item ${spec.item} is marked Not Applicable in the cross-reference index`));
        }
        const stub = detectStub(citi.text, minChars);
        if (!stub.isStub) {
          return ok(citi.text, "crossref-toc", diagnostics);
        }
        diagnostics.stub = { chars: citi.text.length, excerpt: citi.text.slice(0, 300) };
      }
    }
    return fail(
      diagnostics,
      new ExtractionError("no_section_found", `no extraction layer located ${spec.form} Item ${spec.item}${spec.form === "10-Q" ? ` (Part ${specPart(spec)})` : ""}`),
    );
  }

  // Layer 3 — MANDATORY stub detection.
  layersTried.push("layer3-stub-detector");
  const stub = detectStub(sectionText, minChars);
  if (!stub.isStub) return ok(sectionText, method, diagnostics);

  diagnostics.stub = { chars: sectionText.length, excerpt: sectionText.slice(0, 300) };
  notes.push(`stub detected: ${stub.reason}`);

  // 3c — 10-Q Part II Item 1A "unchanged from 10-K" marker.
  if (spec.form === "10-Q" && normItem(spec.item) === "1A" && specPart(spec) === 2 && UNCHANGED_10K_RE.test(sectionText)) {
    return { ok: true, text: sectionText, method: "unchanged-from-10k", chars: sectionText.length, marker: "unchanged_from_10k", diagnostics };
  }

  // "Not required." / "None." bodies (F10) — legitimate absence, disclosed loudly.
  if (sectionText.length < 600 && NOT_REQUIRED_RE.test(sectionText)) {
    return fail(diagnostics, new ExtractionError("not_required", `Item ${spec.item} body is "${sectionText.slice(-80).trim()}" — not required for this filer`));
  }

  // 3a — same-doc mini-TOC redirect (JPM).
  layersTried.push("layer3a-mini-toc");
  const exclude = new Set<string>(startTarget !== undefined ? [startTarget] : []);
  const redirected = tryMiniTocRedirect(pre, entries, specKind(spec), exclude, minChars);
  if (redirected !== null) {
    const check = detectStub(redirected, minChars);
    if (!check.isStub) {
      notes.push("same-doc mini-TOC redirect succeeded");
      return ok(redirected, "mini-toc-redirect", diagnostics);
    }
  }

  if (spec.form === "10-K") {
    layersTried.push("layer3a2-page-header");
    const pageHeaderRedirect = tryAnnualReportPageHeaderRedirect(fullText, sectionText, specKind(spec), minChars);
    if (pageHeaderRedirect !== null) {
      notes.push("annual-report page-header redirect succeeded");
      return ok(pageHeaderRedirect, "page-header-redirect", diagnostics);
    }
  }

  // 3b — exhibit redirect signal (FRD/WFC/Seneca). Caller resolves EX-13 via
  // the index-headers TYPE map and calls extractFromExhibit().
  if (EXHIBIT_PHRASE_RE.test(sectionText)) {
    layersTried.push("layer3b-exhibit-redirect");
    const quoted = parseQuotedTitles(sectionText);
    return fail(
      diagnostics,
      new ExtractionError("exhibit_redirect", `Item ${spec.item} is incorporated by reference into an exhibit (resolve EX-13* via index-headers TYPE map)`, {
        quotedTitles: quoted,
        exhibitTypePrefix: "EX-13",
        section: specKind(spec),
        stubText: sectionText,
      }),
    );
  }

  // Layer 4 — loud hard-fail. NEVER return a stub silently.
  layersTried.push("layer4-hard-fail");
  return fail(
    diagnostics,
    new ExtractionError("stub_detected", `extracted ${spec.form} Item ${spec.item} is a ${sectionText.length}-char stub (${stub.reason}) and no redirect succeeded`),
  );

  function ok(text: string, m: ExtractMethod, d: ExtractDiagnostics): ExtractResult {
    return { ok: true, text, method: m, chars: text.length, diagnostics: d };
  }
  function fail(d: ExtractDiagnostics, e: ExtractionError): ExtractResult {
    return { ok: false, error: e, diagnostics: d };
  }
}

// ---------------------------------------------------------------------------
// extractFromExhibit — Layer 3b completion (EX-13 body)
// ---------------------------------------------------------------------------

export interface ExhibitExtractOptions {
  section: SectionKind;
  /** Quoted titles parsed from the incorporation stub (preferred over synonyms). */
  quotedTitles?: string[];
  stubMinChars?: number;
}

/**
 * Extract a section from an EX-13 / annual-report exhibit document.
 * Route 1: title-based row-scoped TOC slicing (WFC EX-13 — cell order varies,
 * page number may be the link text, F21).
 * Route 2: title-only heading match on stripped text — FIRST ALL-CAPS/heading
 * occurrence (FRD; decoy titles appear AFTER the real header there), sliced to
 * the next major heading or EOF.
 */
export function extractFromExhibit(exhibitHtml: string, opts: ExhibitExtractOptions): ExtractResult {
  const minChars = opts.stubMinChars ?? STUB_MIN_CHARS;
  const notes: string[] = [];
  const layersTried: string[] = [];
  const pre = stripHiddenBlocks(exhibitHtml);
  const entries = parseTocEntries(pre);
  const diagnostics: ExtractDiagnostics = {
    layersTried,
    tocEntryCount: entries.length,
    itemEntryCount: 0,
    notes,
  };

  const synonyms = buildSynonyms(opts.section, opts.quotedTitles ?? []);

  // Route 1 — exhibit contents TOC. Synonyms are tried in PRIORITY order
  // (quoted titles from the stub first, then generic synonyms).
  layersTried.push("exhibit-toc");
  const titleEntries = entries.filter((e) => e.title !== "");
  if (titleEntries.length > 0) {
    const pos = anchorPositions(pre, titleEntries);
    let start: TocEntry | undefined;
    for (const syn of synonyms) {
      start = titleEntries.find((e) => normalizeTitle(e.title).includes(syn) && (pos.get(e.target) ?? -1) >= 0);
      if (start !== undefined) break;
    }
    if (start !== undefined) {
      const startPos = pos.get(start.target) as number;
      const boundaries = BOUNDARY_SYNONYMS[opts.section];
      let endPos = pre.length;
      for (const e of titleEntries) {
        const p = pos.get(e.target);
        if (p === undefined || p <= startPos || e.target === start.target) continue;
        const n = normalizeTitle(e.title);
        const isBoundary = boundaries.some((b) => n.includes(b)) || (isAllCaps(start.title) && isAllCaps(e.title));
        if (isBoundary && p < endPos) endPos = p;
      }
      const text = htmlToText(pre.slice(startPos, endPos));
      if (text.length >= minChars) {
        return { ok: true, text, method: "exhibit-toc", chars: text.length, diagnostics };
      }
      notes.push(`exhibit TOC slice too short (${text.length} chars)`);
    }
  }

  // Route 2 — ALL-CAPS standalone heading, FIRST occurrence.
  layersTried.push("exhibit-header");
  const fullText = htmlToText(pre);
  for (const syn of synonyms) {
    const headRe = allCapsTitleRegex(syn);
    const m = headRe.exec(fullText);
    if (m === null) continue;
    const start = m.index;
    // End at the next major ALL-CAPS boundary heading, else EOF.
    let end = fullText.length;
    const rest = fullText.slice(start + m[0].length);
    for (const b of BOUNDARY_SYNONYMS[opts.section]) {
      const bm = allCapsTitleRegex(b).exec(rest);
      if (bm !== null) {
        const abs = start + m[0].length + bm.index;
        if (abs < end) end = abs;
      }
    }
    const text = fullText.slice(start, end).trim();
    if (text.length >= minChars) {
      return { ok: true, text, method: "exhibit-header", chars: text.length, diagnostics };
    }
    notes.push(`exhibit heading "${syn}" slice too short (${text.length} chars)`);
  }

  return {
    ok: false,
    error: new ExtractionError("no_section_found", `no ${opts.section} section found in exhibit (titles tried: ${synonyms.join("; ")})`),
    diagnostics,
  };
}

function buildSynonyms(kind: SectionKind, quoted: string[]): string[] {
  const out: string[] = [];
  for (const q of quoted) {
    const n = normalizeTitle(q);
    if (n.length >= 3 && !out.includes(n)) out.push(n);
    // "Financial Review – Risk Factors" → also try the segment after the dash.
    const seg = n.split(" - ").pop();
    if (seg !== undefined && seg !== n && seg.length >= 3 && !out.includes(seg)) out.push(seg);
  }
  for (const s of TITLE_SYNONYMS[kind]) if (!out.includes(s)) out.push(s);
  return out;
}

/** Build a case-sensitive ALL-CAPS regex for a normalized title. */
function allCapsTitleRegex(normTitle: string): RegExp {
  const words = normTitle
    .toUpperCase()
    .split(/\s+/)
    .filter((w) => w !== "");
  const body = words
    .map((w) => (w === "AND" ? "(?:AND|&)" : escapeRegExp(w).replace(/'/g, "['’]")))
    .join("[\\s]+");
  return new RegExp(body, "g");
}
