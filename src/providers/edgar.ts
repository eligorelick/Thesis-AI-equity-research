/**
 * SEC EDGAR client (server-only). Fully LIVE — keyless, but every request MUST
 * send the declared User-Agent (403 without it on both www.sec.gov and
 * data.sec.gov, live-verified).
 *
 * Conventions per the provider data contract §1.2:
 *   - Hosts: www.sec.gov (Archives, tickers), data.sec.gov (submissions/XBRL),
 *     efts.sec.gov (full-text search).
 *   - Client-side throttle ≤5 req/s with jitter.
 *   - A 403 mid-session is SEC's RATE-LIMIT signal, not an auth failure →
 *     enter a ~10-minute cooldown and surface a retryable EdgarRateLimitError.
 *   - data.sec.gov needs 10-digit zero-padded CIK ("CIK0000320193"); Archives
 *     URLs take the unpadded integer. Never derive CIK from accession numbers.
 *   - Filed documents are immutable → cache ~forever; submissions ~6h;
 *     company_tickers ~7d; companyfacts ~6h; full-text search ~24h.
 *
 * Wiring: all HTTP flows through the injectable `EdgarTransport` interface.
 *  - createDefaultEdgarTransport(): shared http.ts "edgar" limiter (≤5 req/s)
 *    + retries via fetchWithPolicy + a small in-memory TTL cache. No DB.
 *  - createDbCachedEdgarTransport(): additionally routes 200s through the
 *    durable api_cache (cache/apiCache.cachedFetch, lazy-loaded) — use this
 *    in the report pipeline: createEdgarClient({ transport: createDbCachedEdgarTransport() }).
 */

import "server-only";

import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";
import { companyFactsSchema, type CompanyFacts } from "@/edgar/xbrl";
import {
  HttpRequestAbortedError,
  HttpTransportError,
  fetchWithPolicy,
  getProviderLimiter,
  makeLimiter,
  type HttpResult,
  type TokenBucketLimiter,
} from "@/providers/http";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * SEC-required declared-bot User-Agent — sent on EVERY request.
 *
 * The SEC mandates a real declared contact (a name/org + a reachable email) in
 * the User-Agent and 403s requests without one. Set `EDGAR_CONTACT` in your
 * `.env` to your own contact string (format: `"Your Name your-email@example.com"`).
 * When unset, a generic placeholder is used — enough for local smoke tests, but
 * you SHOULD supply your own before any sustained use so the SEC can reach you.
 * Resolved once at module load (Next.js populates `process.env` from `.env`).
 */
const DEFAULT_EDGAR_CONTACT = "Thesis Research contact@example.com";

/** True only for an identity with a reachable-looking, non-placeholder email. */
export function hasConfiguredEdgarIdentity(contact = process.env.EDGAR_CONTACT?.trim() ?? ""): boolean {
  const email = contact.match(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/i);
  if (email === null) return false;
  const domain = email[1].toLowerCase();
  const reservedDomains = ["example.com", "example.org", "example.net"];
  if (reservedDomains.some((reserved) => domain === reserved || domain.endsWith(`.${reserved}`))) {
    return false;
  }
  const topLevel = domain.split(".").at(-1);
  if (topLevel === "example" || topLevel === "invalid" || topLevel === "localhost" || topLevel === "test") {
    return false;
  }
  const declaredName = contact.replace(email[0], "").replace(/[<>()]/g, "").trim();
  return declaredName.length >= 2;
}

/** Resolve the declared contact, else a detection-only placeholder rejected for live access. */
export function resolveEdgarUserAgent(): string {
  const contact = process.env.EDGAR_CONTACT?.trim();
  return contact !== undefined && contact.length > 0 ? contact : DEFAULT_EDGAR_CONTACT;
}

export const EDGAR_USER_AGENT = resolveEdgarUserAgent();

export const EDGAR_HOSTS = {
  www: "https://www.sec.gov",
  data: "https://data.sec.gov",
  efts: "https://efts.sec.gov",
} as const;

const HOUR = 3_600_000;
export const EDGAR_TTL = {
  /** company_tickers.json — SEC says "periodically" updated. */
  tickers: 7 * 24 * HOUR,
  submissions: 6 * HOUR,
  companyFacts: 6 * HOUR,
  /** Filed documents are immutable. */
  filing: 10 * 365 * 24 * HOUR,
  fullTextSearch: 24 * HOUR,
} as const;

/** ≤5 req/s policy (official max is 10/s). */
export const EDGAR_MAX_RPS = 5;
/** Cooldown after a 403 (SEC's rate-limit response). */
export const EDGAR_COOLDOWN_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Pure helpers: CIK / accession / URL builders
// ---------------------------------------------------------------------------

/** Zero-pad a CIK to the 10-digit form data.sec.gov requires ("320193" -> "0000320193"). */
export function padCik(cik: number | string): string {
  const s = String(cik).replace(/^CIK/i, "").trim();
  if (!/^\d{1,10}$/.test(s)) throw new Error(`padCik: invalid CIK "${cik}"`);
  return s.padStart(10, "0");
}

/** Compare SEC entity identities in their canonical ten-digit form. */
export function sameCik(expected: number | string, actual: number | string): boolean {
  try {
    return padCik(expected) === padCik(actual);
  } catch {
    return false;
  }
}

/** Unpadded integer form used by Archives URLs. */
export function unpadCik(cik: number | string): string {
  const s = String(cik).replace(/^CIK/i, "").trim();
  if (!/^\d{1,10}$/.test(s)) throw new Error(`unpadCik: invalid CIK "${cik}"`);
  return String(Number.parseInt(s, 10));
}

/** "0000320193-25-000079" -> "000032019325000079" (validates the dashed form). */
export function stripAccessionDashes(accession: string): string {
  const s = accession.trim();
  if (/^\d{18}$/.test(s)) return s;
  if (!/^\d{10}-\d{2}-\d{6}$/.test(s)) throw new Error(`stripAccessionDashes: invalid accession "${accession}"`);
  return s.replace(/-/g, "");
}

/** Re-insert dashes: "000032019325000079" -> "0000320193-25-000079". */
export function dashAccession(accession: string): string {
  const s = accession.trim();
  if (/^\d{10}-\d{2}-\d{6}$/.test(s)) return s;
  if (!/^\d{18}$/.test(s)) throw new Error(`dashAccession: invalid accession "${accession}"`);
  return `${s.slice(0, 10)}-${s.slice(10, 12)}-${s.slice(12)}`;
}

/**
 * Archives URL builder:
 * https://www.sec.gov/Archives/edgar/data/{cik-unpadded}/{accession-no-dashes}/{filename}
 */
export function archivesUrl(cik: number | string, accession: string, filename = ""): string {
  const base = `${EDGAR_HOSTS.www}/Archives/edgar/data/${unpadCik(cik)}/${stripAccessionDashes(accession)}`;
  return filename === "" ? base : `${base}/${filename}`;
}

/** Machine-readable exhibit-type map source (research gap-edgar-exhibit-and-banks.md §1.2). */
export function indexHeadersUrl(cik: number | string, accession: string): string {
  return archivesUrl(cik, accession, `${dashAccession(accession)}-index-headers.html`);
}

/** Human filing-index page (fallback exhibit-type source: Type column). */
export function indexHtmUrl(cik: number | string, accession: string): string {
  return archivesUrl(cik, accession, `${dashAccession(accession)}-index.htm`);
}

