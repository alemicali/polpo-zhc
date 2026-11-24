/**
 * CLI accounts (the CLI engine's personal sign-ins: Claude Code, Codex), mounted under
 * /api/v1/harnesses/cli. An account is a config directory on a computer; Polpo never sees a token.
 *
 *   GET    /harnesses/cli/accounts                 accounts with installed version and sign-in status (?status=0 skips the checks)
 *   POST   /harnesses/cli/accounts                 { cli, id?, computer?, label?, owner? } add one (owner: you, or "instance")
 *   PATCH  /harnesses/cli/accounts/:id             { label?, owner? }
 *   DELETE /harnesses/cli/accounts/:id             remove it (refused while agents use it); its sign-in stays in the directory until signed out
 *   GET    /harnesses/cli/accounts/:id/status      installed version and sign-in status
 *   POST   /harnesses/cli/accounts/:id/logout      sign out with the CLI's own command
 *   GET    /harnesses/cli/accounts/:id/login       how to sign in: the terminal to open (this server) or the command to run (a remote computer)
 *   POST   /harnesses/cli/install                  { cli, computer? } install the CLI with its official installer
 *   PATCH  /harnesses/cli/settings                 { allowInstanceCodex }
 *
 * Signing in happens in the dashboard's terminal (/ws/terminal?agent=cli-login&cli_account=<id>),
 * running `claude auth login` / `codex login --device-auth` with the account's directory: the
 * person completes Anthropic's / OpenAI's own sign-in in their browser.
 */
import { Hono } from "hono";
import {
  CLI_CONFIG_ENV, CLI_IDS, CLI_INSTANCE_OWNER, CLI_LOGIN_COMMANDS, CLI_NAMES, HOST_COMPUTER_ID, agentCliEngine, defaultCliConfigDir,
  parseCliAccount, parseCliSettings, type AgentConfig, type CliAccount, type CliId, type CliSettings, type ComputerConfig, type PolpoSettings,
} from "@polpo-ai/core";
import {
  cliAccountLogout, cliAccountReport, cliInstall, hostAccountOps, remoteAccountPrefix, type AccountOps, type CliCommandRunner,
} from "../../cli-engine/accounts.js";
import { cliHostEnv } from "../../cli-engine/process.js";

export interface CliAccountRouteDeps {
  settings: () => PolpoSettings | undefined;
  agents: () => Promise<AgentConfig[]>;
  /** Write settings.harnesses.cli and reload the configuration. */
  save: (cli: CliSettings | undefined) => Promise<void>;
  /** Runs a command on a remote computer (undefined: not running / unreachable). */
  onComputer?: (computerId: string, command: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string } | undefined>;
  /** Commands on this server (tests inject one). */
  hostRunner?: CliCommandRunner;
  /** The member signed in (instance sign-in), if any. */
  member: (c: { get(key: never): unknown }) => string | undefined;
  /** The instance has member sign-in. */
  instanceAuth: () => boolean;
}

const err = (error: string, code = "VALIDATION_ERROR") => ({ ok: false as const, error, code });

