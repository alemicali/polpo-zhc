/**
 * The connection manager: one MCP client per connector, connected lazily and reused. A per-identity
 * connector has one client per (connector, account) instead, each with that account's credentials,
 * created lazily the first time the account is used (same timeouts, reconnects and status rules).
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
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHostedMcpServer } from "../mcp-servers/runtime.js";
import { hostedDeps } from "../mcp-servers/host.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  callerConnectorIdentity, connectorAccountService, connectorAccountsOf, connectorGrants, connectorToolSelected, DEFAULT_CONNECTOR_TOOL_TIMEOUT_MS,
  isIdentityConnector, ORG_CONNECTOR_IDENTITY, resolveConnectorAccount,
  type AgentConnectorTools, type ConnectorAccount, type ConnectorChangedEvent, type ConnectorConfig, type ConnectorIdentity, type ConnectorStatus,
  type PolpoSettings, type VaultStore,
} from "@polpo-ai/core";
import { safeEnv } from "../tools/safe-env.js";
import { allowPrivateNetwork, checkConnectorUrl, type ResolveHost } from "./net.js";
import { OAuthHttpError } from "./oauth-errors.js";
import { VaultOAuthProvider, type PreregisteredClient } from "./oauth-provider.js";
import { ConnectorSecrets, OAUTH_KEYS, resolveSecretRefs, SECRET_KEYS } from "./secrets.js";
import { ConnectorStore } from "./store.js";
import { ConnectorIcons } from "./icon-store.js";
import type { IconFetcher } from "./icons.js";
import { accountParamName, bridgeMcpTool, connectorToolAllowed, type McpToolInfo } from "./tools.js";
import { clientMetadataUrlFor } from "./paths.js";
import { catalogEntry } from "./catalog.js";
import { accountFromIdToken, connectorLabel } from "./view.js";
import { accountFromToolResult, pickIdentityTool } from "./account-identity.js";

const VERSION = "1.0.0";
const CONNECT_TIMEOUT_MS = 20_000;
/** The one identity call after a connection (whoami / get_me…): short, it only labels the connector. */
const ACCOUNT_LOOKUP_TIMEOUT_MS = 5_000;
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
  /** Look custom connectors' icons up on create / connect / list (the server; off in task runners). */
  autoDiscoverIcons?: boolean;
  /** Tests: the network for icon discovery. */
  iconFetcher?: IconFetcher;
}

interface Connection {
  key: string;
  client: Client;
  transport: Transport;
  signature: string;
  tools?: McpToolInfo[];
  toolsAt?: number;
  provider?: VaultOAuthProvider;
}

/**
 * What a connection is for: a connector (org or agent-scoped), or one account of a per-identity
 * connector. `key` names the live connection, `service` the vault entry its secrets are in.
 */
export interface ConnectorTarget {
  key: string;
  connector: ConnectorConfig;
  account?: ConnectorAccount;
  service: string;
}

/** Who calls a connector's tools: an agent (by name), else a person in the Polpo chat (email; none: the shared person). */
export interface ConnectorCaller {
  person?: string | null;
}

export interface ConnectorToolsResult {
  tools: AgentTool<any>[];
  /** Short notes on connectors that could not be used (for the prompt / logs). */
  notes: string[];
}

