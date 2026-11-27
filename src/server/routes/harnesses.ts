/**
 * Agent harnesses (Claude Code, Codex, OpenCode as an agent's engine), for the dashboard, Polpo and MCP.
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
 *   GET  /harnesses/codex/chatgpt-login     ?agent=: Codex's ChatGPT sign-in for that agent: signed in or not
 *                                           (the vault entry holds a login; never its content)
 *   POST /harnesses/codex/chatgpt-login     { agent }: how to sign in: the terminal to open on the agent's
 *                                           computer (`codex login --device-auth` with its CODEX_HOME)
 *   POST /harnesses/codex/chatgpt-login/capture  { agent }: read the login from the agent's computer into
 *                                           the vault (after the sign-in; also done after every run)
 */
import { Hono } from "hono";
import {
  HARNESS_NAMES, agentHarness, harnessesSettingsOf, parseHarnessesSettings,
  type AgentConfig, type AgentHarnessEngine, type ComputerConfig, type HarnessesSettings, type PolpoSettings, type VaultStore,
} from "@polpo-ai/core";
import { testHarnessConnection } from "../../harness/test-connection.js";
import { controlHarnessSession, harnessesOverview, harnessSessionViews } from "../../harness/control.js";
import { type ComputerManager } from "../../sandbox/computers.js";
import { bridgeCommandRunner } from "../../harness/janitor.js";
import { captureCodexAuth, codexChatgptHome, codexChatgptLoginCommand, codexChatgptTarget, type CodexCaptureStatus } from "../../harness/codex-chatgpt.js";
import { codexChatgptStatus } from "../../harness/control.js";
import { driverHost } from "../../sandbox/computers.js";

export interface HarnessRouteDeps {
  polpoDir: () => string;
  settings: () => PolpoSettings | undefined;
  agents: () => Promise<AgentConfig[]>;
  vault: () => VaultStore | undefined;
  manager: () => ComputerManager;
  /** The connection test (tests inject one with a mocked upstream). */
  testConnection?: typeof testHarnessConnection;
  /**
   * Reads a file of a computer when it is running (never starts it): undefined when it is not
   * running, null when the file does not exist. Tests inject one; default: the computer manager.
   */
  readComputerFile?: (computerId: string, path: string) => Promise<string | null | undefined>;
}

