import type { ProjectConfig } from "./types.js";

/**
 * Persistent store for project-level configuration (judge, agent, model, etc.).
 * Created once during setup, read on every boot to skip the wizard.
 */
export interface ConfigStore {
  /** Check if a config has been saved (i.e. setup was completed). */
  exists(): boolean;
  /** Load the saved config, or undefined if none. */
  get(): ProjectConfig | undefined;
  /** Persist the config. Creates the directory if needed. */
  save(config: ProjectConfig): void;
}
