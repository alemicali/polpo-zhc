/**
 * Connectors (Polpo as an MCP client) against a real in-process MCP server (SDK McpServer over
 * streamable HTTP on an ephemeral port), with a bearer-protected variant and an OAuth-protected one
 * backed by a minimal fake authorization server (discovery, DCR, PKCE, refresh, revocation).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CONNECTORS_VAULT_OWNER, connectorGrants, connectorOwner, connectorVisibleTo, parseConnectorIdentity, personConnectorIdentity, resolveConnectorAccount,
  taskToolScopeGrantProblems, taskToolScopeMissingGrants, type AgentConfig, type Task, type TaskToolScope } from "@polpo-ai/core";
import { importConnectorAccount, updateConnectorAccount } from "../mcp/accounts.js";
import { registerConnectorTools } from "../server/mcp-server/connectors.js";
import type { McpDeps, Register } from "../server/mcp-server/kit.js";
import { buildAgentToolset } from "../adapters/engine.js";
import { toHarnessHostTools } from "../harness/host-tools.js";
import { scopedAgentForRun } from "../core/task-tool-scope.js";
import { ProgressiveToolSet } from "@polpo-ai/core/progressive-tools";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";
import { ConnectorManager } from "../mcp/manager.js";
import { buildConnector, ConnectorInputError } from "../mcp/validate.js";
import { checkConnectorUrl } from "../mcp/net.js";
import { connectorToolAllowed, convertToolResult, mcpToolName, MAX_RESULT_TEXT, toolResultText } from "../mcp/tools.js";
import { connectorRoutes, connectorOAuthCallback, CONNECTOR_OAUTH_CALLBACK_PATH } from "../server/routes/connectors.js";
import { CONNECTOR_CATALOG } from "../mcp/catalog.js";
import { clientMetadataDocument, clientMetadataUrlFor } from "../mcp/paths.js";
import { connectorDashboardBase, connectorPublicBase, connectorsPromptSection, currentConnectorPerson } from "../mcp/runtime.js";
import { withEventOrigin } from "../core/events.js";
import { accountFromIdToken, connectorLabel } from "../mcp/view.js";
import { executeConnectorTool } from "../tools/connector-tools.js";

// ── a fake MCP server + authorization server ──

interface FakeAuth {
  clients: Map<string, { redirect_uris: string[] }>;
  codes: Map<string, { challenge: string; redirectUri: string; clientId: string }>;
  access: Set<string>;
  refresh: Set<string>;
  revoked: string[];
  lastAuthorize?: URLSearchParams;
  n: number;
  cimd?: boolean;
  /** Return an OpenID id_token naming this email with the tokens. */
  idTokenEmail?: string;
  oauthFailure?: { path: string; status: number; body: string | Record<string, string> };
}

const BEARER = "secret-bearer-token-123";
let server: Server;
let base: string;
const fake: FakeAuth = { clients: new Map(), codes: new Map(), access: new Set(), refresh: new Set(), revoked: [], n: 0 };

