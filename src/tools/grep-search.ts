/**
 * The search behind the `grep` tool: ripgrep when the machine that holds the files has it (it
 * respects .gitignore and skips binary files), else `grep -rnI` without .git and node_modules.
 * Every argument goes through {@link execArgv}, never through a shell unquoted.
 *
 * Options and the ripgrep invocation follow Pi's grep tool (`@earendil-works/pi-coding-agent` 1.6,
 * src/core/tools/grep.ts, MIT License, Copyright (c) Mario Zechner): `ignore_case`, `literal`,
 * `context`, `limit`, `glob`, `--no-config`, `--hidden`, a leading "./" dropped from the glob.
 */

import type { Shell } from "@polpo-ai/core/shell";
import { execArgv } from "./argv-exec.js";

export type GrepEngine = "rg" | "grep";

export interface GrepOptions {
  pattern: string;
  /** The path to search, as passed to the program (relative to `cwd`, or absolute). */
  path: string;
  cwd: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  glob?: string;
  timeout?: number;
  /** Force an engine (tests); default: ripgrep when installed. */
  engine?: GrepEngine;
}

export interface GrepLine {
  /** "path:12:text" for a match, "path-12-text" for a context line, "--" between groups. */
  text: string;
  isMatch: boolean;
}

export type GrepOutcome =
  | { ok: true; engine: GrepEngine; lines: GrepLine[]; matches: number }
  | { ok: false; engine: GrepEngine; error: string; kind: "regex" | "timeout" | "failed" };

const rgAvailable = new WeakMap<Shell, Promise<boolean>>();

/** Whether ripgrep runs where `shell` runs commands (checked once per shell). */
export function hasRipgrep(shell: Shell, cwd?: string): Promise<boolean> {
  let known = rgAvailable.get(shell);
  if (!known) {
    known = execArgv(shell, ["rg", "--version"], { cwd, timeout: 10_000 })
      .then((r) => r.exitCode === 0 && /ripgrep/i.test(r.stdout))
      .catch(() => false);
    rgAvailable.set(shell, known);
  }
  return known;
}

export function ripgrepArgs(o: GrepOptions): string[] {
  const args = ["rg", "--no-config", "--line-number", "--no-heading", "--color=never", "--hidden", "--null", "--glob", "!.git"];
  if (o.ignoreCase) args.push("--ignore-case");
  if (o.literal) args.push("--fixed-strings");
  if (o.context && o.context > 0) args.push("--context", String(Math.floor(o.context)));
  // rg never matches a leading "./" ("./src/*.ts" finds nothing): drop it, keeping a "!" negation
  if (o.glob) args.push("--glob", o.glob.replace(/^(!?)(?:\.\/)+/, "$1"));
  args.push("--regexp", o.pattern, "--", o.path);
  return args;
}

export function grepArgs(o: GrepOptions): string[] {
  const args = ["grep", "-r", "-n", "-I", "-s", "-Z", "--exclude-dir=.git", "--exclude-dir=node_modules"];
  if (o.ignoreCase) args.push("-i");
  args.push(o.literal ? "-F" : "-E");
  if (o.context && o.context > 0) args.push("-C", String(Math.floor(o.context)));
  // grep's --include matches the file name only
  if (o.glob) {
    const name = o.glob.replace(/^!/, "").split("/").pop()!;
    args.push(o.glob.startsWith("!") ? `--exclude=${name}` : `--include=${name}`);
  }
  args.push("-e", o.pattern, "--", o.path);
  return args;
}

/**
 * Program output (`path\0` before each line number, see --null / -Z) → "path:12:text" lines,
 * files sorted by path (ripgrep searches in parallel, grep in directory order), each file's lines
 * in order, "--" between groups of context lines that are not adjacent.
 */
export function parseGrepOutput(stdout: string): { lines: GrepLine[]; matches: number } {
  const byFile = new Map<string, Array<{ n: number; sep: string; text: string }>>();
  let matches = 0;
  const raw = stdout.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  for (const line of raw) {
    if (line === "--") continue;
    const nul = line.indexOf("\0");
    const file = nul === -1 ? "" : line.slice(0, nul).replace(/^(?:\.\/)+/, "");
    const rest = nul === -1 ? line : line.slice(nul + 1);
    const m = /^(\d+)([:-])/.exec(rest);
    if (!m) continue;
    if (m[2] === ":") matches++;
    const list = byFile.get(file) ?? [];
    // a CRLF file's lines end with the CR
    list.push({ n: Number(m[1]), sep: m[2]!, text: rest.slice(m[0].length).replace(/\r$/, "") });
    byFile.set(file, list);
  }
  const lines: GrepLine[] = [];
  const files = [...byFile.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const withContext = [...byFile.values()].some((list) => list.some((l) => l.sep === "-"));
  for (const file of files) {
    let previous: number | undefined;
    for (const l of byFile.get(file)!) {
      if (withContext && lines.length > 0 && (previous === undefined || l.n !== previous + 1)) lines.push({ text: "--", isMatch: false });
      lines.push({ text: file ? `${file}${l.sep}${l.n}${l.sep}${l.text}` : `${l.n}${l.sep}${l.text}`, isMatch: l.sep === ":" });
      previous = l.n;
    }
  }
  return { lines, matches };
}

export async function grepSearch(shell: Shell, o: GrepOptions): Promise<GrepOutcome> {
  const engine: GrepEngine = o.engine ?? (await hasRipgrep(shell, o.cwd) ? "rg" : "grep");
  const timeout = o.timeout ?? 30_000;
  const r = await execArgv(shell, engine === "rg" ? ripgrepArgs(o) : grepArgs(o), { cwd: o.cwd, timeout });
  if (r.timedOut) {
    return { ok: false, engine, kind: "timeout", error: `the search timed out after ${Math.round(timeout / 1000)} s. Narrow path or glob.` };
  }
  if (r.missing) {
    return { ok: false, engine, kind: "failed", error: `${engine} is not installed where the files are. Use bash to search.` };
  }
  // 0: matches, 1: none, 2: an error (with output: unreadable files next to real matches)
  if (r.exitCode >= 2 && !r.stdout.trim()) {
    const message = r.stderr.trim().split("\n").filter(Boolean).slice(0, 6).join("\n") || `${engine} exited with code ${r.exitCode}`;
    const regex = /regex|parse error|unmatched|unclosed|invalid|repetition|brace|bracket|parenthes|mismatched|backslash/i.test(message);
    return { ok: false, engine, kind: regex ? "regex" : "failed", error: message };
  }
  return { ok: true, engine, ...parseGrepOutput(r.stdout) };
}
