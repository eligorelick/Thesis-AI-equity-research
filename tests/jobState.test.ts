import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createDatabase, type DatabaseHandle, type ThesisDb } from "@/db";
import { jobs, reports } from "@/db/schema";
import { mutateJobSnapshot, renewInvisibleJobLease } from "@/pipeline/jobState";
import { initialSteps } from "@/pipeline/jobRunner";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const directories: string[] = [];

function databasePair(): [DatabaseHandle, DatabaseHandle] {
  const directory = mkdtempSync(join(tmpdir(), "thesis-job-state-"));
  directories.push(directory);
  const file = join(directory, "state.db");
  return [createDatabase(file), createDatabase(file)];
}

function seed(db: ThesisDb, id = "state-job"): void {
  db.insert(jobs).values({
    id,
    symbol: "AAPL",
    status: "queued",
    stepsJson: JSON.stringify(initialSteps()),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    queuedAt: NOW.toISOString(),
  }).run();
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("canonical job snapshot mutations", () => {
  it("starts at revision zero and commits a multi-field mutation with exactly one increment", () => {
    const [first, second] = databasePair();
    try {
      seed(first.db);
      expect(first.db.select().from(jobs).where(eq(jobs.id, "state-job")).get()?.revision)
        .toBe(0);

      const result = mutateJobSnapshot({
        jobId: "state-job",
        now: new Date(NOW.getTime() + 1),
        fence: { runGeneration: 0, status: "queued" },
        mutate: (row) => ({
          status: "running",
          error: null,
          stepsJson: row.stepsJson.replace('"pending"', '"running"'),
          leaseOwner: "worker:nonce",
          leaseExpiresAt: "2999-01-01T00:00:00.000Z",
          heartbeatAt: "2026-08-08T12:00:00.001Z",
        }),
      }, second.db);

      expect(result).toMatchObject({ revision: 1 });
      expect(first.db.select().from(jobs).where(eq(jobs.id, "state-job")).get()).toMatchObject({
        status: "running",
        revision: 1,
        leaseOwner: "worker:nonce",
        updatedAt: "2026-08-08T12:00:00.001Z",
      });
    } finally {
      first.sqlite.close();
      second.sqlite.close();
    }
  });

  it("does not increment for an exact no-op, stale fence, or rolled-back callback", () => {
    const [first, second] = databasePair();
    try {
      seed(first.db);
      expect(mutateJobSnapshot({
        jobId: "state-job",
        now: NOW,
        fence: { runGeneration: 0, status: "queued" },
        mutate: () => ({ status: "queued" }),
      }, first.db)).toBeNull();
      expect(mutateJobSnapshot({
        jobId: "state-job",
        now: NOW,
        fence: { runGeneration: 1, status: "queued" },
        mutate: () => ({ status: "error" }),
      }, second.db)).toBeNull();
      expect(() => mutateJobSnapshot({
        jobId: "state-job",
        now: NOW,
        fence: { runGeneration: 0, status: "queued" },
        mutate: () => {
          throw new Error("injected mutation failure");
        },
      }, first.db)).toThrow("injected mutation failure");
      expect(second.db.select().from(jobs).where(eq(jobs.id, "state-job")).get()?.revision)
        .toBe(0);
    } finally {
      first.sqlite.close();
      second.sqlite.close();
    }
  });

  it("keeps repeated identical progress at the same revision under a queued null-owner fence", () => {
    const [first, second] = databasePair();
    try {
      seed(first.db);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(mutateJobSnapshot({
          jobId: "state-job",
          now: new Date(NOW.getTime() + attempt + 1),
          fence: { runGeneration: 0, status: "queued", leaseOwner: null },
          mutate: (row) => ({ stepsJson: row.stepsJson }),
        }, second.db)).toBeNull();
      }
      expect(first.db.select().from(jobs).where(eq(jobs.id, "state-job")).get())
        .toMatchObject({ revision: 0, leaseOwner: null, updatedAt: NOW.toISOString() });

      expect(mutateJobSnapshot({
        jobId: "state-job",
        now: new Date(NOW.getTime() + 3),
        fence: { runGeneration: 0, status: "queued", leaseOwner: null },
        mutate: () => ({ error: "visible queued change" }),
      }, first.db)).toMatchObject({ revision: 1 });
    } finally {
      first.sqlite.close();
      second.sqlite.close();
    }
  });

  it("rebases sequential writers from two connections into one monotonic revision order", () => {
    const [first, second] = databasePair();
    try {
      seed(first.db);
      const firstResult = mutateJobSnapshot({
        jobId: "state-job",
        now: new Date(NOW.getTime() + 1),
        fence: { runGeneration: 0, status: "queued" },
        mutate: () => ({ error: "first visible change" }),
      }, first.db);
      const secondResult = mutateJobSnapshot({
        jobId: "state-job",
        now: new Date(NOW.getTime() + 2),
        fence: { runGeneration: 0, status: "queued" },
        mutate: (row) => ({ error: `${row.error}; second visible change` }),
      }, second.db);

      expect([firstResult?.revision, secondResult?.revision]).toEqual([1, 2]);
      expect(first.db.select().from(jobs).where(eq(jobs.id, "state-job")).get())
        .toMatchObject({ revision: 2, error: "first visible change; second visible change" });
    } finally {
      first.sqlite.close();
      second.sqlite.close();
    }
  });

  it("renews an exact live lease without changing revision or client updatedAt", () => {
    const [first, second] = databasePair();
    try {
      seed(first.db);
      first.db.update(jobs).set({
        status: "running",
        leaseOwner: "worker:nonce",
        heartbeatAt: NOW.toISOString(),
        leaseExpiresAt: new Date(NOW.getTime() + 1_000).toISOString(),
      }).where(eq(jobs.id, "state-job")).run();
      const original = first.db.select().from(jobs).where(eq(jobs.id, "state-job")).get()!;

      expect(renewInvisibleJobLease({
        jobId: "state-job",
        runGeneration: 0,
        leaseOwner: "worker:nonce",
        now: new Date(NOW.getTime() + 500),
        leaseTtlMs: 1_500,
      }, second.db)).toBe(true);
      expect(second.db.select().from(jobs).where(eq(jobs.id, "state-job")).get()).toMatchObject({
        revision: original.revision,
        updatedAt: original.updatedAt,
        heartbeatAt: new Date(NOW.getTime() + 500).toISOString(),
        leaseExpiresAt: new Date(NOW.getTime() + 2_000).toISOString(),
      });

      expect(renewInvisibleJobLease({
        jobId: "state-job",
        runGeneration: 0,
        leaseOwner: "different-worker",
        now: new Date(NOW.getTime() + 600),
        leaseTtlMs: 2_400,
      }, first.db)).toBe(false);
      expect(renewInvisibleJobLease({
        jobId: "state-job",
        runGeneration: 0,
        leaseOwner: "worker:nonce",
        now: new Date(NOW.getTime() + 2_001),
        leaseTtlMs: 1_999,
      }, first.db)).toBe(false);
    } finally {
      first.sqlite.close();
      second.sqlite.close();
    }
  });

  it.each([-1, Number.MAX_SAFE_INTEGER + 1])(
    "fails closed on unsafe stored revision %s",
    (revision) => {
      const [first, second] = databasePair();
      try {
        seed(first.db);
        first.db.update(jobs).set({ revision }).where(eq(jobs.id, "state-job")).run();
        expect(() => mutateJobSnapshot({
          jobId: "state-job",
          now: NOW,
          fence: { runGeneration: 0, status: "queued" },
          mutate: () => ({ error: "must not commit" }),
        }, second.db)).toThrow(/invalid|unsafe.*revision/i);
        expect(first.db.select().from(jobs).where(eq(jobs.id, "state-job")).get())
          .toMatchObject({ revision, error: null });
      } finally {
        first.sqlite.close();
        second.sqlite.close();
      }
    },
  );

  it("rolls back instead of overflowing a maximum safe stored revision", () => {
    const [first, second] = databasePair();
    try {
      seed(first.db);
      first.db.update(jobs).set({ revision: Number.MAX_SAFE_INTEGER })
        .where(eq(jobs.id, "state-job")).run();
      expect(() => mutateJobSnapshot({
        jobId: "state-job",
        now: NOW,
        fence: { runGeneration: 0, status: "queued" },
        mutate: () => ({ error: "must not overflow" }),
      }, second.db)).toThrow(/overflow|safe.*revision/i);
      expect(first.db.select().from(jobs).where(eq(jobs.id, "state-job")).get())
        .toMatchObject({ revision: Number.MAX_SAFE_INTEGER, error: null });
    } finally {
      first.sqlite.close();
      second.sqlite.close();
    }
  });

  it("links a terminal report and records unsupported terminal metadata with one bump each", () => {
    const [first, second] = databasePair();
    try {
      seed(first.db);
      const report = first.db.insert(reports).values({
        symbol: "AAPL",
        createdAt: NOW.toISOString(),
        model: "test-model",
        status: "done",
      }).returning({ id: reports.id }).get();
      expect(mutateJobSnapshot({
        jobId: "state-job",
        now: new Date(NOW.getTime() + 1),
        fence: { runGeneration: 0, status: "queued" },
        mutate: () => ({ status: "done", reportId: report.id, error: null }),
      }, first.db)).toMatchObject({ revision: 1 });
      expect(mutateJobSnapshot({
        jobId: "state-job",
        now: new Date(NOW.getTime() + 2),
        fence: { runGeneration: 0, status: "done" },
        mutate: () => ({
          status: "unsupported",
          reportId: null,
          unsupportedKind: "etf",
          unsupportedMessage: "companies only",
          error: null,
        }),
      }, second.db)).toMatchObject({ revision: 2 });
      expect(first.db.select().from(jobs).where(eq(jobs.id, "state-job")).get())
        .toMatchObject({
          revision: 2,
          status: "unsupported",
          reportId: null,
          unsupportedKind: "etf",
          unsupportedMessage: "companies only",
        });
    } finally {
      first.sqlite.close();
      second.sqlite.close();
    }
  });
});
