import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCorrectedExport } from "@/report/export/correctedCli";

/**
 * The JSON sidecar path was derived by replacing an `.html`/`.htm` suffix. When
 * `--out` carries no such suffix the replace is a no-op, so the JSON write lands
 * on the path the HTML was just written to and destroys it — while the returned
 * summary still advertises that path as the HTML deliverable.
 */
const ROOT = path.resolve(__dirname, "..");
const REPORT_FIXTURE = path.join(ROOT, "fixtures", "report", "DEMO-sample.json");

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "thesis-corrected-out-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function seed(dbFile: string): void {
  mkdirSync(path.dirname(dbFile), { recursive: true });
  // Same minimal shape as tests/report.correctedCli.test.ts's seed helper — the
  // CLI reads `reports` and left-joins the ledger tables.
  const sqlite = new Database(dbFile);
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
  const stored = readFileSync(REPORT_FIXTURE, "utf8");
  sqlite
    .prepare("INSERT INTO reports (id, reportJson, createdAt, model) VALUES (?, ?, ?, ?)")
    .run(7, stored, "2026-08-30T00:00:00.000Z", "claude-opus-4-8");
  sqlite.close();
}

describe("corrected export --out without an .html suffix", () => {
  it("writes the JSON beside the HTML instead of over it", () => {
    const dbFile = path.join(tempDir, "source.db");
    const out = path.join(tempDir, "corrected-report"); // no extension
    seed(dbFile);

    const summary = runCorrectedExport({ dbFile, reportId: 7, outputHtml: out });

    expect(summary.outputJson).not.toBe(summary.outputHtml);

    const html = readFileSync(summary.outputHtml, "utf8");
    expect(html.trimStart().slice(0, 400).toLowerCase()).toContain("<!doctype html");

    const json = readFileSync(summary.outputJson, "utf8");
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("still replaces the suffix when --out ends in .html", () => {
    const dbFile = path.join(tempDir, "source2.db");
    const out = path.join(tempDir, "corrected.html");
    seed(dbFile);

    const summary = runCorrectedExport({ dbFile, reportId: 7, outputHtml: out });

    expect(summary.outputHtml).toBe(out);
    expect(summary.outputJson).toBe(path.join(tempDir, "corrected.json"));
    expect(readFileSync(summary.outputHtml, "utf8").toLowerCase()).toContain("<!doctype html");
  });
});
