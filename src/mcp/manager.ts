/**
 * The connection manager: one MCP client per connector, connected lazily and reused.
 *
 * - tools are listed once and cached (TTL, refreshed on demand and on notifications/tools/list_changed);
 * - tool calls have a timeout (connector toolTimeoutMs, settings.connectors.toolTimeoutMs, 60 s) and honor
 *   the caller's abort signal; a dropped session reconnects once;
 * - OAuth through the vault-backed provider: the SDK refreshes on 401; a failed refresh marks the
 *   connector "needs_reauth";
 * - status, last error and tool count are cached in connectors.json and announced as `connector:changed`.
 *
 * The server keeps one manager per .polpo dir (`getConnectorManager`); a task runner process makes its own.
 */
import { timingSafeEqual } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  connectorGrants, DEFAULT_CONNECTOR_TOOL_TIMEOUT_MS,
  type ConnectorChangedEvent, type ConnectorConfig, type ConnectorStatus, type PolpoSettings, type VaultStore,
} from "@polpo-ai/core";
import { safeEnv } from "../tools/safe-env.js";
import { allowPrivateNetwork, checkConnectorUrl, type ResolveHost } from "./net.js";
import { VaultOAuthProvider, type PreregisteredClient } from "./oauth-provider.js";
import { ConnectorSecrets, OAUTH_KEYS, resolveSecretRefs, SECRET_KEYS } from "./secrets.js";
import { ConnectorStore } from "./store.js";
import { bridgeMcpTool, connectorToolAllowed, type McpToolInfo } from "./tools.js";
import { clientMetadataUrlFor } from "./paths.js";

const VERSION = "1.0.0";
const CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_LIST_TTL_MS = 5 * 60_000;
/** How long a chat waits for one connector's tools before going on without them. */
const TOOLS_FOR_TIMEOUT_MS = 15_000;

export interface ConnectorManagerOptions {
  polpoDir: string;
  vaultStore?: VaultStore;
  settings?: () => PolpoSettings | undefined;
  emit?: (event: ConnectorChangedEvent) => void;
  log?: (message: string) => void;
  /** Tests: DNS resolution for the private-network check. */
  resolveHost?: ResolveHost;
  listTtlMs?: number;
  /** stdio connectors' working directory (default: the .polpo dir). */
  cwd?: string;
}

interface Connection {
  client: Client;
  transport: Transport;
  signature: string;
  tools?: McpToolInfo[];
  toolsAt?: number;
  provider?: VaultOAuthProvider;
}

export interface ConnectorToolsResult {
  tools: AgentTool<any>[];
  /** Short notes on connectors that could not be used (for the prompt / logs). */
  notes: string[];
}

export class ConnectorError extends Error {
  constructor(message: string, readonly status: ConnectorStatus) {
    super(message);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Errors after which the session is gone and one reconnect + retry is safe (the call never ran). */
function isSessionGone(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && (err.code === 404 || err.code === 400)) return /session/i.test(err.message) || err.code === 404;
  return /not connected|connection closed/i.test(errorMessage(err));
}

export class ConnectorManager {
  readonly store: ConnectorStore;
  secrets: ConnectorSecrets;
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<Connection>>();

  constructor(private options: ConnectorManagerOptions) {
    this.store = new ConnectorStore(options.polpoDir);
    this.secrets = new ConnectorSecrets(options.vaultStore);
  }

  /** Swap the dependencies (the vault store may appear after setup). */
  configure(options: ConnectorManagerOptions): void {
    if (options.vaultStore !== this.options.vaultStore) this.secrets = new ConnectorSecrets(options.vaultStore);
    this.options = options;
  }

  private log(message: string): void {
    (this.options.log ?? ((m: string) => console.log(m)))(`[connectors] ${message}`);
  }

  private urlPolicy() {
    return { allowPrivateNetwork: allowPrivateNetwork(this.options.settings?.()), resolve: this.options.resolveHost };
  }

  private timeoutFor(connector: ConnectorConfig): number {
    return connector.toolTimeoutMs ?? this.options.settings?.()?.connectors?.toolTimeoutMs ?? DEFAULT_CONNECTOR_TOOL_TIMEOUT_MS;
  }

  private signature(connector: ConnectorConfig): string {
    return JSON.stringify([connector.transport, connector.auth, connector.enabled]);
  }

