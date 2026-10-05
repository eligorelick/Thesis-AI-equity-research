# Application operations and API

This guide describes the checked-in implementation as reviewed on 2026-10-04.
It covers application behavior; provider access, prices and account allowances
can change independently. See [methodology](METHODOLOGY.md),
[privacy](PRIVACY.md) and [Claude usage](CLAUDE-USAGE.md) for their respective
contracts. Dated files under `audit/` and `superpowers/` preserve historical
findings and design proposals; they are not substitutes for current guides.

## Installation and startup

The Node engine is `>=22.18.0`; the CI workflow uses Node 24 on Linux and
Windows. Install the lockfile with `npm ci`, copy `.env.example` to `.env`,
then run `npm run dev`. Production needs `npm run build` before `npm start`.
Both npm server commands bind to `127.0.0.1`; the usual URL is
`http://127.0.0.1:3000`. No separate database migration command is required for
normal startup: `src/db/index.ts` creates tables and applies guarded compatibility
updates when it opens the database. `npm run db:push` is an explicit Drizzle
schema-management tool, not a quick-start prerequisite.

On Windows, `./Start-Thesis.ps1` starts an already-built production installation
in a hidden process on port 3000 and opens Chrome at its standard installation
path, or the default browser. `-SkipBrowser` suppresses browser launch. The
launcher sets `THESIS_RESUME_ON_START=0`, `NEXT_TELEMETRY_DISABLED=1` and
`NODE_ENV=production` in the child process, records its PID and start time in
`.local/server.json`, and writes `.local/server.log` and
`.local/server-error.log`. It reuses the matching recorded process and rejects
an occupied port when no matching process is recorded. `./Stop-Thesis.ps1`
stops only the process whose PID and start time match that record, then removes
the record. The launcher does not install dependencies or build the app.

## Pages and saved research

| Path | Behavior |
| --- | --- |
| `/` | Watchlist and research entry point. |
| `/settings` | Provider capability flags, Claude model/effort, AI connections, appearance, and a queue-resume control when startup is held. |
| `/company/[symbol]` | Fetches a current data bundle and computes live analysis. When a saved report exists, tabs expose that report and live analysis separately. |
| `/company/[symbol]/history` | Saved runs for the issuer and selection of reports to compare. |
| `/company/[symbol]/history/diff?a=1&b=2` | Compares two saved reports belonging to the route issuer; orders them older to newer and discloses version differences. |
| `/company/[symbol]/report/[reportId]` | Loads a specific saved report under the requested issuer identity. |
| `/company/[symbol]/report/[reportId]/print` | Dedicated report print view; the browser produces the PDF. |
| `/report/sample` | Synthetic saved-shape demonstration, without running a report job. |
| `/audit-ui/index.html` | Standalone synthetic UI comparison lab: Current, Research workspace and Decision brief prototypes, with simulated data conditions. |

The comparison lab in `public/audit-ui/` makes no provider requests or account
connections and saves no browser/application settings. Its simulated runs and
exports use fixed fictional data; reload resets the lab. Decision brief remains
a prototype there, while the production Settings page offers Current and
Research workspace.

Symbols are trimmed, validated as 1–12 ASCII characters with alphanumeric ends
and internal dots/hyphens, then uppercased. Dot/hyphen share-class spellings are
treated as issuer aliases for relevant watchlist/report lookups. Lexical validity
does not establish that a ticker exists. `DEMO` and `DBNK` are reserved fictional
fixtures and never request market data from providers, regardless of keys.
**Generating a report for either symbol can still call the selected AI provider.**
Use the sample page or select Data only for a demonstration without inference.

Company analysis rejects instruments whose profile flags identify an ETF or
fund. A report job then ends as `unsupported`, with its reason and without a
company report or AI analysis. Benchmark/sector ETF prices are still inputs to
company technical analysis. Missing instrument flags are not proof of a company's
classification; the gate acts on affirmative provider flags.

## Configuration and settings

The README configuration table is generated from `.env.example`; the long
comments explain source policies, reservations, timing and paths. Most parsed
server configuration is cached for the process lifetime, so restart after changing
keys or scheduling settings. Next's environment-file loading also retains shell
variable precedence. Maintenance commands that need configuration use
`scripts/lib/load-env.mjs` to load the applicable Next environment files before
using config or database paths. `export:corrected` takes an explicit database path.

