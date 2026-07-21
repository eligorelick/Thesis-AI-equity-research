/**
 * Handler-level tests for the report download/view API routes (audit test-gap
 * finding). Imports the GET handlers directly and drives them with constructed
 * Request objects + params, against an in-memory better-sqlite3 database.
 *
 * No network / no LLM — both routes only read the local `reports` table via the
 * persistence layer.
 *
 * Coverage:
 *   GET /api/export/[reportId]      — STRICT reportId parse guard (garbage,
 *                                     "12abc"/"12.9"/"1e5", empty, overlong,
 *                                     signed → 400 and NEVER resolve to another
 *                                     report), unknown id → 404, unparseable
 *                                     stored JSON → 422, unknown format → 400,
 *                                     md/pdf success with a sanitized
 *                                     Content-Disposition filename.
 *   GET /api/report/view/[reportId] — same strict parse guard (→ 400), unknown
 *                                     id → 404, compact summary shape on a real
 *                                     row, malformed row degrades to 200.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @/report/history (pulled in by the export route) imports the `server-only`
// shim, absent under the plain-node test runner. Stub it to a no-op.
vi.mock("server-only", () => ({}));

import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { reports } from "@/db/schema";
import { ReportSchema, REPORT_SPEC_VERSION, type Report } from "@/report/schema";

import { GET as exportGET } from "@/app/api/export/[reportId]/route";
import { GET as viewGET } from "@/app/api/report/view/[reportId]/route";

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

let handle: DatabaseHandle;

const FIXTURE_PATH = path.join(process.cwd(), "fixtures", "report", "DEMO-sample.json");

function loadFixtureReport(): Report {
  const parsed = ReportSchema.safeParse(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
  if (!parsed.success) throw new Error("fixture must parse");
  return parsed.data;
}

function clone(report: Report): Report {
  return JSON.parse(JSON.stringify(report)) as Report;
}

/** Seed one report row; returns its id. */
function seedReport(
  report: Report,
  opts: { id?: number; verificationRate?: number; costUsd?: number } = {},
): number {
  const row = handle.db
    .insert(reports)
    .values({
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      symbol: report.meta.symbol,
      createdAt: report.meta.generatedAt,
      model: report.meta.model,
      status: "done",
      reportJson: JSON.stringify(report),
      verificationRate: opts.verificationRate ?? null,
      costUsd: opts.costUsd ?? null,
      specVersion: REPORT_SPEC_VERSION,
    })
    .returning({ id: reports.id })
    .get();
  return row.id;
}

/** Seed a raw row (possibly corrupt/null reportJson); returns its id. */
function seedRawRow(reportJson: string | null, status = "done"): number {
  const row = handle.db
    .insert(reports)
    .values({
      symbol: "AAPL",
      createdAt: "2026-07-05T00:00:00.000Z",
      model: "claude-opus-4-8",
      status,
      reportJson,
      verificationRate: null,
      costUsd: null,
      specVersion: REPORT_SPEC_VERSION,
    })
    .returning({ id: reports.id })
    .get();
  return row.id;
}

/**
 * Ids that lax `Number.parseInt` would have silently truncated to a DIFFERENT
 * report ("12abc"/"12.9" → 12, "1e5" → 1) or coerced (" 12", "+12"), plus
 * empty and overlong (16 digits > the 15-digit safe-integer cap). All must be
 * rejected with 400 by the strict digits-only parser.
 */
const MALFORMED_IDS: ReadonlyArray<[label: string, raw: string]> = [
  ["trailing garbage", "12abc"],
  ["decimal point", "12.9"],
  ["exponent notation", "1e5"],
  ["empty string", ""],
  ["overlong (16 digits)", "1234567890123456"],
  ["leading whitespace", " 12"],
  ["plus sign", "+12"],
  ["negative sign", "-12"],
  ["hex prefix", "0x12"],
];

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
});

afterEach(() => {
  setDbForTests(null);
  handle.sqlite.close();
});

function exportReq(reportId: string, format?: string): [Request, { params: Promise<{ reportId: string }> }] {
  const qs = format === undefined ? "" : `?format=${format}`;
  return [
    new Request(`http://localhost/api/export/${reportId}${qs}`),
    { params: Promise.resolve({ reportId }) },
  ];
}

function viewReq(reportId: string): [Request, { params: Promise<{ reportId: string }> }] {
  return [
    new Request(`http://localhost/api/report/view/${reportId}`),
    { params: Promise.resolve({ reportId }) },
  ];
}

/* ------------------------------------------------------------------------ *
 * GET /api/export/[reportId]
 * ------------------------------------------------------------------------ */

