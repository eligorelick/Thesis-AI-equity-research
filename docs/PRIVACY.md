# Privacy and safety

Thesis runs on your machine and persists its database, cache, report history
and AI connection state locally. Report generation can send evidence to remote
AI services and request market/filing data. Local-first storage does not mean
offline execution or provider-side deletion. This page describes the current
application paths; provider retention, browser behavior and operating-system
backups are outside Thesis's control.

## What leaves the machine

The checked-in app has no author-operated telemetry, analytics, crash-report
or update-check endpoint. Application requests use the providers below;
developer/maintenance commands and browser sign-in have additional behavior
described separately. Every remote service can observe connection metadata
such as your IP address, request time and headers. The Next.js CLI that
`npm run dev` and `npm run build` invoke has its own anonymous usage
telemetry (`telemetry.nextjs.org`). `.env.example` ships
`NEXT_TELEMETRY_DISABLED=1`, which turns it off once copied to `.env`;
`npx next telemetry disable` turns it off for every project on the machine.

| Recipient | Data/credentials sent by the relevant request | Trigger |
| --- | --- | --- |
| SEC EDGAR (`www.sec.gov`, `data.sec.gov`, `efts.sec.gov`) | `EDGAR_CONTACT`, verbatim, as the `User-Agent`; the ticker, CIK, and filing paths being read | A real contact is configured (`src/providers/edgar.ts` `EDGAR_USER_AGENT`, `hasConfiguredEdgarIdentity`) |
| Anthropic (`api.anthropic.com`) | The analysis prompt and evidence payload for inference; `ANTHROPIC_API_KEY` for authenticated Messages/Models calls | Claude API runs a pass, or `auto` resolves the available model catalog |
| OpenAI (`auth.openai.com`, `api.openai.com`) | OAuth registration, token renewal/revocation and account model catalog; research prompt and ticker payload for inference | You connect ChatGPT, request its models, or run a report using that connection |
| Google through the official Gemini CLI | Google OAuth and CLI service requests; the research prompt and evidence payload for inference | You connect Gemini or run a report using that connection; the CLI owns its service endpoints |
| Anthropic's server-side web search | Search queries the model composes, executed by Anthropic on its servers and subject to its search service behavior | A Claude analyst chooses to search; capped at `MAX_PROVIDER_WEB_SEARCHES` = 8 uses per request, including separate retry/resumption requests (`src/providers/anthropic.ts`) |
| Financial Modeling Prep (`financialmodelingprep.com`) | The symbol and endpoint parameters; `FMP_API_KEY` in an `apikey` header, never in the URL | `FMP_API_KEY` is set |
| Yahoo (`query1.finance.yahoo.com`) | The symbol, chart parameters/date range and a product-identifying `User-Agent` (`YAHOO_DEFAULT_USER_AGENT`). **`EDGAR_CONTACT` is not used by the Yahoo client** | Quote or price history fallback is needed and FMP could not serve it |
| FRED (`api.stlouisfed.org`, `fred.stlouisfed.org`) | Series ID, date range and transformation parameters; keyed requests include `FRED_API_KEY` as an `api_key` query parameter. The keyless `fredgraph.csv` fallback sends no credential | Macro series are requested; CSV also provides a fallback when keyed retrieval fails |
| Finnhub (`finnhub.io`) | Symbol, endpoint/date parameters; `FINNHUB_API_KEY` in an `X-Finnhub-Token` header | `FINNHUB_API_KEY` is set |
| FINRA (`api.finra.org`) | Partition requests; symbol and requested settlement cycles in short-interest queries. The production path configures no FINRA credential | Short-interest data is requested |

Cache hits may avoid these requests. Expired hits can trigger a background
refresh even while the UI displays stored data. Opening a company page can
fetch data without starting paid AI research. AI off disables inference;
it does not disable market-data or SEC requests. Fixture market data does not
disable a selected, connected AI provider.

`npm run models:refresh` separately reads Anthropic's Models API with the
ordinary API key and its public pricing page (`platform.claude.com`).
`npm run costs:reconcile` reads the organization's Cost API at
`api.anthropic.com/v1/organizations/cost_report` using
`ANTHROPIC_ADMIN_KEY`, sending a date window/pagination parameters, not a
research payload. It can make that remote read in its default dry run; no
report path calls the Admin API. Package installation/security audits can
contact package registries or advisory services. Thesis does not control
those developer tools' telemetry.

