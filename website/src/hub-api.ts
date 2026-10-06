/**
 * Ink Hub API — the routes shared by every host of the hub: the Cloudflare Worker
 * (src/worker.ts, D1) and the self-hosted Node server (server/index.ts, SQLite).
 *
 * Routes:
 *   POST /api/installs                      — record an install event (CLI / agent telemetry)
 *   GET  /api/packages                      — list all packages with install counts
 *   GET  /api/packages/:o/:r/:name          — single package detail
 *   GET  /api/packages/:o/:r/:name/content  — the package's file (agent JSON, playbook.json, polpo.json)
 *   GET  /api/stats                         — global stats
 *   POST /api/reindex                       — read the registries again (hosts that index them)
 *   GET  /api/health                        — health check
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

export type PackageType = "agent" | "playbook" | "company";

/** The database the hub needs: D1 and better-sqlite3 both fit behind it. */
export interface HubDb {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<void>;
}

export interface HubDeps {
  db: HubDb;
  /** Origins allowed to call the API from a browser. */
  corsOrigins: string[];
  /** The package's file, as text; undefined when it cannot be found. */
  readContent: (source: string, name: string, type: PackageType) => Promise<string | undefined>;
  /** Read the registries again (indexing hosts only). */
  reindex?: () => Promise<{ indexed: number; sources: string[] }>;
  service?: string;
}

interface InstallPayload {
  source: string;
  packages: { name: string; type: string; description?: string; tags?: string[]; version?: string }[];
}

interface PackageRow {
  id: number;
  source: string;
  name: string;
  type: string;
  description: string;
  tags: string;
  version: string;
  author: string;
  installs: number;
  first_seen: string;
  last_installed: string;
  installs24h: number;
}

const toPackage = (r: PackageRow) => ({
  source: r.source,
  name: r.name,
  type: r.type,
  description: r.description,
  tags: JSON.parse(r.tags) as string[],
  version: r.version,
  author: r.author,
  installs: r.installs,
  installs24h: r.installs24h,
  firstSeen: r.first_seen,
  lastInstalled: r.last_installed,
});

const WITH_24H = `
  SELECT p.*, COALESCE(t.cnt, 0) AS installs24h
  FROM packages p
  LEFT JOIN (
    SELECT package_id, COUNT(*) AS cnt FROM installs
    WHERE installed_at >= datetime('now', '-24 hours')
    GROUP BY package_id
  ) t ON t.package_id = p.id`;

/** Upsert a package as an install or the indexer reports it. */
export const UPSERT_PACKAGE = `
  INSERT INTO packages (source, name, type, description, tags, version, author, installs)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  ON CONFLICT(source, name) DO UPDATE SET
    installs = installs + ?8,
    last_installed = CASE WHEN ?8 > 0 THEN datetime('now') ELSE last_installed END,
    type = CASE WHEN ?3 != 'unknown' THEN ?3 ELSE type END,
    description = CASE WHEN ?4 != '' THEN ?4 ELSE description END,
    tags = CASE WHEN ?5 != '[]' THEN ?5 ELSE tags END,
    version = CASE WHEN ?6 != '0.0.0' THEN ?6 ELSE version END,
    author = CASE WHEN ?7 != '' THEN ?7 ELSE author END`;

const isType = (t: string): t is PackageType => t === "agent" || t === "playbook" || t === "company";

export function createHubApi(deps: HubDeps): Hono {
  const app = new Hono();
  const { db } = deps;

  app.use("/api/*", cors({ origin: deps.corsOrigins, allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization"] }));

  app.post("/api/installs", async (c) => {
    let body: InstallPayload;
    try {
      body = await c.req.json<InstallPayload>();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (!body.source || !body.packages?.length) return c.json({ error: "Missing source or packages" }, 400);
    let recorded = 0;
    for (const pkg of body.packages) {
      await db.run(UPSERT_PACKAGE, [
        body.source, pkg.name, pkg.type || "unknown", pkg.description || "", JSON.stringify(pkg.tags ?? []),
        pkg.version || "0.0.0", body.source.split("/")[0] ?? "", 1,
      ]);
      const row = await db.first<{ id: number }>("SELECT id FROM packages WHERE source = ?1 AND name = ?2", [body.source, pkg.name]);
      if (row) await db.run("INSERT INTO installs (package_id) VALUES (?1)", [row.id]);
      recorded++;
    }
    return c.json({ ok: true, recorded });
  });

  app.get("/api/packages", async (c) => {
    const rows = await db.all<PackageRow>(`${WITH_24H} ORDER BY p.installs DESC, p.name ASC`);
    const packages = rows.map(toPackage);
    return c.json({ packages, total: packages.length });
  });

  app.get("/api/packages/:owner/:repo/:name", async (c) => {
    const { owner, repo, name } = c.req.param();
    const row = await db.first<PackageRow>(`${WITH_24H} WHERE p.source = ?1 AND p.name = ?2`, [`${owner}/${repo}`, name]);
    if (!row) return c.json({ error: "Package not found" }, 404);
    return c.json({ package: toPackage(row) });
  });

  app.get("/api/packages/:owner/:repo/:name/content", async (c) => {
    const { owner, repo, name } = c.req.param();
    const source = `${owner}/${repo}`;
    const row = await db.first<{ type: string }>("SELECT type FROM packages WHERE source = ?1 AND name = ?2", [source, name]);
    const type = row?.type ?? c.req.query("type") ?? "";
    if (!isType(type)) return c.json({ error: "Package not found" }, 404);
    const text = await deps.readContent(source, name, type);
    if (text === undefined) return c.json({ error: "Content not found" }, 404);
    return c.body(text, 200, { "content-type": "application/json; charset=utf-8" });
  });

  app.get("/api/stats", async (c) => {
    const stats = await db.first<{ totalPackages: number; totalInstalls: number }>(
      "SELECT COUNT(*) AS totalPackages, COALESCE(SUM(installs), 0) AS totalInstalls FROM packages",
    );
    return c.json({ totalPackages: stats?.totalPackages ?? 0, totalInstalls: stats?.totalInstalls ?? 0 });
  });

  app.post("/api/reindex", async (c) => {
    if (!deps.reindex) return c.json({ error: "This hub does not index registries" }, 404);
    return c.json({ ok: true, ...(await deps.reindex()) });
  });

  app.get("/api/health", (c) => c.json({ status: "ok", service: deps.service ?? "polpo-ink-hub" }));

  return app;
}
