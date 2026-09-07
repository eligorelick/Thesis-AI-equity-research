/**
 * scripts/lib/entrypoint.mjs — the "am I the entry point?" test every script
 * in scripts/ runs its main() behind.
 *
 * Audit 2026-09-06 (§5): `import.meta.url` has symlinks resolved and
 * `process.argv[1]` does not, so on a symlinked checkout the plain comparison
 * every script used skipped main() and exited 0 — for the two release gates
 * (`check:dependencies`, `audit:security`) a silent pass. The linked-directory
 * case is exercised for real here: Windows lets an unprivileged user create a
 * directory junction, and a symlink elsewhere behaves the same way.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HELPER = path.join(process.cwd(), "scripts", "lib", "entrypoint.mjs");

interface EntrypointModule {
  isEntryPoint(moduleUrl: string, argv1?: string): boolean;
}

async function load(): Promise<EntrypointModule> {
  return (await import(pathToFileURL(HELPER).href)) as EntrypointModule;
}

describe("scripts/lib/entrypoint.mjs isEntryPoint", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "thesis-entrypoint-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("matches the module URL to argv[1] as typed, absolute or relative", async () => {
    const { isEntryPoint } = await load();
    const script = path.join(root, "tool.mjs");
    writeFileSync(script, "export {};\n");
    const moduleUrl = pathToFileURL(script).href;
    expect(isEntryPoint(moduleUrl, script)).toBe(true);
    expect(isEntryPoint(moduleUrl, path.relative(process.cwd(), script))).toBe(true);
  });

  it("is false for another file, a missing argv[1] and a path that does not exist", async () => {
    const { isEntryPoint } = await load();
    const script = path.join(root, "tool.mjs");
    const other = path.join(root, "other.mjs");
    writeFileSync(script, "export {};\n");
    writeFileSync(other, "export {};\n");
    const moduleUrl = pathToFileURL(script).href;
    expect(isEntryPoint(moduleUrl, other)).toBe(false);
    expect(isEntryPoint(moduleUrl, undefined)).toBe(false);
    expect(isEntryPoint(moduleUrl, "")).toBe(false);
    expect(isEntryPoint(moduleUrl, path.join(root, "missing.mjs"))).toBe(false);
  });

  it("recognises the script when argv[1] reaches it through a linked directory", async () => {
    const { isEntryPoint } = await load();
    const realDir = path.join(root, "real");
    const linkDir = path.join(root, "link");
    mkdirSync(realDir);
    const script = path.join(realDir, "tool.mjs");
    writeFileSync(script, "export {};\n");
    try {
      symlinkSync(realDir, linkDir, "junction");
    } catch (error) {
      // A platform that refuses links for this user cannot exercise the case;
      // say so rather than passing vacuously.
      throw new Error(`cannot create a symlink/junction here: ${String(error)}`);
    }
    // Node resolves the main module's symlinks, so the module URL is the REAL
    // path while the operator typed the linked one.
    const moduleUrl = pathToFileURL(script).href;
    const typed = path.join(linkDir, "tool.mjs");
    expect(pathToFileURL(typed).href).not.toBe(moduleUrl);
    expect(isEntryPoint(moduleUrl, typed)).toBe(true);
    // The reverse (`--preserve-symlinks-main`): the module URL is the linked
    // path and so is argv[1].
    expect(isEntryPoint(pathToFileURL(typed).href, typed)).toBe(true);
  });
});
