import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MissionDelay } from "../core/types.js";

/**
 * Persisted delay state — serialisable shape written to .polpo/delays.json.
 *
 * Three collections survive restarts:
 *  1. `definitions`  — delay definitions keyed by mission group name
 *  2. `active`       — delays whose timer has started (afterTasks done), waiting to expire
 *  3. `expired`      — delays already expired (prevent re-triggering)
 */
export interface DelayState {
  definitions: Record<string, MissionDelay[]>;
  active: Record<string, { delay: MissionDelay; startedAt: string; expiresAt: string }>;
  expired: string[];
}

/**
 * Filesystem-based delay store.
 * Persists delay runtime state as JSON in `.polpo/delays.json`
 * so that delay blocking survives server restarts.
 */
export class FileDelayStore {
  private filePath: string;

  constructor(polpoDir: string) {
    if (!existsSync(polpoDir)) {
      mkdirSync(polpoDir, { recursive: true });
    }
    this.filePath = join(polpoDir, "delays.json");
  }

  /** Load persisted state (returns empty collections if file missing/corrupt). */
  load(): DelayState {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw) as DelayState;
        return {
          definitions: data.definitions ?? {},
          active: data.active ?? {},
          expired: data.expired ?? [],
        };
      }
    } catch { /* corrupted file — start fresh */ }
    return { definitions: {}, active: {}, expired: [] };
  }

  /** Persist current state to disk. */
  save(state: DelayState): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(state, null, 2));
    } catch { /* best-effort */ }
  }

  /** Remove all entries for a given group and persist. */
  removeGroup(state: DelayState, group: string): DelayState {
    delete state.definitions[group];
    const prefix = `${group}:`;
    for (const key of Object.keys(state.active)) {
      if (key.startsWith(prefix)) delete state.active[key];
    }
    state.expired = state.expired.filter(k => !k.startsWith(prefix));
    this.save(state);
    return state;
  }
}
