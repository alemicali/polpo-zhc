import { eq } from "drizzle-orm";
import type { TeamStore } from "@polpo-ai/core/team-store";
import type { Team, AgentConfig } from "@polpo-ai/core/types";
import { type Dialect, deserializeJson } from "../utils.js";

type AnyTable = any;

export class DrizzleTeamStore implements TeamStore {
  constructor(
    private db: any,
    private teamsTable: AnyTable,
    private agentsTable: AnyTable,
    private dialect: Dialect,
  ) {}

  async getTeams(): Promise<Team[]> {
    const rows: any[] = await this.db.select().from(this.teamsTable);
    const agentRows: any[] = await this.db.select().from(this.agentsTable);

    return rows.map(r => ({
      name: r.name,
      description: r.description ?? undefined,
      agents: agentRows
        .filter((a: any) => a.teamName === r.name)
        .map((a: any) => this.rowToAgent(a)),
    }));
  }

  async getTeam(name: string): Promise<Team | undefined> {
    const rows: any[] = await this.db.select().from(this.teamsTable)
      .where(eq(this.teamsTable.name, name));
    if (rows.length === 0) return undefined;
    const r = rows[0];

    const agentRows: any[] = await this.db.select().from(this.agentsTable)
      .where(eq(this.agentsTable.teamName, name));

    return {
      name: r.name,
      description: r.description ?? undefined,
      agents: agentRows.map((a: any) => this.rowToAgent(a)),
    };
  }

  async createTeam(team: Team): Promise<Team> {
    const now = new Date().toISOString();
    try {
      await this.db.insert(this.teamsTable).values({
        name: team.name,
        description: team.description ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err: any) {
      if (err?.message?.includes("unique") || err?.message?.includes("UNIQUE") || err?.code === "23505") {
        throw new Error(`Team "${team.name}" already exists`);
      }
      throw err;
    }
    return { ...team, agents: [] };
  }

  async updateTeam(name: string, updates: Partial<Omit<Team, "name" | "agents">>): Promise<Team> {
    const now = new Date().toISOString();
    const set: Record<string, unknown> = { updatedAt: now };
    if (updates.description !== undefined) set.description = updates.description;

    await this.db.update(this.teamsTable).set(set).where(eq(this.teamsTable.name, name));
    const team = await this.getTeam(name);
    if (!team) throw new Error(`Team "${name}" not found`);
    return team;
  }

  async renameTeam(oldName: string, newName: string): Promise<Team> {
    // Check target doesn't exist
    const existing = await this.getTeam(newName);
    if (existing) throw new Error(`Team "${newName}" already exists`);

    const now = new Date().toISOString();

    // Update the team row
    await this.db.update(this.teamsTable).set({ name: newName, updatedAt: now })
      .where(eq(this.teamsTable.name, oldName));

    // Update all agent foreign keys
    await this.db.update(this.agentsTable).set({ teamName: newName, updatedAt: now })
      .where(eq(this.agentsTable.teamName, oldName));

    const team = await this.getTeam(newName);
    if (!team) throw new Error(`Team "${oldName}" not found`);
    return team;
  }

  async deleteTeam(name: string): Promise<boolean> {
    const rows: any[] = await this.db.select().from(this.teamsTable)
      .where(eq(this.teamsTable.name, name));
    if (rows.length === 0) return false;

    // Delete agents in this team first
    await this.db.delete(this.agentsTable).where(eq(this.agentsTable.teamName, name));
    await this.db.delete(this.teamsTable).where(eq(this.teamsTable.name, name));
    return true;
  }

  async seed(teams: Team[]): Promise<void> {
    for (const team of teams) {
      const existing = await this.getTeam(team.name);
      if (!existing) {
        await this.createTeam({ name: team.name, description: team.description, agents: [] });
      }
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private rowToAgent(row: any): AgentConfig {
    const cfg = deserializeJson<Record<string, unknown>>(row.config, {}, this.dialect);
    return { name: row.name, ...cfg } as AgentConfig;
  }
}
