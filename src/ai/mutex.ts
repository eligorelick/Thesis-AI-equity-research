import "server-only";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";

// This database contains only a format marker. Credentials remain in the v1
// protected JSON envelope. Keep the canonical inode for the lifetime of the
// installation: deleting/replacing it would split cooperating lock owners.
const APPLICATION_ID = 0x54484149;
const VERSION = 1;
const MIGRATION = "AI credential locking uses an incompatible or damaged lock file. Stop all Thesis servers, then remove only the old connections.lock file and restart. Keep connections.v1.json and Gemini directories. Do not remove a lock file while any Thesis server is running.";

function initialize(lock: string): void {
  if (fs.existsSync(lock)) return;
  const temporary = `${lock}.${randomUUID()}.tmp`;
  let database: Database.Database | undefined;
  try {
    database = new Database(temporary, { timeout: 0 });
    database.exec(`BEGIN IMMEDIATE; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${VERSION}; COMMIT;`);
    database.close();
    database = undefined;
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    // Publish a complete, closed database exclusively. Never initialize an
    // existing zero-byte file: it could be a legacy writer's partial lock.
    try { fs.linkSync(temporary, lock); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    try { database?.close(); } catch { /* preserve initialization failure */ }
    // On Windows a contender can open the canonical hard link before this
    // unlink and deny DELETE sharing. A harmless marker-only alias may remain.
    // Never open/read/close the alias after publication (POSIX lock hazard).
    try { fs.unlinkSync(temporary); } catch { /* safe orphan, never remove canonical */ }
  }
}

function storageError(error: unknown): unknown {
  const code = (error as { code?: string } | null)?.code;
  return code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT" ? new Error(MIGRATION) : error;
}

/** Native OS locks serialize async work and release automatically on process exit.
 * The parent directory must already be private. Never unlink this lock path.
 */
export async function withAiMutex<T>(lock: string, fn: () => Promise<T> | T, waitMs = 40_000): Promise<T> {
  initialize(lock);
  let database: Database.Database;
  try { database = new Database(lock, { timeout: 0, fileMustExist: true }); }
  catch (error) { throw storageError(error); }
  let acquired = false;
  let completed = false;
  try {
    const started = Date.now();
    for (;;) {
      try { database.exec("BEGIN IMMEDIATE"); acquired = true; break; }
      catch (error) {
        if ((error as { code?: string }).code !== "SQLITE_BUSY") throw storageError(error);
        if (Date.now() - started >= waitMs) throw new Error("AI credentials are busy; retry shortly");
        // SQLite's synchronous busy timeout would block the async owner in
        // this process. Retry without blocking the event loop instead.
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, waitMs - (Date.now() - started))));
      }
    }
    if (database.pragma("application_id", { simple: true }) !== APPLICATION_ID
      || database.pragma("user_version", { simple: true }) !== VERSION) throw new Error(MIGRATION);
    const result = await fn();
    completed = true;
    return result;
  } finally {
    let releaseError: unknown;
    try { if (acquired) database.exec("ROLLBACK"); } catch (error) { releaseError = error; }
    try { database.close(); } catch (error) { releaseError ??= error; }
    // Keep callback/storage failures primary, but surface failure to release
    // after otherwise successful work. Never retry the callback.
    if (completed && releaseError) throw releaseError;
  }
}