// ---------------------------------------------------------------------------
// index-headers.html parsing (pure)
// ---------------------------------------------------------------------------

export interface FilingDocumentEntry {
  type: string;
  sequence: string;
  filename: string;
  description?: string;
}

export interface FilingIndex {
  documents: FilingDocumentEntry[];
  /** filename -> TYPE (e.g. "wfc-20251231.htm" -> "EX-13"). */
  typeByFilename: Record<string, string>;
  /** From CONFORMED PERIOD OF REPORT (YYYY-MM-DD) when present. */
  periodOfReport?: string;
  /** From FILED AS OF DATE (YYYY-MM-DD) when present. */
  filedAsOf?: string;
}

/** Minimal HTML entity unescape sufficient for the escaped SGML in index-headers.html. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function yyyymmddToIso(s: string | undefined): string | undefined {
  if (s === undefined || !/^\d{8}$/.test(s)) return undefined;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * Parse {accession}-index-headers.html: the body is HTML-ESCAPED SGML —
 * unescape FIRST, then regex DOCUMENT/TYPE/SEQUENCE/FILENAME/DESCRIPTION.
 * DESCRIPTION is optional (absent on some GRAPHIC entries).
 */
export function parseIndexHeaders(html: string): FilingIndex {
  const text = unescapeHtml(html);
  const documents: FilingDocumentEntry[] = [];
  const re =
    /<DOCUMENT>\s*<TYPE>([^\n<]+)\s*<SEQUENCE>([^\n<]+)\s*<FILENAME>([^\n<]+?)\s*(?:<DESCRIPTION>([^\n<]+?)\s*)?<TEXT>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    documents.push({
      type: m[1].trim(),
      sequence: m[2].trim(),
      filename: m[3].trim(),
      description: m[4] !== undefined ? m[4].trim() : undefined,
    });
  }
  const typeByFilename: Record<string, string> = {};
  for (const d of documents) typeByFilename[d.filename] = d.type;
  const period = /CONFORMED PERIOD OF REPORT:\s*(\d{8})/.exec(text);
  const filed = /FILED AS OF DATE:\s*(\d{8})/.exec(text);
  return {
    documents,
    typeByFilename,
    periodOfReport: yyyymmddToIso(period?.[1]),
    filedAsOf: yyyymmddToIso(filed?.[1]),
  };
}

/**
 * Fallback parser for the human {accession}-index.htm page
 * (tables with columns Seq | Description | Document | Type | Size).
 */
export function parseIndexHtm(html: string): FilingIndex {
  const documents: FilingDocumentEntry[] = [];
  const rowRe = /<tr\b[\s\S]*?<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html)) !== null) {
    const cells: string[] = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c: RegExpExecArray | null;
    let href = "";
    while ((c = cellRe.exec(row[0])) !== null) {
      const inner = c[1];
      const a = /<a\b[^>]*href="([^"]+)"[^>]*>/i.exec(inner);
      if (a !== null && href === "") href = a[1];
      cells.push(
        unescapeHtml(inner.replace(/<[^>]*>/g, " "))
          .replace(/&nbsp;| /g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      );
    }
    // Expect: seq, description, document, type, size
    if (cells.length >= 5 && /^\d+$/.test(cells[0])) {
      const filename = href !== "" ? href.split("/").pop() ?? "" : cells[2].split(" ")[0];
      if (filename !== "") {
        documents.push({ type: cells[3], sequence: cells[0], filename, description: cells[1] });
      }
    }
  }
  const typeByFilename: Record<string, string> = {};
  for (const d of documents) typeByFilename[d.filename] = d.type;
  return { documents, typeByFilename };
}

/**
 * Exhibit type match by PREFIX, never exact string ("EX-13", "EX-13.1",
 * WFC-style letter suffixes). NEVER select exhibits by filename or size —
 * WFC's EX-13 is named like a primary doc and its largest ex*-named file is a
 * compensation plan (F17).
 */
export function isExhibitType(type: string, prefix: string): boolean {
  const t = type.trim().toUpperCase();
  const p = prefix.trim().toUpperCase();
  return t === p || t.startsWith(`${p}.`) || t.startsWith(`${p}-`);
}

/** First document in the index whose TYPE matches the prefix (e.g. "EX-13"). */
export function findDocumentByType(index: FilingIndex, typePrefix: string): FilingDocumentEntry | null {
  for (const d of index.documents) {
    if (isExhibitType(d.type, typePrefix)) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Errors & transport
// ---------------------------------------------------------------------------

/** SEC 403 = rate-limit signal. Retryable after `retryAfterMs`. */
export class EdgarRateLimitError extends Error {
  readonly retryable = true;
  constructor(
    readonly url: string,
    readonly retryAfterMs: number,
  ) {
    super(`EDGAR rate-limited (403) at ${url}; back off ~${Math.round(retryAfterMs / 60000)} min`);
    this.name = "EdgarRateLimitError";
  }
}

/** Live access is disabled until the operator supplies a reachable SEC identity. */
export class EdgarIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgarIdentityError";
  }
}

/** Hard transport failure after retries (network error / persistent 5xx). */
export class EdgarHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "EdgarHttpError";
  }
}

/** A successful HTTP response whose body is unsafe to admit to an EDGAR cache. */
export class EdgarBodyValidationError extends Error {
  constructor(
    readonly url: string,
    readonly problem: string,
  ) {
    super(`EDGAR response body rejected at ${url}: ${problem}`);
    this.name = "EdgarBodyValidationError";
  }
}

export interface EdgarTransportResponse {
  status: number;
  body: string;
  /** ISO timestamp of the underlying fetch (cache-original time when served from cache). */
  fetchedAt: string;
  fromCache: boolean;
  /** True when served past TTL because a refresh failed. */
  stale: boolean;
}

export interface EdgarTransport {
  fetchText(
    url: string,
    opts: { ttlMs: number; validateBody?: (body: string) => string | null },
  ): Promise<EdgarTransportResponse>;
}

interface CacheEntry {
  body: string;
  status: number;
  fetchedAt: string;
  expiresAt: number;
}

const EDGAR_HEADERS: Record<string, string> = {
  "User-Agent": EDGAR_USER_AGENT,
  "Accept-Encoding": "gzip, deflate",
};

/**
 * Default transport: declared UA on every request, ≤5 req/s via the SHARED
 * http.ts "edgar" token-bucket limiter, in-memory TTL cache (200s only),
 * 5xx/network retries via fetchWithPolicy, serve-stale on network failure.
 * (For the durable DB-backed cache use createDbCachedEdgarTransport.)
 */
