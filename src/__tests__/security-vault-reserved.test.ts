/**
 * Security: "$"-prefixed vault owners ("$data", "$providers") are system
 * namespaces — not reachable from user/agent-facing routes and tools.
 */
import { describe, it, expect, vi } from "vitest";
import { vaultRoutes } from "@polpo-ai/server";
import { isReservedVaultOwner } from "@polpo-ai/core/vault-store";
import { AgentManager } from "@polpo-ai/core/agent-manager";
import { executeOrchestratorTool } from "../llm/orchestrator-tools.js";

function fakeVaultStore() {
  return {
    set: vi.fn(async () => {}),
    get: vi.fn(async () => ({ type: "custom", credentials: { k: "v" } })),
    patch: vi.fn(async () => ["k"]),
    remove: vi.fn(async () => true),
    list: vi.fn(async () => []),
  };
}

describe("isReservedVaultOwner", () => {
  it("flags $-prefixed names only", () => {
    expect(isReservedVaultOwner("$data")).toBe(true);
    expect(isReservedVaultOwner(" $providers")).toBe(true);
    expect(isReservedVaultOwner("alice")).toBe(false);
    expect(isReservedVaultOwner("a$b")).toBe(false);
    expect(isReservedVaultOwner(undefined)).toBe(false);
  });
});

