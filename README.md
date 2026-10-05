# Thesis

Thesis is a local-first equity research app with financial calculations and optional AI.
Saved reports expose expandable number provenance and optional, paginated price/relative-strength data tables, including missing evidence. **Settings → Appearance** switches between the default Current design and optional Research workspace; the choice is saved in this browser.

> **Informational only — not investment advice.** Grades and price targets are
> model outputs from disclosed data and assumptions, not human recommendations.
> Market data and AI output can be delayed, incomplete, or wrong.

## What it does

- Fetches typed data from Financial Modeling Prep, SEC EDGAR, Yahoo Finance,
  FINRA, FRED and Finnhub, and validates freshness, balance-sheet identities
  and selected vendor figures against EDGAR XBRL.
- Computes growth, returns, capital structure, valuation, scenarios,
  technicals, grades and forensic indicators in deterministic TypeScript, on a
  sector route drawn from the industry label and SIC code and checked against
  filed facts, which can refine broad financial-industry labels when corroborated.
- Optionally runs separate bull and bear analyses and a judge
  pass, verifies every cited number without another model call, and turns
  missing inputs into disclosed gaps rather than fabricated values.

## Quick start

Node.js 22.18.0 or newer and npm (`package.json`); CI tests Node 24.

```powershell
git clone https://github.com/eligorelick/Thesis-AI-equity-research.git
cd Thesis-AI-equity-research
npm ci
Copy-Item .env.example .env
npm run dev
```

On macOS/Linux, use `cp .env.example .env`. Production: `npm run build`, then `npm start`.
Keep `.env*` private; only the placeholder `.env.example` belongs in Git.

Open <http://127.0.0.1:3000>; development and production both bind to
`127.0.0.1`. Every provider key is optional: with no `FMP_API_KEY`, set
`EDGAR_CONTACT` to a truthful "Name email" identity and real US-listed tickers
come from SEC EDGAR and Yahoo. With no key at all, `/report/sample` renders a
fictional report, and `/company/DEMO` and `/company/DBNK` are reserved strings
served from `fixtures/fmp` whatever keys are set. None of the three reaches a
market-data provider: the company slices disclose fixtures and the sample is synthetic.
Other symbols use live/cache data; generating fixture reports can still call selected AI.

## AI connections

