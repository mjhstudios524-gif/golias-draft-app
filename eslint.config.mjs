import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
    "src/engine/legacy/**",
  ]),
  {
    // The draft engine must stay pure: no framework, no DB, no app imports.
    // This rule is the enforcement mechanism for PLAN.md §3's purity guarantee.
    files: ["src/engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "react",
                "react-dom",
                "react/*",
                "next",
                "next/*",
                "@prisma/*",
                "@clerk/*",
                "stripe",
                "zustand",
                "@tanstack/*",
                "server-only",
                "@/app/*",
                "@/server/*",
                "@/components/*",
                "@/stores/*",
                "@/lib/env",
              ],
              message:
                "src/engine is a pure module — it may not import frameworks, the DB, or app code.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