export class ConnectorError extends Error {
  constructor(message: string, readonly status: ConnectorStatus, readonly oauthApp?: string) {
    super(message);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A log line for a started authorization: where it goes and with which client (no state, PKCE or secrets). */
function describeAuthorization(url: URL, clientMetadataUrl: string | undefined, preregistered: boolean): string {
  const clientId = url.searchParams.get("client_id") ?? "";
  const client = preregistered ? "pre-registered client"
    : clientMetadataUrl && clientId === clientMetadataUrl ? `client_id ${clientId} (metadata document)`
    : "dynamically registered client";
  return `authorize at ${url.origin}${url.pathname}, ${client}, redirect_uri ${url.searchParams.get("redirect_uri") ?? "(none)"}`;
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
  /** Custom connectors' icons (discovered or set by the person). */
  readonly icons: ConnectorIcons;
  secrets: ConnectorSecrets;
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<Connection>>();
  /** Per-identity connectors: the last tool list any of their accounts gave (same server, same tools), for callers with no account. */
  private readonly identityTools = new Map<string, McpToolInfo[]>();

  constructor(private options: ConnectorManagerOptions) {
    this.store = new ConnectorStore(options.polpoDir);
    this.secrets = new ConnectorSecrets(options.vaultStore);
    this.icons = new ConnectorIcons({
      polpoDir: options.polpoDir,
      store: this.store,
      policy: () => ({ allowPrivateNetwork: allowPrivateNetwork(this.options.settings?.()), resolve: this.options.resolveHost }),
      autoDiscover: () => !!this.options.autoDiscoverIcons,
      ...(options.iconFetcher ? { fetcher: options.iconFetcher } : {}),
      onChange: (id) => this.announce(id, "updated"),
      log: (m) => this.log(`icon ${m}`),
    });
  }

  /** Swap the dependencies (the vault store may appear after setup). */
  configure(options: ConnectorManagerOptions): void {
    if (options.vaultStore !== this.options.vaultStore) this.secrets = new ConnectorSecrets(options.vaultStore);
    this.options = options;
  }

  private log(message: string): void {
    (this.options.log ?? ((m: string) => console.log(m)))(`[polpo/connectors] ${message}`);
  }

  private urlPolicy() {
    return { allowPrivateNetwork: allowPrivateNetwork(this.options.settings?.()), resolve: this.options.resolveHost };
  }

  private timeoutFor(connector: ConnectorConfig): number {
    return connector.toolTimeoutMs ?? this.options.settings?.()?.connectors?.toolTimeoutMs ?? DEFAULT_CONNECTOR_TOOL_TIMEOUT_MS;
  }

  private signature(target: ConnectorTarget): string {
    const c = target.connector;
    return JSON.stringify([c.transport, c.auth, c.enabled, c.hostedVersion, target.account?.id ?? null]);
  }

  /**
   * The connection target: the connector itself, or one account of a per-identity connector (which
   * has no connection of its own: every call names an account).
   */
  target(id: string, accountId?: string): ConnectorTarget {
    const connector = this.store.get(id);
    if (!connector) throw new ConnectorError(`No connector "${id}"`, "error");
    if (!isIdentityConnector(connector)) {
      if (accountId) throw new ConnectorError(`${connector.name} is not per identity: it has no accounts`, "error");
      return { key: id, connector, service: id };
    }
    if (!accountId) throw new ConnectorError(`${connector.name} is per identity: name the account to use`, "error");
    const account = connector.accounts?.find((a) => a.id === accountId);
    if (!account) throw new ConnectorError(`${connector.name} has no account "${accountId}"`, "error");
    return { key: `${id}#${account.id}`, connector, account, service: connectorAccountService(id, account.id) };
  }

  /**
   * A per-identity connector's account for configuration chores (listing its tools to set their
   * policy, the Test button): a connected one, else the fallback, else any. Never used for tool calls.
   */
  private representative(connector: ConnectorConfig): ConnectorAccount | undefined {
    const accounts = connector.accounts ?? [];
    return accounts.find((a) => a.status === "connected") ?? connectorAccountsOf(connector, ORG_CONNECTOR_IDENTITY)[0] ?? accounts[0];
  }

  /** The target for configuration chores: the connector, or a per-identity connector's account (given, else representative). */
  private configTarget(id: string, accountId?: string): ConnectorTarget {
    const connector = this.store.get(id);
    if (!connector) throw new ConnectorError(`No connector "${id}"`, "error");
    if (!isIdentityConnector(connector) || accountId) return this.target(id, accountId);
    const account = this.representative(connector);
    if (!account) throw new ConnectorError(`${connector.name} is per identity and no account is connected to it yet: connect one first`, "needs_auth");
    return this.target(id, account.id);
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

  /** Record an account's connection state; announce it when it changed. */
  setAccountStatus(id: string, accountId: string, status: ConnectorStatus, extra: { error?: string; toolCount?: number; action?: ConnectorChangedEvent["action"] } = {}): void {
    const before = this.store.getAccount(id, accountId);
    if (!before) return;
    const changed = before.status !== status || (extra.error ?? undefined) !== (before.lastError ?? undefined)
      || (extra.toolCount !== undefined && extra.toolCount !== before.toolCount);
    if (!changed && !extra.action) return;
    this.store.setAccountStatus(id, accountId, {
      status,
      ...(extra.error ? { lastError: extra.error } : {}),
      ...(extra.toolCount !== undefined ? { toolCount: extra.toolCount } : {}),
      ...(status === "connected" ? { lastConnectedAt: new Date().toISOString() } : {}),
    });
    const connector = this.store.get(id);
    this.options.emit?.({
      id, account: accountId, status: connector?.status ?? "disconnected", action: extra.action ?? "status",
      ...(extra.toolCount !== undefined ? { toolCount: extra.toolCount } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    });
  }

  /** The state of what a connection is for: the connector, or the account. */
  private setTargetStatus(target: ConnectorTarget, status: ConnectorStatus, extra: { error?: string; toolCount?: number; action?: ConnectorChangedEvent["action"] } = {}): void {
    if (target.account) this.setAccountStatus(target.connector.id, target.account.id, status, extra);
    else this.setStatus(target.connector.id, status, extra);
  }

  /** The target's current cached status. */
  private targetStatus(target: ConnectorTarget): ConnectorStatus | undefined {
    return target.account ? this.store.getAccount(target.connector.id, target.account.id)?.status : this.store.get(target.connector.id)?.status;
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
      if (!app) throw new ConnectorError(`Set up the "${oauth.app}" OAuth app first (its client id and any required secret), then connect`, "needs_auth");
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

  /**
   * The secrets a target connects with: the connector's; for an account, the connector's named values
   * (`${vault:KEY}`) under the account's own (tokens, OAuth client, token / header values).
   */
  private async targetSecrets(target: ConnectorTarget): Promise<Record<string, string>> {
    const own = await this.secrets.get(target.connector.id);
    if (!target.account) return own;
    const shared = Object.fromEntries(Object.entries(own).filter(([k]) => k.startsWith("secret:")));
    return { ...shared, ...(await this.secrets.get(target.service)) };
  }

  private async openTransports(target: ConnectorTarget): Promise<{ transports: Array<() => Transport>; provider?: VaultOAuthProvider }> {
    const connector = target.connector;
    const t = connector.transport;
    if (t.type === "hosted") {
      // a custom server Polpo hosts: served in process (no network), the deployed version
      const server = createHostedMcpServer({ serverId: t.serverId ?? "", source: "private" }, hostedDeps(this.options.polpoDir, this.options.vaultStore));
      if (!server) throw new ConnectorError("This hosted server has no deployed version yet: publish and deploy it first", "error");
      return {
        transports: [() => {
          const [client, serverSide] = InMemoryTransport.createLinkedPair();
          void server.connect(serverSide).catch(() => undefined);
          return client;
        }],
      };
    }
    const secrets = await this.targetSecrets(target);
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
      provider = await new VaultOAuthProvider(connector, this.secrets, { interactive: false, preregistered: await this.preregisteredClient(connector), service: target.service }).init();
    }
    const requestInit: RequestInit = { headers };
    const transportOptions = { requestInit, ...(provider ? { authProvider: provider, fetch: provider.fetch } : {}) };
    const http = () => new StreamableHTTPClientTransport(url, transportOptions);
    const sse = () => new SSEClientTransport(url, transportOptions);
    return { transports: t.type === "sse" ? [sse] : [http, sse], provider };
  }

  private async open(target: ConnectorTarget): Promise<Connection> {
    const connector = target.connector;
    const { transports, provider } = await this.openTransports(target);
    let firstError: unknown;
    for (const make of transports) {
      const client = new Client({ name: "polpo", version: VERSION }, { capabilities: {} });
      const transport = make();
      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        const connection: Connection = { key: target.key, client, transport, signature: this.signature(target), provider };
        // the server's icons (MCP serverInfo.icons): looked at in the background, never blocking the connection
        try { this.icons.noteConnected(connector, client.getServerVersion()); } catch { /* icons never break a connection */ }
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          connection.tools = undefined;
        });
        client.onclose = () => {
          if (this.connections.get(target.key) === connection) this.connections.delete(target.key);
        };
        return connection;
      } catch (err) {
        await client.close().catch(() => undefined);
        if (err instanceof UnauthorizedError || provider?.authorizationRequired) throw this.unauthorized(connector, provider);
        const oauthError = this.oauthFailure(connector, err, provider);
        if (oauthError) throw oauthError;
        firstError ??= err;
      }
    }
    throw firstError;
  }

  private unauthorized(connector: ConnectorConfig, provider?: VaultOAuthProvider): ConnectorError {
    if (connector.auth.type === "oauth") {
      if (provider?.refreshError) return new ConnectorError(`${provider.refreshError.message} Reconnect to authorize again.`, "needs_reauth");
      return new ConnectorError(provider?.authorizationRequired
        ? "The authorization expired or was revoked: reconnect it (OAuth)"
        : "Unauthorized: reconnect it (OAuth)", "needs_reauth");
    }
    return new ConnectorError("Unauthorized: check the connector's token or headers", "error");
  }

  private oauthFailure(connector: ConnectorConfig, error: unknown, provider?: VaultOAuthProvider): ConnectorError | undefined {
    const failure = error instanceof OAuthHttpError ? error : provider?.takeDiscoveryError();
    if (failure?.step === "refresh" && failure.status < 500 && failure.status !== 429) {
      return new ConnectorError(`${failure.message} Reconnect to authorize again.`, "needs_reauth");
    }
    if ((failure?.step === "registration" && failure.status < 500 && failure.status !== 429)
      || errorMessage(error) === "Incompatible auth server: does not support dynamic client registration") {
      // the shared app the catalog names (e.g. "meta" for WhatsApp Business), else one for this connector
      const app = connector.auth.oauth?.app ?? (connector.catalogId ? catalogEntry(connector.catalogId)?.oauth?.app : undefined) ?? connector.catalogId ?? connector.id;
      return new ConnectorError(
        `${failure?.message ?? `${connector.name} does not offer dynamic OAuth client registration.`} Set up an approved, pre-registered client in Connectors → OAuth apps.`,
        "error",
        app,
      );
    }
    return failure && new ConnectorError(failure.message, "error");
  }

  private recordFailure(target: ConnectorTarget | string, error: unknown): ConnectorError {
    const failure = error instanceof ConnectorError ? error : new ConnectorError(errorMessage(error), "error");
    if (typeof target === "string") this.setStatus(target, failure.status, { error: failure.message });
    else this.setTargetStatus(target, failure.status, { error: failure.message });
    return failure;
  }

  /** The live connection, connecting if needed (`account`: one account of a per-identity connector). */
  async connect(id: string, account?: string): Promise<Connection> {
    const target = this.target(id, account);
    const { connector } = target;
    if (!connector.enabled) throw new ConnectorError(`Connector "${connector.name}" is disabled`, "disabled");
    const existing = this.connections.get(target.key);
    if (existing && existing.signature === this.signature(target)) return existing;
    if (existing) await this.closeKey(target.key);
    const pending = this.connecting.get(target.key);
    if (pending) return pending;
    const attempt = (async () => {
      try {
        const connection = await this.open(target);
        this.connections.set(target.key, connection);
        return connection;
      } catch (err) {
        throw this.recordFailure(target, err);
      } finally {
        this.connecting.delete(target.key);
      }
    })();
    this.connecting.set(target.key, attempt);
    return attempt;
  }

  /**
   * The connector's tools (cached; `refresh` lists them again). A per-identity connector lists them
   * through `account`, else through one of its accounts (they share the server, so the tools).
   */
  async listTools(id: string, opts: { refresh?: boolean; account?: string } = {}): Promise<McpToolInfo[]> {
    const target = this.configTarget(id, opts.account);
    const accountId = target.account?.id;
    const ttl = this.options.listTtlMs ?? DEFAULT_LIST_TTL_MS;
    const run = async (): Promise<McpToolInfo[]> => {
      const connection = await this.connect(id, accountId);
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
      if (target.account) this.identityTools.set(id, tools);
      this.setTargetStatus(target, "connected", { toolCount: tools.length });
      return tools;
    };
    try {
      return await run();
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      const connector = this.store.get(id)!;
      const provider = this.connections.get(target.key)?.provider;
      const failure = err instanceof UnauthorizedError ? this.unauthorized(connector, provider) : this.oauthFailure(connector, err, provider);
      if (failure) {
        await this.closeKey(target.key);
        throw this.recordFailure(target, failure);
      }
      await this.closeKey(target.key);
      if (isSessionGone(err)) return run();
      this.setTargetStatus(target, "error", { error: errorMessage(err) });
      throw new ConnectorError(errorMessage(err), "error");
    }
  }

  /**
   * Call a tool (the server's name, not the prefixed one). Returns the raw CallToolResult. A
   * per-identity connector needs `account` (the account's id, already resolved for the caller: see callAs).
   */
  async callTool(id: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal, account?: string): Promise<Record<string, unknown>> {
    const target = this.target(id, account);
    const { connector } = target;
    if (connector.toolPolicy?.[toolName] === "off") throw new ConnectorError(`The tool "${toolName}" is turned off for ${connector.name}`, "connected");
    const timeout = this.timeoutFor(connector);
    const run = async () => {
      const connection = await this.connect(id, account);
      return await connection.client.callTool({ name: toolName, arguments: args }, undefined, { timeout, ...(signal ? { signal } : {}) }) as Record<string, unknown>;
    };
    try {
      return await run();
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      if (signal?.aborted) throw err;
      const provider = this.connections.get(target.key)?.provider;
      const failure = err instanceof UnauthorizedError ? this.unauthorized(connector, provider) : this.oauthFailure(connector, err, provider);
      if (failure) {
        await this.closeKey(target.key);
        throw this.recordFailure(target, failure);
      }
      if (isSessionGone(err)) {
        await this.closeKey(target.key);
        return run();
      }
      throw err;
    }
  }

  /**
   * Call a per-identity connector's tool as `identity`: the account is the caller's default one, or
   * the one it names (`label`, one of its own; the fallback account when that is on). Resolved on
   * every call from the current configuration: an identity never reaches another identity's account,
   * whatever label it passes. No account: a clear error naming the connector.
   */
  async callAs(id: string, identity: ConnectorIdentity, toolName: string, args: Record<string, unknown>, label?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const connector = this.store.get(id);
    if (!connector) throw new ConnectorError(`No connector "${id}"`, "error");
    if (!isIdentityConnector(connector)) return this.callTool(id, toolName, args, signal);
    if (label !== undefined && label !== null && typeof label !== "string") throw new ConnectorError("account must be the label of one of your accounts (a string)", "error");
    const resolved = resolveConnectorAccount(connector, identity, label as string | undefined);
    if (!resolved.ok) throw new ConnectorError(resolved.error, "needs_auth");
    return this.callTool(id, toolName, args, signal, resolved.account.id);
  }

  /**
   * Connect and list the tools (the "Test" button); then, if still unknown, which account it is
   * signed in as. A per-identity connector tests `account` (else one of its accounts).
   */
  async test(id: string, account?: string): Promise<{ ok: boolean; status: ConnectorStatus; tools?: McpToolInfo[]; error?: string; account?: string }> {
    let target: ConnectorTarget;
    try {
      target = this.configTarget(id, account);
    } catch (err) {
      return { ok: false, status: err instanceof ConnectorError ? err.status : "error", error: errorMessage(err) };
    }
    await this.closeKey(target.key);
    try {
      const tools = await this.listTools(id, { refresh: true, ...(target.account ? { account: target.account.id } : {}) });
      await this.discoverAccount(id, tools, target.account?.id);
      return { ok: true, status: "connected", tools, ...(target.account ? { account: target.account.id } : {}) };
    } catch (err) {
      return { ok: false, status: err instanceof ConnectorError ? err.status : "error", error: errorMessage(err), ...(target.account ? { account: target.account.id } : {}) };
    }
  }

  /** Test the account `identity` would use on a per-identity connector (its default one, or the fallback); other connectors: test(). */
  async testAs(id: string, identity: ConnectorIdentity): Promise<{ ok: boolean; status: ConnectorStatus; tools?: McpToolInfo[]; error?: string; account?: string }> {
    const connector = this.store.get(id);
    if (!connector || !isIdentityConnector(connector)) return this.test(id);
    const resolved = resolveConnectorAccount(connector, identity);
    if (!resolved.ok) return { ok: false, status: "needs_auth", error: resolved.error };
    return this.test(id, resolved.account.id);
  }

  /**
   * Best effort, when the sign-in did not say which account it is (no id_token): call the server's
   * obvious identity tool once (whoami, get_me, get_current_user… read-only, no arguments; see
   * account-identity.ts) and keep the email or username as the connector's account. Time-boxed;
   * any failure leaves the account unknown. Returns the account found, if any.
   */
  async discoverAccount(id: string, tools: McpToolInfo[], accountId?: string): Promise<string | undefined> {
    const connector = this.store.get(id);
    if (!connector) return undefined;
    const known = () => (accountId ? this.store.getAccount(id, accountId)?.account : this.store.get(id)?.account);
    if (known()) return undefined;
    const tool = pickIdentityTool(tools.filter((t) => connector.toolPolicy?.[t.name] !== "off"));
    if (!tool) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACCOUNT_LOOKUP_TIMEOUT_MS);
    timer.unref?.();
    try {
      const account = accountFromToolResult(await this.callTool(id, tool.name, {}, controller.signal, accountId));
      if (!account || known()) return undefined;
      if (accountId) this.store.setAccountSignedIn(id, accountId, account);
      else this.store.update(id, { account });
      this.announce(id, "updated");
      this.log(`${id}${accountId ? `#${accountId}` : ""}: signed in as ${account} (from ${tool.name})`);
      return account;
    } catch (err) {
      this.log(`${id}: account lookup with ${tool.name} failed: ${errorMessage(err)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The tools of the connectors granted to `agent` (or to Polpo when undefined), as AgentTools,
   * filtered by the connector's tool policy and, for agents, by their per-connector selection
   * (`connectorTools`) and allowedTools: the intersection of the four. A connector that cannot
   * connect is skipped with a note; it never breaks the caller.
   */
  async toolsFor(agent: string | undefined, allowedTools?: string[], connectorTools?: AgentConnectorTools, caller: ConnectorCaller = {}): Promise<ConnectorToolsResult> {
    const connectors = this.store.list().filter((c) => connectorGrants(c, agent));
    const notes: string[] = [];
    // per-identity connectors: the caller's own accounts (an agent's, else the person's in the Polpo chat)
    const identity = callerConnectorIdentity(agent, caller.person);
    const lists = await Promise.all(connectors.map(async (connector) => {
      let account: string | undefined;
      if (isIdentityConnector(connector)) {
        const resolved = resolveConnectorAccount(connector, identity);
        if (!resolved.ok) {
          // no account: the tools still show (from another account's listing in this process) and say so when called
          notes.push(resolved.error);
          return { connector, tools: this.identityTools.get(connector.id) ?? [] };
        }
        account = resolved.account.id;
      }
      try {
        let timer: NodeJS.Timeout | undefined;
        const tools = await Promise.race([
          this.listTools(connector.id, account ? { account } : {}),
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
        const bridged = isIdentityConnector(connector)
          ? this.bridgeIdentityTool(connector, tool, identity)
          : bridgeMcpTool(connector.id, connectorLabel(connector), tool, (name, args, signal) => this.callTool(connector.id, name, args, signal));
        if (agent !== undefined && !connectorToolSelected(connectorTools, connector.id, tool.name)) continue;
        if (agent !== undefined && !connectorToolAllowed(allowedTools, bridged.name)) continue;
        if (seen.has(bridged.name)) continue;
        seen.add(bridged.name);
        tools.push(bridged);
      }
    }
    return { tools, notes };
  }

  /**
   * A per-identity connector's tool for `identity`: the same name for every identity
   * (mcp__<connector>__<tool>), with an optional `account` argument (one of the caller's account
   * labels); the account is resolved on each call (callAs), never from the model's say-so alone.
   */
  private bridgeIdentityTool(connector: ConnectorConfig, tool: McpToolInfo, identity: ConnectorIdentity): AgentTool<any> {
    const param = accountParamName(tool.inputSchema);
    const labels = [...connectorAccountsOf(connector, identity), ...(connector.scope?.kind === "identity" && connector.scope.fallback ? connectorAccountsOf(connector, ORG_CONNECTOR_IDENTITY) : [])]
      .map((a) => `"${a.label}"${a.default ? " (default)" : ""}${a.identity === ORG_CONNECTOR_IDENTITY ? " (shared)" : ""}`);
    const describeAccount = `Which of your ${connector.name} accounts to use: its label${labels.length ? ` (${labels.join(", ")})` : ""}. Omit for your default account.`;
    return bridgeMcpTool(connector.id, connectorLabel(connector), tool, (name, args, signal) => {
      const { [param]: label, ...rest } = args;
      return this.callAs(connector.id, identity, name, rest, label, signal);
    }, { name: param, description: describeAccount });
  }

  // ── OAuth ──

  /** Start the browser authorization: returns the URL to open (or authorized: true when stored tokens still work). */
  async startOAuth(id: string, redirectUrl: string, account?: string): Promise<{ authorizationUrl?: string; authorized?: boolean }> {
    const target = this.target(id, account);
    const { connector } = target;
    const label = target.account ? `${id}#${target.account.id}` : id;
    if (connector.auth.type !== "oauth" || !connector.transport.url) throw new ConnectorError(`${connector.name} does not use OAuth`, "error");
    let provider: VaultOAuthProvider | undefined;
    try {
      const url = await checkConnectorUrl(connector.transport.url, this.urlPolicy());
      const metadataUrl = clientMetadataUrlFor(redirectUrl);
      provider = await new VaultOAuthProvider(connector, this.secrets, {
        interactive: true, redirectUrl, preregistered: await this.preregisteredClient(connector), service: target.service,
        ...(metadataUrl ? { clientMetadataUrl: metadataUrl } : {}),
      }).init();
      if (this.targetStatus(target) === "needs_reauth") await provider.invalidateCredentials("tokens");
      // a client registered for another public URL (e.g. before POLPO_PUBLIC_URL was set) would fail at the provider
      if (!(await provider.tokens())) {
        const stale = await provider.dropStaleClient();
        if (stale) this.log(`oauth start ${label}: dropped the stored OAuth client (${stale}); registering again`);
      }
      const scopes = connector.auth.oauth?.scopes;
      const result = await auth(provider, { serverUrl: url, fetchFn: provider.fetch, ...(scopes?.length ? { scope: scopes.join(" ") } : {}) });
      if (result === "AUTHORIZED") {
        this.log(`oauth start ${label}: already authorized (stored tokens)`);
        await this.closeKey(target.key);
        return { authorized: true };
      }
      if (!provider.authorizationUrl) throw new ConnectorError("The server did not start an authorization", "error");
      if (target.account ? target.account.lastError : connector.lastError) this.setTargetStatus(target, "needs_auth");
      this.log(`oauth start ${label}: ${describeAuthorization(provider.authorizationUrl, provider.clientMetadataUrl, !!provider.preregisteredClient)}`);
      return { authorizationUrl: provider.authorizationUrl.toString() };
    } catch (err) {
      const failure = this.recordFailure(target, this.oauthFailure(connector, err, provider) ?? err);
      this.log(`oauth start ${label} failed (redirect_uri ${redirectUrl}): ${errorMessage(failure)}`);
      throw failure;
    }
  }

  /** Every OAuth target (connectors, and per-identity connectors' accounts), for matching a pending state. */
  private oauthTargets(): ConnectorTarget[] {
    const out: ConnectorTarget[] = [];
    for (const connector of this.store.list().filter((c) => c.auth.type === "oauth")) {
      if (!isIdentityConnector(connector)) out.push({ key: connector.id, connector, service: connector.id });
      else for (const account of connector.accounts ?? []) out.push({ key: `${connector.id}#${account.id}`, connector, account, service: connectorAccountService(connector.id, account.id) });
    }
    return out;
  }

  /**
   * The provider sent the browser back with an error (access_denied, invalid_client…) instead of a
   * code: drop the pending authorization and keep the reason as the connector's lastError.
   */
  async abortOAuth(state: string, error: string, description?: string): Promise<(ConnectorConfig & { pendingAccount?: ConnectorAccount }) | undefined> {
    const reason = [error, description].filter(Boolean).join(": ");
    const pending = await this.findPendingTarget(state);
    if (!pending) {
      this.log(`oauth callback (unknown or expired state): provider returned ${reason}`);
      return undefined;
    }
    await this.secrets.unset(pending.service, [SECRET_KEYS.state, SECRET_KEYS.stateExpires, SECRET_KEYS.verifier]);
    this.setTargetStatus(pending, "error", { error: `Authorization was not completed (${reason}).` });
    this.log(`oauth callback ${pending.key}: provider returned ${reason}`);
    const connector = this.store.get(pending.connector.id) ?? pending.connector;
    return { ...connector, ...(pending.account ? { pendingAccount: pending.account } : {}) };
  }

  /** The connector waiting for this state (unexpired), if any. */
  async findPendingState(state: string): Promise<ConnectorConfig | undefined> {
    return (await this.findPendingTarget(state))?.connector;
  }

  /** The connector, or per-identity connector's account, waiting for this state (unexpired), if any. */
  async findPendingTarget(state: string): Promise<ConnectorTarget | undefined> {
    if (!state) return undefined;
    for (const target of this.oauthTargets()) {
      const secrets = await this.secrets.get(target.service);
      const stored = secrets[SECRET_KEYS.state];
      if (!stored || !safeEqual(stored, state)) continue;
      if (Number(secrets[SECRET_KEYS.stateExpires] ?? 0) < Date.now()) {
        await this.secrets.unset(target.service, [SECRET_KEYS.state, SECRET_KEYS.stateExpires, SECRET_KEYS.verifier]);
        return undefined;
      }
      return target;
    }
    return undefined;
  }

  /** The browser came back: exchange the code (state is single use), store the tokens, connect. */
  async finishOAuth(state: string, code: string): Promise<{ connector: ConnectorConfig; account?: ConnectorAccount; toolCount?: number; error?: string }> {
    const target = await this.findPendingTarget(state);
    if (!target) {
      this.log("oauth callback: unknown or expired state");
      throw new ConnectorError("Unknown or expired authorization: start connecting again", "error");
    }
    const { connector } = target;
    // single use: the state goes before anything else
    await this.secrets.unset(target.service, [SECRET_KEYS.state, SECRET_KEYS.stateExpires]);
    let provider: VaultOAuthProvider | undefined;
    try {
      provider = await new VaultOAuthProvider(connector, this.secrets, {
        interactive: true, preregistered: await this.preregisteredClient(connector), service: target.service,
      }).init();
      await auth(provider, { serverUrl: connector.transport.url!, authorizationCode: code, fetchFn: provider.fetch });
    } catch (err) {
      const failure = this.recordFailure(target, this.oauthFailure(connector, err, provider) ??
        new ConnectorError(`Authorization failed: ${errorMessage(err)}`, "error"));
      this.log(`oauth callback ${target.key}: code exchange failed: ${errorMessage(failure)}`);
      throw failure;
    } finally {
      await this.secrets.unset(target.service, [SECRET_KEYS.verifier]);
    }
    // which account signed in, when the token response says so at no extra cost (an OpenID id_token)
    const signedIn = accountFromIdToken((await provider?.tokens().catch(() => undefined))?.id_token);
    if (target.account) {
      if (signedIn && signedIn !== target.account.account) this.store.setAccountSignedIn(connector.id, target.account.id, signedIn);
    } else if (signedIn && signedIn !== connector.account) this.store.update(connector.id, { account: signedIn });
    await this.closeKey(target.key);
    const result = await this.test(connector.id, target.account?.id);
    this.log(`oauth callback ${target.key}: authorized${result.error ? `, but the first connection failed: ${result.error}` : result.tools ? `, ${result.tools.length} tools` : ""}`);
    return {
      connector: this.store.get(connector.id) ?? connector,
      ...(target.account ? { account: this.store.getAccount(connector.id, target.account.id) ?? target.account } : {}),
      ...(result.tools ? { toolCount: result.tools.length } : {}), ...(result.error ? { error: result.error } : {}),
    };
  }

  /**
   * Forget the authorization: revoke the tokens when the server supports it (best effort), then delete
   * them. A per-identity connector signs out one account (`account`).
   */
  async disconnect(id: string, account?: string): Promise<void> {
    if (!this.store.get(id)) return;
    const target = this.target(id, account);
    const { connector } = target;
    await this.closeKey(target.key);
    if (connector.auth.type === "oauth") {
      await this.revoke(target).catch((err) => this.log(`${target.key}: revoke failed: ${errorMessage(err)}`));
      await this.secrets.unset(target.service, OAUTH_KEYS.filter((k) => k !== SECRET_KEYS.clientInfo && k !== SECRET_KEYS.discovery));
      // the next sign-in may be another account
      if (target.account) {
        if (target.account.account) this.store.setAccountSignedIn(id, target.account.id, undefined);
      } else if (connector.account) this.store.update(id, { account: undefined });
      this.setTargetStatus(target, "needs_auth", { action: "updated" });
    } else {
      this.setTargetStatus(target, "disconnected", { action: "updated" });
    }
  }

  private async revoke(target: ConnectorTarget): Promise<void> {
    const { connector } = target;
    const secrets = await this.secrets.get(target.service);
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

  /**
   * Remove a connector: close, revoke, delete its secrets and its config (a per-identity connector's
   * accounts too). `revoke: false` keeps the tokens valid at the provider (they moved elsewhere: an
   * import into a per-identity connector).
   */
  async remove(id: string, opts: { revoke?: boolean } = {}): Promise<boolean> {
    const connector = this.store.get(id);
    if (!connector) return false;
    await this.close(id);
    const revoke = opts.revoke !== false && connector.auth.type === "oauth";
    if (revoke && !isIdentityConnector(connector)) await this.revoke({ key: id, connector, service: id }).catch(() => undefined);
    for (const account of connector.accounts ?? []) {
      const target = { key: `${id}#${account.id}`, connector, account, service: connectorAccountService(id, account.id) };
      if (revoke) await this.revoke(target).catch(() => undefined);
      await this.secrets.remove(target.service);
    }
    await this.secrets.remove(id);
    this.store.remove(id);
    this.icons.remove(id);
    this.identityTools.delete(id);
    this.options.emit?.({ id, status: "disconnected", action: "deleted" });
    return true;
  }

  /** Close the connector's connections (every account's, for a per-identity connector). */
  async close(id: string): Promise<void> {
    const keys = [...this.connections.keys()].filter((k) => k === id || k.startsWith(`${id}#`));
    await Promise.all(keys.map((k) => this.closeKey(k)));
  }

  /** Close one connection (a connector's, or one account's). */
  async closeKey(key: string): Promise<void> {
    const connection = this.connections.get(key);
    this.connections.delete(key);
    if (connection) await connection.client.close().catch(() => undefined);
  }

  /** Whether a connection is open for this connector / account (tests, diagnostics). */
  isConnected(id: string, account?: string): boolean {
    return this.connections.has(account ? `${id}#${account}` : id);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((key) => this.closeKey(key)));
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
