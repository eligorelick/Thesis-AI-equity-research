/**
 * The Settings page "resume queued work" control (WS8 R-42/D-21, review F8).
 *
 * The panel is only useful when startup held the queue
 * (`THESIS_RESUME_ON_START=0`), so `SettingsPageView` renders it only when the
 * server reports `capabilities.resumeOnStart === false`. On the default `1` the
 * scheduler already claimed whatever was queued and the button would do nothing
 * visible.
 *
 * This suite runs in the `node` environment with no DOM and no test-renderer
 * dependency, so the click is exercised through the action the button's
 * `onClick` invokes — including the intermediate "resuming" state that disables
 * it — and the wiring between button and action is asserted against the source.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_MODEL_OPTIONS,
  EFFORT_LEVELS,
  type SettingsPayload,
} from "@/settings/contracts";
import type { SettingsPageControllerState } from "@/settings/writeQueue";
import {
  ResumeQueueControl,
  createResumeQueueAction,
  type ResumeQueueState,
} from "@/app/settings/ResumeQueueControl";
import { SettingsPageView } from "@/app/settings/SettingsPageView";

const BUTTON_LABEL = "resume queued work";

function payload(resumeOnStart: boolean): SettingsPayload {
  return {
    analysisModel: "auto",
    analysisModelOptions: [...ANALYSIS_MODEL_OPTIONS],
    analysisEffort: "high",
    analysisEffortOptions: [...EFFORT_LEVELS],
    sources: { analysisModel: "default", analysisEffort: "default" },
    revision: 0,
    capabilities: {
      hasFmpKey: false,
      hasFinnhubKey: false,
      hasFredKey: false,
      hasAnthropicKey: false,
      fixtureMode: false,
      resumeOnStart,
    },
  };
}

function renderSettingsPage(resumeOnStart: boolean): string {
  const state: SettingsPageControllerState = {
    status: "ready",
    payload: payload(resumeOnStart),
    writer: null,
    error: null,
  };
  return renderToStaticMarkup(
    createElement(SettingsPageView, {
      state,
      onAnalysisModel: () => {},
      onAnalysisEffort: () => {},
    }),
  );
}

/** Records every state the action reports, in order. */
function recorder(): { states: ResumeQueueState[]; onState: (next: ResumeQueueState) => void } {
  const states: ResumeQueueState[] = [];
  return { states, onState: (next) => states.push(next) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ResumeQueueControl rendering", () => {
  it("renders an enabled button and says what a held startup is", () => {
    const html = renderToStaticMarkup(createElement(ResumeQueueControl));

    expect(html).toContain(BUTTON_LABEL);
    expect(html).toContain("THESIS_RESUME_ON_START=0");
    expect(html).toContain("queued work");
    // Idle: no badge, and the button is clickable. React emits a set boolean
    // attribute as `disabled=""`; the bare word also appears inside the
    // disabled:opacity-50 utility class, which says nothing about state.
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("resuming");
    expect(html).not.toContain("resume failed");
  });

  it("is offered only when the server says startup held the queue", () => {
    // The default THESIS_RESUME_ON_START=1 is every user's normal case; the
    // panel used to render there too, offering a button with nothing to do.
    expect(renderSettingsPage(true)).not.toContain(BUTTON_LABEL);
    expect(renderSettingsPage(false)).toContain(BUTTON_LABEL);
  });

  it("wires the button's onClick to the exported action", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src", "app", "settings", "ResumeQueueControl.tsx"),
      "utf8",
    );
    expect(source).toContain("createResumeQueueAction(setState)");
    expect(source).toContain("onClick={resume}");
    expect(source).toContain("void action();");
    // The panel never posts anywhere else.
    expect(source.match(/fetchImpl\(/g) ?? []).toHaveLength(1);
    expect(source).toContain('"/api/jobs/resume"');
  });
});

describe("ResumeQueueControl click", () => {
  it("posts to /api/jobs/resume and reports the queue it released", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const { states, onState } = recorder();
    const action = createResumeQueueAction(onState, (async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return jsonResponse({ resumed: true, queued: 2 });
    }) as typeof fetch);

    await action();

    expect(calls).toEqual([{ url: "/api/jobs/resume", method: "POST" }]);
    expect(states).toEqual([
      { status: "resuming", detail: null },
      {
        status: "resumed",
        detail: "the scheduler is running; 2 queued jobs may now start",
      },
    ]);
  });

  it("says so when the queue was already empty, in the singular for one job", async () => {
    const empty = recorder();
    await createResumeQueueAction(
      empty.onState,
      (async () => jsonResponse({ resumed: true, queued: 0 })) as typeof fetch,
    )();
    expect(empty.states.at(-1)).toEqual({
      status: "resumed",
      detail: "the scheduler is running; no job was waiting in the queue",
    });

    const single = recorder();
    await createResumeQueueAction(
      single.onState,
      (async () => jsonResponse({ resumed: true, queued: 1 })) as typeof fetch,
    )();
    expect(single.states.at(-1)).toEqual({
      status: "resumed",
      detail: "the scheduler is running; 1 queued job may now start",
    });
  });

  it("never claims a resume when the server refuses or the request fails", async () => {
    const refused = recorder();
    await createResumeQueueAction(
      refused.onState,
      (async () => jsonResponse({ error: "cross-origin request rejected" }, 403)) as typeof fetch,
    )();
    expect(refused.states.at(-1)).toEqual({
      status: "error",
      detail: "the server refused the resume (HTTP 403)",
    });

    const unreachable = recorder();
    await createResumeQueueAction(
      unreachable.onState,
      (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    )();
    expect(unreachable.states.at(-1)).toEqual({
      status: "error",
      detail: "the resume request could not be sent",
    });

    // Both paths still passed through "resuming", which disables the button.
    for (const { states } of [refused, unreachable]) {
      expect(states[0]).toEqual({ status: "resuming", detail: null });
      expect(states).toHaveLength(2);
    }
  });
});
