import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { reportToPrintHtml } from "@/report/export/printHtml";
import { ReportSchema } from "@/report/schema";

const ROOT = path.resolve(__dirname, "..");
const CLI_SOURCE = path.join(ROOT, "src", "report", "export", "correctedCli.ts");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const REPORT_FIXTURE = path.join(ROOT, "fixtures", "report", "DEMO-sample.json");

interface CorrectedCliArguments {
  dbFile: string;
  reportId: number;
  outputHtml: string;
}

interface CorrectedCliSummary extends CorrectedCliArguments {
  outputJson: string;
  withheldEntityStatements: number;
  verificationRate: number | null;
  provenanceCoverage: unknown;
  dataCompleteness: unknown;
  execution: unknown[];
}

interface CorrectedCliModule {
  parseCorrectedCliArguments(
    argv: readonly string[],
    cwd?: string,
  ): CorrectedCliArguments;
  runCorrectedExport(options: CorrectedCliArguments): CorrectedCliSummary;
  runCorrectedCli(
    argv: readonly string[],
    io?: { writeStdout(value: string): void },
    cwd?: string,
  ): CorrectedCliSummary;
}

async function loadCli(): Promise<CorrectedCliModule> {
  const moduleUrl = pathToFileURL(CLI_SOURCE).href;
  return (await import(moduleUrl)) as CorrectedCliModule;
}

