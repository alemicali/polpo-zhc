import { defineConfig } from "vitest/config";

// On CI runners (4 vCPU) every worker builds the full MCP server many times (≈ 150–250 ms of zod
// schema construction and GC each): with the default cpus−1 forks they starve each other, the
// long multi-call tests cross the 5 s default, and a worker can stall long enough that its
// "onTaskUpdate" RPC to the main process times out (60 s) after every test has passed. Fewer
// forks and a CI-sized timeout keep the job reliable; locally nothing changes.
const ci = !!process.env.CI;

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    pool: "forks",
    ...(ci ? { maxWorkers: 2, minWorkers: 1, testTimeout: 30_000, hookTimeout: 30_000 } : {}),
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
