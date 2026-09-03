import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ANALYSIS_MODEL_OPTIONS } from "@/settings/contracts";
import type {
  EffectiveSettings,
  SettingsPayload,
  WritableSettings,
} from "@/settings/contracts";
import {
  createSettingsPageController,
  settingsModelOptionsForDisplay,
  type SettingsPageControllerState,
} from "@/settings/writeQueue";
import { SettingsPageView } from "@/app/settings/SettingsPageView";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  // Response.json() itself crosses several microtask turns in Node. Give the
  // strict response decoder time to finish before observing a queued tail.
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

const INITIAL: EffectiveSettings = {
  analysisModel: "auto",
  analysisEffort: "high",
};

const A: WritableSettings = {
  analysisModel: "auto",
  analysisEffort: "medium",
};

const B: WritableSettings = {
  analysisModel: "claude-opus-4-8",
  analysisEffort: "medium",
};

const C: WritableSettings = {
  analysisModel: "claude-opus-4-8",
  analysisEffort: "max",
};

function payload(
  state: EffectiveSettings,
  revision: number,
  sources: SettingsPayload["sources"] = {
    analysisModel: "database",
    analysisEffort: "database",
  },
): SettingsPayload {
  return {
    ...state,
    analysisModelOptions: [...ANALYSIS_MODEL_OPTIONS],
    analysisEffortOptions: ["low", "medium", "high", "xhigh", "max"],
    sources: { ...sources },
    revision,
    capabilities: {
      hasFmpKey: false,
      hasFinnhubKey: false,
      hasFredKey: false,
      hasAnthropicKey: false,
      fixtureMode: true,
      resumeOnStart: true,
    },
  };
}

function jsonResponse(
  body: unknown,
  etag: string | null,
  status = 200,
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (etag !== null) headers.set("etag", etag);
  return new Response(JSON.stringify(body), { status, headers });
}

