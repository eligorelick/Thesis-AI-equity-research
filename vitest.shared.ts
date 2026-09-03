import path from "node:path";

export const DB_CLI_TEST = "tests/db.cli.test.ts";
export const PRODUCT_TEST_INCLUDE = ["tests/**/*.test.ts"];
export const PRODUCT_TEST_EXCLUDE = [DB_CLI_TEST];
export const INTEGRATION_TEST_INCLUDE = [DB_CLI_TEST];

/**
 * Installed for every test file in every config: replaces `globalThis.fetch`
 * with a guard that rejects any non-loopback request, so a test can never reach
 * a live provider. See `tests/setup/noLiveNetwork.ts`.
 */
export const SHARED_SETUP_FILES = ["./tests/setup/noLiveNetwork.ts"];

export const SHARED_RESOLVE_ALIAS = {
  "@": path.resolve(__dirname, "src"),
  "server-only": path.resolve(__dirname, "tests", "server-only.mock.ts"),
};

/**
 * Literal risk inventory. Keep this deliberately explicit: adding or removing
 * an audited source is a reviewable coverage-policy change.
 */
export const RISK_SOURCE_MANIFEST = [
  "src/providers/anthropic.ts",
  "src/providers/edgar.ts",
  "src/providers/finnhub.ts",
  "src/providers/finra.ts",
  "src/providers/fmp.ts",
  "src/providers/fred.ts",
  "src/providers/http.ts",
  "src/providers/yahoo.ts",
  "src/edgar/extract.ts",
  "src/edgar/xbrl.ts",
  "src/edgar/statements.ts",
  "src/edgar/splits.ts",
  "src/edgar/sic.ts",
  "src/cache/apiCache.ts",
  "src/cache/compression.ts",
  "src/cache/maintenance.ts",
  "src/symbol.ts",
  "src/pipeline/companyLoad.ts",
  "src/pipeline/dataBundle.ts",
  "src/pipeline/keyless.ts",
  "src/pipeline/stageA/manifest.ts",
  "src/pipeline/stageA/validate.ts",
  "src/pipeline/stageC/citations.ts",
  "src/pipeline/stageC/entityValidation.ts",
  "src/pipeline/stageC/index.ts",
  "src/pipeline/stageC/passes.ts",
  "src/pipeline/stageC/payload.ts",
  "src/pipeline/stageC/prompts.ts",
  "src/pipeline/stageC/provenance.ts",
  "src/pipeline/jobArtifacts.ts",
  "src/pipeline/jobRunner.ts",
  "src/pipeline/jobStore.ts",
  "src/pipeline/jobScheduler.ts",
  "src/pipeline/jobSchedulerBootstrap.ts",
  "src/pipeline/jobState.ts",
  "src/pipeline/jobSteps.ts",
  "src/pipeline/events.ts",
  "src/pipeline/types.ts",
  "src/instrumentation.ts",
  "src/report/completeness.ts",
  "src/report/execution.ts",
  "src/report/query.ts",
  "src/report/history.ts",
  "src/report/diff.ts",
  "src/report/legacyEntitySafety.ts",
  "src/report/sectionManifest.ts",
  "src/report/surfaceManifest.ts",
  "src/report/export/correctedCli.ts",
  "src/report/export/markdown.ts",
  "src/report/export/markdownEscape.ts",
  "src/report/export/printHtml.ts",
  "src/report/format.ts",
  "src/settings/contracts.ts",
  "src/settings/settings.ts",
  "src/settings/writeQueue.ts",
  "src/app/requestSecurity.ts",
  "src/app/api/sameOrigin.ts",
  "src/app/api/export/[reportId]/route.ts",
  "src/app/api/jobs/resume/route.ts",
  "src/app/api/report/route.ts",
  "src/app/api/report/resolvePasses.ts",
  "src/app/api/report/[jobId]/route.ts",
  "src/app/api/report/[jobId]/cancel/route.ts",
  "src/app/api/report/[jobId]/retry/route.ts",
  "src/app/api/report/[jobId]/stream/route.ts",
  "src/app/api/report/view/[reportId]/route.ts",
  "src/app/api/settings/route.ts",
  "src/app/api/watchlist/route.ts",
  "src/proxy.ts",
  "src/config/env.ts",
  "src/db/index.ts",
  "src/db/paths.ts",
  "src/db/schema.ts",
  "src/watchlist/watchlist.ts",
];
