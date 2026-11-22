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
 *   POST /harnesses/test                    { harness, settings?, agent? }: one tiny model request from this
 *                                           server with that auth and model → { ok, latencyMs, errorKind?, error? }
 */
import { Hono } from "hono";
import {
  agentHarness, harnessesSettingsOf, parseHarnessesSettings,
  type AgentConfig, type AgentHarnessEngine, type ComputerConfig, type HarnessesSettings, type PolpoSettings, type VaultStore,
} from "@polpo-ai/core";
import { testHarnessConnection } from "../../harness/test-connection.js";
import { controlHarnessSession, harnessesOverview, harnessSessionViews } from "../../harness/control.js";
import { type ComputerManager } from "../../sandbox/computers.js";
import { bridgeCommandRunner } from "../../harness/janitor.js";

export interface HarnessRouteDeps {
  polpoDir: () => string;
  settings: () => PolpoSettings | undefined;
  agents: () => Promise<AgentConfig[]>;
  vault: () => VaultStore | undefined;
  manager: () => ComputerManager;
  /** The connection test (tests inject one with a mocked upstream). */
  testConnection?: typeof testHarnessConnection;
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

  // A connection test from this server (never the VM): saved settings, or the ones being edited
  app.post("/test", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { harness?: string; settings?: unknown; agent?: string };
    const harness = body.harness;
    if (harness !== "claude-code" && harness !== "codex") return c.json({ ok: false, error: "harness must be \"claude-code\" or \"codex\"", code: "VALIDATION_ERROR" }, 400);
    let settings: HarnessesSettings | undefined;
    try {
      settings = body.settings !== undefined && body.settings !== null
        ? parseHarnessesSettings(body.settings)
        : harnessesSettingsOf(deps.settings());
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message, code: "VALIDATION_ERROR" }, 400);
    }
    if (!settings?.[harness]) return c.json({ ok: false, error: `${harness === "codex" ? "Codex" : "Claude Code"} has no settings to test`, code: "VALIDATION_ERROR" }, 400);
    let agentEngine: AgentHarnessEngine | undefined;
    if (body.agent) {
      const agent = (await deps.agents()).find((a) => a.name === body.agent);
      if (!agent) return c.json({ ok: false, error: `Unknown agent "${body.agent}"`, code: "NOT_FOUND" }, 404);
      agentEngine = agentHarness(agent);
      if (agentEngine && agentEngine.harness !== harness) agentEngine = undefined;
    }
    const result = await (deps.testConnection ?? testHarnessConnection)({ harness, settings, vault: deps.vault(), ...(agentEngine ? { agentEngine } : {}) });
    return c.json({ ok: true, data: result });
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
