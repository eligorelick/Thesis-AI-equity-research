import "server-only";

import os from "node:os";
import path from "node:path";

/** Default directory for local persistent data; override with THESIS_DATA_DIR. */
export function defaultDataDir(): string {
  const fromEnv = process.env.THESIS_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) return path.join(localAppData, "Thesis");
    const appData = process.env.APPDATA?.trim();
    if (appData) return path.join(appData, "Thesis");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Thesis");
  }

  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) return path.join(xdgDataHome, "thesis");
  return path.join(os.homedir(), ".local", "share", "thesis");
}

export function hasExplicitDbPath(): boolean {
  const fromEnv = process.env.THESIS_DB_PATH;
  return fromEnv !== undefined && fromEnv.trim() !== "";
}

/** Default on-disk location; override with THESIS_DB_PATH. */
export function defaultDbPath(): string {
  // Same trimmed-truthy idiom as defaultDataDir/hasExplicitDbPath: a
  // whitespace-only THESIS_DB_PATH is "not set", never a literal path.
  const fromEnv = process.env.THESIS_DB_PATH?.trim();
  if (fromEnv) return fromEnv;
  return path.join(defaultDataDir(), "thesis.db");
}
