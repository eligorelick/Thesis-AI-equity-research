import { describe, expect, it } from "vitest";

import { runStageB } from "@/pipeline/compute";
import {
  classifyInstrumentSupport,
  UnsupportedInstrumentError,
} from "@/pipeline/stageB/instrumentSupport";
import type { DataBundle } from "@/pipeline/types";

describe("classifyInstrumentSupport — unsupported company-analysis instruments", () => {
  it.each([
    { label: "ETF only", input: { isEtf: true, isFund: false }, kind: "etf" },
    { label: "fund only", input: { isEtf: false, isFund: true }, kind: "fund" },
    { label: "both flags", input: { isEtf: true, isFund: true }, kind: "etf-fund" },
  ] as const)("classifies $label as unsupported $kind", ({ input, kind }) => {
    const result = classifyInstrumentSupport(input);

    expect(result).toMatchObject({ supported: false, kind });
    if (!result.supported) {
      expect(result.reason).toMatch(/not supported/i);
      expect(result.reason).toMatch(/compan/i);
    }
  });

  it.each([
    { label: "explicit company flags", input: { isEtf: false, isFund: false } },
    { label: "null flags", input: { isEtf: null, isFund: null } },
    { label: "missing flags", input: {} },
    { label: "missing profile", input: null },
  ] as const)("treats $label as a supported company candidate", ({ input }) => {
    expect(classifyInstrumentSupport(input)).toEqual({ supported: true, kind: "company" });
  });
});

describe("runStageB — unsupported defense", () => {
  it("rejects an ETF before company computation with its typed support outcome", () => {
    const bundle = {
      symbol: "SPY",
      profile: {
        ok: true,
        value: { data: { rows: [{ isEtf: true, isFund: false }] } },
      },
    } as unknown as DataBundle;

    let thrown: unknown;
    try {
      runStageB(bundle);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnsupportedInstrumentError);
    expect(thrown).toMatchObject({
      support: { supported: false, kind: "etf" },
    });
  });
});
