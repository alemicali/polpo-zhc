/**
 * Outcome registration tool.
 *
 * The ONLY mechanism for agents to declare task outcomes. Producing a file
 * (via write, pdf_create, bash, etc.) does NOT auto-register it as an
 * outcome — the agent must explicitly call register_outcome for every
 * deliverable artifact.
 *
 * Supports files, media, text, URLs, and structured JSON data.
 * The tool validates that file outcomes actually exist on disk before
 * registering them.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";

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
  path: Type.Optional(Type.String({ description: "File path (required for type 'file' or 'media'). Relative paths resolved from cwd." })),
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

function createRegisterOutcomeTool(cwd: string, sandbox: string[], outputDir?: string): AgentTool<typeof RegisterOutcomeSchema> {
  // Use outputDir in examples when available so the agent naturally writes there
  const exampleDir = outputDir ? outputDir.replace(/\/$/, "") : "output";
  return {
    name: "register_outcome",
    label: "Register Outcome",
    description:
      "Register a file, text, URL, or data as a task outcome. This is the ONLY way to declare " +
      "deliverables — producing files does NOT auto-register them. You MUST call this tool for " +
      "every artifact that should appear in notifications and the task record.\n\n" +
      (outputDir ? `Your task output directory is: ${outputDir}\nWrite deliverable files there before registering them.\n\n` : "") +
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

      if (params.path) {
        filePath = resolve(cwd, params.path);
        assertPathAllowed(filePath, sandbox, "register_outcome");

        if (!existsSync(filePath)) {
          return {
            content: [{ type: "text", text: `Error: file not found: ${filePath}` }],
            details: { error: "file_not_found", path: filePath },
          };
        }

        try {
          const stats = statSync(filePath);
          fileSize = stats.size;
        } catch {
          // stat failed — file may have been deleted between exists check and stat
        }

        mimeType = guessMime(filePath);
      }

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
      if (params.text) details.outcomeText = params.text;
      if (params.url) details.outcomeUrl = params.url;
      if (params.data !== undefined) details.outcomeData = params.data;
      if (params.tags) details.outcomeTags = params.tags;

      // Build human-readable confirmation
      const parts = [`Outcome registered: "${label}" (${type})`];
      if (filePath) parts.push(`  Path: ${filePath}`);
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
 * @param allowedTools - Optional filter
 * @param outputDir - Per-task output directory for deliverables
 */
export function createOutcomeTools(cwd: string, allowedPaths?: string[], allowedTools?: string[], outputDir?: string): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<OutcomeToolName, () => AgentTool<any>> = {
    register_outcome: () => createRegisterOutcomeTool(cwd, sandbox, outputDir),
  };

  const names = allowedTools
    ? ALL_OUTCOME_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_OUTCOME_TOOL_NAMES;

  return names.map(n => factories[n]());
}