Browser OAuth involves the provider's sign-in website and any identity
services the browser follows. Clicking source, documentation or quota links
also opens external sites under the browser's own privacy settings. The table
is not an inventory of all traffic from Chrome, the operating system or the
separately installed Gemini CLI.

## What the AI provider receives

What the selected AI provider's research payload contains, precisely
(`src/pipeline/stageC/payload.ts`, `src/pipeline/stageC/prompts.ts`):

- Excerpts of the company's public SEC filings: 10-K Item 1A (or 20-F Item 3.D)
  risk factors, 10-K Item 7 (or 20-F Item 5) MD&A, and 10-Q Part I Item 2 MD&A,
  each truncated to a disclosed character budget.
- An excerpt of the latest earnings-call transcript, when one was retrieved.
- The ticker context payload: the computed financial figures, ratios,
  valuation inputs, macro series, and public peer-company comparisons used
  for that company, each tagged with its source and as-of date.
- Compact statements and analyst estimates/targets, insider activity and
  sentiment, institutional holders, executives/compensation, short interest,
  segments, news/press snippets, validation flags, missing-data disclosures
  and numeric/prose provenance registries when available.
- Research instructions and output schemas. Synthesis additionally receives
  the bull and bear model outputs; repair requests can include rejected output
  and validation feedback. Paused Claude requests append earlier assistant
  content. These texts can repeat provider-derived evidence.

This is provider-supplied company/market data, public filing excerpts and
derived figures, including data available only under a vendor subscription.
Public records can name executives, insiders and institutional holders.
The research payload builder does not read arbitrary private files or include
your complete watchlist. A requested symbol still reveals which company you
are researching. Public data for peers and market
benchmarks can support the selected company's analysis. The payload is
deterministic: the same inputs produce the same bytes.

Text budgets are 18,000 characters for the latest transcript, 14,000 each for
annual risk factors and MD&A, 8,000 for quarterly MD&A, and 6,000 for news
snippets. Compact statement extracts keep five annual and four quarterly
periods, and list-shaped sources generally keep twelve rows. These are
character/row limits, not a guaranteed overall prompt-token limit. Truncation
is disclosed. The database can cache full provider responses beyond what the
model receives.

ChatGPT requests set `store: false` and stream Responses API output. That
request option does not establish zero retention by OpenAI. Gemini is prompted
to use only supplied evidence and is configured to deny tools, hooks, MCP,
extensions and project context. Subscription adapters expose no additional
web-search tool; Claude analysts retain bounded server-side search. Thesis
does not train a model or change provider account data-use/retention policies.

## Keys

Keys are read from `.env` on the server and never reach the browser.
`src/config/env.ts` is marked `server-only` and additionally throws if it is
ever evaluated with a `window` present, so a client bundle cannot import it.
The built-in clients send each key to its provider. FMP and Finnhub use
headers; FRED requires an `api_key` URL query parameter. Cache parameters omit
those keys. This is not a blanket guarantee that keys cannot appear in
external network diagnostics or an unexpected dependency error. The app
does not encrypt `.env`, and the server-only boundary does not protect it from
other processes running with your account's filesystem access. Avoid sharing
environment files, connection directories or unreviewed diagnostic output.

The `X-Thesis-Token` that non-browser clients use for mutating routes is not a
credential for anything remote, and not a lock on the API either. It is a marker
for clients that send no browser headers: `src/app/api/sameOrigin.ts` accepts a
mutating request with an allowed Host and a matching `Origin`, or accepted
non-cross-site Fetch Metadata when `Origin` is absent. The token is asked for
only when both are absent. That makes it a
cross-site-request-forgery guard for the browser — a page on another site cannot
forge those headers — and not local access control: any process on this machine
can set them by hand, and one with access to your account already has the
database and `.env`. The token is minted fresh at every server start into the
data directory (see below), restricted to its owner where the operating system
enforces file modes, never logged, and never sent to the browser or to any
provider.

The npm dev/start scripts bind to **127.0.0.1**. The request-wide proxy rejects
direct Hosts outside loopback or the exact `THESIS_ALLOWED_HOST` allowlist,
including read routes. Company landing GET/HEAD requests additionally reject
cross-origin subresource/speculation requests using Fetch Metadata, while
allowing normal top-level navigation and header-free local scripts. Mutating
routes use the guard above. Thesis has no user login or caller authentication;
allowlisting a LAN host does not add either, and an allowed client can read
reports and invoke actions. AI connection GET/POST additionally require the
same-origin/token guard and strict localhost/127.0.0.1/[::1] access, even with
a LAN allowlist. Local browser traffic uses HTTP under the default
scripts; HTTPS to remote providers does not encrypt the local database.

