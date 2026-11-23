/**
 * Standard coding tools for the native pi adapter.
 * Each tool implements pi-agent-core's AgentTool interface with TypeBox schemas.
 *
 * All file-based tools enforce path sandboxing when allowedPaths is provided.
 * The bash tool runs with cwd set to the agent's primary working directory.
 */

import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed, isPathAllowed } from "./path-sandbox.js";
import { offloadToolOutput, offloadHint, resolveToolOutputDir, saveToolOutput } from "./tool-output.js";
import { createOutcomeTools as createOutcomeToolsCore } from "./outcome-tools.js";
import { createHttpTools as createHttpToolsCore, ALL_HTTP_TOOL_NAMES as CORE_HTTP_TOOL_NAMES } from "./http-tools.js";
import { createVaultToolsCore } from "./vault-tools.js";
import type { ResolvedVault } from "../vault/index.js";
import { createSecretMasker, resolveEnvFromVault } from "../vault/env-from-vault.js";
import type { WhatsAppMessageStore } from "@polpo-ai/core/whatsapp-store";
import { createInkTools, ALL_INK_TOOL_NAMES } from "./ink-tools.js";
import { copiedLineNumbersError, hasCopiedLineNumbers, hasEscapedLineBreaks, refuseLineNumbers, withoutLineNumbers } from "./line-number-guard.js";
import { globFiles } from "./glob-files.js";
import { withFileMutationLock } from "./file-mutation-queue.js";
import { EditError, applyEdits, applyReplacementsToOriginal, normalizeToLF, splitBom } from "./edit-text.js";
import { grepSearch } from "./grep-search.js";
import { MAX_READ_FILE_BYTES, selectFileLines, type SelectedLine } from "./read-file.js";

const MAX_READ_LINES = 500;
const MAX_OUTPUT_BYTES = 30_000;
/** Per-result cap for `read` (chars). The file is already on disk, so nothing is saved: the result says where to continue. */
const MAX_READ_CHARS = 30_000;

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: any; isError?: boolean };

/** A failed call: the model reads it as an error result (pi-agent-core's isError). */
function toolError(text: string, details: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details, isError: true };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "2 s", "1.5 s", "120 s". */
function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

/** A positive integer from a model-supplied number, else `fallback`. */
function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

// === Read Tool ===

const ReadSchema = Type.Object({
  path: Type.String({ description: "Absolute or relative path to the file to read" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: `Max number of lines to read (default ${MAX_READ_LINES})` })),
});

function createReadTool(cwd: string, sandbox: string[], fs: FileSystem): AgentTool<typeof ReadSchema> {
  return {
    name: "read",
    label: "Read File",
    description: "Read the contents of a text file. Returns line-numbered text: each line is shown as <number><TAB><text>. "
      + "The numbers are not part of the file: never copy them into write or edit. "
      + `At most ${MAX_READ_LINES} lines or ${MAX_READ_CHARS / 1000}K characters per call: for large files use offset and limit, `
      + "and continue from the offset the result gives. Images and binary files are not shown (use read_attachment); "
      + `files over ${MAX_READ_FILE_BYTES / (1024 * 1024)} MB are refused (search them with grep).`,
    parameters: ReadSchema,
    async execute(_toolCallId, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "read");
      const offset = positiveInt(params.offset, 1) - 1;
      const limit = positiveInt(params.limit, MAX_READ_LINES);
      let sel;
      try {
        sel = await selectFileLines(fs, filePath, { start: offset, limit, maxStoredChars: MAX_READ_CHARS, maxLineChars: MAX_READ_CHARS, signal });
      } catch (err: any) {
        if (err?.code === "ENOENT" || /ENOENT|not found|No such file/i.test(String(err?.message))) {
          return toolError(`Error: file not found: ${filePath}`, { path: filePath, error: "not_found" });
        }
        throw err;
      }
      if (sel.kind === "directory") {
        return toolError(`Error: ${filePath} is a directory. List it with ls, or find files with glob.`, { path: filePath, error: "directory" });
      }
      if (sel.kind === "image") {
        return toolError(`${filePath} is an image (${sel.mimeType}, ${formatSize(sel.size)}): read shows text only. Use read_attachment to view it.`,
          { path: filePath, error: "image", mimeType: sel.mimeType, bytes: sel.size });
      }
      if (sel.kind === "binary") {
        return toolError(`${filePath} is ${sel.what ?? "a binary file"} (${formatSize(sel.size)}): read shows text only. `
          + "Use read_attachment for documents and images, or inspect it with bash (e.g. file, xxd | head).",
          { path: filePath, error: "binary", bytes: sel.size });
      }
      if (sel.kind === "too_large") {
        return toolError(`Error: ${filePath} is ${formatSize(sel.size)}, over the ${MAX_READ_FILE_BYTES / (1024 * 1024)} MB read limit. `
          + `Search it with grep, or print a part with bash (e.g. sed -n '1000,1100p' ${params.path}).`,
          { path: filePath, error: "too_large", bytes: sel.size });
      }
      const total = sel.totalLines;
      if (total === 0) {
        return { content: [{ type: "text", text: "(empty file)" }], details: { path: filePath, lines: 0, total: 0 } };
      }
      if (offset >= total) {
        return toolError(`Error: offset ${offset + 1} is past the end of ${filePath} (${total} line${total === 1 ? "" : "s"}).`,
          { path: filePath, error: "offset_past_end", total });
      }
      const lines = sel.lines;
      const numbered = lines.map((l, i) => `${offset + i + 1}\t${l.text}`).join("\n");
      if (numbered.length > MAX_READ_CHARS || lines.some((l) => l.length > l.text.length)) {
        return capReadResult(filePath, lines, offset, total);
      }
      const shownEnd = offset + lines.length;
      const suffix = shownEnd < total ? `\n... (${total - shownEnd} more lines; continue with offset=${shownEnd + 1})` : "";
      return {
        content: [{ type: "text", text: numbered + suffix }],
        details: { path: filePath, lines: lines.length, total },
      };
    },
  };
}

