import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CheckpointStore, CheckpointState } from "@polpo/core/checkpoint-store";

export type { CheckpointState };

/**
 * Filesystem-based checkpoint store.
 * Persists checkpoint runtime state as JSON in `.polpo/checkpoints.json`
 * so that checkpoint blocking survives server restarts.
 */
export class FileCheckpointStore implements CheckpointStore {
  private filePath: string;

  constructor(polpoDir: string) {
    if (!existsSync(polpoDir)) {
      mkdirSync(polpoDir, { recursive: true });
    }
    this.filePath = join(polpoDir, "checkpoints.json");
  }

  /** Load persisted state (returns empty collections if file missing/corrupt). */
  async load(): Promise<CheckpointState> {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw) as CheckpointState;
        return {
          definitions: data.definitions ?? {},
          active: data.active ?? {},
          resumed: data.resumed ?? [],
        };
      }
    } catch { /* corrupted file — start fresh */ }
    return { definitions: {}, active: {}, resumed: [] };
  }

  /** Persist current state to disk. */
  async save(state: CheckpointState): Promise<void> {
    try {
      writeFileSync(this.filePath, JSON.stringify(state, null, 2));
    } catch { /* best-effort */ }
  }

  /** Remove all entries for a given group and persist. */
  async removeGroup(state: CheckpointState, group: string): Promise<CheckpointState> {
    delete state.definitions[group];
    const prefix = `${group}:`;
    for (const key of Object.keys(state.active)) {
      if (key.startsWith(prefix)) delete state.active[key];
    }
    state.resumed = state.resumed.filter(k => !k.startsWith(prefix));
    await this.save(state);
    return state;
  }
}
