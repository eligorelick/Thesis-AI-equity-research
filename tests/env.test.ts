import { afterEach, describe, expect, it } from "vitest";
import { getConfig, parseEnv, resetConfigCache } from "@/config/env";

describe("parseEnv", () => {
  it("treats empty strings as undefined and enables fixture mode", () => {
    const config = parseEnv({
      FMP_API_KEY: "",
      FINNHUB_API_KEY: "",
      FRED_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      ANALYSIS_MODEL: "",
    });

    expect(config.fmpApiKey).toBeUndefined();
    expect(config.finnhubApiKey).toBeUndefined();
    expect(config.fredApiKey).toBeUndefined();
    expect(config.anthropicApiKey).toBeUndefined();

    expect(config.hasFmpKey).toBe(false);
    expect(config.hasFinnhubKey).toBe(false);
    expect(config.hasFredKey).toBe(false);
    expect(config.hasAnthropicKey).toBe(false);
    expect(config.fixtureMode).toBe(true);
  });

  it("treats whitespace-only values as undefined", () => {
    const config = parseEnv({ FMP_API_KEY: "   ", ANTHROPIC_API_KEY: "\t" });
    expect(config.fmpApiKey).toBeUndefined();
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.fixtureMode).toBe(true);
  });

  it("applies defaults when variables are absent (a leftover VERIFY_MODEL is ignored)", () => {
    const config = parseEnv({ VERIFY_MODEL: "claude-sonnet-5" });
    expect(config.analysisModel).toBe("auto");
    expect("verifyModel" in config).toBe(false);
    expect(config.fixtureMode).toBe(true);
    expect(config.hasAnthropicKey).toBe(false);
    expect(config.maxActiveJobs).toBe(1);
    expect(config.maxActiveLlmCalls).toBe(2);
    expect(config.maxJobCostUsd).toBeNull();
    expect(config.maxRollingCostUsd).toBeNull();
    expect(config.rollingCostWindowMs).toBe(1_440 * 60_000);
    expect(config.paidPassLeaseTtlMs).toBe(900_000);
    expect(config.jobLeaseTtlMs).toBe(900_000);
  });

  it("trims and passes through real values, setting capability flags", () => {
    const config = parseEnv({
      FMP_API_KEY: " fmp-key ",
      FINNHUB_API_KEY: "fh-key",
      FRED_API_KEY: "fred-key",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      ANALYSIS_MODEL: "claude-opus-4-8",
    });

    expect(config.fmpApiKey).toBe("fmp-key");
    expect(config.finnhubApiKey).toBe("fh-key");
    expect(config.fredApiKey).toBe("fred-key");
    expect(config.anthropicApiKey).toBe("sk-ant-xxx");
    expect(config.analysisModel).toBe("claude-opus-4-8");

    expect(config.hasFmpKey).toBe(true);
    expect(config.hasFinnhubKey).toBe(true);
    expect(config.hasFredKey).toBe(true);
    expect(config.hasAnthropicKey).toBe(true);
    expect(config.fixtureMode).toBe(false);
  });

  it("fixtureMode is driven solely by the FMP key", () => {
    const withOnlyFmp = parseEnv({ FMP_API_KEY: "k" });
    expect(withOnlyFmp.fixtureMode).toBe(false);
    expect(withOnlyFmp.hasAnthropicKey).toBe(false);

    const withEverythingButFmp = parseEnv({
      FINNHUB_API_KEY: "k",
      FRED_API_KEY: "k",
      ANTHROPIC_API_KEY: "k",
    });
    expect(withEverythingButFmp.fixtureMode).toBe(true);
  });

  it("ignores unrelated environment variables", () => {
    const config = parseEnv({ PATH: "/usr/bin", HOME: "/home/u" });
    expect(config.analysisModel).toBe("auto");
    expect(config.fixtureMode).toBe(true);
  });

  it("returns a frozen config object", () => {
    const config = parseEnv({});
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("parses strict scheduler counts, windows, leases, and decimal USD caps", () => {
    const config = parseEnv({
      THESIS_MAX_ACTIVE_JOBS: "3",
      THESIS_MAX_ACTIVE_LLM_CALLS: "4",
      THESIS_MAX_JOB_COST_USD: "12.345678",
      THESIS_MAX_ROLLING_COST_USD: "99.01",
      THESIS_ROLLING_COST_WINDOW_MINUTES: "60",
      THESIS_PAID_PASS_LEASE_SECONDS: "901",
      THESIS_JOB_LEASE_SECONDS: "1200",
    });
    expect(config).toMatchObject({
      maxActiveJobs: 3,
      maxActiveLlmCalls: 4,
      maxJobCostUsd: 12.345678,
      maxRollingCostUsd: 99.01,
      rollingCostWindowMs: 3_600_000,
      paidPassLeaseTtlMs: 901_000,
      jobLeaseTtlMs: 1_200_000,
    });
  });

  it("treats blank scheduler values as defaults/null rather than zero", () => {
    const config = parseEnv({
      THESIS_MAX_ACTIVE_JOBS: " ",
      THESIS_MAX_ACTIVE_LLM_CALLS: "\t",
      THESIS_MAX_JOB_COST_USD: "",
      THESIS_MAX_ROLLING_COST_USD: " ",
      THESIS_ROLLING_COST_WINDOW_MINUTES: "",
      THESIS_PAID_PASS_LEASE_SECONDS: "",
      THESIS_JOB_LEASE_SECONDS: "",
    });
    expect(config.maxActiveJobs).toBe(1);
    expect(config.maxActiveLlmCalls).toBe(2);
    expect(config.maxJobCostUsd).toBeNull();
    expect(config.maxRollingCostUsd).toBeNull();
    expect(config.rollingCostWindowMs).toBe(1_440 * 60_000);
    expect(config.paidPassLeaseTtlMs).toBe(900_000);
    expect(config.jobLeaseTtlMs).toBe(900_000);
  });

  it.each([
    ["THESIS_MAX_ACTIVE_JOBS", "0"],
    ["THESIS_MAX_ACTIVE_LLM_CALLS", "1.5"],
    ["THESIS_ROLLING_COST_WINDOW_MINUTES", "-1"],
    ["THESIS_PAID_PASS_LEASE_SECONDS", "600"],
    ["THESIS_JOB_LEASE_SECONDS", "NaN"],
    ["THESIS_MAX_ACTIVE_JOBS", "9007199254740992"],
  ])("rejects invalid scheduler integer %s=%s", (key, value) => {
    expect(() => parseEnv({ [key]: value })).toThrow();
  });

  it.each([
    ["THESIS_ROLLING_COST_WINDOW_MINUTES", 60_000, 52_560_000],
    ["THESIS_PAID_PASS_LEASE_SECONDS", 1_000, 2_147_483],
    ["THESIS_JOB_LEASE_SECONDS", 1_000, 2_147_483],
  ] as const)("rejects %s beyond its executable millisecond range", (key, scale, maximumInput) => {
    expect(parseEnv({ [key]: String(maximumInput) })).toMatchObject({
      [key === "THESIS_ROLLING_COST_WINDOW_MINUTES"
        ? "rollingCostWindowMs"
        : key === "THESIS_PAID_PASS_LEASE_SECONDS"
          ? "paidPassLeaseTtlMs"
          : "jobLeaseTtlMs"]: maximumInput * scale,
    });
    expect(() => parseEnv({ [key]: String(maximumInput + 1) })).toThrow(/safe|overflow|range|maximum/i);
  });

  it.each([
    ["THESIS_MAX_JOB_COST_USD", "-0.01"],
    ["THESIS_MAX_ROLLING_COST_USD", "NaN"],
    ["THESIS_MAX_JOB_COST_USD", "Infinity"],
    ["THESIS_MAX_ROLLING_COST_USD", "1e3"],
    ["THESIS_MAX_JOB_COST_USD", "1,000"],
    ["THESIS_MAX_JOB_COST_USD", "9007199254740992"],
  ])("rejects invalid scheduler USD cap %s=%s", (key, value) => {
    expect(() => parseEnv({ [key]: value })).toThrow();
  });

  it("rejects a raw six-place USD cap that binary conversion rounds outside exact micro-USD range", () => {
    expect(parseEnv({ THESIS_MAX_JOB_COST_USD: "9007199254.740990" }).maxJobCostUsd)
      .toBe(9_007_199_254.74099);
    expect(() => parseEnv({ THESIS_MAX_JOB_COST_USD: "9007199254.740991" }))
      .toThrow(/micro-USD|exact|range/i);
  });
});

describe("getConfig", () => {
  const mutatedKeys = [
    "FMP_API_KEY",
    "ANALYSIS_MODEL",
  ] as const;
  const saved: Partial<Record<(typeof mutatedKeys)[number], string | undefined>> = {};

  afterEach(() => {
    for (const key of mutatedKeys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
      delete saved[key];
    }
    resetConfigCache();
  });

  it("caches the parsed config until reset", () => {
    for (const key of mutatedKeys) saved[key] = process.env[key];

    process.env.FMP_API_KEY = "first-key";
    process.env.ANALYSIS_MODEL = "auto";
    resetConfigCache();

    const first = getConfig();
    expect(first.fmpApiKey).toBe("first-key");
    expect(first.fixtureMode).toBe(false);

    // Mutating the environment does NOT change the cached config...
    process.env.FMP_API_KEY = "second-key";
    const second = getConfig();
    expect(second).toBe(first);
    expect(second.fmpApiKey).toBe("first-key");

    // ...until the cache is explicitly reset.
    resetConfigCache();
    const third = getConfig();
    expect(third.fmpApiKey).toBe("second-key");
  });
});
