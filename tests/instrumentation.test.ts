import { afterEach, describe, expect, it, vi } from "vitest";

const { bootstrapReportScheduler, ensureRequestToken } = vi.hoisted(() => ({
  bootstrapReportScheduler: vi.fn(),
  ensureRequestToken: vi.fn(() => ({
    token: "0".repeat(64),
    path: "test-data-dir/csrf-token",
    persisted: true,
  })),
}));

vi.mock("@/pipeline/jobSchedulerBootstrap", () => ({ bootstrapReportScheduler }));
vi.mock("@/app/api/sameOrigin", () => ({ ensureRequestToken }));

import { register } from "@/instrumentation";

const ORIGINAL_RUNTIME = process.env.NEXT_RUNTIME;
const ORIGINAL_PHASE = process.env.NEXT_PHASE;

afterEach(() => {
  bootstrapReportScheduler.mockReset();
  ensureRequestToken.mockClear();
  vi.restoreAllMocks();
  if (ORIGINAL_RUNTIME === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = ORIGINAL_RUNTIME;
  if (ORIGINAL_PHASE === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = ORIGINAL_PHASE;
});

describe("scheduler startup instrumentation", () => {
  it("bootstraps the durable scheduler on a Node server start", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.NEXT_PHASE;

    await register();

    expect(bootstrapReportScheduler).toHaveBeenCalledOnce();
  });

  it("mints the X-Thesis-Token before the scheduler and logs only its path", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.NEXT_PHASE;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const order: string[] = [];
    ensureRequestToken.mockImplementationOnce(() => {
      order.push("token");
      return { token: "f".repeat(64), path: "test-data-dir/csrf-token", persisted: true };
    });
    bootstrapReportScheduler.mockImplementationOnce(async () => {
      order.push("scheduler");
    });

    await register();

    expect(order).toEqual(["token", "scheduler"]);
    expect(info).toHaveBeenCalledOnce();
    const line = String(info.mock.calls[0]?.[0]);
    expect(line).toContain("test-data-dir/csrf-token");
    expect(line).not.toContain("f".repeat(64));
  });

  it("stays quiet when the token file could not be written (the guard already warned)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.NEXT_PHASE;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    ensureRequestToken.mockReturnValueOnce({
      token: "a".repeat(64),
      path: "test-data-dir/csrf-token",
      persisted: false,
    });

    await register();

    expect(info).not.toHaveBeenCalled();
    expect(bootstrapReportScheduler).toHaveBeenCalledOnce();
  });

  it("keeps Edge startup inert", async () => {
    process.env.NEXT_RUNTIME = "edge";
    delete process.env.NEXT_PHASE;

    await register();

    expect(bootstrapReportScheduler).not.toHaveBeenCalled();
    expect(ensureRequestToken).not.toHaveBeenCalled();
  });

  it("keeps production-build evaluation inert", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NEXT_PHASE = "phase-production-build";

    await register();

    expect(bootstrapReportScheduler).not.toHaveBeenCalled();
    expect(ensureRequestToken).not.toHaveBeenCalled();
  });
});