function mcpServer(): McpServer {
  const s = new McpServer({ name: "fake", version: "1.0.0" });
  s.registerTool("echo", { description: "Echo the text back", inputSchema: { text: z.string().describe("What to echo") } }, async ({ text }) => ({
    content: [{ type: "text", text: `echo: ${text}` }],
  }));
  s.registerTool("image", { description: "A tiny image" }, async () => ({
    content: [{ type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" }],
  }));
  s.registerTool("big", { description: "A very large text" }, async () => ({ content: [{ type: "text", text: "x".repeat(MAX_RESULT_TEXT + 5000) }] }));
  s.registerTool("fail", { description: "Always fails" }, async () => ({ content: [{ type: "text", text: "boom" }], isError: true }));
  s.registerTool("weird.name", { description: "Odd name" }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  return s;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

const json = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(data));
};

/** Per-identity tests: a server whose `who` tool answers with the credential the call came with (which account). */
function whoServer(credential: string): McpServer {
  const s = new McpServer({ name: "who", version: "1.0.0" });
  s.registerTool("who", { description: "Which credential called", inputSchema: { note: z.string().optional() } }, async ({ note }) => ({
    content: [{ type: "text", text: `${credential}${note ? ` ${note}` : ""}` }],
  }));
  s.registerTool("send", { description: "Send something", inputSchema: { to: z.string(), account: z.string().optional().describe("the app's own account parameter") } }, async ({ to, account }) => ({
    content: [{ type: "text", text: `sent to ${to} by ${credential}${account ? ` (app account ${account})` : ""}` }],
  }));
  return s;
}

/** Bearer tokens /who-mcp takes (one per account in the per-identity tests). */
const WHO_TOKENS = new Set(["tok-nina-site", "tok-nina-personal", "tok-luca", "tok-org", "tok-legacy-nina"]);

async function serveMcp(req: IncomingMessage, res: ServerResponse, raw: string, make: () => McpServer = mcpServer): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const s = make();
  res.on("close", () => { void transport.close(); void s.close(); });
  await s.connect(transport);
  await transport.handleRequest(req as any, res, raw ? JSON.parse(raw) : undefined);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", base);
  const raw = req.method === "POST" ? await body(req) : "";
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /i, "");
  if (fake.oauthFailure?.path === url.pathname) {
    const { status, body } = fake.oauthFailure;
    if (typeof body !== "string") return json(res, status, body);
    res.writeHead(status, { "content-type": "text/plain" });
    return void res.end(body);
  }
  if (url.pathname === "/mcp") return serveMcp(req, res, raw);
  if (url.pathname === "/who-mcp") {
    if (!WHO_TOKENS.has(bearer)) return json(res, 401, { error: "unauthorized" });
    return serveMcp(req, res, raw, () => whoServer(bearer));
  }
  if (url.pathname === "/who-oauth-mcp") {
    if (!fake.access.has(bearer)) {
      return json(res, 401, { error: "invalid_token" }, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/who-oauth-mcp"` });
    }
    return serveMcp(req, res, raw, () => whoServer(bearer));
  }
  if (url.pathname === "/.well-known/oauth-protected-resource/who-oauth-mcp") {
    return json(res, 200, { resource: `${base}/who-oauth-mcp`, authorization_servers: [base], scopes_supported: ["read"] });
  }
  if (url.pathname === "/bearer-mcp") {
    if (bearer !== BEARER) return json(res, 401, { error: "unauthorized" });
    return serveMcp(req, res, raw);
  }
  if (url.pathname === "/oauth-mcp") {
    if (!fake.access.has(bearer)) {
      return json(res, 401, { error: "invalid_token" }, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/oauth-mcp"` });
    }
    return serveMcp(req, res, raw);
  }
  if (url.pathname === "/.well-known/oauth-protected-resource/oauth-mcp") {
    return json(res, 200, { resource: `${base}/oauth-mcp`, authorization_servers: [base], scopes_supported: ["read", "write"] });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json(res, 200, {
      issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      ...(fake.cimd ? { client_id_metadata_document_supported: true } : {}),
    });
  }
  if (url.pathname === "/register") {
    const meta = JSON.parse(raw) as { redirect_uris: string[] };
    const client_id = `client-${++fake.n}`;
    fake.clients.set(client_id, { redirect_uris: meta.redirect_uris });
    return json(res, 201, { ...meta, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) });
  }
  if (url.pathname === "/authorize") {
    const p = url.searchParams;
    fake.lastAuthorize = p;
    const client = fake.clients.get(p.get("client_id") ?? "");
    if (!client || !client.redirect_uris.includes(p.get("redirect_uri") ?? "")) return json(res, 400, { error: "invalid_request" });
    const code = `code-${++fake.n}`;
    fake.codes.set(code, { challenge: p.get("code_challenge") ?? "", redirectUri: p.get("redirect_uri")!, clientId: p.get("client_id")! });
    const back = new URL(p.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", p.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    return void res.end();
  }
  if (url.pathname === "/token") {
    const form = new URLSearchParams(raw);
    const issue = () => {
      const access_token = `at-${++fake.n}`;
      const refresh_token = `rt-${++fake.n}`;
      fake.access.add(access_token);
      fake.refresh.add(refresh_token);
      const id_token = fake.idTokenEmail
        ? `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "1", email: fake.idTokenEmail })).toString("base64url")}.`
        : undefined;
      return json(res, 200, { access_token, refresh_token, token_type: "Bearer", expires_in: 3600, ...(id_token ? { id_token } : {}) });
    };
    if (form.get("grant_type") === "authorization_code") {
      const entry = fake.codes.get(form.get("code") ?? "");
      fake.codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (!entry || createHash("sha256").update(verifier).digest("base64url") !== entry.challenge || entry.redirectUri !== form.get("redirect_uri")) {
        return json(res, 400, { error: "invalid_grant" });
      }
      return issue();
    }
    if (form.get("grant_type") === "refresh_token") {
      const rt = form.get("refresh_token") ?? "";
      if (!fake.refresh.has(rt)) return json(res, 400, { error: "invalid_grant" });
      fake.refresh.delete(rt);
      return issue();
    }
    return json(res, 400, { error: "unsupported_grant_type" });
  }
  if (url.pathname === "/revoke") {
    const token = new URLSearchParams(raw).get("token") ?? "";
    fake.revoked.push(token);
    fake.access.delete(token);
    fake.refresh.delete(token);
    res.writeHead(200);
    return void res.end();
  }
  json(res, 404, { error: "not found" });
}

const previousKey = process.env.POLPO_VAULT_KEY;
const dirs: string[] = [];
const managers: ConnectorManager[] = [];
const allowLocal = () => ({ connectors: { allowPrivateNetwork: true } }) as any;
const nativeRequest = globalThis.Request;
const nativeResponse = globalThis.Response;

beforeAll(async () => {
  process.env.POLPO_VAULT_KEY = randomBytes(32).toString("hex");
  // Reproduce the dashboard server's fetch/Response mismatch.
  getRequestListener(new Hono().fetch);
  server = createServer((req, res) => { handle(req, res).catch((err) => json(res, 500, { error: String(err) })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  globalThis.Request = nativeRequest;
  globalThis.Response = nativeResponse;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousKey === undefined) delete process.env.POLPO_VAULT_KEY;
  else process.env.POLPO_VAULT_KEY = previousKey;
});

afterEach(async () => {
  fake.oauthFailure = undefined;
  fake.idTokenEmail = undefined;
  await Promise.all(managers.splice(0).map((m) => m.closeAll()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function setup() {
  const polpoDir = mkdtempSync(join(tmpdir(), "polpo-connectors-"));
  dirs.push(polpoDir);
  const vault = new EncryptedVaultStore(polpoDir);
  const events: Array<{ id: string; status: string; action?: string }> = [];
  const manager = new ConnectorManager({ polpoDir, vaultStore: vault, settings: allowLocal, emit: (e) => events.push(e), log: () => undefined });
  managers.push(manager);
  return { polpoDir, vault, manager, events };
}

async function add(manager: ConnectorManager, input: Parameters<typeof buildConnector>[0]) {
  const { connector, secrets } = await buildConnector(input, { allowStdio: true, existingIds: manager.store.list().map((c) => c.id), allowPrivateNetwork: true });
  manager.store.create(connector);
  if (Object.keys(secrets).length) await manager.secrets.patch(connector.id, secrets);
  return connector;
}

function routesApp(manager: ConnectorManager) {
  const app = new Hono();
  app.get(CONNECTOR_OAUTH_CALLBACK_PATH, connectorOAuthCallback({ manager: () => manager, uiUrl: () => "https://polpo.example.com" }));
  app.route("/api/v1/connectors", connectorRoutes({
    manager: () => manager,
    settings: allowLocal,
    redirectUri: () => `http://127.0.0.1:3890${CONNECTOR_OAUTH_CALLBACK_PATH}`,
  }));
  return app;
}

/** The connector routes with the workspace's agents and the signed-in person ("me"). */
function routesAppWith(manager: ConnectorManager, opts: { agentNames?: string[]; member?: string }) {
  const app = new Hono();
  app.get(CONNECTOR_OAUTH_CALLBACK_PATH, connectorOAuthCallback({ manager: () => manager, uiUrl: () => "https://polpo.example.com" }));
  app.route("/api/v1/connectors", connectorRoutes({
    manager: () => manager,
    settings: allowLocal,
    redirectUri: () => `http://127.0.0.1:3890${CONNECTOR_OAUTH_CALLBACK_PATH}`,
    ...(opts.agentNames ? { agentNames: () => opts.agentNames! } : {}),
    ...(opts.member ? { member: () => opts.member } : {}),
  }));
  return app;
}

/** Polpo's MCP connector tools, calling this app's API in process. */
function mcpToolsOver(app: Hono) {
  const handlers = new Map<string, (args: Record<string, unknown>, extra: unknown) => Promise<any>>();
  const deps: McpDeps = {
    version: "t", publicUrl: "https://polpo.example.com",
    api: async (method, path, body) => {
      const r = await app.request(path, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: await r.json().catch(() => undefined), headers: r.headers };
    },
  };
  const tool = ((_set: string, name: string, _spec: unknown, handler: (args: Record<string, unknown>, extra: unknown) => Promise<any>) => { handlers.set(name, handler); }) as unknown as Register;
  registerConnectorTools(tool, deps);
  return { tools: [...handlers.keys()], call: (name: string, args: Record<string, unknown>) => handlers.get(name)!(args, {}) };
}

// ── unit pieces ──

describe("tool names, results and allowedTools", () => {
  it("prefixes, sanitizes and bounds tool names", () => {
    expect(mcpToolName("linear", "create_issue")).toBe("mcp__linear__create_issue");
    expect(mcpToolName("fake", "weird.name/with spaces")).toBe("mcp__fake__weird_name_with_spaces");
    const long = mcpToolName("connector", "a".repeat(100));
    expect(long.length).toBe(64);
    expect(long).toMatch(/^mcp__connector__a+_[0-9a-f]{8}$/);
    expect(mcpToolName("connector", "a".repeat(100) + "b")).not.toBe(long);
  });

  it("matches allowedTools patterns: none, exact, connector wildcard, all MCP", () => {
    expect(connectorToolAllowed(undefined, "mcp__linear__x")).toBe(true);
    expect(connectorToolAllowed(["read", "bash"], "mcp__linear__x")).toBe(false);
    expect(connectorToolAllowed(["mcp__*"], "mcp__linear__x")).toBe(true);
    expect(connectorToolAllowed(["mcp__linear__*"], "mcp__linear__x")).toBe(true);
    expect(connectorToolAllowed(["mcp__linear__*"], "mcp__notion__x")).toBe(false);
    expect(connectorToolAllowed(["mcp__linear__x"], "mcp__linear__x")).toBe(true);
    expect(connectorToolAllowed(["mcp__linear__x"], "mcp__linear__y")).toBe(false);
  });

  it("converts results: text, images, resources, links, structuredContent, errors, size cap", () => {
    const r = convertToolResult({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "inside" } },
        { type: "resource_link", uri: "https://x.example/doc", name: "Doc" },
      ],
      structuredContent: { total: 3 },
    }, "Fake: t");
    expect(r.isError).toBe(false);
    expect(r.content[0]).toEqual({ type: "text", text: "hello" });
    expect(r.content[1]).toEqual({ type: "image", data: "aGk=", mimeType: "image/png" });
    const text = toolResultText({ content: r.content, details: undefined });
    expect(text).toContain("inside");
    expect(text).toContain("https://x.example/doc");
    expect(text).toContain('structuredContent: {"total":3}');
    expect(text).toContain("[image image/png]");
    const err = convertToolResult({ content: [{ type: "text", text: "bad" }], isError: true }, "Fake: t");
    expect(err.isError).toBe(true);
    expect((err.content[0] as any).text).toContain("returned an error");
    const big = convertToolResult({ content: [{ type: "text", text: "y".repeat(MAX_RESULT_TEXT * 2) }] }, "x");
    expect((big.content[0] as any).text.length).toBeLessThan(MAX_RESULT_TEXT + 200);
    expect((big.content[0] as any).text).toContain("[truncated:");
  });
});

describe("URL safety", () => {
  const publicDns = async () => ["160.79.104.10"];
  it("rejects http (except localhost when allowed), private addresses and credentials in URLs", async () => {
    await expect(checkConnectorUrl("http://example.com/mcp", { resolve: publicDns })).rejects.toThrow(/https/);
    await expect(checkConnectorUrl("http://127.0.0.1:9/mcp", {})).rejects.toThrow(/https/);
    await expect(checkConnectorUrl("http://127.0.0.1:9/mcp", { allowPrivateNetwork: true })).resolves.toBeInstanceOf(URL);
    await expect(checkConnectorUrl("https://10.1.2.3/mcp", {})).rejects.toThrow(/private/);
    await expect(checkConnectorUrl("https://internal.example/mcp", { resolve: async () => ["100.100.1.2"] })).rejects.toThrow(/private/);
    await expect(checkConnectorUrl("https://localhost/mcp", { resolve: publicDns })).rejects.toThrow(/private/);
    await expect(checkConnectorUrl("https://user:pw@mcp.example.com/mcp", { resolve: publicDns })).rejects.toThrow(/credentials/);
    await expect(checkConnectorUrl("https://mcp.example.com/mcp", { resolve: publicDns })).resolves.toBeInstanceOf(URL);
  });

  it("refuses private URLs and stdio when creating a connector unless allowed", async () => {
    await expect(buildConnector({ name: "x", url: "https://192.168.1.10/mcp" }, { allowStdio: false, existingIds: [] })).rejects.toThrow(ConnectorInputError);
    await expect(buildConnector({ name: "x", transport: { type: "stdio", command: "node" } }, { allowStdio: false, existingIds: [] })).rejects.toThrow(/admin/);
    const { connector } = await buildConnector({ name: "Local", transport: { type: "stdio", command: "node", env: { TOKEN: "${vault:TOKEN}" } } }, { allowStdio: true, existingIds: [] });
    expect(connector.transport).toMatchObject({ type: "stdio", command: "node" });
  });

  it("builds Google catalog connectors with the shared OAuth app, offline access and fixed scopes", async () => {
    const { connector } = await buildConnector({ catalogId: "gmail" }, { allowStdio: false, existingIds: [], resolve: async () => ["142.250.1.1"] });
    expect(connector).toMatchObject({ id: "gmail", auth: { type: "oauth", oauth: { app: "google", authorizationServer: "https://accounts.google.com", extraAuthParams: { access_type: "offline", prompt: "consent" } } }, status: "needs_auth" });
    expect(connector.auth.oauth?.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(connector.icon?.simpleIcons).toBeTruthy();
    expect(CONNECTOR_CATALOG.filter((e) => e.category === "Google Workspace").length).toBe(9);
  });
});

// ── against the fake server ──

describe("connection manager", () => {
  it("lists and calls tools, converts results, enforces the tool policy and caps sizes", async () => {
    const { manager, events } = setup();
    await add(manager, { id: "fake", name: "Fake", url: `${base}/mcp`, access: { agents: "*", polpo: true }, toolPolicy: { image: "off" } });
    const tools = await manager.listTools("fake");
    expect(tools.map((t) => t.name).sort()).toEqual(["big", "echo", "fail", "image", "weird.name"]);
    expect(manager.store.get("fake")).toMatchObject({ status: "connected", toolCount: 5 });
    expect(events.some((e) => e.id === "fake" && e.status === "connected")).toBe(true);

    const { tools: agentTools } = await manager.toolsFor("alice");
    const names = agentTools.map((t) => t.name);
    expect(names).toContain("mcp__fake__echo");
    expect(names).not.toContain("mcp__fake__image"); // policy "off"
    const echo = agentTools.find((t) => t.name === "mcp__fake__echo")!;
    expect((echo.parameters as any).properties.text).toMatchObject({ type: "string", description: "What to echo" });
    const result = await echo.execute("1", { text: "hi" });
    expect(result.content[0]).toEqual({ type: "text", text: "echo: hi" });

    const fail = await agentTools.find((t) => t.name === "mcp__fake__fail")!.execute("2", {});
    expect(fail.isError).toBe(true);
    const big = await agentTools.find((t) => t.name === "mcp__fake__big")!.execute("3", {});
    expect((big.content[0] as any).text).toContain("[truncated:");
    await expect(manager.callTool("fake", "image", {})).rejects.toThrow(/turned off/);
  });

  it("gives each agent (and Polpo) only the connectors granted to it, filtered by allowedTools", async () => {
    const { manager } = setup();
    await add(manager, { id: "only-alice", name: "A", url: `${base}/mcp`, access: { agents: ["alice"], polpo: false } });
    await add(manager, { id: "everyone", name: "B", url: `${base}/mcp`, access: { agents: "*", polpo: false } });
    await add(manager, { id: "polpo-only", name: "C", url: `${base}/mcp`, access: { agents: [], polpo: true } });
    await add(manager, { id: "off", name: "D", url: `${base}/mcp`, access: { agents: "*", polpo: true }, enabled: false });
    const prefixes = (tools: { name: string }[]) => [...new Set(tools.map((t) => t.name.split("__")[1]))].sort();
    expect(prefixes((await manager.toolsFor("alice")).tools)).toEqual(["everyone", "only-alice"]);
    expect(prefixes((await manager.toolsFor("bob")).tools)).toEqual(["everyone"]);
    expect(prefixes((await manager.toolsFor(undefined)).tools)).toEqual(["polpo-only"]);
    expect(prefixes((await manager.toolsFor("alice", ["read", "mcp__only-alice__*"])).tools)).toEqual(["only-alice"]);
    expect((await manager.toolsFor("alice", ["mcp__everyone__echo"])).tools.map((t) => t.name)).toEqual(["mcp__everyone__echo"]);
    expect((await manager.toolsFor("alice", ["mcp__*"])).tools.length).toBe(10);
    expect((await manager.toolsFor("alice", ["read", "bash"])).tools).toEqual([]);
  });

  it("intersects connector access, toolPolicy, the agent's connectorTools selection and allowedTools", async () => {
    const { manager } = setup();
    await add(manager, { id: "lin", name: "Lin", url: `${base}/mcp`, access: { agents: "*", polpo: true }, toolPolicy: { image: "off" } });
    await add(manager, { id: "other", name: "Other", url: `${base}/mcp`, access: { agents: ["alice"], polpo: false } });
    const names = async (agent: string | undefined, allowed?: string[], selection?: Record<string, "*" | string[]>) =>
      (await manager.toolsFor(agent, allowed, selection)).tools.map((t) => t.name).sort();
    // no selection / "*": every tool the policy allows (today's behaviour)
    expect((await names("alice")).filter((n) => n.startsWith("mcp__lin__"))).toEqual(["mcp__lin__big", "mcp__lin__echo", "mcp__lin__fail", "mcp__lin__weird_name"]);
    expect(await names("alice", undefined, { lin: "*" })).toEqual(await names("alice"));
    // a list: only those tools of that connector; other connectors untouched; unknown names ignored
    expect(await names("alice", undefined, { lin: ["echo", "gone-tool"] })).toEqual([
      "mcp__lin__echo", "mcp__other__big", "mcp__other__echo", "mcp__other__fail", "mcp__other__image", "mcp__other__weird_name",
    ]);
    // an empty list: none of that connector's tools
    expect((await names("alice", undefined, { lin: [], other: ["fail"] }))).toEqual(["mcp__other__fail"]);
    // toolPolicy "off" wins over a selection
    expect(await names("bob", undefined, { lin: ["image", "echo"] })).toEqual(["mcp__lin__echo"]);
    // allowedTools still applies on top
    expect(await names("alice", ["mcp__lin__*"], { lin: ["echo", "big"] })).toEqual(["mcp__lin__big", "mcp__lin__echo"]);
    expect(await names("alice", ["mcp__lin__fail"], { lin: ["echo"] })).toEqual([]);
    // a selection never grants: bob has no access to "other"
    expect(await names("bob", undefined, { other: ["echo"] })).toEqual(["mcp__lin__big", "mcp__lin__echo", "mcp__lin__fail", "mcp__lin__weird_name"]);
    // Polpo has no agent selection
    expect((await names(undefined, undefined, { lin: ["echo"] })).length).toBe(4);
  });

  it("progressive tools_search / tools_load only see the agent's selected connector tools", async () => {
    const { manager } = setup();
    await add(manager, { id: "lin", name: "Lin", url: `${base}/mcp`, access: { agents: "*", polpo: false } });
    const { tools } = await manager.toolsFor("alice", undefined, { lin: ["echo"] });
    const set = new ProgressiveToolSet({ tools, mode: "always", connectorNames: { lin: "Lin" } });
    expect(set.search("lin").map((h) => h.name)).toEqual(["mcp__lin__echo"]);
    expect(set.search("very large text").map((h) => h.name)).not.toContain("mcp__lin__big");
    expect(set.load(["mcp__lin__big", "mcp__lin"])).toEqual({ loaded: ["mcp__lin__echo"], already: [], unknown: ["mcp__lin__big"] });
  });

  it("a task's tool scope narrows the run's tools: Polpo's engine, progressive discovery and harness host tools", async () => {
    const { manager, polpoDir } = setup();
    await add(manager, { id: "lin", name: "Lin", url: `${base}/mcp`, access: { agents: "*", polpo: false } });
    await add(manager, { id: "other", name: "Other", url: `${base}/mcp`, access: { agents: ["alice"], polpo: false } });
    writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({ project: "t", team: { name: "t", agents: [{ name: "alice" }] }, settings: { connectors: { allowPrivateNetwork: true } } }));
    const agent = { name: "alice" } as AgentConfig;
    const run = async (toolScope?: TaskToolScope) => {
      const task = { id: "t2", title: "T", description: "d", assignTo: "alice", dependsOn: ["t1"], status: "pending", expectations: [], metrics: [], retries: 0, maxRetries: 1, createdAt: "", updatedAt: "", ...(toolScope ? { toolScope } : {}) } as Task;
      const agentConfig = scopedAgentForRun({ agent, task, polpoDir });
      const toolset = await buildAgentToolset({ agentConfig, cwd: polpoDir, ctx: { polpoDir }, sandboxProvider: "local", browserProfileDir: join(polpoDir, "bp"), hasExtendedTools: false, task });
      await toolset.connectorManager?.closeAll();
      return { names: toolset.tools.map((t) => t.name), tools: toolset.tools, note: toolset.connectorNote };
    };
    // no scope: everything the agent has (unchanged behaviour)
    const all = await run();
    expect(all.names.filter((n) => n.startsWith("mcp__")).length).toBe(10);
    expect(all.names).toEqual(expect.arrayContaining(["read", "bash", "write", "task_result", "register_outcome"]));
    // scoped: one connector, one tool of it, one built-in tool
    const scoped = await run({ connectors: ["lin"], connectorTools: { lin: ["echo"] }, allowedTools: ["read"] });
    expect(scoped.names.filter((n) => n.startsWith("mcp__"))).toEqual(["mcp__lin__echo"]);
    expect(scoped.names).toContain("read");
    expect(scoped.names).not.toContain("bash");
    expect(scoped.names).not.toContain("write");
    // the dependency results and outcome tools are not affected
    expect(scoped.names).toEqual(expect.arrayContaining(["task_result", "dependency_results", "register_outcome"]));
    // the prompt's Connectors section leaves out the connector the scope excludes
    expect(scoped.note).toContain("mcp__lin__*");
    expect(scoped.note).not.toContain("mcp__other__*");
    // progressive tools_search / tools_load see only the scoped set
    const set = new ProgressiveToolSet({ tools: scoped.tools, mode: "always", connectorNames: { lin: "Lin", other: "Other" } });
    expect(set.search("echo").map((h) => h.name)).toEqual(["mcp__lin__echo"]);
    expect(set.load(["mcp__other__echo", "mcp__lin__big"]).unknown).toEqual(["mcp__other__echo", "mcp__lin__big"]);
    // harness host tools (Claude Code, Codex) get the same set
    const host = toHarnessHostTools(scoped.tools).map((t) => t.name);
    expect(host.filter((n) => n.startsWith("mcp__"))).toEqual(["mcp__lin__echo"]);
    expect(host).toContain("task_result");
    // "none": no connector tool at all
    expect((await run({ connectors: "none" })).names.some((n) => n.startsWith("mcp__"))).toBe(false);
  });

  it("skips a connector that cannot connect, with a note, without failing", async () => {
    const { manager } = setup();
    await add(manager, { id: "good", name: "Good", url: `${base}/mcp`, access: { agents: "*", polpo: false } });
    await add(manager, { id: "dead", name: "Dead", url: "http://127.0.0.1:1/mcp", access: { agents: "*", polpo: false } });
    const { tools, notes } = await manager.toolsFor("alice");
    expect(tools.some((t) => t.name.startsWith("mcp__good__"))).toBe(true);
    expect(notes.join("\n")).toMatch(/Dead \(dead\) is unavailable/);
    expect(manager.store.get("dead")?.status).toBe("error");
  });

  it("bearer auth: the token from the vault, never in the config file", async () => {
    const { manager, polpoDir, vault } = setup();
    await add(manager, { id: "gh", name: "Bearer", url: `${base}/bearer-mcp`, auth: { type: "bearer" }, secrets: { bearerToken: BEARER }, access: { agents: "*", polpo: false } });
    expect(readFileSync(join(polpoDir, "connectors.json"), "utf-8")).not.toContain(BEARER);
    expect((await vault.get(CONNECTORS_VAULT_OWNER, "gh"))?.credentials.bearer_token).toBe(BEARER);
    expect((await manager.test("gh")).ok).toBe(true);
    await manager.secrets.patch("gh", { bearer_token: "wrong" });
    await manager.close("gh");
    const failed = await manager.test("gh");
    expect(failed.ok).toBe(false);
    expect(manager.store.get("gh")?.status).toBe("error");
  });
});

describe("OAuth connectors through the API", () => {
  it.each([
    [{ error: "invalid_client_metadata", error_description: "Client approval is required" }, "invalid_client_metadata: Client approval is required"],
    ["Client approval is required", "HTTP 403: Client approval is required"],
  ])("reports refused dynamic registration (%j)", async (body, detail) => {
    const { manager } = setup();
    const app = routesApp(manager);
    await add(manager, { id: "restricted", name: "Restricted", url: `${base}/oauth-mcp`, auth: { type: "oauth" } });
    fake.oauthFailure = { path: "/register", status: 403, body };

    const res = await app.request("/api/v1/connectors/restricted/oauth/start", { method: "POST" });
    const failure = await res.json();
    expect(failure.error).toContain(detail);
    expect(failure.error).toContain("OAuth apps");
    expect(failure.error).not.toContain("[object Response]");
    expect(failure.oauthApp).toBe("restricted");
    expect(res.status).toBe(409);
    expect(await (await app.request("/api/v1/connectors/restricted")).json()).toMatchObject({
      data: { status: "error", lastError: failure.error },
    });
  });

  it.each([403, 503])("reports exhausted OAuth discovery after HTTP %d", async (status) => {
    const { manager } = setup();
    const app = routesApp(manager);
    await add(manager, { id: "discovery", name: "Discovery", url: `${base}/oauth-mcp`, auth: { type: "oauth" } });
    fake.oauthFailure = {
      path: "/.well-known/oauth-authorization-server", status,
      body: { error: "access_denied", error_description: "Metadata is unavailable" },
    };

    const res = await app.request("/api/v1/connectors/discovery/oauth/start", { method: "POST" });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toContain("OAuth discovery metadata (access_denied: Metadata is unavailable)");
    expect(await (await app.request("/api/v1/connectors/discovery")).json()).toMatchObject({
      data: { status: "error", lastError: error },
    });
  });

  it.each([
    [{ error: "invalid_grant", error_description: "The code expired" }, "invalid_grant: The code expired"],
    ["The token endpoint refused this request", "HTTP 400: The token endpoint refused this request"],
  ])("reports token exchange failures (%j)", async (body, detail) => {
    const { manager } = setup();
    const app = routesApp(manager);
    await add(manager, { id: "exchange", name: "Exchange", url: `${base}/oauth-mcp`, auth: { type: "oauth" } });
    const start = await (await app.request("/api/v1/connectors/exchange/oauth/start", { method: "POST" })).json();
    const back = new URL((await fetch(start.data.authorizationUrl, { redirect: "manual" })).headers.get("location")!);
    fake.oauthFailure = { path: "/token", status: 400, body };

    const res = await app.request(back.pathname + back.search);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain(detail);
    expect(html).not.toContain("[object Response]");
    expect(await (await app.request("/api/v1/connectors/exchange")).json()).toMatchObject({
      data: { status: "error", lastError: expect.stringContaining(detail), secrets: { oauth: { pending: false, authorized: false } } },
    });
  });

  it("keeps the refresh failure reason when a tool call triggers OAuth", async () => {
    const { manager } = setup();
    const app = routesApp(manager);
    await add(manager, { id: "refresh", name: "Refresh", url: `${base}/oauth-mcp`, auth: { type: "oauth" } });
    const start = await (await app.request("/api/v1/connectors/refresh/oauth/start", { method: "POST" })).json();
    const back = new URL((await fetch(start.data.authorizationUrl, { redirect: "manual" })).headers.get("location")!);
    expect((await app.request(back.pathname + back.search)).status).toBe(200);
    const tokens = JSON.parse((await manager.secrets.get("refresh")).oauth_tokens!);
    fake.access.delete(tokens.access_token);
    fake.oauthFailure = { path: "/token", status: 403, body: "Refresh requests are blocked" };

    await expect(manager.callTool("refresh", "echo", { text: "test" })).rejects.toThrow("HTTP 403: Refresh requests are blocked");
    expect(await (await app.request("/api/v1/connectors/refresh")).json()).toMatchObject({
      data: { status: "needs_reauth", lastError: expect.stringContaining("HTTP 403: Refresh requests are blocked") },
    });
    const reconnect = await (await app.request("/api/v1/connectors/refresh/oauth/start", { method: "POST" })).json();
    expect(reconnect).toMatchObject({ ok: true, data: { authorizationUrl: expect.stringContaining("/authorize?") } });
    expect(manager.store.get("refresh")?.lastError).toBeUndefined();
  });

  it("uses Figma's shared OAuth app and skips dynamic registration", async () => {
    const { manager } = setup();
    const app = routesApp(manager);
    await add(manager, { catalogId: "figma", url: `${base}/oauth-mcp` });
    fake.oauthFailure = { path: "/register", status: 403, body: "Client approval is required" };
    const start = () => app.request("/api/v1/connectors/figma/oauth/start", { method: "POST" });
    expect(await (await start()).json()).toMatchObject({ ok: false, error: expect.stringContaining('Set up the "figma" OAuth app') });

    const saved = await app.request("/api/v1/connectors/oauth-apps/figma", {
      method: "PUT", body: JSON.stringify({ clientId: "approved-app", clientSecret: "private-app-secret" }),
    });
    expect(saved.status).toBe(200);
    const body = await (await start()).json();
    expect(body.ok).toBe(true);
    expect(new URL(body.data.authorizationUrl).searchParams.get("client_id")).toBe("approved-app");
    expect(JSON.stringify(body)).not.toContain("private-app-secret");
    expect(manager.store.get("figma")?.lastError).toBeUndefined();
  });

  it("start → authorize → callback stores tokens in the vault → tool calls → refresh on 401 → needs_reauth", async () => {
    const { manager, vault, polpoDir, events } = setup();
    const app = routesApp(manager);
    const created = await app.request("/api/v1/connectors", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "linearish", name: "Linearish", url: `${base}/oauth-mcp`, auth: { type: "oauth", oauth: { extraAuthParams: { prompt: "consent" } } }, access: { agents: ["alice"], polpo: true } }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).data).toMatchObject({ id: "linearish", status: "needs_auth", secrets: { oauth: { authorized: false } } });

    const start = await (await app.request("/api/v1/connectors/linearish/oauth/start", { method: "POST" })).json();
    const authorizationUrl = new URL(start.data.authorizationUrl);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${base}/authorize`);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:3890${CONNECTOR_OAUTH_CALLBACK_PATH}`);
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
    expect(authorizationUrl.searchParams.get("resource")).toBe(`${base}/oauth-mcp`);
    const state = authorizationUrl.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(20);

    // the browser: the fake authorization server consents and redirects back with a code
    const redirect = await fetch(authorizationUrl, { redirect: "manual" });
    const back = new URL(redirect.headers.get("location")!);
    expect(back.searchParams.get("state")).toBe(state);
    const callback = await app.request(`${CONNECTOR_OAUTH_CALLBACK_PATH}${back.search}`);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Linearish connected");

    // single use: the same callback again is refused
    const again = await app.request(`${CONNECTOR_OAUTH_CALLBACK_PATH}${back.search}`);
    expect(again.status).toBe(400);

    const stored = await vault.get(CONNECTORS_VAULT_OWNER, "linearish");
    const tokens = JSON.parse(stored!.credentials.oauth_tokens!);
    expect(tokens.access_token).toMatch(/^at-/);
    expect(stored!.credentials.oauth_state).toBeUndefined();
    expect(stored!.credentials.oauth_code_verifier).toBeUndefined();
    expect(manager.store.get("linearish")).toMatchObject({ status: "connected", toolCount: 5 });
    expect(events.some((e) => e.id === "linearish" && e.status === "connected")).toBe(true);

    // nothing secret in the API or the config file
    const listed = await (await app.request("/api/v1/connectors")).text();
    const file = readFileSync(join(polpoDir, "connectors.json"), "utf-8");
    for (const secret of [tokens.access_token, tokens.refresh_token, JSON.parse(stored!.credentials.oauth_client_info!).client_id]) {
      expect(listed).not.toContain(secret);
      expect(file).not.toContain(secret);
    }
    expect(JSON.parse(listed).data.connectors[0].secrets.oauth).toMatchObject({ authorized: true, clientRegistered: true });

    // a tool call with the token
    const { tools } = await manager.toolsFor("alice");
    const echo = tools.find((t) => t.name === "mcp__linearish__echo")!;
    expect((await echo.execute("1", { text: "a" })).content[0]).toEqual({ type: "text", text: "echo: a" });

    // the access token expires: the SDK refreshes on 401 and the call goes through
    fake.access.clear();
    await manager.close("linearish");
    expect((await echo.execute("2", { text: "b" })).content[0]).toEqual({ type: "text", text: "echo: b" });
    const refreshed = JSON.parse((await vault.get(CONNECTORS_VAULT_OWNER, "linearish"))!.credentials.oauth_tokens!);
    expect(refreshed.access_token).not.toBe(tokens.access_token);

    // refresh revoked too: the connector needs re-authorization
    fake.access.clear();
    fake.refresh.clear();
    await manager.close("linearish");
    await expect(echo.execute("3", { text: "c" })).rejects.toThrow(/reconnect/i);
    expect(manager.store.get("linearish")?.status).toBe("needs_reauth");
  });

  it("disconnect revokes the tokens (best effort) and forgets them", async () => {
    const { manager, vault } = setup();
    const app = routesApp(manager);
    await add(manager, { id: "rev", name: "Rev", url: `${base}/oauth-mcp`, auth: { type: "oauth" } });
    const start = await (await app.request("/api/v1/connectors/rev/oauth/start", { method: "POST" })).json();
    const back = new URL((await fetch(new URL(start.data.authorizationUrl), { redirect: "manual" })).headers.get("location")!);
    expect((await app.request(`${CONNECTOR_OAUTH_CALLBACK_PATH}${back.search}`)).status).toBe(200);
    const tokens = JSON.parse((await vault.get(CONNECTORS_VAULT_OWNER, "rev"))!.credentials.oauth_tokens!);
    await app.request("/api/v1/connectors/rev/disconnect", { method: "POST" });
    expect(fake.revoked).toContain(tokens.refresh_token);
    expect(fake.access.has(tokens.access_token)).toBe(false);
    expect((await vault.get(CONNECTORS_VAULT_OWNER, "rev"))?.credentials.oauth_tokens).toBeUndefined();
    expect(manager.store.get("rev")?.status).toBe("needs_auth");
    await expect(manager.listTools("rev")).rejects.toThrow(/Not authorized/);
  });

  it("refuses expired and unknown states", async () => {
    const { manager } = setup();
    const app = routesApp(manager);
    await add(manager, { id: "exp", name: "Exp", url: `${base}/oauth-mcp`, auth: { type: "oauth" } });
    const start = await (await app.request("/api/v1/connectors/exp/oauth/start", { method: "POST" })).json();
    const url = new URL(start.data.authorizationUrl);
    const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
    await manager.secrets.patch("exp", { oauth_state_expires: String(Date.now() - 1000) });
    expect((await app.request(`${CONNECTOR_OAUTH_CALLBACK_PATH}${back.search}`)).status).toBe(400);
    expect((await app.request(`${CONNECTOR_OAUTH_CALLBACK_PATH}?code=x&state=nope`)).status).toBe(400);
    expect((await manager.secrets.get("exp")).oauth_tokens).toBeUndefined();
  });

  it("CRUD: secrets are write-only, catalog and OAuth apps, delete removes vault secrets", async () => {
    const { manager, vault } = setup();
    const app = routesApp(manager);
    const post = (path: string, data: unknown, method = "POST") => app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    const res = await post("/api/v1/connectors", { name: "Headers", url: `${base}/mcp`, auth: { type: "headers" }, secrets: { headers: { "X-Api-Key": "hdr-secret-1" } } });
    expect(res.status).toBe(201);
    const created = (await res.json()).data;
    expect(created).toMatchObject({ id: "headers", auth: { type: "headers", headerNames: ["X-Api-Key"] }, secrets: { headers: ["X-Api-Key"] } });
    expect(JSON.stringify(created)).not.toContain("hdr-secret-1");

    const patched = await (await post("/api/v1/connectors/headers", { access: { agents: ["alice"] }, toolPolicy: { fail: "off" }, secrets: { headers: { "X-Api-Key": "hdr-secret-2" } } }, "PATCH")).json();
    expect(patched.data.access).toEqual({ agents: ["alice"], polpo: true });
    expect(JSON.stringify(patched)).not.toContain("hdr-secret-2");
    expect((await vault.get(CONNECTORS_VAULT_OWNER, "headers"))?.credentials["header:X-Api-Key"]).toBe("hdr-secret-2");

    const tools = await (await app.request("/api/v1/connectors/headers/tools")).json();
    expect(tools.data.tools.find((t: any) => t.name === "fail").policy).toBe("off");

    const catalog = await (await app.request("/api/v1/connectors/catalog")).json();
    expect(catalog.data.redirectUri).toBe(`http://127.0.0.1:3890${CONNECTOR_OAUTH_CALLBACK_PATH}`);
    expect(catalog.data.entries.some((e: any) => e.id === "linear")).toBe(true);

    const appRes = await (await post("/api/v1/connectors/oauth-apps/google", { clientId: "goog-client", clientSecret: "goog-secret" }, "PUT")).json();
    expect(appRes.data).toMatchObject({ id: "google", clientId: "goog-client", hasSecret: true });
    expect(JSON.stringify(appRes)).not.toContain("goog-secret");


    expect((await app.request("/api/v1/connectors/headers", { method: "DELETE" })).status).toBe(200);
    expect(await vault.get(CONNECTORS_VAULT_OWNER, "headers")).toBeUndefined();
    expect(manager.store.get("headers")).toBeUndefined();
  });

  it("Google: start uses the shared OAuth app's client (no DCR) and the extra parameters", async () => {
    const { manager } = setup();
    // a Google-like connector against the fake server: pre-registered client, offline access
    await add(manager, {
      id: "gmailish", name: "Gmailish", url: `${base}/oauth-mcp`,
      auth: { type: "oauth", oauth: { app: "google", scopes: ["read"], extraAuthParams: { access_type: "offline", prompt: "consent" } } },
    });
    await expect(manager.startOAuth("gmailish", "http://127.0.0.1:3890/cb")).rejects.toThrow(/OAuth app first/);
    fake.clients.set("google-client", { redirect_uris: ["http://127.0.0.1:3890/cb"] });
    manager.store.upsertOAuthApp({ id: "google", clientId: "google-client" });
    await manager.secrets.setAppSecret("google", "google-secret");
    const before = fake.n;
    const { authorizationUrl } = await manager.startOAuth("gmailish", "http://127.0.0.1:3890/cb");
    const url = new URL(authorizationUrl!);
    expect(url.searchParams.get("client_id")).toBe("google-client");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe("read");
    expect(fake.n).toBe(before); // nothing registered
    expect((await manager.secrets.get("gmailish")).oauth_client_info).toBeUndefined();
  });
});

describe("Polpo's connector tools", () => {
  // Adding one is connector_add, the MCP server's tool run in process (polpo-mcp-bridge.ts; see mcp-primitives
  // and polpo-tools-alignment tests): it never takes a token in chat.
  it("lists, changes access, and removes only when confirmed", async () => {
    const { manager } = setup();
    const ctx = { manager, settings: allowLocal(), redirectUri: "http://127.0.0.1:3890/cb", agentNames: async () => ["alice", "bob"] };
    await add(manager, { url: `${base}/mcp`, name: "Fake", access: { agents: ["alice"] } });
    expect(await executeConnectorTool("connector_connect", { id: "fake" }, ctx)).toMatch(/Fake is connected: 5 tools/);
    expect(await executeConnectorTool("connectors_list", {}, ctx)).toMatch(/Fake \[fake\] connected, 5 tools; auth none; scope org; used by agents: alice \+ Polpo/);
    expect(await executeConnectorTool("connector_update_access", { id: "fake", addAgents: ["ghost"] }, ctx)).toMatch(/Unknown agents: ghost/);
    expect(await executeConnectorTool("connector_update_access", { id: "fake", addAgents: ["bob"], polpo: false }, ctx)).toMatch(/agents: alice, bob;/);
    expect(manager.store.get("fake")?.access).toEqual({ agents: ["alice", "bob"], polpo: false });
    expect(await executeConnectorTool("connector_remove", { id: "fake" }, ctx)).toMatch(/confirm/);
    expect(manager.store.get("fake")).toBeDefined();
    expect(await executeConnectorTool("connector_remove", { id: "fake", confirm: true }, ctx)).toBe("Removed Fake.");
    expect(manager.store.get("fake")).toBeUndefined();
    expect(await executeConnectorTool("connector_add", { url: `${base}/mcp` }, ctx)).toMatch(/Unknown tool/);
  });

  it("returns the OAuth link for an OAuth connector", async () => {
    const { manager } = setup();
    const ctx = { manager, settings: allowLocal(), redirectUri: "http://127.0.0.1:3890/cb", agentNames: async () => [] };
    await add(manager, { url: `${base}/oauth-mcp`, name: "OA", auth: { type: "oauth" } });
    const out = await executeConnectorTool("connector_connect", { id: "oa" }, ctx);
    expect(out).toMatch(/must open this link/);
    expect(out).toContain(`${base}/authorize?`);
  });
});

describe("connector scope: the organization's or one agent's own", () => {
  const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  function scopedApp(manager: ConnectorManager) {
    const app = new Hono();
    app.route("/api/v1/connectors", connectorRoutes({
      manager: () => manager, settings: allowLocal, agentNames: () => ["nina", "claudio", "bob"],
      redirectUri: () => `http://127.0.0.1:3890${CONNECTOR_OAUTH_CALLBACK_PATH}`,
    }));
    return app;
  }

  it("existing connectors (no scope field) are the organization's: nothing changes for them", async () => {
    const { polpoDir } = setup();
    // a connectors.json written before scopes existed
    writeFileSync(join(polpoDir, "connectors.json"), JSON.stringify({ connectors: [{
      id: "lin", name: "Lin", kind: "mcp", transport: { type: "http", url: `${base}/mcp` }, auth: { type: "none" },
      access: { agents: "*", polpo: true }, enabled: true, createdAt: "2026-01-01T00:00:00Z",
    }] }));
    const manager = new ConnectorManager({ polpoDir, vaultStore: new EncryptedVaultStore(polpoDir), settings: allowLocal, emit: () => undefined, log: () => undefined });
    managers.push(manager);
    const lin = manager.store.get("lin")!;
    expect(lin.scope).toBeUndefined();
    expect(connectorOwner(lin)).toBeUndefined();
    expect(connectorGrants(lin, "nina")).toBe(true);
    expect(connectorGrants(lin, "claudio")).toBe(true);
    expect(connectorVisibleTo(lin, "claudio")).toBe(true);
    // the API shows it without a scope (= org) and lets any agent be granted
    const app = scopedApp(manager);
    const res = await app.request("/api/v1/connectors/lin", json("PATCH", { access: { agents: ["nina", "claudio"] } }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.access.agents).toEqual(["nina", "claudio"]);
  });

  it("an agent's own connector: only the owner gets its tools, even if its access is edited in the store", async () => {
    const { manager } = setup();
    const app = scopedApp(manager);
    let res = await app.request("/api/v1/connectors", json("POST", { id: "mail-nina", name: "Mail Nina", url: `${base}/mcp`, scope: { kind: "agent", agent: "nina" } }));
    expect(res.status).toBe(201);
    const created = (await res.json()).data;
    expect(created.scope).toEqual({ kind: "agent", agent: "nina" });
    // default access: its owner only, not Polpo
    expect(created.access).toEqual({ agents: ["nina"], polpo: false });
    expect((await manager.toolsFor("nina")).tools.some((t) => t.name.startsWith("mcp__mail-nina__"))).toBe(true);
    expect((await manager.toolsFor("claudio")).tools.some((t) => t.name.startsWith("mcp__mail-nina__"))).toBe(false);

    // someone edits connectors.json by hand: still nobody but nina
    manager.store.update("mail-nina", { access: { agents: "*", polpo: false } });
    expect(connectorGrants(manager.store.get("mail-nina")!, "claudio")).toBe(false);
    expect((await manager.toolsFor("claudio")).tools.some((t) => t.name.startsWith("mcp__mail-nina__"))).toBe(false);
    expect((await manager.toolsFor("nina")).tools.some((t) => t.name.startsWith("mcp__mail-nina__"))).toBe(true);
    // a task tool scope cannot name it for another agent either (nor offer to grant it)
    const scope: TaskToolScope = { connectors: ["mail-nina"] };
    const problems = taskToolScopeGrantProblems(scope, { agent: { name: "claudio" }, connectors: manager.store.list() });
    expect(problems.join("\n")).toMatch(/belongs to agent "nina".*can never use it/);
    expect(taskToolScopeMissingGrants(scope, "claudio", manager.store.list())).toEqual([]);
    // progressive discovery only sees what toolsFor gave
    const set = new ProgressiveToolSet({ tools: (await manager.toolsFor("claudio")).tools, mode: "always", connectorNames: { "mail-nina": "Mail Nina" } });
    expect(set.search("echo").some((h) => h.name.startsWith("mcp__mail-nina__"))).toBe(false);
    // the prompt does not list it for claudio
    expect(connectorsPromptSection(manager.store.list(), "claudio")).not.toContain("mail-nina");
  });

  it("enabling an agent's own connector for another agent or every agent is refused (400)", async () => {
    const { manager } = setup();
    const app = scopedApp(manager);
    await app.request("/api/v1/connectors", json("POST", { id: "mail-nina", name: "Mail Nina", url: `${base}/mcp`, scope: { kind: "agent", agent: "nina" } }));
    for (const agents of [["nina", "claudio"], ["claudio"], "*"]) {
      const res = await app.request("/api/v1/connectors/mail-nina", json("PATCH", { access: { agents } }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/belongs to agent "nina"/);
    }
    expect(manager.store.get("mail-nina")?.access.agents).toEqual(["nina"]);
    // creating one already granted to others is refused too; so is an unknown owner
    expect((await app.request("/api/v1/connectors", json("POST", { name: "X", url: `${base}/mcp`, scope: { kind: "agent", agent: "nina" }, access: { agents: "*" } }))).status).toBe(400);
    expect((await app.request("/api/v1/connectors", json("POST", { name: "Y", url: `${base}/mcp`, scope: { kind: "agent", agent: "ghost" } }))).status).toBe(400);
    expect((await app.request("/api/v1/connectors", json("POST", { name: "Z", url: `${base}/mcp`, scope: { kind: "team" } }))).status).toBe(400);
    // the owner can be turned off and on; Polpo stays editable
    expect((await app.request("/api/v1/connectors/mail-nina", json("PATCH", { access: { agents: [] } }))).status).toBe(200);
    expect((await app.request("/api/v1/connectors/mail-nina", json("PATCH", { access: { agents: ["nina"], polpo: true } }))).status).toBe(200);
    expect(manager.store.get("mail-nina")?.access).toEqual({ agents: ["nina"], polpo: true });
    // Polpo's own chat tool goes through the same rule
    const ctx = { manager, settings: allowLocal(), redirectUri: "http://127.0.0.1:3890/cb", agentNames: async () => ["nina", "claudio"] };
    expect(await executeConnectorTool("connector_update_access", { id: "mail-nina", addAgents: ["claudio"] }, ctx)).toMatch(/Error: .*belongs to agent "nina"/);
    // and connectors_list for claudio never offers it
    const listed = await executeConnectorTool("connectors_list", { agent: "claudio" }, ctx);
    expect(listed).not.toContain("mail-nina");
  });

  it("changing scope: org → agent keeps only the owner and reports the others; agent → org keeps access", async () => {
    const { manager } = setup();
    const app = scopedApp(manager);
    await add(manager, { id: "mail", name: "Mail", url: `${base}/mcp`, access: { agents: ["nina", "claudio", "bob"], polpo: true } });
    let res = await app.request("/api/v1/connectors/mail", json("PATCH", { scope: { kind: "agent", agent: "nina" } }));
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.data.scope).toEqual({ kind: "agent", agent: "nina" });
    expect(body.data.access.agents).toEqual(["nina"]);
    expect(body.droppedAgents).toEqual(["claudio", "bob"]);
    // from "*": "*" is reported
    await add(manager, { id: "all", name: "All", url: `${base}/mcp`, access: { agents: "*", polpo: true } });
    body = await (await app.request("/api/v1/connectors/all", json("PATCH", { scope: { kind: "agent", agent: "bob" } }))).json();
    expect(body.data.access.agents).toEqual(["bob"]);
    expect(body.droppedAgents).toEqual(["*"]);
    // scope + access to others in one call: refused
    await add(manager, { id: "cal", name: "Cal", url: `${base}/mcp`, access: { agents: ["nina"], polpo: true } });
    expect((await app.request("/api/v1/connectors/cal", json("PATCH", { scope: { kind: "agent", agent: "nina" }, access: { agents: ["claudio"] } }))).status).toBe(400);
    // back to org: access as it was
    res = await app.request("/api/v1/connectors/mail", json("PATCH", { scope: { kind: "org" } }));
    body = await res.json();
    expect(body.data.scope).toBeUndefined();
    expect(body.data.access.agents).toEqual(["nina"]);
    expect(body.droppedAgents).toBeUndefined();
    // now any agent can be granted again
    expect((await app.request("/api/v1/connectors/mail", json("PATCH", { access: { agents: ["nina", "claudio"] } }))).status).toBe(200);
  });
});

describe("several accounts of the same app", () => {
  it("a catalog id added again gets gmail-2, gmail-3… and a name of its own", async () => {
    const ctx = { allowStdio: false, existingIds: ["gmail"], resolve: async () => ["142.250.1.1"] };
    const second = (await buildConnector({ catalogId: "gmail" }, ctx)).connector;
    expect(second).toMatchObject({ id: "gmail-2", name: "Gmail 2", catalogId: "gmail", status: "needs_auth" });
    const named = (await buildConnector({ catalogId: "gmail", name: "Gmail – info@acme.com" }, { ...ctx, existingIds: ["gmail", "gmail-2"] })).connector;
    expect(named).toMatchObject({ id: "gmail-3", name: "Gmail – info@acme.com", catalogId: "gmail" });
    // the first one keeps the catalog's id and name
    expect((await buildConnector({ catalogId: "gmail" }, { ...ctx, existingIds: [] })).connector).toMatchObject({ id: "gmail", name: "Gmail" });
  });

  it("names each account to the model: tool descriptions, connector names and the prompt section", async () => {
    const { manager } = setup();
    await add(manager, { id: "mail", name: "Mail", url: `${base}/mcp`, access: { agents: ["alice"], polpo: true } });
    await add(manager, { id: "mail-2", name: "Mail 2", url: `${base}/mcp`, access: { agents: ["alice"], polpo: false } });
    manager.store.update("mail", { catalogId: "mail" });
    manager.store.update("mail-2", { catalogId: "mail", account: "info@acme.com" });
    const { tools } = await manager.toolsFor("alice");
    expect(tools.find((t) => t.name === "mcp__mail__echo")!.description).toMatch(/^\[Mail\] Echo/);
    expect(tools.find((t) => t.name === "mcp__mail-2__echo")!.description).toMatch(/^\[Mail 2 – info@acme\.com\] Echo/);
    expect(tools.find((t) => t.name === "mcp__mail-2__echo")!.label).toBe("Mail 2 – info@acme.com: echo");
    const section = connectorsPromptSection(manager.store.list(), "alice");
    expect(section).toContain("- Mail 2 – info@acme.com (mcp__mail-2__*)");
    expect(section).toContain("2 accounts of the same app: mail = Mail; mail-2 = Mail 2 – info@acme.com");
    // Polpo has one of them only: no "accounts" line
    expect(connectorsPromptSection(manager.store.list(), undefined)).not.toContain("accounts of the same app");
    const ctx = { manager, settings: allowLocal(), agentNames: async () => ["alice"] };
    expect(await executeConnectorTool("connectors_list", {}, ctx)).toMatch(/- Mail 2 – info@acme\.com \[mail-2, another mail account\]/);
  });

  it("labels: the account joins the name unless the name already says it; id_token email", () => {
    expect(connectorLabel({ name: "Gmail 2", account: "info@acme.com" })).toBe("Gmail 2 – info@acme.com");
    expect(connectorLabel({ name: "Gmail – info@acme.com", account: "info@acme.com" })).toBe("Gmail – info@acme.com");
    expect(connectorLabel({ name: "Gmail" })).toBe("Gmail");
    const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
    expect(accountFromIdToken(jwt({ email: "a@b.co", preferred_username: "x" }))).toBe("a@b.co");
    expect(accountFromIdToken(jwt({ preferred_username: "marco" }))).toBe("marco");
    expect(accountFromIdToken(jwt({ sub: "1" }))).toBeUndefined();
    expect(accountFromIdToken("not-a-jwt")).toBeUndefined();
    expect(accountFromIdToken(undefined)).toBeUndefined();
  });

  it("learns the signed-in account from an OpenID id_token at sign-in, and forgets it on disconnect", async () => {
    const { manager } = setup();
    const app = routesApp(manager);
    fake.idTokenEmail = "info@acme.com";
    await add(manager, { id: "who", name: "Who", url: `${base}/oauth-mcp`, auth: { type: "oauth" } });
    const start = await (await app.request("/api/v1/connectors/who/oauth/start", { method: "POST" })).json();
    const redirect = await fetch(new URL(start.data.authorizationUrl), { redirect: "manual" });
    const back = new URL(redirect.headers.get("location")!);
    expect((await app.request(`${CONNECTOR_OAUTH_CALLBACK_PATH}${back.search}`)).status).toBe(200);
    expect(manager.store.get("who")).toMatchObject({ account: "info@acme.com", status: "connected" });
    expect((await (await app.request("/api/v1/connectors/who")).json()).data.account).toBe("info@acme.com");
    // renaming keeps it; the label then does not repeat it
    const renamed = await app.request("/api/v1/connectors/who", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Who – info@acme.com" }),
    });
    expect((await renamed.json()).data).toMatchObject({ name: "Who – info@acme.com", account: "info@acme.com" });
    expect(connectorLabel(manager.store.get("who")!)).toBe("Who – info@acme.com");
    await manager.disconnect("who");
    expect(manager.store.get("who")!.account).toBeUndefined();
  });
});

describe("catalog and Client ID Metadata Documents", () => {
  const publicDns = async () => ["160.79.104.10"];
  const ctx = { allowStdio: false, existingIds: [] as string[], resolve: publicDns };

  it("normalizes the published catalog: shared OAuth apps, Google scopes, variants, URL templates, header keys", async () => {
    const byId = (id: string) => CONNECTOR_CATALOG.find((e) => e.id === id)!;
    expect(CONNECTOR_CATALOG.length).toBeGreaterThan(100);
    expect(new Set(CONNECTOR_CATALOG.map((e) => e.id)).size).toBe(CONNECTOR_CATALOG.length);
    expect(byId("bigquery").oauth).toMatchObject({ app: "google", scopes: ["https://www.googleapis.com/auth/bigquery"] });
    expect(byId("slack").oauth).toEqual({ app: "slack" });
    expect(byId("slack").setup).toContain('"slack" OAuth app');
    // Slack: the MCP server feature must be turned on in the app, created from a manifest with the user scopes
    expect(byId("slack").setup).toContain("Features → Agents");
    expect(byId("slack").setup).toContain("Slack Model Context Protocol (MCP) Server");
    const manifest = JSON.parse(byId("slack").setupManifest!);
    expect(manifest.oauth_config.redirect_urls).toEqual(["<public URL>/api/v1/connectors/oauth/callback"]);
    expect(manifest.oauth_config.scopes.user).toEqual(expect.arrayContaining(["search:read.public", "chat:write", "canvases:write", "lists:write", "users:read.email"]));
    expect(manifest.oauth_config.scopes.user).toHaveLength(29);
    expect(byId("figma").setupManifest).toBeUndefined();
    for (const id of ["figma", "square"]) {
      expect(byId(id)).toMatchObject({ auth: "oauth_preregistered", oauth: { app: id } });
    }
    expect(byId("vercel")).toMatchObject({ auth: "oauth", oauthRegistration: "cimd" });
    // fixed after the catalog health check (scripts/check-connector-catalog.mjs)
    for (const id of ["whatsapp-business", "zoominfo", "mollie", "airwallex", "pitchbook", "gamma", "mailchimp"]) {
      expect(CONNECTOR_CATALOG.some((e) => e.id === id), id).toBe(false);
    }
    expect(byId("canva")).toMatchObject({ url: "https://api.canva.com/connect/v1/mcp", auth: "oauth_preregistered", oauth: { app: "canva" } });
    expect(byId("canva").setup).toContain("Canva MCP");
    expect(byId("dropbox")).toMatchObject({ auth: "oauth_preregistered", oauth: { app: "dropbox", extraAuthParams: { token_access_type: "offline" } } });
    expect(byId("dropbox").setup).toContain("App Console");
    expect(byId("gusto").url).toBe("https://mcp.api.gusto.com");
    expect(byId("semgrep").oauth).toEqual({ resourceIndicator: false });
    for (const id of ["intercom", "brevo", "signeasy"]) expect(byId(id)).toMatchObject({ auth: "bearer" });
    expect(byId("intercom").authHeader).toBeUndefined();
    expect(byId("newrelic")).toMatchObject({ auth: "bearer", authHeader: "Api-Key" });
    expect(byId("pipedrive")).toMatchObject({ auth: "bearer", authHeader: "x-api-token" });
    expect(byId("intercom").variants).toEqual([
      { label: "Default", url: "https://mcp.intercom.com/mcp" },
      { label: "EU", url: "https://mcp.eu.intercom.com/mcp" },
    ]);
    // vendor-hosted servers added later: sign in only (DCR / CIMD), region variants from the notes
    for (const [id, url, registration] of [
      ["ovhcloud", "https://mcp.eu.ovhcloud.com/mcp", "dcr"],
      ["zernio", "https://mcp.zernio.com/mcp", "dcr"],
      ["v0", "https://v0.app/api/mcp", "dcr"],
      ["expo", "https://mcp.expo.dev/mcp", "dcr+cimd"],
      ["autumn", "https://mcp.useautumn.com/mcp", "dcr"],
      ["aws", "https://aws-mcp.us-east-1.api.aws/mcp", "dcr"],
      ["agentphone", "https://mcp.agentphone.ai/mcp", "dcr"],
    ] as const) {
      expect(byId(id)).toMatchObject({ url, transport: "http", auth: "oauth", oauthRegistration: registration, verified: true });
      expect(byId(id).oauth).toBeUndefined();
      expect(byId(id).docs).toMatch(/^https:\/\//);
    }
    expect(byId("ovhcloud").variants).toEqual([
      { label: "EU", url: "https://mcp.eu.ovhcloud.com/mcp" },
      { label: "US", url: "https://mcp.us.ovhcloud.com/mcp" },
      { label: "CA", url: "https://mcp.ca.ovhcloud.com/mcp" },
    ]);
    expect(byId("aws").variants).toEqual([
      { label: "US", url: "https://aws-mcp.us-east-1.api.aws/mcp" },
      { label: "EU", url: "https://aws-mcp.eu-central-1.api.aws/mcp" },
    ]);
    expect(byId("azure-devops")).toMatchObject({ urlTemplate: "https://mcp.dev.azure.com/{organization}" });
    expect(byId("azure-devops").url).toBeUndefined();
    await expect(buildConnector({ catalogId: "azure-devops" }, ctx)).rejects.toThrow(/URL/);
    await expect(buildConnector({ catalogId: "azure-devops", url: "https://mcp.dev.azure.com/{organization}" }, ctx)).rejects.toThrow(/placeholders/);
    const { connector: ado } = await buildConnector({ catalogId: "azure-devops", url: "https://mcp.dev.azure.com/contoso" }, ctx);
    expect(ado).toMatchObject({ transport: { url: "https://mcp.dev.azure.com/contoso" }, auth: { type: "oauth", oauth: { app: "azure-devops" } } });
    const { connector: maps, secrets } = await buildConnector({ catalogId: "google-maps", secrets: { bearerToken: "maps-key" } }, ctx);
    expect(maps.auth).toEqual({ type: "headers", headerNames: ["X-Goog-Api-Key"] });
    expect(secrets).toEqual({ "header:X-Goog-Api-Key": "maps-key" });
  });

  it("serves the metadata document and uses its URL as client_id when the server supports CIMD", async () => {
    const doc = clientMetadataDocument("https://polpo.example.com/team");
    expect(doc).toMatchObject({
      client_id: "https://polpo.example.com/team/api/v1/connectors/oauth/client-metadata.json",
      redirect_uris: [`https://polpo.example.com/team${CONNECTOR_OAUTH_CALLBACK_PATH}`],
      token_endpoint_auth_method: "none",
    });
    expect(clientMetadataUrlFor(`http://127.0.0.1:3890${CONNECTOR_OAUTH_CALLBACK_PATH}`)).toBeUndefined();

    const { manager } = setup();
    await add(manager, { id: "cimd", name: "Cimd", url: `${base}/oauth-mcp`, auth: { type: "oauth" } });
    fake.cimd = true;
    try {
      const before = fake.clients.size;
      const { authorizationUrl } = await manager.startOAuth("cimd", `https://polpo.example.com/team${CONNECTOR_OAUTH_CALLBACK_PATH}`);
      expect(new URL(authorizationUrl!).searchParams.get("client_id")).toBe(doc.client_id);
      expect(fake.clients.size).toBe(before); // no dynamic registration
    } finally {
      fake.cimd = false;
    }
    // without CIMD (or without a public https URL) it registers dynamically
    await manager.secrets.unset("cimd", ["oauth_client_info", "oauth_discovery"]);
    const { authorizationUrl } = await manager.startOAuth("cimd", `http://127.0.0.1:3890${CONNECTOR_OAUTH_CALLBACK_PATH}`);
    expect(new URL(authorizationUrl!).searchParams.get("client_id")).toMatch(/^client-/);
  });
});

describe("public URLs for OAuth providers (POLPO_PUBLIC_URL)", () => {
  const PUBLIC = "https://lumea-dev.example.ts.net/lumea";
  const PRIVATE = "https://lumea-dev.example.ts.net:3001";
  const previous = process.env.POLPO_PUBLIC_URL;
  beforeAll(() => { process.env.POLPO_PUBLIC_URL = PUBLIC; });
  afterAll(() => {
    if (previous === undefined) delete process.env.POLPO_PUBLIC_URL;
    else process.env.POLPO_PUBLIC_URL = previous;
  });

  /** Wired like the server: the redirect URI from POLPO_PUBLIC_URL, whatever host the request came in on. */
  function publicApp(manager: ConnectorManager) {
    const app = new Hono();
    app.route("/api/v1/connectors", connectorRoutes({
      manager: () => manager,
      settings: allowLocal,
      redirectUri: (c) => `${connectorPublicBase(new URL(c.req.url).origin)}${CONNECTOR_OAUTH_CALLBACK_PATH}`,
    }));
    return app;
  }

  it("builds the redirect URI from POLPO_PUBLIC_URL, else the request origin; the dashboard from POLPO_DASHBOARD_URL", () => {
    expect(connectorPublicBase(PRIVATE)).toBe(PUBLIC);
    delete process.env.POLPO_PUBLIC_URL;
    try {
      expect(connectorPublicBase(`${PRIVATE}/`)).toBe(PRIVATE);
    } finally {
      process.env.POLPO_PUBLIC_URL = PUBLIC;
    }
    const dashboard = process.env.POLPO_DASHBOARD_URL;
    process.env.POLPO_DASHBOARD_URL = "https://lumea-dev.example.ts.net:5174/";
    try {
      expect(connectorDashboardBase(PUBLIC)).toBe("https://lumea-dev.example.ts.net:5174");
    } finally {
      if (dashboard === undefined) delete process.env.POLPO_DASHBOARD_URL;
      else process.env.POLPO_DASHBOARD_URL = dashboard;
    }
  });

  it("oauth/start through another port: public client_id (CIMD) and redirect_uri, consistent with the metadata document; a stale client is dropped", async () => {
    const { manager } = setup();
    const app = publicApp(manager);
    await add(manager, { id: "linear", name: "Linear", url: `${base}/oauth-mcp`, auth: { type: "oauth" } });
    // stored by an earlier attempt made through the private port
    await manager.secrets.patch("linear", { oauth_client_info: JSON.stringify({ client_id: `${PRIVATE}/api/v1/connectors/oauth/client-metadata.json` }) });
    fake.cimd = true;
    try {
      const res = await app.request(`${PRIVATE}/api/v1/connectors/linear/oauth/start`, { method: "POST" });
      expect(res.status).toBe(200);
      const { data } = await res.json();
      const url = new URL(data.authorizationUrl);
      const doc = clientMetadataDocument(connectorPublicBase(PRIVATE));
      expect(url.searchParams.get("client_id")).toBe(`${PUBLIC}/api/v1/connectors/oauth/client-metadata.json`);
      expect(url.searchParams.get("redirect_uri")).toBe(`${PUBLIC}${CONNECTOR_OAUTH_CALLBACK_PATH}`);
      expect(data.redirectUri).toBe(`${PUBLIC}${CONNECTOR_OAUTH_CALLBACK_PATH}`);
      expect(doc.client_id).toBe(url.searchParams.get("client_id"));
      expect(doc.redirect_uris).toEqual([url.searchParams.get("redirect_uri")]);
      expect(JSON.parse((await manager.secrets.get("linear")).oauth_client_info!)).toMatchObject({ client_id: doc.client_id });
    } finally {
      fake.cimd = false;
    }
  });

  it("registers again when the dynamically registered client has another redirect URI", async () => {
    const { manager } = setup();
    const app = publicApp(manager);
    await add(manager, { id: "dcr", name: "Dcr", url: `${base}/oauth-mcp`, auth: { type: "oauth" } });
    await manager.secrets.patch("dcr", { oauth_client_info: JSON.stringify({ client_id: "client-old", redirect_uris: [`${PRIVATE}${CONNECTOR_OAUTH_CALLBACK_PATH}`] }) });
    const { data } = await (await app.request(`${PRIVATE}/api/v1/connectors/dcr/oauth/start`, { method: "POST" })).json();
    const url = new URL(data.authorizationUrl);
    expect(url.searchParams.get("client_id")).not.toBe("client-old");
    expect(fake.clients.get(url.searchParams.get("client_id")!)?.redirect_uris).toEqual([`${PUBLIC}${CONNECTOR_OAUTH_CALLBACK_PATH}`]);
    // the browser gets through with the new client
    expect((await fetch(url, { redirect: "manual" })).status).toBe(302);
  });

  it("the provider's error on the callback becomes the connector's lastError", async () => {
    const { manager } = setup();
    const app = routesApp(manager);
    await add(manager, { id: "denied", name: "Denied", url: `${base}/oauth-mcp`, auth: { type: "oauth" } });
    const start = await (await app.request("/api/v1/connectors/denied/oauth/start", { method: "POST" })).json();
    const state = new URL(start.data.authorizationUrl).searchParams.get("state")!;
    const res = await app.request(`${CONNECTOR_OAUTH_CALLBACK_PATH}?state=${state}&error=invalid_client&error_description=Client+metadata+unreachable`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("https://polpo.example.com/connectors");
    expect(manager.store.get("denied")).toMatchObject({ status: "error", lastError: expect.stringContaining("invalid_client: Client metadata unreachable") });
    expect((await manager.secrets.get("denied")).oauth_state).toBeUndefined();
  });
});

// ── per-identity connectors ──

describe("per-identity connectors: accounts per agent / person", () => {
  /** A per-identity bearer connector at /who-mcp (its `who` tool answers with the calling account's token). */
  async function identitySetup(opts: { fallback?: boolean; agents?: string[] | "*" } = {}) {
    const env = setup();
    const app = routesAppWith(env.manager, { agentNames: ["nina", "luca", "bob"], member: "ada@acme.com" });
    const created = await app.request("/api/v1/connectors", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "mail", name: "Mail", url: `${base}/who-mcp`, auth: { type: "bearer" }, access: { agents: opts.agents ?? ["nina", "luca", "bob"], polpo: true },
        scope: { kind: "identity", ...(opts.fallback ? { fallback: true } : {}) } }),
    });
    expect(created.status).toBe(201);
    const addAccount = async (identity: string, label: string, token: string, extra: Record<string, unknown> = {}) => {
      const r = await app.request("/api/v1/connectors/mail/accounts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity, label, secrets: { bearerToken: token }, ...extra }),
      });
      const json = await r.json();
      if (r.status !== 201) throw new Error(`${r.status} ${json.error}`);
      return json.data.account as { id: string; label: string; default?: boolean; identity: string };
    };
    return { ...env, app, addAccount };
  }
  const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

  it("resolves the caller's default account, and the account argument picks another of its own", async () => {
    const { manager, addAccount } = await identitySetup();
    const site = await addAccount("agent:nina", "sitoinchat", "tok-nina-site");
    const personal = await addAccount("agent:nina", "personale", "tok-nina-personal");
    expect(site.default).toBe(true);
    expect(personal.default).toBeUndefined();
    const { tools, notes } = await manager.toolsFor("nina");
    expect(notes).toEqual([]);
    const who = tools.find((t) => t.name === "mcp__mail__who")!;
    // one set of tools for the connector (not per account), with an optional account argument
    expect(tools.map((t) => t.name).sort()).toEqual(["mcp__mail__send", "mcp__mail__who"]);
    expect((who.parameters as any).properties.account).toMatchObject({ type: "string" });
    expect((who.parameters as any).properties.account.description).toContain("\"sitoinchat\" (default)");
    expect(text(await who.execute("1", {}))).toBe("tok-nina-site");
    expect(text(await who.execute("2", { account: "personale" }))).toBe("tok-nina-personal");
    expect(text(await who.execute("3", { account: "PERSONALE", note: "hi" }))).toBe("tok-nina-personal hi");
    // the account argument never reaches the server
    expect(text(await who.execute("4", { account: "sitoinchat", note: "x" }))).toBe("tok-nina-site x");
    // a server tool with its own "account" parameter: Polpo's is polpo_account, the server's passes through
    const send = tools.find((t) => t.name === "mcp__mail__send")!;
    expect(Object.keys((send.parameters as any).properties)).toEqual(expect.arrayContaining(["to", "account", "polpo_account"]));
    expect(text(await send.execute("5", { to: "x@y.z", account: "app-1", polpo_account: "personale" }))).toBe("sent to x@y.z by tok-nina-personal (app account app-1)");
    // one MCP session per (connector, account), created lazily
    expect(manager.isConnected("mail", site.id)).toBe(true);
    expect(manager.isConnected("mail", personal.id)).toBe(true);
    expect(manager.isConnected("mail")).toBe(false);
    // the default can change: the next call uses it
    await updateConnectorAccount({ manager }, "mail", personal.id, { default: true });
    expect(text(await who.execute("6", {}))).toBe("tok-nina-personal");
    expect(manager.store.getAccount("mail", site.id)?.default).toBeUndefined();
  });

  it("isolation: an identity never reaches another identity's account, even by passing its label", async () => {
    const { manager, addAccount } = await identitySetup();
    await addAccount("agent:nina", "sitoinchat", "tok-nina-site");
    await addAccount("agent:luca", "lavoro", "tok-luca");
    const luca = (await manager.toolsFor("luca")).tools.find((t) => t.name === "mcp__mail__who")!;
    expect(text(await luca.execute("1", {}))).toBe("tok-luca");
    await expect(luca.execute("2", { account: "sitoinchat" })).rejects.toThrow(/agent luca has no account "sitoinchat".*"lavoro"/);
    // nor by the account id, nor through callAs with another identity's label
    const ninaAccount = manager.store.get("mail")!.accounts!.find((a) => a.identity === "agent:nina")!;
    await expect(luca.execute("3", { account: ninaAccount.id })).rejects.toThrow(/no account/);
    await expect(manager.callAs("mail", "agent:luca", "who", {}, "sitoinchat")).rejects.toThrow(/no account "sitoinchat"/);
    // the prompt shows only the caller's own accounts
    const section = connectorsPromptSection(manager.store.list(), "luca");
    expect(section).toContain("\"lavoro\" (default)");
    expect(section).not.toContain("sitoinchat");
  });

  it("no account: a clear error naming the connector; the fallback (off by default) covers identities without one", async () => {
    const { manager, app, addAccount } = await identitySetup();
    await addAccount("agent:nina", "sitoinchat", "tok-nina-site");
    await manager.toolsFor("nina"); // lists the tools through Nina's account
    const bob = await manager.toolsFor("bob");
    expect(bob.notes.join("\n")).toMatch(/Mail \(mail\) is per identity and agent bob has no account on it/);
    // the tools still show (same names for everyone), and say so when used
    const who = bob.tools.find((t) => t.name === "mcp__mail__who")!;
    await expect(who.execute("1", {})).rejects.toThrow(/agent bob has no account on it.*Settings → Connectors/);
    expect(connectorsPromptSection(manager.store.list(), "bob")).toContain("agent bob has no account on it yet");
    // an org account exists, but the fallback is off: still no account for bob
    await addAccount("org", "condiviso", "tok-org");
    await expect(who.execute("2", {})).rejects.toThrow(/no account/);
    // fallback on: bob uses the organization's account; nina keeps her own
    const patched = await app.request("/api/v1/connectors/mail", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: { kind: "identity", fallback: true } }) });
    expect(patched.status).toBe(200);
    expect(text(await who.execute("3", {}))).toBe("tok-org");
    const nina = (await manager.toolsFor("nina")).tools.find((t) => t.name === "mcp__mail__who")!;
    expect(text(await nina.execute("4", {}))).toBe("tok-nina-site");
    expect(text(await nina.execute("5", { account: "condiviso" }))).toBe("tok-org");
    expect(connectorsPromptSection(manager.store.list(), "bob")).toContain("organization's shared account");
    // and off again
    await app.request("/api/v1/connectors/mail", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: { kind: "identity", fallback: false } }) });
    await expect(who.execute("6", {})).rejects.toThrow(/no account/);
  });

  it("a person chatting with Polpo uses their own accounts (and only theirs)", async () => {
    const { manager, addAccount, app } = await identitySetup();
    // "me" is the signed-in member calling the API
    const mine = await addAccount("me", "personale", "tok-nina-personal");
    expect(mine.identity).toBe("person:ada@acme.com");
    await addAccount("person:bo@acme.com", "bo", "tok-luca");
    const ada = (await manager.toolsFor(undefined, undefined, undefined, { person: "Ada@Acme.com" })).tools.find((t) => t.name === "mcp__mail__who")!;
    expect(text(await ada.execute("1", {}))).toBe("tok-nina-personal");
    await expect(ada.execute("2", { account: "bo" })).rejects.toThrow(/ada@acme.com has no account "bo"/);
    // no sign-in: the shared person, who has no account here
    const anon = await manager.toolsFor(undefined, undefined, undefined, {});
    expect(anon.notes.join()).toMatch(/the person \(no sign-in\) has no account/);
    // a channel contact chatting with Polpo is nobody's: never a person's account, even the shared person's
    await addAccount("person:_shared", "shared-person", "tok-org");
    const shared = (await manager.toolsFor(undefined, undefined, undefined, {})).tools.find((t) => t.name === "mcp__mail__who")!;
    expect(text(await shared.execute("s", {}))).toBe("tok-org");
    const contact = (await manager.toolsFor(undefined, undefined, undefined, { person: "_nobody" })).tools.find((t) => t.name === "mcp__mail__who")!;
    await expect(contact.execute("c", {})).rejects.toThrow(/has no account/);
    // people need access.polpo
    await app.request("/api/v1/connectors/mail", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ access: { polpo: false } }) });
    await expect(addAccount("person:cy@acme.com", "cy", "tok-org")).rejects.toThrow(/People cannot connect accounts/);
    expect((await manager.toolsFor(undefined, undefined, undefined, { person: "ada@acme.com" })).tools).toEqual([]);
  });

  it("validates accounts: access, unique labels per identity, scope changes, connector-level tokens", async () => {
    const { manager, app, addAccount } = await identitySetup({ agents: ["nina"] });
    await addAccount("agent:nina", "sitoinchat", "tok-nina-site");
    await expect(addAccount("agent:luca", "lavoro", "tok-luca")).rejects.toThrow(/400 agent luca may not use Mail/);
    await expect(addAccount("agent:ghost", "x", "tok-luca")).rejects.toThrow(/400 identity: there is no agent "ghost"/);
    await expect(addAccount("agent:nina", "SitoInChat", "tok-luca")).rejects.toThrow(/400 agent nina already has an account "SitoInChat"/);
    await expect(addAccount("robot", "x", "tok-luca")).rejects.toThrow(/400 identity must be/);
    // the same label for another identity is fine
    await addAccount("org", "sitoinchat", "tok-org");
    const toOrg = await app.request("/api/v1/connectors/mail", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: { kind: "org" } }) });
    expect(toOrg.status).toBe(400);
    const token = await app.request("/api/v1/connectors/mail", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ secrets: { bearerToken: "x" } }) });
    expect(token.status).toBe(400);
    const conn = await app.request("/api/v1/connectors/mail/oauth/start", { method: "POST" });
    expect(conn.status).toBe(400);
    // an org connector cannot become per identity in place
    await add(manager, { id: "plain", name: "Plain", url: `${base}/mcp` });
    const toIdentity = await app.request("/api/v1/connectors/plain", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: { kind: "identity" } }) });
    expect(toIdentity.status).toBe(400);
    expect((await toIdentity.json()).error).toMatch(/import this one as an account/);
    // nothing secret in the API or the config file
    const listed = await (await app.request("/api/v1/connectors")).text();
    expect(listed).not.toContain("tok-nina-site");
    expect(readFileSync(manager.store.file, "utf-8")).not.toContain("tok-nina-site");
    expect(JSON.parse(listed).data.connectors.find((c: any) => c.id === "mail").accounts[0]).toMatchObject({ identity: "agent:nina", identityLabel: "agent nina", secrets: { bearerToken: true } });
    // removing the default promotes the identity's next account
    await addAccount("agent:nina", "personale", "tok-nina-personal");
    const site = manager.store.get("mail")!.accounts!.find((a) => a.label === "sitoinchat" && a.identity === "agent:nina")!;
    const del = await app.request(`/api/v1/connectors/mail/accounts/${site.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(manager.store.get("mail")!.accounts!.find((a) => a.identity === "agent:nina")).toMatchObject({ label: "personale", default: true });
    expect(await manager.secrets.get(`mail~${site.id}`)).toEqual({});
  });

  it("converts separate connectors of the same app into accounts (explicit import), credentials moved, nothing revoked", async () => {
    const { manager, app, addAccount } = await identitySetup();
    await addAccount("agent:luca", "lavoro", "tok-luca");
    // Nina's own connector, made before per-identity connectors existed
    await add(manager, { id: "mail-nina", name: "Mail Nina", url: `${base}/who-mcp`, auth: { type: "bearer" }, scope: { kind: "agent", agent: "nina" }, secrets: { bearerToken: "tok-legacy-nina" } });
    manager.store.update("mail-nina", { account: "nina@sitoinchat.it" });
    // another app cannot be imported
    await add(manager, { id: "other", name: "Other", url: `${base}/mcp` });
    const wrong = await app.request("/api/v1/connectors/mail/accounts/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "other", identity: "agent:nina" }) });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toMatch(/not the same app/);
    const r = await app.request("/api/v1/connectors/mail/accounts/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "mail-nina", label: "sitoinchat" }) });
    expect(r.status).toBe(201);
    const data = (await r.json()).data;
    // the owner of the agent-scoped connector becomes the identity; its account is kept
    expect(data.account).toMatchObject({ identity: "agent:nina", label: "sitoinchat", default: true, account: "nina@sitoinchat.it", importedFrom: "mail-nina" });
    expect(data.source).toEqual({ id: "mail-nina", removed: true, disabled: false });
    expect(data.renamed.from).toBe("mcp__mail-nina__*");
    expect(manager.store.get("mail-nina")).toBeUndefined();
    expect(await manager.secrets.get("mail-nina")).toEqual({});
    // Nina's calls now go through the moved credentials
    const who = (await manager.toolsFor("nina")).tools.find((t) => t.name === "mcp__mail__who")!;
    expect(text(await who.execute("1", {}))).toBe("tok-legacy-nina");
    // keep the source (turned off) instead
    await add(manager, { id: "mail-2", name: "Mail 2", url: `${base}/who-mcp`, auth: { type: "bearer" }, secrets: { bearerToken: "tok-org" } });
    const kept = await importConnectorAccount({ manager, agentNames: ["nina", "luca", "bob"] }, "mail", { from: "mail-2", identity: "org", label: "shared", removeSource: false });
    expect(kept.source).toEqual({ id: "mail-2", removed: false, disabled: true });
    expect(manager.store.get("mail-2")).toMatchObject({ enabled: false, status: "disabled" });
    // an org connector needs to be told whose account it becomes
    await add(manager, { id: "mail-3", name: "Mail 3", url: `${base}/who-mcp`, auth: { type: "bearer" }, secrets: { bearerToken: "tok-org" } });
    await expect(importConnectorAccount({ manager }, "mail", { from: "mail-3" })).rejects.toThrow(/say whose account/);
  });

  it("OAuth per account: each account signs in on its own, tokens under the account's vault entry", async () => {
    const { manager, vault } = setup();
    const app = routesAppWith(manager, { agentNames: ["nina", "luca"] });
    const created = await app.request("/api/v1/connectors", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "gmail", name: "Gmail", url: `${base}/who-oauth-mcp`, auth: { type: "oauth" }, access: { agents: ["nina", "luca"], polpo: false }, scope: { kind: "identity" } }),
    });
    expect((await created.json()).data).toMatchObject({ status: "disconnected", scope: { kind: "identity" } });
    const signIn = async (identity: string, label: string, email: string) => {
      const acc = (await (await app.request("/api/v1/connectors/gmail/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity, label }) })).json()).data.account;
      expect(acc).toMatchObject({ status: "needs_auth", secrets: { oauth: { authorized: false } } });
      const start = await (await app.request(`/api/v1/connectors/gmail/accounts/${acc.id}/oauth/start`, { method: "POST" })).json();
      const redirect = await fetch(new URL(start.data.authorizationUrl), { redirect: "manual" });
      fake.idTokenEmail = email;
      const callback = await app.request(`${CONNECTOR_OAUTH_CALLBACK_PATH}${new URL(redirect.headers.get("location")!).search}`);
      expect(callback.status).toBe(200);
      const html = await callback.text();
      expect(html).toContain(`Gmail – ${label} connected`);
      expect(html).toContain(`account=${acc.id}`);
      return acc.id as string;
    };
    const ninaId = await signIn("agent:nina", "sitoinchat", "nina@sitoinchat.it");
    const lucaId = await signIn("agent:luca", "lavoro", "luca@acme.com");
    expect(manager.store.getAccount("gmail", ninaId)).toMatchObject({ status: "connected", account: "nina@sitoinchat.it", toolCount: 2 });
    expect(manager.store.getAccount("gmail", lucaId)).toMatchObject({ status: "connected", account: "luca@acme.com" });
    // the connector itself has no tokens: each account its own
    expect((await vault.get(CONNECTORS_VAULT_OWNER, "gmail"))?.credentials?.oauth_tokens).toBeUndefined();
    const ninaTokens = JSON.parse((await vault.get(CONNECTORS_VAULT_OWNER, `gmail~${ninaId}`))!.credentials.oauth_tokens!);
    const lucaTokens = JSON.parse((await vault.get(CONNECTORS_VAULT_OWNER, `gmail~${lucaId}`))!.credentials.oauth_tokens!);
    expect(ninaTokens.access_token).not.toBe(lucaTokens.access_token);
    const who = async (agent: string) => text(await (await manager.toolsFor(agent)).tools.find((t) => t.name === "mcp__gmail__who")!.execute("1", {}));
    expect(await who("nina")).toBe(ninaTokens.access_token);
    expect(await who("luca")).toBe(lucaTokens.access_token);
    // signing one account out leaves the other connected
    const out = await app.request(`/api/v1/connectors/gmail/accounts/${ninaId}/disconnect`, { method: "POST" });
    expect(out.status).toBe(200);
    expect(manager.store.getAccount("gmail", ninaId)).toMatchObject({ status: "needs_auth" });
    expect(manager.store.getAccount("gmail", ninaId)?.account).toBeUndefined();
    expect(fake.revoked).toEqual(expect.arrayContaining([ninaTokens.refresh_token]));
    expect(await who("luca")).toBe(lucaTokens.access_token);
    await expect(who("nina")).rejects.toThrow(/reconnect|Not authorized/i);
  });

  it("harness host tools (Claude Code, Codex, OpenCode) and the agent's engine get the agent's own account", async () => {
    const { polpoDir, vault, addAccount } = await identitySetup();
    await addAccount("agent:nina", "sitoinchat", "tok-nina-site");
    await addAccount("agent:nina", "personale", "tok-nina-personal");
    await addAccount("agent:luca", "lavoro", "tok-luca");
    writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({ project: "t", team: { name: "t", agents: [{ name: "nina" }] }, settings: { connectors: { allowPrivateNetwork: true } } }));
    const toolset = await buildAgentToolset({ agentConfig: { name: "nina" } as AgentConfig, cwd: polpoDir, ctx: { polpoDir, vaultStore: vault }, sandboxProvider: "local", browserProfileDir: join(polpoDir, "bp"), hasExtendedTools: false });
    try {
      expect(toolset.connectorNote).toContain("\"sitoinchat\" (default)");
      expect(toolset.connectorNote).not.toContain("lavoro");
      const host = toHarnessHostTools(toolset.tools).find((t) => t.name === "mcp__mail__who")!;
      expect((host.inputSchema as any).properties.account.type).toBe("string");
      expect(await host.execute({}, { toolCallId: "1" })).toBe("tok-nina-site");
      expect(await host.execute({ account: "personale" }, { toolCallId: "2" })).toBe("tok-nina-personal");
      expect(await host.execute({ account: "lavoro" }, { toolCallId: "3" })).toMatch(/^Error: .*agent nina has no account "lavoro"/);
    } finally {
      await toolset.connectorManager?.closeAll();
    }
  });

  it("core resolution rules", () => {
    const c = {
      id: "m", name: "M", scope: { kind: "identity" as const },
      accounts: [
        { id: "a1", identity: "agent:nina", label: "uno", createdAt: "" },
        { id: "a2", identity: "agent:nina", label: "due", default: true, createdAt: "" },
        { id: "o1", identity: "org", label: "shared", default: true, createdAt: "" },
      ],
    };
    expect(resolveConnectorAccount(c, "agent:nina")).toMatchObject({ ok: true, account: { id: "a2" }, fallback: false });
    expect(resolveConnectorAccount(c, "agent:nina", " Uno ")).toMatchObject({ ok: true, account: { id: "a1" } });
    expect(resolveConnectorAccount(c, "agent:bob")).toMatchObject({ ok: false, reason: "no_account" });
    expect(resolveConnectorAccount(c, "agent:bob", "uno")).toMatchObject({ ok: false, reason: "unknown_account" });
    expect(resolveConnectorAccount({ ...c, scope: { kind: "identity", fallback: true } }, "agent:bob")).toMatchObject({ ok: true, account: { id: "o1" }, fallback: true });
    expect(personConnectorIdentity(" Ada@Acme.com ")).toBe("person:ada@acme.com");
    expect(personConnectorIdentity(undefined)).toBe("person:_shared");
    expect(personConnectorIdentity("_nobody")).toBe("person:_nobody");
    expect(parseConnectorIdentity("person:_nobody")).toBeUndefined();
    // who is chatting: the signed-in member (also through an MCP client), the shared person without sign-in, nobody for a channel contact
    expect(withEventOrigin({ source: "api", by: "Ada@Acme.com" }, () => currentConnectorPerson())).toBe("ada@acme.com");
    expect(withEventOrigin({ source: "api", by: "ada@acme.com via Claude" }, () => currentConnectorPerson())).toBe("ada@acme.com");
    expect(withEventOrigin({ source: "api" }, () => withEventOrigin({ source: "polpo" }, () => currentConnectorPerson()))).toBeUndefined();
    expect(withEventOrigin({ source: "channel", by: "telegram:42" }, () => currentConnectorPerson())).toBe("_nobody");
    expect(withEventOrigin({ source: "api", by: "mcp-key:ops" }, () => currentConnectorPerson())).toBe("_nobody");
    expect(parseConnectorIdentity("agent:$connectors")).toBeUndefined();
    expect(parseConnectorIdentity("person:not-an-email")).toBeUndefined();
    // a per-identity connector grants like an org one (access), never per scope owner
    expect(connectorGrants({ enabled: true, access: { agents: ["nina"], polpo: false }, scope: { kind: "identity" } }, "nina")).toBe(true);
    expect(connectorGrants({ enabled: true, access: { agents: ["nina"], polpo: false }, scope: { kind: "identity" } }, "luca")).toBe(false);
  });

  it("MCP and chat tools: per_identity add, accounts list / add / default / import", async () => {
    const { manager, addAccount, app } = await identitySetup();
    await addAccount("agent:nina", "sitoinchat", "tok-nina-site");
    const chat = await executeConnectorTool("connectors_list", { agent: "nina" }, { manager, agentNames: async () => ["nina", "luca", "bob"] });
    expect(chat).toContain("per identity");
    expect(chat).toContain("agent nina: \"sitoinchat\" (default)");
    const connect = await executeConnectorTool("connector_connect", { id: "mail" }, { manager, agentNames: async () => [] });
    expect(connect).toMatch(/per identity: each account signs in on its own/);
    // the MCP server's tools over the same API
    const { tools, call } = mcpToolsOver(app);
    expect(tools).toEqual(expect.arrayContaining(["polpo_connector_accounts", "polpo_connector_account_add", "polpo_connector_account_update", "polpo_connector_account_connect",
      "polpo_connector_account_disconnect", "polpo_connector_account_remove", "polpo_connector_account_import"]));
    const listed = await call("polpo_connector_accounts", { id: "mail", identity: "agent:nina" });
    expect(listed.structuredContent.accounts).toEqual([expect.objectContaining({ label: "sitoinchat", default: true, identity: "agent:nina" })]);
    const added = await call("polpo_connector_account_add", { id: "mail", identity: "agent:nina", label: "personale" });
    expect(added.structuredContent.setup_url).toContain("focus=account%3A");
    const def = await call("polpo_connector_account_update", { id: "mail", account: "personale", identity: "agent:nina", default: true });
    expect(def.structuredContent.account).toMatchObject({ label: "personale", default: true });
    const add2 = await call("polpo_connector_add", { url: `${base}/who-mcp`, id: "mail-b", name: "Mail B", auth: "none", per_identity: true, agents: ["nina"] });
    expect(add2.structuredContent.connector).toMatchObject({ scope: "identity", fallback: false, accounts: [] });
    await add(manager, { id: "mail-nina", name: "Mail Nina", url: `${base}/who-mcp`, auth: { type: "bearer" }, scope: { kind: "agent", agent: "nina" }, secrets: { bearerToken: "tok-legacy-nina" } });
    const refused = await call("polpo_connector_account_import", { id: "mail", from: "mail-nina", label: "vecchia" });
    expect(refused.isError).toBe(true);
    const imported = await call("polpo_connector_account_import", { id: "mail", from: "mail-nina", label: "vecchia", confirm: true });
    expect(imported.structuredContent).toMatchObject({ source_removed: true, account: { identity: "agent:nina", label: "vecchia" } });
  });
});