/**
 * `read` result above MAX_READ_CHARS: keep whole lines up to the cap and tell
 * the agent the exact offset to continue from. A single line longer than the
 * cap is cut (its remainder is reachable with grep or bash).
 */
function capReadResult(filePath: string, lines: SelectedLine[], offset: number, total: number) {
  let acc = "";
  let shown = 0;
  for (const l of lines) {
    const entry = `${offset + shown + 1}\t${l.text}`;
    const sep = acc ? "\n" : "";
    if (acc.length + sep.length + entry.length > MAX_READ_CHARS || l.length > l.text.length) {
      if (shown === 0) {
        acc = `${entry.slice(0, MAX_READ_CHARS)}… [line ${offset + 1} truncated: ${l.length} chars; inspect it with grep or bash]`;
        shown = 1;
      }
      break;
    }
    acc += sep + entry;
    shown++;
  }
  const lastLine = offset + shown;
  const remaining = total - lastLine;
  const footer = remaining > 0
    ? `\n... (output capped at ${MAX_READ_CHARS} chars: showing lines ${offset + 1}-${lastLine} of ${total}. Continue with offset=${lastLine + 1} and a smaller limit, or search with grep)`
    : `\n... (output capped at ${MAX_READ_CHARS} chars: showing lines ${offset + 1}-${lastLine} of ${total})`;
  return {
    content: [{ type: "text" as const, text: acc + footer }],
    details: { path: filePath, lines: shown, total, capped: true },
  };
}

// === Write Tool ===

const WriteSchema = Type.Object({
  path: Type.String({ description: "Absolute or relative path to write to" }),
  content: Type.String({ description: "File content to write" }),
  keep_line_numbers: Type.Optional(Type.Boolean({ description: "Set only when every line really starts with a line number that belongs in the file (e.g. a numbered list): content that looks copied from read with its line numbers is refused otherwise" })),
});

function createWriteTool(cwd: string, sandbox: string[], fs: FileSystem): AgentTool<typeof WriteSchema> {
  return {
    name: "write",
    label: "Write File",
    description: "Create or overwrite a file with the given content. Parent directories are created automatically. "
      + "Use it for new files or complete rewrites; to change part of a file use edit.",
    parameters: WriteSchema,
    async execute(_toolCallId, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "write");
      if (refuseLineNumbers(params.content, params.keep_line_numbers)) {
        return toolError(copiedLineNumbersError("write", "the content", hasEscapedLineBreaks(params.content)), { path: filePath, error: "copied_line_numbers" });
      }
      const bytes = Buffer.byteLength(params.content, "utf8");
      await withFileMutationLock(filePath, async () => {
        await fs.mkdir(dirname(filePath));
        await fs.writeFile(filePath, params.content);
      });
      return {
        content: [{ type: "text", text: `File written: ${filePath} (${bytes} bytes)` }],
        details: { path: filePath, bytes },
      };
    },
  };
}

// === Edit Tool ===

const EditEntrySchema = Type.Object({
  old_text: Type.String({ description: "Exact text to replace: unique in the original file, not overlapping any other edit" }),
  new_text: Type.String({ description: "Replacement text" }),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence of old_text instead of requiring one" })),
});

const EditSchema = Type.Object({
  path: Type.String({ description: "Absolute or relative path to the file to edit" }),
  old_text: Type.Optional(Type.String({ description: "Exact text to find and replace (must be unique in the file). For several changes use edits instead" })),
  new_text: Type.Optional(Type.String({ description: "Replacement text for old_text" })),
  edits: Type.Optional(Type.Array(EditEntrySchema, {
    description: "Several replacements in one call, each matched against the original file (not one after the other). "
      + "They must not overlap: merge changes to the same or nearby lines into one edit.",
  })),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence of old_text instead of requiring a unique one" })),
  keep_line_numbers: Type.Optional(Type.Boolean({ description: "Set only when every line of new_text really starts with a line number that belongs in the file" })),
});

type EditEntry = { old_text: string; new_text: string; replace_all?: boolean };

type EditParams = {
  path: string;
  old_text?: string;
  new_text?: string;
  edits?: EditEntry[];
  replace_all?: boolean;
  keep_line_numbers?: boolean;
};

/** One edit entry in any spelling models send: old_text/new_text, oldText/newText, old_string/new_string. */
function editEntry(value: unknown): EditEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const oldText = v.old_text ?? v.oldText ?? v.old_string ?? v.oldString;
  const newText = v.new_text ?? v.newText ?? v.new_string ?? v.newString;
  if (typeof oldText !== "string" || typeof newText !== "string") return undefined;
  const replaceAll = v.replace_all ?? v.replaceAll;
  return { old_text: oldText, new_text: newText, ...(typeof replaceAll === "boolean" ? { replace_all: replaceAll } : {}) };
}

/**
 * Edit arguments as models send them: `edits` as a JSON string or a single object, camelCase
 * names, a single old_text/new_text next to edits[] (adapted from Pi's prepareEditArguments, MIT).
 */
export function prepareEditArguments(input: unknown): EditParams {
  if (!input || typeof input !== "object") return input as EditParams;
  const args = input as Record<string, unknown>;
  let edits: unknown = args.edits;
  if (typeof edits === "string") {
    try { edits = JSON.parse(edits); } catch { /* not JSON: no edits from it */ }
  }
  if (edits && !Array.isArray(edits) && typeof edits === "object") edits = [edits];
  const list: EditEntry[] = [];
  if (Array.isArray(edits)) {
    for (const e of edits) {
      const entry = editEntry(e);
      if (entry) list.push(entry);
    }
  }
  const single = editEntry(args);
  const replaceAll = args.replace_all ?? args.replaceAll;
  const keep = args.keep_line_numbers ?? args.keepLineNumbers;
  const out: EditParams = { path: args.path as string };
  if (single && list.length === 0) {
    out.old_text = single.old_text;
    out.new_text = single.new_text;
  } else if (single) {
    list.push({ old_text: single.old_text, new_text: single.new_text });
  } else {
    // a lone old_text or new_text: kept, so the tool can say what is missing
    const oldText = args.old_text ?? args.oldText;
    const newText = args.new_text ?? args.newText;
    if (typeof oldText === "string") out.old_text = oldText;
    if (typeof newText === "string") out.new_text = newText;
  }
  if (list.length > 0) out.edits = list;
  if (typeof replaceAll === "boolean") out.replace_all = replaceAll;
  if (typeof keep === "boolean") out.keep_line_numbers = keep;
  return out;
}

