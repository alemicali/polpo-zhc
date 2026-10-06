/**
 * Unified Cloudflare Worker — serves the Polpo website (static assets)
 * and the Ink Hub API (src/hub-api.ts), with Cloudflare D1 as its database.
 *
 * Static assets (Vite build output in dist/) are served by Cloudflare Workers Static Assets;
 * this worker handles /api/* and falls through to them. The self-hosted hub runs the same API
 * on Node (server/index.ts).
 */

import { createHubApi, type HubDb, type PackageType } from "./hub-api";

interface Env {
  INK_DB: D1Database;
  ASSETS: Fetcher;
}

const d1 = (db: D1Database): HubDb => ({
  all: async <T>(sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).all<T>()).results ?? [],
  first: async <T>(sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).first<T>()) ?? undefined,
  run: async (sql: string, params: unknown[] = []) => { await db.prepare(sql).bind(...params).run(); },
});

/** The package's file, from GitHub (public registries). */
async function rawContent(source: string, name: string, type: PackageType): Promise<string | undefined> {
  const base = `https://raw.githubusercontent.com/${source}/main`;
  const path = type === "agent" ? `agents/${name}.json` : type === "playbook" ? `playbooks/${name}/playbook.json` : `companies/${name}/polpo.json`;
  const res = await fetch(`${base}/${path}`);
  return res.ok ? res.text() : undefined;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const api = createHubApi({
      db: d1(env.INK_DB),
      corsOrigins: ["https://polpo.sh", "https://www.polpo.sh", "http://localhost:5173"],
      readContent: rawContent,
      service: "polpo-website",
    });
    return api.fetch(request, env, ctx);
  },
};
