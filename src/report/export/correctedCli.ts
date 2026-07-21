import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { buildDataCompleteness } from "@/report/completeness";
import { buildExecutionMetadataEntry } from "@/report/execution";
import { reportToPrintHtml } from "@/report/export/printHtml";
import { sanitizeLegacyEntityConflicts } from "@/report/legacyEntitySafety";
import { ReportSchema, withLenientLegacyRead, type Report } from "@/report/schema";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const dbFile = path.resolve(argument("--db"));
const reportId = Number(argument("--report"));
const outputHtml = path.resolve(argument("--out"));
if (!Number.isInteger(reportId) || reportId <= 0) throw new Error("--report must be a positive integer");

const sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
try {
  const row = sqlite.prepare(
    `SELECT r."reportJson", r."createdAt", r."model", j."id" AS "runId",
            j."createdAt" AS "runStartedAt", j."updatedAt" AS "runCompletedAt"
       FROM "reports" r
       LEFT JOIN "jobs" j ON j."reportId" = r."id"
      WHERE r."id" = ?`,
  ).get(reportId) as {
    reportJson: string | null;
    createdAt: string;
    model: string;
    runId: string | null;
    runStartedAt: string | null;
    runCompletedAt: string | null;
  } | undefined;
  if (!row?.reportJson) throw new Error(`Report ${reportId} has no report JSON`);

  const raw = JSON.parse(row.reportJson);
  const strict = ReportSchema.safeParse(raw);
  const parsed = strict.success
    ? strict
    : withLenientLegacyRead(() => ReportSchema.safeParse(raw));
  if (!parsed.success) throw new Error(`Report ${reportId} does not match a supported report schema`);

  const safety = sanitizeLegacyEntityConflicts(parsed.data);
  const report: Report = safety.report;
  const costs = row.runId
    ? sqlite.prepare(
        `SELECT "step", "model", "costUsd", "fallbackUsed"
           FROM "cost_log" WHERE "jobId" = ? ORDER BY "id"`,
      ).all(row.runId) as { step: string; model: string; costUsd: number; fallbackUsed: number }[]
    : [];
  const requestedModel = report.meta.model || row.model;
  const execution = costs.map((cost) => buildExecutionMetadataEntry({
    step: cost.step,
    requestedModel,
    effectiveModel: cost.model,
    // Historical requested effort was not persisted; do not infer it from current settings.
    requestedEffort: null,
    fallbackUsed: cost.fallbackUsed === 1,
  }));
  if (!execution.some((entry) => entry.step === "verify")) {
    execution.push(buildExecutionMetadataEntry({
      step: "verify",
      requestedModel: "deterministic",
      effectiveModel: "deterministic",
      requestedEffort: null,
      fallbackUsed: false,
    }));
  }
  report.meta.execution = execution;
  report.meta.reportId = reportId;
  if (row.runId) report.meta.runId = row.runId;
  if (row.runStartedAt) report.meta.startedAt = row.runStartedAt;
  if (row.runCompletedAt) report.meta.completedAt = row.runCompletedAt;
  if (costs.length > 0) {
    // The persisted legacy meta total was rounded to four decimals. Restore
    // the exact machine-readable sum from the immutable cost ledger so JSON,
    // HTML, and the six-decimal rendered total all reconcile.
    report.meta.costUsd = costs.reduce((sum, cost) => sum + cost.costUsd, 0);
    report.appendix.costBreakdown = costs.map((cost, index) => {
      const entry = execution[index]!;
      return {
        step: cost.step,
        model: cost.model,
        costUsd: cost.costUsd,
        requestedModel: entry.requestedModel,
        requestedEffort: entry.requestedEffort,
        effectiveEffort: entry.effectiveEffort,
        fallbackUsed: entry.fallbackUsed,
        adjustments: entry.adjustments,
      };
    });
  }

  const hasEdgar = report.appendix.sources.some((source) => source.provider.toLowerCase() === "edgar");
  const hasXbrl = report.appendix.sources.some((source) => /xbrl|company.?facts/i.test(source.endpoint));
  if (!hasEdgar) {
    report.appendix.missingData.unshift({
      field: "legacy.audit.edgar",
      reason: "No EDGAR source is recorded for this persisted report; EDGAR-dependent conclusions are provisional",
      severity: "critical",
      attemptedSources: ["persisted source manifest"],
    });
  }
  if (!hasXbrl) {
    report.appendix.missingData.unshift({
      field: "legacy.audit.xbrl",
      reason: "No XBRL/company-facts cross-check is recorded for this persisted report",
      severity: "warn",
      attemptedSources: ["persisted source manifest"],
    });
  }
  report.meta.dataCompleteness = buildDataCompleteness(report.appendix.missingData);
  const validated = ReportSchema.parse(report);

  fs.mkdirSync(path.dirname(outputHtml), { recursive: true });
  fs.writeFileSync(outputHtml, reportToPrintHtml(validated), "utf8");
  const outputJson = outputHtml.replace(/\.html?$/i, ".json");
  fs.writeFileSync(outputJson, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({
    dbFile,
    reportId,
    outputHtml,
    outputJson,
    withheldEntityStatements: safety.withheldCount,
    verificationRate: validated.meta.verificationRate,
    provenanceCoverage: validated.meta.provenanceCoverage,
    dataCompleteness: validated.meta.dataCompleteness,
    execution: validated.meta.execution,
  }, null, 2));
} finally {
  sqlite.close();
}
