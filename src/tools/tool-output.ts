/**
 * Large tool output offload ("restorable compression").
 *
 * When a tool result is larger than its limit, the FULL output is written to a
 * private file and the model receives a preview (head + tail with an
 * "… N lines omitted …" marker) plus the absolute path of the file and a hint
 * to page through it with `read` (offset/limit) or `grep`. Nothing is lost:
 * the agent can restore exactly the part it needs instead of the whole blob.
 *
 * Same idea as OpenCode's truncate.ts, Codex and Manus' restorable
 * compression. Small outputs never reach this module's write path: callers
 * keep their existing formatting byte-for-byte below the limit.
 *
 * Security: tool outputs can contain resolved vault values (e.g. an API that
 * echoes a token). The model already sees them; offloading only keeps the
 * same exposure. Files are created with mode 0600 inside 0700 directories so
 * they are never world/group-readable, and their content is never logged.
 *
 * Retention: files older than 7 days in the same directory are deleted
 * opportunistically every time a new file is written. Only files that match
 * our own naming scheme are ever deleted.
 *
 * Where the file goes (open Polpo's rule: a tool's file I/O goes through the
 * run's FileSystem): with a remote sandbox the file is written in the VM, where
 * the agent's `read` and `grep` run; otherwise on this machine's disk.
 */

import { mkdir, readdir, stat, unlink, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import { NodeFileSystem } from "../adapters/node-filesystem.js";

/** A FileSystem other than this machine's disk (a remote sandbox): files go through it. */
function elsewhere(fs: FileSystem | undefined): fs is FileSystem {
  return !!fs && !(fs instanceof NodeFileSystem);
}

/** Default per-result limit (~8k tokens). */
export const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 30_000;
/** Offloaded files older than this are deleted on the next write. */
export const TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Sub-directory of the task output dir (or agent temp dir) holding offloaded outputs. */
export const TOOL_OUTPUT_SUBDIR = "tool-output";

/** `<tool>-<epoch ms>-<8 hex>.txt` — the only files retention may delete. */
const OFFLOAD_FILE_RE = /^[a-z0-9_-]+-\d{10,}-[0-9a-f]{8}\.txt$/;

function safeSegment(value: string, fallback: string): string {
  const s = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return s.length > 0 ? s.slice(0, 64) : fallback;
}

/**
 * Directory where a tool factory offloads large outputs.
 *
 * - Task runs: `<outputDir>/tool-output/` (the task output dir is already in
 *   the agent's sandbox).
 * - Otherwise (chat): `<polpoDir>/tmp/tool-output/<agent>/`.
 * - Last resort: `<os tmpdir>/polpo-tool-output-<uid>/<agent>/`.
 *
 * Tool factories add the returned directory to the read-only sandbox
 * (read/grep/glob/ls) so the saved path is always readable by the agent.
 */
export function resolveToolOutputDir(opts: { outputDir?: string; polpoDir?: string; agentName?: string } = {}): string {
  if (opts.outputDir) return join(opts.outputDir, TOOL_OUTPUT_SUBDIR);
  const agent = safeSegment(opts.agentName ?? "default", "default");
  if (opts.polpoDir) return join(opts.polpoDir, "tmp", TOOL_OUTPUT_SUBDIR, agent);
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(tmpdir(), `polpo-tool-output-${uid}`, agent);
}

export interface OffloadOptions {
  /** Tool name, used in the file name. */
  tool: string;
  /** Directory where the full output is saved (see resolveToolOutputDir). */
  dir: string;
  /** Outputs with `length` above this are offloaded. Default 30,000. */
  maxChars?: number;
  /** Share of the preview budget given to the head (rest goes to the tail). Default 0.5. */
  headRatio?: number;
  /** Preview budget in chars (head + tail). Default: maxChars. */
  previewChars?: number;
  /** Clock override (tests). */
  now?: () => number;
  /** The run's FileSystem: with a remote sandbox the full output is saved in the VM. */
  fs?: FileSystem;
}

export interface OffloadResult {
  /** Text to hand to the model: the original output, or preview + path + hint. */
  text: string;
  offloaded: boolean;
  /** Absolute path of the saved full output (when offloaded and saved). */
  path?: string;
  totalBytes: number;
  totalLines: number;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.endsWith("\n")) n--;
  return n;
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Head + tail preview, cut on line boundaries when that does not waste more
 * than half of each budget (single huge lines are cut mid-line).
 */
export function buildPreview(text: string, budget: number, headRatio = 0.5): { head: string; tail: string; omitted: string } {
  if (text.length <= budget) return { head: text, tail: "", omitted: "" };
  const headBudget = Math.max(0, Math.floor(budget * Math.min(1, Math.max(0, headRatio))));
  const tailBudget = Math.max(0, budget - headBudget);

  let headEnd = headBudget;
  if (headBudget > 0) {
    const nl = text.lastIndexOf("\n", headBudget - 1);
    if (nl >= Math.floor(headBudget / 2)) headEnd = nl + 1;
  }
  let tailStart = text.length - tailBudget;
  if (tailBudget > 0 && tailBudget < text.length) {
    const nl = text.indexOf("\n", tailStart);
    if (nl !== -1 && nl < tailStart + Math.ceil(tailBudget / 2)) tailStart = nl + 1;
  }
  if (tailBudget === 0) tailStart = text.length;
  if (tailStart < headEnd) tailStart = headEnd;
  return { head: text.slice(0, headEnd), tail: text.slice(tailStart), omitted: text.slice(headEnd, tailStart) };
}

/** Hint appended to every offloaded result. */
export function offloadHint(path: string): string {
  return `Full output saved to ${path}. Read it with \`read\` using offset/limit, or search it with \`grep\`; do not read it all at once.`;
}

/** Retention through a FileSystem (remote sandbox). Best-effort. */
async function cleanupToolOutputDirIn(fs: FileSystem, dir: string, now: number, retentionMs = TOOL_OUTPUT_RETENTION_MS): Promise<number> {
  let removed = 0;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!OFFLOAD_FILE_RE.test(name)) continue;
    try {
      const s = await fs.stat(join(dir, name));
      if (s.isFile && s.modifiedAt && now - s.modifiedAt.getTime() > retentionMs) { await fs.remove(join(dir, name)); removed++; }
    } catch { /* skip */ }
  }
  return removed;
}

