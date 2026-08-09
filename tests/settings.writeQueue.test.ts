import { describe, expect, it, vi } from "vitest";

import type {
  EffectiveSettings,
  SettingSource,
  WritableSettings,
  WritableSettingsAuthority,
  WriterState,
} from "@/settings/contracts";
import { createSettingsWriteQueue } from "@/settings/writeQueue";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const INITIAL: WritableSettings = {
  analysisModel: "auto",
  analysisEffort: "high",
};

const A: WritableSettings = {
  analysisModel: "auto",
  analysisEffort: "medium",
};

const B: WritableSettings = {
  analysisModel: "claude-opus-4-8",
  analysisEffort: "medium",
};

const C: WritableSettings = {
  analysisModel: "claude-opus-4-8",
  analysisEffort: "max",
};

const D: WritableSettings = {
  analysisModel: "claude-sonnet-5",
  analysisEffort: "low",
};

function authority(
  state: EffectiveSettings,
  revision: number,
  etag: string,
  sources: { analysisModel: SettingSource; analysisEffort: SettingSource } = {
    analysisModel: "database",
    analysisEffort: "database",
  },
): WritableSettingsAuthority {
  return {
    state: { ...state },
    sources: { ...sources },
    revision,
    etag,
  };
}

function cloneState(state: WriterState): WriterState {
  return structuredClone(state);
}

