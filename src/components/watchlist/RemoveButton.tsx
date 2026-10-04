"use client";

/**
 * RemoveButton — the per-row remove (×) control in the sidebar.
 *
 * DELETEs /api/watchlist { symbol } then router.refresh() to rebuild the
 * enriched sidebar. Client-only; talks to the API, never to the DB directly.
 * Kept visually quiet (faint ×, red on hover) so it does not compete with the
 * ticker link it sits beside — beside, not inside: Sidebar renders it as a
 * sibling of the row link (audit 2026-09-06, F218).
 */

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export async function requestWatchlistRemoval(symbol: string, request: typeof fetch = fetch): Promise<void> {
  try {
    const response = await request("/api/watchlist", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol }),
    });
    if (!response.ok) throw new Error("watchlist deletion failed");
  } catch {
    // Avoid exposing server response bodies or transport details in the UI.
    throw new Error(`Could not remove ${symbol}. Try again.`);
  }
}

export function RemoveButtonView({ symbol, busy, error, onRemove }: {
  symbol: string;
  busy: boolean;
  error: string | null;
  onRemove: () => void;
}) {
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        aria-label={`remove ${symbol}`}
        title={`remove ${symbol}`}
        className={`mono shrink-0 px-1 text-[12px] leading-none ${
          busy ? "text-faint opacity-60" : "text-faint hover:text-neg"
        }`}
      >
        {busy ? "·" : "×"}
      </button>
      {error ? (
        <span role="alert" className="absolute right-0 top-full z-10 mt-1 w-52 border border-neg/40 bg-raised p-2 text-[11px] leading-normal text-neg">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function RemoveButton({ symbol }: { symbol: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await requestWatchlistRemoval(symbol);
      startTransition(() => router.refresh());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `Could not remove ${symbol}. Try again.`);
    } finally {
      setSubmitting(false);
    }
  }, [router, symbol]);

  const busy = submitting || pending;

  return (
    <RemoveButtonView
      symbol={symbol}
      busy={busy}
      error={error}
      onRemove={() => {
        void remove();
      }}
    />
  );
}