export function createDefaultEdgarTransport(opts?: {
  /** Custom rate (tests). Default: the shared "edgar" limiter (5 req/s). */
  maxRps?: number;
  userAgent?: string;
  fetchFn?: typeof fetch;
  maxCacheEntries?: number;
  /** Base backoff between retries in ms (default 500; tests use ~1). */
  retryBaseMs?: number;
  /** Job/request cancellation, composed with per-attempt request timeouts. */
  signal?: AbortSignal;
}): EdgarTransport {
  const userAgent = opts?.userAgent ?? EDGAR_USER_AGENT;
  const identityConfigured = opts?.fetchFn !== undefined || hasConfiguredEdgarIdentity(userAgent);
  if (!identityConfigured) {
    console.warn(
      "[edgar] live acquisition disabled: configure EDGAR_CONTACT with a reachable name/email",
    );
  }
  const limiter: TokenBucketLimiter =
    opts?.maxRps !== undefined ? makeLimiter(opts.maxRps, Math.max(1, Math.ceil(opts.maxRps))) : getProviderLimiter("edgar");
  const maxCacheEntries = opts?.maxCacheEntries ?? 200;
  const cache = new Map<string, CacheEntry>();

  return {
    async fetchText(url, { ttlMs, validateBody }): Promise<EdgarTransportResponse> {
      if (!identityConfigured) {
        throw new EdgarIdentityError(
          "live EDGAR acquisition disabled until EDGAR_CONTACT contains a reachable name and email",
        );
      }
      let hit = cache.get(url);
      // Do not serve a body that entered this transport before a stricter,
      // operation-specific validator was supplied.
      if (hit !== undefined && validateBody !== undefined && validateBody(hit.body) !== null) {
        cache.delete(url);
        hit = undefined;
      }
      if (hit !== undefined && Date.now() < hit.expiresAt) {
        return { status: hit.status, body: hit.body, fetchedAt: hit.fetchedAt, fromCache: true, stale: false };
      }
      let res: HttpResult;
      try {
        res = await fetchWithPolicy(
          url,
          { headers: { ...EDGAR_HEADERS, "User-Agent": userAgent }, redirect: "follow" },
          {
            provider: "edgar",
            limiter,
            maxRetries: 2,
            retryBaseDelayMs: opts?.retryBaseMs ?? 500,
            signal: opts?.signal,
            ...(opts?.fetchFn !== undefined ? { fetchImpl: opts.fetchFn } : {}),
          },
        );
      } catch (e) {
        if (e instanceof HttpRequestAbortedError) throw e;
        // Hard network failure after retries — serve stale if we have anything.
        if (hit !== undefined) {
          return { status: hit.status, body: hit.body, fetchedAt: hit.fetchedAt, fromCache: true, stale: true };
        }
        if (e instanceof HttpTransportError) throw new EdgarHttpError(url, null, e.message);
        throw e;
      }
      const fetchedAt = new Date().toISOString();
      if (res.status === 200) {
        const bodyProblem = validateBody?.(res.bodyText) ?? null;
        if (bodyProblem !== null) {
          // A semantically bad 200 is a failed refresh, not new truth. Keep the
          // prior admitted body and its original timestamp/expiry untouched.
          if (hit !== undefined) {
            return {
              status: hit.status,
              body: hit.body,
              fetchedAt: hit.fetchedAt,
              fromCache: true,
              stale: true,
            };
          }
          throw new EdgarBodyValidationError(url, bodyProblem);
        }
        if (cache.size >= maxCacheEntries) {
          const oldest = cache.keys().next();
          if (!oldest.done) cache.delete(oldest.value);
        }
        cache.set(url, { body: res.bodyText, status: res.status, fetchedAt, expiresAt: Date.now() + ttlMs });
      }
      return { status: res.status, body: res.bodyText, fetchedAt, fromCache: false, stale: false };
    },
  };
}

/**
 * DB-backed transport: routes every 200 through the durable api_cache via
 * cache/apiCache.cachedFetch (serve-stale-while-revalidate, per-endpoint TTLs).
 * The cache module (and the SQLite database under it) loads lazily on first
 * use, so importing this file never touches the DB — safe for unit tests.
 */