In **Settings → AI connections**, connect ChatGPT through official plan OAuth
or Google through the separately installed Gemini CLI **0.36.x**, then save.
ChatGPT supports account model refresh, GPT-6.1 Sol with an access notice,
reasoning choices and opt-in Fast speed. Reports retain actual execution details.
Sign-in runs no inference; failures never switch to paid API usage. Claude API
remains separately billed. Plan allowances and credit settings apply; API dollar
caps do not measure them. See [setup, controls and limits](docs/PRIVACY.md#ai-connection-setup).
Live inference remains unverified. Stop all Thesis servers before changing credential-lock versions; see [upgrade/downgrade guidance](docs/PRIVACY.md).

## Configuration

<!-- BEGIN GENERATED: config -->

Every key is optional. This table is generated from `.env.example`, which
carries the long form of each one, so the two cannot drift apart.

| Key | Shipped value / opt-in example | What it does |
| --- | --- | --- |
| `FMP_API_KEY` | unset | Financial Modeling Prep key — any plan. |
| `ANTHROPIC_API_KEY` | unset | Anthropic key enables Claude analyst/judge passes when Claude API is selected. |
| `FRED_API_KEY` | unset | FRED key enables authenticated macro-series requests. |
| `FINNHUB_API_KEY` | unset | Finnhub — free-tier key. |
| `EDGAR_CONTACT` | unset | SEC EDGAR is keyless but REQUIRES a declared contact in the User-Agent of every request. |
| `THESIS_STATEMENT_SOURCE` | `auto` | Where the income statement, balance sheet and cash flow history comes from. |
| `ANALYSIS_MODEL` | `auto` | Claude model used when the Claude API connection is selected. |
| `ANALYSIS_EFFORT` | `high` | Claude reasoning effort: low \| medium \| high \| xhigh \| max. |
| `THESIS_JUDGE_ORDER` | `random` | Which order the judge/synthesis pass reads the two analyst cases in. |
| `ANTHROPIC_ADMIN_KEY` | unset | Optional Admin API key (distinct from ANTHROPIC_API_KEY). |
| `THESIS_MAX_ACTIVE_JOBS` | `1` | Maximum concurrent report jobs across processes sharing the SQLite database. |
| `THESIS_MAX_ACTIVE_LLM_CALLS` | `2` | Maximum concurrent AI permits across processes sharing the SQLite database. |
| `THESIS_MAX_JOB_COST_USD` | unset | Optional exact USD caps. |
| `THESIS_MAX_ROLLING_COST_USD` | unset | Optional exact USD caps. |
| `THESIS_RESERVATION_MODE` | `request` | How paid work is admitted against these caps: one reservation per provider request, or one per pass. |
| `THESIS_STREAM_IDLE_SECONDS` | `300` | Base gap with no stream event after which a paid request is abandoned, scaled by analysis effort. |
| `THESIS_ROLLING_COST_WINDOW_MINUTES` | `1440` | Rolling paid-cost window in minutes (1440 means 24 hours). |
| `THESIS_PAID_PASS_LEASE_SECONDS` | `900` | Paid-pass lease lifetime in seconds, renewed every quarter of its TTL. |
| `THESIS_JOB_LEASE_SECONDS` | `900` | Job-claim lease lifetime in seconds, never shorter than the paid-pass lease. |
| `THESIS_RESUME_ON_START` | `1` | Automatically resume queued work at startup with 1, or hold it with 0. |
| `THESIS_EV_INCLUDE_LEASES` | `1` (opt in) | Include a separable operating-lease liability only when explicitly set to 1. |
| `THESIS_ALLOWED_HOST` | unset | `npm run dev` and `npm start` bind to 127.0.0.1 by default. |
| `THESIS_TOKEN_FILE` | unset (opt in) | Override the startup token file path (default `<data dir>/csrf-token`). |
| `THESIS_DB_PATH` | unset (opt in) | Override the SQLite file (default `<data dir>/thesis.db`). |
| `THESIS_DATA_DIR` | unset (opt in) | Override the app-data directory used by the default DB and startup token. |
| `THESIS_IMPORT_LEGACY_DB` | `1` (opt in) | One-time migration only. |
| `NEXT_TELEMETRY_DISABLED` | `1` | The Next.js CLI behind `npm run dev` / `npm run build` posts anonymous usage events to telemetry.nextjs.org unless this is set. |

<!-- END GENERATED: config -->

Claude model/effort settings beat environment/defaults; reset with `npm run settings:reset -- --yes`. [Operations](docs/OPERATIONS.md) covers AI selection, jobs, exports and API contracts.

## Where the numbers come from

With an FMP key, FMP is primary unless the statement policy selects EDGAR.
Thesis reads history limits from FMP's rejection and retries within them;
restricted endpoints and symbols use available fallbacks or disclosed gaps.
Some plans return five periods; that depth can support annual calculations,
subject to each module's input gates. The own-history multiple rank needs eight
compatible quarterly observations and waits for them.

Configure `EDGAR_CONTACT` even with a free FMP key. Thesis learns explicit access
restrictions and skips repeat refusals for 15 minutes; see [fallback limits](docs/PRIVACY.md#limited-fmp-access).

With no FMP key, set `EDGAR_CONTACT` for real US filers' research:
supported statements, share counts and public float from SEC EDGAR XBRL company
facts, prices from Yahoo's unofficial chart endpoint, and the profile and
enterprise values derived from the two. `THESIS_STATEMENT_SOURCE` chooses
between the vendor and EDGAR; no statement row mixes source fields, and the
manifest names how many each served.

Where a filer uses an extension tag the field is `null` rather than a guess,
and each stand-in is named in the manifest with the periods it served. Analyst
estimates, price targets, peers, insider trades (SEC Form 4), institutional
ownership, news, transcripts, executive compensation and segment revenue have
no implemented keyless source; IFRS-only facts also remain disclosed gaps.
See [License and data rights](docs/DATA-RIGHTS.md) for what each allows.
## What the numbers mean

[Methodology](docs/METHODOLOGY.md) defines the conventions and sources. Sector
routing weighs XBRL evidence, SIC and industry labels, disclosing contradictions.
Banks, insurers and mortgage REITs use excess returns to equity instead of
inapplicable industrial-company valuation and forensic models. Growth shows
supported methods and their range; free cash flow shows before/after stock-based
compensation. Historical multiple ranks show sample size. Project-specific
choices are labelled house conventions beside the affected figures.

[`docs/RESEARCH.md`](docs/RESEARCH.md) documents the forensic scores' papers,
coefficients, estimation populations and limits; the source cites it by section.

With AI off or unavailable, reports retain deterministic results and disclose
missing analysis. Failed AI runs may retain charges; no completed analyst grade exists.
## AI analysis

Two analysts build the bull and bear cases independently: neither sees the
other's output, and the bear prompt forbids assuming a bull case exists. A
judge pass then reads both and writes the report. Which case it reads first is
drawn from the job id rather than fixed, so first position is not a standing
advantage, and the order is printed in the report header. Both cases share one
character target; actual lengths and protected-content excess are disclosed.
Each analyst scores its own side 1-5 against a stated rubric, and
the judge may discount a side that scored itself low.
`THESIS_JUDGE_ORDER=both` runs the judge twice with the cases swapped and
reconciles every grade and probability, for two judge passes.

The verification pass makes no model call. It measures citation coverage — can
each figure be traced to the record it cites — and separately checks the prose
around figures it can locate: a direction word must match the sign of its
change, a period naming a year must match the cited year, a unit word must fit
the registered unit, and a claim naming a person must rest on a filing, a
transcript, a registry figure or attributed executive/insider rows; any other
source, or none, fails it. Checked is printed beside cited, never merged into it.

Claude model prices and limits come from `config/models.json`; unknown IDs
degrade to data-only reports because their spend cannot be bounded. `auto`
prefers Opus 5.5; Haiku's judge uses Sonnet 5.5 with a disclosed model floor.
See [Claude model, effort and usage guidance](docs/CLAUDE-USAGE.md).

<!-- BEGIN GENERATED: pricing -->

Registry snapshot 2026-10-03, generated by `npm run docs:pricing`
from `config/models.json` and the reservation code. Each request is admitted
against spend caps using up to ten input contexts per search-enabled model,
at five-minute cache-write rates, plus output and configured fallback exposure.
Analyst requests also reserve eight $0.01 searches; the judge never searches.

| Analysis model | One analyst request | One synthesize request | Analyst pass worst case | Primary output ceiling | Estimated run |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude Fable 5.1 | $197.18 | $28.35 | $7,098.48 | $3.20 → $6.40 | $4.46 |
| Claude Fable 5 | $197.18 | $28.35 | $7,098.48 | $3.20 → $6.40 | $4.60 |
| Claude Opus 5.5 | $52.64 | $7.56 | $1,895.04 | $1.28 → $2.56 | $1.85 |
| Claude Opus 5 | $65.78 | $9.45 | $2,368.08 | $1.60 → $3.20 | $2.34 |
| Claude Opus 4.8 | $65.78 | $9.45 | $2,368.08 | $1.60 → $3.20 | $2.34 |
| Claude Sonnet 5.5 | $26.36 | $3.78 | $948.96 | $0.64 → $1.28 | $0.98 |
| Claude Sonnet 5 | $26.36 | $3.78 | $948.96 | $0.64 → $1.28 | $0.98 |
| Claude Haiku 4.5 | $2.90 | $3.78 | $104.40 | $0.32 | $0.69 |

The worst case is every request one pass could make (36: six transport attempts,
each able to pause and resume five times); in the default request mode it is
reported, not reserved, so a job cap need only cover the requests in flight, while
`THESIS_RESERVATION_MODE=pass` reserves it whole. Neither reservation column varies
with effort — both bound a request at the model's full context and output ceiling.

The primary-model output ceiling varies with effort; thinking bills as output.
Below `high`, passes use analyst 64K/judge 96K; at `high` and above, the model's
registry ceiling applies. Fallback output is additional and covered by request
reservations. Abandoned search/fallback requests retain their presumed bound.

The estimated run is a calculation, not a measurement: the fixture shape at effort
`high` and registry rates, Haiku's synthesize figures those of Claude Sonnet 5.5
because that pass is raised to it. It does NOT scale with effort — usage at
other levels has not been measured. Higher effort can consume more tokens;
these examples are neither minimum nor maximum prices. New model quality and
end-to-end costs have not been measured in live Thesis runs for this update.

<!-- END GENERATED: pricing -->

## Running it safely

Thesis sends nothing to Thesis: no telemetry, no analytics, no update check;
its own outbound traffic goes only to the providers you configure. The Next.js
CLI has separate anonymous telemetry, off when the shipped
`NEXT_TELEMETRY_DISABLED=1` is in your `.env` (or `npx next telemetry disable`).
[Privacy and safety](docs/PRIVACY.md) names what each receives, where the local
database lives, and how to delete it.

The application is single-user and has no authentication; keep it on loopback
unless you add a security layer of your own. Mutating routes reject a request
carrying neither browser Fetch Metadata nor a matching `Origin`; browsers send
those automatically, and scripts must send `X-Thesis-Token` with the contents of
the `csrf-token` file the server writes at every start and names on stdout. That
is a browser-CSRF boundary, not local access control: any process on the machine
can present the same headers. Report security problems through the
repository's [private advisory form](https://github.com/eligorelick/Thesis-AI-equity-research/security/advisories/new), not a public issue.

## Commands

<!-- BEGIN GENERATED: commands -->

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app on 127.0.0.1 in development. |
| `npm run build` | Production build. |
| `npm run start` | Serve the production build on 127.0.0.1. |
| `npm run typecheck` | Type-check without emitting. |
| `npm run lint` | ESLint over the repository. |
| `npm run test` | The product test suite. Fully offline whatever .env holds. |
| `npm run test:integration` | The database CLI suite, which runs in its own process. |
| `npm run test:coverage` | Both coverage contracts, core and risk. |
| `npm run test:watch` | The product suite in watch mode. |
| `npm run export:corrected` | Write corrected HTML/JSON from a stored run; requires new output filenames. |
| `npm run settings:reset` | Delete stored settings rows so .env takes precedence again. Needs --yes. |
| `npm run db:push` | Apply the Drizzle schema to the configured database. |
| `npm run check:dependencies` | Assert the dependency tree's shape. |
| `npm run models:refresh` | Diff config/models.json against the published model list and prices. Sends no model request. |
| `npm run costs:reconcile` | Lower presumed spend rows against the Usage and Cost API. Needs ANTHROPIC_ADMIN_KEY. |
| `npm run docs:config` | Print config/commands tables; add -- --write to update README. |
| `npm run docs:pricing` | Print registry-derived pricing; add -- --write to update README. |
| `npm run audit:deltas` | Print fixture comparison's intended deltas; add -- --write to update the intended-delta list. |
| `npm run audit:security` | Audit production and dev dependencies; fail on low or higher severity. |
| `npm run verify` | Everything the release gate runs, in order. |

<!-- END GENERATED: commands -->

The product suite makes no network request whatever your `.env` contains; one
live SEC check is opt-in with `EDGAR_LIVE_SMOKE=1` and a real `EDGAR_CONTACT`.
Protect `main` by requiring the `full` and `windows-smoke` checks in GitHub.
Contributions should preserve source tracing, add regressions and pass `npm run verify`.

## Limitations

- Thesis is a research tool for one local user, not a broker or a trading
  system. A traced number can still come from incorrect source data, and AI
  narrative can be wrong even when its citations resolve.
- Verification traces numbers against the registry only: a figure lifted from
  filing prose stays unverified, and each consistency check judges only the
  claims whose figure it can locate. Oversized analyst cases are shortened
  before judging where possible; protected content may exceed the target.
  The manifest names removed material and any excess that remains.

## License and data rights

The code is [MIT](LICENSE); retrieved data and model output have separate
[data rights](docs/DATA-RIGHTS.md), including when shared in reports.
