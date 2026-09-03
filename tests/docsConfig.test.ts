/**
 * The generated configuration and commands blocks (scripts/docs-config.mjs).
 * Pure functions only: importing the script runs no main(), so nothing reads
 * the README or the network here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "docs-config.mjs");

interface ConfigModule {
  CONFIG_BEGIN: string;
  CONFIG_END: string;
  COMMANDS_BEGIN: string;
  COMMANDS_END: string;
  COMMAND_DESCRIPTIONS: Record<string, string>;
  INTERNAL_COMMANDS: Set<string>;
  parseEnvExample(text: string): Array<{ title: string; entries: Array<{ key: string; value: string; optIn: boolean; comment: string[] }> }>;
  envSchemaKeys(source: string): string[];
  summarize(comment: string[]): string;
  renderConfigBlock(sections: unknown, schemaKeys: string[]): string;
  renderCommandsBlock(scripts: Record<string, string>): string;
  replaceBlock(readme: string, block: string, begin: string, end: string): string;
}

async function load(): Promise<ConfigModule> {
  return (await import(pathToFileURL(SCRIPT).href)) as ConfigModule;
}

const ROOT = process.cwd();
const envExample = (): string => readFileSync(path.join(ROOT, ".env.example"), "utf8");
const envSource = (): string => readFileSync(path.join(ROOT, "src", "config", "env.ts"), "utf8");
const packageScripts = (): Record<string, string> =>
  (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

describe("the generated configuration block", () => {
  it("reads every key out of .env.example, keeping its section, default and opt-in state", async () => {
    const { parseEnvExample } = await load();
    const sections = parseEnvExample(envExample());
    const keys = sections.flatMap((section) => section.entries.map((entry) => entry.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("FMP_API_KEY");
    expect(keys).toContain("THESIS_STATEMENT_SOURCE");
    const statementSource = sections
      .flatMap((section) => section.entries)
      .find((entry) => entry.key === "THESIS_STATEMENT_SOURCE")!;
    expect(statementSource.value).toBe("auto");
    expect(statementSource.optIn).toBe(false);
    expect(statementSource.comment.join(" ")).toContain("EDGAR");
  });

  it("treats a commented-out key as opt in rather than as prose", async () => {
    const { parseEnvExample } = await load();
    const sections = parseEnvExample(
      "# --- Section ---------------------------------------------------------------\n" +
        "# Turn the thing on.\n# THESIS_SOMETHING=1\n",
    );
    expect(sections).toEqual([
      {
        title: "Section",
        entries: [{ key: "THESIS_SOMETHING", value: "1", optIn: true, comment: ["Turn the thing on."] }],
      },
    ]);
  });

  it("lists exactly the keys the schema validates, and finds them all documented", async () => {
    const { envSchemaKeys, renderConfigBlock, parseEnvExample, CONFIG_BEGIN } = await load();
    const keys = envSchemaKeys(envSource());
    expect(keys).toContain("ANTHROPIC_API_KEY");
    expect(keys).toContain("THESIS_MAX_ACTIVE_LLM_CALLS");
    // Read where it is used rather than validated at startup, so it must not
    // appear in the schema list.
    expect(keys).not.toContain("EDGAR_CONTACT");
    const block = renderConfigBlock(parseEnvExample(envExample()), keys);
    expect(block.startsWith(CONFIG_BEGIN)).toBe(true);
    for (const key of keys) expect(block).toContain(`\`${key}\``);
  });

  it("refuses to render when a validated key is undocumented", async () => {
    const { renderConfigBlock, parseEnvExample } = await load();
    const sections = parseEnvExample("# --- Section ---\n# A key.\nTHESIS_KNOWN=1\n");
    expect(() => renderConfigBlock(sections, ["THESIS_KNOWN", "THESIS_MISSING"])).toThrow(
      /documents no THESIS_MISSING/,
    );
  });

  it("summarizes a comment to its first sentence and escapes a pipe", async () => {
    const { summarize } = await load();
    expect(summarize(["One thing. Another thing."])).toBe("One thing.");
    expect(summarize(["low | medium | high."])).toBe("low \\| medium \\| high.");
    expect(summarize([])).toBe("");
  });
});

describe("the generated commands block", () => {
  it("describes every user-facing npm script and nothing that does not exist", async () => {
    const { renderCommandsBlock, COMMAND_DESCRIPTIONS, INTERNAL_COMMANDS, COMMANDS_END } = await load();
    const scripts = packageScripts();
    const block = renderCommandsBlock(scripts);
    for (const name of Object.keys(scripts)) {
      if (INTERNAL_COMMANDS.has(name)) {
        expect(block).not.toContain(`\`npm run ${name}\``);
        continue;
      }
      expect(COMMAND_DESCRIPTIONS[name]).toBeTypeOf("string");
      expect(block).toContain(`\`npm run ${name}\``);
    }
    expect(block.trimEnd().endsWith(COMMANDS_END)).toBe(true);
  });

  it("refuses an undescribed script and a description with no script", async () => {
    const { renderCommandsBlock } = await load();
    expect(() => renderCommandsBlock({ ...packageScripts(), "brand:new": "node nothing.mjs" })).toThrow(
      /describes no brand:new/,
    );
    const withoutTest = { ...packageScripts() };
    delete withoutTest.test;
    expect(() => renderCommandsBlock(withoutTest)).toThrow(/describes test, which package.json no longer defines/);
  });
});

describe("block replacement", () => {
  it("replaces only the marked block and refuses a README without markers", async () => {
    const { replaceBlock, CONFIG_BEGIN, CONFIG_END } = await load();
    const readme = `# Thesis\n\nbefore\n\n${CONFIG_BEGIN}\nstale\n${CONFIG_END}\n\nafter\n`;
    const rewritten = replaceBlock(readme, `${CONFIG_BEGIN}\nfresh\n${CONFIG_END}`, CONFIG_BEGIN, CONFIG_END);
    expect(rewritten).toContain("fresh");
    expect(rewritten).not.toContain("stale");
    expect(rewritten.endsWith("\n\nafter\n")).toBe(true);
    expect(() => replaceBlock("# Thesis\n", "x", CONFIG_BEGIN, CONFIG_END)).toThrow(/missing the/);
  });
});
