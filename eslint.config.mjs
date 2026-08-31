// eslint-config-next v16 ships native flat configs; FlatCompat over the old
// "next/core-web-vitals" eslintrc entrypoints crashes (@eslint/eslintrc
// circular-structure TypeError), so we import the flat arrays directly.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescriptConfig from "eslint-config-next/typescript";

const eslintConfig = [
  {
    // Patterns are `**/`-prefixed so build output is ignored wherever it sits,
    // including inside the gitignored `.worktrees/` checkouts a contributor may
    // have; a root-relative `.next/**` misses those and floods `npm run lint`.
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/out/**",
      "**/drizzle/**",
      "**/coverage/**",
      ".worktrees/**",
      "tmp/**",
      "next-env.d.ts",
    ],
  },
  ...coreWebVitals,
  ...typescriptConfig,
];

export default eslintConfig;
