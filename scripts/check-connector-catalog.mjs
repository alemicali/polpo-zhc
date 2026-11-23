#!/usr/bin/env node
/**
 * Catalog OAuth health check (needs the build: `./node_modules/.bin/tsc`): probes every connector
 * catalog entry the way a real connection would start (see src/mcp/catalog-check.ts) and prints a
 * table plus JSON. Never signs in and stores nothing; DCR servers get one test registration each,
 * deleted again when the provider supports RFC 7592.
 *
 *   node scripts/check-connector-catalog.mjs [--only id,id] [--json out.json] [--concurrency 4]
 *                                            [--timeout 60] [--no-register] [--quiet]
 *                                            [--redirect-uri https://…/api/v1/connectors/oauth/callback]
 *
 * Exits 1 when an entry fails (verdict "fail"); "warn" / "unverified" / "skipped" do not fail.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { maxHeaderSize } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Some sign-in pages send more than Node's 16 KB of response headers (Ramp): run with a browser-like limit.
if (maxHeaderSize < 65536) {
  const run = spawnSync(process.execPath, ["--max-http-header-size=65536", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(join(root, rel)).href);
const { CONNECTOR_CATALOG } = await load("dist/mcp/catalog.js");
const { checkCatalog } = await load("dist/mcp/catalog-check.js");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const only = value("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
const entries = only ? CONNECTOR_CATALOG.filter((e) => only.includes(e.id)) : CONNECTOR_CATALOG;
if (only && entries.length !== only.length) {
  const unknown = only.filter((id) => !CONNECTOR_CATALOG.some((e) => e.id === id));
  console.error(`Unknown catalog ids: ${unknown.join(", ")}`);
  process.exit(2);
}

const quiet = flag("--quiet");
let done = 0;
const results = await checkCatalog(entries, {
  concurrency: Number(value("--concurrency") ?? 4),
  timeoutMs: Number(value("--timeout") ?? 60) * 1000,
  register: !flag("--no-register"),
  ...(value("--redirect-uri") ? { redirectUri: value("--redirect-uri") } : {}),
  onResult: (r) => {
    done++;
    if (!quiet) process.stderr.write(`[${done}/${entries.length}] ${r.verdict.padEnd(10)} ${r.id}${r.error ? ` — ${r.error}` : ""}\n`);
  },
});

const yesNo = (v) => (v === true ? "yes" : v === false ? "NO" : "-");
const cell = (s, n) => { const t = String(s ?? "").replace(/\|/g, "/").replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const rows = results.map((r) => [
  r.id, r.auth + (r.registration && r.auth === "oauth" ? `/${r.registration}` : ""), r.serverAuth ?? "-",
  yesNo(r.registrationOk) + (r.cleanup ? ` (${r.cleanup})` : ""),
  r.authorize ?? "-", r.verdict, cell(r.error ?? r.authorizeDetail ?? r.notes.join("; "), 140),
]);
const header = ["id", "auth", "server", "registration ok", "authorize page", "verdict", "error / detail"];
console.log(`| ${header.join(" | ")} |`);
console.log(`|${header.map(() => "---").join("|")}|`);
for (const row of rows) console.log(`| ${row.join(" | ")} |`);

const counts = results.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {});
console.log(`\n${results.length} entries: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
const out = value("--json");
const json = JSON.stringify({ checkedAt: new Date().toISOString(), counts, results }, null, 2);
if (out) writeFileSync(out, json);
else if (flag("--print-json")) console.log(json);
process.exit(results.some((r) => r.verdict === "fail") ? 1 : 0);
