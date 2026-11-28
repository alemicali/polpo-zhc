/**
 * Outcome registration tool.
 *
 * The ONLY mechanism for agents to declare task outcomes. Producing a file
 * (via write, pdf_create, bash, etc.) does NOT auto-register it as an
 * outcome — the agent must explicitly call register_outcome for every
 * deliverable artifact.
 *
 * Supports files, media, text, URLs, and structured JSON data.
 * The tool validates that file outcomes actually exist before registering
 * them. On a remote computer (the agent's files live in its VM) the file is
 * read through the run's workspace and copied into the task's output
 * directory on this server, so the deliverable outlives the VM; the outcome
 * points at that copy. Registering the same thing twice is a no-op (an agent
 * retrying cannot pile up duplicates).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveAllowedPaths, isPathAllowed, isRemoteRoots, withAllowedPaths } from "./path-sandbox.js";
import { fileSize as sizeOf, readBytes, toolFs } from "./tool-fs.js";

/** The largest file a remote computer's outcome may be (copied to this server). */
export const OUTCOME_FILE_MAX_BYTES = 100 * 1024 * 1024;

export interface OutcomeToolOptions {
  /**
   * The agent's files live in a remote VM (`fs` is its workspace): a registered file is copied
   * into the output directory on this server.
   */
  remote?: boolean;
  /** Copy limit for a remote file (default OUTCOME_FILE_MAX_BYTES). */
  maxBytes?: number;
}

// ─── Tool: register_outcome ───

const RegisterOutcomeSchema = Type.Object({
  type: Type.Union([
    Type.Literal("file"),
    Type.Literal("media"),
    Type.Literal("text"),
    Type.Literal("url"),
    Type.Literal("json"),
  ], { description: "Outcome type. 'file' for documents (PDF, Excel, DOCX, HTML, archives). 'media' for images/audio/video. 'text' for inline text content. 'url' for links. 'json' for structured data." }),
  label: Type.String({ description: "Human-readable label for this outcome (e.g. 'Q4 Sales Report', 'Architecture Diagram', 'API Response')" }),
  path: Type.Optional(Type.String({ description: "File path (required for type 'file' or 'media'). Relative paths resolved from your working directory. On a remote computer: a file of that computer (its working directory, home, /tmp or a mounted /volumes/<name>), copied into the task output." })),
  text: Type.Optional(Type.String({ description: "Text content (for type 'text'). The actual content to include in the outcome." })),
  url: Type.Optional(Type.String({ description: "URL (for type 'url'). Link to external resource." })),
  data: Type.Optional(Type.Unknown({ description: "Structured data (for type 'json'). Any JSON-serializable value." })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags for categorization (e.g. ['report', 'quarterly'])" })),
});

/** MIME type inference from file extension. */
const EXT_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac", ".m4a": "audio/mp4",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".json": "application/json",
  ".txt": "text/plain",
  ".html": "text/html", ".htm": "text/html",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
};

function guessMime(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return undefined;
  return EXT_MIME[filePath.slice(dot).toLowerCase()];
}