function isMissingFile(err: any): boolean {
  return err?.code === "ENOENT" || /ENOENT|not found|No such file/i.test(String(err?.message));
}

function createEditTool(cwd: string, sandbox: string[], fs: FileSystem): AgentTool<typeof EditSchema> {
  return {
    name: "edit",
    label: "Edit File",
    description: "Replace text in a file. old_text must match the file exactly (whitespace included) and appear once, unless replace_all is set. "
      + "Keep old_text short: the lines that change plus enough context to be unique. For several changes to one file, pass edits: "
      + "[{ old_text, new_text }, …] in one call; each is matched against the original file and they must not overlap. "
      + "Line endings (CRLF) and a byte order mark are kept; small differences in trailing spaces, quotes, dashes and Unicode spaces are tolerated.",
    parameters: EditSchema,
    prepareArguments: (args: unknown) => prepareEditArguments(args) as any,
    async execute(_toolCallId, rawParams) {
      const params = prepareEditArguments(rawParams);
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "edit");
      if (!params.edits?.length && (params.old_text === undefined) !== (params.new_text === undefined)) {
        return toolError(`Error: ${params.old_text === undefined ? "old_text" : "new_text"} is missing: pass both old_text and new_text, or edits: [{ old_text, new_text }].`,
          { path: filePath, error: "invalid_arguments" });
      }
      const entries: EditEntry[] = params.edits?.length
        ? params.edits
        : params.old_text !== undefined && params.new_text !== undefined
          ? [{ old_text: params.old_text, new_text: params.new_text }]
          : [];
      if (entries.length === 0) {
        return toolError("Error: nothing to edit: pass old_text and new_text, or edits: [{ old_text, new_text }].", { path: filePath, error: "invalid_arguments" });
      }
      for (const e of entries) {
        // A file whose lines really are numbered (old_text found with its numbers) is edited as is
        if (!hasCopiedLineNumbers(e.old_text) && refuseLineNumbers(e.new_text, params.keep_line_numbers)) {
          return toolError(copiedLineNumbersError("edit", "new_text", hasEscapedLineBreaks(e.new_text)), { path: filePath, error: "copied_line_numbers" });
        }
      }
      // Read, replace and write as one step per file: parallel edits of one file all land
      return withFileMutationLock(filePath, async (): Promise<ToolResult> => {
        let raw: string;
        try {
          // decoded keeping a byte order mark, so it is written back
          raw = fs.readFileBuffer
            ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(await fs.readFileBuffer(filePath))
            : await fs.readFile(filePath);
        } catch (err: any) {
          if (isMissingFile(err)) return toolError(`Error: file not found: ${filePath}. To create a file use write.`, { path: filePath, error: "not_found" });
          throw err;
        }
        // Matched on LF without the byte order mark; written back with both as the file had them
        const { bom, text: original } = splitBom(raw);
        const normalized = normalizeToLF(original);
        let applied;
        try {
          applied = applyEdits(
            normalized,
            entries.map((e) => ({ oldText: e.old_text, newText: e.new_text, replaceAll: e.replace_all ?? params.replace_all })),
            filePath,
          );
        } catch (err) {
          if (!(err instanceof EditError)) throw err;
          let text = err.message;
          // Often old_text was copied from read with its line numbers, which are not in the file
          if (err.code === "not_found") {
            const copied = entries.some((e) => {
              const bare = withoutLineNumbers(e.old_text);
              return bare !== e.old_text && bare.trim() !== "" && normalized.includes(normalizeToLF(bare));
            });
            if (copied) {
              text = text.replace(" not found in " + filePath + ".", ` not found in ${filePath}. It starts with line numbers like the ones the read tool shows: they are not part of the file. Use the text without them.`);
            }
          }
          return toolError(text, { path: filePath, error: err.code });
        }
        const final = bom + (original === normalized ? applied.newContent : applyReplacementsToOriginal(original, applied.replacements));
        await fs.writeFile(filePath, final);
        const count = applied.replacements.length;
        const what = entries.length > 1 ? `${entries.length} edits` : count > 1 ? `${count} replacements` : "1 replacement";
        return {
          content: [{ type: "text", text: `Edited ${filePath}: ${what}, first change at line ${applied.firstChangedLine}`
            + (applied.fuzzy ? " (matched ignoring trailing spaces and quote, dash and space styles; the changed lines were normalized)" : "") }],
          details: { path: filePath, edits: entries.length, replacements: count, firstChangedLine: applied.firstChangedLine, ...(applied.fuzzy ? { fuzzy: true } : {}) },
        };
      });
    },
  };
}

// === Bash Tool ===

const VaultRefSchema = Type.Union([
  Type.String({ description: '"service.key", e.g. "github.token"' }),
  Type.Object({ service: Type.String(), key: Type.String() }),
]);

const DEFAULT_BASH_TIMEOUT_MS = 120_000;

const BashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 120000, 2 minutes). A value below 1000 is read as seconds (300 = 5 minutes)" })),
  env_from_vault: Type.Optional(Type.Record(Type.String(), VaultRefSchema, {
    description: "Secrets from your vault as environment variables of this command only: { VAR_NAME: \"service.key\" }, "
      + "e.g. { \"GITHUB_TOKEN\": \"github.token\" }, then use \"$GITHUB_TOKEN\" in the command. Names: uppercase letters, digits and _ "
      + "(not PATH, HOME or LD_*). Values are never shown to you: they appear as *** in the output.",
  })),
});

/** The bash timeout in ms: below 1000 the number is seconds (models often write 300 meaning 5 minutes). */
export function bashTimeoutMs(timeout: number | undefined): number {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return DEFAULT_BASH_TIMEOUT_MS;
  return timeout < 1000 ? Math.round(timeout * 1000) : Math.round(timeout);
}

