import { describe, expect, it, vi } from "vitest";

type SubmissionPreparation =
  | { ok: true; symbol: string }
  | { ok: false; error: string };

type PrepareTickerSubmission = (raw: string) => SubmissionPreparation;

async function loadPreparation(): Promise<PrepareTickerSubmission | undefined> {
  let loadedModule: Record<string, unknown> = {};
  try {
    loadedModule = await vi.importActual<Record<string, unknown>>(
      "@/components/watchlist/addTickerInput",
    );
  } catch {
    // The RED establishes the pure client-side validation boundary.
  }
  const candidate = loadedModule.prepareTickerSubmission;
  expect(candidate).toBeTypeOf("function");
  return typeof candidate === "function"
    ? (candidate as PrepareTickerSubmission)
    : undefined;
}

describe("prepareTickerSubmission", () => {
  it.each(["ß", "ſ", "ﬀ", "AAPL/US", ""])(
    "surfaces invalid ticker %s without producing a request symbol",
    async (raw) => {
      expect((await loadPreparation())?.(raw)).toEqual({
        ok: false,
        error: "invalid ticker symbol",
      });
    },
  );

  it.each([
    [" aapl ", "AAPL"],
    ["brk.b", "BRK.B"],
    ["bf-b", "BF-B"],
  ])("prepares %s as %s", async (raw, symbol) => {
    expect((await loadPreparation())?.(raw)).toEqual({ ok: true, symbol });
  });
});
