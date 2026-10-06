/**
 * Safe git helpers for Ink registries and skill installs.
 *
 * - Sources are validated by `parseGitSource()` (owner/repo, https GitHub URL,
 *   or a local path) — arbitrary strings are rejected.
 * - git is always invoked with an argument array via execFileSync (no shell),
 *   so URLs and paths can never be interpreted as shell syntax.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseGitSource, InvalidSourceError } from "@polpo-ai/core/git-source";

export { InvalidSourceError, parseGitSource, parseGitHubSource, GITHUB_OWNER_REPO_RE } from "@polpo-ai/core/git-source";

export interface ResolvedSource {
  type: "github" | "local";
  /** For GitHub: canonical https clone URL. For local: absolute path. */
  url: string;
  /** GitHub owner/repo slug (only for type: "github"). */
  ownerRepo?: string;
}

/**
 * Parse a user/LLM-supplied source into a canonical form.
 *
 * Accepts owner/repo, https://github.com/owner/repo, explicit local paths
 * ("/", "./", "../", "."), or any other string that is an existing local path.
 * Throws InvalidSourceError for everything else.
 */
export function resolveSource(input: string): ResolvedSource {
  try {
    const parsed = parseGitSource(input);
    if (parsed.type === "local") return { type: "local", url: resolve(parsed.path) };
    return { type: "github", url: parsed.url, ownerRepo: parsed.ownerRepo };
  } catch (err) {
    // Fallback: a bare relative path that exists on disk (e.g. "my-registry").
    // Never for anything with "." / ".." segments: on Windows existsSync()
    // normalises "owner/.." to "." (true even when "owner" doesn't exist),
    // and a rejected GitHub-looking ref must stay rejected on every OS.
    if (
      typeof input === "string" && input.length > 0 &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f]/.test(input) &&
      !input.startsWith("-") &&
      !input.split(/[\\/]/).some((seg) => seg === "." || seg === "..") &&
      existsSync(input)
    ) {
      return { type: "local", url: resolve(input) };
    }
    if (err instanceof InvalidSourceError) throw err;
    throw new InvalidSourceError(String(input));
  }
}

const GIT_ENV = (): NodeJS.ProcessEnv => ({
  ...process.env,
  // Never block on credential prompts for a non-existent / private repo.
  GIT_TERMINAL_PROMPT: "0",
});

/** Base args: forbid the `ext::` transport, which can run arbitrary commands. */
const GIT_SAFE_ARGS = ["-c", "protocol.ext.allow=never"];

/** `git clone --depth 1 -- <url> <dest>` without a shell. */
export function gitClone(url: string, dest: string, opts: { timeout?: number; quiet?: boolean } = {}): void {
  const args = [...GIT_SAFE_ARGS, "clone", "--depth", "1"];
  if (opts.quiet) args.push("--quiet");
  args.push("--", url, dest);
  execFileSync("git", args, { stdio: "pipe", timeout: opts.timeout ?? 60_000, env: GIT_ENV() });
}

/** `git pull --ff-only` in `cwd` without a shell. */
export function gitPullFastForward(cwd: string, opts: { timeout?: number } = {}): void {
  execFileSync("git", [...GIT_SAFE_ARGS, "pull", "--ff-only"], {
    cwd, stdio: "pipe", timeout: opts.timeout ?? 60_000, env: GIT_ENV(),
  });
}

/** Current HEAD commit hash of the repo at `cwd`. */
export function gitHeadCommit(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Cache directory key for a source label (owner/repo → owner--repo). Never contains path separators. */
export function sourceCacheKey(sourceLabel: string): string {
  const key = sourceLabel.replace(/[\\/]/g, "--").replace(/[^A-Za-z0-9._-]/g, "_");
  return key === "." || key === ".." || key === "" ? `_${key}` : key;
}
