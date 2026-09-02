# Thesis

Thesis is a local-first equity research application. Enter a ticker to collect
and validate market data, calculate deterministic financial metrics, optionally
run grounded AI analysis, and save a source-traceable report with history,
comparison, watchlist, Markdown export, and browser print-to-PDF support.

> **Informational only — not investment advice.** Thesis does not provide
> buy/sell/hold ratings, trade execution, or personalized financial advice.
> Market data and AI output can be delayed, incomplete, or wrong. Verify
> important facts independently.

## What it does

- Fetches typed data from Financial Modeling Prep, SEC EDGAR, Yahoo Finance,
  FINRA, FRED, and Finnhub.
- Validates freshness, balance-sheet identities, and selected FMP figures
  against EDGAR XBRL data.
- Computes growth, returns, capital structure, valuation, projections,
  scenarios, technicals, sector routing, grades, and forensic indicators in
  deterministic TypeScript.
- Optionally runs independent Anthropic bull and bear analyses followed by a
  synthesis pass.
- Requires every report number to carry a source path and as-of date, then
  verifies citation coverage without another model call.
- Turns missing inputs and provider outages into disclosed gaps instead of
  fabricating values or crashing the report.

## Quick start

Requirements:

- Node.js 24 LTS
- npm

Node.js 20 reached end-of-life in April 2026 and is not supported: the test
harness spawns TypeScript workers that rely on Node 24's native type stripping,
so its former CI lane was retired rather than left permanently red.

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

