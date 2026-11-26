/**
 * Codex signed in with ChatGPT (settings.harnesses.codex.auth "chatgpt"): the setting, the
 * credential resolution (no API key, the login cache from the vault, its tokens masked), the seed
 * into the agent's CODEX_HOME and the write-back into the vault (changed vs unchanged vs older),
 * the engine (CODEX_HOME for the runtime, write-back after a turn, at the end and before the VM
 * goes), the REST sign-in routes and the sign-in terminal.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseHarnessesSettings } from "@polpo-ai/core";
import { brokeredHarnessAuth, resolveHarnessAuth } from "../harness/credentials.js";
import {
  captureCodexAuth, codexAuthSecrets, codexChatgptHome, codexChatgptLoginCommand, codexChatgptTarget, parseCodexAuthJson, seedCodexAuth,
} from "../harness/codex-chatgpt.js";
import { testHarnessConnection } from "../harness/test-connection.js";
import { liveHarnessSessions } from "../harness/live-sessions.js";
import { harnessesOverview } from "../harness/control.js";
import { spawnHarnessEngine } from "../adapters/harness-engine.js";
import { harnessRoutes } from "../server/routes/harnesses.js";
import { codexChatgptLoginInvocation } from "../server/terminal.js";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
beforeEach(() => liveHarnessSessions.clear());
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ref = { owner: "ops", service: "codex-chatgpt" };
const authJson = (access: string, refreshedAt: string) => JSON.stringify({
  auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: refreshedAt,
  tokens: { id_token: `id-${access}`, access_token: access, refresh_token: `rt-${access}`, account_id: "acct-1" },
});
const OLD = authJson("at-OLD-1234567", "2026-11-01T10:00:00.000Z");
const NEW = authJson("at-NEW-7654321", "2026-11-20T10:00:00.000Z");

/** A vault in memory with patch (merges credentials). */
function memoryVault(seed: Record<string, Record<string, string>> = {}) {
  const m = new Map<string, any>(Object.entries(seed).map(([k, credentials]) => [k, { type: "custom", credentials }]));
  const patches: string[] = [];
  return {
    m, patches,
    get: async (o: string, s: string) => m.get(`${o}/${s}`),
    set: async (o: string, s: string, e: any) => { m.set(`${o}/${s}`, e); },
    patch: async (o: string, s: string, p: any) => {
      patches.push(`${o}/${s}`);
      const cur = m.get(`${o}/${s}`) ?? { type: p.type, credentials: {} };
      m.set(`${o}/${s}`, { ...cur, ...(p.label ? { label: p.label } : {}), credentials: { ...cur.credentials, ...(p.credentials ?? {}) } });
      return Object.keys(m.get(`${o}/${s}`).credentials);
    },
    remove: async (o: string, s: string) => m.delete(`${o}/${s}`),
    getAllForAgent: async () => ({}), list: async () => [], hasEntries: async () => false, renameAgent: async () => {}, removeAgent: async () => {},
  } as any;
}

