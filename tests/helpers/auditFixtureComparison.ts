import { isDeepStrictEqual } from "node:util";

import { runStageB } from "@/pipeline/compute";
import { buildDataBundle } from "@/pipeline/dataBundle";
import { validateBundle } from "@/pipeline/stageA/validate";
import { assembleReport } from "@/pipeline/stageC/passes";
import { createFmpClient } from "@/providers/fmp";
import { EdgarClient } from "@/providers/edgar";
import { JUDGE_OUTPUT_SCHEMA, ReportSchema } from "@/report/schema";

export type AuditJsonPrimitive = null | boolean | number | string;
export type AuditJsonValue =
  | AuditJsonPrimitive
  | AuditJsonValue[]
  | { [key: string]: AuditJsonValue };

export const AUDIT_FIXTURE_FIXED_NOW = "2026-07-06T00:00:00.000Z";
export const AUDIT_FIXTURE_GENERATED_AT = "2026-07-06T12:00:00.000Z";

const PROVIDER_ENV_KEYS = [
  "FMP_API_KEY",
  "FINNHUB_API_KEY",
  "FRED_API_KEY",
  "ANTHROPIC_API_KEY",
  "EDGAR_CONTACT",
] as const;

export interface AuditFixturePaths {
  fmpFixtures: string;
  reportFixture: string;
}

export interface AuditFixtureCallCounts {
  globalFetch: number;
  fmpLiveFetch: number;
  finnhubLiveFetch: number;
  finraGapTransport: number;
  edgarGapTransport: number;
  fredGap: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function plainEntries(value: object, path: string): [string, unknown][] {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`non-plain object at ${path}`);
  }
  const enumerableKeys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== enumerableKeys.length) {
    fail(`non-enumerable or symbol property at ${path}`);
  }
  return enumerableKeys.map((key) => [key, (value as Record<string, unknown>)[key]]);
}

function assertCanonicalArray(value: unknown[], path: string): void {
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = [
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    "length",
  ];
  if (
    ownKeys.length !== expectedKeys.length ||
    expectedKeys.some((key, index) => ownKeys[index] !== key)
  ) {
    fail(`non-canonical array property at ${path}`);
  }
}

function assertProviderCredentialsAbsent(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    if ((process.env[key] ?? "").trim() !== "") {
      fail(`provider-free audit fixture received credential ${key}`);
    }
  }
}

