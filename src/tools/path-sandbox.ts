/**
 * Path sandboxing for agent filesystem access.
 *
 * When an agent has `allowedPaths` configured, all file tool operations
 * (read/write/edit/glob/grep/ls) validate that resolved paths fall within
 * the allowed directories. This prevents agents from escaping their workspace
 * via absolute paths or `../` traversal.
 *
 * The bash tool cannot be fully sandboxed at this level (arbitrary shell commands),
 * but its cwd is set to the agent's primary allowed path.
 */

import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Resolve allowedPaths to absolute paths, normalizing relative paths against cwd.
 * If no allowedPaths are configured, defaults to [cwd] (the project workDir).
 */
export function resolveAllowedPaths(cwd: string, allowedPaths?: string[]): string[] {
  if (!allowedPaths || allowedPaths.length === 0) {
    return [resolve(cwd)];
  }
  return allowedPaths.map((p) => resolve(cwd, p));
}

/**
 * Check whether a resolved absolute path falls within any of the allowed directories.
 * Uses path prefix matching with separator awareness to prevent partial matches
 * (e.g. `/home/user/project-evil` should NOT match `/home/user/project`).
 */
export function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  let resolved = resolve(filePath);
  // Resolve symlinks to prevent symlink-based sandbox escape
  try { resolved = realpathSync(resolved); } catch { /* file may not exist yet — use logical path */ }
  for (const allowed of allowedPaths) {
    const normalizedAllowed = resolve(allowed);
    // Exact match
    if (resolved === normalizedAllowed) return true;
    // Prefix match with separator (e.g. /foo/bar/ is prefix of /foo/bar/baz)
    const prefix = normalizedAllowed.endsWith(sep) ? normalizedAllowed : normalizedAllowed + sep;
    if (resolved.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Validate a path and throw a descriptive error if it's outside the sandbox.
 * Call this in every file tool's execute() before performing the operation.
 */
export function assertPathAllowed(filePath: string, allowedPaths: string[], toolName: string): void {
  if (!isPathAllowed(filePath, allowedPaths)) {
    const dirs = allowedPaths.join(", ");
    throw new Error(
      `[sandbox] ${toolName}: access denied — "${filePath}" is outside allowed directories [${dirs}]`,
    );
  }
}
