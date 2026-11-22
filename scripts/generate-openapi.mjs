#!/usr/bin/env node
/**
 * Regenerate docs/openapi.json from the route definitions (needs the build: `./node_modules/.bin/tsc`).
 *
 *   node scripts/generate-openapi.mjs [--check]
 *
 * No running instance is needed: src/server/openapi-spec.ts builds the app around an inert
 * orchestrator. With --check nothing is written; it exits 1 when docs/openapi.json is stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "openapi.json");
const load = (rel) => import(pathToFileURL(join(root, rel)).href);
const { createApp } = await load("dist/server/app.js");
const { generateOpenApiSpec } = await load("dist/server/openapi-spec.js");

const spec = await generateOpenApiSpec(createApp);
const text = JSON.stringify(spec, null, 2);
const paths = Object.keys(spec.paths).length;

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(out, "utf8"); } catch { /* missing counts as stale */ }
  if (current.trimEnd() !== text.trimEnd()) {
    console.error("docs/openapi.json is out of date: run `pnpm run generate:openapi`.");
    process.exit(1);
  }
  console.log(`docs/openapi.json is up to date (${paths} paths).`);
} else {
  writeFileSync(out, text);
  console.log(`Generated docs/openapi.json with ${paths} paths.`);
}
// Route modules may leave timers or watchers behind; the spec is written, so stop here.
process.exit(0);