function createRegisterOutcomeTool(cwd: string, sandbox: string[], fs: FileSystem, outputDir?: string, opts: OutcomeToolOptions = {}): AgentTool<typeof RegisterOutcomeSchema> {
  // Use outputDir in examples when available so the agent naturally writes there
  const exampleDir = outputDir ? outputDir.replace(/\/$/, "") : "output";
  // the task's output directory is always a place deliverables may be registered from
  const allowed = outputDir && !isPathAllowed(resolve(outputDir), sandbox) ? withAllowedPaths(sandbox, resolve(outputDir)) : sandbox;
  const maxBytes = opts.maxBytes ?? OUTCOME_FILE_MAX_BYTES;
  const where = opts.remote ? "in your computer" : "on disk";
  // a remote computer: any file of its own folders (home, /tmp, mounted volumes…), copied here
  const remoteRoots = isRemoteRoots(allowed);
  /** What this run registered already (type + path or content): repeats are not added again. */
  const registered = new Map<string, string>();
  /** Remote file → its copy on this server. */
  const copies = new Map<string, string>();
  return {
    name: "register_outcome",
    label: "Register Outcome",
    description:
      "Register a file, text, URL, or data as a task outcome. This is the ONLY way to declare " +
      "deliverables — producing files does NOT auto-register them. You MUST call this tool for " +
      "every artifact that should appear in notifications and the task record.\n\n" +
      (outputDir ? `Your task output directory is: ${outputDir}\nWrite deliverable files there before registering them.\n\n` : "") +
      (remoteRoots ? `You work on a remote computer: a path is a file of that computer, under ${allowed.join(", ")} (mounted volumes included). `
        + "The file is copied into the task output on the Polpo server: no need to copy it yourself.\n\n" : "") +
      "Examples:\n" +
      `- After creating a PDF: register_outcome({type: 'file', label: 'Sales Report', path: '${exampleDir}/report.pdf'})\n` +
      `- After generating an image: register_outcome({type: 'media', label: 'Revenue Chart', path: '${exampleDir}/revenue.png'})\n` +
      "- To share a deploy URL: register_outcome({type: 'url', label: 'Staging Deploy', url: 'https://staging.example.com'})\n" +
      "- To include analysis results: register_outcome({type: 'text', label: 'Summary', text: 'Revenue increased 23%...'})\n" +
      "- To return structured data: register_outcome({type: 'json', label: 'Metrics', data: {revenue: 1234}})",
    parameters: RegisterOutcomeSchema,
    async execute(_id, params) {
      const { type, label } = params;

      // Validate type-specific fields
      if ((type === "file" || type === "media") && !params.path) {
        return {
          content: [{ type: "text", text: `Error: 'path' is required for outcome type '${type}'` }],
          details: { error: "missing_path" },
        };
      }
      if (type === "text" && !params.text) {
        return {
          content: [{ type: "text", text: `Error: 'text' is required for outcome type 'text'` }],
          details: { error: "missing_text" },
        };
      }
      if (type === "url" && !params.url) {
        return {
          content: [{ type: "text", text: `Error: 'url' is required for outcome type 'url'` }],
          details: { error: "missing_url" },
        };
      }
      if (type === "json" && params.data === undefined) {
        return {
          content: [{ type: "text", text: `Error: 'data' is required for outcome type 'json'` }],
          details: { error: "missing_data" },
        };
      }

      // For file/media outcomes, validate the file exists
      let filePath: string | undefined;
      let fileSize: number | undefined;
      let mimeType: string | undefined;
      let copiedFrom: string | undefined;

      if (params.path) {
        const requested = resolve(cwd, params.path);
        if (!isPathAllowed(requested, allowed)) {
          if (remoteRoots) {
            return fail(`Error: cannot register ${requested}: it is outside the folders deliverables can come from on your computer (${allowed.join(", ")}: `
              + `your working directory, your output directory, your home, /tmp and the volumes mounted for this run). Put the file under one of them and register that path.`,
            { error: "path_not_allowed", path: requested, allowedRoots: [...allowed] });
          }
          const dirs = [...new Set([cwd, ...(outputDir ? [outputDir] : [])])].join(", ");
          return fail(`Error: cannot register ${requested}: it is outside the folders deliverables can come from (${dirs}).`
            + (outputDir ? ` Write the file to ${outputDir} and register that path.` : ""), { error: "path_not_allowed", path: requested });
        }

        // where the agent's files live (this machine or the computer's VM)
        let size: number | undefined;
        try {
          size = (await fs.exists(requested)) ? await sizeOf(fs, requested) : undefined;
        } catch (err) {
          return fail(`Error: could not read ${requested} ${where}: ${err instanceof Error ? err.message : String(err)}. Try again; if it keeps failing, register the content as type 'text'.`, { error: "read_failed", path: requested });
        }
        if (size === undefined) {
          return fail(`Error: file not found at ${requested} ${where} (working directory ${cwd}). Check the path (ls), write the file there, then register it again.`, { error: "file_not_found", path: requested });
        }
        filePath = requested;
        fileSize = size;

        // a remote computer's file: copied to this server (the VM may go away, the output stays)
        if (opts.remote && outputDir) {
          if (size > maxBytes) {
            return fail(`Error: ${requested} is too large to register (${formatBytes(size)}; the limit is ${formatBytes(maxBytes)}). Compress or split it, or register a link to where it is published.`, { error: "too_large", path: requested, size, limit: maxBytes });
          }
          let bytes: Buffer;
          try {
            bytes = await readBytes(fs, requested);
          } catch (err) {
            return fail(`Error: could not copy ${requested} from your computer: ${err instanceof Error ? err.message : String(err)}. Try again; if it keeps failing, register the content as type 'text'.`, { error: "copy_failed", path: requested });
          }
          if (bytes.byteLength > maxBytes) {
            return fail(`Error: ${requested} is too large to register (${formatBytes(bytes.byteLength)}; the limit is ${formatBytes(maxBytes)}).`, { error: "too_large", path: requested, size: bytes.byteLength, limit: maxBytes });
          }
          const local = await serverCopyPath(requested, resolve(outputDir), bytes, copies);
          try {
            await mkdir(dirname(local), { recursive: true });
            await writeFile(local, bytes);
          } catch (err) {
            return fail(`Error: could not store ${requested} on the Polpo server: ${err instanceof Error ? err.message : String(err)}`, { error: "store_failed", path: requested });
          }
          copiedFrom = requested;
          filePath = local;
          fileSize = bytes.byteLength;
        }

        mimeType = guessMime(filePath);
      }

      // the same deliverable again (an agent retrying): nothing new is added
      const key = outcomeKey(type, copiedFrom ?? filePath, params);
      const previous = registered.get(key);
      if (previous !== undefined) {
        return {
          content: [{ type: "text", text: `Already registered: "${previous}" (${type})${filePath ? ` at ${filePath}` : ""}${copiedFrom ? " (the copy is up to date)" : ""}. Nothing else to do for it.` }],
          details: { duplicate: true, ...(filePath ? { path: filePath } : {}) },
        };
      }
      registered.set(key, label);

      // Build the details object that engine.ts collectOutcome() will consume.
      // The key fields are: path, outcomeType, outcomeLabel, outcomeTags,
      // outcomeMimeType, outcomeSize, outcomeText, outcomeUrl, outcomeData.
      const details: Record<string, unknown> = {
        path: filePath,
        outcomeType: type,
        outcomeLabel: label,
      };

      if (mimeType) details.outcomeMimeType = mimeType;
      if (fileSize !== undefined) details.outcomeSize = fileSize;
      if (copiedFrom) details.copiedFrom = copiedFrom;
      if (params.text) details.outcomeText = params.text;
      if (params.url) details.outcomeUrl = params.url;
      if (params.data !== undefined) details.outcomeData = params.data;
      if (params.tags) details.outcomeTags = params.tags;

      // Build human-readable confirmation
      const parts = [`Outcome registered: "${label}" (${type})`];
      if (filePath) parts.push(`  Path: ${filePath}`);
      if (copiedFrom) parts.push(`  Copied from your computer: ${copiedFrom}`);
      if (mimeType) parts.push(`  MIME: ${mimeType}`);
      if (fileSize !== undefined) parts.push(`  Size: ${formatBytes(fileSize)}`);
      if (params.url) parts.push(`  URL: ${params.url}`);
      if (params.text) parts.push(`  Text: ${params.text.slice(0, 100)}${params.text.length > 100 ? "..." : ""}`);
      if (params.tags?.length) parts.push(`  Tags: ${params.tags.join(", ")}`);

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details,
      };
    },
  };
}