export interface BashToolOptions {
  /** The agent's vault (own + shared entries): the only source env_from_vault can read. */
  vault?: ResolvedVault;
  /** Where large outputs are saved (the run's FileSystem: the VM in a remote sandbox). */
  fs?: FileSystem;
}

function createBashTool(cwd: string, shell: Shell, toolOutputDir: string, opts: BashToolOptions = {}): AgentTool<typeof BashSchema> {
  return {
    name: "bash",
    label: "Execute Shell",
    description: "Execute a shell command and return its output. Use for running tests, installing packages, git operations, etc. "
      + "Default timeout 2 minutes (timeout is in ms; below 1000 it is seconds); run servers and other long-lived processes in the background. "
      + "To give the command a secret from your vault (API token, password), pass env_from_vault, e.g. "
      + "{ \"command\": \"gh repo list\", \"env_from_vault\": { \"GH_TOKEN\": \"github.token\" } }: the value is set in that command's "
      + "environment only, never written to files, and replaced with *** in the output (values shorter than 6 characters are not masked).",
    parameters: BashSchema,
    async execute(_toolCallId, params) {
      const timeout = bashTimeoutMs(params.timeout);
      // Secrets are resolved here, on the host, and only the references ("service.key") are kept
      // in details: the values exist in the command's environment and nowhere else.
      const fromVault = resolveEnvFromVault(params.env_from_vault, opts.vault);
      const envRefs = Object.keys(fromVault.refs).length > 0 ? { envFromVault: fromVault.refs } : {};
      if (fromVault.errors.length > 0) {
        const message = `env_from_vault: ${fromVault.errors.join("; ")}. The command was not run.`;
        return toolError(`Error: ${message}`, { command: params.command, error: message, ...envRefs });
      }
      // Every value (and its base64/URL-encoded forms) becomes *** before the output reaches the
      // model, the tool result, the offloaded file, activity logs and transcripts.
      const mask = createSecretMasker(fromVault.secrets);
      const started = Date.now();
      try {
        const result = await shell.execute(params.command, {
          cwd, timeout, ...(Object.keys(fromVault.env).length > 0 ? { env: fromVault.env } : {}),
        });
        const timedOut = result.timedOut === true
          || (result.exitCode !== 0 && Date.now() - started >= timeout && /timed? ?out/i.test(result.stderr));
        let output = mask(result.stdout + (result.stderr ? "\n" + result.stderr : ""));
        if (!output.trim()) output = "(no output)";
        // Above the limit: the full output goes to a private file, the model gets
        // head + tail (the tail weighs more: errors and summaries come last).
        const off = await offloadToolOutput(output, { tool: "bash", dir: toolOutputDir, maxChars: MAX_OUTPUT_BYTES, headRatio: 1 / 3, fs: opts.fs });
        const head = timedOut
          ? `Error: the command timed out after ${formatSeconds(timeout)} and was stopped. Run long-lived servers and watchers in the background `
            + "(nohup … > log 2>&1 &), or pass a larger timeout. Output before it stopped:"
          : `Exit code: ${result.exitCode}`;
        const details = off.offloaded
          ? { command: params.command, exitCode: result.exitCode, outputPath: off.path, outputBytes: off.totalBytes, outputLines: off.totalLines, ...envRefs }
          : { command: params.command, exitCode: result.exitCode, ...envRefs };
        return {
          content: [{ type: "text", text: `${head}\n${off.text}` }],
          details: timedOut ? { ...details, timedOut: true, timeoutMs: timeout } : details,
          ...(timedOut ? { isError: true } : {}),
        };
      } catch (err: any) {
        const message = mask(String(err?.message ?? err));
        return toolError(`Error: ${message}`, { command: params.command, error: message, ...envRefs });
      }
    },
  };
}

// === Glob Tool ===

const DEFAULT_GLOB_LIMIT = 200;

const GlobSchema = Type.Object({
  pattern: Type.String({ description: "Glob pattern (e.g. '**/*.ts', 'src/**/*.js')" }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default: cwd)" })),
  limit: Type.Optional(Type.Number({ description: `Max number of files (default ${DEFAULT_GLOB_LIMIT})` })),
});

function createGlobTool(cwd: string, sandbox: string[], fs: FileSystem): AgentTool<typeof GlobSchema> {
  return {
    name: "glob",
    label: "Find Files",
    description: "Find files matching a glob pattern. Returns matching file paths relative to the working directory, sorted. "
      + "node_modules and .git are skipped unless the pattern names them.",
    parameters: GlobSchema,
    async execute(_toolCallId, params) {
      const searchDir = params.path ? resolve(cwd, params.path) : cwd;
      assertPathAllowed(searchDir, sandbox, "glob");
      const limit = positiveInt(params.limit, DEFAULT_GLOB_LIMIT);
      // Walked with the FileSystem (no shell: find and ls are missing on Windows, and find -name
      // never matched a pattern with a "/"); paths relative to the working directory, as before.
      // One result past the limit tells "exactly N" apart from "more than N".
      const matches = await globFiles(fs, searchDir, params.pattern, { limit: limit + 1, canEnter: (dir) => isPathAllowed(dir, sandbox) });
      const truncated = matches.length > limit;
      const files = matches.slice(0, limit).map((m) => relative(cwd, join(searchDir, m)).replace(/\\/g, "/"));
      const text = files.length === 0
        ? "No files found"
        : files.join("\n") + (truncated ? `\n\n[${limit} files limit reached: there are more. Use limit=${limit * 2}, or a narrower pattern or path]` : "");
      return {
        content: [{ type: "text", text }],
        details: { pattern: params.pattern, count: files.length, ...(truncated ? { truncated: true } : {}) },
      };
    },
  };
}

// === Grep Tool ===

const DEFAULT_GREP_LIMIT = 100;

