/**
 * Glob for the agents' glob tool, on the FileSystem port (this machine or a remote sandbox).
 * It replaced `find -name <pattern>`, which matches file names only (so "src/*.ts", "**\/*.md" or
 * "docs/report.md" never matched) and needs a Unix shell (on Windows without bash every search
 * answered "No files found").
 */

import { join } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";

/** Directories walked only when the pattern names them: huge, and almost never what is looked for. */
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/**
 * A glob pattern as a regular expression over "/"-separated relative paths:
 * `**` any number of directories, `*` and `?` within one name, `{a,b}` alternatives, `[abc]` classes.
 * A pattern without "/" matches the file name at any depth (as `find -name` did).
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p.includes("/")) p = `**/${p}`;
  let re = "";
  let inGroup = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // "**/" → zero or more directories; a trailing "**" → anything
        if (p[i + 2] === "/") { re += "(?:[^/]*/)*"; i += 2; }
        else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") { re += "(?:"; inGroup++; }
    else if (c === "}" && inGroup > 0) { re += ")"; inGroup--; }
    else if (c === "," && inGroup > 0) re += "|";
    else if (c === "[") {
      const end = p.indexOf("]", i + 1);
      if (end > i) { re += `[${p.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`; i = end; }
      else re += "\\[";
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Files under `root` whose path relative to it (with "/") matches `pattern`, sorted, at most
 * `limit`. `canEnter(dir)` decides which directories are walked (the sandbox).
 */
export async function globFiles(
  fs: FileSystem,
  root: string,
  pattern: string,
  opts: { limit?: number; canEnter?: (dir: string) => boolean } = {},
): Promise<string[]> {
  const limit = opts.limit ?? 200;
  const re = globToRegExp(pattern);
  const named = (dir: string) => pattern.includes(dir);
  const found: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      entries = fs.readdirWithTypes
        ? await fs.readdirWithTypes(dir)
        : await Promise.all((await fs.readdir(dir)).map(async (name) => ({ name, isDirectory: (await fs.stat(join(dir, name))).isDirectory })));
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= limit) return;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (SKIPPED_DIRS.has(entry.name) && !named(entry.name)) continue;
        const abs = join(dir, entry.name);
        if (opts.canEnter && !opts.canEnter(abs)) continue;
        await walk(abs, path);
      } else if (re.test(path)) {
        found.push(path);
      }
    }
  };
  await walk(root, "");
  return found;
}
