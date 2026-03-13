/**
 * Shared constants — single source of truth for default values
 * used across CLI and server.
 */

import { resolve, join } from "node:path";
import { homedir } from "node:os";

/** Default port for the Polpo HTTP server. */
export const DEFAULT_SERVER_PORT = 3890;

/** Default host for the Polpo HTTP server. */
export const DEFAULT_SERVER_HOST = "127.0.0.1";

/** Name of the per-project config directory. */
export const POLPO_DIR_NAME = ".polpo";

/** Resolve the per-project `.polpo` directory from a working directory. */
export function getPolpoDir(workDir: string): string {
  return resolve(workDir, POLPO_DIR_NAME);
}

/** Resolve the global `~/.polpo` directory in the user's home. */
export function getGlobalPolpoDir(): string {
  return join(homedir(), POLPO_DIR_NAME);
}