const GrepSchema = Type.Object({
  pattern: Type.String({ description: "Regex to search for (ripgrep syntax where installed, else POSIX extended); with literal: true, plain text" }),
  path: Type.Optional(Type.String({ description: "File or directory to search in (default: cwd)" })),
  glob: Type.Optional(Type.String({ description: "Only files matching this glob, e.g. '*.ts' or '**/*.spec.ts'" })),
  include: Type.Optional(Type.String({ description: "Same as glob (kept for compatibility)" })),
  ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as plain text, not a regex" })),
  context: Type.Optional(Type.Number({ description: "Lines of context to show before and after each match" })),
  limit: Type.Optional(Type.Number({ description: `Max number of matches shown (default ${DEFAULT_GREP_LIMIT})` })),
});

// Caps to keep grep output context-friendly. Long minified lines or
// matches in vendored bundles can otherwise dump hundreds of KB into
// the LLM context. Per-line cap protects against single huge lines;
// total-byte cap protects against many medium lines. The agent still
// sees the TOTAL match count so it knows if it needs to refine.
const GREP_MAX_LINE_CHARS = 240;
const GREP_MAX_TOTAL_CHARS = 8_000;

function createGrepTool(cwd: string, sandbox: string[], shell: Shell, toolOutputDir: string, fs?: FileSystem): AgentTool<typeof GrepSchema> {
  return {
    name: "grep",
    label: "Search Code",
    description: "Search file contents. Returns matching lines as path:line:text (paths relative to the working directory). "
      + "Uses ripgrep when installed (respects .gitignore), else grep (skips .git and node_modules); binary files are skipped. "
      + "Options: glob, ignore_case, literal, context, limit. Long lines and large outputs are truncated: refine the pattern if results are cut.",
    parameters: GrepSchema,
    async execute(_toolCallId, params) {
      const searchPath = params.path ? resolve(cwd, params.path) : cwd;
      assertPathAllowed(searchPath, sandbox, "grep");
      const limit = positiveInt(params.limit, DEFAULT_GREP_LIMIT);
      const rel = relative(cwd, searchPath);
      // Inside the working directory the program gets a relative path, so results are relative too
      const target = rel === "" ? "." : !rel.startsWith("..") && !isAbsolute(rel) ? rel : searchPath;
      const outcome = await grepSearch(shell, {
        pattern: params.pattern,
        path: target,
        cwd,
        ignoreCase: params.ignore_case,
        literal: params.literal,
        context: typeof params.context === "number" ? Math.max(0, Math.min(20, Math.floor(params.context))) : undefined,
        glob: params.glob ?? params.include,
      });
      if (!outcome.ok) {
        const text = outcome.kind === "regex"
          ? `Error: invalid regex ${JSON.stringify(params.pattern)}: ${outcome.error}\nEscape special characters, or pass literal: true to search for the text as is.`
          : `Error: ${outcome.error}`;
        return toolError(text, { pattern: params.pattern, error: outcome.kind, engine: outcome.engine });
      }
      if (outcome.matches === 0) {
        return { content: [{ type: "text", text: "No matches found" }], details: { pattern: params.pattern, count: 0, engine: outcome.engine } };
      }
      // Up to `limit` matches (with their context lines), each line cut, within the total cap
      let acc = "";
      let shownMatches = 0;
      let cut = false;
      for (const line of outcome.lines) {
        if (line.isMatch && shownMatches >= limit) { cut = true; break; }
        const text = line.text.length > GREP_MAX_LINE_CHARS ? `${line.text.slice(0, GREP_MAX_LINE_CHARS)}…` : line.text;
        if (acc.length + text.length + 1 > GREP_MAX_TOTAL_CHARS) { cut = true; break; }
        acc += (acc ? "\n" : "") + text;
        if (line.isMatch) shownMatches++;
      }
      acc = acc.replace(/\n--$/, "");
      const totalCount = outcome.matches;
      const omitted = totalCount - shownMatches;
      const wasTruncated = omitted > 0 || cut;
      let text = acc;
      if (omitted > 0) {
        text += `\n… ${omitted} more match${omitted === 1 ? "" : "es"} truncated (${totalCount} in all); `
          + (shownMatches >= limit ? `use limit=${limit * 2}, or ` : "") + "refine the pattern or narrow path/glob.";
      }
      // Omitted matches are saved in full (untruncated lines) so they stay
      // reachable. Not when searching the offload dir itself: that would just
      // copy an already saved file.
      let outputPath: string | undefined;
      if (wasTruncated && !isPathAllowed(searchPath, [toolOutputDir])) {
        try {
          outputPath = await saveToolOutput(outcome.lines.map((l) => l.text).join("\n") + "\n", "grep", toolOutputDir, Date.now(), fs);
          text += `\n${offloadHint(outputPath)}`;
        } catch { /* keep the plain truncated result */ }
      }
      return {
        content: [{ type: "text", text }],
        details: {
          pattern: params.pattern,
          count: totalCount,
          shown: shownMatches,
          truncated: wasTruncated,
          engine: outcome.engine,
          ...(outputPath ? { outputPath } : {}),
        },
      };
    },
  };
}

// === Ls Tool ===

const DEFAULT_LS_LIMIT = 500;

const LsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: cwd)" })),
  limit: Type.Optional(Type.Number({ description: `Max number of entries (default ${DEFAULT_LS_LIMIT})` })),
});

function createLsTool(cwd: string, sandbox: string[], fs: FileSystem): AgentTool<typeof LsSchema> {
  return {
    name: "ls",
    label: "List Directory",
    description: "List files and directories in a given path, sorted; directories end with /.",
    parameters: LsSchema,
    async execute(_toolCallId, params) {
      const dir = params.path ? resolve(cwd, params.path) : cwd;
      assertPathAllowed(dir, sandbox, "ls");
      const limit = positiveInt(params.limit, DEFAULT_LS_LIMIT);
      let entries: Array<{ name: string; isDirectory: boolean }>;
      try {
        // One call with the types where the FileSystem has it (a remote VM: one round trip, not one per entry)
        entries = fs.readdirWithTypes
          ? await fs.readdirWithTypes(dir)
          : await Promise.all((await fs.readdir(dir)).map(async (name) => {
            try { return { name, isDirectory: (await fs.stat(join(dir, name))).isDirectory }; } catch { return { name, isDirectory: false }; }
          }));
      } catch (err: any) {
        const code = err?.code;
        const message = code === "ENOENT" ? `Error: directory not found: ${dir}`
          : code === "ENOTDIR" ? `Error: ${dir} is a file, not a directory: read it with read`
          : `Error: cannot list ${dir}: ${err?.message ?? err}`;
        return toolError(message, { path: dir, error: code ?? "failed" });
      }
      entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "(empty directory)" }], details: { path: dir, count: 0 } };
      }
      const shown = entries.slice(0, limit).map((e) => (e.isDirectory ? `${e.name}/` : e.name));
      const truncated = entries.length > limit;
      const text = shown.join("\n") + (truncated ? `\n\n[${limit} of ${entries.length} entries shown. Use limit=${Math.min(entries.length, limit * 2)} for more, or glob to find files]` : "");
      return {
        content: [{ type: "text", text }],
        details: { path: dir, count: entries.length, ...(truncated ? { shown: limit, truncated: true } : {}) },
      };
    },
  };
}