  /** Record the connection state; announce it when it changed. */
  setStatus(id: string, status: ConnectorStatus, extra: { error?: string; toolCount?: number; action?: ConnectorChangedEvent["action"] } = {}): void {
    const before = this.store.get(id);
    if (!before) return;
    const changed = before.status !== status || (extra.error ?? undefined) !== (before.lastError ?? undefined)
      || (extra.toolCount !== undefined && extra.toolCount !== before.toolCount);
    if (!changed && !extra.action) return;
    this.store.setStatus(id, {
      status,
      ...(extra.error ? { lastError: extra.error } : {}),
      ...(extra.toolCount !== undefined ? { toolCount: extra.toolCount } : {}),
      ...(status === "connected" ? { lastConnectedAt: new Date().toISOString() } : {}),
    });
    this.options.emit?.({
      id, status, action: extra.action ?? "status",
      ...(extra.toolCount !== undefined ? { toolCount: extra.toolCount } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    });
  }

  /** Announce a configuration change (created / updated). */
  announce(id: string, action: "created" | "updated"): void {
    const connector = this.store.get(id);
    if (!connector) return;
    this.options.emit?.({ id, status: connector.status ?? "disconnected", action, ...(connector.toolCount !== undefined ? { toolCount: connector.toolCount } : {}) });
  }

  /** The client for a pre-registered OAuth app or client id, if the connector uses one. */
  async preregisteredClient(connector: ConnectorConfig): Promise<PreregisteredClient | undefined> {
    const oauth = connector.auth.oauth;
    if (oauth?.clientId) {
      const secret = (await this.secrets.get(connector.id))[SECRET_KEYS.clientSecret];
      return { clientId: oauth.clientId, ...(secret ? { clientSecret: secret } : {}) };
    }
    if (oauth?.app) {
      const app = this.store.getOAuthApp(oauth.app);
      if (!app) throw new ConnectorError(`Set up the "${oauth.app}" OAuth app first (its client id and secret), then connect`, "needs_auth");
      const secret = await this.secrets.appSecret(oauth.app);
      return { clientId: app.clientId, ...(secret ? { clientSecret: secret } : {}) };
    }
    return undefined;
  }

  private async headersFor(connector: ConnectorConfig, secrets: Record<string, string>): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(connector.transport.headers ?? {})) headers[name] = resolveSecretRefs(value, secrets);
    if (connector.auth.type === "bearer") {
      const token = secrets[SECRET_KEYS.bearer];
      if (!token) throw new ConnectorError("No token set for this connector", "error");
      headers.Authorization = `Bearer ${token}`;
    }
    if (connector.auth.type === "headers") {
      for (const name of connector.auth.headerNames ?? []) {
        const value = secrets[SECRET_KEYS.header(name)];
        if (value) headers[name] = resolveSecretRefs(value, secrets);
      }
    }
    return headers;
  }

  private async openTransports(connector: ConnectorConfig): Promise<{ transports: Array<() => Transport>; provider?: VaultOAuthProvider }> {
    const t = connector.transport;
    const secrets = await this.secrets.get(connector.id);
    if (t.type === "stdio") {
      const env = Object.fromEntries(Object.entries(t.env ?? {}).map(([k, v]) => [k, resolveSecretRefs(v, secrets)]));
      return {
        transports: [() => new StdioClientTransport({
          command: t.command!, args: t.args ?? [], env: safeEnv(env), cwd: this.options.cwd ?? this.options.polpoDir, stderr: "pipe",
        })],
      };
    }
    const url = await checkConnectorUrl(t.url!, this.urlPolicy());
    const headers = await this.headersFor(connector, secrets);
    let provider: VaultOAuthProvider | undefined;
    if (connector.auth.type === "oauth") {
      if (!secrets[SECRET_KEYS.tokens]) throw new ConnectorError("Not authorized yet: connect it (OAuth) first", "needs_auth");
      provider = await new VaultOAuthProvider(connector, this.secrets, { interactive: false, preregistered: await this.preregisteredClient(connector) }).init();
    }
    const requestInit: RequestInit = { headers };
    const http = () => new StreamableHTTPClientTransport(url, { requestInit, ...(provider ? { authProvider: provider } : {}) });
    const sse = () => new SSEClientTransport(url, { requestInit, ...(provider ? { authProvider: provider } : {}) });
    return { transports: t.type === "sse" ? [sse] : [http, sse], provider };
  }

