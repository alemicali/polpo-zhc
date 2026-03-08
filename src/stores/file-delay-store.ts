import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DelayStore, DelayState } from "@polpo-ai/core/delay-store";

export type { DelayState };

/**
 * Filesystem-based delay store.
 * Persists delay runtime state as JSON in `.polpo/delays.json`
 * so that delay blocking survives server restarts.
 */
export class FileDelayStore implements DelayStore {
  private filePath: string;

  constructor(polpoDir: string) {
    if (!existsSync(polpoDir)) {
      mkdirSync(polpoDir, { recursive: true });
    }
    this.filePath = join(polpoDir, "delays.json");
  }

  /** Load persisted state (returns empty collections if file missing/corrupt). */
  async load(): Promise<DelayState> {
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
  async save(state: DelayState): Promise<void> {
    try {
      writeFileSync(this.filePath, JSON.stringify(state, null, 2));
    } catch { /* best-effort */ }
  }

  /** Remove all entries for a given group and persist. */
  async removeGroup(state: DelayState, group: string): Promise<DelayState> {
    delete state.definitions[group];
    const prefix = `${group}:`;
    for (const key of Object.keys(state.active)) {
      if (key.startsWith(prefix)) delete state.active[key];
    }
    state.expired = state.expired.filter(k => !k.startsWith(prefix));
    await this.save(state);
    return state;
  }
}