/** Delete our own files older than the retention window. Best-effort. */
export async function cleanupToolOutputDir(dir: string, now = Date.now(), retentionMs = TOOL_OUTPUT_RETENTION_MS): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!OFFLOAD_FILE_RE.test(name)) continue;
    const file = join(dir, name);
    try {
      const s = await stat(file);
      if (!s.isFile()) continue;
      if (now - s.mtimeMs > retentionMs) {
        await unlink(file);
        removed++;
      }
    } catch { /* raced with another cleanup or unreadable: skip */ }
  }
  return removed;
}

/** Write the full output to a new private file (0600, dir 0700). Returns the absolute path. */
export async function saveToolOutput(output: string, tool: string, dir: string, now = Date.now(), fs?: FileSystem): Promise<string> {
  const name = `${safeSegment(tool.toLowerCase(), "tool").replace(/\./g, "_")}-${now}-${randomBytes(4).toString("hex")}.txt`;
  const file = join(dir, name);
  if (elsewhere(fs)) {
    await fs.mkdir(dir);
    await fs.writeFile(file, output);
    // when that FileSystem is a proxy to this machine's disk (a chat that is not remote), keep
    // the file private; in a VM these paths do not exist here and nothing happens
    await chmod(file, 0o600).catch(() => {});
    await cleanupToolOutputDirIn(fs, dir, now).catch(() => 0);
    return file;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // "wx": never follow/overwrite an existing path. The umask can only remove
  // bits from 0600; the chmod is defensive (e.g. filesystems ignoring mode).
  await writeFile(file, output, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  await chmod(file, 0o600).catch(() => {});
  await cleanupToolOutputDir(dir, now).catch(() => 0);
  return file;
}

/**
 * Return `output` unchanged when it fits `maxChars`; otherwise save it in
 * full and return a head + tail preview with the saved path and a hint.
 * Never throws: if the file cannot be written, the preview says so.
 */
export async function offloadToolOutput(output: string, opts: OffloadOptions): Promise<OffloadResult> {
  const maxChars = opts.maxChars ?? DEFAULT_TOOL_OUTPUT_MAX_CHARS;
  if (output.length <= maxChars) {
    return { text: output, offloaded: false, totalBytes: Buffer.byteLength(output, "utf-8"), totalLines: countLines(output) };
  }
  const totalBytes = Buffer.byteLength(output, "utf-8");
  const totalLines = countLines(output);
  const now = (opts.now ?? Date.now)();

  let path: string | undefined;
  let saveError: string | undefined;
  try {
    path = await saveToolOutput(output, opts.tool, opts.dir, now, opts.fs);
  } catch (err: any) {
    saveError = err?.code ?? err?.message ?? "write failed";
  }

  const { head, tail, omitted } = buildPreview(output, opts.previewChars ?? maxChars, opts.headRatio ?? 0.5);
  const omittedLines = countNewlines(omitted);
  const omittedBytes = Buffer.byteLength(omitted, "utf-8");
  const marker = `\n\n… ${omittedLines} lines (${omittedBytes} bytes) omitted …\n\n`;
  const footer = path
    ? `\n\n[Output too large (${totalBytes} bytes, ${totalLines} lines). ${offloadHint(path)}]`
    : `\n\n[Output too large (${totalBytes} bytes, ${totalLines} lines); the full output could not be saved (${saveError}).]`;
  const body = tail.length > 0 ? `${head}${marker}${tail}` : `${head}${marker.trimEnd()}`;
  return { text: body + footer, offloaded: true, path, totalBytes, totalLines };
}

/**
 * Wrap a tool so that results whose text content exceeds `maxChars` are
 * offloaded. Text parts are joined, saved, and replaced by a single preview
 * part; image parts are kept. Large `details` (e.g. a raw JSON payload) are
 * replaced by a small summary so checkpoints stay small. Results within the
 * limit are returned untouched (same object).
 */
export function withToolOutputOffload<T extends AgentTool<any>>(
  tool: T,
  opts: { dir: string; maxChars?: number; headRatio?: number; fs?: FileSystem },
): T {
  const maxChars = opts.maxChars ?? DEFAULT_TOOL_OUTPUT_MAX_CHARS;
  const execute = tool.execute.bind(tool);
  const wrapped = async (...args: Parameters<T["execute"]>): Promise<AgentToolResult<any>> => {
    const result = await (execute as (...a: any[]) => Promise<AgentToolResult<any>>)(...args);
    const content = result?.content;
    if (!Array.isArray(content)) return result;
    const textParts = content.filter((c: any) => c?.type === "text");
    const joined = textParts.map((c: any) => c.text ?? "").join("\n");
    if (joined.length <= maxChars) return result;
    const off = await offloadToolOutput(joined, { tool: tool.name, dir: opts.dir, maxChars, headRatio: opts.headRatio, fs: opts.fs });
    const newContent: any[] = [];
    let placed = false;
    for (const c of content as any[]) {
      if (c?.type === "text") {
        if (!placed) { newContent.push({ type: "text", text: off.text }); placed = true; }
      } else {
        newContent.push(c);
      }
    }
    let details: any = result.details;
    let detailsSize = 0;
    try { detailsSize = JSON.stringify(details ?? null)?.length ?? 0; } catch { detailsSize = Infinity; }
    const summary = { outputPath: off.path, outputBytes: off.totalBytes, outputLines: off.totalLines, truncated: true };
    if (detailsSize > maxChars) details = summary;
    else if (details && typeof details === "object" && !Array.isArray(details)) details = { ...details, ...summary };
    return { ...result, content: newContent, details };
  };
  return { ...tool, execute: wrapped } as T;
}
