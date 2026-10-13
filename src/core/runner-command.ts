/**
 * Hidden CLI command that runs a task runner (`<polpo> __runner --config <path>`).
 *
 * Normally the spawner starts `node dist/core/runner.js`. A compiled binary (the
 * desktop app's Bun sidecar) has no runner.js on disk, so it starts itself with
 * this command instead.
 */
export const RUNNER_COMMAND = "__runner";
