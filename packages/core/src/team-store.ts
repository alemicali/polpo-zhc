import type { Team } from "./types.js";

/**
 * Persistent store for teams.
 *
 * Teams are first-class entities with their own lifecycle, independent
 * of project configuration.  Every backend (file, SQLite, PostgreSQL)
 * must implement this interface.
 */
export interface TeamStore {
  /** Return all teams (ordered by creation / insertion order). */
  getTeams(): Promise<Team[]>;

  /** Return a single team by name, or undefined. */
  getTeam(name: string): Promise<Team | undefined>;

  /** Persist a new team. Throws if a team with the same name already exists. */
  createTeam(team: Team): Promise<Team>;

  /** Update an existing team (description, etc.). Returns the updated team. */
  updateTeam(name: string, updates: Partial<Omit<Team, "name" | "agents">>): Promise<Team>;

  /** Rename a team. Throws if `newName` is already taken. */
  renameTeam(oldName: string, newName: string): Promise<Team>;

  /** Delete a team by name. Returns true if it existed. */
  deleteTeam(name: string): Promise<boolean>;

  /** Seed initial teams (e.g. from polpo.json migration). Skips teams that already exist. */
  seed(teams: Team[]): Promise<void>;
}
