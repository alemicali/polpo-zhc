/**
 * Hosted MCP servers: templates and response mapping, the HTTP executor (secrets only to allowed
 * domains, masking, errors, retries, redirects), versions / deploy / rollback / diff, the bound
 * connector used end to end through Polpo's MCP client, approvals, the public endpoint (MCP
 * conformance, rate limits, destructive tools refused), generation with a mocked model, the Printful
 * template with a mocked API, and the REST routes. Never calls a real API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { VaultStore } from "@polpo-ai/core";
import { getPath, mapResponse, renderBody, renderString, renderUrl } from "../mcp-servers/template.js";
import { executeHttpTool, masker } from "../mcp-servers/http-executor.js";
import { normalizeSpec, specProblems } from "../mcp-servers/validate.js";
import { McpServerService, McpServerError } from "../mcp-servers/service.js";
import { runTool } from "../mcp-servers/runtime.js";
import { handlePublicMcpRequest, RateLimiter } from "../mcp-servers/public.js";
import { generateServer, outlineOpenApi, parseOpenApi } from "../mcp-servers/generate.js";
import { PRINTFUL_TEMPLATE } from "../mcp-servers/templates.js";
import { setHostedApprovalHook, setHostedDefaults } from "../mcp-servers/host.js";
import { suggestBump } from "../mcp-servers/versioning.js";
import { ConnectorManager } from "../mcp/manager.js";
import { mcpServerRoutes } from "../server/routes/mcp-servers.js";
import type { McpServerSpec } from "../mcp-servers/types.js";

const TOKEN = "pf_secret_token_123456";

function memoryVault(seed: Record<string, Record<string, string>> = {}): VaultStore {
  const entries = new Map<string, any>(Object.entries(seed).map(([k, credentials]) => [k, { type: "api_key", credentials }]));
  return {
    get: async (o: string, s: string) => entries.get(`${o}/${s}`),
    set: async (o: string, s: string, e: any) => { entries.set(`${o}/${s}`, e); },
    remove: async (o: string, s: string) => entries.delete(`${o}/${s}`),
    getAllForAgent: async () => ({}),
    patch: async () => [],
  } as unknown as VaultStore;
}

const resolve = async (host: string) => (host.endsWith(".internal") ? ["10.0.0.5"] : ["93.184.216.34"]);
const noSleep = async () => undefined;
const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

function spec(over: Partial<McpServerSpec> = {}): McpServerSpec {
  return normalizeSpec({
    name: "Shop",
    baseUrl: "https://api.shop.test",
    allowedDomains: ["api.shop.test"],
    secrets: { token: { owner: "polpo-infra", service: "shop", key: "token" } },
    auth: { type: "bearer", secret: "token" },
    tools: [
      {
        name: "get_item", description: "One item", kind: "http",
        inputSchema: { type: "object", properties: { id: { type: "string" }, verbose: { type: "boolean" } }, required: ["id"] },
        annotations: { readOnlyHint: true },
        http: { method: "GET", url: "/items/{{input.id}}", query: { verbose: "{{input.verbose}}" }, response: { pick: "data", fields: ["id", "name"] }, errors: [{ status: 404, message: "No such item" }] },
      },
      {
        name: "delete_item", description: "Delete an item", kind: "http", requiresApproval: true,
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        annotations: { destructiveHint: true },
        http: { method: "DELETE", url: "/items/{{input.id}}" },
      },
    ],
    ...over,
  });
}

describe("templates and response mapping", () => {
  it("renders inputs, keeps types for whole placeholders, drops missing values, encodes URLs", () => {
    expect(renderUrl("/a/{{input.id}}/b", { input: { id: "x y/z" } })).toBe("/a/x%20y%2Fz/b");
    expect(() => renderUrl("/a/{{input.id}}", { input: {} })).toThrow(/Missing input.id/);
    expect(renderBody({ n: "{{input.n}}", s: "Hi {{input.name}}", gone: "{{input.nope}}", list: "{{input.items}}" }, { input: { n: 3, name: "Ann", items: [1, 2] } }))
      .toEqual({ n: 3, s: "Hi Ann", list: [1, 2] });
    expect(renderString("{{input.limit ?? 20}}", { input: {} })).toBe("20");
    expect(renderString("Bearer {{secrets.t}}", { input: {}, secrets: { t: "abc" } })).toBe("Bearer abc");
    expect(() => renderBody({ x: "{{secrets.t}}" }, { input: {}, secrets: { t: "abc" } })).toThrow(/only allowed in headers/);
  });

  it("picks JSONPath-ish paths and projects fields", () => {
    const body = { data: { items: [{ id: 1, name: "a", extra: 1, opts: { color: "red", size: "M" } }, { id: 2, name: "b" }] } };
    expect(getPath(body, "$.data.items[1].name")).toBe("b");
    expect(getPath(body, "data.items[*].id")).toEqual([1, 2]);
    expect(mapResponse(body, { pick: "data.items", fields: ["id", "opts.color"] })).toEqual([{ id: 1, opts: { color: "red" } }, { id: 2 }]);
  });
});

describe("validation", () => {
  it("refuses literal secrets and reserved vault owners; lists problems without refusing the draft", () => {
    expect(() => normalizeSpec({ name: "x", secrets: { t: { owner: "a", service: "b", key: "c", value: "leak" } } })).toThrow(/never put a secret value/);
    expect(() => normalizeSpec({ name: "x", secrets: { t: { owner: "$connectors", service: "b", key: "c" } } })).toThrow(/reserved/);
    const s = normalizeSpec({ name: "x", tools: [{ name: "t", description: "", kind: "http", http: { method: "GET", url: "https://a.test/{{input.q}}?k={{secrets.k}}" } }] });
    const problems = specProblems(s);
    expect(problems.join("\n")).toMatch(/describe what it does/);
    expect(problems.join("\n")).toMatch(/input.q\}\} is not an input property/);
    expect(problems.join("\n")).toMatch(/secrets may only appear in headers and query/);
    expect(problems.join("\n")).toMatch(/allowedDomains/);
    expect(specProblems(spec())).toEqual([]);
  });
});

describe("http executor", () => {
  const secret = vi.fn(async (name: string) => (name === "token" ? TOKEN : undefined));
  beforeEach(() => secret.mockClear());

  it("injects the secret only for an allowed domain, masks it, maps the response", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
      expect(init.redirect).toBe("manual");
      expect(url).toBe("https://api.shop.test/items/42?verbose=true");
      return json(200, { data: { id: "42", name: "Mug", secret_echo: TOKEN } });
    });
    const s = spec();
    const r = await executeHttpTool(s, s.tools[0]!, { id: "42", verbose: true }, { secret, fetch, resolve });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ id: "42", name: "Mug" });
    expect(r.request?.headers.authorization).toBe("••••");
    expect(r.response).not.toContain(TOKEN);
    expect(r.structured).toEqual({ id: "42", name: "Mug" });
  });

  it("never reads or sends the secret to a domain that is not allowed, or to a private address", async () => {
    const fetch = vi.fn();
    const s = spec({ tools: [{ ...spec().tools[0]!, http: { method: "GET", url: "https://evil.test/steal" } }] });
    const r = await executeHttpTool(s, s.tools[0]!, { id: "1" }, { secret, fetch, resolve });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not one of this server's allowed domains/);
    expect(secret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const priv = spec({ allowedDomains: ["db.internal"], tools: [{ ...spec().tools[0]!, http: { method: "GET", url: "https://db.internal/x" } }] });
    const r2 = await executeHttpTool(priv, priv.tools[0]!, { id: "1" }, { secret, fetch, resolve });
    expect(r2.error).toMatch(/private or local address/);
    const http = spec({ tools: [{ ...spec().tools[0]!, http: { method: "GET", url: "http://api.shop.test/x" } }] });
    expect((await executeHttpTool(http, http.tools[0]!, { id: "1" }, { secret, fetch, resolve })).error).toMatch(/Only https/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps errors, retries 429 / 5xx for idempotent requests (Retry-After), never follows redirects", async () => {
    let n = 0;
    const fetch = vi.fn(async () => (++n === 1 ? json(429, {}, { "retry-after": "1" }) : n === 2 ? json(503, {}) : json(404, { error: { message: "nope" } })));
    const sleep = vi.fn(noSleep);
    const s = spec();
    const r = await executeHttpTool(s, s.tools[0]!, { id: "1" }, { secret, fetch, resolve, sleep });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("No such item (404: nope)");
    expect(r.attempts).toBe(3);

    const post = spec({ tools: [{ ...spec().tools[0]!, http: { method: "POST", url: "/items" } }] });
    const once = vi.fn(async () => json(500, { message: "boom" }));
    expect((await executeHttpTool(post, post.tools[0]!, { id: "1" }, { secret, fetch: once, resolve, sleep })).error).toBe("HTTP 500: boom");
    expect(once).toHaveBeenCalledTimes(1);

    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }));
    const rr = await executeHttpTool(s, s.tools[0]!, { id: "1" }, { secret, fetch: redirect, resolve });
    expect(rr.error).toMatch(/redirects are not followed/);
  });

  it("dry run shows the masked request without sending; secret missing is a clear error", async () => {
    const fetch = vi.fn();
    const s = spec();
    const dry = await executeHttpTool(s, s.tools[1]!, { id: "7" }, { secret, fetch, resolve, dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.request).toMatchObject({ method: "DELETE", url: "https://api.shop.test/items/7" });
    expect(fetch).not.toHaveBeenCalled();
    const none = await executeHttpTool(s, s.tools[0]!, { id: "1" }, { secret: async () => undefined, fetch, resolve });
    expect(none.error).toMatch(/secret "token" is not set \(vault entry polpo-infra\/shop, field token\)/);
  });

  it("masks secrets, their URL encoding and base64", () => {
    const m = masker(["p@ss word"]);
    expect(m(`a p@ss word b ${encodeURIComponent("p@ss word")} ${Buffer.from("p@ss word").toString("base64")}`)).toBe("a •••• b •••• ••••");
  });
});

describe("versions, deploys, the connector, approvals", () => {
  let dir: string;
  let vault: VaultStore;
  let manager: ConnectorManager;
  let service: McpServerService;
  const calls: Array<{ url: string; method: string; auth?: string }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", auth: (init.headers as Record<string, string>).authorization });
    if (init.method === "DELETE") return json(200, { deleted: true });
    return json(200, { data: { id: url.split("/").pop()!.split("?")[0], name: "Mug" } });
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polpo-mcp-servers-"));
    vault = memoryVault({ "polpo-infra/shop": { token: TOKEN } });
    manager = new ConnectorManager({ polpoDir: dir, vaultStore: vault, log: () => undefined });
    setHostedDefaults({ fetch, resolve, sleep: noSleep });
    service = new McpServerService({ polpoDir: dir, vault: () => vault, connectors: () => manager, runtime: () => ({ fetch, resolve, sleep: noSleep }) });
    calls.length = 0;
  });
  afterEach(async () => {
    setHostedDefaults({});
    setHostedApprovalHook(dir, undefined);
    await manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it("publish makes 1.0.0, deploys it and creates the bound connector; later versions bump, deploy, roll back, diff", async () => {
    const { id } = service.create({ spec: spec() }, "person:a@b.c");
    expect(id).toBe("shop");
    await expect(service.deploy(id, "1.0.0", { actor: "x" })).rejects.toThrow(/No version/);
    const first = await service.publish(id, {}, "person:a@b.c");
    expect(first.version).toBe("1.0.0");
    expect(first.deployed?.action).toBe("initial");
    const connector = manager.store.get("shop")!;
    expect(connector.transport).toEqual({ type: "hosted", serverId: "shop" });
    expect(connector.hostedVersion).toBe("1.0.0");
    expect(connector.access).toEqual({ agents: [], polpo: true });

    // nothing changed: nothing to publish
    await expect(service.publish(id, {}, "x")).rejects.toThrow(/nothing to publish/);
    // a description edit is a patch; an added tool a minor; a removed one a major
    const s2 = spec({ description: "Better" });
    expect(suggestBump(spec(), s2)).toBe("patch");
    service.updateDraft(id, s2, "x");
    expect((await service.publish(id, { deploy: true }, "x")).version).toBe("1.0.1");
    const s3 = spec({ description: "Better", tools: [spec().tools[0]!] });
    expect(suggestBump(s2, s3)).toBe("major");
    service.updateDraft(id, s3, "x");
    const third = await service.publish(id, { note: "drop delete" }, "x");
    expect(third.version).toBe("2.0.0");
    expect(service.store.production(id)).toBe("1.0.1");
    const diff = service.diff(id, "1.0.1", "2.0.0");
    expect(diff.changes).toEqual([{ field: "tools.delete_item", kind: "removed" }]);
    expect(diff.unified).toMatch(/^--- a\/shop@1\.0\.1\.yaml/m);
    expect(diff.unified).toMatch(/^-  delete_item:/m);
    await service.deploy(id, "2.0.0", { actor: "x" });
    expect(manager.store.get("shop")!.hostedVersion).toBe("2.0.0");
    const back = await service.rollback(id, { actor: "x" });
    expect(back).toMatchObject({ action: "rollback", from: "2.0.0", to: "1.0.1" });
    expect(service.deploys(id).map((d) => d.action)).toEqual(["rollback", "deploy", "deploy", "initial"]);
    expect(service.versions(id).find((v) => v.production)?.version).toBe("1.0.1");
  });

  it("agents use the tools through Polpo's MCP client (the connector), with the instance's key", async () => {
    const { id } = service.create({ spec: spec() }, "x");
    await service.publish(id, {}, "x");
    manager.store.update("shop", { access: { agents: ["dev"], polpo: false } });
    const { tools, notes } = await manager.toolsFor("dev");
    expect(notes).toEqual([]);
    expect(tools.map((t) => t.name).sort()).toEqual(["mcp__shop__delete_item", "mcp__shop__get_item"]);
    const get = tools.find((t) => t.name === "mcp__shop__get_item")!;
    const result = await get.execute("call-1", { id: "42" });
    expect(JSON.stringify(result.content)).toContain("Mug");
    expect(calls).toEqual([{ url: "https://api.shop.test/items/42", method: "GET", auth: `Bearer ${TOKEN}` }]);
    // listed with annotations
    const listed = await manager.listTools("shop");
    expect(listed.find((t) => t.name === "get_item")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(listed.find((t) => t.name === "delete_item")?.annotations).toMatchObject({ destructiveHint: true });
    expect(service.logs(id)[0]).toMatchObject({ tool: "get_item", source: "private", ok: true, version: "1.0.0" });
  });

  it("an approval tool is queued (never run) until a person approves it; rejection closes it", async () => {
    const hook = vi.fn(async () => "appr-1");
    setHostedApprovalHook(dir, hook);
    const { id } = service.create({ spec: spec() }, "x");
    await service.publish(id, {}, "x");
    const r = await manager.callTool("shop", "delete_item", { id: "9" });
    expect(JSON.stringify(r)).toMatch(/Queued for approval/);
    expect(calls).toEqual([]);
    expect(hook).toHaveBeenCalledTimes(1);
    const [pending] = service.pending(id);
    expect(pending).toMatchObject({ tool: "delete_item", status: "pending", approvalId: "appr-1", input: { id: "9" } });
    expect(service.findByApproval("appr-1")?.id).toBe(pending!.id);
    const done = await service.resolvePending(id, pending!.id, "approved", "person:a@b.c");
    expect(done).toMatchObject({ status: "done", resolvedBy: "person:a@b.c", result: { ok: true } });
    expect(calls).toEqual([{ url: "https://api.shop.test/items/9", method: "DELETE", auth: `Bearer ${TOKEN}` }]);
    // run once only
    await service.resolvePending(id, pending!.id, "approved");
    expect(calls).toHaveLength(1);

    await manager.callTool("shop", "delete_item", { id: "10" });
    const second = service.pending(id).find((p) => p.status === "pending")!;
    expect((await service.resolvePending(id, second.id, "rejected"))?.status).toBe("rejected");
    expect(calls).toHaveLength(1);
  });

  it("the Test section: destructive tools are a dry run unless confirmed; saved tests skip them; block on failure", async () => {
    const { id } = service.create({ spec: spec() }, "x");
    const dry = await service.test(id, { tool: "delete_item", input: { id: "1" } });
    expect(dry.skipped).toMatch(/confirm: true/);
    expect(dry.request?.method).toBe("DELETE");
    expect(calls).toEqual([]);
    const real = await service.test(id, { tool: "delete_item", input: { id: "1" }, confirm: true });
    expect(real.ok).toBe(true);
    expect(calls).toHaveLength(1);

    service.saveTests(id, [{ tool: "get_item", input: { id: "1" }, contains: "Mug" }, { tool: "delete_item", input: { id: "2" } }, { tool: "get_item", input: {}, expect: "ok" }]);
    const run = await service.runSavedTests(id);
    expect(run).toMatchObject({ passed: 1, failed: 1, skipped: 1 });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    service.updateSettings(id, { onTestFailure: "block" });
    await expect(service.publish(id, {}, "x")).rejects.toMatchObject({ code: "TESTS_FAILED" });
    const forced = await service.publish(id, { force: true }, "x");
    expect(forced.tests?.failed).toBe(1);
  });

  it("the kill switch refuses every call; delete removes the connector", async () => {
    const { id } = service.create({ spec: spec() }, "x");
    await service.publish(id, {}, "x");
    service.updateSettings(id, { disabled: true });
    const r = await manager.callTool("shop", "get_item", { id: "1" });
    expect(JSON.stringify(r)).toMatch(/switched off/);
    expect(calls).toEqual([]);
    await service.remove(id);
    expect(manager.store.get("shop")).toBeUndefined();
    expect(() => service.summary(id)).toThrow(McpServerError);
  });

  it("the connector cannot be re-pointed: auth and transport belong to the server", async () => {
    const { applyConnectorPatch } = await import("../mcp/validate.js");
    const { id } = service.create({ spec: spec() }, "x");
    await service.publish(id, {}, "x");
    await expect(applyConnectorPatch(manager.store.get("shop")!, { url: "https://evil.test/mcp" } as never, { allowStdio: true, existingIds: [] } as never)).rejects.toThrow(/bound to a server Polpo hosts/);
  });
});

describe("public endpoint", () => {
  let dir: string;
  let service: McpServerService;
  const vault = memoryVault({ "polpo-infra/shop": { token: TOKEN } });
  const fetch = vi.fn(async () => json(200, { data: { id: "1", name: "Mug" } }));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "polpo-mcp-public-"));
    service = new McpServerService({ polpoDir: dir, vault: () => vault, runtime: () => ({ fetch, resolve }) });
    const withOutput = spec();
    withOutput.tools[0]!.outputSchema = { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } };
    service.create({ spec: withOutput }, "x");
    await service.publish("shop", {}, "x");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const clientFor = (limiter: RateLimiter, ip = "1.2.3.4") => new Client({ name: "test", version: "1" }).connect(new StreamableHTTPClientTransport(new URL("https://polpo.test/mcp/servers/shop"), {
    fetch: (async (url: string | URL, init?: RequestInit) => handlePublicMcpRequest(new Request(url, init), { serverId: "shop", ip, limiter, deps: { polpoDir: dir, vault, fetch, resolve } })) as typeof globalThis.fetch,
  }));

  it("a private server does not exist from outside", async () => {
    const res = await handlePublicMcpRequest(new Request("https://polpo.test/mcp/servers/shop", { method: "POST", body: "{}" }), { serverId: "shop", ip: "1.1.1.1", limiter: new RateLimiter(), deps: { polpoDir: dir } });
    expect(res.status).toBe(404);
  });

  it("speaks MCP: initialize, tools/list with annotations and outputSchema, structured results; destructive tools hidden and refused", async () => {
    service.updateSettings("shop", { visibility: "public" });
    const client = new Client({ name: "test", version: "1" });
    const limiter = new RateLimiter();
    await client.connect(new StreamableHTTPClientTransport(new URL("https://polpo.test/mcp/servers/shop"), {
      fetch: (async (url: string | URL, init?: RequestInit) => handlePublicMcpRequest(new Request(url, init), { serverId: "shop", ip: "1.2.3.4", limiter, deps: { polpoDir: dir, vault, fetch, resolve } })) as typeof globalThis.fetch,
    }));
    expect(client.getServerVersion()).toMatchObject({ name: "Shop", version: "1.0.0" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_item"]);
    expect(tools[0]).toMatchObject({ annotations: { readOnlyHint: true }, outputSchema: { type: "object" } });
    const r = await client.callTool({ name: "get_item", arguments: { id: "1" } });
    expect(r.structuredContent).toEqual({ id: "1", name: "Mug" });
    const blocked = await client.callTool({ name: "delete_item", arguments: { id: "1" } });
    expect(blocked.isError).toBe(true);
    expect(service.logs("shop")[0]).toMatchObject({ source: "public", ip: "1.2.3.4", ok: true });
    await client.close();
  });

  it("rate limits per IP and globally (429 with Retry-After); the kill switch answers 503", async () => {
    service.updateSettings("shop", { visibility: "public", rateLimits: { perIpPerMinute: 2, globalPerMinute: 3 } });
    const limiter = new RateLimiter();
    const post = (ip: string) => handlePublicMcpRequest(new Request("https://polpo.test/mcp/servers/shop", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }), { serverId: "shop", ip, limiter, deps: { polpoDir: dir } });
    expect((await post("a")).status).toBe(200);
    expect((await post("a")).status).toBe(200);
    const limited = await post("a");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post("b")).status).toBe(200);
    expect((await post("c")).status).toBe(429); // global
    service.updateSettings("shop", { disabled: true });
    expect((await post("d")).status).toBe(503);
    void clientFor;
  });
});

describe("generation (mocked model)", () => {
  const openapi = {
    openapi: "3.0.0", info: { title: "Pets" }, servers: [{ url: "https://api.pets.test/v1" }],
    components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-API-Key" } } },
    paths: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`/thing${i}`, { get: { summary: `Thing ${i}` } }]).concat([["/pets/{id}", { get: { summary: "A pet", parameters: [{ name: "id", in: "path", required: true }] } }]])),
  };

  it("outlines the API and turns the model's proposal into a curated draft; literal secrets never survive", async () => {
    const doc = parseOpenApi(JSON.stringify(openapi))!;
    const o = outlineOpenApi(doc);
    expect(o.endpoints).toBe(31);
    expect(o.outline).toMatch(/GET \/pets\/\{id\} — A pet \[id\*\(path\)\]/);
    const llm = vi.fn(async (prompt: string) => {
      expect(prompt).toMatch(/CURATE/);
      expect(prompt).toMatch(/Base URL: https:\/\/api.pets.test\/v1/);
      return "```json\n" + JSON.stringify({
        name: "Pets", baseUrl: "https://api.pets.test/v1", allowedDomains: ["api.pets.test"],
        secrets: { token: { owner: "polpo-infra", service: "pets", key: "token", value: "sk-leaked" } },
        auth: { type: "header", header: "X-API-Key", secret: "token" },
        tools: [
          { name: "get_pet", description: "One pet by id", kind: "http", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { readOnlyHint: true }, http: { method: "GET", url: "/pets/{{input.id}}" } },
          { name: "bad tool!", description: "x", kind: "http", http: { method: "GET", url: "/x" } },
        ],
      }) + "\n```";
    });
    const r = await generateServer({ mode: "api", text: JSON.stringify(openapi), goal: "look up pets" }, llm);
    expect(r.source).toMatchObject({ kind: "openapi", endpoints: 31, title: "Pets" });
    expect(r.spec.tools.map((t) => t.name)).toEqual(["get_pet"]);
    expect(r.notes.join("\n")).toMatch(/Dropped a proposed tool/);
    expect(JSON.stringify(r.spec)).not.toContain("sk-leaked");
    expect(r.spec.secrets.token).toEqual({ owner: "polpo-infra", service: "pets", key: "token" });
    expect(r.problems).toEqual([]);
  });

  it("from a description: code tools", async () => {
    const llm = async () => JSON.stringify({ name: "Math", tools: [{ name: "add", description: "Add two numbers", kind: "code", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } }, code: { source: "export async function handler(i) { return { sum: i.a + i.b } }" } }] });
    const r = await generateServer({ mode: "description", text: "add two numbers" }, llm);
    expect(r.spec.tools[0]).toMatchObject({ name: "add", kind: "code" });
    expect(r.problems).toEqual([]);
  });
});

describe("Printful template (mocked API)", () => {
  let dir: string;
  const vault = memoryVault({ "polpo-infra/printful": { token: TOKEN } });
  const seen: Array<{ url: string; method: string; body?: any; auth?: string }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? "GET", ...(init.body ? { body: JSON.parse(String(init.body)) } : {}), auth: (init.headers as Record<string, string>).authorization });
    const u = new URL(url);
    if (u.pathname === "/categories") return json(200, { code: 200, result: { categories: [{ id: 24, parent_id: 6, title: "T-Shirts", image_url: "x" }] } });
    if (u.pathname === "/products") return json(200, { code: 200, result: [{ id: 71, title: "Unisex Staple T-Shirt", type_name: "T-Shirt", brand: "Bella + Canvas", model: "3001", variant_count: 200, files: [] }] });
    if (u.pathname === "/products/71") return json(200, { code: 200, result: { product: { id: 71, title: "Unisex Staple T-Shirt", type_name: "T-Shirt", brand: "B+C", description: "Soft", files: [] }, variants: [{ id: 4012, size: "M", color: "Black", price: "9.25" }] } });
    if (u.pathname === "/products/variant/4012") return json(200, { code: 200, result: { variant: { id: 4012 }, product: { id: 71 } } });
    if (u.pathname === "/shipping/rates") return json(200, { code: 200, result: [{ id: "STANDARD", rate: "4.49", currency: "EUR" }] });
    if (u.pathname === "/mockup-generator/create-task/71") return json(200, { code: 200, result: { task_key: "gt-1", status: "pending" } });
    if (u.pathname === "/mockup-generator/task") return json(200, { code: 200, result: { task_key: "gt-1", status: "completed", mockups: [{ mockup_url: "https://files.cdn.printful.com/m.png" }] } });
    if (u.pathname === "/orders" && init.method === "POST") return json(200, { code: 200, result: { id: 123, external_id: "A1", status: "draft", costs: { total: "13.74" }, created: 1 } });
    if (u.pathname === "/orders/123") return json(200, { code: 200, result: { id: 123, status: "draft", recipient: { name: "Ann", country_code: "IT", address1: "secret street" }, items: [], costs: {}, shipments: [] } });
    if (u.pathname === "/orders") return json(200, { code: 200, result: [{ id: 123, status: "draft" }], paging: { total: 1, offset: 0, limit: 20 } });
    return json(404, { code: 404, result: "Not Found", error: { reason: "NotFound", message: "Not Found" } });
  });
  let service: McpServerService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polpo-mcp-printful-"));
    seen.length = 0;
    service = new McpServerService({ polpoDir: dir, vault: () => vault, runtime: () => ({ fetch, resolve, sleep: noSleep }) });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    runTool({ serverId: "printful", spec: PRINTFUL_TEMPLATE.spec, toolName: tool, input, source: "test", ...extra }, { polpoDir: dir, vault, fetch, resolve, sleep: noSleep });

  it("is a valid server whose credential is the vault entry polpo-infra/printful (field token), bearer", () => {
    expect(specProblems(PRINTFUL_TEMPLATE.spec)).toEqual([]);
    expect(PRINTFUL_TEMPLATE.spec.secrets).toEqual({ token: { owner: "polpo-infra", service: "printful", key: "token" } });
    expect(PRINTFUL_TEMPLATE.spec.auth).toEqual({ type: "bearer", secret: "token" });
    expect(JSON.stringify(PRINTFUL_TEMPLATE.spec.tools.map((t) => t.http))).not.toMatch(/"confirm"/);
    const order = PRINTFUL_TEMPLATE.spec.tools.find((t) => t.name === "create_order")!;
    expect(order).toMatchObject({ requiresApproval: true, annotations: { destructiveHint: true } });
    expect(order.http?.query).toBeUndefined();
    expect(PRINTFUL_TEMPLATE.spec.tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name))
      .toEqual(["list_catalog_categories", "list_catalog_products", "get_product", "get_variant", "get_shipping_rates", "get_mockup_result", "get_order", "list_orders"]);
  });

  it("each read tool calls the right endpoint with the bearer token and returns a slim result", async () => {
    expect(JSON.parse((await run("list_catalog_categories", {})).text)).toEqual([{ id: 24, parent_id: 6, title: "T-Shirts" }]);
    const products = await run("list_catalog_products", { category_id: 24 });
    expect(JSON.parse(products.text)[0]).toEqual({ id: 71, title: "Unisex Staple T-Shirt", type_name: "T-Shirt", brand: "Bella + Canvas", model: "3001", variant_count: 200 });
    expect((await run("get_product", { product_id: 71 })).text).toMatch(/4012/);
    expect((await run("get_variant", { variant_id: 4012 })).ok).toBe(true);
    const rates = await run("get_shipping_rates", { recipient: { country_code: "IT", zip: "20121" }, items: [{ variant_id: 4012, quantity: 1 }], currency: "EUR" });
    expect(rates.text).toMatch(/STANDARD/);
    const task = await run("create_mockup_task", { product_id: 71, variant_ids: [4012], files: [{ placement: "front", image_url: "https://example.com/d.png" }] });
    expect(JSON.parse(task.text)).toEqual({ task_key: "gt-1", status: "pending" });
    expect((await run("get_mockup_result", { task_key: "gt-1" })).text).toMatch(/completed/);
    const order = await run("get_order", { order_id: "123" });
    expect(order.text).not.toMatch(/secret street/);
    expect(JSON.parse((await run("list_orders", { status: "draft" })).text).paging.total).toBe(1);
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}${new URL(s.url).search}`)).toEqual([
      "GET /categories", "GET /products?category_id=24", "GET /products/71", "GET /products/variant/4012", "POST /shipping/rates",
      "POST /mockup-generator/create-task/71", "GET /mockup-generator/task?task_key=gt-1", "GET /orders/123", "GET /orders?status=draft&limit=20",
    ]);
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(seen.every((s) => new URL(s.url).host === "api.printful.com")).toBe(true);
    expect(seen[4]!.body).toEqual({ recipient: { country_code: "IT", zip: "20121" }, items: [{ variant_id: 4012, quantity: 1 }], currency: "EUR" });
  });

  it("create_order never runs on its own: queued for approval for agents, a dry run in tests unless confirmed, skipped by saved tests; a DRAFT when approved", async () => {
    const input = { external_id: "A1", recipient: { name: "Ann", address1: "Via Roma 1", city: "Milano", country_code: "IT", zip: "20121" }, items: [{ variant_id: 4012, quantity: 1, files: [{ url: "https://example.com/d.png" }] }] };
    const queued = await run("create_order", input, { source: "private" });
    expect(queued.pendingApproval).toBeDefined();
    expect(seen).toEqual([]);
    const { id } = (() => { const c = service.create({ id: "printful", spec: PRINTFUL_TEMPLATE.spec, template: "printful" }, "x"); service.saveTests(c.id, [...PRINTFUL_TEMPLATE.tests, { tool: "create_order", input }]); return c; })();
    const dry = await service.test(id, { tool: "create_order", input });
    expect(dry.skipped).toBeDefined();
    expect(dry.request).toMatchObject({ method: "POST", url: "https://api.printful.com/orders" });
    expect(seen).toEqual([]);
    const saved = await service.runSavedTests(id);
    expect(saved.skipped).toBe(1);
    expect(seen.some((s) => s.method === "POST" && new URL(s.url).pathname === "/orders")).toBe(false);
    const approved = await run("create_order", input, { source: "approval", approved: true });
    expect(JSON.parse(approved.text)).toMatchObject({ id: 123, status: "draft" });
    const post = seen.find((s) => new URL(s.url).pathname === "/orders")!;
    expect(new URL(post.url).search).toBe("");
    expect(post.body).toEqual(input);
  });
});

describe("REST routes", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("create from the Printful template, read (secrets: set or not, never values), test, publish, versions, diff", async () => {
    dir = mkdtempSync(join(tmpdir(), "polpo-mcp-routes-"));
    const vault = memoryVault({ "polpo-infra/printful": { token: TOKEN } });
    const fetch = vi.fn(async () => json(200, { code: 200, result: { categories: [{ id: 1, title: "A" }] } }));
    const manager = new ConnectorManager({ polpoDir: dir, vaultStore: vault, log: () => undefined });
    const service = new McpServerService({ polpoDir: dir, vault: () => vault, connectors: () => manager, runtime: () => ({ fetch, resolve }) });
    const app = mcpServerRoutes({ service: () => service, llm: () => async () => "{}", actor: () => "person:a@b.c", publicBase: () => "https://polpo.test" });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json() as any };
    };
    expect((await call("GET", "/templates")).body.data.templates[0]).toMatchObject({ id: "printful", toolCount: 10 });
    const created = await call("POST", "/", { template: "printful" });
    expect(created.body.data).toMatchObject({ id: "printful", problems: [] });
    expect(created.body.data.setup).toMatch(/polpo-infra/);
    const got = await call("GET", "/printful");
    expect(got.body.data.secrets).toEqual({ token: true });
    expect(JSON.stringify(got.body)).not.toContain(TOKEN);
    expect(got.body.data.tests).toHaveLength(3);
    const test = await call("POST", "/printful/test", { tool: "list_catalog_categories", input: {} });
    expect(test.body.data).toMatchObject({ ok: true, request: { url: "https://api.printful.com/categories", headers: { authorization: "••••" } } });
    const published = await call("POST", "/printful/publish", { note: "first" });
    expect(published.body.data).toMatchObject({ version: "1.0.0", deployed: { action: "initial" } });
    expect(manager.store.get("printful")?.transport.type).toBe("hosted");
    expect((await call("GET", "/printful/versions")).body.data.versions[0]).toMatchObject({ version: "1.0.0", production: true, toolCount: 10 });
    expect((await call("POST", "/printful/publish", {})).status).toBe(409);
    expect((await call("PATCH", "/printful", { visibility: "public" })).body.data.publicUrl).toBe("https://polpo.test/mcp/servers/printful");
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("PUT", "/printful/draft", { spec: { ...PRINTFUL_TEMPLATE.spec, description: "Edited" } })).body.data.problems).toEqual([]);
    expect((await call("GET", "/printful/diff")).body.data.changes).toEqual([{ field: "description", kind: "changed" }]);
    expect((await call("GET", "/printful/logs")).body.data.logs.length).toBeGreaterThan(0);
    await manager.closeAll();
  });
});

describe("MCP tools (polpo_mcp_server_*) and Polpo's chat tools", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("create from template, get, test (dry run for create_order), publish, deploy back, logs, delete with confirm; changes need admin", async () => {
    const { handleMcpRequest } = await import("../server/mcp.js");
    const { expectValidOutput } = await import("./helpers/mcp-output.js");
    dir = mkdtempSync(join(tmpdir(), "polpo-mcp-tools-"));
    const vault = memoryVault({ "polpo-infra/printful": { token: TOKEN } });
    const fetch = vi.fn(async () => json(200, { code: 200, result: { categories: [{ id: 1, title: "A" }] } }));
    const manager = new ConnectorManager({ polpoDir: dir, vaultStore: vault, log: () => undefined });
    const service = new McpServerService({ polpoDir: dir, vault: () => vault, connectors: () => manager, runtime: () => ({ fetch, resolve }) });
    const routes = mcpServerRoutes({ service: () => service, llm: () => async () => "{}", actor: () => "mcp:test", publicBase: () => "https://polpo.test" });
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await routes.request(path.replace(/^\/api\/v1\/mcp-servers/, "") || "/", { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    const deps = (scopes: string[] = ["polpo:admin"]) => ({ api, version: "x", toolsets: ["connectors"], principal: { kind: "oauth" as const, actor: "t", scopes } });
    const rpc = async (d: ReturnType<typeof deps>, method: string, params: Record<string, unknown> = {}) => (await (await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), d as never)).json()).result;
    const call = async (name: string, args: Record<string, unknown> = {}, d = deps()) => {
      const result = await rpc(d, "tools/call", { name, arguments: args });
      await expectValidOutput(d as never, async () => (await rpc(d, "tools/list")).tools, name, result);
      return result;
    };
    const readOnly = (await rpc(deps(["polpo:read", "polpo:work", "polpo:connectors"]), "tools/list")).tools.map((t: { name: string }) => t.name).filter((n: string) => n.includes("mcp_server"));
    expect(readOnly.sort()).toEqual(["polpo_mcp_server_get", "polpo_mcp_server_logs", "polpo_mcp_servers_list"]);

    const created = await call("polpo_mcp_server_create", { template: "printful" });
    expect(created.structuredContent).toMatchObject({ id: "printful", problems: [] });
    expect(created.content[0].text).toMatch(/polpo-infra/);
    const got = await call("polpo_mcp_server_get", { id: "printful" });
    expect(got.content[0].text).toMatch(/secret token: vault polpo-infra\/printful field token — set/);
    expect(got.content[0].text).toMatch(/create_order \(http POST \/orders\) \[needs approval\]/);
    const dry = await call("polpo_mcp_server_test", { id: "printful", tool: "create_order", input: { recipient: { name: "A", address1: "x", city: "y", country_code: "IT", zip: "1" }, items: [{ variant_id: 1, quantity: 1 }] } });
    expect(dry.content[0].text).toMatch(/^Not sent/);
    expect(fetch).not.toHaveBeenCalled();
    expect((await call("polpo_mcp_server_test", { id: "printful", all: true })).structuredContent).toMatchObject({ passed: 3, failed: 0, skipped: 0 });
    expect((await call("polpo_mcp_server_update", { id: "printful", visibility: "public" })).isError).toBe(true);
    const pub = await call("polpo_mcp_server_publish", { id: "printful", note: "first" });
    expect(pub.structuredContent).toMatchObject({ version: "1.0.0", deployed: { action: "initial" } });
    await call("polpo_mcp_server_update", { id: "printful", spec: { ...PRINTFUL_TEMPLATE.spec, description: "v2" } });
    expect((await call("polpo_mcp_server_publish", { id: "printful", deploy: true })).structuredContent.version).toBe("1.0.1");
    const withDiff = await call("polpo_mcp_server_get", { id: "printful", versions: true, diff: { from: "1.0.0", to: "1.0.1" } });
    expect(withDiff.structuredContent.diff.changes).toEqual([{ field: "description", kind: "changed" }]);
    expect((await call("polpo_mcp_server_deploy", { id: "printful", rollback: true })).structuredContent).toMatchObject({ to: "1.0.0", action: "rollback" });
    expect((await call("polpo_mcp_server_logs", { id: "printful" })).structuredContent.logs.length).toBeGreaterThan(0);
    expect((await call("polpo_mcp_server_delete", { id: "printful" })).isError).toBe(true);
    expect((await call("polpo_mcp_server_delete", { id: "printful", confirm: true })).structuredContent).toEqual({ removed: true });
    expect(manager.store.get("printful")).toBeUndefined();
    await manager.closeAll();
  });

  it("Polpo's chat gets them as deferred tools (hosted-servers group)", async () => {
    dir = mkdtempSync(join(tmpdir(), "polpo-mcp-x-"));
    const { bridgedTools, BRIDGED_TOOLS } = await import("../llm/polpo-mcp-bridge.js");
    const names = bridgedTools().map((t) => t.name).filter((n) => n.startsWith("mcp_server"));
    expect(names).toContain("mcp_server_create");
    expect(BRIDGED_TOOLS.filter((t) => t.name.startsWith("mcp_server")).every((t) => t.group === "hosted-servers")).toBe(true);
  });
});
