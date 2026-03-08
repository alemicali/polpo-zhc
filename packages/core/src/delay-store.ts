/**
 * DelayStore — pure interface for mission delay persistence.
 *
 * FileDelayStore (node:fs) implements this in the shell.
 */
import type { MissionDelay } from "./types.js";

export interface DelayState {
  definitions: Record<string, MissionDelay[]>;
  active: Record<string, { delay: MissionDelay; startedAt: string; expiresAt: string }>;
  expired: string[];
}

export interface DelayStore {
  load(): DelayState;
  save(state: DelayState): void;
  removeGroup(state: DelayState, group: string): DelayState;
}
