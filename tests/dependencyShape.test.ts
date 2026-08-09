import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const CHECKER = path.join(ROOT, "scripts", "check-dependency-shape.mjs");
const EXPECTED = {
  next: ["16.3.0"],
  "eslint-config-next": ["16.3.0"],
  postcss: ["8.5.26"],
  sharp: ["0.35.3"],
  "js-yaml": ["4.3.1"],
  "brace-expansion": ["1.1.18", "5.0.9"],
} as const;

interface DependencyShapeModule {
  APPROVED_VERSIONS: Record<string, readonly string[]>;
  collectInstalledVersions(tree: unknown): Record<string, string[]>;
  collectLockVersions(lock: unknown): Record<string, string[]>;
  resolveNpmExecPath(value: string | undefined): string;
  runDependencyShape(options: {
    root: string;
    lockPath: string;
    npmExecPath: string;
    runNpm: (
      executable: string,
      args: readonly string[],
      options: { cwd: string; encoding: "utf8" },
    ) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
  }): void;
  validateExactVersions(
    actual: Record<string, string[]>,
    expected?: Record<string, readonly string[]>,
    label?: string,
  ): void;
}

async function loadChecker(): Promise<DependencyShapeModule> {
  const moduleUrl = pathToFileURL(CHECKER).href;
  return (await import(moduleUrl)) as DependencyShapeModule;
}

function syntheticInstalledTree(): unknown {
  return {
    dependencies: {
      next: {
        version: "16.3.0",
        dependencies: { sharp: { version: "0.35.3" } },
      },
      "eslint-config-next": { version: "16.3.0" },
      postcss: { version: "8.5.26" },
      loaderA: {
        version: "1.0.0",
        dependencies: {
          "js-yaml": { version: "4.3.1" },
          "brace-expansion": { version: "1.1.18" },
        },
      },
      loaderB: {
        version: "1.0.0",
        dependencies: {
          "brace-expansion": { version: "5.0.9" },
        },
      },
    },
  };
}