## Where local data is kept

**Settings → Appearance** stores only `current` or `workspace` in the browser's
`thesis-ui-design` cookie for 180 days (`Path=/`, `SameSite=Lax`, and `Secure`
on HTTPS). It is sent to the local Thesis host, never to a provider. Cookies
are scoped by host, not port, so Thesis instances on the same host share it.
Choosing Current restores the default; clearing this cookie also
resets the design. If the browser refuses storage, the choice applies for the
current visit and Settings displays a warning. This preference does not change
the database, AI connection, model, reasoning effort, reports or exports.

The SQLite database holds reports, caches and ordinary settings. Its default location is the OS
application-data directory (`src/db/paths.ts`):

- Windows: `%LOCALAPPDATA%\Thesis\thesis.db`
- macOS: `$HOME/Library/Application Support/Thesis/thesis.db`
- Linux: `$XDG_DATA_HOME/thesis/thesis.db`, else `$HOME/.local/share/thesis/thesis.db`

`THESIS_DB_PATH` overrides the file; `THESIS_DATA_DIR` overrides the directory.
SQLite writes `thesis.db-wal` and `thesis.db-shm` beside the database file.

On Windows, `APPDATA` is the fallback if `LOCALAPPDATA` is unavailable. Blank
path overrides are treated as unset. The resolved active path is printed by
the database opener. A legacy workspace `data/thesis.db` is ignored by default;
`THESIS_IMPORT_LEGACY_DB=1` intentionally copies it and any WAL/SHM siblings
only when no explicit DB path is set and the destination does not exist. The
old copy is retained, so deleting the active database does not delete that
legacy copy. Turn off the import flag before expecting a fresh database.

It holds your watchlist, generated reports, job history and per-pass/request
cost records, saved settings, and the `api_cache` table of provider responses.
Jobs retain analyst snapshots, payload fingerprints, errors and step detail;
`job_pass_artifacts` retain settled outputs/failures, usage and cost evidence;
`job_llm_leases` hold in-flight reservation/lease metadata. These records may
contain model text and evidence absent from a final exported report. Public
API responses can include full filing HTML, transcripts and names appearing
in financial records.

The SQLite database has **no application encryption at rest**. Cache bodies at
or above 65,536 UTF-8 bytes are gzip-compressed; compression is not encryption.
The app creates the database directory without tightening its filesystem
permissions. Access therefore depends on the OS, chosen directory permissions,
disk encryption and any backup/sync software you use. Reports, watchlist and
ordinary settings are intentionally served to the local browser; being
server-only does not make them inaccessible to that browser.

AI connections are kept separately in the OS user's `Thesis/ai` directory:
`%LOCALAPPDATA%` on Windows, `$HOME/Library/Application Support` on macOS,
and `$XDG_CONFIG_HOME` or `$HOME/.config` on Linux. Database path overrides
do not move these credentials. ChatGPT's `connections.v1.json` is encrypted
with Windows DPAPI for the current Windows user; on macOS/Linux it stores
plaintext JSON inside an owner-only file (0600) and directory (0700).
It contains a stable installation ID, separate account registrations and
tokens, and the selected report connection. Connection IDs, account labels
(including ChatGPT email when available), connection/plan status,
selection/model controls and pending sign-in URLs can reach the browser.
Access/refresh/identity tokens stay in the server-side store and are not
intentionally serialized into reports or browser responses.

The v1 credential reader validates the fields connection code consumes before
allowing a mutation. Malformed records produce a storage error and are left
unchanged; they are never silently reset. Expired/signed-out registrations,
historical valid model identifiers and unknown metadata remain compatible.
Credential mutations use a separate, permanent `connections.lock` SQLite file
containing only a format marker. A native write reservation covers the read,
awaited mutation and JSON save; waiting yields to other async work. Process exit
releases ownership without deleting the lock. The credential envelope and its
encryption remain unchanged. A closed, marker-only `connections.lock.*.tmp`
publication file can remain after a crash or failed cleanup; it contains no tokens.

