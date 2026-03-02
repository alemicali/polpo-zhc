import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MissionCheckpoint } from "../core/types.js";

/**
 * Persisted checkpoint state — serialisable shape written to .polpo/checkpoints.json.
 *
 * Three collections survive restarts:
 *  1. `definitions`  — checkpoint definitions keyed by mission group name
 *  2. `active`       — checkpoints that have been reached and await human resume
 *  3. `resumed`      — checkpoints already resumed (prevent re-triggering)
 */
export interface CheckpointState {
  definitions: Record<string, MissionCheckpoint[]>;
  active: Record<string, { checkpoint: MissionCheckpoint; reachedAt: string }>;
  resumed: string[];
}

/**
 * Filesystem-based checkpoint store.
 * Persists checkpoint runtime state as JSON in `.polpo/checkpoints.json`
 * so that checkpoint blocking survives server restarts.
 */
export class FileCheckpointStore {
  private filePath: string;

  constructor(polpoDir: string) {
    if (!existsSync(polpoDir)) {
      mkdirSync(polpoDir, { recursive: true });
    }
    this.filePath = join(polpoDir, "checkpoints.json");
  }

  /** Load persisted state (returns empty collections if file missing/corrupt). */
  load(): CheckpointState {
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
  save(state: CheckpointState): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(state, null, 2));
    } catch { /* best-effort */ }
  }

  /** Remove all entries for a given group and persist. */
  removeGroup(state: CheckpointState, group: string): CheckpointState {
    delete state.definitions[group];
    const prefix = `${group}:`;
    for (const key of Object.keys(state.active)) {
      if (key.startsWith(prefix)) delete state.active[key];
    }
    state.resumed = state.resumed.filter(k => !k.startsWith(prefix));
    this.save(state);
    return state;
  }
}
