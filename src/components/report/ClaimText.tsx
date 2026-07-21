/**
 * ClaimText — a {@link SourcedClaim} with its label chip and a click-to-reveal
 * source/as-of line. Implemented with a native <details>/<summary> so it ships
 * ZERO client JS: a full report renders dozens-to-100+ claims, and a useState
 * island per claim meant dozens-to-100+ independent hydration roots. The whole
 * claim text is the toggle; provenance is collapsed by default (matching print
 * / export, which render their own text and never open these).
 *
 * Server Component (no "use client"): the label chip, formatting helpers, grade
 * reasoning, scenario cards, etc. in primitives.tsx all render on the server
 * with zero client bundle cost, and this now joins them.
 */

import { Badge, type Tone } from "@/components/ui";
import type { ClaimLabel } from "@/types/core";
import type { SourcedClaim } from "@/report/schema";

const LABEL_TONE: Record<ClaimLabel, Tone> = {
  FACT: "muted",
  ESTIMATE: "accent",
  JUDGMENT: "warn",
};

/** The FACT/ESTIMATE/JUDGMENT tag chip. */
export function ClaimLabelChip({ label }: { label: ClaimLabel }) {
  return <Badge tone={LABEL_TONE[label]}>{label}</Badge>;
}

/** A tiny source + as-of provenance line (used inside popovers). */
function Provenance({ source, asOf }: { source: string; asOf: string | null }) {
  return (
    <div className="mono flex flex-col gap-0.5 text-[10px] leading-snug text-faint">
      <span className="break-all">
        <span className="text-muted">src</span> {source}
      </span>
      <span>
        <span className="text-muted">as of</span> {asOf ?? "—"}
      </span>
    </div>
  );
}

/**
 * Renders one {@link SourcedClaim}: the label chip, the claim text, and its
 * source + as-of. Provenance is inline-collapsed by default and revealed by the
 * native <details> toggle (the small "›src" affordance flips to "‹src" when
 * open) — dense reading column, every claim one click from its origin, no JS.
 */
export function ClaimText({
  claim,
  className,
}: {
  claim: SourcedClaim;
  className?: string;
}) {
  return (
    <details className={`group flex flex-col gap-1 ${className ?? ""}`}>
      <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
        <span className="mt-px shrink-0">
          <ClaimLabelChip label={claim.label} />
        </span>
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-fg">
          {claim.text}{" "}
          <span
            className="mono align-baseline text-[10px] text-faint group-hover:text-accent"
            title={`${claim.source}${claim.asOf ? ` · as of ${claim.asOf}` : ""}`}
          >
            <span className="group-open:hidden">›src</span>
            <span className="hidden group-open:inline">‹src</span>
          </span>
        </span>
      </summary>
      <div className="ml-[3.25rem] border-l border-edge pl-2">
        <Provenance source={claim.source} asOf={claim.asOf} />
      </div>
    </details>
  );
}
