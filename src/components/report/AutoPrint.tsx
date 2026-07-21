"use client";

/**
 * AutoPrint — a zero-markup client component that fires the browser's print
 * dialog once on mount. Mounted by the print page only when `?autoprint=1` is
 * present, giving a dependency-free "Export PDF" experience (the user's browser
 * prints the light print page to PDF).
 *
 * Kept tiny and effect-only so the print page itself can stay a server
 * component (no client boundary for the report content).
 */

import { useEffect } from "react";

export function AutoPrint() {
  useEffect(() => {
    // A short delay lets fonts/layout settle before the print snapshot.
    const id = window.setTimeout(() => {
      window.print();
    }, 300);
    return () => window.clearTimeout(id);
  }, []);
  return null;
}
