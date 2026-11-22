#!/usr/bin/env node
/**
 * Writes the MCP scope matrix (scope → tools) into docs/mcp.md, between the scope-matrix markers,
 * from the code (dist/server/mcp.js: build first). A test checks the docs stay in sync.
 *
 *   ./node_modules/.bin/tsc && node scripts/generate-mcp-scopes.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { scopeMatrixMarkdown } = await import(`${root}dist/server/mcp.js`);
const file = `${root}docs/mcp.md`;
const START = "<!-- scope-matrix:start (generated: node scripts/generate-mcp-scopes.mjs) -->";
const END = "<!-- scope-matrix:end -->";
const doc = readFileSync(file, "utf-8");
const a = doc.indexOf(START);
const b = doc.indexOf(END);
if (a < 0 || b < a) {
  console.error(`docs/mcp.md has no ${START} … ${END} block`);
  process.exit(1);
}
const next = `${doc.slice(0, a + START.length)}\n${scopeMatrixMarkdown()}\n${doc.slice(b)}`;
if (next !== doc) writeFileSync(file, next);
console.log(next === doc ? "docs/mcp.md: scope matrix up to date" : "docs/mcp.md: scope matrix updated");
process.exit(0);
