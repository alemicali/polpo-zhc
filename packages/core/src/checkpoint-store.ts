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
  load(): Promise<CheckpointState>;
  save(state: CheckpointState): Promise<void>;
  removeGroup(state: CheckpointState, group: string): Promise<CheckpointState>;
}