describe("GET /api/export/[reportId]", () => {
  it("returns 400 for a non-numeric (garbage) id", async () => {
    const res = await exportGET(...exportReq("abc"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid report id");
  });

  it("returns 400 for a negative id (sign rejected by the strict parser)", async () => {
    const res = await exportGET(...exportReq("-5"));
    expect(res.status).toBe(400);
  });

  it.each(MALFORMED_IDS)(
    "returns 400 for a malformed id (%s) — never resolves to another report",
    async (_label, raw) => {
      // Seed the reports a lax parseInt WOULD have truncated these ids to
      // (12 and 1) — the strict parser must 400, not serve them.
      seedReport(loadFixtureReport(), { id: 1 });
      seedReport(loadFixtureReport(), { id: 12 });
      const res = await exportGET(...exportReq(raw));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("invalid report id");
    },
  );

  it("accepts a 15-digit id (within the length cap) — unknown, so 404", async () => {
    const res = await exportGET(...exportReq("999999999999999"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown numeric id", async () => {
    const res = await exportGET(...exportReq("999999"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("999999");
  });

  it("returns 422 (not 404) for a done row whose stored JSON is corrupt", async () => {
    const id = seedRawRow("{ this is not valid json");
    const res = await exportGET(...exportReq(String(id)));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    // The error names the report id and says the content is the problem.
    expect(body.error).toContain(String(id));
    expect(body.error).toMatch(/unparseable|missing/);
  });

  it("returns 422 for a done row whose JSON parses but fails schema validation", async () => {
    const id = seedRawRow(JSON.stringify({ hello: "not a report" }));
    const res = await exportGET(...exportReq(String(id)));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(String(id));
  });

  it("returns 422 for a row with null reportJson (exists, no exportable content)", async () => {
    const id = seedRawRow(null, "running");
    const res = await exportGET(...exportReq(String(id)));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(String(id));
  });

  it("returns 400 for an unknown format", async () => {
    const id = seedReport(loadFixtureReport());
    const res = await exportGET(...exportReq(String(id), "csv"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unknown format");
  });

  it("returns markdown (default) with a Content-Disposition filename", async () => {
    const id = seedReport(loadFixtureReport());
    const res = await exportGET(...exportReq(String(id)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="DEMO-report-${id}.md"`,
    );
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it("returns print HTML for format=pdf inline", async () => {
    const id = seedReport(loadFixtureReport());
    const res = await exportGET(...exportReq(String(id), "pdf"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename="DEMO-report-${id}.html"`,
    );
  });

  it("SANITIZES an unsafe symbol into the download filename (no path/quote injection)", async () => {
    const report = clone(loadFixtureReport());
    // A malicious/awkward symbol must never reach the header verbatim.
    report.meta.symbol = 'A/A"PL ..\\evil';
    const id = seedReport(report);
    const res = await exportGET(...exportReq(String(id)));
    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition") ?? "";
    // Every filesystem/header-hostile character collapsed to "-": the only
    // double-quotes left are the two wrapping the filename value.
    expect(cd).not.toContain("/");
    expect(cd).not.toContain("\\");
    expect((cd.match(/"/g) ?? []).length).toBe(2);
    // slug(): [^A-Za-z0-9._-]+ → "-"; the "." run is kept, giving A-A-PL-..-evil.
    expect(cd).toBe(`attachment; filename="A-A-PL-..-evil-report-${id}.md"`);
  });
});

/* ------------------------------------------------------------------------ *
 * GET /api/report/view/[reportId]
 * ------------------------------------------------------------------------ */

describe("GET /api/report/view/[reportId]", () => {
  it("returns 400 for a non-numeric id", async () => {
    const res = await viewGET(...viewReq("garbage"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid report id");
  });

  it.each(MALFORMED_IDS)(
    "returns 400 for a malformed id (%s) — never resolves to another report",
    async (_label, raw) => {
      seedReport(loadFixtureReport(), { id: 1 });
      seedReport(loadFixtureReport(), { id: 12 });
      const res = await viewGET(...viewReq(raw));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("invalid report id");
    },
  );

  it("returns 404 for an unknown id", async () => {
    const res = await viewGET(...viewReq("424242"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("424242");
  });

  it("returns the compact summary shape for a persisted report", async () => {
    const id = seedReport(loadFixtureReport(), { verificationRate: 0.94, costUsd: 2.18 });
    const res = await viewGET(...viewReq(String(id)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reportId: number;
      symbol: string;
      companyName: string;
      model: string;
      costUsd: number | null;
      verificationRate: number | null;
      synthesis: string;
      grades: { key: string; grade: string; oneLineWhy: string }[];
      dataOnly: boolean;
    };
    expect(body.reportId).toBe(id);
    expect(body.symbol).toBe("DEMO");
    expect(body.companyName).toBe("Thesis Example Systems");
    expect(body.verificationRate).toBeCloseTo(0.94);
    expect(body.costUsd).toBeCloseTo(2.18);
    expect(body.grades.map((g) => g.key)).toEqual([
      "fundamentals",
      "valuation",
      "technicals",
      "quality",
      "leadership",
      "moat",
    ]);
    expect(body.synthesis.length).toBeGreaterThan(0);
    expect(body.dataOnly).toBe(false);
  });

  it("degrades to a friendly payload (no throw) when the stored JSON is malformed", async () => {
    // Seed a row whose reportJson cannot be parsed — the route must still 200
    // with empty grades and dataOnly=true rather than 500.
    const row = handle.db
      .insert(reports)
      .values({
        symbol: "AAPL",
        createdAt: "2026-07-05T00:00:00.000Z",
        model: "claude-opus-4-8",
        status: "error",
        reportJson: "{ not valid json",
        verificationRate: null,
        costUsd: null,
        specVersion: REPORT_SPEC_VERSION,
      })
      .returning({ id: reports.id })
      .get();

    const res = await viewGET(...viewReq(String(row.id)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      symbol: string;
      grades: unknown[];
      dataOnly: boolean;
      synthesis: string;
    };
    expect(body.symbol).toBe("AAPL");
    expect(body.grades).toEqual([]);
    expect(body.dataOnly).toBe(true);
    expect(body.synthesis).toContain("unavailable");
  });
});
