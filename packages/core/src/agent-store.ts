import type { AgentConfig } from "./types.js";

/**
 * Persistent store for agents.
 *
 * Agents are first-class entities with their own lifecycle, independent of
 * project configuration.  Each agent belongs to exactly one team (by teamName).
 *
 * Every backend (file, SQLite, PostgreSQL) must implement this interface.
 */
export interface AgentStore {
  // ── Read ────────────────────────────────────────────────────────────

  /** Return all agents, optionally filtered by team. */
  getAgents(teamName?: string): Promise<AgentConfig[]>;

  /** Return a single agent by name (globally unique), or undefined. */
  getAgent(name: string): Promise<AgentConfig | undefined>;

  /** Return the team name an agent belongs to, or undefined. */
  getAgentTeam(name: string): Promise<string | undefined>;

  // ── Write ───────────────────────────────────────────────────────────

  /** Add a new agent to the given team. Throws if name already exists. */
  createAgent(agent: AgentConfig, teamName: string): Promise<AgentConfig>;

  /** Atomic update of an agent's fields. Returns the updated agent. */
  updateAgent(name: string, updates: Partial<Omit<AgentConfig, "name">>): Promise<AgentConfig>;

  /** Move an agent to a different team. */
  moveAgent(name: string, newTeamName: string): Promise<AgentConfig>;

  /** Remove an agent by name. Returns true if it existed. */
  deleteAgent(name: string): Promise<boolean>;

  // ── Volatile lifecycle ──────────────────────────────────────────────

  /** Remove all volatile agents belonging to a mission group. Returns count removed. */
  cleanupVolatileAgents(missionGroup: string): Promise<number>;

  /** Seed initial agents (e.g. from polpo.json migration). Skips agents that already exist. */
  seed(agents: Array<AgentConfig & { teamName: string }>): Promise<void>;
}
