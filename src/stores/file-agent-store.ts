import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { AgentConfig } from "../core/types.js";
import type { AgentStore } from "../core/agent-store.js";

/** Persisted agent entry — includes the teamName foreign key. */
interface AgentEntry {
  agent: AgentConfig;
  teamName: string;
}

/**
 * File-based AgentStore.
 * Persists agents as JSON in `.polpo/agents.json`.
 */
export class FileAgentStore implements AgentStore {
  private readonly filePath: string;

  constructor(polpoDir: string) {
    this.filePath = join(polpoDir, "agents.json");
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private readAll(): AgentEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return JSON.parse(readFileSync(this.filePath, "utf-8")) as AgentEntry[];
    } catch {
      return [];
    }
  }

  private writeAll(entries: AgentEntry[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(entries, null, 2), "utf-8");
  }

  // ── AgentStore implementation ────────────────────────────────────────

  async getAgents(teamName?: string): Promise<AgentConfig[]> {
    const entries = this.readAll();
    const filtered = teamName ? entries.filter(e => e.teamName === teamName) : entries;
    return filtered.map(e => e.agent);
  }

  async getAgent(name: string): Promise<AgentConfig | undefined> {
    return this.readAll().find(e => e.agent.name === name)?.agent;
  }

  async getAgentTeam(name: string): Promise<string | undefined> {
    return this.readAll().find(e => e.agent.name === name)?.teamName;
  }

  async createAgent(agent: AgentConfig, teamName: string): Promise<AgentConfig> {
    const entries = this.readAll();
    if (entries.some(e => e.agent.name === agent.name)) {
      throw new Error(`Agent "${agent.name}" already exists`);
    }
    if (!agent.createdAt) agent.createdAt = new Date().toISOString();
    entries.push({ agent, teamName });
    this.writeAll(entries);
    return agent;
  }

  async updateAgent(name: string, updates: Partial<Omit<AgentConfig, "name">>): Promise<AgentConfig> {
    const entries = this.readAll();
    const entry = entries.find(e => e.agent.name === name);
    if (!entry) throw new Error(`Agent "${name}" not found`);
    Object.assign(entry.agent, updates);
    this.writeAll(entries);
    return entry.agent;
  }

  async moveAgent(name: string, newTeamName: string): Promise<AgentConfig> {
    const entries = this.readAll();
    const entry = entries.find(e => e.agent.name === name);
    if (!entry) throw new Error(`Agent "${name}" not found`);
    entry.teamName = newTeamName;
    this.writeAll(entries);
    return entry.agent;
  }

  async deleteAgent(name: string): Promise<boolean> {
    const entries = this.readAll();
    const idx = entries.findIndex(e => e.agent.name === name);
    if (idx < 0) return false;
    entries.splice(idx, 1);
    this.writeAll(entries);
    return true;
  }

  async cleanupVolatileAgents(missionGroup: string): Promise<number> {
    const entries = this.readAll();
    const before = entries.length;
    const filtered = entries.filter(e => !(e.agent.volatile && e.agent.missionGroup === missionGroup));
    if (filtered.length === before) return 0;
    this.writeAll(filtered);
    return before - filtered.length;
  }

  async seed(agents: Array<AgentConfig & { teamName: string }>): Promise<void> {
    const existing = this.readAll();
    const existingNames = new Set(existing.map(e => e.agent.name));
    let changed = false;
    for (const { teamName, ...agent } of agents) {
      if (!existingNames.has(agent.name)) {
        existing.push({ agent: agent as AgentConfig, teamName });
        changed = true;
      }
    }
    if (changed) this.writeAll(existing);
  }
}
