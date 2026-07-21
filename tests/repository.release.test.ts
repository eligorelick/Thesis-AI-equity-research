import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const read = (name: string) => readFileSync(path.join(ROOT, name), "utf8");
const publicFiles = () =>
  execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/)
    .filter((file) => file && existsSync(path.join(ROOT, file)))
    .sort();

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
    expect(pkg.scripts).not.toHaveProperty("verify:live");
    expect(pkg.scripts).not.toHaveProperty("verify:tickers");
  });

  it("publishes one self-contained Markdown file and no internal work folders", () => {
    const files = publicFiles();
    const markdown = files.filter((file) => file.toLowerCase().endsWith(".md"));
    const forbidden =
      /(^|\/)(\.github\/|research\/|scripts\/|docs\/|\.env($|\.)|data\/|\.next\/|node_modules\/|coverage\/|\.claude\/|\.superpowers\/|\.playwright-mcp\/|\.worktrees\/)|\.db($|-)|\.tsbuildinfo$/;

    expect(markdown).toEqual(["README.md"]);
    expect(files.filter((file) => forbidden.test(file))).toEqual([
      ".env.example",
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
    const settings = read("src/app/settings/page.tsx");
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
});