const CAPTURE_MESSAGES: Record<CodexCaptureStatus, string> = {
  updated: "Signed in with ChatGPT: the login is saved in the vault.",
  unchanged: "Signed in with ChatGPT: the vault already has this login.",
  missing: "No ChatGPT login on the agent's computer yet: complete the sign-in in the terminal (open the link, enter the code), then capture again.",
  invalid: "The file Codex left on the agent's computer holds no login: sign in again.",
  older: "The vault has a newer login than the agent's computer: kept the vault's.",
};

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
    if (harness !== "claude-code" && harness !== "codex" && harness !== "opencode") return c.json({ ok: false, error: "harness must be \"claude-code\", \"codex\" or \"opencode\"", code: "VALIDATION_ERROR" }, 400);
    let settings: HarnessesSettings | undefined;
    try {
      settings = body.settings !== undefined && body.settings !== null
        ? parseHarnessesSettings(body.settings)
        : harnessesSettingsOf(deps.settings());
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message, code: "VALIDATION_ERROR" }, 400);
    }
    if (!settings?.[harness]) return c.json({ ok: false, error: `${HARNESS_NAMES[harness]} has no settings to test`, code: "VALIDATION_ERROR" }, 400);
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

  // ── Codex signed in with ChatGPT: status, the sign-in terminal, the capture into the vault ──
  const chatgptTarget = async (agent: string | undefined) =>
    codexChatgptTarget({ settings: deps.settings(), agents: await deps.agents(), agent, polpoDir: deps.polpoDir() });

  app.get("/codex/chatgpt-login", async (c) => {
    const t = await chatgptTarget(c.req.query("agent") || undefined);
    if (!t.ok) return c.json({ ok: false, error: t.error, code: t.status === 404 ? "NOT_FOUND" : "CONFLICT" }, t.status);
    return c.json({ ok: true, data: { agent: t.agent, computer: t.computer, credentialRef: t.ref, ...(await codexChatgptStatus(deps.vault(), t.ref)) } });
  });

  app.post("/codex/chatgpt-login", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { agent?: string };
    const t = await chatgptTarget(body.agent);
    if (!t.ok) return c.json({ ok: false, error: t.error, code: t.status === 404 ? "NOT_FOUND" : "CONFLICT" }, t.status);
    const status = await codexChatgptStatus(deps.vault(), t.ref);
    return c.json({
      ok: true,
      data: {
        mode: "terminal",
        agent: t.agent,
        computer: t.computer,
        // the dashboard's terminal: /ws/terminal?agent=codex-chatgpt-login&harness_agent=<agent>
        terminal: { agent: "codex-chatgpt-login", harness_agent: t.agent },
        command: codexChatgptLoginCommand(t.agent, t.hostHome ?? "$HOME"),
        codexHome: codexChatgptHome(t.hostHome ?? "$HOME", t.agent),
        credentialRef: t.ref,
        ...status,
        note: `Codex shows a link and a code: open the link, sign in with the ChatGPT account whose plan pays for this agent's work, and enter the code. `
          + `Then capture the login (POST /harnesses/codex/chatgpt-login/capture): it is saved in the vault entry ${t.ref.owner} / ${t.ref.service}, `
          + `written into the agent's computer before each run and saved back when Codex refreshes it.${t.computer !== "host" ? ` The terminal runs on computer "${t.computer}" (started if it is not running).` : ""}`,
      },
    });
  });

  app.post("/codex/chatgpt-login/capture", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { agent?: string };
    const t = await chatgptTarget(body.agent);
    if (!t.ok) return c.json({ ok: false, error: t.error, code: t.status === 404 ? "NOT_FOUND" : "CONFLICT" }, t.status);
    const vault = deps.vault();
    if (!vault) return c.json({ ok: false, error: "This instance has no vault", code: "UNAVAILABLE" }, 409);
    const home = codexChatgptHome(t.hostHome ?? "$HOME", t.agent);
    const read = deps.readComputerFile ?? (async (computerId: string, path: string): Promise<string | null | undefined> => {
      if (computerId === "host") {
        const { readFile } = await import("node:fs/promises");
        return readFile(path, "utf8").catch(() => null);
      }
      const computer = ((deps.settings()?.computers ?? []) as ComputerConfig[]).find((x) => x.id === computerId);
      if (!computer) return undefined;
      return deps.manager().whenRunning(computer, async (d) => {
        const r = await driverHost(d).exec(`cat "${path}" 2>/dev/null`, { timeoutMs: 15_000 });
        return r.exitCode === 0 && r.stdout.trim() ? r.stdout : null;
      });
    });
    let notRunning = false;
    try {
      const r = await captureCodexAuth({
        read: async () => {
          const text = await read(t.computer, `${home}/auth.json`);
          if (text === undefined) notRunning = true;
          return text ?? undefined;
        },
        vault, ref: t.ref,
      });
      if (notRunning) return c.json({ ok: false, error: `Computer "${t.computer}" is not running: start it (or sign in again) and capture again`, code: "UNAVAILABLE" }, 409);
      const status = await codexChatgptStatus(vault, t.ref);
      return c.json({ ok: true, data: { agent: t.agent, computer: t.computer, credentialRef: t.ref, result: r.status, message: CAPTURE_MESSAGES[r.status], ...status } });
    } catch (err) {
      return c.json({ ok: false, error: `Saving the ChatGPT sign-in to the vault failed: ${(err as Error).message}`, code: "UNAVAILABLE" }, 409);
    }
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