On macOS or Linux, use `cp .env.example .env`. Open
[http://127.0.0.1:3000](http://127.0.0.1:3000).

A provider key is optional. With no `FMP_API_KEY`, set `EDGAR_CONTACT` in
`.env` to a truthful "Name email" identity and real US-listed tickers are
served from SEC EDGAR and Yahoo instead of FMP (see *Without an FMP
subscription* below).

### Synthetic demo mode

No API key is needed to evaluate the interface:

- `/report/sample` renders a complete fictional report without running the
  analysis pipeline.
- `/company/DEMO` loads the fictional general-company fixture.
- `/company/DBNK` loads the fictional bank fixture.

`DEMO` and `DBNK` resolve to fixtures **only while no `FMP_API_KEY` is
configured**. Once a key is set, they are treated as ordinary symbols and sent
to the live provider, which does not list them — so the pages render as
near-empty disclosed gaps rather than the demo company. To see the fixtures
again with a key in your `.env`, start the server with `FMP_API_KEY=""`.
`/report/sample` is static and always renders, key or no key.

Bundled FMP-compatible fixtures and the sample report are invented contract
data, not current market data or copied provider responses. Any other symbol
sent to `/company/SYMBOL` with no `FMP_API_KEY` is a live request: with
`EDGAR_CONTACT` configured it returns a full report sourced from SEC EDGAR and
Yahoo (see *Without an FMP subscription*); without it, live EDGAR is disabled
and the page renders as disclosed gaps. Use `/report/sample` when you want a
static demonstration with no provider request.

For a production build:

```powershell
npm run build
npm start
```

Development and production both bind to `127.0.0.1`.

## Configuration

Copy `.env.example` to `.env` and configure only the providers you want. Every
credential is optional.

| Variable | Purpose | Behavior when absent |
|---|---|---|
| `FMP_API_KEY` | Statements, prices, estimates, ownership, segments, and peers | Real tickers are served from SEC EDGAR and Yahoo (see *Without an FMP subscription*); `DEMO`/`DBNK` use the fictional fixtures |
| `ANTHROPIC_API_KEY` | Grounded bull, bear, and synthesis passes | Produces a deterministic data-only report |
| `FRED_API_KEY` | Macroeconomic series | Uses supported keyless CSV data where available |
| `FINNHUB_API_KEY` | Insider sentiment | Records the source as unavailable |
| `EDGAR_CONTACT` | Honest name and email for SEC request identification | Live EDGAR requests fail closed |
| `ANALYSIS_MODEL` | `auto` or one priced model alias | Defaults to `auto` |
| `ANALYSIS_EFFORT` | `low`, `medium`, `high`, `xhigh`, or `max` | Defaults to `high` |
| `THESIS_MAX_ACTIVE_JOBS` | Durable cross-process job concurrency | Defaults to `1` |
| `THESIS_MAX_ACTIVE_LLM_CALLS` | Durable cross-process paid-call concurrency | Defaults to `2` |
| `THESIS_MAX_JOB_COST_USD` | Optional per-job settled-plus-reserved spend cap | No cap |
| `THESIS_MAX_ROLLING_COST_USD` | Optional rolling settled-plus-reserved spend cap | No cap |
| `THESIS_ROLLING_COST_WINDOW_MINUTES` | Rolling spend window, at most `52560000` minutes | Defaults to `1440` |
| `THESIS_PAID_PASS_LEASE_SECONDS` | Paid-call lease TTL; `601`–`2147483` seconds | Defaults to `900` |
| `THESIS_JOB_LEASE_SECONDS` | Job-claim lease TTL; at most `2147483` seconds | Defaults to `900` |
| `THESIS_ALLOWED_HOST` | One exact non-loopback Host authority | Accepts loopback authorities only |
| `THESIS_DB_PATH` | Exact SQLite file location | Uses the operating-system app-data directory |
| `THESIS_DATA_DIR` | SQLite directory override | Uses the operating-system app-data directory |
| `THESIS_IMPORT_LEGACY_DB` | Set to `1` for a one-time copy of an older in-repo `data/thesis.db` into the app-data location | The in-repo database is left untouched and unused |

### Without an FMP subscription

Set only `EDGAR_CONTACT`. FMP stays the primary source for every member;
wherever FMP cannot serve one — no key, an empty response, HTTP 402, or a
refused symbol — the pipeline fills it from public keyless sources instead of
leaving the report empty:

| Member | Source | Provenance |
| --- | --- | --- |
| Statements (income statement, balance sheet, cash flow), shares outstanding, public float | SEC EDGAR XBRL company facts | `edgar` |
| Registrant name, sector and industry (from SIC), exchange, fiscal year end | SEC EDGAR submissions | `edgar` |
| Daily prices for the symbol, SPY, and the sector ETF; quote; listing date | Yahoo Finance chart endpoint | `yahoo` |
| Beta, market cap, quarterly enterprise values, daily market-cap history, float | computed from the above | `computed` |

Beta is estimated from five years of monthly returns against SPY; market cap
is price times shares outstanding. Quarterly cash-flow figures, and any
quarter a filer reports only year-to-date, are derived by subtraction and
marked `derivation` on the row; a line item a filer tags with a non-standard
extension tag yields `null`, never a guess. Every replaced member is recorded
in the missing-data manifest as `keyless.<member>`, naming why FMP could not
serve it.

Analyst estimates and price targets, grades consensus, peers, insider trades
and statistics, 13F institutional ownership, news and press releases,
transcripts, executive compensation, segment revenue, the earnings calendar,
and FMP's derived key-metrics, ratios, and financial-growth rows have no
keyless source and stay disclosed gaps (Stage B computes its own
growth/margin/return figures from the statements either way).

The Yahoo endpoint is unofficial and best-effort: requests carry a
User-Agent, are rate-limited and cached, and any failure becomes a disclosed
gap rather than an error. The same fallback also fills members that an
entry-tier FMP plan refuses outright, such as sector-ETF price history, even
when a key is configured. `DEMO` and `DBNK` remain the fictional fixtures,
served only when no `FMP_API_KEY` is configured; they never reach EDGAR or
Yahoo. Because keyless statements are sourced from XBRL, the FMP-versus-XBRL
cross-check on those rows is recorded as a passing identity check rather than
a numeric comparison.

Any FMP plan works. Lower tiers cap the `limit` parameter (5 periods on the
entry plans) and restrict some endpoints: Thesis reads the cap from FMP's own
rejection, retries within it, and records the truncated history depth in the
missing-data manifest, while restricted endpoints (insider trades,
institutional ownership, news, transcripts) become disclosed gaps rather than
failures. Sector-ETF price history that an entry-tier plan refuses is instead
served from Yahoo when `EDGAR_CONTACT` is configured, the same fallback real
tickers use with no key at all (see *Without an FMP subscription* above).
Five fiscal years still support the growth, returns, forensic, DCF and
scoring modules; own-history multiple percentiles need eight quarters and are
withheld until the plan supplies them.

A data-only report (no `ANTHROPIC_API_KEY`) is not empty: it carries every
deterministic Stage B result — growth, margins, returns, capital structure,
forensic scores, technicals, DCF, reverse DCF, multiples, scenario targets,
projections and the aspect scores — with the score bands shown as grades and
every block stating that no analyst pass ran. Only the narrative sections
(catalysts, risks, outlook, executive credibility, moat sources) stay empty.

EDGAR does not require a key, but it does require a truthful contact identity.
Placeholder or missing identities disable live EDGAR acquisition and create a
visible data gap.

`ANALYSIS_MODEL` is not a free-form Anthropic model ID. It accepts `auto` or one
of the five priced aliases — `claude-opus-5`, `claude-opus-4-8`,
`claude-sonnet-5`, `claude-fable-5`, `claude-haiku-4-5` — optionally as an
eight-digit dated snapshot such as `claude-opus-5-20260115`. The scheduler
cannot prove a spend bound for anything else, so any other value is rejected at
model resolution and the run degrades to a data-only report with the AI passes
marked skipped. `auto` resolves against the models your key can reach,
preferring `claude-opus-5`, then `claude-opus-4-8`, then `claude-sonnet-5`,
then `claude-fable-5`.

Selecting `claude-haiku-4-5` does not make the whole run Haiku. Haiku is not
used for the synthesis/judge pass; that pass is raised to `claude-sonnet-5`,
and the substitution is disclosed in the report's execution metadata as a
`model-floor` adjustment.

The Settings page can override the analysis model and effort. Stored settings
take precedence over environment variables, which take precedence over
application defaults.

Report requests are queued in SQLite and claimed with durable leases, so the
limits hold across server processes and restarts. Node server startup drains
pre-existing queued work, and a single process-local wake timer revisits future
queue times and expired job/paid leases without making read routes mutate state.
Spend admission atomically counts every settled attempt plus live reservations. Reservations deliberately
use a worst-case 108-request exposure bound (SDK retries, transport retries,
and pause resumptions), strict model/context/output/search caps, and standard
pricing; this can be much larger than the typical final charge. The strict
per-pass reservation is `108 * maximum cost of one capped provider request`:

| Analysis model | Bull/bear analyst pass | Synthesize/judge pass |
| --- | ---: | ---: |
| Claude Haiku 4.5 | $70.20 | $373.68 |
| Claude Sonnet 5 | $347.76 | $373.68 |
| Claude Opus 5 | $856.44 | $934.20 |
| Claude Opus 4.8 | $856.44 | $934.20 |
| Claude Fable 5 | $1,704.24 | $1,868.40 |

Haiku's synthesize figure is a Sonnet 5 reservation because that pass is raised
to Sonnet 5. Because these are worst-case bounds rather than expected charges,
a job cap small enough to act as an everyday budget is not achievable: one
synthesize pass alone reserves $373.68, so `THESIS_MAX_JOB_COST_USD` set near a
typical run's actual cost rejects every job before it starts. Control routine
spend with `ANALYSIS_MODEL` and `ANALYSIS_EFFORT`, and treat the caps as
runaway protection. For scale, one complete Anthropic-backed run measured on
2026-09-01 (`ANALYSIS_MODEL=claude-haiku-4-5`, one large-cap US issuer, web
search enabled) settled at **$1.43** in total.

Deterministic verification reserves exactly $0. An injected provider-backed
verification adapter must declare and reserve its own finite maximum. Use these
strict maxima, not typical observed charges, when sizing the optional job and
rolling caps. A provider-launched call retains its reservation until exact
settlement or lease expiry so another process cannot spend the same budget
prematurely; only an exit before provider launch releases a reservation as
unbilled.

## Privacy and safety

Thesis stores its SQLite database locally, outside the repository by default.
Reports, settings, cached provider responses, watchlist entries, job state, and
cost records stay in that database.

Local-first does not mean offline. Tickers, identifiers, query parameters,
grounded report inputs, and credentials are sent directly to the providers you
configure. API keys remain server-side and never enter the browser bundle.
Thesis does not include its own telemetry service.

The application is single-user and has no authentication or multi-user access
control. Keep it on loopback unless you add an appropriate security layer. Do
not commit `.env`, API keys, personal EDGAR contact details, databases, cached
provider data, or private reports.

Report sensitive security problems through the repository's
[private security advisory form](https://github.com/eligorelick/Thesis-AI-equity-research/security/advisories/new),
not a public issue.

## Using Thesis

1. Enter a symbol on the dashboard or open `/company/SYMBOL`.
2. Review the deterministic analysis, source dates, warnings, and missing-data
   manifest.
3. Generate an AI-assisted report if an Anthropic key is configured.
4. Use History to compare saved reports for the same symbol.
5. Export Markdown, or use the print view and the browser's **Save as PDF**
   command. The server's PDF-format endpoint returns print-ready HTML rather
   than generating a binary PDF.

The report pipeline runs in this order:

```text
fetch → validate → compute → bull → bear → synthesize → verify
```

The fetch/validation and calculation stages degrade safely when data is
missing. The AI stages are optional. The final verification stage is
deterministic and measures source coverage, not whether an investment thesis is
correct.

## Commands

```powershell
npm run dev            # local development server
npm run build          # production build
npm start              # serve the production build
npm run db:push        # create/update the configured local SQLite database
npm test               # isolated product suite; DB CLI integration excluded
npm run test:integration       # single-worker database CLI integration
npm run typecheck      # strict TypeScript check
npm run lint           # ESLint
npm run test:coverage:core     # Stage B/schema coverage contract
npm run test:coverage:risk     # audited per-file risk coverage contract
npm run test:coverage          # both independent coverage contracts
npm run check:dependencies     # exact lockfile + installed-tree versions
npm run audit:security         # dev-inclusive low-severity npm audit
npm run verify         # all required local CI gates in release order
```

Run `npm run verify` before contributing or publishing a change. A successful
Next.js build alone is not the type-safety gate because strict checking runs as
a separate command.

The suite makes no network requests, whatever your `.env` contains. One live
check against SEC EDGAR is available opt-in and is skipped otherwise:

```powershell
$env:EDGAR_LIVE_SMOKE = "1"   # also needs a real EDGAR_CONTACT
npm test
```

It issues exactly two keyless requests (ticker→CIK and submissions) and fails
rather than degrading, which is the point of opting in.

GitHub Actions runs the same required gates on Node.js 24 LTS and performs a
single-worker Windows smoke run.
Repository administrators must configure branch protection to require the
`CI / full` check; the workflow cannot enable branch protection by itself.

## Project layout

```text
src/              application, providers, pipeline, reports, database, and UI
tests/            deterministic unit and integration tests
fixtures/fmp/     fictional provider-contract data for the no-key demo fixtures
fixtures/edgar/   compact SEC excerpts required by extraction tests
fixtures/report/  fictional complete sample report
```

## Limitations

- Thesis is a research tool, not a broker, portfolio manager, discovery engine,
  or autonomous trading system.
- Provider coverage, freshness, entitlements, schemas, and rate limits vary.
- A traced number can still originate from incorrect source data.
- AI narrative can be incomplete or wrong even when its citations resolve.
- Paid analysis cost depends on model choice, reasoning effort, cache state,
  retries, web searches, and provider pricing.
- This build is designed for one local user and should not be exposed publicly
  without additional authentication and authorization.
- Keyless statements are derived from XBRL tags; a filer that uses extension
  tags for a line item yields `null` for that field, never a guess.

## Contributing

Issues and pull requests are welcome. Keep changes focused, add regression tests
for behavior changes, preserve deterministic computation and source tracing,
and run `npm run verify` before submitting.

## License and data rights

The source code is released under the [MIT License](LICENSE). The license does
not grant rights to third-party market data, filings, news, model output, or
provider services. Users are responsible for each enabled provider's terms and
for deciding whether a generated report may be shared.
