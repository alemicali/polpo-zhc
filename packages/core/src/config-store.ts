import type { PolpoConfig } from "./types.js";

/**
 * Persistent store for project-level configuration (.polpo/polpo.json).
 */
export interface ConfigStore {
  /** Check if a config has been saved. */
  exists(): Promise<boolean>;
  /** Load the saved config, or undefined if none. */
  get(): Promise<PolpoConfig | undefined>;
  /** Persist the config. Creates the directory if needed. */
  save(config: PolpoConfig): Promise<void>;
}
