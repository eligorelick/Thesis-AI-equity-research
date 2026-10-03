"use client";
import { useCallback, useEffect, useState } from "react";
import { Panel } from "@/components/ui";
import type { AiConnectionsView } from "@/ai/contracts";

const button = "border border-edge px-3 py-1.5 text-sm hover:border-accent disabled:opacity-40";
export function AiConnections() {
  const [view, setView] = useState<AiConnectionsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [chosen, setChosen] = useState("none");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const refresh = useCallback(async () => {
    const r = await fetch("/api/ai/connections", { cache: "no-store" });
    const data = await r.json(); if (!r.ok) throw new Error(data.error);
    setView(data as AiConnectionsView);
  }, []);
  useEffect(() => {
    let active = true;
    void fetch("/api/ai/connections", { cache: "no-store" }).then(async (r) => {
      const data = await r.json(); if (!r.ok) throw new Error(data.error);
      if (active) setView(data);
    }).catch((e: Error) => { if (active) setMessage(e.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (view?.pending?.status !== "waiting") return;
    const timer = setInterval(() => { void refresh().catch((e: Error) => setMessage(e.message)); }, 3000);
    return () => clearInterval(timer);
  }, [refresh, view?.pending?.status]);
  async function act(body: Record<string, unknown>) {
    setBusy(true); setMessage("");
    try {
      const r = await fetch("/api/ai/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error);
      if (data.models) { setModels(data.models); setModel(data.models[0]?.id ?? ""); }
      else setView(data);
      if (data.message) setMessage(data.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Connection action failed"); }
    finally { setBusy(false); }
  }
  const connection = view?.connections.find((c) => c.id === chosen);
  const active = view?.selection;
  return <Panel title="AI connections">
    <div className="space-y-3 text-sm">
      <p>Choose how Thesis runs its AI research. Financial calculations and citation checks stay in Thesis.</p>
      <p className="text-faint">Sign-in opens your normal Chrome browser. Signing in does not run a report. Thesis never switches a failed connection to paid API usage.</p>
      {view && <>
        <p><strong>Active:</strong> {active?.provider === "none" ? "AI off — data-only reports" : active?.provider === "anthropic" ? "Claude API — separately billed" : `${active?.provider === "chatgpt" ? "ChatGPT plan" : "Google Gemini CLI allowance"} · ${active && "model" in active ? active.model : ""} · ${view.connections.find((c) => c.id === (active && "connectionId" in active ? active.connectionId : ""))?.label ?? "connection unavailable"}`}</p>
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={busy || view.pending?.status === "waiting"} onClick={() => void act({ action: "connect-chatgpt" })}>Continue with ChatGPT</button>
          <button className={button} disabled={busy || !view.geminiInstalled || view.pending?.status === "waiting"} onClick={() => void act({ action: "connect-gemini" })}>Connect Gemini with Google</button>
        </div>
        <p className="text-xs text-faint">ChatGPT requires an eligible plan. Gemini uses the official local Gemini CLI and its Google allowance. Claude remains available through a separately billed API key; third-party Claude subscription sign-in is not enabled.</p>
        {!view.geminiInstalled && <p>Gemini CLI is missing or too old. Install it using <a className="underline" href="https://geminicli.com/docs/get-started/installation/" target="_blank" rel="noreferrer">Google’s instructions</a>, then restart Thesis. Version 0.36 or newer is required.</p>}
        {view.pending && <div role="status" className="border border-edge p-2"><p>{view.pending.message}</p>{view.pending.url && <a className="underline" href={view.pending.url} target="_blank" rel="noreferrer">Open ChatGPT sign-in</a>}</div>}
        {view.connections.map((c) => <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-edge py-2">
          <span>{c.label} — {c.connected ? c.planEnabled ? "connected" : "plan access not granted" : "signed out"}</span>
          <div className="flex gap-2">
            {c.provider === "chatgpt" && <button className={button} disabled={busy} onClick={() => void act({ action: "connect-chatgpt", id: c.id })}>Reconnect</button>}
            <button className={button} disabled={busy} onClick={() => void act({ action: `disconnect-${c.provider}`, id: c.id })}>Disconnect</button>
          </div>
        </div>)}
        <label className="block">Use for new reports
          <select className="mt-1 w-full border border-edge bg-bg p-2" value={chosen} disabled={busy} onChange={(e) => { setChosen(e.target.value); setModels([]); setModel(view.connections.find((c) => c.id === e.target.value)?.provider === "gemini" ? "auto" : ""); }}>
            <option value="none">AI off — data-only reports</option>
            {view.connections.filter((c) => c.connected && c.planEnabled).map((c) => <option key={c.id} value={c.id}>{c.provider === "chatgpt" ? "ChatGPT plan" : "Gemini CLI allowance"} · {c.label}</option>)}
            <option value="anthropic" disabled={!view.hasAnthropicKey}>Claude API — separately billed{!view.hasAnthropicKey ? " (no key configured)" : ""}</option>
          </select>
        </label>
        {connection?.provider === "chatgpt" && <div className="space-y-2">
          <button className={button} disabled={busy} onClick={() => void act({ action: "models", id: connection.id })}>Load this account’s models</button>
          <label className="block">Model<select className="mt-1 w-full border border-edge bg-bg p-2" value={model} onChange={(e) => setModel(e.target.value)}><option value="">Choose a model</option>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        </div>}
        {connection?.provider === "gemini" && <label className="block">Gemini model<input className="mt-1 w-full border border-edge bg-bg p-2" value={model} maxLength={128} onChange={(e) => setModel(e.target.value)} /><span className="text-xs text-faint">“auto” uses Google’s CLI selection; you can enter an available Gemini model ID.</span></label>}
        <button className={button} disabled={busy || (!!connection && !model)} onClick={() => void act({ action: "select", selection: connection ? { provider: connection.provider, connectionId: connection.id, model } : { provider: chosen } })}>Save report connection</button>
        <p className="text-xs text-faint">Your remaining plan allowance is not available here. A model listing does not guarantee access or remaining quota. Check <a className="underline" href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noreferrer">ChatGPT usage</a> or <a className="underline" href="https://geminicli.com/docs/resources/quota-and-pricing/" target="_blank" rel="noreferrer">Gemini allowance details</a> before running reports. Your provider’s credit settings still apply.</p>
      </>}
      {!view && !message && <p>Loading connections…</p>}
      {message && <p role="status">{message}</p>}
    </div>
  </Panel>;
}
