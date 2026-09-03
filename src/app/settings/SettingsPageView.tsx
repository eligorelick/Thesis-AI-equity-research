"use client";

import Link from "next/link";
import { AppShell } from "@/components/shell";
import { Badge, Panel, SectionHeading } from "@/components/ui";
import {
  isAnalysisModelOption,
  type AnalysisModelOption,
  type EffortLevel,
} from "@/settings/contracts";
import {
  settingsModelOptionsForDisplay,
  type SettingsPageControllerState,
} from "@/settings/writeQueue";
import { ResumeQueueControl } from "./ResumeQueueControl";

const MODEL_LABELS: Record<string, string> = {
  auto: "auto — best available [recommended]",
  "claude-haiku-4-5": "claude-haiku-4-5",
  "claude-fable-5": "claude-fable-5",
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-sonnet-5": "claude-sonnet-5",
};

const EFFORT_LABELS: Record<string, string> = {
  low: "low — fastest/cheapest, shallow reasoning",
  medium: "medium — balanced cost/quality",
  high: "high — thorough reasoning [recommended]",
  xhigh: "xhigh — extra-deep reasoning, higher cost",
  max: "max — deepest reasoning, highest cost",
};

export interface SettingsPageViewProps {
  state: SettingsPageControllerState;
  onAnalysisModel(value: AnalysisModelOption): void;
  onAnalysisEffort(value: EffortLevel): void;
}

function CapabilityRow({ name, ok }: { name: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-edge py-1.5 last:border-b-0">
      <span className="mono text-[12px]">{name}</span>
      {ok ? <Badge tone="pos">configured</Badge> : <Badge tone="neg">missing</Badge>}
    </div>
  );
}

export function SettingsPageView({
  state,
  onAnalysisModel,
  onAnalysisEffort,
}: SettingsPageViewProps) {
  const settings = state.payload;
  const status = state.writer?.status ?? "idle";
  const saveBadge = status === "saving" ? (
    <Badge tone="muted">saving…</Badge>
  ) : status === "recovering" ? (
    <Badge tone="muted">recovering…</Badge>
  ) : status === "saved" ? (
    <Badge tone="pos">saved</Badge>
  ) : status === "error" ? (
    <Badge tone="neg">save failed</Badge>
  ) : null;

  const sidebar = (
    <div className="flex flex-col gap-2 p-3">
      <Link
        href="/"
        className="mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-accent"
      >
        ← dashboard
      </Link>
      <div className="pt-2">
        <SectionHeading>settings</SectionHeading>
        <p className="pt-1 text-[11px] leading-snug text-faint">
          Model choices persist to the local database. API keys are configured
          in <span className="mono">.env</span> only.
        </p>
      </div>
    </div>
  );

  return (
    <AppShell sidebar={sidebar}>
      <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
        {state.error !== null && (
          <div className="border border-neg/40 bg-neg/10 px-3 py-2 text-[12px] text-neg">
            {state.error}
          </div>
        )}

        <Panel title="analysis model" right={saveBadge}>
          {settings === null && state.status === "loading" ? (
            <div className="py-2 text-[11px] text-faint">loading…</div>
          ) : settings !== null ? (
            <fieldset className="flex flex-col gap-1">
              <legend className="sr-only">Analysis model</legend>
              {settingsModelOptionsForDisplay(
                settings.analysisModel,
                settings.analysisModelOptions,
              ).map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-2 border border-edge bg-bg px-2 py-1.5 text-[12px] hover:border-edge-strong"
                >
                  <input
                    type="radio"
                    name="analysisModel"
                    value={option.value}
                    checked={settings.analysisModel === option.value}
                    disabled={option.unsupported}
                    onChange={() => {
                      if (isAnalysisModelOption(option.value)) {
                        onAnalysisModel(option.value);
                      }
                    }}
                    className="accent-[var(--accent)]"
                  />
                  <span className="mono">
                    {MODEL_LABELS[option.value] ?? option.value}
                    {option.carryOnly ? " (current; carry-only)" : ""}
                    {option.unsupported ? " (unsupported current model)" : ""}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
        </Panel>

        <Panel title="analysis effort" right={saveBadge}>
          {settings === null && state.status === "loading" ? (
            <div className="py-2 text-[11px] text-faint">loading…</div>
          ) : settings !== null ? (
            <>
              <fieldset className="flex flex-col gap-1">
                <legend className="sr-only">Analysis effort</legend>
                {settings.analysisEffortOptions.map((option) => (
                  <label
                    key={option}
                    className="flex cursor-pointer items-center gap-2 border border-edge bg-bg px-2 py-1.5 text-[12px] hover:border-edge-strong"
                  >
                    <input
                      type="radio"
                      name="analysisEffort"
                      value={option}
                      checked={settings.analysisEffort === option}
                      onChange={() => onAnalysisEffort(option)}
                      className="accent-[var(--accent)]"
                    />
                    <span className="mono">{EFFORT_LABELS[option] ?? option}</span>
                  </label>
                ))}
              </fieldset>
              <p className="pt-2 text-[11px] leading-snug text-faint">
                Controls how much the model reasons per pass. Reasoning tokens
                are billed as output and are the largest cost component of a
                report, so lower effort trades analytical depth for cost.
              </p>
            </>
          ) : null}
        </Panel>

        <ResumeQueueControl />

        <Panel title="verification">
          <p className="py-1 text-[11px] leading-snug text-faint">
            The citation-coverage pass is fully deterministic (numeric-source
            tracing) — it never calls a model and costs nothing, so there is no
            verification model to configure.
          </p>
        </Panel>

        <Panel title="api keys (read-only)">
          {settings !== null ? (
            <div className="flex flex-col">
              {settings.capabilities.fixtureMode && (
                <div className="mb-2 border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
                  synthetic fixture mode — no FMP key and no current market data.
                  Use fictional ticker <Link href="/company/DEMO" className="font-semibold underline">DEMO</Link>{" "}
                  or DBNK; unsupported symbols become disclosed gaps.
                </div>
              )}
              <CapabilityRow name="FMP_API_KEY" ok={settings.capabilities.hasFmpKey} />
              <CapabilityRow name="FINNHUB_API_KEY" ok={settings.capabilities.hasFinnhubKey} />
              <CapabilityRow name="FRED_API_KEY" ok={settings.capabilities.hasFredKey} />
              <CapabilityRow name="ANTHROPIC_API_KEY" ok={settings.capabilities.hasAnthropicKey} />
              <p className="pt-2 text-[11px] leading-snug text-faint">
                Keys are read from <span className="mono">.env</span> at server
                start and never enter the browser. Server-side requests send
                each key only to its configured provider. Restart after editing.
              </p>
            </div>
          ) : state.status === "loading" ? (
            <div className="py-2 text-[11px] text-faint">loading…</div>
          ) : (
            <div className="py-2 text-[11px] text-faint">settings unavailable</div>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}
