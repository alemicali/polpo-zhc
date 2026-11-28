/**
 * Accounts of per-identity connectors (scope "identity"): the connector is defined once for the
 * organization, and each identity (an agent, a person chatting with Polpo, or the organization for
 * the optional fallback) connects one or more accounts to it, each with a label, its own credentials
 * (vault `$connectors` / `<connector>~<account>`, never shown to agents) and its own connection state.
 *
 * Also the opt-in conversion of separate connectors of the same app (gmail, gmail-2, mail-nina…)
 * into accounts of one per-identity connector (`importConnectorAccount`): the source's credentials
 * move to the account, the source is removed (or turned off). Nothing converts by itself.
 */
import { randomBytes } from "node:crypto";
import {
  CONNECTOR_ACCOUNT_LABEL_PATTERN, ORG_CONNECTOR_IDENTITY, connectorAccountAllowed, connectorAccountService, connectorIdentityLabel,
  connectorOwner, isIdentityConnector, parseConnectorIdentity, personConnectorIdentity,
  type ConnectorAccount, type ConnectorConfig, type ConnectorIdentity,
} from "@polpo-ai/core";
import type { ConnectorManager } from "./manager.js";
import { SECRET_KEYS } from "./secrets.js";
import { ConnectorInputError, type ConnectorSecretsInput } from "./validate.js";

const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;

export interface ConnectorAccountInput {
  /** "agent:<name>", "person:<email>", "org" (the fallback account), or "me" (the person calling). */
  identity?: string;
  label?: string;
  /** Make it the identity's default account. */
  default?: boolean;
  /** Write-only credentials (token-based connectors): the account's token or header values. */
  secrets?: Pick<ConnectorSecretsInput, "bearerToken" | "headers">;
}

export interface ConnectorAccountImportInput {
  /** The connector to convert into an account (another connector of the same app). */
  from?: string;
  /** Whose account it becomes; default: the source's owner (an agent-scoped connector). */
  identity?: string;
  /** Default: the source's signed-in account, else its name. */
  label?: string;
  default?: boolean;
  /** true (default): delete the source connector (its tokens are not revoked: they moved); false: turn it off. */
  removeSource?: boolean;
}

export interface AccountContext {
  manager: ConnectorManager;
  /** The workspace's agents, when known: an agent identity must name one. */
  agentNames?: string[];
  /** The person calling (their email), for identity "me". */
  me?: string;
}

/** An identity from input ("me" = the person calling); throws ConnectorInputError when invalid. */
export function normalizeIdentity(value: unknown, ctx: Pick<AccountContext, "agentNames" | "me">): ConnectorIdentity {
  if (value === "me") return personConnectorIdentity(ctx.me);
  const parsed = parseConnectorIdentity(value);
  if (!parsed) throw new ConnectorInputError('identity must be "agent:<name>", "person:<email>", "org" (the fallback account) or "me"');
  if (parsed.kind === "agent") {
    if (ctx.agentNames && !ctx.agentNames.includes(parsed.agent)) throw new ConnectorInputError(`identity: there is no agent "${parsed.agent}"`);
    return `agent:${parsed.agent}`;
  }
  return parsed.kind === "org" ? ORG_CONNECTOR_IDENTITY : `person:${parsed.email}`;
}

function normalizeLabel(value: unknown): string {
  const label = typeof value === "string" ? value.trim() : "";
  if (!CONNECTOR_ACCOUNT_LABEL_PATTERN.test(label)) throw new ConnectorInputError("label: 1–64 characters, letters, digits, spaces and . _ @ + - (e.g. \"sitoinchat\", \"personale\")");
  return label;
}

function identityConnector(manager: ConnectorManager, id: string): ConnectorConfig {
  const connector = manager.store.get(id);
  if (!connector) throw new ConnectorInputError(`No connector "${id}"`);
  if (!isIdentityConnector(connector)) throw new ConnectorInputError(`${connector.name} is not per identity: it has no accounts (make a per-identity connector and import it as an account)`);
  if (connector.transport.type === "hosted") throw new ConnectorInputError("A server Polpo hosts cannot be per identity");
  return connector;
}

