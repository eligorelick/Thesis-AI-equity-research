import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withAiMutex } from "@/ai/mutex";

type Message = { type: string; index?: number; message?: string; code?: string; published?: boolean };
type Worker = { child: ChildProcess; messages: Message[]; errors: string[] };
let directory: string;
let lock: string;
let scratch: string;
let workers: Worker[];
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "thesis-native-mutex-"));
  lock = path.join(directory, "connections.lock"); scratch = path.join(directory, "scratch.json"); workers = [];
});
async function exited(worker: Worker): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  await new Promise<void>((resolve) => worker.child.once("exit", () => resolve()));
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workers.map(async (worker) => { if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL"); await exited(worker); }));
  fs.rmSync(directory, { recursive: true, force: true });
});
function spawn(mode: string, identity = "worker", iterations = 1): Worker {
  const child = fork(path.resolve("tests/fixtures/aiMutexWorker.mjs"), [lock, scratch, mode, identity, String(iterations)], {
    execArgv: ["--import", "tsx", "--conditions=react-server"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, LOCALAPPDATA: directory, XDG_CONFIG_HOME: directory, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" },
  });
  const worker = { child, messages: [] as Message[], errors: [] as string[] }; workers.push(worker);
  child.on("message", (message) => worker.messages.push(message as Message));
  child.stderr?.on("data", (data) => worker.errors.push(String(data)));
  return worker;
}
async function wait(worker: Worker, type: string): Promise<Message> {
  const started = Date.now();
  for (;;) {
    const message = worker.messages.find((entry) => entry.type === type);
    if (message) return message;
    const failure = worker.messages.find((entry) => entry.type === "failed");
    if (failure && type !== "failed") throw new Error(failure.message);
    if (Date.now() - started > 8_000 || worker.child.exitCode !== null || worker.child.signalCode !== null) throw new Error(`Worker missing ${type}: ${worker.errors.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function go(worker: Worker): Promise<void> { await wait(worker, "ready"); worker.child.send("go"); }
function identity() { const stat = fs.statSync(lock); return { dev: stat.dev, ino: stat.ino }; }

describe("permanent native credential mutex", () => {
  it("keeps one canonical inode and holds ownership across same-process async callbacks", async () => {
    const order: string[] = [];
    let original: ReturnType<typeof identity>;
    await Promise.all([1, 2].map((number) => withAiMutex(lock, async () => {
      order.push(`enter${number}`); original ??= identity();
      await new Promise((resolve) => setTimeout(resolve, 25)); order.push(`leave${number}`);
    })));
    expect(order).toEqual(["enter1", "leave1", "enter2", "leave2"]);
    expect(identity()).toEqual(original!);
    const db = new Database(lock); expect(db.pragma("application_id", { simple: true })).toBe(0x54484149); expect(db.pragma("user_version", { simple: true })).toBe(1); db.close();
    if (process.platform !== "win32") expect(fs.statSync(lock).mode & 0o777).toBe(0o600);
  });
  it("serializes simultaneous native cold-start writers without losing scratch updates", async () => {
    const group = ["a", "b", "c"].map((name) => spawn("update", name, 4));
    await Promise.all(group.map((worker) => wait(worker, "ready")));
    group.forEach((worker) => worker.child.send("go"));
    await Promise.all(group.map((worker) => wait(worker, "done")));
    const state: string[] = JSON.parse(fs.readFileSync(scratch, "utf8"));
    expect(state.sort()).toEqual(["a", "b", "c"].flatMap((name) => [0, 1, 2, 3].map((index) => `${name}:${index}`)));
    const artifacts = fs.readdirSync(directory).filter((file) => file.startsWith("connections.lock"));
    expect(artifacts).toContain("connections.lock");
    // Publication cleanup may leave a harmless closed alias on Windows if a
    // contender's canonical handle denies DELETE sharing. No partial file is
    // ever published at the canonical name.
    for (const artifact of artifacts) expect(artifact === "connections.lock" || /^connections\.lock\.[\da-f-]+\.tmp$/.test(artifact)).toBe(true);
  }, 15_000);
  it("times out without entering a live native owner's callback, then recovers the same inode", async () => {
    const owner = spawn("hold"); await go(owner); await wait(owner, "entered"); const original = identity();
    const contender = spawn("timeout"); await go(contender);
    expect((await wait(contender, "failed")).message).toContain("busy");
    expect(contender.messages.some((message) => message.type === "entered")).toBe(false);
    expect(identity()).toEqual(original);
    owner.child.send("release"); await wait(owner, "done");
    await expect(withAiMutex(lock, () => "retry")).resolves.toBe("retry"); expect(identity()).toEqual(original);
  }, 15_000);
  it.each(["hold", "write-hold"])("recovers a killed native %s owner without replacing the mutex or partial JSON", async (mode) => {
    fs.writeFileSync(scratch, "[]");
    const owner = spawn(mode, "killed"); await go(owner); await wait(owner, mode === "hold" ? "entered" : "written"); const original = identity();
    const survivor = spawn("update", "survivor"); await wait(survivor, "ready"); survivor.child.send("go");
    await new Promise((resolve) => setTimeout(resolve, 100)); expect(survivor.messages.some((message) => message.type === "entered")).toBe(false);
    owner.child.kill("SIGKILL"); await exited(owner); await wait(survivor, "done");
    expect(JSON.parse(fs.readFileSync(scratch, "utf8"))).toEqual(mode === "hold" ? ["survivor:0"] : ["killed:0", "survivor:0"]);
    expect(identity()).toEqual(original);
  }, 15_000);
  it("does not release a native owner's reservation when a closed publication alias is unlinked", async () => {
    const owner = spawn("orphan"); await go(owner); await wait(owner, "entered");
    const alias = fs.readdirSync(directory).find((file) => file.endsWith(".tmp"))!; expect(alias).toBeTruthy();
    let removed = false;
    try { fs.unlinkSync(path.join(directory, alias)); removed = true; }
    catch (error) { expect(process.platform).toBe("win32"); expect(["EACCES", "EPERM"]).toContain((error as NodeJS.ErrnoException).code); }
    const contender = spawn("timeout"); await go(contender); expect((await wait(contender, "failed")).message).toContain("busy");
    expect(contender.messages.some((message) => message.type === "entered")).toBe(false);
    owner.child.send("release"); await wait(owner, "done"); await exited(owner);
    if (!removed) fs.unlinkSync(path.join(directory, alias));
    await expect(withAiMutex(lock, () => "retry")).resolves.toBe("retry");
  }, 15_000);
  it.each(["crash-before-publish", "crash-after-publish"])("recovers initialization %s with no partial canonical publication", async (mode) => {
    const publisher = spawn(mode); await go(publisher); await wait(publisher, "publication");
    expect(fs.existsSync(lock)).toBe(mode === "crash-after-publish");
    publisher.child.kill("SIGKILL"); await exited(publisher);
    const survivor = spawn("update", "survivor"); await go(survivor); await wait(survivor, "done");
    expect(JSON.parse(fs.readFileSync(scratch, "utf8"))).toEqual(["survivor:0"]);
  }, 15_000);
  it("makes a quiescent legacy PID client refuse a new native mutex without deleting it", async () => {
    await withAiMutex(lock, () => {}); const original = identity();
    const legacy = spawn("legacy"); await go(legacy); expect((await wait(legacy, "failed")).message).toContain("busy");
    expect(identity()).toEqual(original); await expect(withAiMutex(lock, () => "retry")).resolves.toBe("retry");
  }, 15_000);
  it.each(["", "12345", String(process.pid), "12", "garbage"])("refuses legacy/partial contents %j before a callback and preserves bytes", async (contents) => {
    fs.writeFileSync(lock, contents); const callback = vi.fn();
    await expect(withAiMutex(lock, callback)).rejects.toThrow("Stop all Thesis servers");
    expect(callback).not.toHaveBeenCalled(); expect(fs.readFileSync(lock, "utf8")).toBe(contents);
  });
  it.each([0, 2])("refuses unrecognized SQLite version %i without rewriting it", async (version) => {
    const db = new Database(lock); db.exec(`PRAGMA application_id = ${version ? 0x54484149 : 0}; PRAGMA user_version = ${version};`); db.close();
    const saved = fs.readFileSync(lock); const callback = vi.fn();
    await expect(withAiMutex(lock, callback)).rejects.toThrow("Stop all Thesis servers"); expect(callback).not.toHaveBeenCalled(); expect(fs.readFileSync(lock)).toEqual(saved);
  });
  it("preserves a native open failure instead of presenting it as legacy migration", async () => {
    fs.mkdirSync(lock); const callback = vi.fn();
    await expect(withAiMutex(lock, callback)).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_CANTOPEN(?:_ISDIR)?$/) });
    expect(callback).not.toHaveBeenCalled(); expect(fs.statSync(lock).isDirectory()).toBe(true);
  });
  it("does not replace an existing winner when publication reports EEXIST", async () => {
    const link = fs.linkSync; let published: ReturnType<typeof identity> | undefined;
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => { link(from, to); published = identity(); throw Object.assign(new Error("winner"), { code: "EEXIST" }); });
    await expect(withAiMutex(lock, () => "done")).resolves.toBe("done"); expect(identity()).toEqual(published);
  });
  it.each(["link", "chmod"])("fails initialization safely when %s fails without publishing a partial mutex", async (operation) => {
    if (operation === "chmod" && process.platform === "win32") return;
    const failure = Object.assign(new Error("initialization denied"), { code: "EPERM" });
    if (operation === "link") vi.spyOn(fs, "linkSync").mockImplementation(() => { throw failure; });
    else vi.spyOn(fs, "chmodSync").mockImplementation(() => { throw failure; });
    const callback = vi.fn(); await expect(withAiMutex(lock, callback)).rejects.toBe(failure); expect(callback).not.toHaveBeenCalled(); expect(fs.existsSync(lock)).toBe(false); expect(fs.readdirSync(directory)).toEqual([]);
  });
  it("preserves callback failures, releases native ownership and does not retry side effects", async () => {
    const failure = new Error("callback failed"); const callback = vi.fn(() => { throw failure; });
    await expect(withAiMutex(lock, callback)).rejects.toBe(failure); expect(callback).toHaveBeenCalledTimes(1);
    const original = identity(); await expect(withAiMutex(lock, () => "retry")).resolves.toBe("retry"); expect(identity()).toEqual(original);
  });
  it("preserves callback errors when rollback fails and still closes the native connection", async () => {
    await withAiMutex(lock, () => {});
    const exec = Database.prototype.exec; const failure = new Error("callback failed");
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql === "ROLLBACK") throw new Error("rollback failed"); return exec.call(this, sql);
    });
    await expect(withAiMutex(lock, () => { throw failure; })).rejects.toBe(failure);
    vi.restoreAllMocks(); await expect(withAiMutex(lock, () => "retry", 200)).resolves.toBe("retry");
  });
  it.each(["initialize", "acquire"])("preserves SQLite I/O failures during %s without running the callback", async (phase) => {
    if (phase === "acquire") await withAiMutex(lock, () => {});
    const failure = Object.assign(new Error("SQLite I/O failed"), { code: "SQLITE_IOERR" });
    vi.spyOn(Database.prototype, "exec").mockImplementation(() => { throw failure; });
    const callback = vi.fn(); await expect(withAiMutex(lock, callback)).rejects.toBe(failure); expect(callback).not.toHaveBeenCalled();
    expect(fs.existsSync(lock)).toBe(phase === "acquire");
  });
  it.each([true, false])("closes ownership and preserves the primary error when close throws (callback fails: %s)", async (callbackFails) => {
    await withAiMutex(lock, () => {});
    const close = Database.prototype.close; const closeError = new Error("close failed"); const callbackError = new Error("callback failed");
    vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) { close.call(this); throw closeError; });
    await expect(withAiMutex(lock, () => { if (callbackFails) throw callbackError; return "success"; })).rejects.toBe(callbackFails ? callbackError : closeError);
    vi.restoreAllMocks(); await expect(withAiMutex(lock, () => "retry", 200)).resolves.toBe("retry");
  });
  it("does not publish a canonical file when initialization close throws", async () => {
    const close = Database.prototype.close; const failure = new Error("initialization close failed");
    vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) { close.call(this); throw failure; });
    const callback = vi.fn(); await expect(withAiMutex(lock, callback)).rejects.toBe(failure); expect(callback).not.toHaveBeenCalled(); expect(fs.existsSync(lock)).toBe(false); expect(fs.readdirSync(directory)).toEqual([]);
  });
  it("surfaces rollback failure after success and releases through close", async () => {
    await withAiMutex(lock, () => {}); const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql === "ROLLBACK") throw new Error("rollback failed"); return exec.call(this, sql);
    });
    await expect(withAiMutex(lock, () => "success")).rejects.toThrow("rollback failed");
    vi.restoreAllMocks(); await expect(withAiMutex(lock, () => "retry", 200)).resolves.toBe("retry");
  });
});