function seedReportDatabase(
  dbFile: string,
  reportJson?: string,
  withLedger = false,
): string {
  const storedBytes = reportJson ?? readFileSync(REPORT_FIXTURE, "utf8");
  const sqlite = new Database(dbFile);
  try {
    sqlite.exec(`
      CREATE TABLE reports (
        id INTEGER PRIMARY KEY,
        reportJson TEXT,
        createdAt TEXT NOT NULL,
        model TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        reportId INTEGER,
        createdAt TEXT,
        updatedAt TEXT
      );
      CREATE TABLE cost_log (
        id INTEGER PRIMARY KEY,
        jobId TEXT,
        step TEXT,
        model TEXT,
        costUsd REAL,
        fallbackUsed INTEGER
      );
    `);
    sqlite
      .prepare(
        "INSERT INTO reports (id, reportJson, createdAt, model) VALUES (?, ?, ?, ?)",
      )
      .run(
        7,
        storedBytes,
        "2026-08-08T00:00:00.000Z",
        "fixture-model",
      );
    if (withLedger) {
      sqlite
        .prepare(
          "INSERT INTO jobs (id, reportId, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
        )
        .run(
          "run-7",
          7,
          "2026-08-08T01:00:00.000Z",
          "2026-08-08T01:05:00.000Z",
        );
      const insertCost = sqlite.prepare(
        "INSERT INTO cost_log (id, jobId, step, model, costUsd, fallbackUsed) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insertCost.run(1, "run-7", "bull", "effective-bull", 0.001234, 1);
      insertCost.run(2, "run-7", "verify", "effective-verify", 0.002345, 0);
    }
  } finally {
    sqlite.close();
  }
  return storedBytes;
}

describe("corrected report CLI", () => {
  it("is import-safe and exposes callable parsing/export entry points", async () => {
    const tempRoot = path.join(ROOT, "tmp");
    mkdirSync(tempRoot, { recursive: true });
    const tempDir = mkdtempSync(path.join(tempRoot, "corrected-import-"));
    try {
      const imported = spawnSync(
        process.execPath,
        [
          TSX_CLI,
          "--eval",
          `import(${JSON.stringify(pathToFileURL(CLI_SOURCE).href)}).catch((error) => { console.error(error); process.exitCode = 1; })`,
        ],
        { cwd: tempDir, encoding: "utf8", timeout: 10_000 },
      );
      const diagnostic = imported.stderr.match(/Error: [^\r\n]+/)?.[0];
      expect(imported.status, diagnostic).toBe(0);
      expect(imported.stdout).toBe("");
      expect(imported.stderr).toBe("");
      expect(readdirSync(tempDir)).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    const cli = await loadCli();
    expect(cli.parseCorrectedCliArguments).toBeTypeOf("function");
    expect(cli.runCorrectedExport).toBeTypeOf("function");
    expect(cli.runCorrectedCli).toBeTypeOf("function");
  });

  it("parses absolute and relative arguments strictly", async () => {
    const cli = await loadCli();
    expect(
      cli.parseCorrectedCliArguments(
        ["--db", "db/report.db", "--report", "7", "--out", "out/report.html"],
        ROOT,
      ),
    ).toEqual({
      dbFile: path.join(ROOT, "db", "report.db"),
      reportId: 7,
      outputHtml: path.join(ROOT, "out", "report.html"),
    });
    expect(() => cli.parseCorrectedCliArguments([], ROOT)).toThrow(/Missing --db/);
    expect(() =>
      cli.parseCorrectedCliArguments(
        ["--db", "x.db", "--report", "7x", "--out", "x.html"],
        ROOT,
      ),
    ).toThrow(/--report must be a positive integer/);
    expect(() =>
      cli.parseCorrectedCliArguments(
        ["--db", "x.db", "--report", "0", "--out", "x.html"],
        ROOT,
      ),
    ).toThrow(/--report must be a positive integer/);
  });

  it("writes exact HTML, newline-terminated JSON, and machine-readable summary", async () => {
    const cli = await loadCli();
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "thesis-corrected-"));
    const nested = path.join(tempDir, "Unicode 数据 workspace");
    const dbFile = path.join(nested, "source report 数据.db");
    const outputHtml = path.join(
      nested,
      "nested output 数据",
      "corrected report.html",
    );
    const report = JSON.parse(readFileSync(REPORT_FIXTURE, "utf8")) as {
      appendix: { sources: Array<{ provider: string; endpoint: string }> };
    };
    report.appendix.sources = report.appendix.sources.filter(
      (source) =>
        source.provider.toLowerCase() !== "edgar" &&
        !/xbrl|company.?facts/i.test(source.endpoint),
    );
    let storedBytes = "";

    try {
      mkdirSync(nested, { recursive: true });
      storedBytes = seedReportDatabase(dbFile, JSON.stringify(report), true);
      let stdout = "";
      const summary = cli.runCorrectedCli(
        ["--db", dbFile, "--report", "7", "--out", outputHtml],
        { writeStdout: (value) => (stdout += value) },
        ROOT,
      );
      const parsedStdout = JSON.parse(stdout) as CorrectedCliSummary;
      const outputJson = outputHtml.replace(/\.html?$/i, ".json");

      expect(summary).toEqual(parsedStdout);
      expect(Object.keys(summary).sort()).toEqual(
        [
          "dataCompleteness",
          "dbFile",
          "execution",
          "outputHtml",
          "outputJson",
          "provenanceCoverage",
          "reportId",
          "verificationRate",
          "withheldEntityStatements",
        ].sort(),
      );
      expect(summary).toMatchObject({
        dbFile,
        reportId: 7,
        outputHtml,
        outputJson,
        withheldEntityStatements: 0,
      });
      expect(summary.withheldEntityStatements).toBeGreaterThanOrEqual(0);
      const htmlBytes = readFileSync(outputHtml, "utf8");
      expect(htmlBytes).toMatch(/<!doctype html>[\s\S]*Thesis Example Systems/i);
      const jsonBytes = readFileSync(outputJson, "utf8");
      expect(jsonBytes.endsWith("\n")).toBe(true);
      const corrected = ReportSchema.parse(JSON.parse(jsonBytes));
      expect(htmlBytes).toBe(reportToPrintHtml(corrected));
      expect(corrected).toMatchObject({
        meta: {
          symbol: "DEMO",
          reportId: 7,
          runId: "run-7",
          startedAt: "2026-08-08T01:00:00.000Z",
          completedAt: "2026-08-08T01:05:00.000Z",
        },
        appendix: {
          costBreakdown: [
            {
              step: "bull",
              model: "effective-bull",
              costUsd: 0.001234,
              fallbackUsed: true,
            },
            {
              step: "verify",
              model: "effective-verify",
              costUsd: 0.002345,
              fallbackUsed: false,
            },
          ],
        },
      });
      expect(corrected.meta.costUsd).toBeCloseTo(0.003579, 12);
      expect(corrected.meta.execution).toEqual([
        {
          step: "bull",
          requestedModel: "synthetic-fixture",
          effectiveModel: "effective-bull",
          requestedEffort: null,
          effectiveEffort: null,
          fallbackUsed: true,
          adjustments: ["fallback"],
          note: "bull: served by the server-side fallback model effective-bull after synthetic-fixture declined the request.",
        },
        {
          step: "verify",
          requestedModel: "synthetic-fixture",
          effectiveModel: "effective-verify",
          requestedEffort: null,
          effectiveEffort: null,
          fallbackUsed: false,
          adjustments: [],
        },
      ]);
      expect(corrected.appendix.costBreakdown).toEqual([
        {
          step: "bull",
          model: "effective-bull",
          costUsd: 0.001234,
          requestedModel: "synthetic-fixture",
          requestedEffort: null,
          effectiveEffort: null,
          fallbackUsed: true,
          adjustments: ["fallback"],
        },
        {
          step: "verify",
          model: "effective-verify",
          costUsd: 0.002345,
          requestedModel: "synthetic-fixture",
          requestedEffort: null,
          effectiveEffort: null,
          fallbackUsed: false,
          adjustments: [],
        },
      ]);
      expect(corrected.appendix.missingData.slice(0, 2)).toEqual([
        expect.objectContaining({ field: "legacy.audit.xbrl", severity: "warn" }),
        expect.objectContaining({ field: "legacy.audit.edgar", severity: "critical" }),
      ]);
      expect(corrected.appendix.missingData.slice(2)).toEqual(
        ReportSchema.parse(JSON.parse(storedBytes)).appendix.missingData,
      );
      expect(summary.execution).toEqual(corrected.meta.execution);
      expect(summary.verificationRate).toBe(corrected.meta.verificationRate);
      expect(summary.provenanceCoverage).toEqual(corrected.meta.provenanceCoverage);
      expect(summary.dataCompleteness).toEqual(corrected.meta.dataCompleteness);

      const persisted = new Database(dbFile, { readonly: true, fileMustExist: true });
      try {
        const row = persisted
          .prepare("SELECT reportJson FROM reports WHERE id = 7")
          .get() as { reportJson: string };
        expect(row.reportJson).toBe(storedBytes);
      } finally {
        persisted.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
    expect(existsSync(tempDir)).toBe(false);
  });

  it("closes the database and cleans safely after missing-report, schema, and write failures", async () => {
    const cli = await loadCli();

    for (const failure of ["report", "schema", "write"] as const) {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "thesis-corrected-failure-"));
      const nested = path.join(tempDir, `${failure} workspace 数据`);
      const dbFile = path.join(nested, "source 数据.db");
      const outputHtml =
        failure === "write" ? nested : path.join(nested, "output 数据.html");
      let storedBytes = "";

      try {
        mkdirSync(nested, { recursive: true });
        storedBytes = seedReportDatabase(
          dbFile,
          failure === "schema" ? "{invalid json" : undefined,
        );
        expect(() =>
          cli.runCorrectedExport({
            dbFile,
            reportId: failure === "report" ? 8 : 7,
            outputHtml,
          }),
        ).toThrow(
          failure === "report"
            ? /Report 8 has no report JSON/i
            : failure === "schema"
              ? /supported report schema/i
              : /EISDIR|directory/i,
        );

        const persisted = new Database(dbFile, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const row = persisted
            .prepare("SELECT reportJson FROM reports WHERE id = 7")
            .get() as { reportJson: string };
          expect(row.reportJson).toBe(storedBytes);
        } finally {
          persisted.close();
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
      expect(existsSync(tempDir)).toBe(false);
    }
  });

  it("keeps the package export:corrected entry point executable", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "thesis-corrected-cli-"));
    const nested = path.join(tempDir, "CLI workspace 数据");
    const dbFile = path.join(nested, "source 数据.db");
    const outputHtml = path.join(nested, "cli output 数据.html");
    try {
      mkdirSync(nested, { recursive: true });
      seedReportDatabase(dbFile);
      // The argv package.json declares, spawned without npm: `npm run` fires
      // npm's update-notifier, a live pacote.manifest("npm@*") request to
      // registry.npmjs.org from a child process that
      // tests/setup/noLiveNetwork.ts cannot reach. `npm_execpath` is also
      // unset under node_modules/.bin/vitest and IDE runners.
      const script = (
        JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
          scripts: Record<string, string>;
        }
      ).scripts["export:corrected"];
      const [runner, ...scriptArgv] = script.split(/\s+/);
      expect(runner).toBe("tsx");
      expect(scriptArgv).toEqual([path.relative(ROOT, CLI_SOURCE).replaceAll("\\", "/")]);

      const result = spawnSync(
        process.execPath,
        [
          TSX_CLI,
          ...scriptArgv,
          "--db",
          dbFile,
          "--report",
          "7",
          "--out",
          outputHtml,
        ],
        { cwd: ROOT, encoding: "utf8", timeout: 12_000, shell: false },
      );
      const diagnostic = result.stderr.match(/Error: [^\r\n]+/)?.[0];
      expect(result.status, diagnostic).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ reportId: 7, outputHtml });
      expect(existsSync(outputHtml)).toBe(true);
      expect(existsSync(outputHtml.replace(/\.html$/i, ".json"))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});
