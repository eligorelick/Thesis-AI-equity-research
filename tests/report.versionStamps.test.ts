/**
 * Version stamps after the 2026-09-30 currency-integrity changes, and legacy
 * reads.
 *
 *  - REPORT_SPEC_VERSION 1.3.0: a report's money figures carry only
 *    established currencies (no legacy dollar default), statements and years
 *    are combined only in one currency, and route metrics may carry an
 *    optional `currency`. A 1.2.0 report is not like-for-like comparable, so
 *    the history diff says "spec-version-mismatch".
 *  - PAYLOAD_VERSION 1.4.0: the AI context payload states each money
 *    figure's currency or "(currency unknown)" and registers only figures
 *    whose own evidence establishes one.
 *
 * A report saved under 1.2.0 is still read, rendered and exported, keeps its
 * own stamp, and its stored bytes are never rewritten. Disposable in-memory
 * database; no network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ReportView } from "@/components/report/ReportView";
import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { reports } from "@/db/schema";
import { runStageB } from "@/pipeline/compute";
import { buildDataOnlyReport } from "@/pipeline/jobRunner";
import type { ValidationReport } from "@/pipeline/stageA/validate";
import {
  PAYLOAD_VERSION,
  assembleContextPayload,
  payloadFingerprint,
  serializePayloadForPrompt,
} from "@/pipeline/stageC/payload";
import { diffReports } from "@/report/diff";
import { reportToMarkdown } from "@/report/export/markdown";
import { reportToPrintBody } from "@/report/export/printHtml";
import { getLatestDoneReport } from "@/report/query";
import { REPORT_SPEC_VERSION, ReportSchema, type Report } from "@/report/schema";

import { completeCurrencyBundle } from "./helpers/currencyBundle";

const VALIDATION = { checks: [], flags: [], gaps: [] } as unknown as ValidationReport;
/** A report persisted under spec 1.2.0 (the checked-in sample; byte-pinned by the audit comparison). */
const LEGACY_REPORT_BYTES = readFileSync(path.join(process.cwd(), "fixtures", "report", "DEMO-sample.json"), "utf8");

function newReport(): Report {
  const bundle = completeCurrencyBundle({});
  return buildDataOnlyReport({
    symbol: bundle.symbol,
    companyName: "Test General Co",
    generatedAt: "2026-07-06T12:00:00.000Z",
    model: "none",
    costUsd: 0,
    bundle,
    validation: VALIDATION,
    computed: runStageB(bundle),
    costBreakdown: [],
    reason: "no analysis",
  });
}

describe("new version stamps", () => {
  it("bumps the report spec to 1.3.0 and the payload to 1.4.0", () => {
    expect(REPORT_SPEC_VERSION).toBe("1.3.0");
    expect(PAYLOAD_VERSION).toBe("1.4.0");
  });

  it("stamps a newly built report and payload with them", () => {
    expect(newReport().meta.specVersion).toBe("1.3.0");
    const bundle = completeCurrencyBundle({});
    const payload = assembleContextPayload(bundle, runStageB(bundle), VALIDATION);
    expect(payload.payloadVersion).toBe("1.4.0");
    expect(payloadFingerprint(payload)).toMatch(/^1\.4\.0:[0-9a-f]{8}$/);
    expect(serializePayloadForPrompt(payload)).toMatch(/^# CONTEXT PAYLOAD \(payloadVersion 1\.4\.0\)/);
  });
});

describe("a report saved under spec 1.2.0", () => {
  let handle: DatabaseHandle;
  beforeEach(() => {
    handle = createDatabase(":memory:");
    setDbForTests(handle.db);
  });
  afterEach(() => {
    setDbForTests(null);
    handle.sqlite.close();
  });

  it("is read, rendered and exported with its own stamp, and its stored bytes are left unchanged", () => {
    const legacy = JSON.parse(LEGACY_REPORT_BYTES) as Report;
    expect(legacy.meta.specVersion).toBe("1.2.0");
    const id = Number(
      handle.db
        .insert(reports)
        .values({
          symbol: legacy.meta.symbol,
          createdAt: "2026-07-01T00:00:00.000Z",
          model: "claude-opus-4-8",
          status: "done",
          reportJson: LEGACY_REPORT_BYTES,
          verificationRate: 0.9,
          costUsd: 0,
          specVersion: "1.2.0",
        })
        .run().lastInsertRowid,
    );

    const read = getLatestDoneReport(legacy.meta.symbol);
    expect(read?.reportId).toBe(id);
    expect(read?.specVersion).toBe("1.2.0");
    expect(read?.report?.meta.specVersion).toBe("1.2.0");
    expect(ReportSchema.safeParse(read!.report).success).toBe(true);
    expect(() => renderToStaticMarkup(createElement(ReportView, { report: read!.report! }))).not.toThrow();
    expect(reportToMarkdown(read!.report!)).toContain(legacy.meta.symbol);
    expect(reportToPrintBody(read!.report!)).toContain(legacy.meta.symbol);

    const stored = handle.sqlite
      .prepare('SELECT "reportJson", "specVersion" FROM "reports" WHERE "id" = ?')
      .get(id) as { reportJson: string; specVersion: string };
    expect(stored.reportJson).toBe(LEGACY_REPORT_BYTES);
    expect(stored.specVersion).toBe("1.2.0");
  });

  it("is not diffed like-for-like against a 1.3.0 report", () => {
    const legacy = JSON.parse(LEGACY_REPORT_BYTES) as Report;
    const current = structuredClone(legacy);
    current.meta.specVersion = REPORT_SPEC_VERSION;
    const diff = diffReports(legacy, current, {
      fromReportVersion: legacy.meta.pipelineVersion,
      toReportVersion: current.meta.pipelineVersion,
      fromSpecVersion: "1.2.0",
      toSpecVersion: "1.3.0",
    });
    expect(diff.comparisonStatus).toBe("not-comparable");
    expect(diff.notComparableReasons).toContain("spec-version-mismatch");
  });
});
