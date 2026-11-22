/**
 * Agent harnesses (Claude Code, Codex as an agent's engine), for the dashboard, Polpo and MCP.
 * Mounted under the authenticated API (/api/v1/harnesses). The settings themselves change through
 * PATCH /config/settings { harnesses } (vault references only, never secrets).
 *
 *   GET  /harnesses                         each harness: enabled, auth, credential reference and whether
 *                                           its vault entry exists (never its value), model, agents on it
 *   GET  /harnesses/sessions                harness sessions (?agent=, ?computer=): bootstrapped, live,
 *                                           last detach/resume, turns, cost so far
 *   POST /harnesses/sessions/:key/stop      stop the runtime (the conversation stays resumable)
 *   POST /harnesses/sessions/:key/reset     { confirm: true }: stop and forget it (a new conversation next time)
 */
import { Hono } from "hono";
import type { AgentConfig, ComputerConfig, PolpoSettings, VaultStore } from "@polpo-ai/core";
import { controlHarnessSession, harnessesOverview, harnessSessionViews } from "../../harness/control.js";
import { type ComputerManager } from "../../sandbox/computers.js";
import { bridgeCommandRunner } from "../../harness/janitor.js";

export interface HarnessRouteDeps {
  polpoDir: () => string;
  settings: () => PolpoSettings | undefined;
  agents: () => Promise<AgentConfig[]>;
  vault: () => VaultStore | undefined;
  manager: () => ComputerManager;
}

export function harnessRoutes(deps: HarnessRouteDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const data = await harnessesOverview(deps.settings(), deps.vault(), await deps.agents());
    return c.json({ ok: true, data });
  });

  app.get("/sessions", (c) => {
    const sessions = harnessSessionViews(deps.polpoDir(), { agent: c.req.query("agent") || undefined, computer: c.req.query("computer") || undefined });
    return c.json({ ok: true, data: { sessions } });
  });

  for (const action of ["stop", "reset"] as const) {
    app.post(`/sessions/:key/${action}`, async (c) => {
      const key = c.req.param("key");
      if (action === "reset") {
        const body = await c.req.json().catch(() => ({})) as { confirm?: boolean };
        if (body.confirm !== true) return c.json({ ok: false, error: "Resetting forgets the session's conversation: send { confirm: true }", code: "CONFIRM_REQUIRED" }, 400);
      }
      const r = await controlHarnessSession({
        polpoDir: deps.polpoDir(), vault: deps.vault(), settings: deps.settings(), key, action,
        onComputer: bridgeCommandRunner(deps.manager, () => (deps.settings()?.computers ?? []) as ComputerConfig[]),
      });
      if (!r.ok) return c.json({ ok: false, error: r.error, code: r.status === 404 ? "NOT_FOUND" : "CONFLICT" }, r.status);
      return c.json({ ok: true, data: { message: r.message, ...(r.session ? { session: r.session } : {}) } });
    });
  }

  return app;
}
