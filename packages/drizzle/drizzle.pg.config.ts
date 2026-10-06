import { defineConfig } from "drizzle-kit";

/**
 * Migrations for the pg dialect, generated from the Drizzle schema in src/schema
 * (read from the compiled dist/ because drizzle-kit cannot resolve ".js" imports in TS sources).
 * Generate with: pnpm --filter @polpo-ai/drizzle db:generate
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./dist/schema/*.js",
  out: "./migrations/pg",
});
