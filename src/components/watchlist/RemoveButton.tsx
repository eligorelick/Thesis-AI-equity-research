"use client";

/**
 * RemoveButton — the per-row remove (×) control in the sidebar.
 *
 * DELETEs /api/watchlist { symbol } then router.refresh() to rebuild the
 * enriched sidebar. Client-only; talks to the API, never to the DB directly.
 * Kept visually quiet (faint ×, red on hover) so it does not compete with the
 * ticker link it sits beside.
 */

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function RemoveButton({ symbol }: { symbol: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);

  const remove = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/watchlist", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      if (res.ok) {
        startTransition(() => router.refresh());
      }
    } catch {
      // Non-fatal: leave the row in place; the user can retry.
    } finally {
      setSubmitting(false);
    }
  }, [router, symbol]);

  const busy = submitting || pending;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void remove();
      }}
      disabled={busy}
      aria-label={`remove ${symbol}`}
      title={`remove ${symbol}`}
      className={`mono shrink-0 px-1 text-[12px] leading-none ${
        busy ? "text-faint opacity-60" : "text-faint hover:text-neg"
      }`}
    >
      {busy ? "·" : "×"}
    </button>
  );
}
