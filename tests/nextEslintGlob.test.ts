import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const fixture = mkdtempSync(path.join(os.tmpdir(), "thesis-eslint-roots-"));
const directories = ["pages", "apps", "apps/alpha", "apps/alpha/pages", "apps/alpha/nested", "apps/alpha/nested/pages", "apps/beta", "apps/beta/src", "apps/beta/src/pages", "apps/.hidden", "apps/.hidden/pages"];
for (const dir of directories) mkdirSync(path.join(fixture, dir), { recursive: true });
for (const [dir, route] of [["pages", "default"], ["apps/alpha/pages", "alpha"], ["apps/alpha/nested/pages", "nested"], ["apps/beta/src/pages", "beta"], ["apps/.hidden/pages", "hidden"]]) {
  writeFileSync(path.join(fixture, dir, `${route}.tsx`), "export default function Page() { return null; }");
}
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function probe(operation: string, value?: unknown): unknown {
  const script = `
    const {createRequire}=require('node:module');
    const req=createRequire(process.argv[1]+'/package.json');
    const pluginFile=req.resolve('@next/eslint-plugin-next');
    const pluginRequire=createRequire(pluginFile);
    const glob=pluginRequire('fast-glob');
    const value=JSON.parse(process.argv[3]);
    if(process.argv[2]==='glob') {
      try { console.log(JSON.stringify({matches:glob.globSync(value,{onlyDirectories:true}).sort()})); }
      catch(error) { console.log(JSON.stringify({error:error.message})); }
    } else if(process.argv[2]==='api') {
      const errors=[];
      for(const args of [[['apps/*'],{onlyDirectories:true}],['apps/*',{}],['apps/*',{onlyDirectories:true,dot:true}]]) {
        try {glob.globSync(...args);errors.push(null);}catch(error){errors.push(error.message);}
      }
      console.log(JSON.stringify({keys:Object.keys(glob),errors}));
    } else {
      const {Linter}=req('eslint');
      const plugin=req('@next/eslint-plugin-next');
      const settings=value===null?{}:{next:{rootDir:value}};
      const messages=new Linter({cwd:process.cwd()}).verify(
        'const View=()=> <><a href="/default">d</a><a href="/alpha">a</a><a href="/beta">b</a><a href="/nested">n</a><a href="/hidden">h</a></>;',
        {languageOptions:{parserOptions:{ecmaVersion:2022,sourceType:'module',ecmaFeatures:{jsx:true}}},plugins:{next:plugin},settings,rules:{'next/no-html-link-for-pages':'error'}}
      );
      console.log(JSON.stringify(messages.map(message=>message.message)));
    }
  `;
  return JSON.parse(execFileSync(process.execPath, ["-e", script, ROOT, operation, JSON.stringify(value ?? null)], { cwd: fixture, encoding: "utf8" }));
}

describe("scoped Next ESLint directory glob migration", () => {
  // Captured from fast-glob 3.3.1 using this fixture before dependency migration.
  it.each([
    ["apps/alpha", ["apps/alpha"]],
    ["./apps/alpha/", ["./apps/alpha/"]],
    ["apps/*", ["apps/alpha", "apps/beta"]],
    ["apps/a*", ["apps/alpha"]],
    ["apps/*/*", ["apps/alpha/nested", "apps/alpha/pages", "apps/beta/src"]],
    ["apps/**", directories.filter((dir) => dir.startsWith("apps/") && !dir.includes(".hidden"))],
    ["apps/*/**", directories.filter((dir) => dir.startsWith("apps/") && !dir.includes(".hidden"))],
    ["missing/*", []],
    ["!apps/**", []],
    ["apps/alpha/pages/alpha.tsx", []],
  ])("preserves directory matches for %s", (pattern, expected) => {
    expect(probe("glob", pattern)).toEqual({ matches: [...expected].sort() });
  });

  it("preserves absolute paths", () => {
    const absolute = fixture.replaceAll("\\", "/");
    expect(probe("glob", `${absolute}/apps/*`)).toEqual({ matches: [`${absolute}/apps/alpha`, `${absolute}/apps/beta`] });
  });

  it.each(["apps/{alpha,beta}/**", "apps/{alpha/**,beta/**}/*", "apps/!(beta)", "apps/[ab]*", "apps/**/**", "apps/**/pages"])("fails clearly for unsupported pattern %s", (pattern) => {
    expect(probe("glob", pattern)).toEqual({ error: expect.stringContaining("Unsupported Next ESLint rootDir pattern") });
  });

  it("exposes only its supported API and rejects other options", () => {
    expect(probe("api")).toEqual({ keys: ["globSync"], errors: Array(3).fill(expect.stringContaining("Next ESLint globSync requires")) });
  });

  it.each([
    [null, ["default"]],
    ["apps/alpha", ["alpha"]],
    ["apps/*", ["alpha", "beta"]],
    ["apps/**", ["alpha", "beta", "nested"]],
    ["apps/*/**", ["alpha", "beta", "nested"]],
    [["apps/alpha", "apps/beta", 123], ["alpha", "beta"]],
    [path.join(fixture, "apps", "alpha"), ["alpha"]],
    [path.join(fixture, "apps", "*").replaceAll("/", "\\"), ["alpha", "beta"]],
    ["missing/*", []],
  ])("keeps the actual Next internal-link rule active for rootDir %j", (rootDir, routes) => {
    const messages = probe("lint", rootDir) as string[];
    expect(messages).toHaveLength(routes.length);
    for (const route of routes) expect(messages).toEqual(expect.arrayContaining([expect.stringContaining(`navigate to \`/${route}/\``)]));
  });

  it("installs a genuinely distinct scoped package and removes the vulnerable chain", () => {
    const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
    const entries = Object.entries(lock.packages) as Array<[string, { name?: string; resolved?: string }]>;
    expect(entries.some(([key, entry]) => key.endsWith("/node_modules/fast-glob") && entry.resolved === "scripts/next-eslint-glob")).toBe(true);
    expect(entries.filter(([key]) => /(?:^|\/)node_modules\/(?:braces|micromatch)$/.test(key))).toEqual([]);
  });
});
