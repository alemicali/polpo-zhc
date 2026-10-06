/**
 * Strict parsing of remote/local sources for Ink registries and skills.
 *
 * Sources end up as arguments to `git clone`, so this module only ever
 * produces canonical `https://github.com/<owner>/<repo>.git` URLs built from
 * validated components. Anything that is not a GitHub repo reference or an
 * explicit local path is rejected — arbitrary strings must never reach a
 * shell or a git transport (e.g. `ext::`, `--upload-pack=...`).
 *
 * Pure: no filesystem access. Callers resolve and check local paths.
 */

/** Owner/repo slug accepted for GitHub sources. */
export const GITHUB_OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export type GitSource =
  | { type: "github"; url: string; ownerRepo: string }
  | { type: "local"; path: string };

export class InvalidSourceError extends Error {
  constructor(input: string, reason?: string) {
    super(
      `Invalid source "${truncate(input)}"${reason ? ` (${reason})` : ""}. ` +
      `Expected owner/repo, https://github.com/owner/repo, or a local path starting with "/", "./" or "../".`,
    );
    this.name = "InvalidSourceError";
  }
}

function truncate(s: string): string {
  // Strip control characters so error messages can't be used for terminal/log injection.
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, "?");
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

function validSegment(seg: string): boolean {
  return SEGMENT_RE.test(seg) && seg !== "." && seg !== "..";
}

function fromOwnerRepo(owner: string, repoRaw: string): { url: string; ownerRepo: string } | null {
  const repo = repoRaw.replace(/\.git$/, "");
  if (!validSegment(owner) || !validSegment(repo)) return null;
  // Disallow leading "-" so nothing can ever look like a CLI option.
  if (owner.startsWith("-") || repo.startsWith("-")) return null;
  const ownerRepo = `${owner}/${repo}`;
  return { url: `https://github.com/${ownerRepo}.git`, ownerRepo };
}

/**
 * Parse a GitHub repo reference. Accepts:
 *   - `owner/repo`
 *   - `https://github.com/owner/repo[.git][/tree/...]`
 *   - `github.com/owner/repo` (scheme-less)
 *   - `git@github.com:owner/repo[.git]` (normalised to https)
 * Returns null when the input is not a valid GitHub reference.
 */
export function parseGitHubSource(input: string): { url: string; ownerRepo: string } | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 512) return null;
  // No whitespace / control characters anywhere.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(input)) return null;

  // owner/repo shorthand
  if (GITHUB_OWNER_REPO_RE.test(input)) {
    const [owner, repo] = input.split("/");
    return fromOwnerRepo(owner, repo);
  }

  // SSH shorthand: git@github.com:owner/repo(.git)
  const ssh = input.match(/^git@github\.com:([^/]+)\/([^/]+)$/);
  if (ssh) return fromOwnerRepo(ssh[1], ssh[2]);

  // URLs (with or without https://)
  let urlStr = input;
  if (/^(www\.)?github\.com\//i.test(urlStr)) urlStr = `https://${urlStr}`;
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  if (url.username || url.password || url.port) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return fromOwnerRepo(segments[0], segments[1]);
}

/** True when the input looks like an explicit local path. */
export function isLocalSourcePath(input: string): boolean {
  return input === "." || input.startsWith("/") || input.startsWith("./") || input.startsWith("../");
}

/**
 * Classify a source string. Throws InvalidSourceError for anything that is
 * neither a valid GitHub reference nor an explicit local path. Local paths
 * are returned verbatim — callers must resolve them and check they exist.
 */
export function parseGitSource(input: string): GitSource {
  if (typeof input !== "string" || input.length === 0) {
    throw new InvalidSourceError(String(input ?? ""), "empty");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    throw new InvalidSourceError(input, "control characters are not allowed");
  }
  if (isLocalSourcePath(input)) {
    return { type: "local", path: input };
  }
  const gh = parseGitHubSource(input);
  if (gh) return { type: "github", ...gh };
  throw new InvalidSourceError(input);
}

/**
 * Quote a string as a single POSIX shell word. Only for code paths that are
 * limited to a string-based Shell abstraction — prefer argument arrays
 * (execFile/spawn without a shell) wherever possible.
 */
export function shellQuote(arg: string): string {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}
