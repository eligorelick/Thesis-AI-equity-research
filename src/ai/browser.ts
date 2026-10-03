import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function chromeExecutable(): string | null {
  if (process.platform === "win32") {
    for (const base of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      const candidate = path.join(base, "Google", "Chrome", "Application", "chrome.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  for (const base of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      const candidate = path.join(base, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export async function openChrome(url: string): Promise<boolean> {
  const executable = chromeExecutable();
  if (!executable) return false;
  return new Promise((resolve) => {
    const child = spawn(executable, [url], { detached: true, stdio: "ignore", windowsHide: true, shell: false });
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref(); resolve(true); });
  });
}
