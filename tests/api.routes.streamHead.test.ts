import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Next.js answers HEAD by invoking the GET handler and discarding the body. For
 * an SSE route that means a HEAD probe would build the ReadableStream, register
 * a job subscriber and arm the poll/heartbeat timers — resources a bodiless
 * response never releases. HEAD must therefore be handled explicitly and
 * allocate nothing.
 */
const hook = vi.hoisted(() => ({ subscribeCalls: 0, existing: new Set<string>(["job-1"]) }));

vi.mock("@/pipeline/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/events")>();
  return {
    ...actual,
    jobExists: (jobId: string) => hook.existing.has(jobId),
    getJobSnapshot: () => null,
    subscribeJob: (jobId: string, callback: Parameters<typeof actual.subscribeJob>[1]) => {
      hook.subscribeCalls += 1;
      return actual.subscribeJob(jobId, callback);
    },
  };
});

describe("HEAD on the job event stream", () => {
  it("answers without subscribing or arming timers", async () => {
    const route = await import("@/app/api/report/[jobId]/stream/route");
    expect(typeof route.HEAD).toBe("function");

    hook.subscribeCalls = 0;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const res = await route.HEAD(
      new Request("http://127.0.0.1/api/report/job-1/stream", { method: "HEAD" }),
      { params: Promise.resolve({ jobId: "job-1" }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).toBeNull();
    expect(hook.subscribeCalls).toBe(0);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it("still reports 404 for an unknown job and subscribes to nothing", async () => {
    const route = await import("@/app/api/report/[jobId]/stream/route");

    hook.subscribeCalls = 0;
    const res = await route.HEAD(
      new Request("http://127.0.0.1/api/report/nope/stream", { method: "HEAD" }),
      { params: Promise.resolve({ jobId: "nope" }) },
    );

    expect(res.status).toBe(404);
    expect(hook.subscribeCalls).toBe(0);
  });
});
