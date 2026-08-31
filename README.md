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

- Fetches typed data from Financial Modeling Prep, SEC EDGAR, FINRA, FRED, and
  Finnhub.
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

Node.js 20 compatibility is retained as a transitional CI lane, but Node 20 is
end-of-life and is not the supported runtime for new deployments.

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

On macOS or Linux, use `cp .env.example .env`. Open
[http://127.0.0.1:3000](http://127.0.0.1:3000).

### Synthetic demo mode

No API key is needed to evaluate the interface:

- `/report/sample` renders a complete fictional report without running the
  analysis pipeline.
- `/company/DEMO` loads the fictional general-company fixture.
- `/company/DBNK` loads the fictional bank fixture.

Bundled FMP-compatible fixtures and the sample report are invented contract
data, not current market data or copied provider responses. The company route
can still try keyless FINRA, FRED, and EDGAR paths; use `/report/sample` when you
want a static demonstration with no provider request.

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
| `FMP_API_KEY` | Statements, prices, estimates, ownership, segments, and peers | Uses the fictional `DEMO` and `DBNK` fixtures |
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

EDGAR does not require a key, but it does require a truthful contact identity.
Placeholder or missing identities disable live EDGAR acquisition and create a
visible data gap.

`ANALYSIS_MODEL` is not a free-form Anthropic model ID. It accepts `auto` or one
of the four priced aliases — `claude-opus-4-8`, `claude-sonnet-5`,
`claude-fable-5`, `claude-haiku-4-5` — optionally as an eight-digit dated
snapshot such as `claude-opus-4-8-20260115`. The scheduler cannot prove a spend
bound for anything else, so any other value is rejected at model resolution and
the run degrades to a data-only report with the AI passes marked skipped.
`auto` resolves against the models your key can reach, preferring
`claude-opus-4-8`, then `claude-sonnet-5`, then `claude-fable-5`.

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
| Claude Haiku 4.5 | $70.20 | $560.52 |
| Claude Sonnet 5 | $517.32 | $560.52 |
| Claude Opus 4.8 | $856.44 | $934.20 |
| Claude Fable 5 | $1,704.24 | $1,868.40 |

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

GitHub Actions runs the same required gates on Node.js 24 LTS, retains a
Node.js 20 compatibility lane, and performs a single-worker Windows smoke run.
Repository administrators must configure branch protection to require the
`CI / full` check; the workflow cannot enable branch protection by itself.

## Project layout

```text
src/              application, providers, pipeline, reports, database, and UI
tests/            deterministic unit and integration tests
fixtures/fmp/     fictional provider-contract data for keyless demo mode
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

## Contributing

Issues and pull requests are welcome. Keep changes focused, add regression tests
for behavior changes, preserve deterministic computation and source tracing,
and run `npm run verify` before submitting.

## License and data rights

The source code is released under the [MIT License](LICENSE). The license does
not grant rights to third-party market data, filings, news, model output, or
provider services. Users are responsible for each enabled provider's terms and
for deciding whether a generated report may be shared.