// === Tool name matching (wildcard support) ===

/**
 * Check if a tool name matches an allowed pattern.
 * Supports exact match and trailing wildcard: "browser_*" matches "browser_navigate".
 */
export function matchToolPattern(pattern: string, toolName: string): boolean {
  const p = pattern.toLowerCase();
  const n = toolName.toLowerCase();
  if (p === n) return true;
  if (p.endsWith("*")) {
    return n.startsWith(p.slice(0, -1));
  }
  return false;
}

/**
 * Expand wildcard patterns in an allowedTools list against all known tool names.
 * E.g. ["browser_*", "http_fetch"] → ["browser_navigate", "browser_click", ..., "http_fetch"].
 * Non-wildcard entries pass through as-is (even if not in allNames — factory will just skip them).
 */
export function expandToolWildcards(allowedTools: string[], allNames: readonly string[]): string[] {
  const result = new Set<string>();
  for (const pattern of allowedTools) {
    if (pattern.includes("*")) {
      for (const name of allNames) {
        if (matchToolPattern(pattern, name)) result.add(name);
      }
    } else {
      result.add(pattern.toLowerCase());
    }
  }
  return [...result];
}

// === Factory ===

/** Tool name to filter by in allowedTools config */
type SystemToolName = "read" | "write" | "edit" | "bash" | "glob" | "grep" | "ls";

const ALL_TOOL_NAMES: SystemToolName[] = ["read", "write", "edit", "bash", "glob", "grep", "ls"];

export interface SystemToolsOptions {
  /** Where large outputs are offloaded (default: resolveToolOutputDir({ outputDir, polpoDir, agentName })). */
  toolOutputDir?: string;
  /** Polpo directory, used for the default offload dir when there is no outputDir. */
  polpoDir?: string;
  /** Agent name, used for the default per-agent offload dir. */
  agentName?: string;
  /**
   * The run's effective sandbox provider ("local", "bwrap", "docker", "daytona", "e2b"). Anything
   * but "local" makes vault_get hide secret values (commands get them through env_from_vault).
   * Undefined = no sandbox.
   */
  sandboxProvider?: string;
}

/**
 * Create the standard set of coding tools scoped to a working directory.
 * If allowedTools is provided, only those tools are included.
 * If allowedPaths is provided, file-based tools enforce path sandboxing.
 *
 * Core tools (always included regardless of allowedTools):
 * - read, write, edit, bash, glob, grep, ls
 * - register_outcome
 * - http_fetch, http_download
 * - vault_get, vault_list (when vault is provided)
 *
 * Large outputs (bash, grep, http_fetch) are offloaded to `options.toolOutputDir`
 * (default `<outputDir>/tool-output/`), which read/grep/glob/ls can always read.
 */
export function createSystemTools(cwd: string, allowedTools?: string[], allowedPaths?: string[], outputDir?: string, vault?: ResolvedVault, fs?: FileSystem, shell?: Shell, options: SystemToolsOptions = {}): AgentTool<any>[] {
  const _fs = fs ?? new NodeFileSystem();
  const _shell = shell ?? new NodeShell();
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);
  const toolOutputDir = options.toolOutputDir
    ?? resolveToolOutputDir({ outputDir, polpoDir: options.polpoDir, agentName: options.agentName });
  // Offloaded outputs must be readable by read/grep/glob/ls even when the
  // offload dir sits outside the sandbox (read-only: write/edit are unchanged).
  const readSandbox = isPathAllowed(toolOutputDir, sandbox) ? sandbox : [...sandbox, toolOutputDir];

  const factories: Record<SystemToolName, () => AgentTool<any>> = {
    read: () => createReadTool(cwd, readSandbox, _fs),
    write: () => createWriteTool(cwd, sandbox, _fs),
    edit: () => createEditTool(cwd, sandbox, _fs),
    bash: () => createBashTool(cwd, _shell, toolOutputDir, { vault, fs: _fs }),
    glob: () => createGlobTool(cwd, readSandbox, _fs),
    grep: () => createGrepTool(cwd, readSandbox, _shell, toolOutputDir, _fs),
    ls: () => createLsTool(cwd, readSandbox, _fs),
  };

  const names = allowedTools
    ? ALL_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_TOOL_NAMES;

  const tools = names.map(n => factories[n]());

  // register_outcome is always included — agents must always be able to declare artifacts
  tools.push(...createOutcomeToolsCore(cwd, allowedPaths, allowedTools, outputDir, _fs));

  // http_fetch + http_download are always included — core tools with SSRF protection
  tools.push(...createHttpToolsCore(cwd, allowedPaths, allowedTools, toolOutputDir, _fs));

  // vault_get + vault_list are always included — core tools for credential access
  if (vault) {
    tools.push(...createVaultToolsCore(vault, { sandboxProvider: options.sandboxProvider }));
  }

  return tools;
}

// === Extended Tools Factory ===

