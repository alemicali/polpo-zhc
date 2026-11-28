/**
 * `.polpo/connectors.json`: the connectors' configuration (no secrets) and the shared OAuth apps'
 * client ids. Read fresh on every call (it is small and other processes, such as task runners,
 * read it too) and written atomically (temp file + rename).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConnectorAccount, ConnectorConfig, ConnectorIconAsset,ConnectorOAuthApp, ConnectorsFile, ConnectorStatus } from "@polpo-ai/core";

export class ConnectorStore {
  readonly file: string;

  constructor(polpoDir: string) {
    this.file = join(polpoDir, "connectors.json");
  }

  read(): ConnectorsFile {
    if (!existsSync(this.file)) return { connectors: [], oauthApps: [] };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<ConnectorsFile>;
      return {
        connectors: Array.isArray(raw.connectors) ? raw.connectors : [],
        oauthApps: Array.isArray(raw.oauthApps) ? raw.oauthApps : [],
      };
    } catch {
      return { connectors: [], oauthApps: [] };
    }
  }

  private write(data: ConnectorsFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list(): ConnectorConfig[] {
    return this.read().connectors;
  }

  get(id: string): ConnectorConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  create(connector: ConnectorConfig): ConnectorConfig {
    const data = this.read();
    if (data.connectors.some((c) => c.id === connector.id)) throw new Error(`A connector "${connector.id}" already exists`);
    data.connectors.push(connector);
    this.write(data);
    return connector;
  }

  update(id: string, patch: Partial<ConnectorConfig>): ConnectorConfig {
    const data = this.read();
    const index = data.connectors.findIndex((c) => c.id === id);
    if (index < 0) throw new Error(`No connector "${id}"`);
    const next = { ...data.connectors[index]!, ...patch, id, updatedAt: new Date().toISOString() };
    data.connectors[index] = next;
    this.write(data);
    return next;
  }

  /** Cached connection state (does not touch updatedAt). */
  setStatus(id: string, state: { status: ConnectorStatus; lastError?: string; toolCount?: number; lastConnectedAt?: string }): ConnectorConfig | undefined {
    const data = this.read();
    const current = data.connectors.find((c) => c.id === id);
    if (!current) return undefined;
    current.status = state.status;
    if (state.lastError) current.lastError = state.lastError.slice(0, 500);
    else delete current.lastError;
    if (state.toolCount !== undefined) current.toolCount = state.toolCount;
    if (state.lastConnectedAt) current.lastConnectedAt = state.lastConnectedAt;
    this.write(data);
    return current;
  }

  // ── per-identity connectors: accounts ──

  getAccount(id: string, accountId: string): ConnectorAccount | undefined {
    return this.get(id)?.accounts?.find((a) => a.id === accountId);
  }

  /** Replace a connector's accounts with `change(accounts)` (touches the connector's updatedAt). */
  updateAccounts(id: string, change: (accounts: ConnectorAccount[]) => ConnectorAccount[]): ConnectorConfig {
    const data = this.read();
    const current = data.connectors.find((c) => c.id === id);
    if (!current) throw new Error(`No connector "${id}"`);
    const next = change([...(current.accounts ?? [])]);
    if (next.length) current.accounts = next;
    else delete current.accounts;
    current.updatedAt = new Date().toISOString();
    this.write(data);
    return current;
  }

  /** An account's cached connection state (does not touch updatedAt). */
  setAccountStatus(id: string, accountId: string, state: { status: ConnectorStatus; lastError?: string; toolCount?: number; lastConnectedAt?: string }): ConnectorAccount | undefined {
    const data = this.read();
    const account = data.connectors.find((c) => c.id === id)?.accounts?.find((a) => a.id === accountId);
    if (!account) return undefined;
    account.status = state.status;
    if (state.lastError) account.lastError = state.lastError.slice(0, 500);
    else delete account.lastError;
    if (state.toolCount !== undefined) account.toolCount = state.toolCount;
    if (state.lastConnectedAt) account.lastConnectedAt = state.lastConnectedAt;
    this.write(data);
    return account;
  }

  /** An account's signed-in identity (e.g. its email); undefined forgets it (does not touch updatedAt). */
  setAccountSignedIn(id: string, accountId: string, signedIn: string | undefined): void {
    const data = this.read();
    const account = data.connectors.find((c) => c.id === id)?.accounts?.find((a) => a.id === accountId);
    if (!account) return;
    if (signedIn) account.account = signedIn;
    else delete account.account;
    this.write(data);
  }

  /** The custom connector's icon metadata and when discovery last ran (does not touch updatedAt). */
  setIcon(id: string, asset: ConnectorIconAsset | undefined, checkedAt: string): ConnectorConfig | undefined {
    const data = this.read();
    const current = data.connectors.find((c) => c.id === id);
    if (!current) return undefined;
    if (asset) current.iconAsset = asset;
    else delete current.iconAsset;
    current.iconCheckedAt = checkedAt;
    this.write(data);
    return current;
  }

  remove(id: string): boolean {
    const data = this.read();
    const before = data.connectors.length;
    data.connectors = data.connectors.filter((c) => c.id !== id);
    if (data.connectors.length === before) return false;
    this.write(data);
    return true;
  }

  listOAuthApps(): ConnectorOAuthApp[] {
    return this.read().oauthApps ?? [];
  }

  getOAuthApp(id: string): ConnectorOAuthApp | undefined {
    return this.listOAuthApps().find((a) => a.id === id);
  }

  upsertOAuthApp(app: Omit<ConnectorOAuthApp, "createdAt" | "updatedAt">): ConnectorOAuthApp {
    const data = this.read();
    const apps = data.oauthApps ?? [];
    const existing = apps.find((a) => a.id === app.id);
    const now = new Date().toISOString();
    const next: ConnectorOAuthApp = existing ? { ...existing, ...app, updatedAt: now } : { ...app, createdAt: now };
    data.oauthApps = [...apps.filter((a) => a.id !== app.id), next];
    this.write(data);
    return next;
  }

  removeOAuthApp(id: string): boolean {
    const data = this.read();
    const before = data.oauthApps?.length ?? 0;
    data.oauthApps = (data.oauthApps ?? []).filter((a) => a.id !== id);
    if (data.oauthApps.length === before) return false;
    this.write(data);
    return true;
  }
}
