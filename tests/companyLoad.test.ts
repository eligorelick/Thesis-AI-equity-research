import { afterEach, describe, expect, it, vi } from "vitest";

type CoordinatorFactory = <T>(options: {
  maxConcurrent: number;
  maxQueued?: number;
  negativeTtlMs: number;
  load(symbol: string): Promise<T | null>;
}) => (symbol: string) => Promise<T | null>;

type CapacityErrorConstructor = new () => Error;

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

async function nextTurns(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

async function loadFactory(): Promise<CoordinatorFactory | undefined> {
  let loadedModule: Record<string, unknown> = {};
  try {
    loadedModule = await vi.importActual<Record<string, unknown>>("@/pipeline/companyLoad");
  } catch {
    // The first RED establishes the new module through an observable behavior.
  }
  const candidate = loadedModule.createCompanyLoadCoordinator;
  expect(candidate).toBeTypeOf("function");
  return typeof candidate === "function" ? (candidate as CoordinatorFactory) : undefined;
}

async function loadCapacityError(): Promise<CapacityErrorConstructor | undefined> {
  const loadedModule = await vi.importActual<Record<string, unknown>>("@/pipeline/companyLoad");
  const candidate = loadedModule.CompanyLoadCapacityError;
  expect(candidate).toBeTypeOf("function");
  return typeof candidate === "function"
    ? (candidate as CapacityErrorConstructor)
    : undefined;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createCompanyLoadCoordinator", () => {
  it("singleflights concurrent normalized requests for one symbol", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const gate = deferred<{ symbol: string } | null>();
    const load = vi.fn((symbol: string) => gate.promise.then((value) => value ?? { symbol }));
    const coordinate = createCoordinator({ maxConcurrent: 2, negativeTtlMs: 100, load });

    const first = coordinate(" aapl ");
    const second = coordinate("AAPL");
    await nextTurns();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("AAPL");

    gate.resolve({ symbol: "AAPL" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { symbol: "AAPL" },
      { symbol: "AAPL" },
    ]);
  });

  it("registers same-symbol work before it waits for a global permit", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const activeGate = deferred<string | null>();
    const queuedGate = deferred<string | null>();
    const load = vi.fn((symbol: string) =>
      symbol === "AAPL" ? activeGate.promise : queuedGate.promise,
    );
    const coordinate = createCoordinator({ maxConcurrent: 1, negativeTtlMs: 100, load });

    const active = coordinate("AAPL");
    await nextTurns();
    const queuedOne = coordinate(" msft ");
    const queuedTwo = coordinate("MSFT");
    await nextTurns();
    expect(load).toHaveBeenCalledTimes(1);

    activeGate.resolve("AAPL");
    await active;
    await nextTurns();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls.map(([symbol]) => symbol)).toEqual(["AAPL", "MSFT"]);

    queuedGate.resolve("MSFT");
    await expect(Promise.all([queuedOne, queuedTwo])).resolves.toEqual(["MSFT", "MSFT"]);
  });

  it("keeps dot and hyphen share classes as distinct coordination keys", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const gates = new Map([
      ["BRK-B", deferred<string | null>()],
      ["BRK.B", deferred<string | null>()],
    ]);
    const load = vi.fn((symbol: string) => gates.get(symbol)!.promise);
    const coordinate = createCoordinator({ maxConcurrent: 2, negativeTtlMs: 100, load });

    const hyphen = coordinate("brk-b");
    const dot = coordinate("BRK.B");
    await nextTurns();
    expect(load.mock.calls.map(([symbol]) => symbol).sort()).toEqual(["BRK-B", "BRK.B"]);

    gates.get("BRK-B")!.resolve("hyphen");
    gates.get("BRK.B")!.resolve("dot");
    await expect(Promise.all([hyphen, dot])).resolves.toEqual(["hyphen", "dot"]);
  });

  it.each(["ß", "ſ", "ﬀ"])(
    "rejects raw Unicode symbol %s before uppercase expansion can alias it",
    async (rawSymbol) => {
      const createCoordinator = await loadFactory();
      if (createCoordinator === undefined) return;

      const load = vi.fn(async (symbol: string) => symbol);
      const coordinate = createCoordinator({ maxConcurrent: 1, negativeTtlMs: 100, load });

      await expect(coordinate(rawSymbol)).rejects.toThrow(/invalid symbol/i);
      expect(load).not.toHaveBeenCalled();
    },
  );

  it("negative-caches only null through the configured TTL boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const load = vi.fn(async () => null as string | null);
    const coordinate = createCoordinator({ maxConcurrent: 1, negativeTtlMs: 15_000, load });

    await expect(coordinate("AAPL")).resolves.toBeNull();
    await expect(coordinate("aapl")).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(14_999);
    await expect(coordinate(" AAPL ")).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await expect(coordinate("AAPL")).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("starts a null TTL when the loader completes, not while it is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const gate = deferred<string | null>();
    const load = vi.fn(() => gate.promise);
    const coordinate = createCoordinator({ maxConcurrent: 1, negativeTtlMs: 1_000, load });

    const pending = coordinate("AAPL");
    await nextTurns();
    vi.advanceTimersByTime(60_000);
    gate.resolve(null);
    await pending;

    vi.advanceTimersByTime(999);
    await expect(coordinate("AAPL")).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    const reloaded = coordinate("AAPL");
    await nextTurns();
    expect(load).toHaveBeenCalledTimes(2);
    // Resolve the second invocation through the already-settled test gate.
    await expect(reloaded).resolves.toBeNull();
  });

  it("disables negative caching when negativeTtlMs is zero", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const load = vi.fn(async () => null as string | null);
    const coordinate = createCoordinator({ maxConcurrent: 1, negativeTtlMs: 0, load });
    await coordinate("AAPL");
    await coordinate("AAPL");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("self-evicts idle negative entries with one unref'd cleanup timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const load = vi.fn(async () => null as string | null);
    const coordinate = createCoordinator({ maxConcurrent: 2, negativeTtlMs: 100, load });
    await coordinate("AAPL");
    await coordinate("MSFT");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
    await coordinate("AAPL");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("fails open and reloads when the wall clock moves behind cache completion", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-08-08T00:00:00.000Z");
    vi.setSystemTime(start);
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const load = vi.fn(async () => null as string | null);
    const coordinate = createCoordinator({ maxConcurrent: 1, negativeTtlMs: 15_000, load });
    await coordinate("AAPL");
    vi.setSystemTime(new Date(start.getTime() - 60_000));
    await coordinate("AAPL");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not positive-cache successful loads", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    let sequence = 0;
    const load = vi.fn(async () => ({ sequence: ++sequence }));
    const coordinate = createCoordinator({ maxConcurrent: 1, negativeTtlMs: 15_000, load });

    await expect(coordinate("AAPL")).resolves.toEqual({ sequence: 1 });
    await expect(coordinate("AAPL")).resolves.toEqual({ sequence: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([
    new Error("provider failed"),
    new DOMException("aborted", "AbortError"),
  ])("does not cache loader rejection $name", async (failure) => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const load = vi
      .fn<(symbol: string) => Promise<string | null>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("recovered");
    const coordinate = createCoordinator({ maxConcurrent: 1, negativeTtlMs: 15_000, load });

    await expect(coordinate("AAPL")).rejects.toBe(failure);
    await expect(coordinate("AAPL")).resolves.toBe("recovered");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one rejection across overlapping callers and retries afterward", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const gate = deferred<string | null>();
    const failure = new Error("shared failure");
    const load = vi
      .fn<(symbol: string) => Promise<string | null>>()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValueOnce("recovered");
    const coordinate = createCoordinator({ maxConcurrent: 1, negativeTtlMs: 100, load });
    const first = coordinate("AAPL");
    const second = coordinate("aapl");
    const settled = Promise.allSettled([first, second]);
    await nextTurns();
    gate.reject(failure);

    expect(await settled).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    await expect(coordinate("AAPL")).resolves.toBe("recovered");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not negative-cache an out-of-contract undefined result", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const load = vi.fn(async () => undefined as unknown as string | null);
    const coordinate = createCoordinator({ maxConcurrent: 1, negativeTtlMs: 100, load });
    await coordinate("AAPL");
    await coordinate("AAPL");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("releases a rejected load's permit to the next queued symbol", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const aGate = deferred<string | null>();
    const bGate = deferred<string | null>();
    const started: string[] = [];
    const coordinate = createCoordinator({
      maxConcurrent: 1,
      negativeTtlMs: 100,
      load: (symbol) => {
        started.push(symbol);
        return symbol === "A" ? aGate.promise : bGate.promise;
      },
    });
    const a = coordinate("A");
    const b = coordinate("B");
    await nextTurns();
    expect(started).toEqual(["A"]);
    const failure = new Error("A failed");
    aGate.reject(failure);
    await expect(a).rejects.toBe(failure);
    await nextTurns();
    expect(started).toEqual(["A", "B"]);
    bGate.resolve("B");
    await expect(b).resolves.toBe("B");
  });

  it("snapshots validated options instead of re-reading caller mutations", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const gateA = deferred<string | null>();
    const gateB = deferred<string | null>();
    const original = vi.fn((symbol: string) => (symbol === "A" ? gateA.promise : gateB.promise));
    const replacement = vi.fn(async () => "replacement");
    const options = { maxConcurrent: 1, negativeTtlMs: 100, load: original };
    const coordinate = createCoordinator(options);
    options.maxConcurrent = 2;
    options.negativeTtlMs = 0;
    options.load = replacement;

    const a = coordinate("A");
    const b = coordinate("B");
    await nextTurns();
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    gateA.resolve("A");
    await a;
    await nextTurns();
    expect(original).toHaveBeenCalledTimes(2);
    gateB.resolve(null);
    await b;
    await expect(coordinate("B")).resolves.toBeNull();
    expect(original).toHaveBeenCalledTimes(2);
  });

  it("enforces maxConcurrent across different symbols", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const gates = new Map(["A", "B", "C", "D"].map((symbol) => [symbol, deferred<string | null>()]));
    let active = 0;
    let maximumActive = 0;
    const started: string[] = [];
    const load = vi.fn(async (symbol: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.push(symbol);
      try {
        return await gates.get(symbol)!.promise;
      } finally {
        active -= 1;
      }
    });
    const coordinate = createCoordinator({ maxConcurrent: 2, negativeTtlMs: 100, load });

    const requests = ["A", "B", "C", "D"].map((symbol) => coordinate(symbol));
    await nextTurns();
    expect(started).toEqual(["A", "B"]);

    gates.get("A")!.resolve("A");
    await requests[0];
    await nextTurns();
    expect(started).toEqual(["A", "B", "C"]);

    gates.get("B")!.resolve("B");
    await requests[1];
    await nextTurns();
    expect(started).toEqual(["A", "B", "C", "D"]);
    expect(maximumActive).toBe(2);

    gates.get("C")!.resolve("C");
    gates.get("D")!.resolve("D");
    await expect(Promise.all(requests)).resolves.toEqual(["A", "B", "C", "D"]);
  });

  it("hands a released permit to queued work in FIFO order without barging", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const gates = new Map(["A", "B", "C", "D"].map((symbol) => [symbol, deferred<string | null>()]));
    const started: string[] = [];
    const coordinate = createCoordinator({
      maxConcurrent: 1,
      maxQueued: 3,
      negativeTtlMs: 100,
      load: async (symbol) => {
        started.push(symbol);
        return gates.get(symbol)!.promise;
      },
    });

    const a = coordinate("A");
    await nextTurns();
    const b = coordinate("B");
    const c = coordinate("C");
    await nextTurns();
    expect(started).toEqual(["A"]);

    gates.get("A")!.resolve("A");
    await a;
    const d = coordinate("D");
    await nextTurns();
    expect(started).toEqual(["A", "B"]);

    gates.get("B")!.resolve("B");
    await b;
    await nextTurns();
    expect(started).toEqual(["A", "B", "C"]);

    gates.get("C")!.resolve("C");
    await c;
    await nextTurns();
    expect(started).toEqual(["A", "B", "C", "D"]);
    gates.get("D")!.resolve("D");
    await d;
  });

  it("fails fast at maxQueued zero and admits a rejected symbol after capacity recovers", async () => {
    const createCoordinator = await loadFactory();
    const CapacityError = await loadCapacityError();
    if (createCoordinator === undefined || CapacityError === undefined) return;

    const gates = new Map([
      ["A", deferred<string | null>()],
      ["B", deferred<string | null>()],
    ]);
    const load = vi.fn((symbol: string) => gates.get(symbol)!.promise);
    const coordinate = createCoordinator({
      maxConcurrent: 1,
      maxQueued: 0,
      negativeTtlMs: 100,
      load,
    });

    const active = coordinate("A");
    await nextTurns();
    const overflow = coordinate("B");
    const observed: Array<{ status: string; value?: unknown }> = [];
    void overflow.then(
      (value) => observed.push({ status: "resolved", value }),
      (error) => observed.push({ status: "rejected", value: error }),
    );
    await nextTurns();
    const overflowAtCapacity = observed[0] ?? { status: "pending" };

    gates.get("A")!.resolve("A");
    await active;
    await nextTurns();
    if (overflowAtCapacity.status === "pending") {
      gates.get("B")!.resolve("B");
      await overflow;
    }

    expect(overflowAtCapacity).toMatchObject({
      status: "rejected",
      value: expect.any(CapacityError),
    });
    expect(load).toHaveBeenCalledTimes(1);

    const retry = coordinate("B");
    await nextTurns();
    gates.get("B")!.resolve("B");
    await expect(retry).resolves.toBe("B");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("lets a duplicate join at a full queue while rejecting a new distinct symbol", async () => {
    const createCoordinator = await loadFactory();
    const CapacityError = await loadCapacityError();
    if (createCoordinator === undefined || CapacityError === undefined) return;

    const gates = new Map(
      ["A", "B", "C"].map((symbol) => [symbol, deferred<string | null>()]),
    );
    const load = vi.fn((symbol: string) => gates.get(symbol)!.promise);
    const coordinate = createCoordinator({
      maxConcurrent: 1,
      maxQueued: 1,
      negativeTtlMs: 100,
      load,
    });

    const active = coordinate("A");
    const queued = coordinate("B");
    const duplicate = coordinate(" b ");
    const overflow = coordinate("C");
    expect(duplicate).toBe(queued);
    const observed: Array<{ status: string; value?: unknown }> = [];
    void overflow.then(
      (value) => observed.push({ status: "resolved", value }),
      (error) => observed.push({ status: "rejected", value: error }),
    );
    await nextTurns();
    const overflowAtCapacity = observed[0] ?? { status: "pending" };

    gates.get("A")!.resolve("A");
    await active;
    gates.get("B")!.resolve("B");
    await Promise.all([queued, duplicate]);
    await nextTurns();
    if (overflowAtCapacity.status === "pending") gates.get("C")!.resolve("C");
    await Promise.allSettled([overflow]);

    expect(overflowAtCapacity).toMatchObject({
      status: "rejected",
      value: expect.any(CapacityError),
    });
    expect(load.mock.calls.map(([symbol]) => symbol)).toEqual(["A", "B"]);
  });

  it("serves a negative-cache hit even while distinct-symbol admission is full", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const gates = new Map([
      ["A", deferred<string | null>()],
      ["B", deferred<string | null>()],
    ]);
    const load = vi.fn((symbol: string) =>
      symbol === "MISS" ? Promise.resolve(null) : gates.get(symbol)!.promise,
    );
    const coordinate = createCoordinator({
      maxConcurrent: 1,
      maxQueued: 1,
      negativeTtlMs: 100,
      load,
    });

    await expect(coordinate("MISS")).resolves.toBeNull();
    const active = coordinate("A");
    const queued = coordinate("B");
    await nextTurns();
    await expect(coordinate("MISS")).resolves.toBeNull();
    expect(load.mock.calls.map(([symbol]) => symbol)).toEqual(["MISS", "A"]);

    gates.get("A")!.resolve("A");
    await active;
    gates.get("B")!.resolve("B");
    await queued;
  });

  it("uses maxConcurrent as the bounded maxQueued default", async () => {
    const createCoordinator = await loadFactory();
    const CapacityError = await loadCapacityError();
    if (createCoordinator === undefined || CapacityError === undefined) return;

    const gates = new Map(
      ["A", "B", "C"].map((symbol) => [symbol, deferred<string | null>()]),
    );
    const coordinate = createCoordinator({
      maxConcurrent: 1,
      negativeTtlMs: 100,
      load: (symbol) => gates.get(symbol)!.promise,
    });
    const active = coordinate("A");
    const queued = coordinate("B");
    const overflow = coordinate("C");
    const observed: Array<{ status: string; value?: unknown }> = [];
    void overflow.then(
      (value) => observed.push({ status: "resolved", value }),
      (error) => observed.push({ status: "rejected", value: error }),
    );
    await nextTurns();
    const overflowAtCapacity = observed[0] ?? { status: "pending" };
    gates.get("A")!.resolve("A");
    await active;
    gates.get("B")!.resolve("B");
    await queued;
    await nextTurns();
    if (overflowAtCapacity.status === "pending") gates.get("C")!.resolve("C");
    await Promise.allSettled([overflow]);
    expect(overflowAtCapacity).toMatchObject({
      status: "rejected",
      value: expect.any(CapacityError),
    });
  });

  it("validates constructor limits and rejects invalid symbols before loading", async () => {
    const createCoordinator = await loadFactory();
    if (createCoordinator === undefined) return;

    const load = vi.fn(async (symbol: string) => symbol);
    for (const maxConcurrent of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => createCoordinator({ maxConcurrent, negativeTtlMs: 1, load })).toThrow();
    }
    for (const negativeTtlMs of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => createCoordinator({ maxConcurrent: 1, negativeTtlMs, load })).toThrow();
    }
    for (const maxQueued of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        createCoordinator({ maxConcurrent: 1, maxQueued, negativeTtlMs: 1, load }),
      ).toThrow();
    }
    expect(() =>
      createCoordinator({ maxConcurrent: 1, negativeTtlMs: 1, load: null as never }),
    ).toThrow(/load/i);

    const coordinate = createCoordinator({ maxConcurrent: 1, negativeTtlMs: 0, load });
    for (const invalid of ["", " ", "../AAPL", "AAPL/US", ".AAPL", "AAPL."]) {
      await expect(coordinate(invalid)).rejects.toThrow(/invalid symbol/i);
    }
    expect(load).not.toHaveBeenCalled();
  });
});