import { createBrowserTools, ALL_BROWSER_TOOL_NAMES } from "./browser-tools.js";
import { ALL_HTTP_TOOL_NAMES } from "./http-tools.js";
import { createEmailTools, ALL_EMAIL_TOOL_NAMES } from "./email-tools.js";
import { createVaultTools, ALL_VAULT_TOOL_NAMES } from "./vault-tools.js";
import { createImageTools, ALL_IMAGE_TOOL_NAMES } from "./image-tools.js";
import { createAudioTools, ALL_AUDIO_TOOL_NAMES } from "./audio-tools.js";
import { createExcelTools, ALL_EXCEL_TOOL_NAMES } from "./excel-tools.js";
import { createPdfTools, ALL_PDF_TOOL_NAMES } from "./pdf-tools.js";
import { createDocxTools, ALL_DOCX_TOOL_NAMES } from "./docx-tools.js";
import { createSearchTools, ALL_SEARCH_TOOL_NAMES } from "./search-tools.js";
import { createWhatsAppTools, ALL_WHATSAPP_TOOL_NAMES } from "./whatsapp-tools.js";
import { createPhoneTools, ALL_PHONE_TOOL_NAMES } from "./phone-tools.js";
import { createAttachmentTools, ALL_ATTACHMENT_TOOL_NAMES } from "./attachment-tools.js";
import { ALL_OUTCOME_TOOL_NAMES } from "./outcome-tools.js";

export type { BrowserToolName } from "./browser-tools.js";
export type { HttpToolName } from "./http-tools.js";
export type { EmailToolName } from "./email-tools.js";
export type { OutcomeToolName } from "./outcome-tools.js";
export type { VaultToolName } from "./vault-tools.js";
export type { ImageToolName } from "./image-tools.js";
export type { AudioToolName } from "./audio-tools.js";
export type { ExcelToolName } from "./excel-tools.js";
export type { PdfToolName } from "./pdf-tools.js";
export type { DocxToolName } from "./docx-tools.js";
export type { SearchToolName } from "./search-tools.js";
export type { WhatsAppToolName } from "./whatsapp-tools.js";
export type { PhoneToolName } from "./phone-tools.js";
export type { InkToolName } from "./ink-tools.js";

/** All known tool names across all categories */
export type ExtendedToolName = SystemToolName
  | import("./browser-tools.js").BrowserToolName
  | import("./http-tools.js").HttpToolName
  | import("./email-tools.js").EmailToolName
  | import("./outcome-tools.js").OutcomeToolName
  | import("./vault-tools.js").VaultToolName
  | import("./image-tools.js").ImageToolName
  | import("./audio-tools.js").AudioToolName
  | import("./excel-tools.js").ExcelToolName
  | import("./pdf-tools.js").PdfToolName
  | import("./docx-tools.js").DocxToolName
  | import("./search-tools.js").SearchToolName
  | import("./whatsapp-tools.js").WhatsAppToolName
  | import("./phone-tools.js").PhoneToolName
  | import("./ink-tools.js").InkToolName;

/** All available tool names for documentation/config validation */
export const ALL_EXTENDED_TOOL_NAMES: string[] = [
  ...ALL_TOOL_NAMES,
  ...ALL_BROWSER_TOOL_NAMES,
  ...ALL_HTTP_TOOL_NAMES,
  ...ALL_EMAIL_TOOL_NAMES,
  ...ALL_OUTCOME_TOOL_NAMES,
  ...ALL_VAULT_TOOL_NAMES,
  ...ALL_IMAGE_TOOL_NAMES,
  ...ALL_AUDIO_TOOL_NAMES,
  ...ALL_EXCEL_TOOL_NAMES,
  ...ALL_PDF_TOOL_NAMES,
  ...ALL_DOCX_TOOL_NAMES,
  ...ALL_SEARCH_TOOL_NAMES,
  ...ALL_WHATSAPP_TOOL_NAMES,
  ...ALL_PHONE_TOOL_NAMES,
  ...ALL_INK_TOOL_NAMES,
  ...ALL_ATTACHMENT_TOOL_NAMES,
];

export interface CreateAllToolsOptions {
  /** Working directory for the agent */
  cwd: string;
  /** Tool name filter — only include tools with these names.
   *  Extended tools are auto-loaded when their names appear here (e.g. "browser_*", "email_*", "image_*", "video_*", "audio_*", "excel_*", "pdf_*", "docx_*", "search_*", "whatsapp_*", "phone_*").
   *  If omitted, only core coding tools are included. */
  allowedTools?: string[];
  /** Filesystem sandbox paths */
  allowedPaths?: string[];
  /** Browser session name for isolation (default: "default"). */
  browserSession?: string;
  /** Browser profile directory for agent-browser persistent state (cookies, localStorage).
   *  Typically `.polpo/browser-profiles/<agent>/`. Passed as --profile to agent-browser. */
  browserProfileDir?: string;
  /** The agent's sandbox network rule for the browser (see browser-network-guard.ts). */
  browserNetwork?: import("./browser-network-guard.js").BrowserNetworkGuard;
  /** The agent's egress proxy for the browser (settings.egressProxies[agent.browserEgress]). */
  browserEgress?: import("./browser-egress.js").BrowserEgressConfig;
  /** Resolved vault credentials for the agent */
  vault?: ResolvedVault;
  /** Allowed recipient email domains for email_send. */
  emailAllowedDomains?: string[];
  /** Per-task output directory for deliverables. Passed to outcome tools. */
  outputDir?: string;
  /** WhatsApp message store (for whatsapp_* tools). */
  whatsappStore?: WhatsAppMessageStore;
  /** WhatsApp send function (for whatsapp_send tool). */
  whatsappSendMessage?: (jid: string, text: string) => Promise<string | undefined>;
  /** WhatsApp media send function (for whatsapp_send_file tool). */
  whatsappSendMedia?: (jid: string, opts: {
    path: string;
    caption?: string;
    mimeType?: string;
    fileName?: string;
    mediaKind?: "auto" | "image" | "video" | "audio" | "document";
    viewOnce?: boolean;
    /** The file's bytes, when they were read elsewhere (the agent's files may live in a remote sandbox). */
    data?: Uint8Array;
  }) => Promise<string | undefined>;
  /** WhatsApp read receipt function (for whatsapp_read markRead). */
  whatsappMarkRead?: (keys: { remoteJid: string; id: string; fromMe?: boolean; participant?: string }[]) => Promise<void>;
  /** Polpo directory (.polpo/) for Ink tools and the default offload dir of large tool outputs. */
  polpoDir?: string;
  /** Agent name — scopes the offload dir of large tool outputs when there is no outputDir (default: browserSession). */
  agentName?: string;
  /**
   * Where the agent's files live (default: NodeFileSystem). Every tool that reads or writes the
   * agent's files (read/write/edit/ls, pdf, excel, docx, images, audio, downloads, attachments,
   * outcomes, screenshots) goes through it, so with a remote sandbox the bytes stay in the VM.
   */
  fs?: FileSystem;
  /** Where commands run (default: NodeShell). A remote sandbox's shell also runs the browser. */
  shell?: Shell;
  /** The run's effective sandbox provider: anything but "local" hides secret values from vault_get. */
  sandboxProvider?: string;
}