export function assertAuditJsonSafe(value: unknown, path = "$audit"): asserts value is AuditJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`non-finite number at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    assertCanonicalArray(value, path);
    value.forEach((entry, index) => assertAuditJsonSafe(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of plainEntries(value, path)) {
      assertAuditJsonSafe(entry, `${path}.${key}`);
    }
    return;
  }
  fail(`non-JSON ${typeof value} at ${path}`);
}

function toAuditJson(value: unknown): AuditJsonValue {
  const normalize = (entry: unknown, path: string): AuditJsonValue => {
    if (entry === undefined) return { $auditUndefined: true };
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) fail(`non-finite number at ${path}`);
      return entry;
    }
    if (Array.isArray(entry)) {
      assertCanonicalArray(entry, path);
      return entry.map((child, index) => normalize(child, `${path}[${index}]`));
    }
    if (typeof entry === "object") {
      return Object.fromEntries(
        plainEntries(entry, path).map(([key, child]) => [key, normalize(child, `${path}.${key}`)]),
      );
    }
    fail(`non-JSON ${typeof entry} at ${path}`);
  };
  const normalized = normalize(value, "$audit");
  assertAuditJsonSafe(normalized);
  return normalized;
}

function project(
  bundle: Awaited<ReturnType<typeof buildDataBundle>>,
  computed: ReturnType<typeof runStageB>,
  report: ReturnType<typeof assembleReport>,
): AuditJsonValue {
  const quotePrice = bundle.quote.ok
    ? bundle.quote.value.data.rows[0]?.price ?? null
    : null;
  const reportWithoutRawSourceEnvelopes = {
    ...report,
    appendix: {
      ...report.appendix,
      sources: "<raw provider source envelopes verified by dedicated provenance suites>",
    },
  };
  return toAuditJson({
    fixtureControl: {
      symbol: bundle.symbol,
      companyName: report.meta.companyName,
      quotePrice,
    },
    stageB: computed,
    report: reportWithoutRawSourceEnvelopes,
  });
}

function assertUnchanged(label: string, value: unknown, before: unknown): void {
  if (!isDeepStrictEqual(value, before)) fail(`${label} mutated during fixture comparison`);
}

export async function buildAuditFixtureComparison(
  paths: AuditFixturePaths,
): Promise<{
  projection: AuditJsonValue;
  repeatedProjection: AuditJsonValue;
  calls: AuditFixtureCallCounts;
  reportCostUsd: number;
  reportModel: string;
}> {
  assertProviderCredentialsAbsent();

  const calls: AuditFixtureCallCounts = {
    globalFetch: 0,
    fmpLiveFetch: 0,
    finnhubLiveFetch: 0,
    finraGapTransport: 0,
    edgarGapTransport: 0,
    fredGap: 0,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    calls.globalFetch += 1;
    return Promise.reject(new Error("provider-free fixture invoked global fetch"));
  };

  try {
    const fixedDate = new Date(AUDIT_FIXTURE_FIXED_NOW);
    const fmp = createFmpClient({
      apiKey: "",
      fixturesDir: paths.fmpFixtures,
      now: () => fixedDate,
      fetchImpl: () => {
        calls.fmpLiveFetch += 1;
        return Promise.reject(new Error("fixture-mode FMP invoked live fetch"));
      },
    });
    const edgar = new EdgarClient({
      transport: {
        fetchText: async () => {
          calls.edgarGapTransport += 1;
          return {
            status: 404,
            body: "",
            fetchedAt: AUDIT_FIXTURE_FIXED_NOW,
            fromCache: false,
            stale: false,
          };
        },
      },
    });
    const fredGap = async (id: string) => {
      calls.fredGap += 1;
      return {
        ok: false as const,
        gap: {
          field: `fred.${id}`,
          reason: "offline fixture",
          severity: "info" as const,
          attemptedSources: ["fixture"],
        },
      };
    };

    const bundle = await buildDataBundle("DEMO", {
      now: () => fixedDate,
      fmp,
      edgar,
      fredFetch: fredGap,
      finnhub: {
        fetchImpl: () => {
          calls.finnhubLiveFetch += 1;
          return Promise.reject(new Error("keyless Finnhub invoked live fetch"));
        },
      },
      finra: {
        fetchImpl: async () => {
          calls.finraGapTransport += 1;
          return new Response("offline fixture", { status: 503 });
        },
        retryDelaysMs: [],
        minRequestIntervalMs: 0,
        timeoutMs: 100,
      },
      edgarSectionBudgetMs: 100,
    });

    const pristineBundle = structuredClone(bundle);
    const validation = validateBundle(bundle, { now: fixedDate });
    const computed = runStageB(bundle);
    assertUnchanged("bundle before Stage B", bundle, pristineBundle);

    const fixture = ReportSchema.parse(JSON.parse(await BunlessRead(paths.reportFixture)));
    const pipelineOwnedReportKeys = new Set([
      "meta",
      "appendix",
      "scores",
      "projections",
      "scenarioTargets",
      "fairValue",
    ]);
    const judgeCandidate = Object.fromEntries(
      Object.entries(fixture).filter(([key]) => !pipelineOwnedReportKeys.has(key)),
    );
    const judgeOutput = JUDGE_OUTPUT_SCHEMA.parse(judgeCandidate);
    const bundleBeforeAssembly = structuredClone(bundle);
    const computedBeforeAssembly = structuredClone(computed);
    const judgeBeforeAssembly = structuredClone(judgeOutput);
    const assemble = (
      inputBundle: typeof bundle,
      inputComputed: typeof computed,
      inputJudge: typeof judgeOutput,
    ) =>
      assembleReport(
        {
          symbol: "DEMO",
          bundle: inputBundle,
          computed: inputComputed,
          judgeOutput: inputJudge,
          verify: {
            verificationRate: fixture.meta.verificationRate,
            coverage: fixture.meta.provenanceCoverage,
            log: [],
          },
          costEntries: [],
          model: "synthetic-fixture",
          pipelineVersion: "audit-fixture-comparison",
          validationGaps: validation.gaps,
        },
        AUDIT_FIXTURE_GENERATED_AT,
      );
    const report = assemble(bundle, computed, judgeOutput);
    assertUnchanged("bundle during report assembly", bundle, bundleBeforeAssembly);
    assertUnchanged("computed metrics during report assembly", computed, computedBeforeAssembly);
    assertUnchanged("judge output during report assembly", judgeOutput, judgeBeforeAssembly);

    const repeatedBundle = structuredClone(pristineBundle);
    const repeatedValidation = validateBundle(repeatedBundle, { now: fixedDate });
    const repeatedComputed = runStageB(repeatedBundle);
    const repeatedJudge = structuredClone(judgeBeforeAssembly);
    const repeatedReport = assembleReport(
      {
        symbol: "DEMO",
        bundle: repeatedBundle,
        computed: repeatedComputed,
        judgeOutput: repeatedJudge,
        verify: {
          verificationRate: fixture.meta.verificationRate,
          coverage: fixture.meta.provenanceCoverage,
          log: [],
        },
        costEntries: [],
        model: "synthetic-fixture",
        pipelineVersion: "audit-fixture-comparison",
        validationGaps: repeatedValidation.gaps,
      },
      AUDIT_FIXTURE_GENERATED_AT,
    );

    const projection = project(bundle, computed, report);
    const repeatedProjection = project(repeatedBundle, repeatedComputed, repeatedReport);
    return {
      projection,
      repeatedProjection,
      calls,
      reportCostUsd: report.meta.costUsd,
      reportModel: report.meta.model,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function BunlessRead(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
}

if (process.env.AUDIT_FIXTURE_EMIT === "1") {
  const root = process.cwd();
  void buildAuditFixtureComparison({
    fmpFixtures: `${root}/fixtures/fmp`,
    reportFixture: `${root}/fixtures/report/DEMO-sample.json`,
  })
    .then(async ({ projection }) => {
      const serialized = `${JSON.stringify(projection)}\n`;
      const output = process.env.AUDIT_FIXTURE_OUTPUT;
      if (output === undefined || output === "") {
        process.stdout.write(serialized);
        return;
      }
      const { writeFile } = await import("node:fs/promises");
      await writeFile(output, serialized, "utf8");
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
