/**
 * Route-level loading UI for /company/[symbol].
 *
 * Next.js shows this the instant a <Link> navigation to a company begins,
 * while the async page server component (which runs the full Stage-A fetch +
 * Stage-B compute pipeline) streams in behind it. This is what removes the
 * frozen "rendering…" wait: the shell + a skeleton paint immediately instead of
 * the browser blocking on the whole pipeline before the transition completes.
 */

import { AppShell } from "@/components/shell";

import { CompanyBodySkeleton, SidebarSkeleton } from "./skeletons";

export default function Loading() {
  return (
    <AppShell sidebar={<SidebarSkeleton />}>
      <CompanyBodySkeleton />
    </AppShell>
  );
}
