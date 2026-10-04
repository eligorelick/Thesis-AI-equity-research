import fs from "node:fs";
import { withAiMutex } from "../../src/ai/mutex.ts";

// This subprocess never loads provider code, credentials or the report DB.
globalThis.fetch = () => { throw new Error("Network prohibited in mutex worker"); };
const [lock, scratch, mode, identity, iterations = "1"] = process.argv.slice(2);
const send = (type, details = {}) => process.send?.({ type, ...details });
const command = (name) => new Promise((resolve) => {
  function listener(message) { if (message === name) { process.off("message", listener); resolve(); } }
  process.on("message", listener);
});
if (mode === "orphan") {
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (String(file).startsWith(`${lock}.`) && String(file).endsWith(".tmp")) throw Object.assign(new Error("DELETE sharing denied"), { code: "EPERM" });
    return unlink(file);
  };
}
if (mode === "crash-before-publish" || mode === "crash-after-publish") {
  const link = fs.linkSync;
  fs.linkSync = (...args) => {
    if (mode === "crash-after-publish") link(...args);
    send("publication", { published: mode === "crash-after-publish" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
}
const start = command("go");
send("ready");
await start;
try {
  if (mode === "legacy") {
    // The old binary's PID protocol, with only its test wait budget shortened.
    const started = Date.now();
    for (;;) {
      try { const fd = fs.openSync(lock, "wx", 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); throw new Error("Legacy acquired new mutex"); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const pid = Number(fs.readFileSync(lock, "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (probe) { if (probe.code === "ESRCH") { fs.rmSync(lock); continue; } }
        }
        if (Date.now() - started >= 200) throw new Error("AI credentials are busy; retry shortly");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  for (let index = 0; index < Number(iterations); index++) {
    await withAiMutex(lock, async () => {
      send("entered", { index });
      if (mode === "hold" || mode === "orphan") await command("release");
      if (mode !== "hold" && mode !== "orphan") {
        const state = fs.existsSync(scratch) ? JSON.parse(fs.readFileSync(scratch, "utf8")) : [];
        await new Promise((resolve) => setTimeout(resolve, 15));
        state.push(`${identity}:${index}`);
        fs.writeFileSync(`${scratch}.${identity}.tmp`, JSON.stringify(state));
        fs.renameSync(`${scratch}.${identity}.tmp`, scratch);
        send("written", { index });
        if (mode === "write-hold") await command("release");
      }
      send("leaving", { index });
    }, mode === "timeout" ? 200 : 40_000);
  }
  send("done");
} catch (error) { send("failed", { message: error.message, code: error.code }); }
process.disconnect?.();
