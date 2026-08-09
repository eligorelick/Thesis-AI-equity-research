import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";

import { buildDataCompleteness } from "@/report/completeness";
import { buildExecutionMetadataEntry } from "@/report/execution";
import { reportToPrintHtml } from "@/report/export/printHtml";
import {
  parseStoredReportWithSafety,
  validateStoredReportInReadMode,
} from "@/report/legacyEntitySafety";
import type { Report } from "@/report/schema";

export interface CorrectedCliArguments {
  dbFile: string;
  reportId: number;
  outputHtml: string;
}

export interface CorrectedCliSummary extends CorrectedCliArguments {
  outputJson: string;
  withheldEntityStatements: number;
  verificationRate: Report["meta"]["verificationRate"];
  provenanceCoverage: Report["meta"]["provenanceCoverage"];
  dataCompleteness: Report["meta"]["dataCompleteness"];
  execution: Report["meta"]["execution"];
}

function argument(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function parseCorrectedCliArguments(
  argv: readonly string[],
  cwd = process.cwd(),
): CorrectedCliArguments {
  const dbFile = path.resolve(cwd, argument(argv, "--db"));
  const reportValue = argument(argv, "--report");
  const reportId = Number(reportValue);
  const outputHtml = path.resolve(cwd, argument(argv, "--out"));
  if (!/^[1-9]\d*$/.test(reportValue) || !Number.isSafeInteger(reportId)) {
    throw new Error("--report must be a positive integer");
  }
  return { dbFile, reportId, outputHtml };
}

export function runCorrectedExport({
  dbFile,
  reportId,
  outputHtml,
}: CorrectedCliArguments): CorrectedCliSummary {
  const sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const row = sqlite
      .prepare(
        `SELECT r."reportJson", r."createdAt", r."model", j."id" AS "runId",
                j."createdAt" AS "runStartedAt", j."updatedAt" AS "runCompletedAt"
           FROM "reports" r
           LEFT JOIN "jobs" j ON j."reportId" = r."id"
          WHERE r."id" = ?`,
      )
      .get(reportId) as
      | {
          reportJson: string | null;
          createdAt: string;
          model: string;
          runId: string | null;
          runStartedAt: string | null;
          runCompletedAt: string | null;
        }
      | undefined;
    if (!row?.reportJson) {
      throw new Error(`Report ${reportId} has no report JSON`);
    }

    const safety = parseStoredReportWithSafety(row.reportJson);
    if (safety === null) {
      throw new Error(`Report ${reportId} does not match a supported report schema`);
    }
    const report: Report = safety.report;
    const costs = row.runId
      ? (sqlite
          .prepare(
            `SELECT "step", "model", "costUsd", "fallbackUsed"
               FROM "cost_log" WHERE "jobId" = ? ORDER BY "id"`,
          )
          .all(row.runId) as {
          step: string;
          model: string;
          costUsd: number;
          fallbackUsed: number;
        }[])
      : [];
    const requestedModel = report.meta.model || row.model;
    const execution = costs.map((cost) =>
      buildExecutionMetadataEntry({
        step: cost.step,
        requestedModel,
        effectiveModel: cost.model,
        // Historical requested effort was not persisted; do not infer it.
        requestedEffort: null,
        fallbackUsed: cost.fallbackUsed === 1,
      }),
    );
    if (!execution.some((entry) => entry.step === "verify")) {
      execution.push(
        buildExecutionMetadataEntry({
          step: "verify",
          requestedModel: "deterministic",
          effectiveModel: "deterministic",
          requestedEffort: null,
          fallbackUsed: false,
        }),
      );
    }
    report.meta.execution = execution;
    report.meta.reportId = reportId;
    if (row.runId) report.meta.runId = row.runId;
    if (row.runStartedAt) report.meta.startedAt = row.runStartedAt;
    if (row.runCompletedAt) report.meta.completedAt = row.runCompletedAt;
    if (costs.length > 0) {
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

    const hasEdgar = report.appendix.sources.some(
      (source) => source.provider.toLowerCase() === "edgar",
    );
    const hasXbrl = report.appendix.sources.some((source) =>
      /xbrl|company.?facts/i.test(source.endpoint),
    );
    if (!hasEdgar) {
      report.appendix.missingData.unshift({
        field: "legacy.audit.edgar",
        reason:
          "No EDGAR source is recorded for this persisted report; EDGAR-dependent conclusions are provisional",
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
    report.meta.dataCompleteness = buildDataCompleteness(
      report.appendix.missingData,
    );
    const validated = validateStoredReportInReadMode(report, safety.readMode);
    if (validated === null) {
      throw new Error(
        `Corrected report ${reportId} no longer matches its supported read schema`,
      );
    }

    fs.mkdirSync(path.dirname(outputHtml), { recursive: true });
    fs.writeFileSync(outputHtml, reportToPrintHtml(validated), "utf8");
    const outputJson = outputHtml.replace(/\.html?$/i, ".json");
    fs.writeFileSync(
      outputJson,
      `${JSON.stringify(validated, null, 2)}\n`,
      "utf8",
    );
    return {
      dbFile,
      reportId,
      outputHtml,
      outputJson,
      withheldEntityStatements: safety.withheldCount,
      verificationRate: validated.meta.verificationRate,
      provenanceCoverage: validated.meta.provenanceCoverage,
      dataCompleteness: validated.meta.dataCompleteness,
      execution: validated.meta.execution,
    };
  } finally {
    sqlite.close();
  }
}

export function runCorrectedCli(
  argv: readonly string[],
  io: { writeStdout(value: string): void } = {
    writeStdout: (value) => process.stdout.write(value),
  },
  cwd = process.cwd(),
): CorrectedCliSummary {
  const summary = runCorrectedExport(parseCorrectedCliArguments(argv, cwd));
  io.writeStdout(JSON.stringify(summary, null, 2));
  return summary;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    runCorrectedCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
