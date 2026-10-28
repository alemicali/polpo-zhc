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

import { basename, dirname, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Absolute path with symlinks resolved, also for paths that do not exist yet: the nearest
 * existing ancestor is resolved and the rest appended. Both sides of a sandbox check go
 * through this, so /tmp vs /private/tmp (macOS) or a symlinked workspace compare equal, and
 * a new file under a symlinked directory cannot escape.
 */
export function canonicalPath(p: string): string {
  let current = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return rest.length > 0 ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(p); // nothing on the way exists
      rest.push(basename(current));
      current = parent;
    }
  }
}

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
/**
 * Directories agents never reach through a broader grant (the project's .polpo: config, .env,
 * sessions, vault, storage mounts). A path inside one is allowed only when an allowed path
 * itself lies inside it (task output dir, a granted storage mount) or it is one of the
 * exceptions (offloaded tool outputs, skills, playbooks).
 */
let protectedRoots: string[] = [];
let protectedExceptions: string[] = [];

export function setProtectedPaths(roots: string[], exceptions: string[] = []): void {
  protectedRoots = roots.map((r) => canonicalPath(r));
  protectedExceptions = exceptions.map((e) => canonicalPath(e));
}

/**
 * Protect a project's .polpo in this process; offloaded tool outputs, skills and playbooks stay
 * reachable. The state is per process: the server calls this at init, and so must every task
 * runner (a separate process, see NodeSpawner) before it builds the agent's tools.
 */
export function protectPolpoDir(polpoDir: string): void {
  setProtectedPaths([polpoDir], [
    join(polpoDir, "tmp", "tool-output"),
    join(polpoDir, "skills"),
    join(polpoDir, "playbooks"),
  ]);
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  // Symlinks resolved on both sides: no symlink-based escape, no false denials.
  const resolved = canonicalPath(filePath);
  const protectedRoot = protectedRoots.find((root) => within(resolved, root));
  if (protectedRoot) {
    if (protectedExceptions.some((e) => within(resolved, e))) return true;
    return allowedPaths.some((allowed) => {
      const a = canonicalPath(allowed);
      return within(a, protectedRoot) && within(resolved, a);
    });
  }
  for (const allowed of allowedPaths) {
    const normalizedAllowed = canonicalPath(allowed);
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

/**
 * In a task run, the output root (output/) is read-only except for the task's own folder: an
 * agent reads what the tasks before it delivered but cannot overwrite it (a fixer writing its
 * corrections over the drafts it was given). Per process, like the .polpo guard: the task runner
 * sets it before it builds the agent's tools. Only the current layout is guarded, an output
 * folder inside the output root; called without one, it clears the guard.
 */
let readOnlyOutputRoot: string | undefined;
let ownOutputDir: string | undefined;

export function protectOtherTaskOutputs(outputRoot?: string, taskOutputDir?: string): void {
  const root = outputRoot ? canonicalPath(outputRoot) : undefined;
  const own = taskOutputDir ? canonicalPath(taskOutputDir) : undefined;
  const guarded = !!root && !!own && own !== root && within(own, root);
  readOnlyOutputRoot = guarded ? root : undefined;
  ownOutputDir = guarded ? own : undefined;
}

/** assertPathAllowed for a tool that creates or changes the file. */
export function assertWriteAllowed(filePath: string, allowedPaths: string[], toolName: string): void {
  assertPathAllowed(filePath, allowedPaths, toolName);
  if (!readOnlyOutputRoot || !ownOutputDir) return;
  const resolved = canonicalPath(filePath);
  if (within(resolved, readOnlyOutputRoot) && !within(resolved, ownOutputDir)) {
    throw new Error(
      `[sandbox] ${toolName}: "${filePath}" is outside your own output folder. The rest of the output folder holds the other tasks' folders, ` +
      `which you can read but not change. Write your files in your own output folder: ${ownOutputDir}`,
    );
  }
}