**Upgrade or downgrade with every Thesis server stopped.** Old numeric/partial
locks and unknown lock formats are refused before credential mutation. If the
error requests migration, stop every Thesis server, remove only
`connections.lock` in the AI directory, then restart the intended version.
Preserve `connections.v1.json` and every `gemini-*` directory. Never remove or
replace a lock while a server is running, or mix old and new servers: an old
in-flight stale-lock deletion cannot be fenced by the new protocol. Downgrading
also requires this stopped-server lock removal. Local filesystem hard links and
native SQLite locking are required; unsupported publication fails closed.
Network filesystems are not supported by this locking guarantee. See the
[locking decision and verification limits](audit/2026-10-04-recommendations.md#1-credential-locking--implemented).

Gemini stores its own OAuth state under an isolated `gemini-<id>` subdirectory
owned by Thesis. Thesis does not read another app's Google credentials. CLI
telemetry, extensions, hooks, MCP and tools are disabled; prompts are passed
on standard input rather than command-line arguments. The CLI may retain its
own session files inside this directory. Disconnect stops local child
processes, waits for exit, and removes that directory. The official CLI storage
override preserves your normal browser profile. This CLI directory has no
Thesis-added DPAPI encryption; the CLI manages its own credential/session
files. An empty environment file in
its work directory prevents loading credentials from ancestor directories.
Connection lifecycle and inference operations claim one live Thesis server
per OS user; another server cannot connect, refresh or disconnect them until
the owning server stops. Status reads and selection saves are not an
authentication boundary and do not themselves claim that runtime ownership.
Remove the CLI's remote authorization
from Google Account connections if needed. ChatGPT disconnect clears local
tokens and attempts to revoke the renewable session; an unconfirmed remote
revocation is reported. Account registrations remain for later reconnection.

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
  file space with `VACUUM` when rows were compressed or purged. Failed sweeps
  warn and do not block startup. Filings and transcripts carry a 10-year TTL, so in
  practice they are kept, not purged.
- Reports, jobs, cost records, the watchlist, and settings are never expired.
  They persist until you delete them, and Thesis has no delete-report command:
  removing them means removing the database.
- Pass artifacts and completed job history have no automatic time-based
  retention limit. Normal lease settlement/recovery removes relevant live
  reservations, but this is bookkeeping, not a general history purge.
- Prompt-cache expiry at the AI provider is separate from SQLite retention
  and does not establish deletion of provider logs. Disconnecting an account
  stops/clears local state as described above; it does not delete old research
  reports, downloads or remote provider records.

## Deleting local data

- Reports, cache and database settings: quit Thesis and delete the database file together with its
  `-wal` and `-shm` siblings. Disable `THESIS_IMPORT_LEGACY_DB` first if set,
  or a retained workspace copy can be imported again. The next start otherwise
  creates an empty database. The
  `csrf-token` file is deleted separately, at the path the server printed at
  startup — `THESIS_TOKEN_FILE` if you set it, otherwise `csrf-token` in the
  application-data directory, which is not necessarily the directory the
  database is in.
- Start clean while keeping the old data: point `THESIS_DATA_DIR` at a fresh
  directory (or `THESIS_DB_PATH` at a new file). Reports and cache use the new
  location. AI connections remain in their
  separate per-user store until disconnected from Settings.
- Stored settings only: `npm run settings:reset -- --yes`. Settings resolve in
  one order — a value stored in the database beats the matching environment
  variable, which beats the built-in default (`src/settings/settings.ts`,
  `resolveValue`) — so a model or effort choice saved from the Settings page
  goes on overriding `.env` until this command deletes it. Without `--yes` it
  prints the rows it would delete without deleting settings; opening the
  database can still perform schema/cache maintenance. Two internal rows are
  always kept, because neither is a setting: the cache-maintenance stamp and
  the settings revision counter. AI connection selections are managed separately.
- AI connections: disconnect accounts in Settings, then quit Thesis and delete
  its `ai` directory described above to remove retained registration metadata.
  Deleting local files alone does not revoke remote grants; use the provider's
  account settings if remote revocation was not confirmed.
- Appearance: clear the `thesis-ui-design` cookie or choose Current. Exported
  Markdown, HTML, JSON, printed PDFs, legacy database copies, backups and
  browser downloads must be deleted separately. The app does not erase them
  when the active database is removed. Deleting files is not secure disk erasure.

## Sharing a report

An exported report embeds provider data and, when a filing or transcript was
cited, quoted excerpts of it. Sending one sends that data along with it — see
[License and data rights](DATA-RIGHTS.md).

The regular Markdown export and print/PDF HTML use persisted report content
without running new inference. `format=pdf` returns a self-contained HTML
document that invokes the browser's print dialog; the PDF is produced by the
browser. `npm run export:corrected -- --db <file> --report <id> --out <file.html>`
opens the named database read-only and creates new HTML and JSON files. That
JSON can expose richer structured content than the printed pages. These
exports contain no configured provider keys or OAuth tokens by design, but
retain research symbols, model/execution evidence, dates, sources, costs and
any relevant public-person names. Inspect content before sharing it.

## AI connection setup

Open **Settings → AI connections**, connect an account, choose a model, and
save it as the report connection. Signing in does not run inference. AI can
also be switched off for data-only reports.

| Connection | Authorization | Usage |
| --- | --- | --- |
| ChatGPT | Browser OAuth with the required `chatgpt.tokens.use.direct` scope; account/provider eligibility applies | Your ChatGPT plan allowance and account credit settings |
| Gemini | Official Gemini CLI 0.36.x, installed separately; Google browser sign-in | Your Google CLI allowance and account settings |
| Claude | Optional `ANTHROPIC_API_KEY` | Separately billed Anthropic API usage |

ChatGPT sign-in opens normal Chrome, with a fallback link. Gemini sign-in
requires Chrome, and Thesis passes its executable to the CLI as the browser,
preserving the normal browser profile for sign-in/autofill. Thesis gives
Gemini an isolated local home and disables
tools, extensions, hooks, MCP and inherited API keys. CLI support is restricted
to the reviewed 0.36 minor line; newer minor releases need compatibility review.
Only one running Thesis server per OS user can own connection lifecycles/inference;
stop that server before moving these connections to another local instance.
Its Google connection
is separate from an existing personal CLI login. See Google's
[installation guide](https://geminicli.com/docs/get-started/installation/).

ChatGPT models come from the connected account's catalog. A catalog entry
does not prove remaining quota or model access. Check
[ChatGPT usage](https://chatgpt.com/#settings/Usage) and
[Gemini quotas](https://geminicli.com/docs/resources/quota-and-pricing/)
before generating reports. Thesis does not know your remaining allowance.
There is no automatic change to a paid API when a connection fails.
Subscription reports use the supplied evidence without additional web search;
the existing Claude API path retains its bounded web search.

The financial calculations and deterministic citation checks are shared by
all providers. Account/model changes invalidate incompatible partial report
work. The existing Claude model and effort controls apply only to that API
connection. A subscription report's `$0` means no API charge recorded by
Thesis, not free or unlimited usage; provider account credit settings still
apply. Thesis's USD API caps do not cap subscription tokens or provider credits.

ChatGPT credentials stay server-side in protected per-user storage (Windows
DPAPI; owner-only files on macOS/Linux). Disconnect stops local requests and
attempts ChatGPT session revocation. Google disconnect clears Thesis's CLI
state; revoke the Google grant from your Google Account if desired. See
[Privacy](PRIVACY.md). The OAuth paths have offline regression coverage;
live inference has not been verified for this release.

### Model and speed controls

ChatGPT model choices refresh for the selected account. GPT-6.1 Sol can also
be requested explicitly if the account catalog has not listed it yet; that
choice is marked as access unconfirmed and can still be rejected by OpenAI.
ChatGPT reasoning and Standard/Fast speed are saved with the connection.
Fast is opt-in; check its current allowance/credit effects in
[OpenAI's speed rules](https://learn.chatgpt.com/docs/agent-configuration/speed).
Reports, exports and history retain actual provider model and usage evidence;
the requested speed is shown separately from the returned tier. Successful
ChatGPT output requires a completed event, usable final text, valid model ID
and nonnegative integer input/output usage. Missing or
inconsistent provider evidence stays unknown. Gemini reports every observed
model when its CLI uses several, without guessing which wrote the final response.

## Limited FMP access

A configured key does not establish paid access. Thesis learns explicit FMP
endpoint and symbol restrictions from responses, suppresses repeat refused
requests for 15 minutes, then rechecks. Restrictions are scoped to the key and
endpoint; a symbol refusal never blocks other symbols. Successful cached data
keeps its original freshness labels. The first request is still necessary to
discover access, and source outages or unavailable endpoints remain disclosed
gaps. Configure a real `EDGAR_CONTACT` even with a free FMP key so SEC statement
fallbacks can run. Restrictions are held in memory and reset on server restart.