/**
 * Create all available tools for an agent, including extended tool categories.
 *
 * Core tools (always included): read, write, edit, bash, glob, grep, ls,
 * register_outcome, http_fetch, http_download, vault_get, vault_list.
 *
 * Extended categories must be explicitly enabled via allowedTools patterns.
 *
 * When allowedTools is provided, it acts as a filter across ALL categories — any tool whose name
 * appears in allowedTools will be included (and its category auto-enabled).
 */
export async function createAllTools(options: CreateAllToolsOptions): Promise<AgentTool<any>[]> {
  const { cwd, allowedPaths, browserSession } = options;
  const tools: AgentTool<any>[] = [];

  // Expand wildcards in allowedTools once — e.g. "browser_*" → all browser tool names.
  // This way individual factory functions don't need wildcard awareness.
  const rawAllowed = options.allowedTools;
  const allowedTools = rawAllowed
    ? expandToolWildcards(rawAllowed, ALL_EXTENDED_TOOL_NAMES)
    : undefined;

  // Helper: check if any tool from a category is in the (expanded) allowedTools list
  const categoryRequested = (names: readonly string[]) =>
    allowedTools?.some(a => names.some(n => n === a.toLowerCase()));

  // Core coding tools (always included unless filtered out) — includes vault_get/vault_list
  // Large outputs: <outputDir>/tool-output/ for task runs, else <polpoDir>/tmp/tool-output/<agent>/.
  const toolOutputDir = resolveToolOutputDir({
    outputDir: options.outputDir,
    polpoDir: options.polpoDir,
    agentName: options.agentName ?? browserSession,
  });
  tools.push(...createSystemTools(cwd, allowedTools, allowedPaths, options.outputDir, options.vault, options.fs, options.shell, { toolOutputDir, sandboxProvider: options.sandboxProvider }));

  // Ink tools (always included when polpoDir is available)
  if (options.polpoDir) {
    tools.push(...createInkTools(options.polpoDir, allowedTools));
  }

  // Browser tools — activated when any browser_* tool is in allowedTools
  if (categoryRequested(ALL_BROWSER_TOOL_NAMES)) {
    tools.push(...createBrowserTools(cwd, browserSession, allowedTools, options.browserProfileDir, toolOutputDir, allowedPaths, options.browserNetwork, { shell: options.shell, fs: options.fs, vault: options.vault, egress: options.browserEgress }));
  }

  // Email tools — activated when any email_* tool is in allowedTools
  if (categoryRequested(ALL_EMAIL_TOOL_NAMES)) {
    tools.push(...createEmailTools(cwd, allowedPaths, allowedTools, options.vault, options.emailAllowedDomains, options.outputDir, toolOutputDir, options.fs));
  }

  // Image & video tools — activated when any image_* or video_* tool is in allowedTools
  if (categoryRequested(ALL_IMAGE_TOOL_NAMES)) {
    tools.push(...createImageTools(cwd, allowedPaths, allowedTools, options.vault, options.fs));
  }

  // Audio tools — activated when any audio_* tool is in allowedTools
  if (categoryRequested(ALL_AUDIO_TOOL_NAMES)) {
    tools.push(...createAudioTools(cwd, allowedPaths, allowedTools, options.vault, options.fs));
  }

  // Excel tools — activated when any excel_* tool is in allowedTools
  if (categoryRequested(ALL_EXCEL_TOOL_NAMES)) {
    tools.push(...createExcelTools(cwd, allowedPaths, allowedTools, options.fs));
  }

  // PDF tools — activated when any pdf_* tool is in allowedTools
  if (categoryRequested(ALL_PDF_TOOL_NAMES)) {
    tools.push(...createPdfTools(cwd, allowedPaths, allowedTools, options.fs, options.shell));
  }

  // Docx tools — activated when any docx_* tool is in allowedTools
  if (categoryRequested(ALL_DOCX_TOOL_NAMES)) {
    tools.push(...createDocxTools(cwd, allowedPaths, allowedTools, options.fs));
  }

  // Search tools (Exa) — activated when any search_* tool is in allowedTools
  if (categoryRequested(ALL_SEARCH_TOOL_NAMES)) {
    tools.push(...createSearchTools(options.vault, allowedTools));
  }

  // WhatsApp tools — activated when any whatsapp_* tool is in allowedTools AND store is available
  if (categoryRequested(ALL_WHATSAPP_TOOL_NAMES) && options.whatsappStore && options.whatsappSendMessage) {
    tools.push(...createWhatsAppTools(
      {
        store: options.whatsappStore,
        sendMessage: options.whatsappSendMessage,
        sendMedia: options.whatsappSendMedia,
        markRead: options.whatsappMarkRead,
      },
      allowedTools,
      cwd,
      allowedPaths,
      options.fs,
    ));
  }

  // Phone tools (VAPI) — activated when any phone_* tool is in allowedTools
  if (categoryRequested(ALL_PHONE_TOOL_NAMES)) {
    tools.push(...createPhoneTools(options.vault, allowedTools));
  }

  // Attachment tool — always included (reads any file type attached by user)
  tools.push(...createAttachmentTools(cwd, allowedPaths, allowedTools, options.fs));

  // HTTP, register_outcome, and vault are already included via createSystemTools() above — no need to add again

  return tools;
}
