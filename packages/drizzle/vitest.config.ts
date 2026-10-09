import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Test files share one PostgreSQL database when POLPO_TEST_DATABASE_URL is set and empty it
    // before each test: run them one at a time.
    fileParallelism: false,
  },
});
