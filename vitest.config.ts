import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: [
        "src/core/**/*.ts",
        "src/server/**/*.ts",
        "src/adapters/**/*.ts",
        "src/assessment/**/*.ts",
        "src/stores/**/*.ts",
        "src/llm/**/*.ts",
        "src/cli/**/*.ts",
        "src/tools/**/*.ts",
        "src/auth/**/*.ts",
        "src/vault/**/*.ts",
        "src/quality/**/*.ts",
        "src/scheduling/**/*.ts",
        "src/notifications/**/*.ts",
      ],
      exclude: [
        "src/**/*.test.ts",
        "src/__tests__/**",
        "src/**/index.ts",
        "src/tui/**",
      ],
      thresholds: {
        statements: 45,
        branches: 35,
        functions: 40,
        lines: 45,
      },
    },
  },
});
