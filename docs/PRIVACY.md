# Privacy and safety

Thesis runs on your machine. Its database, its cache, and every report it
generates are local files. This page lists exactly what leaves the machine, who
receives it, where the data is kept, and how to delete it.

## What leaves the machine

Nothing goes to Thesis or its authors. There is no telemetry, no analytics, no
crash reporting, and no update check. The only outbound requests are the
provider calls below, and each one goes only to the provider it names.

| Recipient | Sent on every request | Only when |
| --- | --- | --- |
| SEC EDGAR (`www.sec.gov`, `data.sec.gov`, `efts.sec.gov`) | `EDGAR_CONTACT`, verbatim, as the `User-Agent`; the ticker, CIK, and filing paths being read | A real contact is configured (`src/providers/edgar.ts` `EDGAR_USER_AGENT`, `hasConfiguredEdgarIdentity`) |
| Anthropic (`api.anthropic.com`) | The analysis prompt and the serialized ticker context payload; `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` is set |
| Anthropic's server-side web search | Search queries the model composes, executed by Anthropic on its own servers | The model chooses to search; capped at `MAX_PROVIDER_WEB_SEARCHES` = 8 uses per request (`src/providers/anthropic.ts`) |
| Financial Modeling Prep (`financialmodelingprep.com`) | The symbol and endpoint parameters; `FMP_API_KEY` in an `apikey` header, never in the URL | `FMP_API_KEY` is set |
| Yahoo (`query1.finance.yahoo.com`) | The symbol and the requested date range; a Thesis-identifying `User-Agent` (`YAHOO_DEFAULT_USER_AGENT`, mandatory — the endpoint answers 429 without one) | Prices are needed and FMP could not serve them |
| FRED (`api.stlouisfed.org`, `fred.stlouisfed.org`) | The series id; `FRED_API_KEY` as an `api_key` query parameter. Without a key, the keyless `fredgraph.csv` fallback sends the series id only | Macro series are requested |
| Finnhub (`finnhub.io`) | The symbol; `FINNHUB_API_KEY` in an `X-Finnhub-Token` header | `FINNHUB_API_KEY` is set |
| FINRA (`api.finra.org`) | The symbol and date range. Keyless: no credential is configured or sent | Short-interest data is requested |

What the Anthropic payload contains, precisely
(`src/pipeline/stageC/payload.ts`, `src/pipeline/stageC/prompts.ts`):

- Excerpts of the company's public SEC filings: 10-K Item 1A (or 20-F Item 3.D)
  risk factors, 10-K Item 7 (or 20-F Item 5) MD&A, and 10-Q Part I Item 2 MD&A,
  each truncated to a disclosed character budget.
- An excerpt of the latest earnings-call transcript, when one was retrieved.
- The ticker context payload: the computed financial figures, ratios,
  valuation inputs, and macro series for that company, each tagged with its
  source and as-of date.

All of it is public company data plus figures derived from it. No file of
yours, no watchlist, and no other symbol's data is included. The payload is
deterministic: the same inputs produce the same bytes.

## Keys

Keys are read from `.env` on the server and never reach the browser.
`src/config/env.ts` is marked `server-only` and additionally throws if it is
ever evaluated with a `window` present, so a client bundle cannot import it.
Each key is sent only to the provider it belongs to, in a header wherever the
provider supports one, so keys stay out of logged URLs and out of the
`api_cache` rows.

The `X-Thesis-Token` that non-browser clients use for mutating routes is not a
credential for anything remote, and not a lock on the API either. It is a marker
for clients that send no browser headers: `src/app/api/sameOrigin.ts` accepts a
mutating request as soon as it carries browser Fetch Metadata or a matching
`Origin`, so the token is asked for only when both are absent. That makes it a
cross-site-request-forgery guard for the browser — a page on another site cannot
forge those headers — and not local access control: any process on this machine
can set them by hand, and one with access to your account already has the
database and `.env`. The token is minted fresh at every server start into the
data directory (see below), restricted to its owner where the operating system
enforces file modes, never logged, and never sent to the browser or to any
provider.

## Where local data is kept

The SQLite database is the only durable store. Its default location is the OS
application-data directory (`src/db/paths.ts`):

- Windows: `%LOCALAPPDATA%\Thesis\thesis.db`
- macOS: `$HOME/Library/Application Support/Thesis/thesis.db`
- Linux: `$XDG_DATA_HOME/thesis/thesis.db`, else `$HOME/.local/share/thesis/thesis.db`

`THESIS_DB_PATH` overrides the file; `THESIS_DATA_DIR` overrides the directory.
SQLite writes `thesis.db-wal` and `thesis.db-shm` beside the database file.

It holds your watchlist, generated reports, job history and per-pass cost
records, saved settings, and the `api_cache` table of provider responses.

The `csrf-token` file does not follow `THESIS_DB_PATH`. It is written to
`THESIS_TOKEN_FILE` when that is set, and otherwise to `csrf-token` in the
application-data directory listed above — the directory `THESIS_DATA_DIR`
overrides (`src/app/api/sameOrigin.ts`, `requestTokenPath`). Set only
`THESIS_DB_PATH` and the database moves while the token file stays where it
was. The server prints the resolved path at every start:

```
[security] X-Thesis-Token for non-browser clients written to <path>
```

## Retention

- Cached provider rows are deleted 30 days after their stored TTL expires
  (`src/cache/maintenance.ts`, `PURGE_EXPIRED_MARGIN_SECONDS`). The sweep runs
  when the database is opened, at most once every 24 hours, and reclaims the
  file space with `VACUUM`. Filings and transcripts carry a 10-year TTL, so in
  practice they are kept, not purged.
- Reports, jobs, cost records, the watchlist, and settings are never expired.
  They persist until you delete them, and Thesis has no delete-report command:
  removing them means removing the database.

## Deleting local data

- Everything: quit Thesis and delete the database file together with its
  `-wal` and `-shm` siblings. The next start creates an empty database. The
  `csrf-token` file is deleted separately, at the path the server printed at
  startup — `THESIS_TOKEN_FILE` if you set it, otherwise `csrf-token` in the
  application-data directory, which is not necessarily the directory the
  database is in.
- Start clean while keeping the old data: point `THESIS_DATA_DIR` at a fresh
  directory (or `THESIS_DB_PATH` at a new file). Nothing reads the previous
  location afterwards.
- Stored settings only: `npm run settings:reset -- --yes`. Settings resolve in
  one order — a value stored in the database beats the matching environment
  variable, which beats the built-in default (`src/settings/settings.ts`,
  `resolveValue`) — so a model or effort choice saved from the Settings page
  goes on overriding `.env` until this command deletes it. Without `--yes` it
  prints the rows it would delete and changes nothing. Two internal rows are
  always kept, because neither is a setting: the cache-maintenance stamp and
  the settings revision counter.

## Sharing a report

An exported report embeds provider data and, when a filing or transcript was
cited, quoted excerpts of it. Sending one sends that data along with it — see
[License and data rights](DATA-RIGHTS.md).
