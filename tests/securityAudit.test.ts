import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const AUDIT_SCRIPT = path.join(ROOT, "scripts", "run-security-audit.mjs");

interface AuditFailure extends Error {
  exitCode: number;
}

interface SecurityAuditModule {
  resolveNpmExecPath(value: string | undefined): string;
  runSecurityAudit(options: {
    npmExecPath: string;
    runNpm: (
      executable: string,
      args: readonly string[],
      options: { cwd: string; encoding: "utf8"; stdio: "inherit" | "pipe" },
    ) => {
      status: number | null;
      stdout?: string;
      stderr?: string;
      error?: Error;
    };
    cwd: string;
    stdio?: "inherit" | "pipe";
  }): void;
}

async function loadAudit(): Promise<SecurityAuditModule> {
  const moduleUrl = pathToFileURL(AUDIT_SCRIPT).href;
  return (await import(moduleUrl)) as SecurityAuditModule;
}

describe("security audit gate", () => {
  it("invokes npm through Node with the exact dev-inclusive low advisory gate", async () => {
    const audit = await loadAudit();
    const npmCli = path.join(ROOT, "fake", "npm-cli.js");
    const calls: Array<{
      executable: string;
      args: readonly string[];
      cwd: string;
      stdio: string;
    }> = [];

    audit.runSecurityAudit({
      npmExecPath: npmCli,
      cwd: ROOT,
      stdio: "pipe",
      runNpm: (executable, args, options) => {
        calls.push({ executable, args, cwd: options.cwd, stdio: options.stdio });
        return { status: 0, stdout: "clean" };
      },
    });

    expect(calls).toEqual([
      {
        executable: process.execPath,
        args: [npmCli, "audit", "--include=dev", "--audit-level=low"],
        cwd: ROOT,
        stdio: "pipe",
      },
    ]);
  });

  it("preserves advisory failures and fails closed on registry/spawn outages", async () => {
    const audit = await loadAudit();
    const base = {
      npmExecPath: path.join(ROOT, "fake", "npm-cli.js"),
      cwd: ROOT,
      stdio: "pipe" as const,
    };

    let advisory: unknown;
    try {
      audit.runSecurityAudit({
        ...base,
        runNpm: () => ({ status: 1, stderr: "low severity advisory" }),
      });
    } catch (error) {
      advisory = error;
    }
    expect((advisory as AuditFailure).exitCode).toBe(1);
    expect((advisory as Error).message).toMatch(/low severity advisory/i);

    let registry: unknown;
    try {
      audit.runSecurityAudit({
        ...base,
        runNpm: () => ({ status: 42, stderr: "registry unavailable" }),
      });
    } catch (error) {
      registry = error;
    }
    expect((registry as AuditFailure).exitCode).toBe(42);
    expect((registry as Error).message).toMatch(/registry unavailable/i);

    let spawn: unknown;
    try {
      audit.runSecurityAudit({
        ...base,
        runNpm: () => ({ status: null, error: new Error("spawn outage") }),
      });
    } catch (error) {
      spawn = error;
    }
    expect((spawn as AuditFailure).exitCode).toBe(1);
    expect((spawn as Error).message).toMatch(/spawn outage/i);
  });

  it("rejects missing, relative, and non-file npm_execpath values", async () => {
    const audit = await loadAudit();
    expect(() => audit.resolveNpmExecPath(undefined)).toThrow(/npm_execpath.*missing/i);
    expect(() => audit.resolveNpmExecPath("node_modules/npm/bin/npm-cli.js")).toThrow(
      /npm_execpath.*absolute/i,
    );
    expect(() => audit.resolveNpmExecPath(path.join(ROOT, "missing-npm-cli.js"))).toThrow(
      /npm_execpath.*file/i,
    );
    expect(() => audit.resolveNpmExecPath(ROOT)).toThrow(/npm_execpath.*file/i);
  });

  it("propagates a real child npm exit code through the executable wrapper", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "thesis-audit-gate-"));
    try {
      const fakeNpm = path.join(tempDir, "fake npm cli.js");
      writeFileSync(
        fakeNpm,
        [
          'if (process.argv.slice(2).join(" ") !== "audit --include=dev --audit-level=low") process.exit(99);',
          'process.stderr.write("registry unavailable\\n");',
          "process.exit(37);",
          "",
        ].join("\n"),
        "utf8",
      );
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(childEnv)) {
        if (key.toLowerCase() === "npm_execpath") delete childEnv[key];
      }
      childEnv.npm_execpath = fakeNpm;
      const result = spawnSync(process.execPath, [AUDIT_SCRIPT], {
        cwd: ROOT,
        encoding: "utf8",
        env: childEnv,
      });
      expect(result.status).toBe(37);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/registry unavailable/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
