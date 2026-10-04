import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The supported runtime binds to loopback. HTTP gzip adds no useful network
  // savings here, and Next's bundled compression forwards drain listeners to
  // Gzip without forwarding their removal (leaking once listeners on long
  // responses). Storage compression in src/cache/compression.ts is independent.
  compress: false,
  // Native module (better-sqlite3) + a large server-only SDK (@anthropic-ai/sdk,
  // used only in src/providers/anthropic.ts): keep both external so they stay a
  // runtime `require` instead of being pulled into the server module graph.
  serverExternalPackages: ["better-sqlite3", "@anthropic-ai/sdk"],
  // Type-checking runs as its own gate (`npm run typecheck`), so skip the
  // duplicate blocking full-project tsc pass inside `next build`. NOTE: run
  // `npm run typecheck` in CI / before shipping — the build no longer catches
  // type errors.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
