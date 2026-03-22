import { eq, and } from "drizzle-orm";
import type { AgentStore } from "@polpo-ai/core/agent-store";
import type { AgentConfig } from "@polpo-ai/core/types";
import { type Dialect, serializeJson, deserializeJson } from "../utils.js";

type AnyTable = any;

export class DrizzleAgentStore implements AgentStore {
  constructor(
    private db: any,
    private agentsTable: AnyTable,
    private dialect: Dialect,
  ) {}

  async getAgents(teamName?: string): Promise<AgentConfig[]> {
    const rows: any[] = teamName
      ? await this.db.select().from(this.agentsTable).where(eq(this.agentsTable.teamName, teamName))
      : await this.db.select().from(this.agentsTable);
    return rows.map(r => this.rowToAgent(r));
  }

  async getAgent(name: string): Promise<AgentConfig | undefined> {
    const rows: any[] = await this.db.select().from(this.agentsTable)
      .where(eq(this.agentsTable.name, name));
    if (rows.length === 0) return undefined;
    return this.rowToAgent(rows[0]);
  }

  async getAgentTeam(name: string): Promise<string | undefined> {
    const rows: any[] = await this.db.select().from(this.agentsTable)
      .where(eq(this.agentsTable.name, name));
    if (rows.length === 0) return undefined;
    return rows[0].teamName;
  }

  async createAgent(agent: AgentConfig, teamName: string): Promise<AgentConfig> {
    const now = new Date().toISOString();
    if (!agent.createdAt) agent.createdAt = now;

    const { name, ...rest } = agent;
    try {
      await this.db.insert(this.agentsTable).values({
        name,
        teamName,
        config: serializeJson(rest, this.dialect),
        createdAt: agent.createdAt,
        updatedAt: now,
      });
    } catch (err: any) {
      if (err?.message?.includes("unique") || err?.message?.includes("UNIQUE") || err?.code === "23505") {
        throw new Error(`Agent "${name}" already exists`);
      }
      throw err;
    }
    return agent;
  }

  async updateAgent(name: string, updates: Partial<Omit<AgentConfig, "name">>): Promise<AgentConfig> {
    const existing = await this.getAgent(name);
    if (!existing) throw new Error(`Agent "${name}" not found`);

    const merged = { ...existing, ...updates, name };
    const { name: _n, ...rest } = merged;
    const now = new Date().toISOString();

    await this.db.update(this.agentsTable).set({
      config: serializeJson(rest, this.dialect),
      updatedAt: now,
    }).where(eq(this.agentsTable.name, name));

    return merged;
  }

  async moveAgent(name: string, newTeamName: string): Promise<AgentConfig> {
    const existing = await this.getAgent(name);
    if (!existing) throw new Error(`Agent "${name}" not found`);

    await this.db.update(this.agentsTable).set({
      teamName: newTeamName,
      updatedAt: new Date().toISOString(),
    }).where(eq(this.agentsTable.name, name));

    return existing;
  }

  async deleteAgent(name: string): Promise<boolean> {
    const rows: any[] = await this.db.select().from(this.agentsTable)
      .where(eq(this.agentsTable.name, name));
    if (rows.length === 0) return false;
    await this.db.delete(this.agentsTable).where(eq(this.agentsTable.name, name));
    return true;
  }

  async cleanupVolatileAgents(missionGroup: string): Promise<number> {
    // We need to read agents, filter volatile ones with matching group, then delete
    const rows: any[] = await this.db.select().from(this.agentsTable);
    const toDelete: string[] = [];
    for (const row of rows) {
      const cfg = deserializeJson<Record<string, unknown>>(row.config, {}, this.dialect);
      if (cfg.volatile && cfg.missionGroup === missionGroup) {
        toDelete.push(row.name);
      }
    }
    for (const name of toDelete) {
      await this.db.delete(this.agentsTable).where(eq(this.agentsTable.name, name));
    }
    return toDelete.length;
  }

  async seed(agents: Array<AgentConfig & { teamName: string }>): Promise<void> {
    for (const { teamName, ...agent } of agents) {
      const existing = await this.getAgent(agent.name);
      if (!existing) {
        await this.createAgent(agent as AgentConfig, teamName);
      }
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private rowToAgent(row: any): AgentConfig {
    const cfg = deserializeJson<Record<string, unknown>>(row.config, {}, this.dialect);
    const agent = { name: row.name, ...cfg } as AgentConfig & { teamName?: string };
    if (row.teamName) agent.teamName = row.teamName;
    return agent;
  }
}
