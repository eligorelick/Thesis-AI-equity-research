/**
 * Server-safe loading skeletons for the /company/[symbol] route.
 *
 * Shared by loading.tsx (the instant route-transition fallback) and the in-page
 * <Suspense> boundaries in page.tsx. Before these existed the route was one big
 * async server component that awaited the ENTIRE Stage-A fetch (live EDGAR /
 * FRED / FINRA / FMP) + Stage-B compute + ~1260-bar chart build before emitting
 * any HTML — so clicking a ticker froze on a blank "rendering…" state for many
 * seconds. With a Suspense boundary Next streams this skeleton instantly, then
 * swaps in the real content when the pipeline resolves.
 *
 * Presentational only — no hooks, no data fetching, no server imports.
 */

function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-[2px] bg-raised ${className}`} />;
}

/** Static placeholder for the watchlist rail while getWatchlistView() resolves. */
export function SidebarSkeleton() {
  return (
    <div className="flex min-h-0 flex-col" aria-hidden>
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <Bar className="h-3 w-16" />
        <Bar className="h-3 w-4" />
      </div>
      <div className="border-b border-edge p-2">
        <Bar className="h-7 w-full" />
      </div>
      <ul className="flex flex-col">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i} className="border-b border-edge px-3 py-2">
            <div className="flex items-center justify-between">
              <Bar className="h-3 w-14" />
              <Bar className="h-3 w-10" />
            </div>
            <Bar className="mt-2 h-2 w-24" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <section className="border border-edge bg-panel">
      <div className="border-b border-edge px-3 py-1.5">
        <Bar className="h-3 w-32" />
      </div>
      <div className="flex flex-col gap-2 px-3 py-3">
        {Array.from({ length: rows }).map((_, i) => (
          <Bar key={i} className="h-3 w-full" />
        ))}
      </div>
    </section>
  );
}

/** Placeholder for the main research surface while the pipeline runs. */
export function CompanyBodySkeleton({ symbol }: { symbol?: string }) {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 p-4" aria-busy>
      <div className="flex items-center justify-between">
        <Bar className="h-3 w-40" />
        <Bar className="h-6 w-28" />
      </div>

      {/* quote header */}
      <div className="border border-edge bg-panel">
        <div className="flex items-center justify-between border-b border-edge px-3 py-2">
          <div className="flex items-baseline gap-3">
            <span className="mono text-[20px] font-semibold tracking-[0.08em] text-faint">
              {symbol ?? ""}
            </span>
            <Bar className="h-3 w-32" />
          </div>
          <Bar className="h-3 w-20" />
        </div>
        <div className="flex divide-x divide-edge">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex-1 px-2 py-2">
              <Bar className="h-2 w-10" />
              <Bar className="mt-1.5 h-4 w-16" />
            </div>
          ))}
        </div>
      </div>

      {/* analysis panel grid */}
      <div className="grid gap-3 lg:grid-cols-2">
        <PanelSkeleton />
        <PanelSkeleton />
        <PanelSkeleton />
        <PanelSkeleton />
      </div>
      <PanelSkeleton rows={6} />

      <div className="pt-2 text-center text-[11px] text-faint">
        <span className="animate-pulse">
          loading {symbol ? `${symbol} ` : ""}research — fetching filings, prices &amp; macro, then computing metrics…
        </span>
      </div>
    </div>
  );
}
