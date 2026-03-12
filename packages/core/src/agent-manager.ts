import type { OrchestratorContext } from "./orchestrator-context.js";
import type { AgentConfig, Team } from "./types.js";

/**
 * Manages multi-team agent topology: CRUD operations on teams and agents,
 * volatile (mission-tied) agents.
 *
 * All persistence goes through TeamStore / AgentStore — no more dual-write
 * to config + TaskStore.  The in-memory `config.teams` cache is kept in sync
 * so existing callers that read `config.teams` still work during migration.
 */
export class AgentManager {
  constructor(private ctx: OrchestratorContext) {}

  // ── Internal: sync in-memory cache ────────────────────────────────

  /** Refresh the in-memory `config.teams` from the stores. */
  async syncConfigCache(): Promise<void> {
    const teams = await this.ctx.teamStore.getTeams();
    // Each team from TeamStore already contains its agents via the store's join.
    // But for file-based stores, TeamStore stores teams without agents —
    // agents come from AgentStore. Rebuild the full Team[] shape.
    const allAgents = await this.ctx.agentStore.getAgents();
    const agentsByTeam = new Map<string, AgentConfig[]>();
    for (const agent of allAgents) {
      const teamName = await this.ctx.agentStore.getAgentTeam(agent.name);
      if (teamName) {
        const list = agentsByTeam.get(teamName) ?? [];
        list.push(agent);
        agentsByTeam.set(teamName, list);
      }
    }
    this.ctx.config.teams = teams.map(t => ({
      ...t,
      agents: agentsByTeam.get(t.name) ?? [],
    }));
  }

  // ── Internal: hydrate teams with agents ────────────────────────────

  /** Build a full Team with its agents array populated from AgentStore. */
  private async hydrateTeam(team: Team): Promise<Team> {
    const agents = await this.ctx.agentStore.getAgents(team.name);
    return { ...team, agents };
  }

  // ── Team-level operations ──────────────────────────────────────────

  async getTeams(): Promise<Team[]> {
    const teams = await this.ctx.teamStore.getTeams();
    return Promise.all(teams.map(t => this.hydrateTeam(t)));
  }

  async getTeam(name?: string): Promise<Team | undefined> {
    let team: Team | undefined;
    if (!name) {
      const teams = await this.ctx.teamStore.getTeams();
      team = teams[0];
    } else {
      team = await this.ctx.teamStore.getTeam(name);
    }
    return team ? this.hydrateTeam(team) : undefined;
  }

  /** Get the default (first) team, creating one if none exist. */
  async getDefaultTeam(): Promise<Team> {
    const teams = await this.ctx.teamStore.getTeams();
    if (teams.length === 0) {
      return this.ctx.teamStore.createTeam({ name: "default", agents: [] });
    }
    return teams[0]; // No need to hydrate — used for team identity only
  }

  async addTeam(team: Team): Promise<void> {
    // Extract agents from the team — they go to AgentStore separately
    const { agents, ...teamData } = team;
    await this.ctx.teamStore.createTeam({ ...teamData, agents: [] });

    // Add any agents that came with the team definition
    for (const agent of agents ?? []) {
      await this.ctx.agentStore.createAgent(agent, team.name);
    }

    await this.syncConfigCache();
    this.ctx.emitter.emit("log", { level: "info", message: `Team added: ${team.name}` });
  }

  async removeTeam(name: string): Promise<boolean> {
    const teams = await this.ctx.teamStore.getTeams();
    if (teams.length <= 1 && teams[0]?.name === name) {
      throw new Error("Cannot remove the last team");
    }
    const deleted = await this.ctx.teamStore.deleteTeam(name);
    if (deleted) {
      await this.syncConfigCache();
      this.ctx.emitter.emit("log", { level: "info", message: `Team removed: ${name}` });
    }
    return deleted;
  }

  async renameTeam(oldName: string, newName: string): Promise<void> {
    await this.ctx.teamStore.renameTeam(oldName, newName);

    // Move all agents from the old team to the new team name
    const agents = await this.ctx.agentStore.getAgents(oldName);
    for (const agent of agents) {
      await this.ctx.agentStore.moveAgent(agent.name, newName);
    }

    await this.syncConfigCache();
    this.ctx.emitter.emit("log", { level: "info", message: `Team renamed: "${oldName}" → "${newName}"` });
  }

  // ── Agent-level operations ─────────────────────────────────────────

  /** Get ALL agents across all teams (flattened). */
  async getAgents(): Promise<AgentConfig[]> {
    return this.ctx.agentStore.getAgents();
  }

  /** Find an agent by name across all teams. */
  async findAgent(name: string): Promise<AgentConfig | undefined> {
    return this.ctx.agentStore.getAgent(name);
  }

  /** Find which team an agent belongs to. */
  async findAgentTeam(name: string): Promise<Team | undefined> {
    const teamName = await this.ctx.agentStore.getAgentTeam(name);
    if (!teamName) return undefined;
    return this.ctx.teamStore.getTeam(teamName);
  }

  async addAgent(agent: AgentConfig, teamName?: string): Promise<void> {
    const team = teamName
      ? await this.ctx.teamStore.getTeam(teamName)
      : await this.getDefaultTeam();
    if (!team) throw new Error(`Team "${teamName}" not found`);

    await this.ctx.agentStore.createAgent(agent, team.name);
    await this.syncConfigCache();
    this.ctx.emitter.emit("log", { level: "info", message: `Agent added: ${agent.name} (team: ${team.name})` });
  }

  /** Atomic update of an agent's fields. No more remove+add. */
  async updateAgent(name: string, updates: Partial<Omit<AgentConfig, "name">>): Promise<AgentConfig> {
    const updated = await this.ctx.agentStore.updateAgent(name, updates);
    await this.syncConfigCache();
    this.ctx.emitter.emit("log", { level: "info", message: `Agent updated: ${name}` });
    return updated;
  }

  async removeAgent(name: string): Promise<boolean> {
    const teamName = await this.ctx.agentStore.getAgentTeam(name);
    const deleted = await this.ctx.agentStore.deleteAgent(name);
    if (deleted) {
      await this.syncConfigCache();
      this.ctx.emitter.emit("log", { level: "info", message: `Agent removed: ${name}${teamName ? ` (team: ${teamName})` : ""}` });
    }
    return deleted;
  }

  async addVolatileAgent(agent: AgentConfig, group: string): Promise<void> {
    const existing = await this.ctx.agentStore.getAgent(agent.name);
    if (existing) return;

    const team = await this.getDefaultTeam();
    const volatileAgent: AgentConfig = {
      ...agent,
      volatile: true,
      missionGroup: group,
      createdAt: agent.createdAt ?? new Date().toISOString(),
    };
    await this.ctx.agentStore.createAgent(volatileAgent, team.name);
    await this.syncConfigCache();
    this.ctx.emitter.emit("log", { level: "info", message: `Volatile agent added: ${agent.name} for ${group}` });
  }

  async cleanupVolatileAgents(group: string): Promise<number> {
    const removed = await this.ctx.agentStore.cleanupVolatileAgents(group);
    if (removed > 0) {
      await this.syncConfigCache();
      this.ctx.emitter.emit("log", { level: "debug", message: `Cleaned up ${removed} volatile agent(s) from ${group}` });
    }
    return removed;
  }
}