export function createDbCachedEdgarTransport(opts?: {
  userAgent?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): EdgarTransport {
  let cacheModule: Promise<typeof import("@/cache/apiCache")> | null = null;
  const inner = createDefaultEdgarTransport({ ...opts, maxCacheEntries: 1 });

  /** Non-200s must NOT be cached: tunnel them out of cachedFetch as a typed throw. */
  class NonOkStatus extends Error {
    constructor(readonly res: EdgarTransportResponse) {
      super(`HTTP ${res.status}`);
    }
  }

  return {
    async fetchText(url, { ttlMs, validateBody }): Promise<EdgarTransportResponse> {
      cacheModule ??= import("@/cache/apiCache");
      const { cachedFetch } = await cacheModule;
      try {
        const sourced = await cachedFetch<{ status: number; body: string }>({
          provider: "edgar",
          endpoint: url,
          params: {},
          ttlSeconds: Math.floor(ttlMs / 1000),
          maxStaleSeconds: 7 * 86_400,
          ...(validateBody !== undefined
            ? {
                validateBody: (cached: { status: number; body: string }): string | null =>
                  cached.status === 200
                    ? validateBody(cached.body)
                    : `cached EDGAR response had non-success status ${cached.status}`,
              }
            : {}),
          fetcher: async () => {
            const res = await inner.fetchText(url, { ttlMs: 0, validateBody });
            if (res.status !== 200) throw new NonOkStatus(res);
            const bodyProblem = validateBody?.(res.body) ?? null;
            if (bodyProblem !== null) throw new EdgarBodyValidationError(url, bodyProblem);
            // The inner cache serves its last-good body when a refresh fails.
            // That is safe to return to a direct caller but is not a successful
            // durable-cache refresh and must not advance the SQLite timestamp.
            if (res.stale) {
              throw new EdgarHttpError(url, null, "EDGAR refresh failed; preserving last-good durable body");
            }
            return { body: { status: res.status, body: res.body }, asOf: res.fetchedAt.slice(0, 10) };
          },
        });
        return {
          status: sourced.data.status,
          body: sourced.data.body,
          fetchedAt: sourced.fetchedAt,
          fromCache: Date.now() - Date.parse(sourced.fetchedAt) > 2_000,
          stale: sourced.stale === true,
        };
      } catch (e) {
        if (e instanceof NonOkStatus) return e.res;
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Response schemas / types
// ---------------------------------------------------------------------------

const tickerEntrySchema = z.looseObject({
  cik_str: z.number(),
  ticker: z.string(),
  title: z.string(),
});

export interface CikMapping {
  /** 10-digit zero-padded ("0000320193") for data.sec.gov. */
  cik10: string;
  /** Raw integer CIK (320193) for Archives URLs. */
  cik: number;
  ticker: string;
  title: string;
}

const recentFilingsSchema = z.looseObject({
  accessionNumber: z.array(z.string()),
  filingDate: z.array(z.string()),
  reportDate: z.array(z.string()),
  form: z.array(z.string()),
  primaryDocument: z.array(z.string()),
  primaryDocDescription: z.array(z.string().nullable()).optional(),
  isInlineXBRL: z.array(z.unknown()).optional(),
  isXBRL: z.array(z.unknown()).optional(),
  items: z.array(z.string().nullable()).optional(),
  acceptanceDateTime: z.array(z.string().nullable()).optional(),
});

const ACCESSION_NUMBER = /^\d{10}-\d{2}-\d{6}$/;

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function filingMetadataProblem(
  cik: number | string,
  filing: EdgarFiling,
  accessionWasAdmitted: boolean,
): string | null {
  if (!ACCESSION_NUMBER.test(filing.accessionNumber)) {
    return `malformed accession number "${filing.accessionNumber}"`;
  }
  if (!sameCik(cik, filing.accessionNumber.slice(0, 10)) && !accessionWasAdmitted) {
    return `accession ${filing.accessionNumber} was not admitted for requested CIK ${padCik(cik)}`;
  }
  if (!isValidIsoDate(filing.filingDate)) {
    return `invalid filing date "${filing.filingDate}"`;
  }
  const primaryDocument = filing.primaryDocument;
  if (
    primaryDocument.trim() === "" ||
    primaryDocument === "." ||
    primaryDocument === ".." ||
    primaryDocument.includes("/") ||
    primaryDocument.includes("\\")
  ) {
    return `unsafe primary document "${primaryDocument}"; expected a nonempty basename`;
  }
  return null;
}

const EDGAR_ERROR_BODY_PATTERNS: readonly RegExp[] = [
  /your request originates from an undeclared automated tool/i,
  /request rate threshold exceeded/i,
  /\bedgar is (?:currently )?(?:unavailable|undergoing (?:scheduled )?maintenance)\b/i,
  /\b(?:the )?(?:page|file) you requested (?:could not|cannot) be found\b/i,
  /\btemporarily unavailable[.;, ]+(?:please )?try again later\b/i,
  /^\s*(?:ok|not found|file not found|access denied|service unavailable|temporarily unavailable)\s*[.!]?\s*$/i,
];

function knownEdgarErrorBody(body: string): boolean {
  if (EDGAR_ERROR_BODY_PATTERNS.some((pattern) => pattern.test(body))) return true;
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]
    ?.replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const secSiteBranding = title !== undefined && /\bsec\.gov\b/i.test(title);
  const maintenanceTitleSignal =
    title !== undefined && /\b(?:scheduled )?maintenance\b|\b(?:temporarily )?unavailable\b/i.test(title);
  // SEC's site-shell maintenance page contains enough legitimate prose to
  // look meaningful. Require both the operational signal and SEC.gov title
  // branding so issuer disclosures that discuss maintenance remain valid.
  if (secSiteBranding && maintenanceTitleSignal) return true;
  if (
    title !== undefined &&
    /(?:page|file) not found\b|access denied\b|request rate threshold exceeded\b|service unavailable\b|temporarily unavailable\b|edgar (?:maintenance|unavailable)\b/i.test(
      title,
    )
  ) {
    return true;
  }
  return /<(?:[a-z][\w.-]*:)?(?:error|errorresponse|exceptionreport)\b/i.test(body) ||
    /<(?:[a-z][\w.-]*:)?code\b[^>]*>\s*(?:accessdenied|nosuchkey|requesttimeout|serviceunavailable)\s*</i.test(
      body,
    );
}

function textContent(body: string): string {
  return unescapeHtml(body)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMeaningfulHumanContent(body: string): boolean {
  const text = textContent(body);
  const words = text.match(/[A-Za-z][A-Za-z'’-]{2,}/g) ?? [];
  const uniqueWords = new Set(words.map((word) => word.toLowerCase()));
  // Lexical diversity plus sentence/connective structure admits substantive
  // plain text and ordinary HTML disclosures without treating a two-word page
  // or arbitrary tag as a filing. This is intentionally not a byte threshold.
  return words.length >= 12 &&
    uniqueWords.size >= 8 &&
    (/[.!?;:]/.test(text) || /\b(?:and|but|because|while|which|that)\b/i.test(text));
}

const XBRL_INSTANCE_NAMESPACE = "http://www.xbrl.org/2003/instance";
const INLINE_XBRL_NAMESPACES = new Set([
  "http://www.xbrl.org/2013/inlineXBRL",
  "http://www.xbrl.org/2008/inlineXBRL",
]);
const INLINE_XBRL_LOCAL_NAMES = new Set([
  "continuation",
  "denominator",
  "exclude",
  "footnote",
  "fraction",
  "header",
  "hidden",
  "nonfraction",
  "nonnumeric",
  "numerator",
  "references",
  "relationship",
  "resources",
  "tuple",
]);
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

interface XbrlMarkupScan {
  found: boolean;
  malformed: boolean;
}

interface ParsedName {
  name: string;
  end: number;
}

interface ParsedStartTag {
  qName: string;
  end: number;
  selfClosing: boolean;
  declarations: Map<string, string>;
}

const MARKUP_NAME_PATTERN = /[\p{L}_][\p{L}\p{N}\p{M}_.\-\u00B7\u203F\u2040]*(?::[\p{L}_][\p{L}\p{N}\p{M}_.\-\u00B7\u203F\u2040]*)?/uy;

function readMarkupName(body: string, start: number): ParsedName | null {
  // XML Names permit Unicode letters; prefix labels are non-normative and
  // must not be constrained to ASCII spellings.
  MARKUP_NAME_PATTERN.lastIndex = start;
  const match = MARKUP_NAME_PATTERN.exec(body);
  return match === null ? null : { name: match[0], end: MARKUP_NAME_PATTERN.lastIndex };
}

function isMarkupWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function skipWhitespace(body: string, start: number): number {
  let cursor = start;
  while (cursor < body.length && isMarkupWhitespace(body[cursor])) cursor++;
  return cursor;
}

/** Find a quoted ignored-region terminator; optionally honor DOCTYPE [] depth. */
function ignoredRegionEnd(
  body: string,
  start: number,
  terminator: string,
  bracketAware: boolean,
): number | null {
  let quote: "\"" | "'" | null = null;
  let bracketDepth = 0;
  for (let cursor = start; cursor < body.length; cursor++) {
    const char = body[cursor];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (bracketAware) {
      if (body.startsWith("<!--", cursor)) {
        const end = body.indexOf("-->", cursor + 4);
        if (end < 0) return null;
        cursor = end + 2;
        continue;
      }
      if (body.startsWith("<?", cursor)) {
        const end = ignoredRegionEnd(body, cursor + 2, "?>", false);
        if (end === null) return null;
        cursor = end - 1;
        continue;
      }
      if (char === "[") {
        bracketDepth++;
        continue;
      }
      if (char === "]" && bracketDepth > 0) {
        bracketDepth--;
        continue;
      }
    }
    if (bracketDepth === 0 && body.startsWith(terminator, cursor)) {
      return cursor + terminator.length;
    }
  }
  return null;
}

function parseStartTag(body: string, start: number): ParsedStartTag | null {
  const parsedName = readMarkupName(body, start + 1);
  if (parsedName === null) return null;
  let cursor = parsedName.end;
  const declarations = new Map<string, string>();
  while (cursor < body.length) {
    cursor = skipWhitespace(body, cursor);
    if (body[cursor] === ">") {
      return { qName: parsedName.name, end: cursor + 1, selfClosing: false, declarations };
    }
    if (body[cursor] === "/" && body[cursor + 1] === ">") {
      return { qName: parsedName.name, end: cursor + 2, selfClosing: true, declarations };
    }
    const attribute = readMarkupName(body, cursor);
    if (attribute === null) return null;
    cursor = skipWhitespace(body, attribute.end);
    let value: string | null = null;
    let quoted = false;
    if (body[cursor] === "=") {
      cursor = skipWhitespace(body, cursor + 1);
      const quote = body[cursor];
      if (quote === "\"" || quote === "'") {
        quoted = true;
        const valueStart = cursor + 1;
        const valueEnd = body.indexOf(quote, valueStart);
        if (valueEnd < 0) return null;
        value = body.slice(valueStart, valueEnd);
        cursor = valueEnd + 1;
      } else {
        const valueStart = cursor;
        while (cursor < body.length && !isMarkupWhitespace(body[cursor]) && body[cursor] !== ">") cursor++;
        if (cursor === valueStart) return null;
        value = body.slice(valueStart, cursor);
      }
    }

    const namespacePrefix =
      attribute.name === "xmlns"
        ? ""
        : attribute.name.startsWith("xmlns:")
          ? attribute.name.slice("xmlns:".length)
          : null;
    if (namespacePrefix !== null) {
      if (!quoted || value === null || declarations.has(namespacePrefix)) return null;
      if (namespacePrefix === "xmlns") return null;
      if (namespacePrefix === "xml" && value !== XML_NAMESPACE) return null;
      if (namespacePrefix !== "xml" && value === XML_NAMESPACE) return null;
      if (value === XMLNS_NAMESPACE) return null;
      declarations.set(namespacePrefix, value);
    }
  }
  return null;
}

function rawTextElementEnd(body: string, start: number, qName: string): number | null {
  const lowerBody = body.toLowerCase();
  const needle = `</${qName.toLowerCase()}`;
  let cursor = start;
  while (cursor < body.length) {
    const candidate = lowerBody.indexOf(needle, cursor);
    if (candidate < 0) return null;
    const afterName = candidate + needle.length;
    const boundary = body[afterName];
    if (boundary !== ">" && !isMarkupWhitespace(boundary)) {
      cursor = afterName;
      continue;
    }
    const close = skipWhitespace(body, afterName);
    return body[close] === ">" ? close + 1 : null;
  }
  return null;
}

/**
 * Recognize XBRL by namespace URI, never by a conventional prefix. This
 * quote-aware, non-executing tokenizer resolves actual xmlns attributes while
 * skipping declarations and raw-text regions. Any unterminated ignored region
 * or tag fails closed so later prose heuristics cannot admit malformed input.
 */
function scanBoundXbrlStructure(body: string): XbrlMarkupScan {
  const scopes: Array<{ qName: string; bindings: Map<string, string> }> = [];
  const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  let found = false;
  let cursor = 0;
  while (cursor < body.length) {
    const tagStart = body.indexOf("<", cursor);
    if (tagStart < 0) break;

    if (body.startsWith("<!--", tagStart)) {
      const end = body.indexOf("-->", tagStart + 4);
      if (end < 0) return { found: false, malformed: true };
      cursor = end + 3;
      continue;
    }
    if (body.startsWith("<![CDATA[", tagStart)) {
      const end = body.indexOf("]]>", tagStart + 9);
      if (end < 0) return { found: false, malformed: true };
      cursor = end + 3;
      continue;
    }
    if (body.startsWith("<?", tagStart)) {
      const end = ignoredRegionEnd(body, tagStart + 2, "?>", false);
      if (end === null) return { found: false, malformed: true };
      cursor = end;
      continue;
    }
    if (body.startsWith("<!", tagStart)) {
      const end = ignoredRegionEnd(body, tagStart + 2, ">", true);
      if (end === null) return { found: false, malformed: true };
      cursor = end;
      continue;
    }

    if (body.startsWith("</", tagStart)) {
      const closingName = readMarkupName(body, tagStart + 2);
      if (closingName === null) return { found: false, malformed: true };
      const close = skipWhitespace(body, closingName.end);
      if (body[close] !== ">") return { found: false, malformed: true };
      const scopeIndex = scopes.findLastIndex(
        (scope) => scope.qName.toLowerCase() === closingName.name.toLowerCase(),
      );
      if (scopeIndex >= 0) scopes.splice(scopeIndex);
      cursor = close + 1;
      continue;
    }

    const tag = parseStartTag(body, tagStart);
    if (tag === null) {
      // A name-looking opener is an unterminated/malformed tag. A lone '<'
      // used as prose is ignored for compatibility with imperfect HTML/text.
      if (readMarkupName(body, tagStart + 1) !== null) return { found: false, malformed: true };
      cursor = tagStart + 1;
      continue;
    }

    const bindings = new Map(scopes.at(-1)?.bindings ?? []);
    for (const [prefix, namespace] of tag.declarations) bindings.set(prefix, namespace);
    const colon = tag.qName.indexOf(":");
    const prefix = colon >= 0 ? tag.qName.slice(0, colon) : "";
    const localName = (colon >= 0 ? tag.qName.slice(colon + 1) : tag.qName).toLowerCase();
    const namespace = bindings.get(prefix);
    if (localName === "xbrl" && namespace === XBRL_INSTANCE_NAMESPACE) found = true;
    if (INLINE_XBRL_LOCAL_NAMES.has(localName) && namespace !== undefined && INLINE_XBRL_NAMESPACES.has(namespace)) {
      found = true;
    }

    const rawTextElement =
      localName === "script" || localName === "style" || localName === "title" || localName === "textarea";
    if (rawTextElement && !tag.selfClosing) {
      const end = rawTextElementEnd(body, tag.end, tag.qName);
      if (end === null) return { found: false, malformed: true };
      cursor = end;
      continue;
    }
    const htmlVoid = prefix === "" && voidElements.has(localName);
    if (!tag.selfClosing && !htmlVoid) scopes.push({ qName: tag.qName, bindings });
    cursor = tag.end;
  }
  return { found, malformed: false };
}

/** Return a semantic problem for a successful filing-document body, if any. */
export function filingDocumentBodyProblem(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed === "") return "filing document response was empty";
  if (knownEdgarErrorBody(trimmed)) return "filing document response was an SEC error or placeholder page";
  const xbrlScan = scanBoundXbrlStructure(trimmed);
  if (xbrlScan.malformed) return "filing document response contained malformed or unterminated markup";

  // SEC filing artifacts legitimately arrive as HTML/iXBRL, XML/XBRL, SGML,
  // or plain text. Recognize filing structures/terms first, then fall back to
  // meaningful human prose. Markup or an XML declaration alone proves nothing.
  if (
    xbrlScan.found ||
    /<SEC-DOCUMENT\b|<DOCUMENT\b[\s\S]*?<TYPE>[\s\S]*?<TEXT\b/i.test(trimmed)
  ) {
    return null;
  }
  if (
    /\b(?:united states securities and exchange commission|annual (?:report|filing)|quarterly (?:report|filing)|current report|filing disclosure|registrant|exhibit\s+(?:\d+(?:\.\d+)?|[A-Z]\b)|(?:form\s+)?(?:10-[KQ]|20-F|6-K|8-K)|accession number)\b/i.test(
      trimmed,
    )
  ) {
    return null;
  }
  if (hasMeaningfulHumanContent(trimmed)) return null;
  return "filing document response was implausible SEC filing content";
}

/** Validate the two SEC Archives filing-index representations before caching. */
function filingIndexBodyProblem(body: string): string | null {
  const genericProblem = filingDocumentBodyProblem(body);
  if (genericProblem !== null) return genericProblem.replace("filing document", "filing index");
  const text = unescapeHtml(body);
  const sgmlIndex = /<DOCUMENT>[\s\S]*?<TYPE>[^\r\n<]+[\s\S]*?<FILENAME>[^\r\n<]+/i.test(text);
  const htmlIndex =
    /<table\b/i.test(text) &&
    /\b(?:document|document format files)\b/i.test(text) &&
    /\btype\b/i.test(text) &&
    /<a\b[^>]*href=/i.test(text);
  const plainTextIndex =
    /\baccession(?:-| )number\b/i.test(text) &&
    /\b(?:filename|document|public document count)\b/i.test(text);
  return sgmlIndex || htmlIndex || plainTextIndex
    ? null
    : "filing index response lacked SEC document-index structure";
}

const submissionsSchema = z.looseObject({
  cik: z.string(),
  name: z.string(),
  sic: z.string().nullish(),
  sicDescription: z.string().nullish(),
  fiscalYearEnd: z.string().nullish(),
  stateOfIncorporation: z.string().nullish(),
  tickers: z.array(z.string()).optional(),
  exchanges: z.array(z.string().nullable()).optional(),
  filings: z.looseObject({
    recent: recentFilingsSchema,
    files: z
      .array(
        z.looseObject({
          name: z.string(),
          filingCount: z.number().optional(),
          filingFrom: z.string().optional(),
          filingTo: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

export interface EdgarFiling {
  accessionNumber: string;
  form: string;
  filingDate: string;
  reportDate: string;
  primaryDocument: string;
  primaryDocDescription?: string;
  isInlineXBRL?: boolean;
  items?: string;
  acceptanceDateTime?: string;
}

export interface EdgarSubmissions {
  cik: string;
  name: string;
  sic: string | null;
  sicDescription: string | null;
  fiscalYearEnd: string | null;
  stateOfIncorporation: string | null;
  tickers: string[];
  exchanges: (string | null)[];
  /** filings.recent converted from parallel arrays to row objects, newest first. */
  recentFilings: EdgarFiling[];
  /** Older-history overflow page descriptors (not fetched by this client). */
  olderPages: { name: string; filingCount?: number; filingFrom?: string; filingTo?: string }[];
}

const eftsSchema = z.looseObject({
  hits: z.looseObject({
    total: z.looseObject({ value: z.number() }),
    hits: z.array(
      z.looseObject({
        _id: z.string(),
        _source: z.record(z.string(), z.unknown()),
      }),
    ),
  }),
});

export interface FullTextSearchHit {
  /** "{accession-with-dashes}:{filename}" */
  id: string;
  accession: string;
  filename: string;
  form?: string;
  fileDate?: string;
  fileType?: string;
  ciks: string[];
  displayNames: string[];
  source: Record<string, unknown>;
}

export interface FullTextSearchResult {
  total: number;
  hits: FullTextSearchHit[];
}

export interface FullTextSearchOptions {
  forms?: string | string[];
  ciks?: string | number | (string | number)[];
  startdt?: string;
  enddt?: string;
  /** Pagination offset (UI sends &from=N; unverified beyond first page). */
  from?: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface EdgarClientOptions {
  transport?: EdgarTransport;
  maxRps?: number;
  cooldownMs?: number;
  userAgent?: string;
  fetchFn?: typeof fetch;
}

interface RequestOk {
  ok: true;
  body: string;
  fetchedAt: string;
  stale: boolean;
}

interface RequestGap {
  ok: false;
  status: number;
  bodyProblem?: string;
}

export class EdgarClient {
  private readonly transport: EdgarTransport;
  private readonly cooldownMs: number;
  private cooldownUntil = 0;
  private tickerMap: { map: Map<string, CikMapping>; fetchedAt: string; stale: boolean } | null = null;
  private readonly admittedAccessionsByCik = new Map<string, Set<string>>();

  constructor(opts: EdgarClientOptions = {}) {
    this.transport =
      opts.transport ??
      createDefaultEdgarTransport({ maxRps: opts.maxRps, userAgent: opts.userAgent, fetchFn: opts.fetchFn });
    this.cooldownMs = opts.cooldownMs ?? EDGAR_COOLDOWN_MS;
  }

  /** Milliseconds remaining in the 403 cooldown window (0 = not rate-limited). */
  cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  private async request(
    url: string,
    ttlMs: number,
    validateBody?: (body: string) => string | null,
  ): Promise<RequestOk | RequestGap> {
    const remaining = this.cooldownRemainingMs();
    if (remaining > 0) throw new EdgarRateLimitError(url, remaining);
    let res: EdgarTransportResponse;
    try {
      res = await this.transport.fetchText(url, { ttlMs, validateBody });
    } catch (err) {
      if (err instanceof EdgarBodyValidationError) {
        return { ok: false, status: 200, bodyProblem: err.problem };
      }
      throw err;
    }
    if (res.status === 200) {
      return { ok: true, body: res.body, fetchedAt: res.fetchedAt, stale: res.stale };
    }
    if (res.status === 403 || res.status === 429) {
      // Mid-session 403 = rate-limit signal (works-then-403 pattern), not auth.
      this.cooldownUntil = Date.now() + this.cooldownMs;
      throw new EdgarRateLimitError(url, this.cooldownMs);
    }
    if (res.status >= 500) {
      throw new EdgarHttpError(url, res.status, `EDGAR ${res.status} after retries at ${url}`);
    }
    return { ok: false, status: res.status };
  }

  private gap(field: string, reason: string, urls: string[], severity: ManifestEntry["severity"] = "warn"): { ok: false; gap: ManifestEntry } {
    return { ok: false, gap: { field, reason, severity, attemptedSources: urls } };
  }

  private sourced<T>(data: T, endpoint: string, asOf: string, fetchedAt: string, stale: boolean): Sourced<T> {
    return { data, asOf, source: "edgar", endpoint, fetchedAt, ...(stale ? { stale: true } : {}) };
  }

  // -- ticker -> CIK ---------------------------------------------------------

  /**
   * Resolve a ticker via https://www.sec.gov/files/company_tickers.json
   * (object keyed by array index, cik_str UNPADDED int; 1,476 CIKs appear under
   * multiple tickers — map is built ticker→cik, first occurrence wins).
   * Cached ~7 days. Tries "BRK.B" ⇄ "BRK-B" spellings.
   */
  async tickerToCik(symbol: string): Promise<FetchResult<CikMapping>> {
    const url = `${EDGAR_HOSTS.www}/files/company_tickers.json`;
    const mapExpired =
      this.tickerMap !== null && Date.now() - Date.parse(this.tickerMap.fetchedAt) > EDGAR_TTL.tickers;
    if (this.tickerMap === null || mapExpired) {
      const res = await this.request(url, EDGAR_TTL.tickers);
      if (!res.ok) return this.gap(`edgar.tickerToCik(${symbol})`, `company_tickers.json HTTP ${res.status}`, [url], "critical");
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(res.body);
      } catch {
        return this.gap(`edgar.tickerToCik(${symbol})`, "company_tickers.json was not valid JSON", [url], "critical");
      }
      const rec = z.record(z.string(), z.unknown()).safeParse(parsedJson);
      if (!rec.success) {
        return this.gap(`edgar.tickerToCik(${symbol})`, "company_tickers.json shape unexpected", [url], "critical");
      }
      const map = new Map<string, CikMapping>();
      for (const v of Object.values(rec.data)) {
        const e = tickerEntrySchema.safeParse(v);
        if (!e.success) continue;
        const key = e.data.ticker.toUpperCase();
        if (!map.has(key)) {
          map.set(key, {
            cik10: padCik(e.data.cik_str),
            cik: e.data.cik_str,
            ticker: e.data.ticker,
            title: e.data.title,
          });
        }
      }
      this.tickerMap = { map, fetchedAt: res.fetchedAt, stale: res.stale };
    }
    const { map, fetchedAt, stale } = this.tickerMap;
    const u = symbol.trim().toUpperCase();
    const found = map.get(u) ?? map.get(u.replace(/\./g, "-")) ?? map.get(u.replace(/-/g, "."));
    if (found === undefined) {
      return this.gap(`edgar.tickerToCik(${symbol})`, `ticker "${symbol}" not in SEC company_tickers.json`, [url]);
    }
    return { ok: true, value: this.sourced(found, url, fetchedAt.slice(0, 10), fetchedAt, stale) };
  }

  // -- submissions -----------------------------------------------------------

  /**
   * https://data.sec.gov/submissions/CIK{10-digit}.json — filings.recent is a
   * struct of parallel arrays, newest first, ≥1 year or 1,000 filings
   * (JPM: 25,280 rows). Older overflow pages are listed but not fetched.
   */
  async submissions(cik: number | string): Promise<FetchResult<EdgarSubmissions>> {
    const url = `${EDGAR_HOSTS.data}/submissions/CIK${padCik(cik)}.json`;
    const res = await this.request(url, EDGAR_TTL.submissions);
    if (!res.ok) return this.gap(`edgar.submissions(${cik})`, `submissions HTTP ${res.status}`, [url]);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(res.body);
    } catch {
      return this.gap(`edgar.submissions(${cik})`, "submissions response was not valid JSON", [url]);
    }
    const parsed = submissionsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return this.gap(`edgar.submissions(${cik})`, `submissions shape unexpected: ${parsed.error.issues[0]?.message ?? "?"}`, [url]);
    }
    if (!sameCik(cik, parsed.data.cik)) {
      return this.gap(
        `edgar.submissions(${cik})`,
        `submissions CIK ${parsed.data.cik} did not match requested CIK ${padCik(cik)}`,
        [url],
      );
    }
    const d = parsed.data;
    const r = d.filings.recent;
    const n = r.accessionNumber.length;
    for (const [field, values] of Object.entries(r)) {
      if (Array.isArray(values) && values.length !== n) {
        return this.gap(
          `edgar.submissions(${cik})`,
          `submissions parallel array ${field} had length ${values.length}; accessionNumber had length ${n}`,
          [url],
          "critical",
        );
      }
    }
    for (let i = 0; i < n; i++) {
      const accessionNumber = r.accessionNumber[i];
      const filingDate = r.filingDate[i];
      const reportDate = r.reportDate[i];
      if (!ACCESSION_NUMBER.test(accessionNumber)) {
        return this.gap(
          `edgar.submissions(${cik})`,
          `submissions filing row ${i} had malformed accession number "${accessionNumber}"`,
          [url],
          "critical",
        );
      }
      if (!isValidIsoDate(filingDate)) {
        return this.gap(
          `edgar.submissions(${cik})`,
          `submissions filing row ${i} had invalid filing date "${filingDate}"`,
          [url],
          "critical",
        );
      }
      if (reportDate !== "" && !isValidIsoDate(reportDate)) {
        return this.gap(
          `edgar.submissions(${cik})`,
          `submissions filing row ${i} had invalid report date "${reportDate}"`,
          [url],
          "critical",
        );
      }
    }
    const recentFilings: EdgarFiling[] = new Array<EdgarFiling>(n);
    for (let i = 0; i < n; i++) {
      const ix = r.isInlineXBRL?.[i];
      recentFilings[i] = {
        accessionNumber: r.accessionNumber[i],
        form: r.form[i] ?? "",
        filingDate: r.filingDate[i] ?? "",
        reportDate: r.reportDate[i] ?? "",
        primaryDocument: r.primaryDocument[i] ?? "",
        primaryDocDescription: r.primaryDocDescription?.[i] ?? undefined,
        isInlineXBRL: typeof ix === "number" ? ix === 1 : typeof ix === "boolean" ? ix : undefined,
        items: r.items?.[i] ?? undefined,
        acceptanceDateTime: r.acceptanceDateTime?.[i] ?? undefined,
      };
    }
    const sub: EdgarSubmissions = {
      cik: d.cik,
      name: d.name,
      sic: d.sic ?? null,
      sicDescription: d.sicDescription ?? null,
      fiscalYearEnd: d.fiscalYearEnd ?? null,
      stateOfIncorporation: d.stateOfIncorporation ?? null,
      tickers: d.tickers ?? [],
      exchanges: d.exchanges ?? [],
      recentFilings,
      olderPages: d.filings.files ?? [],
    };
    const asOf =
      recentFilings.length > 0 && recentFilings[0].filingDate !== "" ? recentFilings[0].filingDate : res.fetchedAt.slice(0, 10);
    this.admittedAccessionsByCik.set(padCik(cik), new Set(r.accessionNumber));
    return { ok: true, value: this.sourced(sub, url, asOf, res.fetchedAt, res.stale) };
  }

  /**
   * Newest filing of an EXACT form ("10-K" !== "10-K/A" — amendments are
   * distinct form values; scan newest-first, first exact match wins).
   */
  async latestFiling(cik: number | string, form: string): Promise<FetchResult<EdgarFiling>> {
    const sub = await this.submissions(cik);
    if (!sub.ok) return sub;
    const hit = sub.value.data.recentFilings.find((f) => f.form === form);
    if (hit === undefined) {
      return this.gap(
        `edgar.latestFiling(${cik}, ${form})`,
        `no "${form}" among ${sub.value.data.recentFilings.length} recent filings (older overflow pages not searched)`,
        [sub.value.endpoint],
      );
    }
    return { ok: true, value: this.sourced(hit, sub.value.endpoint, hit.filingDate, sub.value.fetchedAt, sub.value.stale === true) };
  }

  // -- documents -------------------------------------------------------------

  /**
   * Fetch a filing document (immutable — cached ~forever). `asOf` should be the
   * filing date when the caller knows it; defaults to fetch date.
   */
  async fetchFilingDoc(url: string, opts?: { asOf?: string }): Promise<FetchResult<string>> {
    let parsedUrl: URL;
    let host = "";
    try {
      parsedUrl = new URL(url);
      host = parsedUrl.hostname.toLowerCase();
    } catch {
      throw new Error(`fetchFilingDoc: invalid URL "${url}"`);
    }
    if (parsedUrl.protocol !== "https:") {
      throw new Error(`fetchFilingDoc: refusing non-HTTPS URL "${url}"`);
    }
    if (host !== "sec.gov" && !host.endsWith(".sec.gov")) {
      throw new Error(`fetchFilingDoc: refusing non-SEC host "${host}"`);
    }
    const res = await this.request(url, EDGAR_TTL.filing, filingDocumentBodyProblem);
    if (!res.ok) {
      return this.gap(
        `edgar.fetchFilingDoc(${url})`,
        res.bodyProblem ?? `document HTTP ${res.status}`,
        [url],
        res.bodyProblem !== undefined ? "critical" : "warn",
      );
    }
    return { ok: true, value: this.sourced(res.body, url, opts?.asOf ?? res.fetchedAt.slice(0, 10), res.fetchedAt, res.stale) };
  }

  /**
   * Validate a submissions filing row before constructing or requesting its
   * Archives URL. Provider metadata failures are data gaps, not exceptions.
   */
  async fetchFilingDocument(
    cik: number | string,
    filing: EdgarFiling,
    opts?: { asOf?: string },
  ): Promise<FetchResult<string>> {
    let problem: string | null;
    try {
      const accessionWasAdmitted =
        this.admittedAccessionsByCik.get(padCik(cik))?.has(filing.accessionNumber) === true;
      problem = filingMetadataProblem(cik, filing, accessionWasAdmitted);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      problem = `invalid filing metadata: ${reason}`;
    }
    if (problem !== null) {
      return this.gap(
        `edgar.fetchFilingDocument(${cik}, ${filing.accessionNumber})`,
        problem,
        [],
        "critical",
      );
    }

    const url = archivesUrl(cik, filing.accessionNumber, filing.primaryDocument);
    const result = await this.fetchFilingDoc(url, opts);
    if (!result.ok) return result;
    const bodyProblem = filingDocumentBodyProblem(result.value.data);
    if (bodyProblem !== null) {
      return this.gap(
        `edgar.fetchFilingDocument(${cik}, ${filing.accessionNumber})`,
        bodyProblem,
        [url],
        "critical",
      );
    }
    return result;
  }

  /**
   * filename -> TYPE map for one accession via
   * {accession-with-dashes}-index-headers.html (HTML-escaped SGML; the ONLY
   * verified machine-readable exhibit-type source — FilingSummary.xml fails,
   * index.json `type` is an icon name). Falls back to parsing -index.htm.
   */
  async filingIndexHeaders(cik: number | string, accession: string): Promise<FetchResult<FilingIndex>> {
    const url = indexHeadersUrl(cik, accession);
    const res = await this.request(url, EDGAR_TTL.filing, filingIndexBodyProblem);
    if (res.ok) {
      const idx = parseIndexHeaders(res.body);
      if (idx.documents.length > 0) {
        return { ok: true, value: this.sourced(idx, url, idx.filedAsOf ?? res.fetchedAt.slice(0, 10), res.fetchedAt, res.stale) };
      }
    }
    const fallbackUrl = indexHtmUrl(cik, accession);
    const fb = await this.request(fallbackUrl, EDGAR_TTL.filing, filingIndexBodyProblem);
    if (fb.ok) {
      const idx = parseIndexHtm(fb.body);
      if (idx.documents.length > 0) {
        return { ok: true, value: this.sourced(idx, fallbackUrl, fb.fetchedAt.slice(0, 10), fb.fetchedAt, fb.stale) };
      }
    }
    return this.gap(
      `edgar.filingIndexHeaders(${cik}, ${accession})`,
      "no DOCUMENT entries parsed from index-headers.html or -index.htm",
      [url, fallbackUrl],
    );
  }

  // -- XBRL ------------------------------------------------------------------

  /** https://data.sec.gov/api/xbrl/companyfacts/CIK{10digit}.json (~6h TTL; can be multi-MB). */
  async companyFacts(cik: number | string): Promise<FetchResult<CompanyFacts>> {
    const url = `${EDGAR_HOSTS.data}/api/xbrl/companyfacts/CIK${padCik(cik)}.json`;
    const res = await this.request(url, EDGAR_TTL.companyFacts);
    if (!res.ok) return this.gap(`edgar.companyFacts(${cik})`, `companyfacts HTTP ${res.status}`, [url]);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(res.body);
    } catch {
      return this.gap(`edgar.companyFacts(${cik})`, "companyfacts response was not valid JSON", [url]);
    }
    const parsed = companyFactsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return this.gap(`edgar.companyFacts(${cik})`, `companyfacts shape unexpected: ${parsed.error.issues[0]?.message ?? "?"}`, [url]);
    }
    if (!sameCik(cik, parsed.data.cik)) {
      return this.gap(
        `edgar.companyFacts(${cik})`,
        `companyfacts CIK ${parsed.data.cik} did not match requested CIK ${padCik(cik)}`,
        [url],
      );
    }
    const facts: CompanyFacts = {
      cik: parsed.data.cik,
      entityName: parsed.data.entityName,
      facts: parsed.data.facts,
    };
    return { ok: true, value: this.sourced(facts, url, res.fetchedAt.slice(0, 10), res.fetchedAt, res.stale) };
  }

  // -- full-text search --------------------------------------------------------

  /**
   * EFTS full-text search (2001-present). Treat as a LOCATOR (hits carry
   * accession + filename), not a snippet source. Quote phrases yourself:
   * fullTextSearch('"going concern"').
   */
  async fullTextSearch(q: string, opts: FullTextSearchOptions = {}): Promise<FetchResult<FullTextSearchResult>> {
    const params = new URLSearchParams();
    params.set("q", q);
    if (opts.forms !== undefined) {
      params.set("forms", Array.isArray(opts.forms) ? opts.forms.join(",") : opts.forms);
    }
    if (opts.ciks !== undefined) {
      const list = Array.isArray(opts.ciks) ? opts.ciks : [opts.ciks];
      params.set("ciks", list.map((c) => padCik(c)).join(","));
    }
    if (opts.startdt !== undefined || opts.enddt !== undefined) {
      params.set("dateRange", "custom");
      if (opts.startdt !== undefined) params.set("startdt", opts.startdt);
      if (opts.enddt !== undefined) params.set("enddt", opts.enddt);
    }
    if (opts.from !== undefined) params.set("from", String(opts.from));
    const url = `${EDGAR_HOSTS.efts}/LATEST/search-index?${params.toString()}`;
    const res = await this.request(url, EDGAR_TTL.fullTextSearch);
    if (!res.ok) return this.gap(`edgar.fullTextSearch(${q})`, `EFTS HTTP ${res.status}`, [url]);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(res.body);
    } catch {
      return this.gap(`edgar.fullTextSearch(${q})`, "EFTS response was not valid JSON", [url]);
    }
    const parsed = eftsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return this.gap(`edgar.fullTextSearch(${q})`, `EFTS shape unexpected: ${parsed.error.issues[0]?.message ?? "?"}`, [url]);
    }
    const hits: FullTextSearchHit[] = parsed.data.hits.hits.map((h) => {
      const [accession, filename = ""] = h._id.split(":");
      const src = h._source;
      const strOrU = (k: string): string | undefined => {
        const v = src[k];
        return typeof v === "string" ? v : undefined;
      };
      const strArr = (k: string): string[] => {
        const v = src[k];
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      };
      return {
        id: h._id,
        accession,
        filename,
        form: strOrU("form"),
        fileDate: strOrU("file_date"),
        fileType: strOrU("file_type"),
        ciks: strArr("ciks"),
        displayNames: strArr("display_names"),
        source: src,
      };
    });
    return {
      ok: true,
      value: this.sourced({ total: parsed.data.hits.total.value, hits }, url, res.fetchedAt.slice(0, 10), res.fetchedAt, res.stale),
    };
  }

  /** Convenience: Archives URL for a filing row from submissions. */
  filingDocUrl(cik: number | string, filing: EdgarFiling): string {
    return archivesUrl(cik, filing.accessionNumber, filing.primaryDocument);
  }
}

export function createEdgarClient(opts: EdgarClientOptions = {}): EdgarClient {
  return new EdgarClient(opts);
}