  private async open(connector: ConnectorConfig): Promise<Connection> {
    const { transports, provider } = await this.openTransports(connector);
    let firstError: unknown;
    for (const make of transports) {
      const client = new Client({ name: "polpo", version: VERSION }, { capabilities: {} });
      const transport = make();
      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        const connection: Connection = { client, transport, signature: this.signature(connector), provider };
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          connection.tools = undefined;
        });
        client.onclose = () => {
          if (this.connections.get(connector.id) === connection) this.connections.delete(connector.id);
        };
        return connection;
      } catch (err) {
        await client.close().catch(() => undefined);
        if (err instanceof UnauthorizedError || provider?.authorizationRequired) throw this.unauthorized(connector, provider);
        firstError ??= err;
      }
    }
    throw firstError;
  }

  private unauthorized(connector: ConnectorConfig, provider?: VaultOAuthProvider): ConnectorError {
    if (connector.auth.type === "oauth") {
      return new ConnectorError(provider?.authorizationRequired
        ? "The authorization expired or was revoked: reconnect it (OAuth)"
        : "Unauthorized: reconnect it (OAuth)", "needs_reauth");
    }
    return new ConnectorError("Unauthorized: check the connector's token or headers", "error");
  }

  /** The live connection, connecting if needed. */
  async connect(id: string): Promise<Connection> {
    const connector = this.store.get(id);
    if (!connector) throw new ConnectorError(`No connector "${id}"`, "error");
    if (!connector.enabled) throw new ConnectorError(`Connector "${connector.name}" is disabled`, "disabled");
    const existing = this.connections.get(id);
    if (existing && existing.signature === this.signature(connector)) return existing;
    if (existing) await this.close(id);
    const pending = this.connecting.get(id);
    if (pending) return pending;
    const attempt = (async () => {
      try {
        const connection = await this.open(connector);
        this.connections.set(id, connection);
        return connection;
      } catch (err) {
        const status = err instanceof ConnectorError ? err.status : "error";
        this.setStatus(id, status, { error: errorMessage(err) });
        throw err instanceof ConnectorError ? err : new ConnectorError(errorMessage(err), status);
      } finally {
        this.connecting.delete(id);
      }
    })();
    this.connecting.set(id, attempt);
    return attempt;
  }

  /** The connector's tools (cached; `refresh` lists them again). */
  async listTools(id: string, opts: { refresh?: boolean } = {}): Promise<McpToolInfo[]> {
    const ttl = this.options.listTtlMs ?? DEFAULT_LIST_TTL_MS;
    const run = async (): Promise<McpToolInfo[]> => {
      const connection = await this.connect(id);
      if (!opts.refresh && connection.tools && connection.toolsAt && Date.now() - connection.toolsAt < ttl) return connection.tools;
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await connection.client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
        tools.push(...page.tools.map((t) => ({
          name: t.name, ...(t.title ? { title: t.title } : {}), ...(t.description ? { description: t.description } : {}),
          inputSchema: t.inputSchema as Record<string, unknown>, ...(t.annotations ? { annotations: t.annotations as Record<string, unknown> } : {}),
        })));
        cursor = page.nextCursor;
      } while (cursor && tools.length < 2000);
      connection.tools = tools;
      connection.toolsAt = Date.now();
      this.setStatus(id, "connected", { toolCount: tools.length });
      return tools;
    };
    try {
      return await run();
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      if (err instanceof UnauthorizedError) {
        const e = this.unauthorized(this.store.get(id)!, this.connections.get(id)?.provider);
        await this.close(id);
        this.setStatus(id, e.status, { error: e.message });
        throw e;
      }
      await this.close(id);
      if (isSessionGone(err)) return run();
      this.setStatus(id, "error", { error: errorMessage(err) });
      throw new ConnectorError(errorMessage(err), "error");
    }
  }

  /** Call a tool (the server's name, not the prefixed one). Returns the raw CallToolResult. */
  async callTool(id: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const connector = this.store.get(id);
    if (!connector) throw new ConnectorError(`No connector "${id}"`, "error");
    if (connector.toolPolicy?.[toolName] === "off") throw new ConnectorError(`The tool "${toolName}" is turned off for ${connector.name}`, "connected");
    const timeout = this.timeoutFor(connector);
    const run = async () => {
      const connection = await this.connect(id);
      return await connection.client.callTool({ name: toolName, arguments: args }, undefined, { timeout, ...(signal ? { signal } : {}) }) as Record<string, unknown>;
    };
    try {
      return await run();
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      if (signal?.aborted) throw err;
      if (err instanceof UnauthorizedError) {
        const e = this.unauthorized(connector, this.connections.get(id)?.provider);
        await this.close(id);
        this.setStatus(id, e.status, { error: e.message });
        throw e;
      }
      if (isSessionGone(err)) {
        await this.close(id);
        return run();
      }
      throw err;
    }
  }

  /** Connect and list the tools (the "Test" button). */
  async test(id: string): Promise<{ ok: boolean; status: ConnectorStatus; tools?: McpToolInfo[]; error?: string }> {
    await this.close(id);
    try {
      const tools = await this.listTools(id, { refresh: true });
      return { ok: true, status: "connected", tools };
    } catch (err) {
      return { ok: false, status: err instanceof ConnectorError ? err.status : "error", error: errorMessage(err) };
    }
  }

  /**
   * The tools of the connectors granted to `agent` (or to Polpo when undefined), as AgentTools,
   * filtered by the connector's tool policy and, for agents, by allowedTools. A connector that cannot
   * connect is skipped with a note; it never breaks the caller.
   */
  async toolsFor(agent: string | undefined, allowedTools?: string[]): Promise<ConnectorToolsResult> {
    const connectors = this.store.list().filter((c) => connectorGrants(c, agent));
    const notes: string[] = [];
    const lists = await Promise.all(connectors.map(async (connector) => {
      try {
        let timer: NodeJS.Timeout | undefined;
        const tools = await Promise.race([
          this.listTools(connector.id),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), TOOLS_FOR_TIMEOUT_MS); timer.unref?.(); }),
        ]).finally(() => clearTimeout(timer));
        return { connector, tools };
      } catch (err) {
        notes.push(`${connector.name} (${connector.id}) is unavailable: ${errorMessage(err)}`);
        this.log(`${connector.id}: ${errorMessage(err)}`);
        return { connector, tools: [] as McpToolInfo[] };
      }
    }));
    const tools: AgentTool<any>[] = [];
    const seen = new Set<string>();
    for (const { connector, tools: list } of lists) {
      for (const tool of list) {
        const policy = connector.toolPolicy?.[tool.name] ?? "allow";
        if (policy === "off") continue;
        // TODO(connectors): "ask" should pause for the person's approval in chat; treated as "allow" until an approval hook exists.
        const bridged = bridgeMcpTool(connector.id, connector.name, tool, (name, args, signal) => this.callTool(connector.id, name, args, signal));
        if (agent !== undefined && !connectorToolAllowed(allowedTools, bridged.name)) continue;
        if (seen.has(bridged.name)) continue;
        seen.add(bridged.name);
        tools.push(bridged);
      }
    }
    return { tools, notes };
  }

  // ── OAuth ──

  /** Start the browser authorization: returns the URL to open (or authorized: true when stored tokens still work). */
  async startOAuth(id: string, redirectUrl: string): Promise<{ authorizationUrl?: string; authorized?: boolean }> {
    const connector = this.store.get(id);
    if (!connector) throw new ConnectorError(`No connector "${id}"`, "error");
    if (connector.auth.type !== "oauth" || !connector.transport.url) throw new ConnectorError(`${connector.name} does not use OAuth`, "error");
    const url = await checkConnectorUrl(connector.transport.url, this.urlPolicy());
    const metadataUrl = clientMetadataUrlFor(redirectUrl);
    const provider = await new VaultOAuthProvider(connector, this.secrets, {
      interactive: true, redirectUrl, preregistered: await this.preregisteredClient(connector),
      ...(metadataUrl ? { clientMetadataUrl: metadataUrl } : {}),
    }).init();
    const scopes = connector.auth.oauth?.scopes;
    const result = await auth(provider, { serverUrl: url, ...(scopes?.length ? { scope: scopes.join(" ") } : {}) });
    if (result === "AUTHORIZED") {
      await this.close(id);
      return { authorized: true };
    }
    if (!provider.authorizationUrl) throw new ConnectorError("The server did not start an authorization", "error");
    return { authorizationUrl: provider.authorizationUrl.toString() };
  }

  /** The connector waiting for this state (unexpired), if any. */
  async findPendingState(state: string): Promise<ConnectorConfig | undefined> {
    if (!state) return undefined;
    for (const connector of this.store.list().filter((c) => c.auth.type === "oauth")) {
      const secrets = await this.secrets.get(connector.id);
      const stored = secrets[SECRET_KEYS.state];
      if (!stored || !safeEqual(stored, state)) continue;
      if (Number(secrets[SECRET_KEYS.stateExpires] ?? 0) < Date.now()) {
        await this.secrets.unset(connector.id, [SECRET_KEYS.state, SECRET_KEYS.stateExpires, SECRET_KEYS.verifier]);
        return undefined;
      }
      return connector;
    }
    return undefined;
  }

  /** The browser came back: exchange the code (state is single use), store the tokens, connect. */
  async finishOAuth(state: string, code: string): Promise<{ connector: ConnectorConfig; toolCount?: number; error?: string }> {
    const connector = await this.findPendingState(state);
    if (!connector) throw new ConnectorError("Unknown or expired authorization: start connecting again", "error");
    // single use: the state goes before anything else
    await this.secrets.unset(connector.id, [SECRET_KEYS.state, SECRET_KEYS.stateExpires]);
    const provider = await new VaultOAuthProvider(connector, this.secrets, {
      interactive: true, preregistered: await this.preregisteredClient(connector),
    }).init();
    try {
      await auth(provider, { serverUrl: connector.transport.url!, authorizationCode: code });
    } catch (err) {
      this.setStatus(connector.id, "needs_auth", { error: `Authorization failed: ${errorMessage(err)}` });
      throw new ConnectorError(`Authorization failed: ${errorMessage(err)}`, "needs_auth");
    } finally {
      await this.secrets.unset(connector.id, [SECRET_KEYS.verifier]);
    }
    await this.close(connector.id);
    const result = await this.test(connector.id);
    return { connector: this.store.get(connector.id) ?? connector, ...(result.tools ? { toolCount: result.tools.length } : {}), ...(result.error ? { error: result.error } : {}) };
  }

  /** Forget the authorization: revoke the tokens when the server supports it (best effort), then delete them. */
  async disconnect(id: string): Promise<void> {
    const connector = this.store.get(id);
    await this.close(id);
    if (!connector) return;
    if (connector.auth.type === "oauth") {
      await this.revoke(connector).catch((err) => this.log(`${id}: revoke failed: ${errorMessage(err)}`));
      await this.secrets.unset(id, OAUTH_KEYS.filter((k) => k !== SECRET_KEYS.clientInfo && k !== SECRET_KEYS.discovery));
      this.setStatus(id, "needs_auth", { action: "updated" });
    } else {
      this.setStatus(id, "disconnected", { action: "updated" });
    }
  }

  private async revoke(connector: ConnectorConfig): Promise<void> {
    const secrets = await this.secrets.get(connector.id);
    const tokens = secrets[SECRET_KEYS.tokens] ? JSON.parse(secrets[SECRET_KEYS.tokens]!) as { access_token?: string; refresh_token?: string } : undefined;
    const discovery = secrets[SECRET_KEYS.discovery] ? JSON.parse(secrets[SECRET_KEYS.discovery]!) as { authorizationServerMetadata?: { revocation_endpoint?: string } } : undefined;
    const endpoint = discovery?.authorizationServerMetadata?.revocation_endpoint;
    if (!tokens || !endpoint) return;
    await checkConnectorUrl(endpoint, this.urlPolicy());
    const client = await this.preregisteredClient(connector).catch(() => undefined)
      ?? (secrets[SECRET_KEYS.clientInfo] ? JSON.parse(secrets[SECRET_KEYS.clientInfo]!) as { client_id: string; client_secret?: string } : undefined);
    for (const token of [tokens.refresh_token, tokens.access_token].filter(Boolean) as string[]) {
      const body = new URLSearchParams({ token });
      const id = client && "clientId" in client ? client.clientId : (client as { client_id?: string } | undefined)?.client_id;
      const secret = client && "clientSecret" in client ? client.clientSecret : (client as { client_secret?: string } | undefined)?.client_secret;
      if (id) body.set("client_id", id);
      if (secret) body.set("client_secret", secret);
      await fetch(endpoint, { method: "POST", body, signal: AbortSignal.timeout(10_000), redirect: "error" }).catch(() => undefined);
    }
  }

  /** Remove a connector: close, revoke, delete its secrets and its config. */
  async remove(id: string): Promise<boolean> {
    const connector = this.store.get(id);
    if (!connector) return false;
    await this.close(id);
    if (connector.auth.type === "oauth") await this.revoke(connector).catch(() => undefined);
    await this.secrets.remove(id);
    this.store.remove(id);
    this.options.emit?.({ id, status: "disconnected", action: "deleted" });
    return true;
  }

  async close(id: string): Promise<void> {
    const connection = this.connections.get(id);
    this.connections.delete(id);
    if (connection) await connection.client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.close(id)));
  }
}

// ── one manager per .polpo dir (server process) ──

const managers = new Map<string, ConnectorManager>();

export function getConnectorManager(options: ConnectorManagerOptions): ConnectorManager {
  let manager = managers.get(options.polpoDir);
  if (!manager) {
    manager = new ConnectorManager(options);
    managers.set(options.polpoDir, manager);
  } else {
    manager.configure(options);
  }
  return manager;
}

export async function closeAllConnectorManagers(): Promise<void> {
  await Promise.all([...managers.values()].map((m) => m.closeAll()));
  managers.clear();
}
