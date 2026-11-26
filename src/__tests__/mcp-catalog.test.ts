/**
 * The MCP tool catalog is declared once per process and bound to each request (mcp-server/catalog.ts):
 * a request builds no schema, two requests share them, each handler runs with its own request's
 * deps (principal, api…), the toolsets and scopes still decide what each request gets, and
 * tools/list is what the SDK's own handler would answer.
 */
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPolpoMcpServer, handleMcpRequest, mcpCatalog, type McpDeps, type McpPrincipal } from "../server/mcp.js";
import { TOOLSET_NAMES, requestDeps, withRequestDeps } from "../server/mcp-server/kit.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK keeps registered tools in a private field
const registered = (s: McpServer) => (s as any)._registeredTools as Record<string, { inputSchema?: unknown; outputSchema?: unknown; handler: unknown }>;

/** An API that answers the agents list with these names, after a delay (so concurrent requests interleave). */
function agentsApi(names: string[], delay = 0): McpDeps["api"] {
  return async (_method, path) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return { status: 200, body: path.endsWith("/agents") ? names.map((name) => ({ name })) : [], headers: new Headers() };
  };
}

async function rpc(deps: McpDeps, method: string, params: Record<string, unknown> = {}, query = "") {
  const res = await handleMcpRequest(new Request(`http://localhost/mcp${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), deps);
  return { status: res.status, body: await res.json() as { result?: any; error?: any } };
}

const READER: McpPrincipal = { kind: "key", actor: "reader", scopes: ["polpo:read"] };
const ADMIN: McpPrincipal = { kind: "key", actor: "admin", scopes: ["polpo:admin"] };

describe("the MCP tool catalog", () => {
  it("is declared once: later servers reuse its schemas and build in a few milliseconds", () => {
    const api = agentsApi([]);
    expect(mcpCatalog()).toBe(mcpCatalog());
    const a = createPolpoMcpServer({ api, version: "1", toolsets: TOOLSET_NAMES });
    const b = createPolpoMcpServer({ api, version: "1", toolsets: TOOLSET_NAMES });
    const ta = registered(a);
    const tb = registered(b);
    expect(Object.keys(ta).length).toBeGreaterThan(200);
    expect(Object.keys(tb)).toEqual(Object.keys(ta));
    for (const name of Object.keys(ta)) {
      expect(tb[name]!.inputSchema, name).toBe(ta[name]!.inputSchema);
      expect(tb[name]!.outputSchema, name).toBe(ta[name]!.outputSchema);
      expect(tb[name]!.handler, name).not.toBe(ta[name]!.handler); // bound to each request
    }
    // building every tool's zod schemas took 120–210 ms a request; binding the catalog takes ~1 ms
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      void createPolpoMcpServer({ api, version: "1", toolsets: TOOLSET_NAMES }).close();
      times.push(performance.now() - t);
    }
    times.sort((x, y) => x - y);
    expect(times[2]).toBeLessThan(40);
    void a.close();
    void b.close();
  });

  it("declarations cannot read a request's deps; handlers read their own request's", async () => {
    expect(() => requestDeps.api).toThrow(/outside a request/);
    const deps: McpDeps = { api: agentsApi([]), version: "7", publicUrl: "https://a.example.com" };
    expect(withRequestDeps(deps, () => ({ ...requestDeps }))).toEqual(deps);
    expect(withRequestDeps(deps, () => "publicUrl" in requestDeps && requestDeps.publicUrl)).toBe("https://a.example.com");
  });

  it("keeps concurrent requests apart: each gets its principal's tools and its own deps", async () => {
    const reader: McpDeps = { api: agentsApi(["reader-agent"], 30), version: "1", principal: READER, toolsets: ["core", "tasks"] };
    const admin: McpDeps = { api: agentsApi(["admin-agent"], 5), version: "1", principal: ADMIN, toolsets: TOOLSET_NAMES };
    const [listR, listA, callR, callA] = await Promise.all([
      rpc(reader, "tools/list"),
      rpc(admin, "tools/list"),
      rpc(reader, "tools/call", { name: "polpo_agents_list", arguments: {} }),
      rpc(admin, "tools/call", { name: "polpo_agents_list", arguments: {} }),
    ]);
    const namesR = (listR.body.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>);
    const namesA = (listA.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    // the reader: read-only tools of core and tasks only
    expect(namesR.length).toBeGreaterThan(3);
    expect(namesR.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    expect(namesR.map((t) => t.name)).toContain("polpo_tasks_list");
    expect(namesR.map((t) => t.name)).not.toContain("polpo_task_create");
    expect(namesR.map((t) => t.name)).not.toContain("polpo_missions_list");
    // the admin: every toolset, writes too
    expect(namesA).toEqual(expect.arrayContaining(["polpo_task_create", "polpo_missions_list", "polpo_api_get", "agent_intention_decide"]));
    expect(namesA.length).toBeGreaterThan(namesR.length);
    // each handler used its own request's api, though the reader's answered last
    expect(callR.body.result.structuredContent.items).toEqual([expect.objectContaining({ name: "reader-agent" })]);
    expect(callA.body.result.structuredContent.items).toEqual([expect.objectContaining({ name: "admin-agent" })]);
    // and a narrower request after a wider one still gets only its own
    const again = await rpc(reader, "tools/list");
    expect((again.body.result.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(namesR.map((t) => t.name));
    // a call beyond the reader's scope is still refused before any work (step-up)
    const denied = await rpc(reader, "tools/call", { name: "polpo_task_create", arguments: { title: "x", description: "x", assignTo: "a" } });
    expect(denied.status).toBe(403);
  });

  it("answers tools/list as the SDK's own handler does", async () => {
    const deps: McpDeps = { api: agentsApi([]), version: "1", toolsets: TOOLSET_NAMES };
    const ours = createPolpoMcpServer(deps);
    // the same tools on a plain McpServer, whose tools/list converts the schemas itself
    const plain = new McpServer({ name: "polpo", version: "1" });
    for (const [name, t] of Object.entries(registered(ours)) as Array<[string, any]>) {
      plain.registerTool(name, { title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations, _meta: t._meta }, t.handler);
    }
    const list = async (server: McpServer) => {
      const client = new Client({ name: "t", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      try {
        return (await client.listTools()).tools;
      } finally {
        await client.close();
      }
    };
    const [mine, sdk] = [await list(ours), await list(plain)];
    expect(mine.length).toBeGreaterThan(200);
    expect(mine).toEqual(sdk);
  });
});
