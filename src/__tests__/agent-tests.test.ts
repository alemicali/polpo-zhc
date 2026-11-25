/**
 * Agent tests (src/server/agent-tests.ts): every check's pass / warn / fail with mocked engines,
 * connectors, vault, skills, computers and channels — no model, connector or machine is called.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AgentVersioning, InMemoryAgentTestStore, InMemoryAgentVersionStore,
  type AgentConfig, type AgentUpdate, type ConnectorConfig, type PolpoSettings, type VaultStore,
} from "@polpo-ai/core";
import { AgentTester, connectorIdsInPattern, envFromVaultMappings, type AgentTestDeps } from "../server/agent-tests.js";

const connector = (id: string, agents: string[] | "*", extra: Partial<ConnectorConfig> = {}): ConnectorConfig => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), kind: "mcp", transport: { type: "http", url: `https://${id}.example.com/mcp` } as ConnectorConfig["transport"],
  auth: { type: "none" } as ConnectorConfig["auth"], access: { agents, polpo: false }, enabled: true, createdAt: "2026-11-01T00:00:00.000Z", ...extra,
});

function vaultOf(entries: Record<string, Array<{ service: string; keys: string[]; sharedFrom?: string }>>): VaultStore {
  return { list: async (owner: string) => (entries[owner] ?? []).map((e) => ({ type: "custom", ...e })) } as unknown as VaultStore;
}

function setup(opts: {
  agents?: AgentConfig[]; settings?: PolpoSettings; connectors?: ConnectorConfig[]; deps?: Partial<AgentTestDeps>;
} = {}) {
  const agents = new Map<string, AgentConfig>((opts.agents ?? [{ name: "writer", allowedTools: ["read", "bash"] }]).map((a) => [a.name, a]));
  const writeLive = async (name: string, updates: AgentUpdate) => {
    const merged = { ...agents.get(name)!, ...updates } as AgentConfig;
    agents.set(name, merged);
    return merged;
  };
  const versioning = new AgentVersioning(new InMemoryAgentVersionStore(), {
    getAgent: async (n) => agents.get(n), getAgents: async () => [...agents.values()], writeLive,
  });
  let connectors = opts.connectors ?? [];
  const store = new InMemoryAgentTestStore();
  const deps: AgentTestDeps = {
    agents: async () => [...agents.values()],
    settings: () => opts.settings,
    store,
    versioning: () => versioning,
    nativeModelTest: vi.fn(async (model?: string) => ({ model: model ?? "anthropic:claude-haiku-4-5", latencyMs: 120 })),
    harnessTest: vi.fn(async () => ({ ok: true, model: "claude-haiku-4-5", auth: "api-key", latencyMs: 300 })),
    cliAccountReport: vi.fn(async () => ({ installed: true, version: "2.1.0", status: { signedIn: true, who: "ada@example.com" } })),
    instanceAuth: () => true,
    knownTools: async () => ["read", "write", "edit", "bash", "glob", "grep", "ls", "register_outcome", "browser_navigate", "browser_click", "email_send"],
    connectors: () => connectors,
    testConnector: vi.fn(async () => ({ ok: true, status: "connected", tools: [{ name: "list_products" }, { name: "create_order" }] })),
    grantConnector: vi.fn(async (id: string, agent: string) => {
      connectors = connectors.map((c) => c.id === id ? { ...c, access: { ...c.access, agents: [...(c.access.agents as string[]), agent] } } : c);
    }),
    vault: () => vaultOf({}),
    loadSkills: () => [],
    skillVersionExists: () => true,
    computers: () => [],
    computerLive: vi.fn(async () => ({ status: "running" })),
    startComputer: vi.fn(async () => undefined),
    sandboxProviderStatus: async () => ({ configured: true, keyFound: true }),
    sandboxProviderTest: vi.fn(async () => ({ ok: true, durationMs: 1500 })),
    computerEgress: async () => undefined,
    proxyReachable: async () => true,
    channelLive: () => true,
    smoke: vi.fn(async () => ({ text: "TEST OK", toolCalls: [{ name: "register_outcome", state: "completed" }], latencyMs: 900 })),
    ...opts.deps,
  };
  return { tester: new AgentTester(deps), deps, store, agents, versioning, connectorsNow: () => connectors };
}

const check = async (t: AgentTester, name: string, id: string, extra: Record<string, unknown> = {}) => {
  const run = await t.run(name, { checks: [id as never], ...extra });
  return run.checks[0]!;
};

describe("engine & model", () => {
  it("Polpo's engine: one tiny request, model and latency", async () => {
    const { tester, deps } = setup({ agents: [{ name: "writer", model: "openai:gpt-5-mini" }] });
    const r = await check(tester, "writer", "engine");
    expect(r.status).toBe("pass");
    expect(r.data).toMatchObject({ engine: "polpo", model: "openai:gpt-5-mini", latencyMs: 120 });
    expect(deps.nativeModelTest).toHaveBeenCalledWith("openai:gpt-5-mini");
  });

  it("Polpo's engine: a failing provider fails with a link to the providers", async () => {
    const { tester } = setup({ deps: { nativeModelTest: async () => { throw new Error("401 invalid x-api-key"); } } });
    const r = await check(tester, "writer", "engine");
    expect(r.status).toBe("fail");
    expect(r.items[0]).toMatchObject({ status: "fail", detail: expect.stringContaining("invalid x-api-key"), fix: { href: "/config?section=providers" } });
  });

  it("a harness: reuses the harness connection test with the agent's engine", async () => {
    const settings = { harnesses: { enabled: ["claude-code"], allowHost: true, "claude-code": { auth: "api-key", credentialRef: { owner: "writer", service: "anthropic" } } } } as unknown as PolpoSettings;
    const { tester, deps } = setup({ settings, agents: [{ name: "writer", engine: { harness: "claude-code", model: "claude-sonnet-4-5" } } as AgentConfig] });
    const r = await check(tester, "writer", "engine");
    expect(r.status).toBe("pass");
    expect(deps.harnessTest).toHaveBeenCalledWith(expect.objectContaining({ harness: "claude-code", agentEngine: expect.objectContaining({ model: "claude-sonnet-4-5" }) }));
    expect(r.data).toMatchObject({ engine: "claude-code", latencyMs: 300 });
  });

  it("a harness that is not enabled fails before any request", async () => {
    const { tester, deps } = setup({ settings: {} as PolpoSettings, agents: [{ name: "writer", engine: { harness: "codex" } } as AgentConfig] });
    const r = await check(tester, "writer", "engine");
    expect(r.status).toBe("fail");
    expect(r.items[0]!.detail).toMatch(/not enabled/);
    expect(deps.harnessTest).not.toHaveBeenCalled();
  });

  const cliSettings = (owner: string) => ({ harnesses: { enabled: [], cli: { accounts: [{ id: "ada-claude", cli: "claude", computer: "host", configDir: "~/.polpo-cli/claude/ada-claude", owner }] } } }) as unknown as PolpoSettings;
  const cliAgent = { name: "writer", engine: { type: "cli", cli: "claude", account: "ada-claude" } } as unknown as AgentConfig;

  it("CLI engine: signed in and the owner policy allows the person testing", async () => {
    const { tester } = setup({ settings: cliSettings("ada@example.com"), agents: [cliAgent] });
    const run = await tester.run("writer", { checks: ["engine"] }, { member: "ada@example.com" });
    expect(run.checks[0]!.status).toBe("pass");
    expect(run.checks[0]!.items.map((i) => i.label)).toEqual(["Account ada-claude", "Policy for ada@example.com"]);
  });

  it("CLI engine: not signed in fails with a sign-in link", async () => {
    const { tester } = setup({
      settings: cliSettings("ada@example.com"), agents: [cliAgent],
      deps: { cliAccountReport: async () => ({ installed: true, version: "2.1.0", status: { signedIn: false, detail: "Not logged in" } }) },
    });
    const r = (await tester.run("writer", { checks: ["engine"] }, { member: "ada@example.com" })).checks[0]!;
    expect(r.status).toBe("fail");
    expect(r.items[0]).toMatchObject({ label: "Account ada-claude", status: "fail", detail: expect.stringMatching(/Not signed in/), fix: { label: "Sign in", href: "/config?section=harnesses" } });
  });

  it("CLI engine: the policy guard warns another member", async () => {
    const { tester } = setup({ settings: cliSettings("ada@example.com"), agents: [cliAgent] });
    const r = (await tester.run("writer", { checks: ["engine"] }, { member: "bob@example.com" })).checks[0]!;
    expect(r.status).toBe("warn");
    expect(r.items[1]).toMatchObject({ label: "Policy for bob@example.com", status: "warn", detail: expect.stringContaining("belongs to ada@example.com") });
  });
});

describe("tools", () => {
  it("resolves names and globs, flags unknown names and empty globs, counts the blocked ones", async () => {
    const { tester } = setup({ agents: [{ name: "writer", allowedTools: ["read", "browser_*", "reed", "video_*", "mcp__printful__*"] }] });
    const r = await check(tester, "writer", "tools");
    expect(r.status).toBe("warn");
    const by = Object.fromEntries(r.items.map((i) => [i.label, i]));
    expect(by.read!.status).toBe("pass");
    expect(by["browser_*"]).toMatchObject({ status: "pass", detail: expect.stringContaining("2 tools") });
    expect(by.reed).toMatchObject({ status: "warn", detail: expect.stringMatching(/Unknown tool name/) });
    expect(by["video_*"]).toMatchObject({ status: "warn", detail: expect.stringMatching(/Matches no tool/) });
    expect(by["mcp__printful__*"]).toMatchObject({ status: "pass", detail: expect.stringMatching(/Connectors/) });
    expect(by["Not allowed"]!.detail).toMatch(/8 other built-in tools stay blocked/);
    expect(r.data).toMatchObject({ allowed: 3, blocked: 8 });
  });

  it("no allowedTools: the core tools", async () => {
    const { tester } = setup({ agents: [{ name: "writer" }] });
    const r = await check(tester, "writer", "tools");
    expect(r.status).toBe("pass");
    expect(r.summary).toMatch(/Core tools/);
  });
});

describe("connectors", () => {
  it("flags a connector named in allowedTools whose access leaves the agent out, and the one-click fix grants it", async () => {
    const { tester, deps, connectorsNow } = setup({
      agents: [{ name: "shop", allowedTools: ["read", "mcp__printful__*"] }],
      connectors: [connector("printful", [])],
    });
    const r = await check(tester, "shop", "connectors");
    expect(r.status).toBe("fail");
    expect(r.items).toEqual([expect.objectContaining({
      status: "fail", detail: expect.stringContaining("access does not include shop: the agent sees none of its tools"),
      fix: { label: "Grant shop access", action: { type: "grant-connector-access", connector: "printful" } },
    })]);
    expect(deps.testConnector).not.toHaveBeenCalled();

    expect(await tester.fix("shop", { type: "grant-connector-access", connector: "printful" })).toEqual({ message: expect.stringContaining("now grants shop") });
    expect(connectorsNow()[0]!.access.agents).toEqual(["shop"]);
    const again = await check(tester, "shop", "connectors");
    expect(again.status).toBe("pass");
    expect(again.items[0]).toMatchObject({ label: "Printful", detail: "Connected · 2 of 2 tools for shop" });
    expect(await tester.fix("shop", { type: "grant-connector-access", connector: "printful" })).toEqual({ message: "Printful already grants shop" });
  });

  it("tests each granted connector: auth failures, policy-blocked tools, tools that do not reach the agent, unknown selections", async () => {
    const { tester } = setup({
      agents: [{ name: "shop", allowedTools: ["read", "mcp__linear__*"], connectorTools: { linear: ["create_order", "nope"] } }],
      connectors: [
        connector("linear", ["shop"], { toolPolicy: { list_products: "off" } }),
        connector("notion", "*"),
        connector("gmail", ["shop"]),
      ],
      deps: {
        testConnector: async (id: string) => id === "gmail"
          ? { ok: false, status: "needs_reauth", error: "token expired" }
          : { ok: true, status: "connected", tools: [{ name: "list_products" }, { name: "create_order" }] },
      },
    });
    const r = await check(tester, "shop", "connectors");
    expect(r.status).toBe("fail");
    const by = Object.fromEntries(r.items.map((i) => [i.label, i]));
    expect(by.Linear).toMatchObject({ status: "pass", detail: "Connected · 1 of 2 tools for shop · 1 turned off by the connector's policy (blocked)" });
    expect(by["Linear: selected tools"]).toMatchObject({ status: "warn", detail: "Not on the server: nope" });
    expect(by.Notion).toMatchObject({ status: "warn", detail: expect.stringContaining("none reaches shop (allowedTools has no mcp__notion__* entry)") });
    expect(by.Gmail).toMatchObject({ status: "fail", detail: "Sign-in needed: token expired", fix: { label: "Sign in again" } });
  });

  it("unknown and disabled connectors are warnings; no connectors is a skip", async () => {
    const { tester } = setup({ agents: [{ name: "shop", allowedTools: ["mcp__ghost__*", "mcp__off__x"] }], connectors: [connector("off", ["shop"], { enabled: false })] });
    const r = await check(tester, "shop", "connectors");
    expect(r.items.map((i) => i.status)).toEqual(["warn", "warn"]);
    const none = setup({ agents: [{ name: "shop" }] });
    expect((await check(none.tester, "shop", "connectors")).status).toBe("skip");
  });

  it("reads connector ids from patterns", () => {
    expect(connectorIdsInPattern("mcp__printful__*", [])).toEqual(["printful"]);
    expect(connectorIdsInPattern("mcp__printful__get_order", [])).toEqual(["printful"]);
    expect(connectorIdsInPattern("mcp__gmail*", ["gmail", "gmail-2", "notion"])).toEqual(["gmail", "gmail-2"]);
    expect(connectorIdsInPattern("mcp__*", ["x"])).toEqual(["*"]);
    expect(connectorIdsInPattern("read", ["x"])).toEqual([]);
  });
});

describe("vault", () => {
  it("lists entry names, checks the engine's references and env_from_vault mappings (never values)", async () => {
    const settings = { harnesses: { enabled: ["claude-code"], allowHost: true, "claude-code": { auth: "api-key", credentialRef: { owner: "ops", service: "anthropic" } } } } as unknown as PolpoSettings;
    const { tester } = setup({
      settings,
      agents: [{
        name: "writer", engine: { harness: "claude-code", credentialRef: { owner: "writer", service: "own-key" } },
        systemPrompt: 'Deploy with bash and env_from_vault: { "GH_TOKEN": "github.token", "NPM": "npm.token" }', skills: ["release"],
      } as AgentConfig],
      deps: {
        vault: () => vaultOf({ writer: [{ service: "github", keys: ["token"] }, { service: "slack", keys: ["bot"], sharedFrom: "ops" }], ops: [] }),
        loadSkills: () => [{ name: "release", content: 'Use env_from_vault {"SLACK": "slack.webhook"}' }],
      },
    });
    const r = await check(tester, "writer", "vault");
    expect(r.status).toBe("fail");
    const by = Object.fromEntries(r.items.map((i) => [i.label, i]));
    expect(by.Entries!.detail).toBe("github, slack (shared by ops)");
    expect(by["engine.credentialRef → writer / own-key"]).toMatchObject({ status: "fail", detail: "The entry does not exist", fix: { href: "/agents/writer?tab=credentials" } });
    expect(by["harness claude-code: credentialRef → ops / anthropic"]!.status).toBe("fail");
    expect(by["env_from_vault GH_TOKEN → github.token (instructions)"]!.status).toBe("pass");
    expect(by["env_from_vault NPM → npm.token (instructions)"]).toMatchObject({ status: "fail", detail: 'writer has no vault entry "npm" (own or shared)' });
    expect(by["env_from_vault SLACK → slack.webhook (skill release)"]).toMatchObject({ status: "fail", detail: expect.stringContaining('no field "webhook"') });
    expect(JSON.stringify(r)).not.toMatch(/secret|value/i);
  });

  it("parses env_from_vault mappings", () => {
    expect(envFromVaultMappings('{ "command": "gh", "env_from_vault": { "GH_TOKEN": "github.token" } }')).toEqual([{ variable: "GH_TOKEN", ref: "github.token" }]);
    expect(envFromVaultMappings("nothing here")).toEqual([]);
  });
});

describe("skills", () => {
  it("each skill loads with its files; a missing skill and a missing pinned version fail", async () => {
    const { tester, versioning, agents } = setup({
      agents: [{ name: "writer", skills: ["style", "ghost"] }],
      deps: {
        loadSkills: () => [{ name: "style", content: "Be clear", files: 3 }],
        skillVersionExists: (_name: string, v: number) => v !== 4,
      },
    });
    let r = await check(tester, "writer", "skills");
    expect(r.items).toEqual([
      expect.objectContaining({ label: "style", status: "pass", detail: "Loads · 3 bundled files" }),
      expect.objectContaining({ label: "ghost", status: "fail", fix: { label: "Open skills", href: "/skills" } }),
    ]);
    // a published version pinned style at v4, which was pruned
    const v = await versioning.getVersion("writer", "1.0.0");
    v!.skillVersions = { style: 4 };
    agents.set("writer", { ...agents.get("writer")!, skills: ["style"] });
    r = await check(tester, "writer", "skills", { target: v!.version });
    expect(r.items[0]).toMatchObject({ status: "fail", detail: "Pinned at v4, which no longer exists" });
  });
});

describe("computer & sandbox", () => {
  const vm = { id: "box", name: "Box", kind: "daytona", egress: "home" } as never;

  it("a stopped computer is not started unless asked; then it is", async () => {
    let status = "stopped";
    const { tester, deps } = setup({
      agents: [{ name: "writer", defaultComputer: "box" }],
      deps: {
        computers: () => [vm], computerLive: vi.fn(async () => ({ status })), startComputer: vi.fn(async () => { status = "running"; }),
        computerEgress: async () => ({ tailnet: "off", proxyReachable: false, effective: "checked again when it next starts" }),
      },
    });
    let r = await check(tester, "writer", "computer");
    expect(deps.startComputer).not.toHaveBeenCalled();
    expect(r.data).toMatchObject({ computer: "box", status: "stopped", canStart: true });
    expect(r.items.map((i) => [i.label, i.status])).toEqual([
      ["Computer box (daytona)", "warn"], ["Sandbox provider daytona", "pass"], ["Egress home (tailnet)", "warn"],
    ]);
    expect(deps.sandboxProviderTest).toHaveBeenCalledWith("daytona");

    r = await check(tester, "writer", "computer", { startComputer: true });
    expect(deps.startComputer).toHaveBeenCalledOnce();
    expect(r.items[0]).toMatchObject({ status: "pass", detail: "Running" });
  });

  it("a provider without its key, an unreachable egress proxy and an unknown computer fail", async () => {
    const { tester } = setup({
      agents: [{ name: "writer", defaultComputer: "box" }, { name: "host-agent", browserEgress: "home" }, { name: "lost", defaultComputer: "gone" }],
      settings: { egressProxies: { home: "socks5://100.64.0.2:1080" } } as unknown as PolpoSettings,
      deps: {
        computers: () => [vm], sandboxProviderStatus: async () => ({ configured: true, keyFound: false }), proxyReachable: async () => false,
        computerEgress: async () => ({ tailnet: "up", proxyReachable: true, effective: "via home" }),
      },
    });
    const box = await check(tester, "writer", "computer");
    expect(box.items.find((i) => i.label === "Sandbox provider daytona")).toMatchObject({ status: "fail", detail: "Its API key's vault entry is missing" });
    expect(box.items.find((i) => i.label === "Egress home (tailnet)")).toMatchObject({ status: "pass", detail: "via home" });
    const host = await check(tester, "host-agent", "computer");
    expect(host.items).toEqual([
      expect.objectContaining({ label: "Computer", status: "pass" }),
      expect.objectContaining({ label: "Egress home", status: "fail", detail: "Not reachable from this server" }),
    ]);
    expect((await check(tester, "lost", "computer")).items[0]).toMatchObject({ status: "fail", detail: "There is no such computer" });
  });
});

describe("channels", () => {
  it("routes to the agent: running, inbound off, not running", async () => {
    const settings = { notifications: { channels: {
      tg: { type: "telegram", gateway: { agent: "writer", enableInbound: true } },
      slack: { type: "slack", gateway: { agent: "writer", enableInbound: false } },
      wa: { type: "whatsapp", gateway: { agent: "writer", enableInbound: true } },
      other: { type: "telegram", gateway: { agent: "someone", enableInbound: true } },
    } } } as unknown as PolpoSettings;
    const { tester } = setup({ settings, deps: { channelLive: (n: string) => n !== "wa" } });
    const r = await check(tester, "writer", "channels");
    expect(r.items.map((i) => [i.label, i.status])).toEqual([["tg (telegram)", "pass"], ["slack (slack)", "warn"], ["wa (whatsapp)", "fail"]]);
    expect(r.items[2]!.fix).toEqual({ label: "Open the channel", href: "/config?section=channels&channel=wa" });
    expect((await check(setup().tester, "writer", "channels")).status).toBe("skip");
  });
});

describe("versioning", () => {
  it("production version; a stale draft warns", async () => {
    const { tester, versioning } = setup();
    let r = await check(tester, "writer", "versioning");
    expect(r.status).toBe("pass");
    expect(r.items[0]).toMatchObject({ label: "Production", detail: "1.0.0" });
    // publish and deploy 1.1.0, draft a change on it, roll back to 1.0.0: the draft is stale
    await versioning.update("writer", { systemPrompt: "v2" }, { actor: "t", mode: "deploy" });
    await versioning.updateDraft("writer", { role: "Writes" }, "t");
    await versioning.rollback("writer", { actor: "t" });
    r = await check(tester, "writer", "versioning");
    expect(r.status).toBe("warn");
    expect(r.items[1]).toMatchObject({ label: "Draft", status: "warn", detail: expect.stringContaining("production is now 1.0.0"), fix: { href: "/agents/writer?tab=versions" } });
    expect(r.data).toMatchObject({ production: "1.0.0", draftStale: true });
  });
});

describe("smoke run", () => {
  it("is not part of Run all, and runs one harmless tool end to end when asked", async () => {
    const { tester, deps } = setup();
    const all = await tester.run("writer");
    expect(all.checks.map((c) => c.id)).toEqual(["engine", "tools", "connectors", "vault", "skills", "computer", "channels", "versioning"]);
    expect(deps.smoke).not.toHaveBeenCalled();
    const r = await check(tester, "writer", "smoke");
    expect(deps.smoke).toHaveBeenCalledWith("writer", expect.stringContaining("register_outcome"));
    expect(r.status).toBe("pass");
    expect(r.items).toEqual([
      expect.objectContaining({ label: "Reply", status: "pass", detail: "TEST OK" }),
      expect.objectContaining({ label: "Tool register_outcome", status: "pass" }),
    ]);
  });

  it("targets the draft or a version; a tool not called warns, a failed call fails", async () => {
    const { tester, deps } = setup({ deps: { smoke: vi.fn(async () => ({ text: "OK", toolCalls: [], latencyMs: 10 })) } });
    const draft = await tester.run("writer", { checks: ["smoke"], target: "draft" });
    expect(deps.smoke).toHaveBeenLastCalledWith("writer@draft", expect.any(String));
    expect(draft).toMatchObject({ target: "draft", status: "warn" });
    expect(draft.version).toBeUndefined();
    const v = await tester.run("writer", { checks: ["smoke"], target: "1.0.0" });
    expect(deps.smoke).toHaveBeenLastCalledWith("writer@1.0.0", expect.any(String));
    expect(v).toMatchObject({ target: "1.0.0", version: "1.0.0" });

    const failing = setup({ deps: { smoke: async () => ({ text: "Sorry", toolCalls: [{ name: "register_outcome", state: "error", result: "disk full" }], latencyMs: 5 }) } });
    const f = await check(failing.tester, "writer", "smoke");
    expect(f.items[1]).toMatchObject({ status: "fail", detail: "Called, and it failed: disk full" });
    const broken = setup({ deps: { smoke: async () => { throw new Error("Agent \"writer\" not found"); } } });
    expect((await check(broken.tester, "writer", "smoke")).status).toBe("fail");
  });

  it("an unknown version or target is refused", async () => {
    const { tester } = setup();
    await expect(tester.run("writer", { target: "9.9.9" })).rejects.toThrow(/no version 9.9.9/);
    await expect(tester.run("writer", { target: "nightly" })).rejects.toThrow(/not a target/);
    await expect(tester.run("ghost", {})).rejects.toThrow(/not found/);
  });
});

describe("runs and history", () => {
  it("keeps every run with its timestamp, target and version, newest first", async () => {
    let t = Date.parse("2026-11-25T10:00:00.000Z");
    const { tester } = setup({ deps: { now: () => new Date(t += 1000) } });
    const a = await tester.run("writer", { checks: ["tools"] }, { actor: "person:ada@example.com" });
    const b = await tester.run("writer", { checks: ["versioning"] });
    const history = await tester.history("writer");
    expect(history.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(history[1]).toMatchObject({ agent: "writer", target: "production", version: "1.0.0", actor: "person:ada@example.com", status: "pass" });
    expect(Date.parse(history[1]!.finishedAt)).toBeGreaterThanOrEqual(Date.parse(history[1]!.startedAt));
    expect(await tester.get("writer", a.id)).toEqual(a);
    await tester.forget("writer");
    expect(await tester.history("writer")).toEqual([]);
  });

  it("a check that throws fails on its own without breaking the run", async () => {
    const { tester } = setup({ deps: { knownTools: async () => { throw new Error("boom"); } } });
    const run = await tester.run("writer", { checks: ["tools", "versioning"] });
    expect(run.checks.map((c) => [c.id, c.status])).toEqual([["tools", "fail"], ["versioning", "pass"]]);
    expect(run.status).toBe("fail");
  });
});