function assertAllowed(connector: ConnectorConfig, identity: ConnectorIdentity): void {
  if (connectorAccountAllowed(connector, identity)) return;
  const p = parseConnectorIdentity(identity);
  throw new ConnectorInputError(p?.kind === "person"
    ? `People cannot connect accounts to ${connector.name}: turn on "Polpo may use it" (access.polpo) first`
    : `${connectorIdentityLabel(identity)} may not use ${connector.name}: add it to the connector's agents first`);
}

function assertUniqueLabel(connector: ConnectorConfig, identity: ConnectorIdentity, label: string, except?: string): void {
  const taken = (connector.accounts ?? []).some((a) => a.identity === identity && a.id !== except && a.label.toLowerCase() === label.toLowerCase());
  if (taken) throw new ConnectorInputError(`${connectorIdentityLabel(identity)} already has an account "${label}" on ${connector.name}`);
}

/** The account secrets from input: vault key → value ("" removes); token / headers only. */
function accountSecretValues(connector: ConnectorConfig, input: ConnectorAccountInput["secrets"]): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  if (!input) return values;
  if (input.bearerToken !== undefined) {
    if (connector.auth.type !== "bearer") throw new ConnectorInputError(`${connector.name} does not sign in with a token`);
    values[SECRET_KEYS.bearer] = String(input.bearerToken).trim();
  }
  if (input.headers !== undefined) {
    if (connector.auth.type !== "headers") throw new ConnectorInputError(`${connector.name} does not sign in with headers`);
    if (!input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) throw new ConnectorInputError("secrets.headers must be an object");
    const allowed = connector.auth.headerNames ?? [];
    for (const [name, value] of Object.entries(input.headers)) {
      if (!HEADER_NAME.test(name) || typeof value !== "string") throw new ConnectorInputError(`secrets.headers: invalid header "${name}"`);
      if (allowed.length && !allowed.includes(name)) throw new ConnectorInputError(`secrets.headers: ${connector.name} takes ${allowed.join(", ")}`);
      values[SECRET_KEYS.header(name)] = value;
    }
  }
  return values;
}

/** Defaults: exactly one default per identity that has accounts (`preferred` wins when given). */
function withDefaults(accounts: ConnectorAccount[], identity: ConnectorIdentity, preferred?: string): ConnectorAccount[] {
  const own = accounts.filter((a) => a.identity === identity);
  const chosen = preferred ?? own.find((a) => a.default)?.id ?? own[0]?.id;
  return accounts.map((a) => {
    if (a.identity !== identity) return a;
    const { default: _d, ...rest } = a;
    return a.id === chosen ? { ...rest, default: true } : rest;
  });
}

function newAccountId(connector: ConnectorConfig): string {
  let id: string;
  do id = `acc-${randomBytes(5).toString("hex")}`;
  while ((connector.accounts ?? []).some((a) => a.id === id));
  return id;
}

/** Add an account to a per-identity connector (OAuth ones then sign in: startOAuth with the account). */
export async function addConnectorAccount(ctx: AccountContext, id: string, input: ConnectorAccountInput): Promise<ConnectorAccount> {
  const { manager } = ctx;
  const connector = identityConnector(manager, id);
  const identity = normalizeIdentity(input.identity, ctx);
  assertAllowed(connector, identity);
  const label = normalizeLabel(input.label);
  assertUniqueLabel(connector, identity, label);
  const secrets = accountSecretValues(connector, input.secrets);
  if (Object.values(secrets).some(Boolean) && !manager.secrets.available) throw new ConnectorInputError("The vault is not available: cannot store the account's secrets");
  const account: ConnectorAccount = {
    id: newAccountId(connector), identity, label, createdAt: new Date().toISOString(),
    status: connector.auth.type === "oauth" ? "needs_auth" : "disconnected",
  };
  const first = !(connector.accounts ?? []).some((a) => a.identity === identity);
  manager.store.updateAccounts(id, (accounts) => withDefaults([...accounts, account], identity, first || input.default ? account.id : undefined));
  if (Object.keys(secrets).length) await manager.secrets.patch(connectorAccountService(id, account.id), secrets);
  manager.announce(id, "updated");
  return manager.store.getAccount(id, account.id)!;
}

