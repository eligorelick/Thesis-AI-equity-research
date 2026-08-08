import { describe, expect, it, vi } from "vitest";

import {
  createTerminalResumeRequestFence,
  fetchTerminalResumable,
  refreshTerminalResumableState,
  shouldShowServerRetry,
} from "@/app/company/[symbol]/GenerateReport";
import type { StepProgress } from "@/types/core";

const terminalContext = {
  busy: false,
  jobId: "job-authority",
  phase: "error" as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("GenerateReport — authoritative retry client contract", () => {
  it("shows Retry from server true even when display steps say synthesis completed", async () => {
    const lyingSteps: StepProgress[] = [
      { step: "bull", status: "error" },
      { step: "bear", status: "error" },
      { step: "synthesize", status: "done" },
    ];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      status: "error",
      steps: lyingSteps,
      resumable: true,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const resumable = await fetchTerminalResumable("job-authority", fetcher);

    expect(resumable).toBe(true);
    expect(shouldShowServerRetry({ ...terminalContext, resumable })).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/report/job-authority",
      { cache: "no-store" },
    );
  });

  it("hides Retry from server false even when display steps mimic the old resumable shape", async () => {
    const lyingSteps: StepProgress[] = [
      { step: "bull", status: "done" },
      { step: "bear", status: "done" },
      { step: "synthesize", status: "error" },
    ];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      status: "error",
      steps: lyingSteps,
      resumable: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const resumable = await fetchTerminalResumable("job-authority", fetcher);

    expect(resumable).toBe(false);
    expect(shouldShowServerRetry({ ...terminalContext, resumable })).toBe(false);
  });

  it("does not install job A authority after a newer job B terminal refresh wins", async () => {
    const oldResponse = deferred<Response>();
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/job-A")) return oldResponse.promise;
      return new Response(JSON.stringify({ resumable: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const fence = createTerminalResumeRequestFence();
    const installed: Array<{ jobId: string; resumable: boolean }> = [];
    const oldRefresh = refreshTerminalResumableState(
      "job-A",
      fence,
      (jobId, resumable) => installed.push({ jobId, resumable }),
      fetcher,
    );
    const currentRefresh = refreshTerminalResumableState(
      "job-B",
      fence,
      (jobId, resumable) => installed.push({ jobId, resumable }),
      fetcher,
    );
    await currentRefresh;
    oldResponse.resolve(new Response(JSON.stringify({ resumable: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await oldRefresh;

    expect(installed).toEqual([{ jobId: "job-B", resumable: false }]);
  });
});