| Statement policy | Current behavior |
| --- | --- |
| `auto` | Keeps available FMP members, replaces missing members where eligible, and appends older EDGAR rows separately for each statement family. |
| `fmp` | Keeps available FMP members and disables older-row/predecessor backfill. A missing member can still use issuer-gated EDGAR replacement; this is not a strict vendor-only mode. |
| `edgar` | Rebuilds statement members from eligible EDGAR facts and withholds vendor rows when a filed-facts reconstruction fails. |

EDGAR replacement requires issuer confirmation. Each statement row is served
whole from one source; income, balance sheet and cash-flow rows for the same
period can have different sources. Selecting EDGAR statements still allows other
vendor endpoints for market/profile/estimates and does not disable AI.

Claude's model/effort pair resolves SQLite settings → environment → defaults
(`auto`, `high`). The Settings page saves that pair without restarting. Its writer
uses versioned compare-and-swap, so an older browser tab cannot silently overwrite
a newer save. `npm run settings:reset` previews stored rows;
`npm run settings:reset -- --yes` deletes them, preserving the cache-maintenance
stamp and settings revision counter. `--db <path>` targets another database.
This command does not reset the separate AI connection store or appearance.

AI selection is independently persisted in the connection store. Before that
store exists, an Anthropic key chooses Claude API; otherwise the default is
Data only. Beginning account setup creates a store initially selecting Data only,
so an existing API user may need to select Claude explicitly again. A saved
unavailable selection does not fall back to paid Claude when authorization fails;
explicitly disconnecting its selected account resets the choice to Data only.
ChatGPT/Gemini model choices are separate from `ANALYSIS_MODEL`; ChatGPT has
its own effort/speed choices. Selection is captured for an execution rather than
re-read in each pass. Credential availability and model access can still fail.
See [AI setup](PRIVACY.md#ai-connection-setup) for the implemented connections
and the live-inference verification limitation.

Appearance is a per-browser `thesis-ui-design` cookie (`current` or `workspace`),
with a 180-day maximum age and `SameSite=Lax`; HTTPS adds `Secure`. It changes
presentation independently of stored research/model settings.

## Report lifecycle and recovery

Generation runs fetch → validate → compute → bull → bear → synthesize → verify.
Neither analyst sees the other's output; they share payload/model context and
are not statistically independent. The runner can overlap their requests when
the durable permit limit allows it. Verification is deterministic and makes no
model call. Missing/disabled AI or certain computation/pass failures can produce
a saved data-only report, with gaps and any incurred costs disclosed. A `done`
job therefore means a saved result, not necessarily completed AI analysis.

SQLite owns job claims, generations, paid permits, pass artifacts and cost
settlements. Starting the same issuer while compatible queued/running work
exists returns the existing job. Terminal statuses include `done`, `error`,
`unsupported` and `canceled`. A stopped process is reconciled through lease
expiry by scheduling/write surfaces; status polling and SSE do not reconcile
expired claims or start model work. Reading a company page can fetch provider
data and update caches even though status reads do not mutate job state.

`THESIS_RESUME_ON_START=1` starts the scheduler at server initialization;
`0` holds queued work until an explicit resume or a report/retry/cancel request
wakes it. Holding startup does not disable report generation. Canceling makes
the job terminal and aborts local execution where possible; remote usage and
late settlements may still arrive. It is not a refund mechanism.

Retry uses the same job ID and validates durable artifacts, generation lineage,
payload/model compatibility and paid settlement evidence before reusing work.
It may reuse a verified result, reuse synthesis and rerun verification, or reuse
compatible analyst sides and run the missing tail. New requests remain billable;
earlier spend remains in the ledger. Retry rejects queued/running, canceled and
unsupported jobs, active same-issuer conflicts and incompatible/unresumable
terminal work. Start a new report when no compatible tail can be resumed.

Claude USD caps apply to reservations plus settled spend, not estimated typical
run cost. Plan-based usage is not measured by those dollar caps. Abandoned paid
leases preserve conservative presumed spend until a late settlement or explicit
reconciliation lowers it. See [usage controls](CLAUDE-USAGE.md) before sizing caps.

## Local HTTP API

All paths below pass the request-wide direct-Host allowlist. Mutations also
require accepted browser metadata/matching Origin or the startup
`X-Thesis-Token`; cross-site or mismatched Origin requests remain rejected even
with a token. This is a browser-CSRF boundary, not authentication of local
processes. Heavy company GET/HEAD requests additionally filter cross-origin
embeds and speculation. AI connection GET/POST requires the mutation guard
and strict local access even when an optional LAN authority is allowed.

| Method and path | Request / successful response | Material error behavior |
| --- | --- | --- |
| `GET /api/watchlist` | `{ watchlist }`, raw stored rows. | Request Host guard applies. |
| `POST` / `DELETE /api/watchlist` | `{ symbol }`; returns updated `{ watchlist }`. | `400` malformed symbol/body; `403` request guard. |
| `GET /api/settings` | Model/effort, choices, sources, revision and capability flags; strong `ETag`, `no-store`. | `500` storage failure; no keys/contact returned. |
| `POST /api/settings` | Exactly `{ analysisModel, analysisEffort }` and current strong `If-Match`; returns authority and new `ETag`. | `428` missing/invalid strong validator; `412` stale validator with current authority; `400` invalid body/selection; `500` storage failure. |
| `POST /api/report` | `{ symbol }`; `202 { jobId }` or `{ jobId, existing: true }`. | `400` invalid JSON/symbol. Provider/instrument failures occur asynchronously. |
| `GET /api/report/[jobId]` | Coherent durable snapshot with revision, steps, costs, terminal details and report linkage. | `404` unknown job. |
| `GET /api/report/[jobId]/stream` | SSE `snapshot` events; event ID is snapshot revision. | `404` unknown job. Reconnect reads current state, not an event history. |
| `HEAD /api/report/[jobId]/stream` | Same existence/status/stream headers with no body/subscription. | `404` unknown job. |
| `POST /api/report/[jobId]/cancel` | No body needed; `202 { jobId, canceled: true }`. | `404` unknown; `409` terminal job or changed execution state. |
| `POST /api/report/[jobId]/retry` | No body needed; `202 { jobId, resumed: true }`. | `404` unknown; `409` active/unsupported/canceled/conflicting/incompatible work. |
| `POST /api/jobs/resume` | No body needed; `202 { resumed: true, queued }`. | Guard runs before scheduler; queued count is read before resuming. |
| `GET /api/report/view/[reportId]` | Compact persisted synthesis/grades/verification/cost/completeness summary, not full report JSON. | `400` malformed ID; `404` absent row; unreadable content yields a friendly `200` summary with unknown content fields. |
| `GET /api/export/[reportId]?format=md` | Markdown attachment; default format is `md`. | `400` malformed ID/format; `404` absent; `422` unreadable saved content. |
| `GET /api/export/[reportId]?format=pdf` | Print-optimized HTML and browser print dialog, `text/html`; no PDF bytes from the server. | Same validation as Markdown. |
| `GET /api/ai/connections` | Sanitized connection status, selected route and pending sign-in; `no-store`. | `403` nonlocal/unguarded access; `500` storage failure. |
| `POST /api/ai/connections` | Actions: `connect-chatgpt`, `connect-gemini`, `disconnect-chatgpt`, `disconnect-gemini`, `models`, `select`. | `413` body over 8,192 characters; `400` invalid action/selection or connection failure; `403` guard. |

The SSE endpoint reads on subscription, polls once per second for other-process
commits, emits only advancing revisions, and sends heartbeat comments every
15 seconds. It closes after a terminal snapshot has no pending settlements.
Read failures retry after 250/500/1,000 ms before closing. Browser reconnects
receive a fresh current snapshot; the endpoint does not implement replay from
`Last-Event-ID`. Polling is the fallback for clients without a persistent stream.

For a script, read the server's printed token-file path and send its trimmed
contents in the header; do not print the token. Example for the default Windows
data directory (adjust for overrides):

```powershell
$thesisToken = (Get-Content -LiteralPath "$env:LOCALAPPDATA\Thesis\csrf-token" -Raw).Trim()
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/report' -Method Post `
  -Headers @{ 'X-Thesis-Token' = $thesisToken } -ContentType 'application/json' `
  -Body '{"symbol":"AAPL"}'
```

## Persistence, exports and maintenance

The default database is `<data directory>/thesis.db`. Windows uses
`%LOCALAPPDATA%/Thesis`, falling back to `%APPDATA%/Thesis`; macOS uses
`$HOME/Library/Application Support/Thesis`; Linux uses `$XDG_DATA_HOME/thesis` or
`$HOME/.local/share/thesis`. `THESIS_DB_PATH` overrides the database file;
`THESIS_DATA_DIR` changes the default directory and token location. Neither
redirects AI credentials, which have their own OS-profile store. SQLite data,
API cache, saved reports and `.env` have no application-level encryption.

Back up a stopped database with any remaining `-wal`/`-shm` sidecars, or use a
SQLite-aware backup while running. A copied DB without its uncheckpointed WAL
may omit committed data. Legacy import is opt-in with
`THESIS_IMPORT_LEGACY_DB=1`, copies `data/thesis.db` and sidecars, and never
overwrites an existing target or applies with an explicit `THESIS_DB_PATH`.

Cache freshness uses each caller's TTL and optional stale limit. Eligible stale
rows can return immediately while revalidation runs; bounded stale policies
force a refresh once that limit is exceeded. Cache admission validates provider
payloads, and selected empty-refresh guards retain a previously nonempty row.
On opening the DB, maintenance runs at most once per 24 hours: compress large
plain cache rows, purge rows older than stored TTL plus 30 days, and VACUUM
after actual work. It does not purge reports, watchlists, jobs or cost history.

Correct an older saved report into new files without rewriting its DB row:

```powershell
npm run export:corrected -- --db 'C:\path\thesis.db' --report 1 --out 'C:\exports\report-1.html'
```

The CLI reads SQLite read-only, validates issuer identity/schema, applies legacy
entity safety, adds recorded execution/cost/source disclosures, and writes HTML
plus a JSON sibling. `.html`/`.htm` is replaced with `.json`; otherwise `.json`
is appended. Both destinations must be new. It does not refetch data, recompute
the financial analysis or run inference. A supported legacy read does not make
unknown historic effort or missing source evidence recoverable.

Documentation generators print by default; use explicit writes after review:

```powershell
npm run docs:config -- --write
npm run docs:pricing -- --write
```

`models:refresh` queries Anthropic model availability and published pricing,
prints a diff, and only writes the registry with `--write`; existing capability
and request policies still require review. `costs:reconcile` previews presumed
spend and can read the admin cost report; `--write` applies conservative downward
reconciliation, not a new report. `audit:deltas` compares offline fixtures;
`--write --group <name>` records newly classified changes, whose reason must be
reviewed. Regenerating deltas is not evidence that a financial change is correct.

## Verification and troubleshooting

`npm run test` and `test:product` run the same product suite; `test:integration`
isolates the database CLI test. `test:coverage` runs both core and risk coverage
contracts. Shared setup rejects external `fetch` by default, while loopback
test servers are allowed. `EDGAR_LIVE_SMOKE=1` allows SEC hosts only, with a
truthful `EDGAR_CONTACT`; it does not permit other providers. The fetch guard
is process-local, not a sandbox for arbitrary subprocess traffic.

`npm run verify` matches the Linux release sequence: dependency shape, types,
lint, product tests, integration tests, both coverage contracts, build and
security audit. The audit invokes npm with production/dev dependencies and
`--audit-level=low`, so it requires registry access and fails on any listed
severity. Windows CI runs product tests with one worker and the CLI integration
suite. A historical audit's passing counts do not prove the current checkout.

| Symptom | Check |
| --- | --- |
| Environment edit has no effect | Restart the server, check shell precedence and stored model/effort overrides. AI selection is separate. |
| Live SEC evidence absent | Set a truthful nonplaceholder contact; verify ticker/CIK and supported US-GAAP facts. No contact or extension-only/IFRS facts produce disclosed gaps. |
| Run is data-only | Read `analysis.llm`, computation and pass disclosures; check selected connection, Claude registry support and reservations. A key alone does not override a saved Data only choice. |
| Queued work waits after launch | Windows launcher holds startup; resume explicitly. Budget/concurrency gates can also defer admission. |
| Mutation returns `403` | Use the direct allowed authority and matching browser Origin/metadata or current startup token. Restart replaces the token. |
| Settings save returns `412` | Refresh current authority/ETag and reconcile intended edits before saving. |
| Retry returns `409` | Reload durable state; active/conflicting/unsupported/canceled or incompatible work needs a different action or new run. |
| PDF download is HTML | Open the print view and use browser Print → Save as PDF. |
| Corrected export refuses a path | Choose new HTML and JSON destinations; existing files are never overwritten. |
| AI store is held by another server | Use the owning local server or stop it before connecting here; changing DB paths does not isolate AI credentials. |

Implementation anchors: `src/app/api/`, `src/app/requestSecurity.ts`,
`src/pipeline/jobRunner.ts`, `jobStore.ts`, `jobScheduler.ts`, `events.ts`,
`src/settings/`, `src/appearance/preference.ts`, `src/db/`, `src/cache/`,
`src/report/history.ts`, `src/report/export/`, `src/ai/`, `scripts/`,
`Start-Thesis.ps1`, `Stop-Thesis.ps1`, `vitest.shared.ts` and
`.github/workflows/ci.yml`.
