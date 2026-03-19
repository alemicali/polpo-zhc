/**
 * Spawner — abstraction for launching agent runner processes.
 *
 * Node.js uses NodeSpawner (child_process.spawn).
 * Cloud uses SandboxSpawner (Daytona sandbox).
 *
 * Same pattern as FileSystem and Shell — pure interface in core,
 * runtime implementations in the shell layer.
 */
import type { RunnerConfig } from "./types.js";

/**
 * Result of spawning a runner process.
 */
export interface SpawnResult {
  /** OS process ID (0 for sandbox-based spawners with no local PID). */
  pid: number;
  /** Where the config was persisted ("file:///path" or "db://runId"). */
  configPath: string;
}

/**
 * Interface for spawning agent runner processes.
 */
export interface Spawner {
  /**
   * Spawn a runner process for the given config.
   * The spawner is responsible for:
   *   - Persisting the RunnerConfig (to file or DB)
   *   - Starting the runner process
   *   - Returning the PID and config location
   */
  spawn(config: RunnerConfig): Promise<SpawnResult>;

  /**
   * Check if a process is still alive.
   * Returns false for spawners that don't track OS processes (e.g. sandbox).
   */
  isAlive(pid: number): boolean;

  /**
   * Kill a runner process by PID.
   * No-op for spawners that don't track OS processes (e.g. sandbox).
   */
  kill(pid: number): void;
}
