import { describe, expect, it } from "vitest";
import { agentRoutes } from "@polpo-ai/server";
import { AgentVersioning, InMemoryAgentVersionStore, type AgentConfig, type AgentUpdate } from "@polpo-ai/core";

/** agentRoutes over an in-memory team with versioning (as src/server/app.ts wires it). */
function app(opts: { autoDeploy?: boolean } = {}) {
  const agents = new Map<string, AgentConfig>([["writer", { name: "writer", role: "Writes", systemPrompt: "Be concise.", allowedTools: ["read"] }]]);
  const writeLive = async (name: string, updates: AgentUpdate) => {
    const merged = { ...agents.get(name)!, ...updates } as Record<string, unknown>;
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    agents.set(name, merged as unknown as AgentConfig);
    return merged as unknown as AgentConfig;
  };
  const versioning = new AgentVersioning(new InMemoryAgentVersionStore(), {
    getAgent: async (n) => agents.get(n), getAgents: async () => [...agents.values()], writeLive,
  });
  const http = agentRoutes((() => ({
    getAgents: async () => [...agents.values()],
    updateAgent: writeLive,
    polpoDir: "/tmp",
    versions: {
      versioning: () => versioning,
      update: async (name: string, updates: AgentUpdate, o: { actor: string; mode: "draft" | "publish" | "deploy"; note?: string }) => {
        const r = await versioning.update(name, updates, o);
        return { agent: agents.get(name), ...r };
      },
      deploy: (name: string, version: string, o: { actor: string; note?: string }) => versioning.deploy(name, version, o),
      rollback: (name: string, o: { actor: string; note?: string; to?: string }) => versioning.rollback(name, o),
      autoDeploy: () => opts.autoDeploy ?? true,
      actor: () => "person:ada@example.com",
    },
  })) as unknown as Parameters<typeof agentRoutes>[0]);
  const json = async (method: string, path: string, body?: unknown) => {
    const res = await http.request(path, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    return { status: res.status, body: await res.json() as any };
  };
  return { agents, versioning, json };
}

describe("agent versioning REST", () => {
  it("PATCH without flags keeps the old immediate effect (auto publish + deploy) by default", async () => {
    const { json, agents } = app();
    const r = await json("PATCH", "/writer", { systemPrompt: "Be brief." });
    expect(r.status).toBe(200);
    expect(r.body.data.systemPrompt).toBe("Be brief.");
    expect(r.body.data.versioning).toMatchObject({ mode: "deploy", production: "1.0.1", published: { version: "1.0.1", bump: "patch" } });
    expect(r.body.data.versioning.deployed).toMatchObject({ from: "1.0.0", to: "1.0.1", actor: "person:ada@example.com" });
    expect(agents.get("writer")!.systemPrompt).toBe("Be brief.");
  });

  it("PATCH writes only the draft when the setting is off or publish: false", async () => {
    for (const variant of [{ autoDeploy: false, body: {} }, { autoDeploy: true, body: { publish: false } }]) {
      const { json, agents } = app({ autoDeploy: variant.autoDeploy });
      const r = await json("PATCH", "/writer", { allowedTools: ["read", "bash"], ...variant.body });
      expect(r.status).toBe(200);
      // production unchanged, the draft has the change
      expect(r.body.data.allowedTools).toEqual(["read"]);
      expect(agents.get("writer")!.allowedTools).toEqual(["read"]);
      expect(r.body.data.versioning).toMatchObject({ mode: "draft", draftChanged: true, production: "1.0.0", draft: { hasChanges: true, suggestedBump: "minor", nextVersion: "1.1.0", changedFields: ["allowedTools"] } });
    }
  });

  it("PATCH publish: true publishes without deploying; deploy: true does both", async () => {
    const { json, agents } = app();
    let r = await json("PATCH", "/writer", { role: "Edits", publish: true, note: "rename" });
    expect(r.body.data.versioning).toMatchObject({ mode: "publish", published: { version: "1.0.1" }, production: "1.0.0" });
    expect(agents.get("writer")!.role).toBe("Writes");
    r = await json("PATCH", "/writer", { model: "openai:gpt-5", deploy: true, version: "3.0.0" });
    expect(r.body.data.versioning).toMatchObject({ mode: "deploy", published: { version: "3.0.0" }, production: "3.0.0" });
    expect(agents.get("writer")).toMatchObject({ role: "Edits", model: "openai:gpt-5" });
  });

  it("lists, reads and diffs versions; publishes, deploys and rolls back with an audited history", async () => {
    const { json, agents } = app({ autoDeploy: false });
    await json("PATCH", "/writer", { systemPrompt: "Be concise.\nCite sources." });

    let r = await json("GET", "/writer/diff");
    expect(r.body.data).toMatchObject({ from: "1.0.0", to: "draft", suggestedBump: "patch" });
    expect(r.body.data.unified).toContain("+  Cite sources.");

    r = await json("POST", "/writer/publish", { note: "sources" });
    expect(r.status).toBe(200);
    expect(r.body.data.version).toMatchObject({ version: "1.0.1", note: "sources", author: "person:ada@example.com" });
    r = await json("POST", "/writer/publish", {});
    expect(r.status).toBe(409);

    r = await json("GET", "/writer/versions");
    expect(r.body.data.state).toMatchObject({ production: "1.0.0", latest: "1.0.1" });
    expect(r.body.data.versions.map((v: { version: string }) => v.version)).toEqual(["1.0.1", "1.0.0"]);
    expect(r.body.data.versions[0].config).toBeUndefined();

    r = await json("GET", "/writer/versions/1.0.1");
    expect(r.body.data.config.systemPrompt).toBe("Be concise.\nCite sources.");
    expect((await json("GET", "/writer/versions/9.9.9")).status).toBe(404);

    r = await json("POST", "/writer/deploy", { version: "1.0.1", note: "ship" });
    expect(r.body.data).toMatchObject({ from: "1.0.0", to: "1.0.1", action: "deploy", note: "ship" });
    expect(agents.get("writer")!.systemPrompt).toContain("Cite sources.");

    r = await json("GET", "/writer");
    expect(r.body.data.versioning).toMatchObject({ production: "1.0.1", latest: "1.0.1", draft: { hasChanges: false } });

    r = await json("POST", "/writer/rollback", { note: "oops" });
    expect(r.body.data).toMatchObject({ action: "rollback", from: "1.0.1", to: "1.0.0" });
    expect(agents.get("writer")!.systemPrompt).toBe("Be concise.");

    r = await json("GET", "/writer/deploys?diff=true");
    expect(r.body.data.map((d: { action: string }) => d.action)).toEqual(["rollback", "deploy", "initial"]);
    expect(r.body.data[0].diff.unified).toContain("-  Cite sources.");
    const id = r.body.data[1].id;
    r = await json("GET", `/writer/deploys/${id}`);
    expect(r.body.data.diff.changes.map((c: { field: string }) => c.field)).toEqual(["systemPrompt"]);
  });

  it("discards the draft", async () => {
    const { json } = app({ autoDeploy: false });
    await json("PATCH", "/writer", { role: "x" });
    expect((await json("DELETE", "/writer/draft")).body.data).toEqual({ discarded: true });
    expect((await json("GET", "/writer")).body.data.versioning.draft.hasChanges).toBe(false);
    expect((await json("GET", "/ghost/versions")).status).toBe(404);
  });
});
