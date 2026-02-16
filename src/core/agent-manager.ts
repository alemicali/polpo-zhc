import type { OrchestratorContext } from "./orchestrator-context.js";
import type { AgentConfig, Team } from "./types.js";

/**
 * Manages the agent team: CRUD operations, volatile (plan-tied) agents.
 */
export class AgentManager {
  constructor(private ctx: OrchestratorContext) {}

  getAgents(): AgentConfig[] {
    return this.ctx.config?.team.agents ?? [];
  }

  getTeam(): Team {
    return this.ctx.config?.team ?? { name: "", agents: [] };
  }

  renameTeam(newName: string): void {
    if (!this.ctx.config) throw new Error("Orchestrator not initialized");
    this.ctx.config.team.name = newName;
    this.ctx.registry.setState({ team: this.ctx.config.team });
    this.ctx.emitter.emit("log", { level: "info", message: `Team renamed to "${newName}"` });
  }

  addAgent(agent: AgentConfig): void {
    if (!this.ctx.config) throw new Error("Orchestrator not initialized");
    const existing = this.ctx.config.team.agents.find(a => a.name === agent.name);
    if (existing) throw new Error(`Agent "${agent.name}" already exists`);
    this.ctx.config.team.agents.push(agent);
    this.ctx.registry.setState({ team: this.ctx.config.team });
    this.ctx.emitter.emit("log", { level: "info", message: `Agent added: ${agent.name}` });
  }

  removeAgent(name: string): boolean {
    if (!this.ctx.config) throw new Error("Orchestrator not initialized");
    const idx = this.ctx.config.team.agents.findIndex(a => a.name === name);
    if (idx < 0) return false;
    this.ctx.config.team.agents.splice(idx, 1);
    this.ctx.registry.setState({ team: this.ctx.config.team });
    this.ctx.emitter.emit("log", { level: "info", message: `Agent removed: ${name}` });
    return true;
  }

  addVolatileAgent(agent: AgentConfig, group: string): void {
    if (!this.ctx.config) throw new Error("Orchestrator not initialized");
    const existing = this.ctx.config.team.agents.find(a => a.name === agent.name);
    if (existing) return;
    const volatileAgent: AgentConfig = { ...agent, volatile: true, planGroup: group };
    this.ctx.config.team.agents.push(volatileAgent);
    this.ctx.registry.setState({ team: this.ctx.config.team });
    this.ctx.emitter.emit("log", { level: "info", message: `Volatile agent added: ${agent.name} for ${group}` });
  }

  cleanupVolatileAgents(group: string): number {
    if (!this.ctx.config) return 0;
    const before = this.ctx.config.team.agents.length;
    this.ctx.config.team.agents = this.ctx.config.team.agents.filter(
      a => !(a.volatile && a.planGroup === group)
    );
    const removed = before - this.ctx.config.team.agents.length;
    if (removed > 0) {
      this.ctx.registry.setState({ team: this.ctx.config.team });
      this.ctx.emitter.emit("log", { level: "debug", message: `Cleaned up ${removed} volatile agent(s) from ${group}` });
    }
    return removed;
  }
}
