import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Team } from "../core/types.js";
import type { TeamStore } from "../core/team-store.js";

/**
 * File-based TeamStore.
 * Persists teams as JSON in `.polpo/teams.json`.
 */
export class FileTeamStore implements TeamStore {
  private readonly filePath: string;

  constructor(polpoDir: string) {
    this.filePath = join(polpoDir, "teams.json");
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private readAll(): Team[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return JSON.parse(readFileSync(this.filePath, "utf-8")) as Team[];
    } catch {
      return [];
    }
  }

  private writeAll(teams: Team[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(teams, null, 2), "utf-8");
  }

  // ── TeamStore implementation ─────────────────────────────────────────

  async getTeams(): Promise<Team[]> {
    return this.readAll();
  }

  async getTeam(name: string): Promise<Team | undefined> {
    return this.readAll().find(t => t.name === name);
  }

  async createTeam(team: Team): Promise<Team> {
    const teams = this.readAll();
    if (teams.some(t => t.name === team.name)) {
      throw new Error(`Team "${team.name}" already exists`);
    }
    teams.push(team);
    this.writeAll(teams);
    return team;
  }

  async updateTeam(name: string, updates: Partial<Omit<Team, "name" | "agents">>): Promise<Team> {
    const teams = this.readAll();
    const team = teams.find(t => t.name === name);
    if (!team) throw new Error(`Team "${name}" not found`);
    if (updates.description !== undefined) team.description = updates.description;
    this.writeAll(teams);
    return team;
  }

  async renameTeam(oldName: string, newName: string): Promise<Team> {
    const teams = this.readAll();
    const team = teams.find(t => t.name === oldName);
    if (!team) throw new Error(`Team "${oldName}" not found`);
    if (teams.some(t => t.name === newName)) {
      throw new Error(`Team "${newName}" already exists`);
    }
    team.name = newName;
    this.writeAll(teams);
    return team;
  }

  async deleteTeam(name: string): Promise<boolean> {
    const teams = this.readAll();
    const idx = teams.findIndex(t => t.name === name);
    if (idx < 0) return false;
    teams.splice(idx, 1);
    this.writeAll(teams);
    return true;
  }

  async seed(teams: Team[]): Promise<void> {
    const existing = this.readAll();
    const existingNames = new Set(existing.map(t => t.name));
    let changed = false;
    for (const team of teams) {
      if (!existingNames.has(team.name)) {
        // Seed the team without its agents (agents live in AgentStore)
        existing.push({ name: team.name, description: team.description, agents: [] });
        changed = true;
      }
    }
    if (changed) this.writeAll(existing);
  }
}
