/**
 * Generate the README's configuration and commands tables from the files that
 * define them, so the README cannot document a key that does not exist or miss
 * one that does.
 *
 *   npm run docs:config             # print the blocks
 *   npm run docs:config -- --write  # rewrite the marked README blocks
 *
 * Sources of truth: `.env.example` for the keys, their defaults and what each
 * one does; `src/config/env.ts` for which keys are actually validated at
 * startup; `package.json` for the commands. Two contracts fall out and the
 * doc-lint test enforces both:
 *
 *   - every key the schema validates is documented in `.env.example`; and
 *   - every npm script a user is meant to run has a description here.
 *
 * No network, no provider call.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, "..");
export const README_PATH = path.join(ROOT, "README.md");
export const CONFIG_BEGIN = "<!-- BEGIN GENERATED: config -->";
export const CONFIG_END = "<!-- END GENERATED: config -->";
export const COMMANDS_BEGIN = "<!-- BEGIN GENERATED: commands -->";
export const COMMANDS_END = "<!-- END GENERATED: commands -->";

/**
 * One line per command a reader is meant to type. A script with no entry here
 * fails the build rather than shipping undocumented, and an entry naming a
 * script that no longer exists fails too.
 */
export const COMMAND_DESCRIPTIONS = {
  dev: "Run the app on 127.0.0.1 in development.",
  build: "Production build.",
  start: "Serve the production build on 127.0.0.1.",
  typecheck: "Type-check without emitting.",
  lint: "ESLint over the repository.",
  test: "The product test suite. Fully offline whatever .env holds.",
  "test:integration": "The database CLI suite, which runs in its own process.",
  "test:coverage": "Both coverage contracts, core and risk.",
  "test:watch": "The product suite in watch mode.",
  verify: "Everything the release gate runs, in order.",
  "db:push": "Apply the Drizzle schema to the configured database.",
  "settings:reset": "Delete stored settings rows so .env takes precedence again. Needs --yes.",
  "models:refresh": "Diff config/models.json against the published model list and prices. Sends no model request.",
  "costs:reconcile": "Lower presumed spend rows against the Usage and Cost API. Needs ANTHROPIC_ADMIN_KEY.",
  "docs:pricing": "Regenerate the README's cost table from the model registry.",
  "docs:config": "Regenerate the README's configuration and commands tables.",
  "audit:deltas": "Refresh the audited fixture comparison's intended-delta list.",
  "audit:security": "Dependency audit at the release threshold.",
  "check:dependencies": "Assert the dependency tree's shape.",
  "export:corrected": "Write a corrected report export from a stored run.",
};

/** Commands that exist for the suite's own plumbing and are not user-facing. */
export const INTERNAL_COMMANDS = new Set([
  "test:product",
  "test:coverage:core",
  "test:coverage:risk",
]);

/**
 * Parse `.env.example` into sections of documented keys.
 *
 * Two rules matter, and both come from how the file is actually written. A
 * comment block describes the key it sits directly above: a blank line between
 * them means the block is a note about the section, not about the next key. And
 * a key with no block of its own shares the one above its neighbour, which is
 * how the paired keys are written (the two concurrency caps, the two spend
 * caps, the two lease TTLs, the two database overrides).
 */
export function parseEnvExample(text) {
  const sections = [];
  let section = null;
  let comment = [];
  let adjacent = false;
  let inherited = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const sectionMatch = /^#\s*---+\s*(.+?)\s*-{3,}\s*$/.exec(line);
    if (sectionMatch) {
      section = { title: sectionMatch[1], entries: [] };
      sections.push(section);
      comment = [];
      adjacent = false;
      inherited = [];
      continue;
    }
    if (line.length === 0) {
      comment = [];
      adjacent = false;
      continue;
    }
    const commentedKey = /^#\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    const liveKey = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (line.startsWith("#") && commentedKey === null) {
      comment.push(line.replace(/^#\s?/, ""));
      adjacent = true;
      continue;
    }
    const match = liveKey ?? commentedKey;
    if (match === null) continue;
    const own = adjacent && comment.length > 0 ? [...comment] : [];
    if (own.length > 0) inherited = own;
    const entry = {
      key: match[1],
      value: match[2].trim(),
      optIn: liveKey === null,
      comment: own.length > 0 ? own : [...inherited],
    };
    comment = [];
    adjacent = false;
    if (section === null) {
      section = { title: "Configuration", entries: [] };
      sections.push(section);
    }
    section.entries.push(entry);
  }
  return sections.filter((entry) => entry.entries.length > 0);
}

