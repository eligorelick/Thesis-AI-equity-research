import "server-only";

import { normalizeSymbol } from "@/symbol";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class CompanyLoadCapacityError extends Error {
  constructor() {
    super("company load capacity exceeded");
    this.name = "CompanyLoadCapacityError";
  }
}

export interface CompanyLoadCoordinatorOptions<T> {
  maxConcurrent: number;
  maxQueued?: number;
  negativeTtlMs: number;
  load(symbol: string): Promise<T | null>;
}

function requireSafeInteger(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
}

/**
 * Coordinate expensive company loads within one application process.
 *
 * The returned function has no positive cache: it shares only current work and
 * briefly remembers confirmed semantic misses (`null`). Different symbols pass
 * through a FIFO permit queue so one burst cannot exceed the configured cap.
 */
export function createCompanyLoadCoordinator<T>(
  options: CompanyLoadCoordinatorOptions<T>,
): (symbol: string) => Promise<T | null> {
  const { maxConcurrent, negativeTtlMs, load } = options;
  const maxQueued = options.maxQueued ?? maxConcurrent;
  requireSafeInteger("maxConcurrent", maxConcurrent, 1);
  requireSafeInteger("maxQueued", maxQueued, 0);
  requireSafeInteger("negativeTtlMs", negativeTtlMs, 0);
  if (typeof load !== "function") throw new Error("load must be a function");

  let active = 0;
  const permitQueue: Array<() => void> = [];
  const inFlight = new Map<string, Promise<T | null>>();
  const negativeCompletedAt = new Map<string, number>();
  let negativeCleanupTimer: ReturnType<typeof setTimeout> | null = null;

  function pruneNegative(now: number): boolean {
    let changed = false;
    for (const [cachedSymbol, completedAt] of negativeCompletedAt) {
      const elapsed = now - completedAt;
      if (elapsed < 0 || elapsed >= negativeTtlMs) {
        negativeCompletedAt.delete(cachedSymbol);
        changed = true;
      }
    }
    return changed;
  }

  function scheduleNegativeCleanup(): void {
    if (negativeCleanupTimer !== null) {
      clearTimeout(negativeCleanupTimer);
      negativeCleanupTimer = null;
    }
    if (negativeTtlMs === 0 || negativeCompletedAt.size === 0) return;

    const now = Date.now();
    pruneNegative(now);
    if (negativeCompletedAt.size === 0) return;

    let delayMs = MAX_TIMER_DELAY_MS;
    for (const completedAt of negativeCompletedAt.values()) {
      const remaining = negativeTtlMs - (now - completedAt);
      delayMs = Math.min(delayMs, Math.max(1, Math.ceil(remaining)));
    }
    negativeCleanupTimer = setTimeout(() => {
      negativeCleanupTimer = null;
      pruneNegative(Date.now());
      scheduleNegativeCleanup();
    }, delayMs);
    negativeCleanupTimer.unref?.();
  }

  function acquirePermit(): Promise<void> {
    if (active < maxConcurrent && permitQueue.length === 0) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      permitQueue.push(resolve);
    });
  }

  function releasePermit(): void {
    const next = permitQueue.shift();
    if (next !== undefined) {
      // Transfer the occupied permit before the next continuation runs. Keeping
      // `active` unchanged prevents a newly arriving request from barging.
      next();
      return;
    }
    active -= 1;
  }

  return (rawSymbol: string): Promise<T | null> => {
    const symbol = normalizeSymbol(rawSymbol);
    if (symbol === null) {
      return Promise.reject(new Error(`invalid symbol: ${rawSymbol}`));
    }

    const now = Date.now();
    if (pruneNegative(now)) scheduleNegativeCleanup();
    if (negativeCompletedAt.has(symbol)) return Promise.resolve(null);

    const existing = inFlight.get(symbol);
    if (existing !== undefined) return existing;

    if (active >= maxConcurrent && permitQueue.length >= maxQueued) {
      return Promise.reject(new CompanyLoadCapacityError());
    }

    const pending = (async (): Promise<T | null> => {
      await acquirePermit();
      try {
        const value = await load(symbol);
        if (value === null && negativeTtlMs > 0) {
          negativeCompletedAt.set(symbol, Date.now());
          scheduleNegativeCleanup();
        }
        return value;
      } finally {
        releasePermit();
      }
    })();

    // Register before the first permit await settles so duplicate queued work
    // observes this exact promise rather than entering the global queue twice.
    inFlight.set(symbol, pending);
    void pending.then(
      () => {
        if (inFlight.get(symbol) === pending) inFlight.delete(symbol);
      },
      () => {
        if (inFlight.get(symbol) === pending) inFlight.delete(symbol);
      },
    );
    return pending;
  };
}
