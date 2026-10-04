"use client";

import { useId, useState, type ReactNode } from "react";

export function SidebarNavigation({ children }: { children: ReactNode }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <button type="button" className="thesis-nav-toggle" aria-expanded={expanded} aria-controls={id}
        onClick={() => setExpanded((value) => !value)}>
        {expanded ? "Hide navigation" : "Show navigation"}
      </button>
      <aside id={id} data-mobile-expanded={expanded} className="thesis-sidebar flex w-64 shrink-0 flex-col overflow-y-auto border-r border-edge bg-panel">
        {children}
      </aside>
    </>
  );
}
