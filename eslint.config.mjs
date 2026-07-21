// eslint-config-next v16 ships native flat configs; FlatCompat over the old
// "next/core-web-vitals" eslintrc entrypoints crashes (@eslint/eslintrc
// circular-structure TypeError), so we import the flat arrays directly.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescriptConfig from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "drizzle/**",
      "next-env.d.ts",
    ],
  },
  ...coreWebVitals,
  ...typescriptConfig,
];

export default eslintConfig;