/** A machine with files in memory. */
function memoryMachine(root: string, home = "/home/daytona") {
  const files = new Map<string, string>();
  const execs: string[] = [];
  const spawns: Array<{ command: string; env?: Record<string, string> }> = [];
  const machine = {
    id: "nina", description: "", workDir: root, files, execs, spawns,
    exec: async (c: string) => {
      execs.push(c);
      if (c.startsWith("printf %s")) return { exitCode: 0, stdout: home, stderr: "" };
      if (c.startsWith("for p in")) return { exitCode: 0, stdout: "4007", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readFile: async (p: string) => (files.has(p) ? new TextEncoder().encode(files.get(p)!) : null),
    writeFile: async (p: string, d: Uint8Array) => { files.set(p, new TextDecoder().decode(d)); },
    stat: async () => null, list: async () => null, remove: async () => false,
    spawn: async (command: string, o: { env?: Record<string, string> }) => {
      spawns.push({ command, ...(o.env ? { env: o.env } : {}) });
      return { id: "p1", stdout: new ReadableStream({ start(c) { c.close(); } }), stderr: new ReadableStream({ start(c) { c.close(); } }), wait: async () => ({ exitCode: 0 }), kill: async () => {}, detach: () => {} };
    },
    portEndpoint: async () => ({ url: "ws://x" }), close: () => {},
  };
  return machine;
}

describe("settings and credentials", () => {
  it("parses auth chatgpt; resolves with no API key, an explicit empty auth environment, the login masked", async () => {
    const settings = parseHarnessesSettings({ enabled: ["codex"], codex: { auth: "chatgpt", credentialRef: ref, model: "gpt-5-codex" } });
    expect(settings.codex).toEqual({ auth: "chatgpt", credentialRef: ref, model: "gpt-5-codex" });
    const vault = memoryVault({ "ops/codex-chatgpt": { authJson: OLD } });
    const a = await resolveHarnessAuth({ harness: "codex" }, settings, vault);
    expect(a.auth).toEqual({});
    expect(a.env).toEqual({});
    expect(a.route).toBeUndefined();
    expect(a.model).toBe("gpt-5-codex");
    expect(a.chatgpt).toEqual({ ref, authJson: OLD });
    expect(a.secrets).toEqual(expect.arrayContaining(["at-OLD-1234567", "rt-at-OLD-1234567", "id-at-OLD-1234567"]));
    // never brokered: nothing goes in the environment (Codex reads $CODEX_HOME/auth.json)
    expect(brokeredHarnessAuth(a, "none").auth).toEqual({});
    // an agent's own entry replaces the setting's; an entry without a login (before the first sign-in)
    const own = await resolveHarnessAuth({ harness: "codex", credentialRef: { owner: "cody", service: "chatgpt" } }, settings, vault);
    expect(own.chatgpt).toEqual({ ref: { owner: "cody", service: "chatgpt" } });
    expect(own.secrets).toEqual([]);
  });

  it("the connection test says signed in or not, without a request from this server", async () => {
    const settings = parseHarnessesSettings({ enabled: ["codex"], codex: { auth: "chatgpt", credentialRef: ref } });
    const fetch = (() => { throw new Error("no request"); }) as any;
    expect(await testHarnessConnection({ harness: "codex", settings, vault: memoryVault({ "ops/codex-chatgpt": { authJson: OLD } }), fetch })).toMatchObject({ ok: true, auth: "chatgpt" });
    expect(await testHarnessConnection({ harness: "codex", settings, vault: memoryVault(), fetch })).toMatchObject({ ok: false, errorKind: "auth", error: expect.stringMatching(/nobody has signed in/) });
  });

  it("the overview says signed in or not, never the login", async () => {
    const vault = memoryVault({ "ops/codex-chatgpt": { authJson: OLD } });
    const o = await harnessesOverview({ harnesses: { enabled: ["codex"], codex: { auth: "chatgpt", credentialRef: ref } } } as any, vault, []);
    const cx = o.harnesses.find((h) => h.id === "codex") as any;
    expect(cx.chatgpt).toEqual({ signedIn: true, lastRefresh: "2026-11-01T10:00:00.000Z" });
    expect(cx.brokering).toBeUndefined();
    expect(JSON.stringify(o)).not.toContain("at-OLD");
  });
});

describe("login cache: seed and write-back", () => {
  const home = codexChatgptHome("/home/daytona", "Cody Bot");
  it("CODEX_HOME is per agent, under the computer's HOME; the sign-in command uses it", () => {
    expect(home).toBe("/home/daytona/.polpo-harness/codex/cody-bot");
    const cmd = codexChatgptLoginCommand("Cody Bot");
    expect(cmd).toContain('export CODEX_HOME="$HOME/.polpo-harness/codex/cody-bot"');
    expect(cmd).toContain("login --device-auth");
  });

  it("parses a login and lists its secrets", () => {
    expect(parseCodexAuthJson("{}")).toBeUndefined();
    expect(parseCodexAuthJson("not json")).toBeUndefined();
    expect(parseCodexAuthJson(OLD)?.freshness).toBe(Date.parse("2026-11-01T10:00:00.000Z"));
    expect(codexAuthSecrets(JSON.stringify({ OPENAI_API_KEY: "sk-proj-abcdef" }))).toEqual(["sk-proj-abcdef"]);
  });

  it("seeds the vault's copy when the machine has none or an older one, keeps a fresher one", async () => {
    const m = memoryMachine("/w");
    expect(await seedCodexAuth(m, home, undefined)).toEqual({ action: "none" });
    expect(m.execs[0]).toContain("cli_auth_credentials_store");
    expect(await seedCodexAuth(m, home, OLD)).toMatchObject({ action: "written" });
    expect(JSON.parse(m.files.get(`${home}/auth.json`)!)).toEqual(JSON.parse(OLD));
    expect(m.execs.some((c) => c.includes("chmod 600"))).toBe(true);
    m.files.set(`${home}/auth.json`, NEW);
    expect(await seedCodexAuth(m, home, OLD)).toMatchObject({ action: "kept", machineRaw: NEW });
    expect(m.files.get(`${home}/auth.json`)).toBe(NEW);
    m.files.set(`${home}/auth.json`, OLD);
    expect(await seedCodexAuth(m, home, NEW)).toMatchObject({ action: "written" });
  });

  it("writes back a changed login, leaves an unchanged or older one, creates a missing entry", async () => {
    const vault = memoryVault({ "ops/codex-chatgpt": { authJson: OLD } });
    expect(await captureCodexAuth({ read: async () => `${OLD}\n`, vault, ref })).toMatchObject({ status: "unchanged" });
    expect(vault.patches).toEqual([]);
    const up = await captureCodexAuth({ read: async () => NEW, vault, ref });
    expect(up.status).toBe("updated");
    expect(up.secrets).toContain("at-NEW-7654321");
    expect(vault.m.get("ops/codex-chatgpt").credentials.authJson).toBe(NEW);
    expect(await captureCodexAuth({ read: async () => OLD, vault, ref })).toMatchObject({ status: "older" });
    expect(vault.m.get("ops/codex-chatgpt").credentials.authJson).toBe(NEW);
    expect(await captureCodexAuth({ read: async () => undefined, vault, ref })).toMatchObject({ status: "missing" });
    expect(await captureCodexAuth({ read: async () => "{}", vault, ref })).toMatchObject({ status: "invalid" });
    const empty = memoryVault();
    expect(await captureCodexAuth({ read: async () => NEW, vault: empty, ref })).toMatchObject({ status: "updated" });
    expect(empty.m.get("ops/codex-chatgpt")).toMatchObject({ type: "custom", credentials: { authJson: NEW } });
  });
});

describe("harness engine with a ChatGPT login", () => {
  const task = { id: "t1", title: "Fix", description: "Fix it", expectations: [], status: "in_progress" } as any;
  const agent = { name: "Cody", role: "dev", engine: { harness: "codex" } } as any;
  const settings = { harnesses: { enabled: ["codex"], allowHost: true, codex: { auth: "chatgpt", credentialRef: ref } } } as any;

  function run(vault: any, turn: (m: ReturnType<typeof memoryMachine>, n: number) => Promise<void>, followUps: string[] = []) {
    const root = tmp("polpo-cxg-");
    const polpoDir = join(root, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    const machine = memoryMachine(root);
    let spec: any;
    const transcript: any[] = [];
    const usage: any[] = [];
    let turns = 0;
    const runtime = {
      harness: "codex",
      createSession: async (o: any) => {
        // the runtime starts its bridge: what environment does it get?
        await o.sandbox.spawn({ command: "node bridge.mjs", env: { BRIDGE_WS_PORT: "4007" } });
        return {
          sessionId: "hs-1", workDir: root, isResume: false,
          turn: async (_p: string, x: any) => {
            await turn(machine, turns);
            // the tokens Polpo knows at this point (the seeded login; a refreshed one after the turn that refreshed it)
            x.onEvent({ type: "text", text: turns++ === 0 ? "done with at-OLD-1234567" : "again with at-NEW-7654321 and at-OLD-1234567" });
            return { text: "done", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 } };
          },
          steer: async () => {}, detach: async () => ({}), stop: async () => ({}), destroy: async () => {},
        };
      },
    };
    const handle = spawnHarnessEngine(agent, task, root, { polpoDir, outputDir: join(polpoDir, "output", "t1"), vaultStore: vault } as any, {
      settings: () => settings,
      openMachine: async () => ({ machine: machine as any, computerId: "nina", hold: () => () => {} }),
      runtimeFactory: (s) => { spec = s; return runtime as any; },
      recordUsage: async (r) => { usage.push(r); },
    });
    handle.onTranscript = (e) => transcript.push(e);
    for (const f of followUps) handle.followUp(f);
    return { handle, machine, transcript, usage, getSpec: () => spec };
  }

  it("seeds CODEX_HOME, gives it to the runtime, masks the tokens, writes the refreshed login back", async () => {
    const vault = memoryVault({ "ops/codex-chatgpt": { authJson: OLD } });
    const home = "/home/daytona/.polpo-harness/codex/cody";
    const env = run(vault, async (m, n) => {
      if (n > 0) return;
      // the seed happened before the session; Codex refreshes its tokens during the turn
      expect(JSON.parse(m.files.get(`${home}/auth.json`)!)).toEqual(JSON.parse(OLD));
      m.files.set(`${home}/auth.json`, NEW);
    }, ["go on"]);
    const r = await env.handle.done;
    expect(r).toMatchObject({ exitCode: 0 });
    expect(env.getSpec().auth.auth).toEqual({});
    expect(env.machine.spawns[0]!.env).toMatchObject({ CODEX_HOME: home, BRIDGE_WS_PORT: "4007" });
    expect(env.machine.spawns[0]!.env).not.toHaveProperty("CODEX_API_KEY");
    expect(vault.m.get("ops/codex-chatgpt").credentials.authJson).toBe(NEW);
    const text = JSON.stringify(env.transcript);
    expect(text).not.toContain("at-OLD-1234567");
    expect(text).not.toContain("at-NEW-7654321");
    expect(text).toContain("saved to the vault");
    expect(env.transcript.find((e) => e.type === "usage")).toMatchObject({ costSource: "subscription" });
  });

  it("an unchanged login is not written back; before the VM goes the login is saved", async () => {
    const vault = memoryVault({ "ops/codex-chatgpt": { authJson: OLD } });
    const home = "/home/daytona/.polpo-harness/codex/cody";
    const unchanged = run(vault, async () => {});
    await unchanged.handle.done;
    expect(vault.patches).toEqual([]);

    const v2 = memoryVault({ "ops/codex-chatgpt": { authJson: OLD } });
    const hib = run(v2, async (m) => {
      m.files.set(`${home}/auth.json`, NEW);
      await liveHarnessSessions.beforeVmGoes("nina", "memory", "hibernate");
      expect(v2.m.get("ops/codex-chatgpt").credentials.authJson).toBe(NEW);
    });
    await hib.handle.done;
    expect(v2.patches).toEqual(["ops/codex-chatgpt"]);
  });

  it("nobody signed in: the run fails with how to sign in; a write-back failure is only a warning", async () => {
    const none = run(memoryVault(), async () => {});
    const r = await none.handle.done;
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/nobody has signed in for agent "Cody"/);

    const vault = memoryVault({ "ops/codex-chatgpt": { authJson: OLD } });
    vault.patch = async () => { throw new Error("vault is read-only"); };
    const home = "/home/daytona/.polpo-harness/codex/cody";
    const warn = run(vault, async (m) => { m.files.set(`${home}/auth.json`, NEW); });
    const w = await warn.handle.done;
    expect(w.exitCode).toBe(0);
    expect(JSON.stringify(warn.transcript)).toMatch(/could not be saved back to the vault/);
  });
});

describe("sign-in: REST routes and terminal", () => {
  const settings = {
    harnesses: { enabled: ["codex"], codex: { auth: "chatgpt", credentialRef: ref } },
    computers: [{ id: "nina", name: "Nina", kind: "daytona" }],
  } as any;
  const agents = [{ name: "Cody", role: "dev", engine: { harness: "codex" }, defaultComputer: "nina" } as any, { name: "Pat", role: "dev" } as any];

  function app(vault: any, files: Record<string, string | null | undefined>, s = settings) {
    const reads: string[] = [];
    const routes = harnessRoutes({
      polpoDir: () => "/nowhere", settings: () => s, vault: () => vault, manager: () => ({}) as any, agents: async () => agents,
      readComputerFile: async (computer, path) => { reads.push(`${computer}:${path}`); return files[path]; },
    });
    const post = (path: string, body: unknown) => routes.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { routes, post, reads };
  }

  it("POST …/chatgpt-login gives the terminal on the agent's computer; capture saves the login; GET says signed in", async () => {
    const vault = memoryVault();
    const path = "$HOME/.polpo-harness/codex/cody/auth.json";
    const a = app(vault, { [path]: NEW });
    const login = await (await a.post("/codex/chatgpt-login", { agent: "Cody" })).json();
    expect(login).toMatchObject({ ok: true, data: { mode: "terminal", computer: "nina", terminal: { agent: "codex-chatgpt-login", harness_agent: "Cody" }, signedIn: false, credentialRef: ref } });
    expect(login.data.command).toContain("login --device-auth");
    const cap = await (await a.post("/codex/chatgpt-login/capture", { agent: "Cody" })).json();
    expect(cap).toMatchObject({ ok: true, data: { result: "updated", signedIn: true } });
    expect(a.reads).toEqual([`nina:${path}`]);
    expect(JSON.stringify(cap)).not.toContain("at-NEW");
    expect(vault.m.get("ops/codex-chatgpt").credentials.authJson).toBe(NEW);
    const status = await (await a.routes.request("/codex/chatgpt-login?agent=Cody")).json();
    expect(status).toMatchObject({ ok: true, data: { signedIn: true, lastRefresh: "2026-11-20T10:00:00.000Z" } });
    expect(JSON.stringify(status)).not.toContain("at-NEW");
  });

  it("refuses without auth chatgpt, an unknown agent, a stopped computer, nothing to capture", async () => {
    const vault = memoryVault();
    const off = app(vault, {}, { ...settings, harnesses: { enabled: ["codex"], codex: { auth: "api-key", credentialRef: ref } } });
    expect((await off.post("/codex/chatgpt-login", { agent: "Cody" })).status).toBe(409);
    const a = app(vault, {});
    expect((await a.post("/codex/chatgpt-login", { agent: "Nobody" })).status).toBe(404);
    // Pat works on this server and harnesses are not allowed there
    expect((await a.post("/codex/chatgpt-login", { agent: "Pat" })).status).toBe(409);
    expect((await a.post("/codex/chatgpt-login/capture", { agent: "Cody" })).status).toBe(409);
    const nothing = app(vault, { "$HOME/.polpo-harness/codex/cody/auth.json": null });
    expect(await (await nothing.post("/codex/chatgpt-login/capture", { agent: "Cody" })).json()).toMatchObject({ ok: true, data: { result: "missing", signedIn: false } });
  });

  it("the sign-in terminal: a PTY on the agent's computer, or this server's isolated harness HOME", async () => {
    const orchestrator = (s: any) => ({ getConfig: () => ({ settings: s }) as any, getAgents: async () => agents, getPolpoDir: () => polpoDir });
    const polpoDir = tmp("polpo-cxg-term-");
    const remote = await codexChatgptLoginInvocation(orchestrator(settings), "Cody");
    expect(remote).toMatchObject({ sessionId: "codex-chatgpt-login-cody", remote: { computer: "nina" } });
    expect(remote.remote!.command).toContain('CODEX_HOME="$HOME/.polpo-harness/codex/cody"');
    const host = await codexChatgptLoginInvocation(orchestrator({ ...settings, harnesses: { ...settings.harnesses, allowHost: true } }), "Pat", { PATH: "/usr/bin", HOME: "/root", OPENAI_API_KEY: "sk-server" });
    expect(host.remote).toBeUndefined();
    expect(host.cwd).toBe(join(polpoDir, "harness", "pat", "home"));
    expect(host.env.HOME).toBe(host.cwd);
    expect(host.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(host.command).toContain(`CODEX_HOME="${join(polpoDir, "harness", "pat", "home")}/.polpo-harness/codex/pat"`);
    await expect(codexChatgptLoginInvocation(orchestrator(settings), "Pat")).rejects.toThrow(/allowHost/);
    expect(codexChatgptTarget({ settings, agents, agent: undefined, polpoDir })).toMatchObject({ ok: false, status: 409 });
  });
});
