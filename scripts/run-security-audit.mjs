import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

class SecurityAuditFailure extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "SecurityAuditFailure";
    this.exitCode = exitCode;
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
  return value;
}

export function runSecurityAudit({
  npmExecPath,
  runNpm = spawnSync,
  cwd,
  stdio = "inherit",
}) {
  const result = runNpm(
    process.execPath,
    [npmExecPath, "audit", "--include=dev", "--audit-level=low"],
    { cwd, encoding: "utf8", stdio },
  );
  if (result.error) {
    throw new SecurityAuditFailure(`npm audit failed: ${result.error.message}`, 1);
  }
  if (result.status === 0) return;

  const exitCode =
    typeof result.status === "number" && result.status > 0 ? result.status : 1;
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  throw new SecurityAuditFailure(
    `npm audit failed${detail ? `: ${detail}` : ""}`,
    exitCode,
  );
}

export function main() {
  runSecurityAudit({
    npmExecPath: resolveNpmExecPath(process.env.npm_execpath),
    cwd: process.cwd(),
  });
}

// Node resolves symlinks when it builds `import.meta.url`, so comparing it to a
// merely path.resolve()d argv[1] fails whenever the checkout is reached through
// a symlink or junction (CI caches, macOS /tmp). This gate must never silently
// no-op and exit 0, so resolve argv[1] the same way before comparing.
function realpathOrSelf(target) {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathOrSelf(path.resolve(process.argv[1]))).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode =
      error instanceof SecurityAuditFailure ? error.exitCode : 1;
  }
}
