import { afterEach, describe, expect, it, vi } from "vitest";

const { bootstrapReportScheduler } = vi.hoisted(() => ({
  bootstrapReportScheduler: vi.fn(),
}));

vi.mock("@/pipeline/jobSchedulerBootstrap", () => ({ bootstrapReportScheduler }));

import { register } from "@/instrumentation";

const ORIGINAL_RUNTIME = process.env.NEXT_RUNTIME;
const ORIGINAL_PHASE = process.env.NEXT_PHASE;

afterEach(() => {
  bootstrapReportScheduler.mockReset();
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

  it("keeps Edge startup inert", async () => {
    process.env.NEXT_RUNTIME = "edge";
    delete process.env.NEXT_PHASE;

    await register();

    expect(bootstrapReportScheduler).not.toHaveBeenCalled();
  });

  it("keeps production-build evaluation inert", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NEXT_PHASE = "phase-production-build";

    await register();

    expect(bootstrapReportScheduler).not.toHaveBeenCalled();
  });
});