/** Rename an account, make it its identity's default, or change its token / header values. */
export async function updateConnectorAccount(ctx: AccountContext, id: string, accountId: string, input: Omit<ConnectorAccountInput, "identity">): Promise<ConnectorAccount> {
  const { manager } = ctx;
  const connector = identityConnector(manager, id);
  const current = connector.accounts?.find((a) => a.id === accountId);
  if (!current) throw new ConnectorInputError(`${connector.name} has no account "${accountId}"`);
  if ((input as { identity?: unknown }).identity !== undefined && (input as { identity?: unknown }).identity !== current.identity) {
    throw new ConnectorInputError("An account's identity cannot change: add one for the other identity");
  }
  const label = input.label !== undefined ? normalizeLabel(input.label) : undefined;
  if (label) assertUniqueLabel(connector, current.identity, label, accountId);
  if (input.default === false) throw new ConnectorInputError("Make another account the default instead (default: true on it)");
  const secrets = accountSecretValues(connector, input.secrets);
  if (Object.values(secrets).some(Boolean) && !manager.secrets.available) throw new ConnectorInputError("The vault is not available: cannot store the account's secrets");
  manager.store.updateAccounts(id, (accounts) => {
    const next = accounts.map((a) => (a.id === accountId ? { ...a, ...(label ? { label } : {}), updatedAt: new Date().toISOString() } : a));
    return input.default === true ? withDefaults(next, current.identity, accountId) : next;
  });
  if (Object.keys(secrets).length) {
    await manager.secrets.patch(connectorAccountService(id, accountId), secrets);
    await manager.closeKey(`${id}#${accountId}`);
  }
  manager.announce(id, "updated");
  return manager.store.getAccount(id, accountId)!;
}

/** Remove an account: close, revoke (OAuth, best effort), delete its secrets; the identity's next account becomes the default. */
export async function removeConnectorAccount(ctx: AccountContext, id: string, accountId: string): Promise<boolean> {
  const { manager } = ctx;
  const connector = identityConnector(manager, id);
  const account = connector.accounts?.find((a) => a.id === accountId);
  if (!account) return false;
  if (connector.auth.type === "oauth") await manager.disconnect(id, accountId).catch(() => undefined);
  await manager.closeKey(`${id}#${accountId}`);
  await manager.secrets.remove(connectorAccountService(id, accountId));
  manager.store.updateAccounts(id, (accounts) => withDefaults(accounts.filter((a) => a.id !== accountId), account.identity));
  manager.announce(id, "updated");
  return true;
}

/** The secret keys an imported connector's credentials move with (never a pending authorization's state). */
const MOVABLE = (key: string) => key === SECRET_KEYS.bearer || key.startsWith("header:") || key.startsWith("secret:")
  || key === SECRET_KEYS.tokens || key === SECRET_KEYS.clientInfo || key === SECRET_KEYS.discovery || key === SECRET_KEYS.redirectUri;

const sameServer = (a: ConnectorConfig, b: ConnectorConfig) => {
  if (a.catalogId && b.catalogId) return a.catalogId === b.catalogId;
  const norm = (u?: string) => u?.replace(/\/+$/, "").toLowerCase();
  return !!a.transport.url && norm(a.transport.url) === norm(b.transport.url);
};

export interface ConnectorAccountImportResult {
  account: ConnectorAccount;
  /** What happened to the source connector. */
  source: { id: string; removed: boolean; disabled: boolean };
  /** Tool names change: skills, playbooks and tool selections that named the source's tools now use the per-identity connector's. */
  renamed: { from: string; to: string };
}

/**
 * Convert a separate connector of the same app (gmail-2, mail-nina…) into an account of a per-identity
 * connector: its credentials (tokens, registered client, token / header values) move to the new
 * account, which keeps its signed-in identity and state; the source is then deleted without revoking
 * (removeSource, the default) or turned off. Explicit and opt-in: nothing converts by itself.
 */
