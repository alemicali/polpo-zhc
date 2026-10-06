/**
 * Self-hosted Ink Hub: the hub API (src/hub-api.ts) and the website (dist/) on Node, with
 * SQLite instead of Cloudflare D1, and an indexer that reads the registries itself, so the
 * catalogue lists every template, not only the ones someone installed.
 *
 * Environment:
 *   PORT, HOST                 where to listen (default 3700 on 127.0.0.1)
 *   INK_DATA_DIR               database and registry clones (default ./data)
 *   INK_REGISTRIES             registries to index, comma separated "owner/repo" (GitHub; private
 *                              ones through the machine's git credentials)
 *   INK_REINDEX_MINUTES        how often to read them again (default 15; 0 = only on POST /api/reindex)
 *   INK_STATIC_DIR             the built website (default ../dist next to this server)
 *   INK_CORS_ORIGINS           extra browser origins allowed on the API, comma separated
 *   INK_HUB_ONLY               "1": "/" goes to the catalogue (/ink), no marketing page
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createHubApi, UPSERT_PACKAGE, type HubDb, type PackageType } from "../src/hub-api.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3700);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA = resolve(process.env.INK_DATA_DIR ?? "./data");
const STATIC = resolve(process.env.INK_STATIC_DIR ?? join(here, "../../dist"));
const REGISTRIES = (process.env.INK_REGISTRIES ?? "").split(",").map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s));
const REINDEX_MINUTES = Number(process.env.INK_REINDEX_MINUTES ?? 15);
const CORS = ["http://localhost:5173", ...(process.env.INK_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)];

mkdirSync(join(DATA, "registries"), { recursive: true });

// ── Database ────────────────────────────────────────────────────────

const sqlite = new Database(join(DATA, "ink.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'unknown',
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    version TEXT NOT NULL DEFAULT '0.0.0',
    author TEXT NOT NULL DEFAULT '',
    installs INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_installed TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source, name)
  );
  CREATE TABLE IF NOT EXISTS installs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL REFERENCES packages(id),
    installed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_installs_at ON installs(installed_at);
  CREATE INDEX IF NOT EXISTS idx_packages_source_name ON packages(source, name);
  CREATE INDEX IF NOT EXISTS idx_packages_installs ON packages(installs DESC);
`);

// D1 numbers its parameters ?1, ?2…: better-sqlite3 takes them as an object keyed by number
const bind = (params: unknown[] = []) => Object.fromEntries(params.map((p, i) => [i + 1, p]));
const db: HubDb = {
  all: async <T>(sql: string, params?: unknown[]) => sqlite.prepare(sql).all(bind(params)) as T[],
  first: async <T>(sql: string, params?: unknown[]) => sqlite.prepare(sql).get(bind(params)) as T | undefined,
  run: async (sql: string, params?: unknown[]) => { sqlite.prepare(sql).run(bind(params)); },
};

// ── Registries ──────────────────────────────────────────────────────

const cloneDir = (source: string) => join(DATA, "registries", source.replace("/", "__"));
const SAFE_NAME = /^[\w.-]+$/;

function fileOf(source: string, name: string, type: PackageType): string | undefined {
  if (!SAFE_NAME.test(name)) return undefined;
  const dir = cloneDir(source);
  return type === "agent" ? join(dir, "agents", `${name}.json`)
    : type === "playbook" ? join(dir, "playbooks", name, "playbook.json")
      : join(dir, "companies", name, "polpo.json");
}

async function readContent(source: string, name: string, type: PackageType): Promise<string | undefined> {
  const file = fileOf(source, name, type);
  return file && existsSync(file) ? readFileSync(file, "utf-8") : undefined;
}

/** Clone the registry, or bring it to the latest commit of its default branch. */
async function sync(source: string): Promise<void> {
  const dir = cloneDir(source);
  const opts = { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
  if (!existsSync(join(dir, ".git"))) {
    await run("git", ["clone", "--depth", "1", `https://github.com/${source}.git`, dir], opts);
    return;
  }
  await run("git", ["-C", dir, "fetch", "--depth", "1", "origin", "HEAD"], opts);
  await run("git", ["-C", dir, "reset", "--hard", "FETCH_HEAD"], opts);
}

interface Found { name: string; type: PackageType; description: string; tags: string[]; version: string; author: string }

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    if (statSync(file).size > 1024 * 1024) return undefined;
    const v = JSON.parse(readFileSync(file, "utf-8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const tagsOf = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : []);

/** The templates of a registry, by its folder convention (see src/core/ink.ts in polpo-zhc). */
function discover(source: string): Found[] {
  const dir = cloneDir(source);
  const found: Found[] = [];
  const meta = (o: Record<string, unknown>, name: string, type: PackageType, description: string): Found => ({
    name, type, description, tags: tagsOf(o.tags), version: str(o.version) || "0.0.0", author: str(o.author) || source.split("/")[0]!,
  });
  const agents = join(dir, "agents");
  if (existsSync(agents)) {
    for (const f of readdirSync(agents).filter((f) => f.endsWith(".json"))) {
      const o = readJson(join(agents, f));
      if (!o) continue;
      const identity = (o.identity && typeof o.identity === "object" ? o.identity : {}) as Record<string, unknown>;
      found.push(meta(o, str(o.name) || f.slice(0, -5), "agent", str(o.description) || str(o.role) || str(identity.title) || str(identity.bio)));
    }
  }
  for (const [folder, file, type] of [["playbooks", "playbook.json", "playbook"], ["companies", "polpo.json", "company"]] as const) {
    const base = join(dir, folder);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const o = readJson(join(base, name, file));
      if (!o) continue;
      const teams = Array.isArray(o.teams) ? o.teams.length : 0;
      const description = str(o.description) || (type === "company" ? `A ready company setup${teams ? ` with ${teams} team${teams === 1 ? "" : "s"}` : ""}` : "");
      found.push(meta(o, name, type, description));
    }
  }
  return found.filter((p) => SAFE_NAME.test(p.name)).slice(0, 100);
}

let indexing: Promise<{ indexed: number; sources: string[] }> | undefined;

/** Read every registry again: new templates appear, removed ones go, install counts stay. */
async function reindex(): Promise<{ indexed: number; sources: string[] }> {
  indexing ??= (async () => {
    let indexed = 0;
    const sources: string[] = [];
    for (const source of REGISTRIES) {
      try {
        await sync(source);
        const found = discover(source);
        for (const p of found) {
          await db.run(UPSERT_PACKAGE, [source, p.name, p.type, p.description, JSON.stringify(p.tags), p.version, p.author, 0]);
        }
        const keep = new Set(found.map((p) => p.name));
        for (const row of await db.all<{ id: number; name: string }>("SELECT id, name FROM packages WHERE source = ?1", [source])) {
          if (keep.has(row.name)) continue;
          await db.run("DELETE FROM installs WHERE package_id = ?1", [row.id]);
          await db.run("DELETE FROM packages WHERE id = ?1", [row.id]);
        }
        indexed += found.length;
        sources.push(source);
      } catch (err) {
        console.error(`[ink-hub] ${source}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`[ink-hub] indexed ${indexed} templates from ${sources.join(", ") || "no registry"}`);
    return { indexed, sources };
  })().finally(() => { indexing = undefined; });
  return indexing;
}

// ── HTTP ────────────────────────────────────────────────────────────

const app = new Hono();
app.route("/", createHubApi({ db, corsOrigins: CORS, readContent, reindex, service: "polpo-ink-hub" }));
if (process.env.INK_HUB_ONLY === "1") app.get("/", (c) => c.redirect("/ink"));
app.use("/*", serveStatic({ root: STATIC }));
// the website is a single-page app: every other path is its index
app.get("*", (c) => c.html(readFileSync(join(STATIC, "index.html"), "utf-8")));

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`[ink-hub] http://${HOST}:${PORT} · registries: ${REGISTRIES.join(", ") || "none"} · static: ${STATIC}`);
});

void reindex();
if (REINDEX_MINUTES > 0) setInterval(() => void reindex(), REINDEX_MINUTES * 60_000).unref();
