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

- Node.js 20.9 or newer
- npm

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
| `ANALYSIS_MODEL` | Anthropic model ID or `auto` | Defaults to `auto` |
| `ANALYSIS_EFFORT` | `low`, `medium`, `high`, `xhigh`, or `max` | Defaults to `high` |
| `THESIS_DB_PATH` | Exact SQLite file location | Uses the operating-system app-data directory |
| `THESIS_DATA_DIR` | SQLite directory override | Uses the operating-system app-data directory |

EDGAR does not require a key, but it does require a truthful contact identity.
Placeholder or missing identities disable live EDGAR acquisition and create a
visible data gap.

The Settings page can override the analysis model and effort. Stored settings
take precedence over environment variables, which take precedence over
application defaults.

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
npm test               # deterministic mocked test suite; no live network
npm run typecheck      # strict TypeScript check
npm run lint           # ESLint
npm run test:coverage  # focused coverage report
npm run verify         # typecheck + lint + tests + production build
```

Run `npm run verify` before contributing or publishing a change. A successful
Next.js build alone is not the type-safety gate because strict checking runs as
a separate command.

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
