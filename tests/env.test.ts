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
