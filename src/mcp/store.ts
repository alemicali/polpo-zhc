/**
 * `.polpo/connectors.json`: the connectors' configuration (no secrets) and the shared OAuth apps'
 * client ids. Read fresh on every call (it is small and other processes, such as task runners,
 * read it too) and written atomically (temp file + rename).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConnectorConfig, ConnectorOAuthApp, ConnectorsFile, ConnectorStatus } from "@polpo-ai/core";

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
