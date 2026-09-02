/**
 * Global test guard: no test may reach the live network.
 *
 * The suite's freedom from live provider traffic used to rest on fixture
 * content — `buildDataBundle` builds a real `YahooClient` when `opts.yahoo` is
 * absent, and the only thing stopping the keyless layer from calling it in nine
 * degradation scenarios was that their FMP profile fixtures happen to omit
 * `cik`. Adding a `cik` to one of those fixtures would have opened a live
 * socket with nothing failing loudly. This guard replaces `globalThis.fetch`
 * for every test file so that reaching a non-loopback host is a test failure
 * with the offending method and URL in the message.
 *
 * Loopback (`127.0.0.1`, `localhost`, `::1`) passes through to the real fetch
 * so tests that stand up a local server keep working. `EDGAR_LIVE_SMOKE=1`
 * — the existing opt-in for the two-request live smoke in
 * `tests/edgar.client.test.ts` — disables the guard entirely.
 *
 * Tests that install their own `globalThis.fetch` and restore the previous
 * value (`tests/helpers/auditFixtureComparison.ts`) keep working: the value
 * they save and put back is this guard, not a raw fetch.
 */

type FetchFn = typeof globalThis.fetch;
type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

const GUARD_MARKER = Symbol.for("thesis.tests.noLiveNetworkGuard");

/** `Request` carries its own resolved URL; everything else stringifies. */
function urlOf(input: FetchInput): string {
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

function methodOf(input: FetchInput, init: FetchInit): string {
  const fromInit = init?.method;
  if (typeof fromInit === "string" && fromInit.length > 0) return fromInit.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

/**
 * True only for loopback literals. An unparseable URL is treated as non-local
 * so the guard fails closed rather than waving through something it cannot
 * classify.
 */
export function isLoopbackUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  // `new URL("http://[::1]/").hostname` keeps the brackets.
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return LOOPBACK_HOSTNAMES.has(bare.toLowerCase());
}

/**
 * Wrap `realFetch` so non-loopback requests reject. Exported for the guard's
 * own test, which observes the pass-through without opening a socket.
 */
export function createNoLiveNetworkFetch(realFetch: FetchFn): FetchFn {
  const guarded: FetchFn = (input, init) => {
    if (process.env.EDGAR_LIVE_SMOKE === "1") return realFetch(input, init);
    const url = urlOf(input);
    if (isLoopbackUrl(url)) return realFetch(input, init);
    return Promise.reject(
      new Error(`live network is disabled in the test suite: ${methodOf(input, init)} ${url}`),
    );
  };
  Object.defineProperty(guarded, GUARD_MARKER, { value: true });
  return guarded;
}

/** Idempotent: a second call leaves the already-installed guard in place. */
export function installNoLiveNetworkGuard(): void {
  const current = globalThis.fetch as (FetchFn & { [GUARD_MARKER]?: boolean }) | undefined;
  if (typeof current !== "function" || current[GUARD_MARKER] === true) return;
  globalThis.fetch = createNoLiveNetworkFetch(current);
}

installNoLiveNetworkGuard();