/** The keys `src/config/env.ts` actually validates at startup. */
export function envSchemaKeys(source) {
  const start = source.indexOf("const envSchema = z.object({");
  if (start < 0) throw new Error("src/config/env.ts no longer declares `const envSchema = z.object({`");
  const end = source.indexOf("\n}).superRefine(", start);
  if (end < 0) throw new Error("src/config/env.ts no longer closes envSchema with .superRefine");
  const body = source.slice(start, end);
  const keys = [];
  for (const line of body.split("\n")) {
    const match = /^ {2}([A-Z][A-Z0-9_]*):/.exec(line);
    if (match !== null) keys.push(match[1]);
  }
  if (keys.length === 0) throw new Error("no environment keys found in envSchema");
  return keys;
}

/** First sentence of a key's comment, flattened to one table cell. */
export function summarize(comment) {
  const prose = comment
    .filter((line) => !/^\s{2,}/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (prose.length === 0) return "";
  const sentence = /^(.+?[.;])(\s|$)/.exec(prose);
  return (sentence === null ? prose : sentence[1]).replace(/\|/g, "\\|");
}

export function renderConfigBlock(sections, schemaKeys) {
  const documented = new Set(sections.flatMap((section) => section.entries.map((entry) => entry.key)));
  const undocumented = schemaKeys.filter((key) => !documented.has(key));
  if (undocumented.length > 0) {
    throw new Error(`.env.example documents no ${undocumented.join(", ")}; every validated key must appear there`);
  }
  const lines = [CONFIG_BEGIN, ""];
  lines.push("Every key is optional. `.env.example` carries the long form of each one;");
  lines.push("this table is generated from it, so the two cannot drift apart.");
  lines.push("");
  lines.push("| Key | Default | What it does |");
  lines.push("| --- | --- | --- |");
  for (const section of sections) {
    for (const entry of section.entries) {
      const shown = entry.value.length > 0 ? `\`${entry.value}\`` : "unset";
      const optIn = entry.optIn ? " (opt in)" : "";
      lines.push(`| \`${entry.key}\` | ${shown}${optIn} | ${summarize(entry.comment)} |`);
    }
  }
  lines.push("");
  lines.push(CONFIG_END);
  return lines.join("\n");
}

export function renderCommandsBlock(scripts) {
  const names = Object.keys(scripts).filter((name) => !INTERNAL_COMMANDS.has(name));
  const missing = names.filter((name) => COMMAND_DESCRIPTIONS[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`scripts/docs-config.mjs describes no ${missing.join(", ")}; add a line or mark it internal`);
  }
  const stale = Object.keys(COMMAND_DESCRIPTIONS).filter((name) => scripts[name] === undefined);
  if (stale.length > 0) {
    throw new Error(`scripts/docs-config.mjs describes ${stale.join(", ")}, which package.json no longer defines`);
  }
  const lines = [COMMANDS_BEGIN, ""];
  lines.push("| Command | What it does |");
  lines.push("| --- | --- |");
  for (const name of names) {
    lines.push(`| \`npm run ${name}\` | ${COMMAND_DESCRIPTIONS[name]} |`);
  }
  lines.push("");
  lines.push(COMMANDS_END);
  return lines.join("\n");
}

export function replaceBlock(readme, block, begin, end) {
  const from = readme.indexOf(begin);
  const to = readme.indexOf(end);
  if (from < 0 || to < 0) throw new Error(`README is missing the ${begin} / ${end} markers`);
  return readme.slice(0, from) + block + readme.slice(to + end.length);
}

async function main(argv) {
  const sections = parseEnvExample(readFileSync(path.join(ROOT, ".env.example"), "utf8"));
  const schemaKeys = envSchemaKeys(readFileSync(path.join(ROOT, "src", "config", "env.ts"), "utf8"));
  const scripts = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  const config = renderConfigBlock(sections, schemaKeys);
  const commands = renderCommandsBlock(scripts);

  if (!argv.includes("--write")) {
    console.log(config);
    console.log();
    console.log(commands);
    return 0;
  }
  let readme = readFileSync(README_PATH, "utf8");
  readme = replaceBlock(readme, config, CONFIG_BEGIN, CONFIG_END);
  readme = replaceBlock(readme, commands, COMMANDS_BEGIN, COMMANDS_END);
  writeFileSync(README_PATH, readme, "utf8");
  console.log(`docs:config — rewrote the generated blocks in ${README_PATH}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