function fail(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

/** What makes two registrations the same deliverable. */
function outcomeKey(type: string, path: string | undefined, params: { text?: string; url?: string; data?: unknown }): string {
  if (path) return `${type}:path:${path}`;
  const body = type === "text" ? params.text : type === "url" ? params.url : JSON.stringify(params.data ?? null);
  return `${type}:${createHash("sha256").update(String(body ?? "")).digest("hex")}`;
}

/**
 * Where a remote file goes on this server: the same path when it is in the output directory (the
 * VM's output directory has this server's path), else <outputDir>/<name> — <name>-2… when another
 * file of this run already took that name.
 */
async function serverCopyPath(remotePath: string, outputDir: string, bytes: Buffer, copies: Map<string, string>): Promise<string> {
  const rel = relative(outputDir, remotePath);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return remotePath;
  const known = copies.get(remotePath);
  if (known) return known;
  const taken = new Set(copies.values());
  const name = basename(remotePath);
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let chosen = join(outputDir, `${stem}-${Date.now()}${ext}`);
  for (let i = 1; i < 1000; i++) {
    const candidate = join(outputDir, i === 1 ? name : `${stem}-${i}${ext}`);
    if (taken.has(candidate)) continue;
    // free, or already holding these bytes
    const existing = await readFile(candidate).catch(() => undefined);
    if (!existing || existing.equals(bytes)) { chosen = candidate; break; }
  }
  copies.set(remotePath, chosen);
  return chosen;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Factory ───

export type OutcomeToolName = "register_outcome";

export const ALL_OUTCOME_TOOL_NAMES: OutcomeToolName[] = ["register_outcome"];

/**
 * Create outcome registration tools.
 *
 * @param cwd - Working directory
 * @param allowedPaths - Sandbox paths
 * @param _allowedTools - Ignored: register_outcome is always included, whatever the agent's
 *   allowedTools (the task prompt and the harness instructions always tell the agent to use it;
 *   without it a run ended "done" with no outcome)
 * @param outputDir - Per-task output directory for deliverables
 * @param fs - Where the agent's files live (default: this machine's disk)
 * @param opts - remote: `fs` is a remote computer's workspace (files are copied to outputDir)
 */
export function createOutcomeTools(cwd: string, allowedPaths?: string[], _allowedTools?: string[], outputDir?: string, fs?: FileSystem, opts: OutcomeToolOptions = {}): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);
  return [createRegisterOutcomeTool(cwd, sandbox, toolFs(fs), outputDir, opts)];
}