describe("createSettingsWriteQueue", () => {
  it("serializes A then latest C, coalesces B, chains the acknowledged ETag, and never renders old A", async () => {
    const pending: Deferred<WritableSettingsAuthority>[] = [];
    const writes: Array<{ desired: WritableSettings; ifMatch: string }> = [];
    const states: WriterState[] = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const write = vi.fn((desired: WritableSettings, ifMatch: string) => {
      const result = deferred<WritableSettingsAuthority>();
      pending.push(result);
      writes.push({ desired: structuredClone(desired), ifMatch });
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      return result.promise.finally(() => {
        activeWrites -= 1;
      });
    });

    const queue = createSettingsWriteQueue({
      initial: authority(INITIAL, 0, '"settings-0"'),
      write,
      recover: vi.fn(),
      onState: (state) => states.push(cloneState(state)),
    });

    queue.setDesired(A);
    await settle();
    queue.setDesired(B);
    queue.setDesired(C);

    expect(writes).toEqual([{ desired: A, ifMatch: '"settings-0"' }]);
    expect(states.at(-1)).toMatchObject({
      status: "saving",
      desired: C,
      authority: authority(INITIAL, 0, '"settings-0"'),
    });
    expect(states.some((state) => state.status === "saved")).toBe(false);

    const responseA = authority(A, 1, '"settings-1"');
    const afterQueuedC = states.length;
    pending[0]!.resolve(responseA);
    await settle();

    expect(writes).toEqual([
      { desired: A, ifMatch: '"settings-0"' },
      { desired: C, ifMatch: '"settings-1"' },
    ]);
    expect(states.at(-1)).toMatchObject({
      status: "saving",
      desired: C,
      authority: authority(A, 1, '"settings-1"'),
    });
    expect(states.slice(afterQueuedC).every((state) =>
      state.status === "saving" && state.desired.analysisModel === C.analysisModel &&
      state.desired.analysisEffort === C.analysisEffort
    )).toBe(true);
    expect(states.length).toBeGreaterThan(afterQueuedC);

    pending[1]!.resolve(authority(C, 2, '"settings-2"'));
    await queue.flush();

    expect(states.at(-1)).toMatchObject({
      status: "saved",
      desired: C,
      authority: authority(C, 2, '"settings-2"'),
      error: null,
    });
    expect(maxActiveWrites).toBe(1);
  });

  it("defensively copies desired inputs, write arguments, responses, and callback payloads", async () => {
    const firstResult = deferred<WritableSettingsAuthority>();
    const secondResult = deferred<WritableSettingsAuthority>();
    const writes: Array<{ desired: WritableSettings; ifMatch: string }> = [];
    const states: WriterState[] = [];
    const input = { ...A };
    let writeCount = 0;
    const queue = createSettingsWriteQueue({
      initial: authority(INITIAL, 0, '"settings-0"'),
      write: (desired, ifMatch) => {
        writeCount += 1;
        writes.push({ desired: structuredClone(desired), ifMatch });
        // A hostile adapter must not be able to mutate the queue's own copy.
        desired.analysisModel = "claude-fable-5";
        desired.analysisEffort = "xhigh";
        return writeCount === 1 ? firstResult.promise : secondResult.promise;
      },
      recover: vi.fn(),
      onState: (state) => {
        states.push(cloneState(state));
        // A hostile observer receives a disposable clone too.
        state.desired.analysisModel = "claude-fable-5";
        state.authority.etag = '"mutated-by-observer"';
        state.authority.state.analysisEffort = "xhigh";
      },
    });

    queue.setDesired(input);
    input.analysisModel = "claude-sonnet-5";
    input.analysisEffort = "low";
    await settle();

    expect(writes).toEqual([{ desired: A, ifMatch: '"settings-0"' }]);

    const responseA = authority(A, 1, '"settings-1"');
    firstResult.resolve(responseA);
    await queue.flush();
    responseA.etag = '"mutated-after-resolution"';
    responseA.state.analysisEffort = "low";

    queue.setDesired(C);
    await settle();
    expect(writes).toEqual([
      { desired: A, ifMatch: '"settings-0"' },
      { desired: C, ifMatch: '"settings-1"' },
    ]);
    secondResult.resolve(authority(C, 2, '"settings-2"'));
    await queue.flush();
    expect(states.at(-1)).toMatchObject({ status: "saved", desired: C });
  });

  it("enters recovering after a rejected write, blocks its tail, and treats recovered desired state as saved", async () => {
    const firstWrite = deferred<WritableSettingsAuthority>();
    const recovery = deferred<WritableSettingsAuthority>();
    const writes: WritableSettings[] = [];
    const recoverySignals: AbortSignal[] = [];
    const states: WriterState[] = [];
    const queue = createSettingsWriteQueue({
      initial: authority(INITIAL, 0, '"settings-0"'),
      write: (desired) => {
        writes.push(structuredClone(desired));
        return firstWrite.promise;
      },
      recover: (signal) => {
        recoverySignals.push(signal);
        return recovery.promise;
      },
      onState: (state) => states.push(cloneState(state)),
    });

    queue.setDesired(A);
    await settle();
    queue.setDesired(C);
    let flushed = false;
    const flushing = queue.flush().then(() => {
      flushed = true;
    });
    firstWrite.reject(new Error("ambiguous POST failure"));
    await settle();

    expect(writes).toEqual([A]);
    expect(recoverySignals).toHaveLength(1);
    expect(recoverySignals[0]!.aborted).toBe(false);
    expect(flushed).toBe(false);
    expect(states.at(-1)).toMatchObject({
      status: "recovering",
      desired: C,
      authority: authority(INITIAL, 0, '"settings-0"'),
    });

    recovery.resolve(authority(C, 7, '"settings-7"'));
    await flushing;

    expect(writes).toEqual([A]);
    expect(states.at(-1)).toMatchObject({
      status: "saved",
      desired: C,
      authority: authority(C, 7, '"settings-7"'),
      error: null,
    });
  });

  it("installs mismatched recovered authority, reports error, and drops the stale tail instead of replaying it", async () => {
    const firstWrite = deferred<WritableSettingsAuthority>();
    const recovery = deferred<WritableSettingsAuthority>();
    const writes: WritableSettings[] = [];
    const states: WriterState[] = [];
    const external: WritableSettings = {
      analysisModel: "claude-fable-5",
      analysisEffort: "xhigh",
    };
    const queue = createSettingsWriteQueue({
      initial: authority(INITIAL, 0, '"settings-0"'),
      write: (desired) => {
        writes.push(structuredClone(desired));
        return firstWrite.promise;
      },
      recover: () => recovery.promise,
      onState: (state) => states.push(cloneState(state)),
    });

    queue.setDesired(A);
    await settle();
    queue.setDesired(C);
    firstWrite.reject(new Error("412 precondition failed"));
    await settle();
    recovery.resolve(authority(external, 9, '"settings-9"'));
    await queue.flush();

    expect(writes).toEqual([A]);
    expect(states.at(-1)).toMatchObject({
      status: "error",
      desired: external,
      authority: authority(external, 9, '"settings-9"'),
    });
    expect(states.at(-1)!.error).toEqual(expect.any(String));
  });

  it("restores last authority after recovery failure, drops the tail, then recovers before a later explicit edit POST", async () => {
    const firstWrite = deferred<WritableSettingsAuthority>();
    const secondWrite = deferred<WritableSettingsAuthority>();
    const firstRecovery = deferred<WritableSettingsAuthority>();
    const secondRecovery = deferred<WritableSettingsAuthority>();
    const writes: Array<{ desired: WritableSettings; ifMatch: string }> = [];
    const states: WriterState[] = [];
    let recoveryCount = 0;
    const queue = createSettingsWriteQueue({
      initial: authority(INITIAL, 0, '"settings-0"'),
      write: (desired, ifMatch) => {
        writes.push({ desired: structuredClone(desired), ifMatch });
        return writes.length === 1 ? firstWrite.promise : secondWrite.promise;
      },
      recover: () => {
        recoveryCount += 1;
        return recoveryCount === 1 ? firstRecovery.promise : secondRecovery.promise;
      },
      onState: (state) => states.push(cloneState(state)),
    });

    queue.setDesired(A);
    await settle();
    queue.setDesired(C);
    firstWrite.reject(new Error("connection reset"));
    await settle();
    firstRecovery.reject(new Error("GET unavailable"));
    await queue.flush();

    expect(writes).toEqual([{ desired: A, ifMatch: '"settings-0"' }]);
    expect(states.at(-1)).toMatchObject({
      status: "error",
      desired: INITIAL,
      authority: authority(INITIAL, 0, '"settings-0"'),
    });

    queue.setDesired(D);
    await settle();
    expect(recoveryCount).toBe(2);
    expect(writes).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({
      status: "recovering",
      desired: D,
      authority: authority(INITIAL, 0, '"settings-0"'),
    });

    const external = authority(B, 4, '"settings-4"');
    const beforeSecondRecovery = states.length;
    secondRecovery.resolve(external);
    await settle();
    expect(writes).toEqual([
      { desired: A, ifMatch: '"settings-0"' },
      { desired: D, ifMatch: '"settings-4"' },
    ]);
    expect(states.slice(beforeSecondRecovery).every((state) =>
      state.desired.analysisModel === D.analysisModel &&
      state.desired.analysisEffort === D.analysisEffort &&
      (state.status === "recovering" || state.status === "saving")
    )).toBe(true);
    expect(states.length).toBeGreaterThan(beforeSecondRecovery);

    secondWrite.resolve(authority(D, 5, '"settings-5"'));
    await queue.flush();
    expect(states.at(-1)).toMatchObject({
      status: "saved",
      authority: authority(D, 5, '"settings-5"'),
      desired: D,
    });
  });

  it("treats a mismatched successful write response as ambiguous and GET-recovers before any tail", async () => {
    const writeResult = deferred<WritableSettingsAuthority>();
    const recovery = deferred<WritableSettingsAuthority>();
    const recover = vi.fn(() => recovery.promise);
    const states: WriterState[] = [];
    const queue = createSettingsWriteQueue({
      initial: authority(INITIAL, 0, '"settings-0"'),
      write: () => writeResult.promise,
      recover,
      onState: (state) => states.push(cloneState(state)),
    });

    queue.setDesired(A);
    await settle();
    writeResult.resolve(authority(B, 1, '"settings-1"'));
    await settle();

    expect(recover).toHaveBeenCalledOnce();
    expect(states.at(-1)?.status).toBe("recovering");

    recovery.resolve(authority(B, 1, '"settings-1"'));
    await queue.flush();
    expect(states.at(-1)).toMatchObject({
      status: "error",
      authority: authority(B, 1, '"settings-1"'),
      desired: B,
    });
  });

  it("keeps flush pending through a successful coalesced A to C tail", async () => {
    const firstWrite = deferred<WritableSettingsAuthority>();
    const tailWrite = deferred<WritableSettingsAuthority>();
    const writes: WritableSettings[] = [];
    const queue = createSettingsWriteQueue({
      initial: authority(INITIAL, 0, '"settings-0"'),
      write: (desired) => {
        writes.push(structuredClone(desired));
        return writes.length === 1 ? firstWrite.promise : tailWrite.promise;
      },
      recover: vi.fn(),
      onState: vi.fn(),
    });

    queue.setDesired(A);
    await settle();
    queue.setDesired(C);
    let flushed = false;
    const flushing = queue.flush().then(() => {
      flushed = true;
    });
    await settle();
    expect(flushed).toBe(false);

    firstWrite.resolve(authority(A, 1, '"settings-1"'));
    await settle();
    expect(flushed).toBe(false);
    expect(writes).toEqual([A, C]);

    tailWrite.resolve(authority(C, 2, '"settings-2"'));
    await flushing;
    expect(flushed).toBe(true);
  });

  it("aborts an in-progress recovery on dispose and suppresses every later state callback", async () => {
    const writeResult = deferred<WritableSettingsAuthority>();
    const recovery = deferred<WritableSettingsAuthority>();
    let recoverySignal: AbortSignal | undefined;
    const onState = vi.fn();
    const queue = createSettingsWriteQueue({
      initial: authority(INITIAL, 0, '"settings-0"'),
      write: () => writeResult.promise,
      recover: (signal) => {
        recoverySignal = signal;
        return recovery.promise;
      },
      onState,
    });

    queue.setDesired(A);
    await settle();
    writeResult.reject(new Error("ambiguous"));
    await settle();
    expect(recoverySignal?.aborted).toBe(false);
    const callbacksBeforeDispose = onState.mock.calls.length;

    queue.dispose();
    expect(recoverySignal?.aborted).toBe(true);
    recovery.reject(new DOMException("aborted", "AbortError"));
    await queue.flush();

    expect(onState).toHaveBeenCalledTimes(callbacksBeforeDispose);
  });

  it("does not abort an in-flight POST on dispose and ignores its eventual settlement", async () => {
    const writeResult = deferred<WritableSettingsAuthority>();
    const recover = vi.fn();
    const onState = vi.fn();
    const write = vi.fn(() => writeResult.promise);
    const queue = createSettingsWriteQueue({
      initial: authority(INITIAL, 0, '"settings-0"'),
      write,
      recover,
      onState,
    });

    queue.setDesired(A);
    await settle();
    const callbacksBeforeDispose = onState.mock.calls.length;
    queue.dispose();
    writeResult.resolve(authority(A, 1, '"settings-1"'));
    await queue.flush();

    expect(write).toHaveBeenCalledWith(A, '"settings-0"');
    expect(recover).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(callbacksBeforeDispose);
  });

  it("does not launch recovery when a non-abortable POST rejects after dispose", async () => {
    const writeResult = deferred<WritableSettingsAuthority>();
    const recover = vi.fn();
    const onState = vi.fn();
    const queue = createSettingsWriteQueue({
      initial: authority(INITIAL, 0, '"settings-0"'),
      write: () => writeResult.promise,
      recover,
      onState,
    });

    queue.setDesired(A);
    await settle();
    const callbacksBeforeDispose = onState.mock.calls.length;
    queue.dispose();
    writeResult.reject(new Error("POST settled ambiguously after unmount"));
    await queue.flush();

    expect(recover).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(callbacksBeforeDispose);
  });
});
