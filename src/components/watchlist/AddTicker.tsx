"use client";

/**
 * AddTicker — the "add ticker" control at the top of the sidebar.
 *
 * POSTs /api/watchlist { symbol } then calls router.refresh() so the parent
 * server component (WatchlistSidebar) re-runs getWatchlistView with the new
 * symbol enriched. Dense terminal styling: a mono input + a compact add button.
 * Client-only — it never imports server modules; all data flows through the API.
 */

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function AddTicker() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(
    async (raw: string) => {
      const symbol = raw.trim().toUpperCase();
      if (symbol.length === 0) return;
      setError(null);
      setSubmitting(true);
      try {
        const res = await fetch("/api/watchlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ symbol }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `add failed (${res.status})`);
          return;
        }
        setValue("");
        startTransition(() => router.refresh());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [router],
  );

  const busy = submitting || pending;

  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(value);
      }}
    >
      <div className="flex items-stretch gap-1">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="add ticker"
          spellCheck={false}
          autoCapitalize="characters"
          maxLength={12}
          aria-label="add ticker"
          className="mono min-w-0 flex-1 border border-edge bg-bg px-2 py-1 text-[12px] uppercase tracking-[0.08em] text-fg placeholder:text-faint placeholder:normal-case placeholder:tracking-normal focus:border-accent/60 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || value.trim().length === 0}
          className={`mono shrink-0 border px-2 py-1 text-[11px] uppercase tracking-[0.1em] ${
            busy || value.trim().length === 0
              ? "cursor-not-allowed border-edge text-faint opacity-60"
              : "border-accent/50 text-accent hover:bg-accent/10"
          }`}
        >
          {busy ? "…" : "+"}
        </button>
      </div>
      {error ? (
        <div className="text-[10px] leading-snug text-neg">{error}</div>
      ) : null}
    </form>
  );
}
