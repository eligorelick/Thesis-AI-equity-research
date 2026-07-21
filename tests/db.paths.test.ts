/**
 * src/db/paths.ts — resolution of the on-disk SQLite location.
 *
 * The module reads process.env and process.platform live (not at import
 * time), so we exercise it through that seam: stub env vars and redefine
 * process.platform for the duration of each test, then restore both.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { defaultDataDir, defaultDbPath, hasExplicitDbPath } from "@/db/paths";

const ENV_KEYS = ["THESIS_DATA_DIR", "THESIS_DB_PATH", "LOCALAPPDATA", "APPDATA", "XDG_DATA_HOME"] as const;

let savedEnv: Record<string, string | undefined>;
let savedPlatform: PropertyDescriptor | undefined;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
});

describe("hasExplicitDbPath", () => {
  it("is false when THESIS_DB_PATH is unset", () => {
    expect(hasExplicitDbPath()).toBe(false);
  });

  it("is false when THESIS_DB_PATH is empty or whitespace-only", () => {
    process.env.THESIS_DB_PATH = "";
    expect(hasExplicitDbPath()).toBe(false);
    process.env.THESIS_DB_PATH = "   ";
    // hasExplicitDbPath trims before comparing, so whitespace-only counts
    // as "not explicitly set" just like the empty string.
    expect(hasExplicitDbPath()).toBe(false);
  });

  it("is true when THESIS_DB_PATH is set to a real path", () => {
    process.env.THESIS_DB_PATH = "C:\\custom\\thesis.db";
    expect(hasExplicitDbPath()).toBe(true);
  });
});

describe("defaultDbPath", () => {
  it("respects THESIS_DB_PATH override verbatim, bypassing defaultDataDir", () => {
    process.env.THESIS_DB_PATH = "D:\\override\\path\\custom.db";
    expect(defaultDbPath()).toBe("D:\\override\\path\\custom.db");
  });

  it("falls back to <defaultDataDir>/thesis.db when THESIS_DB_PATH is unset", () => {
    setPlatform("win32");
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
    expect(defaultDbPath()).toBe(path.join("C:\\Users\\test\\AppData\\Local", "Thesis", "thesis.db"));
  });

  it("treats a whitespace-only THESIS_DB_PATH as unset — consistent with hasExplicitDbPath (fix-review)", () => {
    setPlatform("win32");
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
    process.env.THESIS_DB_PATH = "   ";
    expect(defaultDbPath()).toBe(path.join("C:\\Users\\test\\AppData\\Local", "Thesis", "thesis.db"));
  });
});

describe("defaultDataDir", () => {
  it("respects THESIS_DATA_DIR override on any platform", () => {
    setPlatform("linux");
    process.env.THESIS_DATA_DIR = "/custom/data/dir";
    expect(defaultDataDir()).toBe("/custom/data/dir");
  });

  it("trims whitespace-padded THESIS_DATA_DIR", () => {
    process.env.THESIS_DATA_DIR = "  /padded/dir  ";
    expect(defaultDataDir()).toBe("/padded/dir");
  });

  it("win32: uses LOCALAPPDATA/Thesis when LOCALAPPDATA is set", () => {
    setPlatform("win32");
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
    expect(defaultDataDir()).toBe(path.join("C:\\Users\\test\\AppData\\Local", "Thesis"));
  });

  it("win32: falls back to APPDATA/Thesis when LOCALAPPDATA is unset", () => {
    setPlatform("win32");
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
    expect(defaultDataDir()).toBe(path.join("C:\\Users\\test\\AppData\\Roaming", "Thesis"));
  });

  it("win32: falls through to XDG/home default when neither LOCALAPPDATA nor APPDATA is set", () => {
    setPlatform("win32");
    expect(defaultDataDir()).toBe(path.join(os.homedir(), ".local", "share", "thesis"));
  });

  it("darwin: uses ~/Library/Application Support/Thesis regardless of LOCALAPPDATA/XDG", () => {
    setPlatform("darwin");
    process.env.LOCALAPPDATA = "C:\\should\\be\\ignored";
    process.env.XDG_DATA_HOME = "/should/be/ignored";
    expect(defaultDataDir()).toBe(path.join(os.homedir(), "Library", "Application Support", "Thesis"));
  });

  it("linux: uses XDG_DATA_HOME/thesis when set", () => {
    setPlatform("linux");
    process.env.XDG_DATA_HOME = "/home/test/.local/share";
    expect(defaultDataDir()).toBe(path.join("/home/test/.local/share", "thesis"));
  });

  it("linux: falls back to ~/.local/share/thesis when XDG_DATA_HOME is unset", () => {
    setPlatform("linux");
    expect(defaultDataDir()).toBe(path.join(os.homedir(), ".local", "share", "thesis"));
  });
});