describe("settings page controller", () => {
  it("loads a coherent ETag authority, posts one full pair at a time, and renders desired C while A settles", async () => {
    const firstPost = deferred<Response>();
    const tailPost = deferred<Response>();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return Promise.resolve(jsonResponse(payload(INITIAL, 0), '"settings-0"'));
      }
      return calls.length === 2 ? firstPost.promise : tailPost.promise;
    });
    const states: SettingsPageControllerState[] = [];
    const controller = createSettingsPageController({
      fetcher,
      onState: (state) => states.push(structuredClone(state)),
    });

    await controller.start();
    expect(calls[0]).toMatchObject({
      url: "/api/settings",
      init: { cache: "no-store" },
    });
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(states.at(-1)).toMatchObject({
      status: "ready",
      payload: payload(INITIAL, 0),
      writer: { status: "idle", desired: INITIAL },
    });

    controller.setAnalysisEffort(A.analysisEffort);
    await settle();
    controller.setAnalysisModel(B.analysisModel);
    controller.setAnalysisEffort(C.analysisEffort);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ url: "/api/settings", init: { method: "POST" } });
    expect(new Headers(calls[1]!.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(new Headers(calls[1]!.init?.headers).get("if-match")).toBe('"settings-0"');
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual(A);
    expect(calls[1]!.init?.signal).toBeUndefined();
    expect(states.at(-1)).toMatchObject({
      status: "ready",
      payload: payload(C, 0),
      writer: { status: "saving", desired: C },
    });

    const beforeA = states.length;
    firstPost.resolve(jsonResponse(payload(A, 1), '"settings-1"'));
    await settle();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ url: "/api/settings", init: { method: "POST" } });
    expect(new Headers(calls[2]!.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(new Headers(calls[2]!.init?.headers).get("if-match")).toBe('"settings-1"');
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual(C);
    expect(calls[2]!.init?.signal).toBeUndefined();
    const afterA = states.slice(beforeA);
    expect(afterA.length).toBeGreaterThan(0);
    for (const state of afterA) {
      expect(state).toMatchObject({
        status: "ready",
        payload: payload(C, 1),
        writer: { status: "saving", desired: C },
      });
      expect(state.writer?.status).not.toBe("saved");
    }

    tailPost.resolve(jsonResponse(payload(C, 2), '"settings-2"'));
    await controller.flush();
    expect(states.at(-1)).toMatchObject({
      status: "ready",
      payload: payload(C, 2),
      writer: { status: "saved", desired: C },
    });
  });

  it("GET-recovers after a 412, ignores its body, installs recovery authority, and never replays the tail", async () => {
    const external: EffectiveSettings = {
      analysisModel: "claude-sonnet-5",
      analysisEffort: "low",
    };
    const misleading412: EffectiveSettings = {
      analysisModel: "claude-fable-5",
      analysisEffort: "xhigh",
    };
    const post = deferred<Response>();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return Promise.resolve(jsonResponse(payload(INITIAL, 0), '"settings-0"'));
      }
      if (calls.length === 2) {
        return post.promise;
      }
      return Promise.resolve(jsonResponse(payload(external, 9), '"settings-9"'));
    });
    const states: SettingsPageControllerState[] = [];
    const controller = createSettingsPageController({
      fetcher,
      onState: (state) => states.push(structuredClone(state)),
    });

    await controller.start();
    controller.setAnalysisEffort(A.analysisEffort);
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ url: "/api/settings", init: { method: "POST" } });
    expect(new Headers(calls[1]!.init?.headers).get("if-match")).toBe('"settings-0"');
    expect(new Headers(calls[1]!.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual(A);
    controller.setAnalysisModel(C.analysisModel);
    controller.setAnalysisEffort(C.analysisEffort);
    const before412 = states.length;
    post.resolve(jsonResponse(payload(misleading412, 8), '"settings-8"', 412));
    await controller.flush();

    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ url: "/api/settings", init: { cache: "no-store" } });
    expect(calls[2]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
    expect(states.some((state) => state.writer?.status === "recovering")).toBe(true);
    expect(states.slice(before412).every((state) =>
      state.payload?.analysisModel !== misleading412.analysisModel &&
      state.payload?.analysisEffort !== misleading412.analysisEffort
    )).toBe(true);
    expect(states.at(-1)).toMatchObject({
      status: "ready",
      payload: payload(external, 9),
      writer: { status: "error", desired: external },
    });
    expect(states.at(-1)!.payload).not.toMatchObject(misleading412);
  });

  it("preserves and visibly offers an unlisted valid dated current model for carry-only effort edits", async () => {
    const dated = "claude-haiku-4-5-20251001" as const;
    const current = payload(
      { analysisModel: dated, analysisEffort: "high" },
      4,
      { analysisModel: "environment", analysisEffort: "default" },
    );
    const post = deferred<Response>();
    const calls: Array<{ init: RequestInit | undefined }> = [];
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      calls.push({ init });
      return calls.length === 1
        ? Promise.resolve(jsonResponse(current, '"settings-4"'))
        : post.promise;
    });
    const controller = createSettingsPageController({ fetcher, onState: vi.fn() });

    await controller.start();
    expect(settingsModelOptionsForDisplay(dated, current.analysisModelOptions)).toEqual([
      { value: dated, carryOnly: true, unsupported: false },
      ...current.analysisModelOptions.map((value) => ({
        value,
        carryOnly: false,
        unsupported: false,
      })),
    ]);
    controller.setAnalysisEffort("medium");
    await settle();
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      analysisModel: dated,
      analysisEffort: "medium",
    });
    post.resolve(jsonResponse(
      payload(
        { analysisModel: dated, analysisEffort: "medium" },
        5,
        { analysisModel: "environment", analysisEffort: "database" },
      ),
      '"settings-5"',
    ));
    await controller.flush();
  });

  it.each([
    ["missing ETag", jsonResponse(payload(INITIAL, 0), null)],
    ["weak ETag", jsonResponse(payload(INITIAL, 0), 'W/"settings-0"')],
    ["ETag list", jsonResponse(payload(INITIAL, 0), '"a", "b"')],
    ["null payload", jsonResponse(null, '"settings-0"')],
    [
      "extra payload key",
      jsonResponse({ ...payload(INITIAL, 0), apiSecret: "must-not-pass" }, '"settings-0"'),
    ],
  ])("fails closed when the initial GET has a %s", async (_name, response) => {
    const states: SettingsPageControllerState[] = [];
    const fetcher = vi.fn(() => Promise.resolve(response));
    const controller = createSettingsPageController({
      fetcher,
      onState: (state) => states.push(structuredClone(state)),
    });

    await controller.start();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({
      status: "error",
      payload: null,
      writer: null,
      error: "failed to load settings",
    });
  });

  it.each([
    ["missing ETag", (state: EffectiveSettings) => jsonResponse(payload(state, 1), null)],
    [
      "malformed payload",
      (state: EffectiveSettings) => jsonResponse(
        { ...payload(state, 1), capabilities: { hasFmpKey: "yes" } },
        '"settings-1"',
      ),
    ],
  ])("GET-recovers before a queued tail after a 200 POST with a %s", async (_name, reply) => {
    const firstPost = deferred<Response>();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return Promise.resolve(jsonResponse(payload(INITIAL, 0), '"settings-0"'));
      }
      if (calls.length === 2) return firstPost.promise;
      return Promise.resolve(jsonResponse(payload(A, 1), '"settings-1"'));
    });
    const states: SettingsPageControllerState[] = [];
    const controller = createSettingsPageController({
      fetcher,
      onState: (state) => states.push(structuredClone(state)),
    });

    await controller.start();
    controller.setAnalysisEffort(A.analysisEffort);
    await settle();
    controller.setAnalysisModel(C.analysisModel);
    controller.setAnalysisEffort(C.analysisEffort);
    firstPost.resolve(reply(A));
    await controller.flush();

    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ url: "/api/settings", init: { cache: "no-store" } });
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
    expect(states.some((state) => state.writer?.status === "recovering")).toBe(true);
    expect(states.at(-1)).toMatchObject({
      payload: payload(A, 1),
      writer: { status: "error", desired: A },
    });
  });

  it("surfaces an arbitrary legacy current model for repair but never carries it into an effort write", async () => {
    const legacy = "legacy-mystery-model";
    const current = payload(
      { analysisModel: legacy, analysisEffort: "high" },
      7,
      { analysisModel: "environment", analysisEffort: "database" },
    );
    const post = deferred<Response>();
    const calls: Array<{ init: RequestInit | undefined }> = [];
    const states: SettingsPageControllerState[] = [];
    const controller = createSettingsPageController({
      fetcher: (_input, init) => {
        calls.push({ init });
        return calls.length === 1
          ? Promise.resolve(jsonResponse(current, '"settings-7"'))
          : post.promise;
      },
      onState: (state) => states.push(structuredClone(state)),
    });

    await controller.start();
    expect(settingsModelOptionsForDisplay(legacy, current.analysisModelOptions)).toEqual([
      { value: legacy, carryOnly: false, unsupported: true },
      ...current.analysisModelOptions.map((value) => ({
        value,
        carryOnly: false,
        unsupported: false,
      })),
    ]);
    controller.setAnalysisEffort("medium");
    await settle();
    expect(calls).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({
      payload: current,
      writer: {
        status: "error",
        desired: { analysisModel: legacy, analysisEffort: "high" },
      },
      error: "select a supported analysis model before saving",
    });

    controller.setAnalysisModel("auto");
    await settle();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      analysisModel: "auto",
      analysisEffort: "high",
    });
    post.resolve(jsonResponse(
      payload(
        { analysisModel: "auto", analysisEffort: "high" },
        8,
        { analysisModel: "database", analysisEffort: "database" },
      ),
      '"settings-8"',
    ));
    await controller.flush();
  });

  it("fails closed when a recovery GET has an invalid ETag and restores the last acknowledged authority", async () => {
    const write = deferred<Response>();
    const calls: Array<{ init: RequestInit | undefined }> = [];
    const states: SettingsPageControllerState[] = [];
    const controller = createSettingsPageController({
      fetcher: (_input, init) => {
        calls.push({ init });
        if (calls.length === 1) {
          return Promise.resolve(jsonResponse(payload(INITIAL, 0), '"settings-0"'));
        }
        if (calls.length === 2) return write.promise;
        return Promise.resolve(jsonResponse(payload(C, 9), null));
      },
      onState: (state) => states.push(structuredClone(state)),
    });

    await controller.start();
    controller.setAnalysisEffort(A.analysisEffort);
    await settle();
    controller.setAnalysisModel(C.analysisModel);
    write.reject(new Error("ambiguous write"));
    await controller.flush();

    expect(calls).toHaveLength(3);
    expect(states.at(-1)).toMatchObject({
      payload: payload(INITIAL, 0),
      writer: { status: "error", desired: INITIAL },
      error: "settings could not be confirmed",
    });
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
  });

  it("aborts initial GET on dispose but never supplies an abort signal to POST", async () => {
    const initial = deferred<Response>();
    let initialSignal: AbortSignal | null | undefined;
    const initialStates: SettingsPageControllerState[] = [];
    const initialController = createSettingsPageController({
      fetcher: (_input, init) => {
        initialSignal = init?.signal;
        return initial.promise;
      },
      onState: (state) => initialStates.push(structuredClone(state)),
    });
    const starting = initialController.start();
    await settle();
    initialController.dispose();
    expect(initialSignal?.aborted).toBe(true);
    const callbacksAtDispose = initialStates.length;
    initial.resolve(jsonResponse(payload(INITIAL, 0), '"settings-0"'));
    await starting;
    expect(initialStates).toHaveLength(callbacksAtDispose);

    const post = deferred<Response>();
    const calls: RequestInit[] = [];
    const controller = createSettingsPageController({
      fetcher: (_input, init = {}) => {
        calls.push(init);
        return calls.length === 1
          ? Promise.resolve(jsonResponse(payload(INITIAL, 0), '"settings-0"'))
          : post.promise;
      },
      onState: vi.fn(),
    });
    await controller.start();
    controller.setDesired(A);
    await settle();
    expect(calls[1]!.signal).toBeUndefined();
    controller.dispose();
    post.resolve(jsonResponse(payload(A, 1), '"settings-1"'));
    await controller.flush();
  });

  it("the route-used page delegates transport and persistence to the tested controller", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src", "app", "settings", "page.tsx"),
      "utf8",
    );
    expect(source).toContain("createSettingsPageController");
    expect(source).toContain('from "./SettingsPageView"');
    expect(source).toContain("<SettingsPageView");
    expect(source).toContain("controller.start()");
    expect(source).toContain("controller.setAnalysisModel(");
    expect(source).toContain("controller.setAnalysisEffort(");
    expect(source).toContain("controller.dispose()");
    expect(source).not.toMatch(/fetch\(\s*["']\/api\/settings["']/);

    const viewSource = readFileSync(
      path.join(process.cwd(), "src", "app", "settings", "SettingsPageView.tsx"),
      "utf8",
    );
    expect(viewSource).toContain("settingsModelOptionsForDisplay(");
    expect(viewSource).toContain('status === "recovering"');
  });

  it("the route-used view renders optimistic desired values and honest saving/recovery states", () => {
    const current = payload(
      { analysisModel: "claude-haiku-4-5-20251001", analysisEffort: "high" },
      4,
      { analysisModel: "environment", analysisEffort: "default" },
    );
    const saving: SettingsPageControllerState = {
      status: "ready",
      payload: { ...current, ...C },
      error: null,
      writer: {
        status: "saving",
        authority: {
          state: {
            analysisModel: current.analysisModel,
            analysisEffort: current.analysisEffort,
          },
          sources: current.sources,
          revision: current.revision,
          etag: '"settings-4"',
        },
        desired: C,
        error: null,
      },
    };
    const html = renderToStaticMarkup(createElement(SettingsPageView, {
      state: saving,
      onAnalysisModel: vi.fn(),
      onAnalysisEffort: vi.fn(),
    }));

    const modelInput = html.match(/<input[^>]*value="claude-opus-4-8"[^>]*>/)?.[0];
    const effortInput = html.match(/<input[^>]*value="max"[^>]*>/)?.[0];
    expect(modelInput).toContain("checked");
    expect(effortInput).toContain("checked");
    expect(html).toContain("saving");
    expect(html).not.toContain(">saved<");
    expect(html).toContain("FMP_API_KEY");

    const datedHtml = renderToStaticMarkup(createElement(SettingsPageView, {
      state: {
        ...saving,
        payload: current,
        writer: {
          ...saving.writer!,
          status: "recovering",
          desired: {
            analysisModel: current.analysisModel,
            analysisEffort: current.analysisEffort,
          },
        },
      },
      onAnalysisModel: vi.fn(),
      onAnalysisEffort: vi.fn(),
    }));
    expect(datedHtml).toContain("claude-haiku-4-5-20251001");
    expect(datedHtml).toContain("current; carry-only");
    expect(datedHtml).toContain("recovering");
    expect(datedHtml).not.toContain(">saved<");

    const legacy = "legacy-mystery-model";
    const legacyPayload = payload(
      { analysisModel: legacy, analysisEffort: "high" },
      7,
      { analysisModel: "environment", analysisEffort: "database" },
    );
    const legacyHtml = renderToStaticMarkup(createElement(SettingsPageView, {
      state: {
        status: "ready",
        payload: legacyPayload,
        error: "select a supported analysis model before saving",
        writer: {
          ...saving.writer!,
          status: "error",
          authority: {
            state: {
              analysisModel: legacyPayload.analysisModel,
              analysisEffort: legacyPayload.analysisEffort,
            },
            sources: legacyPayload.sources,
            revision: legacyPayload.revision,
            etag: '"settings-7"',
          },
          desired: { analysisModel: legacy, analysisEffort: "high" },
          error: "select a supported analysis model before saving",
        },
      },
      onAnalysisModel: vi.fn(),
      onAnalysisEffort: vi.fn(),
    }));
    expect(legacyHtml).toContain("legacy-mystery-model");
    expect(legacyHtml).toContain("unsupported current model");
    expect(legacyHtml).toContain("select a supported analysis model before saving");
    const legacyInput = legacyHtml.match(
      /<input[^>]*value="legacy-mystery-model"[^>]*>/,
    )?.[0];
    expect(legacyInput).toContain("disabled");
    expect(legacyInput).toContain("checked");
  });

  it("the route-used view does not claim to still be loading after a terminal load error", () => {
    const html = renderToStaticMarkup(createElement(SettingsPageView, {
      state: {
        status: "error",
        payload: null,
        writer: null,
        error: "failed to load settings",
      },
      onAnalysisModel: vi.fn(),
      onAnalysisEffort: vi.fn(),
    }));

    expect(html).toContain("failed to load settings");
    expect(html).toContain("settings unavailable");
    expect(html).not.toContain("loading…");
  });

  it("keeps every client settings module free of server, database, provider, and runtime config imports", () => {
    const paths = [
      path.join(process.cwd(), "src", "settings", "contracts.ts"),
      path.join(process.cwd(), "src", "settings", "writeQueue.ts"),
      path.join(process.cwd(), "src", "app", "settings", "page.tsx"),
      path.join(process.cwd(), "src", "app", "settings", "SettingsPageView.tsx"),
    ];
    for (const file of paths) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(
        /(?:server-only|@\/db|@\/config|@\/providers|better-sqlite3|drizzle-orm)/,
      );
    }
  });
});
