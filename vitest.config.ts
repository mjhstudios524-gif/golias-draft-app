import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/engine/**/*.ts"],
      exclude: ["src/engine/legacy/**", "src/engine/**/*.test.ts"],
      thresholds: {
        lines: 95,
        // 92, not 95: the shortfall is (a) the deliberately-preserved
        // unreachable legacy fallback in computeTiers (pinned dead code,
        // PLAN.md §4) and (b) defensive ??-fallback arms v8 counts as
        // branches. Raising this would require deleting pinned behavior.
        branches: 92,
      },
    },
  },
});
