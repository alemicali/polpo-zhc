import type { OrchestratorContext } from "./orchestrator-context.js";
import type { AgentConfig, Team } from "./types.js";
import { getAllAgents, findAgent, findAgentTeam } from "./types.js";

/**
 * Manages multi-team agent topology: CRUD operations on teams and agents,
 * volatile (mission-tied) agents, and config persistence.
 */
export class AgentManager {
  constructor(private ctx: OrchestratorContext) {}

  /**
   * Persist the current teams to polpo.json, excluding volatile agents.
   * Merges into the existing file config to preserve providers/settings
   * that may have been edited outside the runtime.
   */
  private persistConfig(): void {
    if (!this.ctx.loadConfig || !this.ctx.saveConfig) return;
    const existing = this.ctx.loadConfig();
    if (!existing) return; // no polpo.json to update (e.g. headless / test mode)

    // Strip volatile agents from each team; drop empty teams that only had volatile agents
    existing.teams = this.ctx.config.teams.map(t => ({
      ...t,
      agents: t.agents.filter(a => !a.volatile),
    })).filter(t => t.agents.length > 0 || !this.isVolatileOnlyTeam(t.name));

    this.ctx.saveConfig(existing);
  }

  /** Returns true if a team had ONLY volatile agents (should not be persisted). */
  private isVolatileOnlyTeam(teamName: string): boolean {
    const team = this.ctx.config.teams.find(t => t.name === teamName);
    if (!team) return false;
    return team.agents.length > 0 && team.agents.every(a => a.volatile);
  }

  // ── Team-level operations ──

  getTeams(): Team[] {
    return this.ctx.config?.teams ?? [];
  }

  getTeam(name?: string): Team | undefined {
    if (!this.ctx.config) return undefined;
    if (!name) return this.ctx.config.teams[0];
    return this.ctx.config.teams.find(t => t.name === name);
  }

  /** Get the default (first) team, creating one if none exist. */
  getDefaultTeam(): Team {
    if (!this.ctx.config) return { name: "default", agents: [] };
    if (this.ctx.config.teams.length === 0) {
      const team: Team = { name: "default", agents: [] };
      this.ctx.config.teams.push(team);
    }
    return this.ctx.config.teams[0];
  }

  addTeam(team: Team): void {
    if (!this.ctx.config) throw new Error("Orchestrator not initialized");
    const existing = this.ctx.config.teams.find(t => t.name === team.name);
    if (existing) throw new Error(`Team "${team.name}" already exists`);
    this.ctx.config.teams.push(team);
    this.ctx.registry.setState({ teams: this.ctx.config.teams });
    this.persistConfig();
    this.ctx.emitter.emit("log", { level: "info", message: `Team added: ${team.name}` });
  }

  removeTeam(name: string): boolean {
    if (!this.ctx.config) throw new Error("Orchestrator not initialized");
    const idx = this.ctx.config.teams.findIndex(t => t.name === name);
    if (idx < 0) return false;
    if (this.ctx.config.teams.length === 1) {
      throw new Error("Cannot remove the last team");
    }
    this.ctx.config.teams.splice(idx, 1);
    this.ctx.registry.setState({ teams: this.ctx.config.teams });
    this.persistConfig();
    this.ctx.emitter.emit("log", { level: "info", message: `Team removed: ${name}` });
    return true;
  }

  renameTeam(oldName: string, newName: string): void {
    if (!this.ctx.config) throw new Error("Orchestrator not initialized");
    const team = this.ctx.config.teams.find(t => t.name === oldName);
    if (!team) throw new Error(`Team "${oldName}" not found`);
    if (this.ctx.config.teams.some(t => t.name === newName)) {
      throw new Error(`Team "${newName}" already exists`);
    }
    team.name = newName;
    this.ctx.registry.setState({ teams: this.ctx.config.teams });
    this.persistConfig();
    this.ctx.emitter.emit("log", { level: "info", message: `Team renamed: "${oldName}" → "${newName}"` });
  }

  // ── Agent-level operations ──

  /** Get ALL agents across all teams (flattened). */
  getAgents(): AgentConfig[] {
    return getAllAgents(this.ctx.config?.teams ?? []);
  }

  /** Find an agent by name across all teams. */
  findAgent(name: string): AgentConfig | undefined {
    return findAgent(this.ctx.config?.teams ?? [], name);
  }

  /** Find which team an agent belongs to. */
  findAgentTeam(name: string): Team | undefined {
    return findAgentTeam(this.ctx.config?.teams ?? [], name);
  }

  addAgent(agent: AgentConfig, teamName?: string): void {
    if (!this.ctx.config) throw new Error("Orchestrator not initialized");

    // Globally unique names across all teams
    const existing = this.findAgent(agent.name);
    if (existing) throw new Error(`Agent "${agent.name}" already exists`);

    const team = teamName
      ? this.ctx.config.teams.find(t => t.name === teamName)
      : this.getDefaultTeam();
    if (!team) throw new Error(`Team "${teamName}" not found`);

    if (!agent.createdAt) agent.createdAt = new Date().toISOString();
    team.agents.push(agent);
    this.ctx.registry.setState({ teams: this.ctx.config.teams });
    if (!agent.volatile) this.persistConfig();
    this.ctx.emitter.emit("log", { level: "info", message: `Agent added: ${agent.name} (team: ${team.name})` });
  }

  removeAgent(name: string): boolean {
    if (!this.ctx.config) throw new Error("Orchestrator not initialized");

    for (const team of this.ctx.config.teams) {
      const idx = team.agents.findIndex(a => a.name === name);
      if (idx >= 0) {
        const wasVolatile = team.agents[idx].volatile;
        team.agents.splice(idx, 1);
        this.ctx.registry.setState({ teams: this.ctx.config.teams });
        if (!wasVolatile) this.persistConfig();
        this.ctx.emitter.emit("log", { level: "info", message: `Agent removed: ${name} (team: ${team.name})` });
        return true;
      }
    }
    return false;
  }

  addVolatileAgent(agent: AgentConfig, group: string): void {
    if (!this.ctx.config) throw new Error("Orchestrator not initialized");

    const existing = this.findAgent(agent.name);
    if (existing) return;

    // Volatile agents go to the default (first) team
    const team = this.getDefaultTeam();
    const volatileAgent: AgentConfig = { ...agent, volatile: true, missionGroup: group, createdAt: agent.createdAt ?? new Date().toISOString() };
    team.agents.push(volatileAgent);
    this.ctx.registry.setState({ teams: this.ctx.config.teams });
    this.ctx.emitter.emit("log", { level: "info", message: `Volatile agent added: ${agent.name} for ${group}` });
  }

  cleanupVolatileAgents(group: string): number {
    if (!this.ctx.config) return 0;
    let removed = 0;
    for (const team of this.ctx.config.teams) {
      const before = team.agents.length;
      team.agents = team.agents.filter(a => !(a.volatile && a.missionGroup === group));
      removed += before - team.agents.length;
    }
    if (removed > 0) {
      this.ctx.registry.setState({ teams: this.ctx.config.teams });
      this.ctx.emitter.emit("log", { level: "debug", message: `Cleaned up ${removed} volatile agent(s) from ${group}` });
    }
    return removed;
  }
}
