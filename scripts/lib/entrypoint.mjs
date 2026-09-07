/**
 * "Am I the entry point?" for the scripts in this directory.
 *
 * Every script here exports its pure functions for the tests and runs its
 * main() only when invoked directly. The usual test — compare `import.meta.url`
 * with `pathToFileURL(process.argv[1])` — is wrong on a symlinked checkout:
 * Node resolves symlinks when it builds `import.meta.url` (unless
 * `--preserve-symlinks-main` is set) while `process.argv[1]` is the path as
 * typed, so through macOS's /tmp, a CI cache or a Windows junction the two
 * never match, main() is skipped and the script exits 0 having done nothing.
 * For `npm run check:dependencies` and `npm run audit:security` that is a
 * release gate silently passing (audit 2026-09-06, §5).
 *
 * Both spellings of argv[1] are accepted — as typed, and with symlinks
 * resolved — so the check holds under either symlink mode.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @param {string} moduleUrl the calling module's `import.meta.url`
 * @param {string | undefined} argv1 the script path Node was started with
 * @returns {boolean}
 */
export function isEntryPoint(moduleUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const resolved = path.resolve(argv1);
  if (pathToFileURL(resolved).href === moduleUrl) return true;
  let real;
  try {
    real = realpathSync(resolved);
  } catch {
    return false;
  }
  return pathToFileURL(real).href === moduleUrl;
}
