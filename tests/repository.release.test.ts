import { execFileSync } from "node:child_process";
import {
  existsSync,
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
const read = (name: string) => readFileSync(path.join(ROOT, name), "utf8");
const trackedFiles = (root = ROOT) =>
  execFileSync("git", ["ls-files", "--cached", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file.length > 0)
    .sort();
const publicFiles = () => trackedFiles();

const REQUIRED_RELEASE_FILES = [
  ".github/workflows/ci.yml",
  "docs/superpowers/plans/2026-08-07-audit-remediation.md",
  "docs/superpowers/specs/2026-08-07-audit-remediation-design.md",
  "config/models.json",
  "scripts/check-dependency-shape.mjs",
  "scripts/models-refresh.mjs",
  "scripts/reconcile-presumed-costs.mjs",
  "scripts/docs-pricing.mjs",
  "scripts/run-security-audit.mjs",
  "tests/dependencyShape.test.ts",
  "tests/report.correctedCli.test.ts",
  "tests/risk.coverage.test.ts",
  "tests/risk.providers.coverage.test.ts",
  "tests/risk.runtime.coverage.test.ts",
  "tests/securityAudit.test.ts",
  "vitest.integration.config.ts",
  "vitest.risk.config.ts",
  "vitest.shared.ts",
] as const;
const ALLOWED_MARKDOWN = new Set([
  "README.md",
  "docs/superpowers/plans/2026-08-07-audit-remediation.md",
  "docs/superpowers/specs/2026-08-07-audit-remediation-design.md",
  "docs/superpowers/audits/2026-08-07-remediation-verification.md",
  "docs/superpowers/plans/2026-08-09-provider-temporal-integrity.md",
  "docs/superpowers/specs/2026-08-09-provider-temporal-integrity-design.md",
  "docs/superpowers/audits/2026-08-30-code-and-docs-audit.md",
  "docs/superpowers/plans/2026-08-31-outstanding-audit-items.md",
  "docs/superpowers/audits/2026-08-31-analytical-integrity-verification.md",
  "docs/superpowers/plans/2026-09-02-keyless-data-path.md",
  "docs/superpowers/specs/2026-09-02-keyless-data-path-design.md",
  "docs/superpowers/specs/2026-09-02-analysis-quality-design.md",
  "docs/audit/README-RECONCILIATION.md",
  "docs/audit/DECISIONS.md",
  "docs/audit/PROGRESS.md",
  // WS8
  "docs/PRIVACY.md",
  "docs/DATA-RIGHTS.md",
  "docs/audit/README-NOTES-WS8.md",
  // end WS8
  // WS5
  "docs/audit/README-NOTES-WS5.md",
  "docs/audit/ws5-methodology.md",
  "docs/METHODOLOGY.md", // WS6
  "docs/audit/README-NOTES-WS6.md", // WS6
  "docs/audit/README-NOTES-WS7.md", // WS7
]);
const VERIFY_GATES = [
  "npm run check:dependencies",
  "npm run typecheck",
  "npm run lint",
  "npm run test:product",
  "npm run test:integration",
  "npm run test:coverage",
  "npm run build",
  "npm run audit:security",
] as const;

function forbiddenReleaseFiles(files: readonly string[]): string[] {
  return files.filter((file) => {
    const lower = file.toLowerCase();
    if (file === ".env.example") return false;
    if (lower.endsWith(".md") && !ALLOWED_MARKDOWN.has(file)) return true;
    if (lower.startsWith("docs/") && !ALLOWED_MARKDOWN.has(file)) return true;
    if (lower.startsWith(".github/") && file !== ".github/workflows/ci.yml") {
      return true;
    }
    return /(^|\/)(audit_prompt(?:\.md)?|credentials(?:\.json)?|id_rsa|\.npmrc|\.netrc|research\/|\.env($|\.)|data\/|\.next\/|build\/|out\/|dist\/|node_modules\/|coverage\/|\.claude\/|\.superpowers\/|\.playwright-mcp\/|\.worktrees\/)|\.(?:db(?:3)?$|db-|sqlite(?:3)?$|tsbuildinfo$|pem$|key$|p12$|pfx$)/i.test(
      file,
    );
  });
}

function unsafePublicDocument(document: string): string[] {
  const findings: string[] = [];
  if (
    /(?:[A-Z]:[\\/]Users[\\/][^\\/\s"']+|(?:^|[\s"'`=(])\/(?:Users|home)\/[^/\s"']+|~[\\/])/i.test(
      document,
    )
  ) {
    findings.push("absolute home path");
  }
  if (
    /(?:sk-ant-|ghp_|github_pat_|Bearer\s+[A-Za-z0-9._-]{12,}|(?:API_KEY|TOKEN|PASSWORD)["']?\s*[:=]\s*["']?(?!<|\$|your-|example|placeholder)[A-Za-z0-9._-]{12,})/i.test(
      document,
    )
  ) {
    findings.push("credential value");
  }
  return findings;
}

function listedTests(config: string): string[] {
  const raw = execFileSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
      "list",
      "--config",
      config,
      "--filesOnly",
      "--json",
      "--staticParse",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  const listed = JSON.parse(raw) as Array<{ file: string }>;
  return listed
    .map(({ file }) => path.relative(ROOT, file).replaceAll("\\", "/"))
    .sort();
}

interface LoadedVitestConfig {
  test?: {
    include?: string[];
    exclude?: string[];
    pool?: string;
    isolate?: boolean;
    fileParallelism?: boolean;
    maxWorkers?: number | string;
    testTimeout?: number;
    retry?: number;
    coverage?: {
      provider?: string;
      include?: string[];
      reportsDirectory?: string;
      thresholds?: Record<string, number | boolean>;
    };
  };
  resolve?: { alias?: Record<string, string> };
}

interface LoadedSharedVitestConfig {
  DB_CLI_TEST: string;
  PRODUCT_TEST_INCLUDE: string[];
  PRODUCT_TEST_EXCLUDE: string[];
  INTEGRATION_TEST_INCLUDE: string[];
  SHARED_RESOLVE_ALIAS: Record<string, string>;
}

async function loadVitestConfig(config: string): Promise<LoadedVitestConfig> {
  const moduleUrl = pathToFileURL(path.join(ROOT, config)).href;
  const loaded = (await import(moduleUrl)) as { default: LoadedVitestConfig };
  return loaded.default;
}

async function loadSharedVitestConfig(): Promise<LoadedSharedVitestConfig> {
  const moduleUrl = pathToFileURL(path.join(ROOT, "vitest.shared.ts")).href;
  return (await import(moduleUrl)) as LoadedSharedVitestConfig;
}

interface WorkflowStep {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  shell?: string;
  if?: unknown;
}

interface WorkflowJob {
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: unknown;
  steps?: WorkflowStep[];
}

interface ParsedWorkflow {
  name?: string;
  on?: unknown;
  permissions?: unknown;
  concurrency?: unknown;
  jobs?: Record<string, WorkflowJob>;
}

async function parseWorkflow(source: string): Promise<ParsedWorkflow> {
  const moduleName = "js-yaml";
  const yaml = (await import(moduleName)) as {
    load(value: string): unknown;
  };
  return yaml.load(source) as ParsedWorkflow;
}

describe("public release contract", () => {
  it("uses canonical GitHub metadata and loopback-only server scripts", () => {
    const pkg = JSON.parse(read("package.json")) as {
      homepage: string;
      repository: { url: string };
      bugs: { url: string };
      scripts: Record<string, string>;
    };

    expect(pkg.homepage).toBe(
      "https://github.com/eligorelick/Thesis-AI-equity-research#readme",
    );
    expect(pkg.repository.url).toBe(
      "git+https://github.com/eligorelick/Thesis-AI-equity-research.git",
    );
    expect(pkg.bugs.url).toBe(
      "https://github.com/eligorelick/Thesis-AI-equity-research/issues",
    );
    expect(pkg.scripts.dev).toBe("next dev -H 127.0.0.1");
    expect(pkg.scripts.start).toBe("next start -H 127.0.0.1");
    expect(pkg.scripts["export:corrected"]).toBe(
      "tsx src/report/export/correctedCli.ts",
    );
    expect(pkg.scripts).not.toHaveProperty("verify:live");
    expect(pkg.scripts).not.toHaveProperty("verify:tickers");
  });

  it("defines the exact fail-closed local CI gate order", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts).toMatchObject({
      "check:dependencies": "node scripts/check-dependency-shape.mjs",
      "test:product": "vitest run --config vitest.config.ts",
      "test:integration": "vitest run --config vitest.integration.config.ts",
      "test:coverage:core":
        "vitest run --config vitest.config.ts --coverage",
      "test:coverage:risk":
        "vitest run --config vitest.risk.config.ts --coverage",
      "test:coverage":
        "npm run test:coverage:core && npm run test:coverage:risk",
      "audit:security": "node scripts/run-security-audit.mjs",
    });
    expect(pkg.scripts.verify).toBe(VERIFY_GATES.join(" && "));
    expect(pkg.scripts["audit:security"]).not.toMatch(
      /\|\||continue-on-error|--omit=dev/i,
    );
  });

  it("partitions every tracked test through the real static Vitest CLI", () => {
    for (const config of [
      "vitest.config.ts",
      "vitest.risk.config.ts",
      "vitest.integration.config.ts",
    ]) {
      expect(existsSync(path.join(ROOT, config)), `${config} must exist`).toBe(
        true,
      );
    }

    const tracked = publicFiles().filter((file) =>
      /^tests\/.+\.test\.ts$/.test(file),
    );
    const dbCli = "tests/db.cli.test.ts";
    const expectedProduct = tracked.filter((file) => file !== dbCli);
    const product = listedTests("vitest.config.ts");
    const risk = listedTests("vitest.risk.config.ts");
    const integration = listedTests("vitest.integration.config.ts");

    expect(product).toEqual(expectedProduct);
    expect(risk).toEqual(expectedProduct);
    expect(integration).toEqual([dbCli]);
    expect(product.filter((file) => integration.includes(file))).toEqual([]);
    expect([...new Set([...product, ...integration])].sort()).toEqual(tracked);
  }, 30_000);

  it("uses isolated forks, shared aliases, and deterministic coverage artifacts", async () => {
    const shared = await loadSharedVitestConfig();
    const product = await loadVitestConfig("vitest.config.ts");
    const risk = await loadVitestConfig("vitest.risk.config.ts");
    const integration = await loadVitestConfig("vitest.integration.config.ts");

    for (const config of [product, risk, integration]) {
      expect(config.test?.pool).toBe("forks");
      expect(config.test?.isolate).toBe(true);
    }
    expect(shared.DB_CLI_TEST).toBe("tests/db.cli.test.ts");
    expect(product.test?.include).toBe(shared.PRODUCT_TEST_INCLUDE);
    expect(risk.test?.include).toBe(shared.PRODUCT_TEST_INCLUDE);
    expect(product.test?.exclude).toBe(shared.PRODUCT_TEST_EXCLUDE);
    expect(risk.test?.exclude).toBe(shared.PRODUCT_TEST_EXCLUDE);
    expect(integration.test?.include).toBe(shared.INTEGRATION_TEST_INCLUDE);
    expect(product.test?.maxWorkers).toBe("50%");
    expect(risk.test?.maxWorkers).toBe(1);
    expect(product.resolve?.alias).toBe(shared.SHARED_RESOLVE_ALIAS);
    expect(risk.resolve?.alias).toBe(shared.SHARED_RESOLVE_ALIAS);
    expect(integration.resolve?.alias).toBe(shared.SHARED_RESOLVE_ALIAS);
    expect(product.test?.exclude).toEqual(["tests/db.cli.test.ts"]);
    expect(risk.test?.exclude).toEqual(["tests/db.cli.test.ts"]);
    expect(integration.test).toMatchObject({
      include: ["tests/db.cli.test.ts"],
      fileParallelism: false,
      maxWorkers: 1,
      testTimeout: 15_000,
      retry: 0,
    });
    expect(risk.resolve?.alias).toEqual(product.resolve?.alias);
    expect(integration.resolve?.alias).toEqual(product.resolve?.alias);
    expect(product.resolve?.alias).toEqual({
      "@": path.join(ROOT, "src"),
      "server-only": path.join(ROOT, "tests", "server-only.mock.ts"),
    });
    expect(product.test?.coverage).toMatchObject({
      provider: "v8",
      include: ["src/pipeline/stageB/**/*.ts", "src/report/schema.ts"],
      reportsDirectory: "coverage/core",
      thresholds: {
        statements: 90,
        branches: 84,
        functions: 95,
        lines: 93,
      },
    });
    expect(risk.test?.coverage).toMatchObject({
      provider: "v8",
      reportsDirectory: "coverage/risk",
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 85,
        lines: 85,
        perFile: true,
        autoUpdate: false,
      },
    });
  });

  it("keeps the workflow in exact verify parity across supported lanes", async () => {
    const workflowSource = read(".github/workflows/ci.yml");
    const workflow = await parseWorkflow(workflowSource);
    const full = workflow.jobs?.full;
    const windows = workflow.jobs?.["windows-smoke"];
    const expectedSteps = (nodeVersion: number, commands: readonly string[]) => [
      { uses: "actions/checkout@v4" },
      {
        uses: "actions/setup-node@v4",
        with: { "node-version": nodeVersion, cache: "npm" },
      },
      ...commands.map((run) => ({ run })),
    ];

    expect(workflow.name).toBe("CI");
    expect(workflow.on).toEqual(["push", "pull_request"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "${{ github.workflow }}-${{ github.ref }}",
      "cancel-in-progress": true,
    });
    // Node 20 reached end-of-life in April 2026 and its lane was retired on
    // 2026-09-01: the test harness spawns TypeScript workers and eval scripts
    // that depend on Node 24's native type stripping, so the lane could never
    // pass and no longer describes a supported runtime.
    expect(Object.keys(workflow.jobs ?? {}).sort()).toEqual(["full", "windows-smoke"]);
    expect(full).toMatchObject({ "runs-on": "ubuntu-latest", "timeout-minutes": 60 });
    expect(windows).toMatchObject({
      "runs-on": "windows-latest",
      "timeout-minutes": 45,
    });
    for (const job of [full, windows]) {
      expect(job?.permissions).toBeUndefined();
      for (const step of job?.steps ?? []) {
        expect(step.if).toBeUndefined();
        expect(step.shell).toBeUndefined();
      }
    }
    expect(full?.steps).toEqual(expectedSteps(24, ["npm ci", ...VERIFY_GATES]));
    expect(workflowSource).not.toMatch(/node-version:\s*20\b/);
    expect(windows?.steps).toEqual(
      expectedSteps(24, [
        "npm ci",
        "npm run test:product -- --maxWorkers=1",
        "npm run test:integration",
      ]),
    );
    expect(workflowSource).not.toMatch(
      /continue-on-error|^\s*if:|:\s*write(?:-all)?\b|\$\{\{\s*secrets\.|^\s*(?:env|defaults|shell):\s*|ANTHROPIC_API_KEY|FMP_API_KEY|FINNHUB_API_KEY|FRED_API_KEY|EDGAR_CONTACT|verify:live|node_modules|\|\|\s*true|;\s*exit\s+0/im,
    );
  });

  it("keeps approved public docs free of home paths and credential values", () => {
    const approvedDocs = publicFiles().filter((file) => ALLOWED_MARKDOWN.has(file));
    for (const file of approvedDocs) {
      expect(unsafePublicDocument(read(file)), file).toEqual([]);
    }

    expect(unsafePublicDocument("home: C:\\Users\\alice\\private\\file.md")).toEqual([
      "absolute home path",
    ]);
    expect(unsafePublicDocument("watchlist/home/history")).toEqual([]);
    expect(unsafePublicDocument("path: /home/alice/private")).toEqual([
      "absolute home path",
    ]);
    expect(unsafePublicDocument("token: ghp_1234567890abcdef")).toEqual([
      "credential value",
    ]);
    expect(
      unsafePublicDocument('{"ANTHROPIC_API_KEY":"abcdefghijklmnop"}'),
    ).toEqual(["credential value"]);
    expect(unsafePublicDocument("PASSWORD: abcdefghijklmnop")).toEqual([
      "credential value",
    ]);
  });

  it("documents supported CI, the retired Node 20 lane, and branch protection", () => {
    const readme = read("README.md");
    expect(readme).toContain("Node.js 24 LTS");
    expect(readme).toMatch(/Node\.js 20 .*end-of-life/s);
    expect(readme).not.toContain("compatibility lane");
    expect(readme).toMatch(/branch protection.*require.*CI \/ full/is);
  });

  it("publishes only the exact tracked release allowlist", () => {
    const files = publicFiles();

    for (const required of REQUIRED_RELEASE_FILES) {
      expect(files).toContain(required);
    }
    expect(forbiddenReleaseFiles(files)).toEqual([]);
  });

  it("ignores unrelated untracked files but rejects the same paths if tracked", () => {
    const tempRepo = mkdtempSync(path.join(os.tmpdir(), "thesis-release-index-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: tempRepo });
      writeFileSync(path.join(tempRepo, ".gitignore"), "*.md\n", "utf8");
      writeFileSync(
        path.join(tempRepo, "user-owned.md"),
        "user-owned and intentionally untracked\n",
        "utf8",
      );
      expect(trackedFiles(tempRepo)).not.toContain("user-owned.md");

      execFileSync("git", ["add", "-f", "user-owned.md"], { cwd: tempRepo });
      const forceTracked = trackedFiles(tempRepo);
      expect(forceTracked).toContain("user-owned.md");
      expect(forbiddenReleaseFiles(forceTracked)).toContain("user-owned.md");
    } finally {
      rmSync(tempRepo, { recursive: true, force: true });
    }

    expect(
      forbiddenReleaseFiles([
        "AUDIT_PROMPT.md",
        "docs/unknown.md",
        "Docs/case-variant.MD",
        ".github/workflows/unknown.yml",
        ".GITHUB/workflows/case-variant.yml",
        ".superpowers/private.md",
        "data/local.db",
        "local.sqlite",
        "local.sqlite3",
        "local.db3",
        "build/output.js",
        "coverage/risk/coverage-summary.json",
        "credentials.json",
        "certs/private.pem",
        "certs/private.key",
        "certs/private.p12",
        "certs/private.pfx",
        ".npmrc",
        ".netrc",
        "ssh/id_rsa",
      ]),
    ).toEqual([
      "AUDIT_PROMPT.md",
      "docs/unknown.md",
      "Docs/case-variant.MD",
      ".github/workflows/unknown.yml",
      ".GITHUB/workflows/case-variant.yml",
      ".superpowers/private.md",
      "data/local.db",
      "local.sqlite",
      "local.sqlite3",
      "local.db3",
      "build/output.js",
      "coverage/risk/coverage-summary.json",
      "credentials.json",
      "certs/private.pem",
      "certs/private.key",
      "certs/private.p12",
      "certs/private.pfx",
      ".npmrc",
      ".netrc",
      "ssh/id_rsa",
    ]);
  });

  it("keeps only referenced EDGAR test samples in the fixtures boundary", () => {
    const files = publicFiles();
    const edgarFixtures = files.filter((file) =>
      file.startsWith("fixtures/edgar/"),
    );
    const edgarTests = [
      read("tests/edgar.client.test.ts"),
      read("tests/edgar.extract.test.ts"),
      read("tests/edgar.xbrl.test.ts"),
    ].join("\n");

    expect(edgarFixtures).toHaveLength(15);
    for (const fixture of edgarFixtures) {
      expect(edgarTests).toContain(path.basename(fixture));
    }
  });

  it("contains no source or test references to deleted internal documents", () => {
    const files = publicFiles().filter(
      (file) =>
        /^(src|tests)\/.+\.(?:ts|tsx)$/.test(file) &&
        file !== "tests/repository.release.test.ts",
    );
    const implementationText = files.map((file) => read(file)).join("\n");
    const removedDocNames = [
      "AGENTS",
      "CLAUDE",
      "CONTRIBUTING",
      "COST",
      "DATA_MAP",
      "DECISIONS",
      "SECURITY",
      "SPEC",
    ]
      .map((name) => `${name}\\.md`)
      .join("|");

    expect(implementationText).not.toMatch(new RegExp(removedDocNames));
    expect(implementationText).not.toMatch(/research[\\/]/);
  });

  it("documents setup, privacy, safety, and verification in README", () => {
    const readme = read("README.md");
    const prose = readme.replace(/\s+/g, " ");

    for (const required of [
      "Synthetic demo mode",
      "/company/DEMO",
      "not investment advice",
      "127.0.0.1",
      "sent directly to the providers you configure",
      "never enter the browser",
      "npm ci",
      "npm run verify",
    ]) {
      expect(prose).toContain(required);
    }

    expect(readme).not.toMatch(
      /verify:live|verify:tickers|\.github\/|(?:^|[\s`(])research\//im,
    );
  });

  it("labels keyless data as synthetic and keeps synthetic artifacts fictional", () => {
    const home = read("src/app/page.tsx");
    const settings = [
      read("src/app/settings/page.tsx"),
      read("src/app/settings/SettingsPageView.tsx"),
    ].join("\n");
    const company = read("src/app/company/[symbol]/page.tsx");
    const implementationNotes = [
      read("src/pipeline/dataBundle.ts"),
      read("src/providers/fmp.ts"),
    ].join("\n");

    for (const copy of [home, settings]) {
      expect(copy.toLowerCase()).toContain("synthetic fixture mode");
      expect(copy).toContain("/company/DEMO");
      expect(copy).toContain("DBNK");
      expect(copy.toLowerCase()).toContain("no current market data");
    }
    expect(company).toContain("/company/DEMO");
    expect(company).not.toContain("/company/AAPL");
    expect(implementationNotes).toContain("synthetic contract fixtures");

    const syntheticFiles = publicFiles().filter(
      (file) => file.startsWith("fixtures/fmp/") || file.startsWith("fixtures/report/"),
    );
    const syntheticText = syntheticFiles.map((file) => read(file)).join("\n");
    expect(syntheticText).not.toMatch(
      /Apple Inc\.|\bAAPL\b|Timothy D\. Cook|Cupertino|0000320193|416[,.]?161|182[,.]?447|232\.8|verbatim (sample|response)/i,
    );
  });

  it("publishes only the explicitly synthetic report fixture", () => {
    const reportFixtures = publicFiles().filter((file) =>
      file.startsWith("fixtures/report/"),
    );

    expect(reportFixtures).toEqual(["fixtures/report/DEMO-sample.json"]);
  });
});
