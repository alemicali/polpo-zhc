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

import { basename, dirname, join, posix, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { SANDBOX_VOLUME_ROOT } from "@polpo-ai/core/sandbox";

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
  // a remote computer's roots are absolute paths of the VM already (and keep their kind)
  if (allowedPaths && isRemoteRoots(allowedPaths)) return allowedPaths;
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
  // A remote computer's paths are the VM's: compared as written (this server's symlinks say
  // nothing about them), with the same rule for .polpo.
  if (isRemoteRoots(allowedPaths)) {
    const p = posix.resolve(filePath);
    const protectedRoot = protectedRoots.find((root) => within(p, root));
    if (protectedRoot && !protectedExceptions.some((e) => within(p, e))
      && !allowedPaths.some((a) => within(a, protectedRoot) && within(p, a))) return false;
    return allowedPaths.some((root) => within(p, root));
  }
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
    if (isRemoteRoots(allowedPaths)) throw new Error(remotePathDenied(toolName, filePath, allowedPaths));
    const dirs = allowedPaths.join(", ");
    throw new Error(
      `[sandbox] ${toolName}: access denied — "${filePath}" is outside allowed directories [${dirs}]`,
    );
  }
}

// ── Remote computers ────────────────────────────────────────────────────────

/**
 * Roots of a run on a remote computer (Daytona, E2B): the tools' file I/O goes through the VM's
 * workspace, so their path arguments are paths of the VM. Marked, so the checks above compare
 * them as the VM's paths (no realpath on this server) and a refusal lists them.
 */
const REMOTE_ROOTS = new WeakSet<readonly string[]>();

export function isRemoteRoots(paths: readonly string[]): boolean {
  return REMOTE_ROOTS.has(paths);
}

/** For the descriptions of tools that take a file path: where the path is. */
export const TOOL_PATH_HINT = "Paths are on the machine you work on: on a remote computer, files of that computer "
  + "(its working directory, your home, /tmp, or a mounted /volumes/<name>) — no need to copy them anywhere first.";

/** The home directories of a remote computer's users (/home/daytona, /home/user…). */
export const REMOTE_HOME_ROOT = "/home";
/** A remote computer's temporary directory. */
export const REMOTE_TMP_ROOT = "/tmp";

/**
 * Where a run on a remote computer may point Polpo's tools that take a file path
 * (browser_screenshot, image_analyze, image_edit, register_outcome, pdf_*, excel_*…): the run's
 * working directory and output directory in the VM, the home directories of its users, /tmp, and
 * the volumes attached to this run (/volumes/<name>). The rest of the VM (/etc, /usr, a volume
 * this run did not select) is refused.
 */
export function remoteAllowedRoots(o: { cwd: string; outputDir?: string; volumes?: ReadonlyArray<{ mountPath: string }> }): string[] {
  const volumes = (o.volumes ?? []).map((v) => posix.resolve(v.mountPath))
    .filter((m) => m !== SANDBOX_VOLUME_ROOT && within(m, SANDBOX_VOLUME_ROOT));
  const roots = [o.cwd, ...(o.outputDir ? [o.outputDir] : []), REMOTE_HOME_ROOT, REMOTE_TMP_ROOT, ...volumes];
  return markRemoteRoots([...new Set(roots.map((r) => posix.resolve(r)))]);
}

function markRemoteRoots(paths: string[]): string[] {
  REMOTE_ROOTS.add(paths);
  return paths;
}

/** `base` and `extra` together, of the same kind as `base` (a remote computer's roots stay remote). */
export function withAllowedPaths(base: string[], ...extra: string[]): string[] {
  const all = [...base, ...extra];
  return isRemoteRoots(base) ? markRemoteRoots([...new Set(all.map((p) => posix.resolve(p)))]) : all;
}

/** The refusal of a path of a remote computer outside its roots, with where the file can go instead. */
export function remotePathDenied(toolName: string, filePath: string, roots: readonly string[]): string {
  return `[sandbox] ${toolName}: "${filePath}" is outside the folders Polpo's tools can use on your computer. `
    + `Use a path under one of: ${roots.join(", ")} (your working directory, your output directory, your home, /tmp and the volumes mounted for this run).`;
}
