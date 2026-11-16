/**
 * Browser profiles (agents' persistent browser state) for the dashboard and API clients:
 *
 *   GET    /browser-profiles                    the profiles, their agents, size, cookies, open login
 *   POST   /browser-profiles/:name/login        { url }: open the profile there, in the Live browser view
 *   POST   /browser-profiles/:name/login/finish close the login session (the profile keeps the login)
 *   DELETE /browser-profiles/:name              delete the profile and its logins
 */
import { Hono } from "hono";
import {
  clearBrowserProfile, finishProfileLogin, listBrowserProfiles, startProfileLogin, type BrowserProfileAgent,
} from "../../tools/browser-profiles.js";

export interface BrowserProfileRouteDeps {
  polpoDir: () => string;
  agents: () => Promise<BrowserProfileAgent[]>;
}

export function browserProfileRoutes(deps: BrowserProfileRouteDeps): Hono {
  const app = new Hono();
  const fail = (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) });

  app.get("/", async (c) => c.json({ ok: true, data: { profiles: await listBrowserProfiles(deps.polpoDir(), await deps.agents()) } }));

  app.post("/:name/login", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { url?: unknown };
    if (typeof body.url !== "string" || !body.url.trim()) return c.json({ ok: false, error: "url is required" }, 400);
    try {
      return c.json({ ok: true, data: await startProfileLogin(deps.polpoDir(), c.req.param("name"), body.url.trim()) });
    } catch (err) {
      return c.json(fail(err), 400);
    }
  });

  app.post("/:name/login/finish", async (c) => {
    try {
      return c.json({ ok: true, data: { closed: await finishProfileLogin(c.req.param("name")) } });
    } catch (err) {
      return c.json(fail(err), 400);
    }
  });

  app.delete("/:name", async (c) => {
    try {
      return c.json({ ok: true, data: await clearBrowserProfile(deps.polpoDir(), c.req.param("name"), await deps.agents()) });
    } catch (err) {
      return c.json(fail(err), 400);
    }
  });

  return app;
}