describe("vault routes", () => {
  const json = (body: unknown, method = "POST") => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it.each(["$data", "$providers"])("rejects reserved owner %s on every route", async (owner) => {
    const store = fakeVaultStore();
    const app = vaultRoutes(() => ({ vaultStore: store }));
    const enc = encodeURIComponent(owner);

    const post = await app.request("/entries", json({ agent: owner, service: "x", type: "custom", credentials: { a: "b" } }));
    expect(post.status).toBe(400);
    expect((await app.request(`/entries/${enc}`)).status).toBe(400);
    expect((await app.request(`/entries/${enc}/data:abc`, json({ credentials: { a: "b" } }, "PATCH"))).status).toBe(400);
    expect((await app.request(`/entries/${enc}/data:abc`, { method: "DELETE" })).status).toBe(400);

    expect(store.set).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
    expect(store.patch).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("rejects sharing with reserved owners", async () => {
    const store = fakeVaultStore();
    const app = vaultRoutes(() => ({ vaultStore: store }));
    const post = await app.request("/entries", json({ agent: "alice", service: "x", type: "custom", credentials: { a: "b" }, allowedAgents: ["$data"] }));
    expect(post.status).toBe(400);
    const patch = await app.request("/entries/alice/x", json({ allowedAgents: ["$data"] }, "PATCH"));
    expect(patch.status).toBe(400);
    expect(store.set).not.toHaveBeenCalled();
    expect(store.patch).not.toHaveBeenCalled();
  });

  it("still allows normal agents", async () => {
    const store = fakeVaultStore();
    const app = vaultRoutes(() => ({ vaultStore: store }));
    const post = await app.request("/entries", json({ agent: "alice", service: "x", type: "custom", credentials: { a: "b" } }));
    expect(post.status).toBe(200);
    expect(store.set).toHaveBeenCalledWith("alice", "x", expect.anything());
  });
});

describe("orchestrator vault tools", () => {
  function fakePolpo(agentNames: string[]) {
    const store = fakeVaultStore();
    return {
      store,
      polpo: {
        getAgents: async () => agentNames.map((name) => ({ name })),
        getVaultStore: () => store,
      } as any,
    };
  }

  it.each([
    ["set_vault_entry", { agent: "$data", service: "x", type: "custom", credentials: { a: "b" } }],
    ["update_vault_credentials", { agent: "$data", service: "x", credentials: { a: "b" } }],
    ["remove_vault_entry", { agent: "$data", service: "x" }],
    ["list_vault", { agent: "$data" }],
  ])("%s refuses a reserved owner even if an agent had that name", async (tool, args) => {
    const { polpo, store } = fakePolpo(["$data", "alice"]);
    const out = await executeOrchestratorTool(tool, args as any, polpo);
    expect(out).toMatch(/reserved/);
    expect(store.set).not.toHaveBeenCalled();
    expect(store.patch).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
  });

  it("set_vault_entry refuses sharing with a reserved owner", async () => {
    const { polpo, store } = fakePolpo(["alice"]);
    const out = await executeOrchestratorTool("set_vault_entry", {
      agent: "alice", service: "x", type: "custom", credentials: { a: "b" }, allowedAgents: ["$data"],
    }, polpo);
    expect(out).toMatch(/reserved/);
    expect(store.set).not.toHaveBeenCalled();
  });
});

describe("agent names", () => {
  it("AgentManager.addAgent rejects $-prefixed names", async () => {
    const createAgent = vi.fn();
    const mgr = new AgentManager({
      agentStore: { createAgent },
      teamStore: { getTeam: async () => ({ name: "default", agents: [] }), getTeams: async () => [{ name: "default", agents: [] }] },
      emitter: { emit: () => {} },
    } as any);
    await expect(mgr.addAgent({ name: "$data" } as any, "default")).rejects.toThrow(/reserved/);
    expect(createAgent).not.toHaveBeenCalled();
  });
});

describe("$providers namespace (provider keys)", () => {
  const json = (body: unknown, method: string) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("PATCH /vault/entries/$providers/<id> with allowedAgents is refused", async () => {
    const store = fakeVaultStore();
    const app = vaultRoutes(() => ({ vaultStore: store }));
    const res = await app.request("/entries/%24providers/gw-1", json({ allowedAgents: ["alice"] }, "PATCH"));
    expect(res.status).toBe(400);
    expect(store.get).not.toHaveBeenCalled();
    expect(store.patch).not.toHaveBeenCalled();
  });

  it("POST / DELETE on $providers are refused", async () => {
    const store = fakeVaultStore();
    const app = vaultRoutes(() => ({ vaultStore: store }));
    expect((await app.request("/entries", json({ agent: "$providers", service: "gw-1", type: "api_key", credentials: { key: "x" } }, "POST"))).status).toBe(400);
    expect((await app.request("/entries/%24providers/gw-1", { method: "DELETE" })).status).toBe(400);
    expect(store.set).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("orchestrator share_vault_entry cannot target or share with $providers", async () => {
    const store = fakeVaultStore();
    const polpo = { getAgents: async () => [{ name: "$providers" }, { name: "alice" }], getVaultStore: () => store } as any;
    expect(await executeOrchestratorTool("share_vault_entry", { agent: "$providers", service: "gw-1", action: "add", withAgents: ["alice"] }, polpo)).toMatch(/reserved/);
    expect(await executeOrchestratorTool("share_vault_entry", { agent: "alice", service: "x", action: "add", withAgents: ["$providers"] }, polpo)).toMatch(/reserved/);
    expect(store.patch).not.toHaveBeenCalled();
  });
});

describe("agent vault loading", () => {
  it("never loads vault entries for $-prefixed agent names", async () => {
    const { loadAgentVaultEntries } = await import("../vault/index.js");
    const store = { getAllForAgent: vi.fn(async () => ({ key: { type: "api_key", credentials: { k: "secret" } } })) };
    expect(await loadAgentVaultEntries(store as any, "$providers")).toBeUndefined();
    expect(await loadAgentVaultEntries(store as any, "$data")).toBeUndefined();
    expect(store.getAllForAgent).not.toHaveBeenCalled();
    expect(await loadAgentVaultEntries(store as any, "alice")).toBeDefined();
    expect(store.getAllForAgent).toHaveBeenCalledWith("alice");
  });
});

describe("agent names — every creation/update path", () => {
  function mgr() {
    const createAgent = vi.fn();
    const updateAgent = vi.fn();
    const createTeam = vi.fn();
    const m = new AgentManager({
      agentStore: { createAgent, updateAgent, getAgent: async () => undefined, getAgentTeam: async () => undefined, deleteAgent: async () => false },
      teamStore: { getTeam: async () => ({ name: "default", agents: [] }), getTeams: async () => [{ name: "default", agents: [] }], createTeam },
      emitter: { emit: () => {} },
    } as any);
    return { m, createAgent, updateAgent, createTeam };
  }

  it("addTeam with a $-named agent is refused before anything is written", async () => {
    const { m, createAgent, createTeam } = mgr();
    await expect(m.addTeam({ name: "t", agents: [{ name: "$providers" }] } as any)).rejects.toThrow(/reserved/);
    expect(createTeam).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("addVolatileAgent and updateAgent refuse $-names", async () => {
    const { m, createAgent, updateAgent } = mgr();
    await expect(m.addVolatileAgent({ name: "$providers" } as any, "g")).rejects.toThrow(/reserved/);
    await expect(m.updateAgent("$providers", { role: "x" })).rejects.toThrow(/reserved/);
    expect(createAgent).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("POST /agents refuses $-names (schema validation)", async () => {
    const { agentRoutes } = await import("@polpo-ai/server");
    const addAgent = vi.fn(async () => {});
    const app = agentRoutes(() => ({ addAgent } as any));
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "$providers" }),
    });
    expect(res.status).toBe(400);
    expect(addAgent).not.toHaveBeenCalled();
  });

  it("config validation refuses $-named agents", async () => {
    const { validateAgents } = await import("../core/config.js");
    expect(() => validateAgents([{ name: "$data" }])).toThrow(/reserved/);
  });
});

describe("file-store import of system vault entries", () => {
  it("drops allowedAgents on $-owned entries, keeps normal sharing", async () => {
    const { sanitizeImportedVaultEntry } = await import("../stores/import-file-stores.js");
    const shared = { type: "api_key", credentials: { k: "v" }, allowedAgents: ["alice"] };
    expect(sanitizeImportedVaultEntry("$providers", shared)).toEqual({ type: "api_key", credentials: { k: "v" } });
    expect(sanitizeImportedVaultEntry("bob", shared)).toEqual(shared);
  });
});
