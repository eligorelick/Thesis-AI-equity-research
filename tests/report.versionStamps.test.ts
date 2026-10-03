/**
 * Version stamps after the 2026-10-02 release review, and legacy reads.
 * Report 1.5.0 and payload 1.6.0 apply currency-safe historical multiples,
 * dated ROE and explicit REIT approximation disclosures. Earlier stamps:
 *
 *  - REPORT_SPEC_VERSION 1.4.0: every share count and per-share figure is on
 *    the share basis of the price it meets, or withheld. A 1.3.0 report's
 *    market values and per-share figures were computed under other split
 *    rules, so the history diff says "spec-version-mismatch".
 *  - PAYLOAD_VERSION 1.5.0: the payload states EPS, share counts and market
 *    values only where their split basis is established; a pass stored under
 *    1.4.0 is never resumed.
 *
 * Earlier:
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
  it("bumps the report spec to 1.5.0 and the payload to 1.6.0", () => {
    expect(REPORT_SPEC_VERSION).toBe("1.5.0");
    expect(PAYLOAD_VERSION).toBe("1.6.0");
  });

  it("stamps a newly built report and payload with them", () => {
    expect(newReport().meta.specVersion).toBe("1.5.0");
    const bundle = completeCurrencyBundle({});
    const payload = assembleContextPayload(bundle, runStageB(bundle), VALIDATION);
    expect(payload.payloadVersion).toBe("1.6.0");
    expect(payloadFingerprint(payload)).toMatch(/^1\.6\.0:[0-9a-f]{8}$/);
    expect(serializePayloadForPrompt(payload)).toMatch(/^# CONTEXT PAYLOAD \(payloadVersion 1\.6\.0\)/);
  });

  it("never resumes a pass stored under the prior 1.5.0 financial conventions", () => {
    const bundle = completeCurrencyBundle({});
    const payload = assembleContextPayload(bundle, runStageB(bundle), VALIDATION);
    const asStoredUnder150 = payloadFingerprint({ ...payload, payloadVersion: "1.5.0" });
    expect(asStoredUnder150).toMatch(/^1\.5\.0:[0-9a-f]{8}$/);
    expect(payloadFingerprint(payload)).not.toBe(asStoredUnder150);
  });

  it("does not compare a prior 1.4.0 report as the same financial convention", () => {
    const before = newReport();
    before.meta.specVersion = "1.4.0";
    const after = newReport();
    const diff = diffReports(before, after, {
      fromReportVersion: before.meta.pipelineVersion,
      toReportVersion: after.meta.pipelineVersion,
      fromSpecVersion: before.meta.specVersion,
      toSpecVersion: after.meta.specVersion,
    });
    expect(diff.comparisonStatus).toBe("not-comparable");
    expect(diff.notComparableReasons).toContain("spec-version-mismatch");
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

  it("is not diffed like-for-like against a report of the current spec", () => {
    const legacy = JSON.parse(LEGACY_REPORT_BYTES) as Report;
    const current = structuredClone(legacy);
    current.meta.specVersion = REPORT_SPEC_VERSION;
    const diff = diffReports(legacy, current, {
      fromReportVersion: legacy.meta.pipelineVersion,
      toReportVersion: current.meta.pipelineVersion,
      fromSpecVersion: "1.2.0",
      toSpecVersion: REPORT_SPEC_VERSION,
    });
    expect(diff.comparisonStatus).toBe("not-comparable");
    expect(diff.notComparableReasons).toContain("spec-version-mismatch");
  });

  it("a 1.3.0 report (split rules before Batch 2) is not diffed like-for-like against a 1.4.0 report", () => {
    const legacy = JSON.parse(LEGACY_REPORT_BYTES) as Report;
    const before = structuredClone(legacy);
    before.meta.specVersion = "1.3.0";
    const after = structuredClone(legacy);
    after.meta.specVersion = "1.4.0";
    const diff = diffReports(before, after, {
      fromReportVersion: before.meta.pipelineVersion,
      toReportVersion: after.meta.pipelineVersion,
      fromSpecVersion: "1.3.0",
      toSpecVersion: "1.4.0",
    });
    expect(diff.comparisonStatus).toBe("not-comparable");
    expect(diff.notComparableReasons).toEqual(["spec-version-mismatch"]);
    // Control: two 1.4.0 reports remain comparable on the version test.
    const same = diffReports(after, structuredClone(after), {
      fromReportVersion: after.meta.pipelineVersion,
      toReportVersion: after.meta.pipelineVersion,
      fromSpecVersion: "1.4.0",
      toSpecVersion: "1.4.0",
    });
    expect(same.notComparableReasons ?? []).not.toContain("spec-version-mismatch");
  });
});
