# README notes — WS8 (security, privacy, compliance)

Facts WS9 needs for the README. Everything here matches the code on branch
`ws8-security`; the two documents referenced are written and ready to link.

## New README sections (link, do not duplicate)

**Privacy and safety** → link `docs/PRIVACY.md`. Suggested sentence:

> Thesis sends nothing to Thesis: no telemetry, no analytics, no update check.
> The only outbound traffic is to the data providers you configure — see
> [Privacy and safety](docs/PRIVACY.md) for exactly what each one receives,
> where the local database lives, and how to delete it.

**License and data rights** → link `docs/DATA-RIGHTS.md`. Suggested sentence:

> The MIT license covers this code only, not the market and filing data Thesis
> retrieves; sharing a generated report shares that provider data with it. See
> [License and data rights](docs/DATA-RIGHTS.md).

## Settings precedence and reset (R-41)

The sentence the reconciliation asked for, verbatim:

> Stored settings take precedence over environment variables, which take
> precedence over defaults; reset with `npm run settings:reset -- --yes` or the
> Settings page.

Notes for whoever writes the surrounding paragraph:

- Precedence is implemented in `src/settings/settings.ts` (`resolveValue`).
- `npm run settings:reset` with no `--yes` prints the exact rows it would
  delete and changes nothing. `--yes` deletes them. `--db <path>` targets a
  specific database file; otherwise the configured path is used.
- The reset keeps two internal rows, neither of which is a setting:
  `cacheMaintenanceLastRunAt` (the cache-sweep stamp) and
  `__writableSettingsRevision` (the monotonic counter behind the settings
  compare-and-swap). Neither is listed in the preview.
- The Settings page has no reset control. It does have a **resume queued work**
  control (below). If the README claims a UI reset, it would be wrong today.

## Startup hold (R-42)

New env key, belongs in the README's configuration table:

> `THESIS_RESUME_ON_START` — default `1`. With `0`, starting the server does
> not claim queued jobs and arms no wake timer, so paid work left by a restart
> waits until you resume it with `POST /api/jobs/resume`, the Settings page
> "resume queued work" button, or any new report/retry/cancel request.

New route worth a line in any endpoint list: `POST /api/jobs/resume` → `202
{ resumed: true, queued: n }`. Same-origin guarded like the other mutating
routes.

## Local request security (V-11, D-21)

New env key: `THESIS_TOKEN_FILE` — optional full path for the token file;
blank means `<data dir>/csrf-token`.

Behavior change worth documenting wherever the README describes scripting
against the API:

> Mutating routes (`/api/report`, its retry and cancel, `/api/settings`,
> `/api/watchlist`, `/api/jobs/resume`) reject a request that carries neither
> browser Fetch Metadata nor a matching `Origin`. Browsers send those
> automatically and need nothing extra. curl and scripts must send
> `X-Thesis-Token` with the contents of the `csrf-token` file that the server
> writes into its data directory at every start.

A curl example that works, if the README wants one:

```
curl -X POST http://127.0.0.1:3000/api/report \
  -H "content-type: application/json" \
  -H "X-Thesis-Token: $(cat "$THESIS_DATA_DIR/csrf-token")" \
  -d '{"symbol":"AAPL"}'
```

If the README currently shows a curl call against any of those routes without
that header, it is now wrong.

## Corrections to existing README claims

- R-48 ("what leaves the machine") named none of the three real egress paths.
  `docs/PRIVACY.md` names all of them: `EDGAR_CONTACT` in the SEC `User-Agent`,
  the filing/transcript excerpts and ticker context payload sent to Anthropic,
  and the model-issued web searches Anthropic runs server-side (capped at 8 per
  request).
- R-58 ("license and data rights") named no provider terms. `docs/DATA-RIGHTS.md`
  covers Yahoo (automated access and redistribution prohibited, delayed quotes,
  unofficial endpoint), FMP (Data Display and Licensing Agreement required to
  display or redistribute), EDGAR (public domain, but a declared contact
  `User-Agent` and at most 10 requests/second), and FRED (its own terms of use).
- R-49 ("single-user, no auth, loopback only") remains true and needs no change.

## Files this workstream added or changed that the README may mention

- `docs/PRIVACY.md`, `docs/DATA-RIGHTS.md` (new).
- `npm run settings:reset` (new script in `package.json`).
- `THESIS_RESUME_ON_START`, `THESIS_TOKEN_FILE` (new keys, both in
  `.env.example`).
- `POST /api/jobs/resume` (new route).
