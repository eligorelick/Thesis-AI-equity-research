/**
 * AppShell — global chrome: top header bar, fixed left sidebar, scrollable
 * main region, and the mandatory "informational only" footer (hard product
 * requirement — every screen renders it).
 *
 * Presentational only; safe in server and client components.
 */

import type { ReactNode } from "react";
import Link from "next/link";

export function AppShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      {/* Header bar */}
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-edge bg-panel px-4">
        <div className="flex items-baseline gap-3">
          <Link
            href="/"
            className="mono text-[13px] font-semibold tracking-[0.3em] text-fg"
          >
            THESIS
          </Link>
          <span className="hidden text-[11px] text-faint sm:inline">
            equity research engine
          </span>
        </div>
        <nav className="flex items-center gap-3 text-[11px]">
          <Link
            href="/settings"
            className="mono uppercase tracking-[0.1em] text-muted hover:text-accent"
          >
            settings
          </Link>
        </nav>
      </header>

      {/* Sidebar + main */}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-edge bg-panel">
          {sidebar}
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      {/* Global disclaimer footer — hard product requirement */}
      <footer className="shrink-0 border-t border-edge bg-panel px-4 py-1">
        <p className="text-[10px] uppercase tracking-[0.08em] text-faint">
          informational only — not investment advice
        </p>
      </footer>
    </div>
  );
}
