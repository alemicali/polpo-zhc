/**
 * Unified Cloudflare Worker — serves the Polpo website (static assets)
 * and the Ink Hub API (telemetry + package data).
 *
 * Static assets (Vite build output in dist/) are served automatically
 * by Cloudflare Workers Static Assets. This worker only handles /api/* routes.
 *
 * Storage: Cloudflare D1 (SQLite)
 *
 * Routes:
 *   POST /api/installs               — Record an install event (CLI telemetry)
 *   GET  /api/packages               — List all packages with install counts
 *   GET  /api/packages/:o/:r/:name   — Single package detail
 *   GET  /api/stats                   — Global stats
 *   GET  /api/health                  — Health check
 *   *                                 — Falls through to static assets
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

/* ── Types ────────────────────────────────────────────────────────── */

interface Env {
  INK_DB: D1Database;
  ASSETS: Fetcher;
}

interface InstallPayload {
  source: string;
  packages: {
    name: string;
    type: string;
    description?: string;
    tags?: string[];
    version?: string;
  }[];
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
}

/* ── App ──────────────────────────────────────────────────────────── */

const app = new Hono<{ Bindings: Env }>();

app.use(
  "/api/*",
  cors({
    origin: ["https://polpo.sh", "https://www.polpo.sh", "http://localhost:5173"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

/* ── POST /api/installs ──────────────────────────────────────────── */

app.post("/api/installs", async (c) => {
  const db = c.env.INK_DB;

  let body: InstallPayload;
  try {
    body = await c.req.json<InstallPayload>();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (!body.source || !body.packages?.length) {
    return c.json({ error: "Missing source or packages" }, 400);
  }

  let recorded = 0;

  for (const pkg of body.packages) {
    const tags = JSON.stringify(pkg.tags ?? []);
    const author = body.source.split("/")[0];

    // Upsert: insert or update on conflict
    await db
      .prepare(
        `INSERT INTO packages (source, name, type, description, tags, version, author, installs)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
         ON CONFLICT(source, name) DO UPDATE SET
           installs = installs + 1,
           last_installed = datetime('now'),
           description = CASE WHEN ?4 != '' THEN ?4 ELSE description END,
           tags = CASE WHEN ?5 != '[]' THEN ?5 ELSE tags END,
           version = CASE WHEN ?6 != '0.0.0' THEN ?6 ELSE version END`,
      )
      .bind(
        body.source,
        pkg.name,
        pkg.type || "unknown",
        pkg.description || "",
        tags,
        pkg.version || "0.0.0",
        author,
      )
      .run();

    // Get the package id for the install event
    const row = await db
      .prepare("SELECT id FROM packages WHERE source = ?1 AND name = ?2")
      .bind(body.source, pkg.name)
      .first<{ id: number }>();

    if (row) {
      await db
        .prepare("INSERT INTO installs (package_id) VALUES (?1)")
        .bind(row.id)
        .run();
    }

    recorded++;
  }

  return c.json({ ok: true, recorded });
});

/* ── GET /api/packages ───────────────────────────────────────────── */

app.get("/api/packages", async (c) => {
  const db = c.env.INK_DB;

  const { results } = await db
    .prepare(
      `SELECT
         p.*,
         COALESCE(t.cnt, 0) AS installs24h
       FROM packages p
       LEFT JOIN (
         SELECT package_id, COUNT(*) AS cnt
         FROM installs
         WHERE installed_at >= datetime('now', '-24 hours')
         GROUP BY package_id
       ) t ON t.package_id = p.id
       ORDER BY p.installs DESC`,
    )
    .all<PackageRow & { installs24h: number }>();

  const packages = (results ?? []).map((r) => ({
    source: r.source,
    name: r.name,
    type: r.type,
    description: r.description,
    tags: JSON.parse(r.tags),
    version: r.version,
    author: r.author,
    installs: r.installs,
    installs24h: r.installs24h,
    firstSeen: r.first_seen,
    lastInstalled: r.last_installed,
  }));

  return c.json({ packages, total: packages.length });
});

/* ── GET /api/packages/:owner/:repo/:name ────────────────────────── */

app.get("/api/packages/:owner/:repo/:name", async (c) => {
  const db = c.env.INK_DB;
  const { owner, repo, name } = c.req.param();
  const source = `${owner}/${repo}`;

  const row = await db
    .prepare(
      `SELECT
         p.*,
         COALESCE(t.cnt, 0) AS installs24h
       FROM packages p
       LEFT JOIN (
         SELECT package_id, COUNT(*) AS cnt
         FROM installs
         WHERE installed_at >= datetime('now', '-24 hours')
         GROUP BY package_id
       ) t ON t.package_id = p.id
       WHERE p.source = ?1 AND p.name = ?2`,
    )
    .bind(source, name)
    .first<PackageRow & { installs24h: number }>();

  if (!row) return c.json({ error: "Package not found" }, 404);

  return c.json({
    package: {
      source: row.source,
      name: row.name,
      type: row.type,
      description: row.description,
      tags: JSON.parse(row.tags),
      version: row.version,
      author: row.author,
      installs: row.installs,
      installs24h: row.installs24h,
      firstSeen: row.first_seen,
      lastInstalled: row.last_installed,
    },
  });
});

/* ── GET /api/stats ──────────────────────────────────────────────── */

app.get("/api/stats", async (c) => {
  const db = c.env.INK_DB;

  const stats = await db
    .prepare(
      `SELECT
         COUNT(*) AS totalPackages,
         COALESCE(SUM(installs), 0) AS totalInstalls
       FROM packages`,
    )
    .first<{ totalPackages: number; totalInstalls: number }>();

  return c.json({
    totalPackages: stats?.totalPackages ?? 0,
    totalInstalls: stats?.totalInstalls ?? 0,
  });
});

/* ── GET /api/health ─────────────────────────────────────────────── */

app.get("/api/health", (c) => c.json({ status: "ok", service: "polpo-website" }));

/* ── Fallback: serve static assets (SPA) ─────────────────────────── */

app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