export function cliAccountRoutes(deps: CliAccountRouteDeps): Hono {
  const app = new Hono();
  const current = (): CliSettings => {
    const raw = (deps.settings()?.harnesses as { cli?: unknown } | undefined)?.cli;
    try { return raw ? parseCliSettings(raw) : { accounts: [] }; } catch { return { accounts: [] }; }
  };
  const computers = () => (deps.settings()?.computers ?? []) as ComputerConfig[];
  const opsFor = (computer: string): AccountOps | { error: string } => {
    if (computer === HOST_COMPUTER_ID) return hostAccountOps(deps.hostRunner);
    if (!computers().some((c) => c.id === computer)) return { error: `Unknown computer "${computer}"` };
    if (!deps.onComputer) return { error: `Computer "${computer}" is not reachable from this server` };
    return {
      run: async (command, _env, opts) => {
        const r = await deps.onComputer!(computer, command, opts?.timeoutMs ?? 30_000);
        if (!r) throw new Error(`Computer "${computer}" is not running: start it to check or change its CLI accounts`);
        return r;
      },
      envFor: () => ({}),
      prefixFor: (a) => remoteAccountPrefix(a),
    };
  };
  /** Who may change or sign in an account: its owner, anyone for "instance" accounts, anyone without member sign-in. */
  const mayManage = (c: { get(key: never): unknown }, a: CliAccount): boolean => {
    if (!deps.instanceAuth()) return true;
    const me = deps.member(c);
    return a.owner === CLI_INSTANCE_OWNER || (!!me && me === a.owner);
  };
  const usersOf = async (id: string) => (await deps.agents()).filter((a) => agentCliEngine(a)?.account === id).map((a) => a.name);

  app.get("/accounts", async (c) => {
    const s = current();
    const withStatus = c.req.query("status") !== "0";
    const agents = await deps.agents();
    const accounts = await Promise.all(s.accounts.map(async (a) => {
      const ops = opsFor(a.computer);
      const report = withStatus
        ? ("error" in ops ? { id: a.id, installed: false, error: ops.error } : await cliAccountReport(a, ops).catch((e) => ({ id: a.id, installed: false, error: (e as Error).message })))
        : undefined;
      const users = agents.filter((x) => { const e = agentCliEngine(x); return e?.cli === a.cli && (e.account === a.id || (!e.account && (x.defaultComputer || HOST_COMPUTER_ID) === a.computer)); }).map((x) => x.name);
      return { ...a, ...(report ? { report } : {}), agents: users, manageable: mayManage(c, a) };
    }));
    return c.json({ ok: true, data: { accounts, allowInstanceCodex: !!s.allowInstanceCodex, clis: CLI_IDS.map((id) => ({ id, name: CLI_NAMES[id], login: CLI_LOGIN_COMMANDS[id], configEnv: CLI_CONFIG_ENV[id] })) } });
  });

  app.post("/accounts", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const cli = body.cli as CliId;
    if (!(CLI_IDS as string[]).includes(cli)) return c.json(err(`cli must be one of ${CLI_IDS.join(", ")}`), 400);
    const me = deps.member(c);
    // the owner is the person who will sign in: you (or "instance" without member sign-in, or on request)
    const owner = typeof body.owner === "string" && body.owner ? body.owner.toLowerCase() : me ?? CLI_INSTANCE_OWNER;
    if (deps.instanceAuth() && owner !== CLI_INSTANCE_OWNER && owner !== me) {
      return c.json(err("An account belongs to the member who signs in with it: create it signed in as that member (owner is you)", "FORBIDDEN"), 403);
    }
    const s = current();
    const base = (typeof body.id === "string" && body.id) || `${(me ?? "instance").split("@")[0]!.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 24)}-${cli}`;
    let id = base.replace(/^-+/, "") || cli;
    for (let i = 2; s.accounts.some((a) => a.id === id); i++) id = `${base}-${i}`;
    let account: CliAccount;
    try {
      account = parseCliAccount({
        id, cli, owner, computer: body.computer ?? HOST_COMPUTER_ID,
        configDir: body.configDir ?? defaultCliConfigDir(cli, id), ...(typeof body.label === "string" ? { label: body.label } : {}),
      }, "account");
      if (account.computer !== HOST_COMPUTER_ID && !computers().some((x) => x.id === account.computer)) return c.json(err(`Unknown computer "${account.computer}"`), 400);
      const next = parseCliSettings({ ...s, accounts: [...s.accounts, account] });
      await deps.save(next);
    } catch (e) {
      return c.json(err((e as Error).message), 400);
    }
    return c.json({ ok: true, data: account }, 201);
  });

  app.patch("/accounts/:id", async (c) => {
    const s = current();
    const a = s.accounts.find((x) => x.id === c.req.param("id"));
    if (!a) return c.json(err("Unknown account", "NOT_FOUND"), 404);
    if (!mayManage(c, a)) return c.json(err(`Only ${a.owner} can change this account`, "FORBIDDEN"), 403);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const me = deps.member(c);
    if (body.owner !== undefined && deps.instanceAuth() && body.owner !== CLI_INSTANCE_OWNER && String(body.owner).toLowerCase() !== me) {
      return c.json(err("The owner is the member who signed in: you can set it to yourself or \"instance\"", "FORBIDDEN"), 403);
    }
    try {
      const updated = parseCliAccount({ ...a, ...(body.label !== undefined ? { label: body.label || undefined } : {}), ...(body.owner !== undefined ? { owner: body.owner } : {}) }, "account");
      await deps.save(parseCliSettings({ ...s, accounts: s.accounts.map((x) => (x.id === a.id ? updated : x)) }));
      return c.json({ ok: true, data: updated });
    } catch (e) {
      return c.json(err((e as Error).message), 400);
    }
  });

  app.delete("/accounts/:id", async (c) => {
    const s = current();
    const a = s.accounts.find((x) => x.id === c.req.param("id"));
    if (!a) return c.json(err("Unknown account", "NOT_FOUND"), 404);
    if (!mayManage(c, a)) return c.json(err(`Only ${a.owner} can remove this account`, "FORBIDDEN"), 403);
    const users = await usersOf(a.id);
    if (users.length) return c.json(err(`Agents use this account: ${users.join(", ")}. Change their engine first.`, "CONFLICT"), 409);
    const accounts = s.accounts.filter((x) => x.id !== a.id);
    await deps.save(accounts.length || s.allowInstanceCodex ? { ...s, accounts } : undefined);
    return c.json({ ok: true, data: { removed: a.id, note: "The sign-in stays in its directory on the computer until you sign out (POST …/logout before removing)." } });
  });

  app.get("/accounts/:id/status", async (c) => {
    const a = current().accounts.find((x) => x.id === c.req.param("id"));
    if (!a) return c.json(err("Unknown account", "NOT_FOUND"), 404);
    const ops = opsFor(a.computer);
    if ("error" in ops) return c.json(err(ops.error, "UNAVAILABLE"), 409);
    try { return c.json({ ok: true, data: await cliAccountReport(a, ops) }); } catch (e) { return c.json(err((e as Error).message, "UNAVAILABLE"), 409); }
  });

  app.post("/accounts/:id/logout", async (c) => {
    const a = current().accounts.find((x) => x.id === c.req.param("id"));
    if (!a) return c.json(err("Unknown account", "NOT_FOUND"), 404);
    if (!mayManage(c, a)) return c.json(err(`Only ${a.owner} can sign this account out`, "FORBIDDEN"), 403);
    const ops = opsFor(a.computer);
    if ("error" in ops) return c.json(err(ops.error, "UNAVAILABLE"), 409);
    try { return c.json({ ok: true, data: await cliAccountLogout(a, ops) }); } catch (e) { return c.json(err((e as Error).message, "UNAVAILABLE"), 409); }
  });

  app.get("/accounts/:id/login", (c) => {
    const a = current().accounts.find((x) => x.id === c.req.param("id"));
    if (!a) return c.json(err("Unknown account", "NOT_FOUND"), 404);
    if (!mayManage(c, a)) return c.json(err(`Only ${a.owner} can sign in this account: it is their personal sign-in`, "FORBIDDEN"), 403);
    const command = `${CLI_CONFIG_ENV[a.cli]}=${a.configDir} ${CLI_LOGIN_COMMANDS[a.cli]}`;
    if (a.computer === HOST_COMPUTER_ID) {
      return c.json({ ok: true, data: { mode: "terminal", terminal: { agent: "cli-login", cli_account: a.id }, command } });
    }
    // a remote computer: the same terminal, opened on that computer (its provider's PTY; started when needed)
    if (!computers().some((x) => x.id === a.computer)) return c.json(err(`Unknown computer "${a.computer}"`, "UNAVAILABLE"), 409);
    return c.json({
      ok: true,
      data: {
        mode: "terminal", computer: a.computer, terminal: { agent: "cli-login", cli_account: a.id }, command,
        note: `The sign-in runs in a terminal on computer "${a.computer}" (started if it is not running). The credentials stay on that computer's disk: hibernation (Daytona v2) and pause (E2B) keep them; a reset or a delete of the computer signs the account out, and an ephemeral sandbox cannot hold a sign-in.`,
      },
    });
  });

  app.post("/install", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { cli?: string; computer?: string };
    const cli = body.cli as CliId;
    if (!(CLI_IDS as string[]).includes(cli)) return c.json(err(`cli must be one of ${CLI_IDS.join(", ")}`), 400);
    const computer = body.computer || HOST_COMPUTER_ID;
    const ops = opsFor(computer);
    if ("error" in ops) return c.json(err(ops.error, "UNAVAILABLE"), 409);
    const env = computer === HOST_COMPUTER_ID ? cliHostEnv(cli, { configDir: "~" }) : {};
    try {
      const r = await cliInstall(cli, ops, env);
      return c.json({ ok: true, data: r }, r.ok ? 200 : 502);
    } catch (e) {
      return c.json(err((e as Error).message, "UNAVAILABLE"), 409);
    }
  });

  app.patch("/settings", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { allowInstanceCodex?: unknown };
    if (typeof body.allowInstanceCodex !== "boolean") return c.json(err("allowInstanceCodex must be true or false"), 400);
    const s = current();
    await deps.save({ ...s, ...(body.allowInstanceCodex ? { allowInstanceCodex: true } : { allowInstanceCodex: undefined }) });
    return c.json({ ok: true, data: { allowInstanceCodex: body.allowInstanceCodex } });
  });

  return app;
}
