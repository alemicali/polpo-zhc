/**
 * Connectors (Polpo as an MCP client) against a real in-process MCP server (SDK McpServer over
 * streamable HTTP on an ephemeral port), with a bearer-protected variant and an OAuth-protected one
 * backed by a minimal fake authorization server (discovery, DCR, PKCE, refresh, revocation).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CONNECTORS_VAULT_OWNER } from "@polpo-ai/core";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";
import { ConnectorManager } from "../mcp/manager.js";
import { buildConnector, ConnectorInputError } from "../mcp/validate.js";
import { checkConnectorUrl } from "../mcp/net.js";
import { connectorToolAllowed, convertToolResult, mcpToolName, MAX_RESULT_TEXT, toolResultText } from "../mcp/tools.js";
import { connectorRoutes, connectorOAuthCallback, CONNECTOR_OAUTH_CALLBACK_PATH } from "../server/routes/connectors.js";
import { CONNECTOR_CATALOG } from "../mcp/catalog.js";
import { clientMetadataDocument, clientMetadataUrlFor } from "../mcp/paths.js";
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

async function serveMcp(req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const s = mcpServer();
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
      return json(res, 200, { access_token, refresh_token, token_type: "Bearer", expires_in: 3600 });
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
  it("adds from a custom URL, lists, changes access, and removes only when confirmed", async () => {
    const { manager } = setup();
    const ctx = { manager, settings: allowLocal(), redirectUri: "http://127.0.0.1:3890/cb", agentNames: async () => ["alice", "bob"] };
    const added = await executeConnectorTool("connector_add", { url: `${base}/mcp`, name: "Fake", agents: ["alice"] }, ctx);
    expect(added).toMatch(/Added Fake \[fake\].*Connected: 5 tools/s);
    expect(await executeConnectorTool("connector_add", { url: `${base}/mcp`, name: "X", agents: ["ghost"] }, ctx)).toMatch(/Unknown agents: ghost/);
    expect(await executeConnectorTool("connectors_list", {}, ctx)).toMatch(/Fake \[fake\] connected, 5 tools; auth none; used by agents: alice \+ Polpo/);
    expect(await executeConnectorTool("connector_update_access", { id: "fake", addAgents: ["bob"], polpo: false }, ctx)).toMatch(/agents: alice, bob;/);
    expect(manager.store.get("fake")?.access).toEqual({ agents: ["alice", "bob"], polpo: false });
    expect(await executeConnectorTool("connector_remove", { id: "fake" }, ctx)).toMatch(/confirm/);
    expect(manager.store.get("fake")).toBeDefined();
    expect(await executeConnectorTool("connector_remove", { id: "fake", confirm: true }, ctx)).toBe("Removed Fake.");
    expect(manager.store.get("fake")).toBeUndefined();
  });

  it("returns the OAuth link for an OAuth connector", async () => {
    const { manager } = setup();
    const ctx = { manager, settings: allowLocal(), redirectUri: "http://127.0.0.1:3890/cb", agentNames: async () => [] };
    const out = await executeConnectorTool("connector_add", { url: `${base}/oauth-mcp`, name: "OA", auth: "oauth" }, ctx);
    expect(out).toMatch(/must open this link/);
    expect(out).toContain(`${base}/authorize?`);
    expect(await executeConnectorTool("connector_add", { url: "http://127.0.0.1:9/x", transport: "http", name: "S" }, { ...ctx, settings: {} })).toMatch(/https/);
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
    for (const id of ["figma", "square"]) {
      expect(byId(id)).toMatchObject({ auth: "oauth_preregistered", oauth: { app: id } });
    }
    expect(byId("vercel")).toMatchObject({ auth: "oauth", oauthRegistration: "cimd" });
    expect(byId("intercom").variants).toEqual([
      { label: "Default", url: "https://mcp.intercom.com/mcp" },
      { label: "EU", url: "https://mcp.eu.intercom.com/mcp" },
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