export async function importConnectorAccount(ctx: AccountContext, id: string, input: ConnectorAccountImportInput): Promise<ConnectorAccountImportResult> {
  const { manager } = ctx;
  const target = identityConnector(manager, id);
  const fromId = typeof input.from === "string" ? input.from.trim() : "";
  if (!fromId) throw new ConnectorInputError("from: the connector to import is required");
  if (fromId === id) throw new ConnectorInputError("A connector cannot be imported into itself");
  const source = manager.store.get(fromId);
  if (!source) throw new ConnectorInputError(`No connector "${fromId}"`);
  if (isIdentityConnector(source)) throw new ConnectorInputError(`${source.name} is per identity itself: move its accounts one by one instead`);
  if (source.transport.type === "hosted" || source.transport.type === "stdio") throw new ConnectorInputError(`${source.name} runs locally / is hosted: only remote connectors can be imported`);
  if (!sameServer(source, target)) throw new ConnectorInputError(`${source.name} is not the same app as ${target.name} (another server): only connectors of the same app can become its accounts`);
  if (source.auth.type !== target.auth.type) throw new ConnectorInputError(`${source.name} signs in with ${source.auth.type}, ${target.name} with ${target.auth.type}`);
  if (target.auth.type === "oauth" && ((source.auth.oauth?.clientId ?? "") !== (target.auth.oauth?.clientId ?? "") || (source.auth.oauth?.app ?? "") !== (target.auth.oauth?.app ?? ""))) {
    throw new ConnectorInputError(`${source.name} was authorized with another OAuth client than ${target.name}: its tokens would not refresh there. Connect the account again instead`);
  }
  const owner = connectorOwner(source);
  const identity = input.identity !== undefined ? normalizeIdentity(input.identity, ctx) : owner ? `agent:${owner}` : undefined;
  if (!identity) throw new ConnectorInputError(`identity: say whose account ${source.name} becomes ("agent:<name>", "person:<email>" or "org" for the fallback)`);
  assertAllowed(target, identity);
  const label = normalizeLabel(input.label ?? source.account ?? source.name);
  assertUniqueLabel(target, identity, label);
  const secrets = Object.fromEntries(Object.entries(await manager.secrets.get(fromId)).filter(([k]) => MOVABLE(k)));
  if (Object.keys(secrets).length && !manager.secrets.available) throw new ConnectorInputError("The vault is not available: cannot move the credentials");
  const account: ConnectorAccount = {
    id: newAccountId(target), identity, label, createdAt: new Date().toISOString(), importedFrom: fromId,
    ...(source.account ? { account: source.account } : {}),
    status: secrets[SECRET_KEYS.tokens] || secrets[SECRET_KEYS.bearer] || Object.keys(secrets).some((k) => k.startsWith("header:"))
      ? (source.status === "connected" ? "connected" : "disconnected")
      : target.auth.type === "oauth" ? "needs_auth" : "disconnected",
    ...(source.toolCount !== undefined ? { toolCount: source.toolCount } : {}),
  };
  const first = !(target.accounts ?? []).some((a) => a.identity === identity);
  // the source stops first: nothing refreshes its tokens while they move
  await manager.close(fromId);
  if (Object.keys(secrets).length) await manager.secrets.patch(connectorAccountService(id, account.id), secrets);
  manager.store.updateAccounts(id, (accounts) => withDefaults([...accounts, account], identity, first || input.default ? account.id : undefined));
  const removeSource = input.removeSource !== false;
  if (removeSource) await manager.remove(fromId, { revoke: false });
  else {
    manager.store.update(fromId, { enabled: false });
    manager.setStatus(fromId, "disabled", { action: "updated" });
  }
  manager.announce(id, "updated");
  return {
    account: manager.store.getAccount(id, account.id)!,
    source: { id: fromId, removed: removeSource, disabled: !removeSource },
    renamed: { from: `mcp__${fromId}__*`, to: `mcp__${id}__* (account "${label}")` },
  };
}
