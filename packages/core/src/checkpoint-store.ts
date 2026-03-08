/**
 * CheckpointStore — pure interface for mission checkpoint persistence.
 *
 * FileCheckpointStore (node:fs) implements this in the shell.
 */
import type { MissionCheckpoint } from "./types.js";

export interface CheckpointState {
  definitions: Record<string, MissionCheckpoint[]>;
  active: Record<string, { checkpoint: MissionCheckpoint; reachedAt: string }>;
  resumed: string[];
}

export interface CheckpointStore {
  load(): CheckpointState;
  save(state: CheckpointState): void;
  removeGroup(state: CheckpointState, group: string): CheckpointState;
}
