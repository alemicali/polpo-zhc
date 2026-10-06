/**
 * Destinations the network rule refused, kept in memory (the last ~100) so Settings → Sandbox
 * can show them and offer to allow one. Entries are per workspace and destination; the list
 * merges them per agent.
 */
import type { NetworkDenialReason } from "./net-proxy.js";

export interface NetworkDeniedReport {
  workspaceId?: string;
  provider: string;
  scope: "chat" | "task";
  taskId?: string;
  agentName?: string;
  host: string;
  port?: number;
  reason: NetworkDenialReason;
}

export interface NetworkDeniedEntry {
  agentName?: string;
  scope: "chat" | "task";
  host: string;
  port?: number;
  reason: NetworkDenialReason;
  count: number;
  lastAt: string;
}

const MAX_ENTRIES = 100;

export class NetworkDeniedLog {
  private entries = new Map<string, NetworkDeniedEntry & { workspaceId?: string }>();

  /** Count a refusal. Returns true the first time a workspace is refused this host:port (the caller emits the event then). */
  record(report: NetworkDeniedReport, now = new Date()): boolean {
    const key = `${report.workspaceId ?? report.agentName ?? ""}|${report.host}|${report.port ?? ""}|${report.reason}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.count++;
      existing.lastAt = now.toISOString();
      // most recent last, so the oldest is evicted first
      this.entries.delete(key);
      this.entries.set(key, existing);
      return false;
    }
    this.entries.set(key, {
      workspaceId: report.workspaceId, agentName: report.agentName, scope: report.scope, host: report.host,
      ...(report.port !== undefined ? { port: report.port } : {}), reason: report.reason, count: 1, lastAt: now.toISOString(),
    });
    if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    return true;
  }

  /** Newest first, one row per agent and destination. */
  list(): NetworkDeniedEntry[] {
    const merged = new Map<string, NetworkDeniedEntry>();
    for (const { workspaceId: _ignored, ...entry } of this.entries.values()) {
      const key = `${entry.agentName ?? ""}|${entry.host}|${entry.port ?? ""}|${entry.reason}`;
      const row = merged.get(key);
      if (!row) merged.set(key, { ...entry });
      else { row.count += entry.count; if (entry.lastAt > row.lastAt) row.lastAt = entry.lastAt; }
    }
    return [...merged.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  }

  clear(): void { this.entries.clear(); }
}
