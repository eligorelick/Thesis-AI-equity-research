import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const APPROVED_VERSIONS = {
  next: ["16.3.0"],
  "eslint-config-next": ["16.3.0"],
  postcss: ["8.5.26"],
  sharp: ["0.35.3"],
  "js-yaml": ["4.3.1"],
  "brace-expansion": ["1.1.18", "5.0.9"],
};

const TARGET_NAMES = Object.keys(APPROVED_VERSIONS);
const AUDITED_NPM_PACKAGES = [
  "next",
  "eslint-config-next",
  "postcss",
  "sharp",
  "brace-expansion",
  "js-yaml",
];

function emptyVersionSets() {
  return Object.fromEntries(TARGET_NAMES.map((name) => [name, new Set()]));
}

function sortedVersionRecord(versionSets) {
  return Object.fromEntries(
    TARGET_NAMES.map((name) => [name, [...versionSets[name]].sort()]),
  );
}

function objectRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

export function collectLockVersions(lock) {
  const lockRecord = objectRecord(lock, "lock");
  const packages = objectRecord(lockRecord.packages, "lock packages");
  const versions = emptyVersionSets();

  for (const [packagePath, rawEntry] of Object.entries(packages)) {
    const name = TARGET_NAMES.find(
      (candidate) =>
        packagePath === `node_modules/${candidate}` ||
        packagePath.endsWith(`/node_modules/${candidate}`),
    );
    if (!name) continue;
    const entry = objectRecord(rawEntry, `lock entry ${packagePath}`);
    if (typeof entry.version !== "string" || entry.version.length === 0) {
      throw new Error(`lock ${name} entry is missing a version`);
    }
    versions[name].add(entry.version);
  }

  return sortedVersionRecord(versions);
}

export function collectInstalledVersions(tree) {
  const root = objectRecord(tree, "npm tree");
  const versions = emptyVersionSets();

  function visit(node, location) {
    const record = objectRecord(node, `npm tree node ${location}`);
    if (Array.isArray(record.problems) && record.problems.length > 0) {
      throw new Error(`npm tree problems: ${record.problems.join("; ")}`);
    }
    if (record.dependencies === undefined) return;
    const dependencies = objectRecord(
      record.dependencies,
      `npm tree dependencies ${location}`,
    );
    for (const [name, rawDependency] of Object.entries(dependencies)) {
      const dependency = objectRecord(
        rawDependency,
        `npm tree dependency ${location}/${name}`,
      );
      if (Object.hasOwn(APPROVED_VERSIONS, name)) {
        if (
          typeof dependency.version !== "string" ||
          dependency.version.length === 0
        ) {
          throw new Error(`npm tree ${name} dependency is missing a version`);
        }
        versions[name].add(dependency.version);
      }
      visit(dependency, `${location}/${name}`);
    }
  }

  visit(root, "root");
  return sortedVersionRecord(versions);
}

export function validateExactVersions(
  actual,
  expected = APPROVED_VERSIONS,
  label = "lock",
) {
  const names = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const name of names) {
    const observed = [...(actual[name] ?? [])].sort();
    const approved = [...(expected[name] ?? [])].sort();
    if (JSON.stringify(observed) !== JSON.stringify(approved)) {
      throw new Error(
        `${label} ${name} versions [${observed.join(", ")}] do not match approved [${approved.join(", ")}]`,
      );
    }
  }
}

export function resolveNpmExecPath(value) {
  if (!value) throw new Error("npm_execpath is missing");
  if (!path.isAbsolute(value)) {
    throw new Error("npm_execpath must be an absolute path");
  }
  let isFile = false;
  try {
    isFile = statSync(value).isFile();
  } catch {
    // Use the single actionable diagnostic below.
  }
  if (!isFile) throw new Error("npm_execpath must name an existing file");
  if (!/^(?:npm|npm-cli|npx|npx-cli)\.(?:js|cjs|mjs)$/i.test(path.basename(value))) {
    throw new Error("npm_execpath must name an npm CLI file");
  }
  return value;
}

export function runDependencyShape({
  root,
  lockPath,
  npmExecPath,
  runNpm = spawnSync,
}) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read dependency lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateExactVersions(collectLockVersions(lock), APPROVED_VERSIONS, "lock");

  const args = [
    npmExecPath,
    "ls",
    ...AUDITED_NPM_PACKAGES,
    "--all",
    "--json",
    "--include=dev",
  ];
  const result = runNpm(process.execPath, args, { cwd: root, encoding: "utf8" });
  if (result.error) {
    throw new Error(`npm ls failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim();
    throw new Error(`npm ls failed${detail ? `: ${detail}` : ""}`);
  }

  let tree;
  try {
    tree = JSON.parse(result.stdout ?? "");
  } catch (error) {
    throw new Error(
      `npm ls returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateExactVersions(
    collectInstalledVersions(tree),
    APPROVED_VERSIONS,
    "installed tree",
  );
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value) throw new Error(`Missing ${name} value`);
  return value;
}

export function main(argv = process.argv.slice(2)) {
  const root = process.cwd();
  const lockPath = path.resolve(argument(argv, "--lockfile") ?? path.join(root, "package-lock.json"));
  const npmExecPath = resolveNpmExecPath(process.env.npm_execpath);
  runDependencyShape({ root, lockPath, npmExecPath });
  process.stdout.write("dependency shape verified\n");
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