describe("dependency shape gate", () => {
  it("pins the exact audited version sets in package-lock", async () => {
    const checker = await loadChecker();
    const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));

    expect(checker.APPROVED_VERSIONS).toEqual(EXPECTED);
    const versions = checker.collectLockVersions(lock);
    expect(versions).toEqual(EXPECTED);
    expect(() => checker.validateExactVersions(versions)).not.toThrow();
  });

  it("fails separately for missing, wrong, and extra lock versions", async () => {
    const checker = await loadChecker();
    const baseline = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string }>;
    };
    const clone = () => structuredClone(baseline);

    const wrong = clone();
    wrong.packages["node_modules/next"]!.version = "16.3.1";
    expect(() =>
      checker.validateExactVersions(checker.collectLockVersions(wrong)),
    ).toThrow(/lock.*next.*16\.3\.1.*16\.3\.0/i);

    const missing = clone();
    delete missing.packages[
      "node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion"
    ];
    expect(() =>
      checker.validateExactVersions(checker.collectLockVersions(missing)),
    ).toThrow(/lock.*brace-expansion.*5\.0\.9/i);

    const extra = clone();
    extra.packages["node_modules/fake/node_modules/postcss"] = {
      version: "8.5.27",
    };
    expect(() =>
      checker.validateExactVersions(checker.collectLockVersions(extra)),
    ).toThrow(/lock.*postcss.*8\.5\.27.*8\.5\.26/i);
  });

  it("validates the installed tree and catches missing, wrong, and nested extra versions", async () => {
    const checker = await loadChecker();
    const installed = syntheticInstalledTree();
    expect(checker.collectInstalledVersions(installed)).toEqual(EXPECTED);
    expect(() =>
      checker.validateExactVersions(
        checker.collectInstalledVersions(installed),
        checker.APPROVED_VERSIONS,
        "installed tree",
      ),
    ).not.toThrow();

    const drifted = syntheticInstalledTree() as {
      dependencies: { postcss: { version: string } };
    };
    drifted.dependencies.postcss.version = "8.5.25";
    expect(() =>
      checker.validateExactVersions(
        checker.collectInstalledVersions(drifted),
        checker.APPROVED_VERSIONS,
        "installed tree",
      ),
    ).toThrow(/installed tree.*postcss.*8\.5\.25.*8\.5\.26/i);

    const missing = syntheticInstalledTree() as {
      dependencies: Record<string, unknown>;
    };
    delete missing.dependencies["eslint-config-next"];
    expect(() =>
      checker.validateExactVersions(
        checker.collectInstalledVersions(missing),
        checker.APPROVED_VERSIONS,
        "installed tree",
      ),
    ).toThrow(/installed tree.*eslint-config-next.*16\.3\.0/i);

    const extra = syntheticInstalledTree() as {
      dependencies: Record<string, unknown>;
    };
    extra.dependencies.extra = {
      version: "1.0.0",
      dependencies: { sharp: { version: "0.35.4" } },
    };
    expect(() =>
      checker.validateExactVersions(
        checker.collectInstalledVersions(extra),
        checker.APPROVED_VERSIONS,
        "installed tree",
      ),
    ).toThrow(/installed tree.*sharp.*0\.35\.4.*0\.35\.3/i);
  });

  it("rejects malformed and problemed npm trees before version comparison", async () => {
    const checker = await loadChecker();
    expect(() => checker.collectInstalledVersions(null)).toThrow(/npm tree/i);
    expect(() =>
      checker.collectInstalledVersions({ problems: ["invalid: next@0.0.0"] }),
    ).toThrow(/npm tree.*invalid/i);
    expect(() =>
      checker.collectInstalledVersions({
        dependencies: { next: { dependencies: {} } },
      }),
    ).toThrow(/next.*version/i);
  });

  it("consults npm through process.execPath semantics and validates its result", async () => {
    const checker = await loadChecker();
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    checker.runDependencyShape({
      root: ROOT,
      lockPath: path.join(ROOT, "package-lock.json"),
      npmExecPath: path.join(ROOT, "fake", "npm-cli.js"),
      runNpm: (executable, args) => {
        calls.push({ executable, args });
        return { status: 0, stdout: JSON.stringify(syntheticInstalledTree()) };
      },
    });
    expect(calls).toEqual([
      {
        executable: process.execPath,
        args: [
          path.join(ROOT, "fake", "npm-cli.js"),
          "ls",
          "next",
          "eslint-config-next",
          "postcss",
          "sharp",
          "brace-expansion",
          "js-yaml",
          "--all",
          "--json",
          "--include=dev",
        ],
      },
    ]);

    let npmLsFailure: unknown;
    try {
      checker.runDependencyShape({
        root: ROOT,
        lockPath: path.join(ROOT, "package-lock.json"),
        npmExecPath: path.join(ROOT, "fake", "npm-cli.js"),
        runNpm: () => ({
          status: 1,
          stdout: '{"full":"tree payload must stay out of diagnostics"}',
          stderr: "npm registry/tree failure",
        }),
      });
    } catch (error) {
      npmLsFailure = error;
    }
    expect((npmLsFailure as Error).message).toMatch(
      /npm ls.*registry\/tree failure/i,
    );
    expect((npmLsFailure as Error).message).not.toContain("tree payload");
  });

  it("rejects missing, relative, and non-file npm_execpath values", async () => {
    const checker = await loadChecker();
    expect(() => checker.resolveNpmExecPath(undefined)).toThrow(/npm_execpath.*missing/i);
    expect(() => checker.resolveNpmExecPath("node_modules/npm/bin/npm-cli.js")).toThrow(
      /npm_execpath.*absolute/i,
    );
    expect(() => checker.resolveNpmExecPath(path.join(ROOT, "missing-npm-cli.js"))).toThrow(
      /npm_execpath.*file/i,
    );
    expect(() => checker.resolveNpmExecPath(ROOT)).toThrow(/npm_execpath.*file/i);
  });

  it("wires CLI failures to a nonzero exit instead of printing a fake success", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "thesis-dep-shape-"));
    try {
      const lock = JSON.parse(
        readFileSync(path.join(ROOT, "package-lock.json"), "utf8"),
      ) as { packages: Record<string, { version?: string }> };
      lock.packages["node_modules/next"]!.version = "0.0.0";
      const lockPath = path.join(tempDir, "package-lock.json");
      writeFileSync(lockPath, JSON.stringify(lock), "utf8");

      const result = spawnSync(process.execPath, [CHECKER, "--lockfile", lockPath], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env },
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/next.*0\.0\.0.*16\.3\.0/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("passes against the real lock and npm-provided installed tree", () => {
    const output = execFileSync(process.execPath, [CHECKER], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env },
    });
    expect(output).toContain("dependency shape verified");
  }, 30_000);
});
