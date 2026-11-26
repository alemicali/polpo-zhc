import { defineConfig } from "vitest/config";

// CI runners (4 vCPU): the default cpus−1 forks again (the MCP tool catalog is declared once per
// process since src/server/mcp-server/catalog.ts, so building a server per request no longer
// starves the workers — the cause of the "onTaskUpdate" RPC timeouts). A 10 s test timeout keeps a
// little headroom over the 5 s local default for slow runners; locally nothing changes.
const ci = !!process.env.CI;

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    pool: "forks",
    ...(ci ? { testTimeout: 10_000, hookTimeout: 10_000 } : {}),
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
