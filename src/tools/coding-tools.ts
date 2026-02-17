/**
 * Standard coding tools for the native pi adapter.
 * Each tool implements pi-agent-core's AgentTool interface with TypeBox schemas.
 *
 * All file-based tools enforce path sandboxing when allowedPaths is provided.
 * The bash tool runs with cwd set to the agent's primary working directory.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { execSync, spawn as spawnChild } from "node:child_process";
import { join, dirname, resolve, relative } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";
import { bashSafeEnv } from "./safe-env.js";

const MAX_READ_LINES = 500;
const MAX_OUTPUT_BYTES = 30_000;

// === Read Tool ===

const ReadSchema = Type.Object({
  path: Type.String({ description: "Absolute or relative path to the file to read" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Max number of lines to read" })),
});

function createReadTool(cwd: string, sandbox: string[]): AgentTool<typeof ReadSchema> {
  return {
    name: "read",
    label: "Read File",
    description: "Read the contents of a file. Returns line-numbered text. For large files, use offset and limit to read specific sections.",
    parameters: ReadSchema,
    async execute(_toolCallId, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "read");
      const raw = readFileSync(filePath, "utf-8");
      const allLines = raw.split("\n");
      const offset = (params.offset ?? 1) - 1;
      const limit = params.limit ?? MAX_READ_LINES;
      const lines = allLines.slice(offset, offset + limit);
      const numbered = lines.map((l, i) => `${offset + i + 1}\t${l}`).join("\n");
      const truncated = allLines.length > offset + limit;
      const suffix = truncated ? `\n... (${allLines.length - offset - limit} more lines)` : "";
      return {
        content: [{ type: "text", text: numbered + suffix }],
        details: { path: filePath, lines: lines.length, total: allLines.length },
      };
    },
  };
}

// === Write Tool ===

const WriteSchema = Type.Object({
  path: Type.String({ description: "Absolute or relative path to write to" }),
  content: Type.String({ description: "File content to write" }),
});

function createWriteTool(cwd: string, sandbox: string[]): AgentTool<typeof WriteSchema> {
  return {
    name: "write",
    label: "Write File",
    description: "Create or overwrite a file with the given content. Parent directories are created automatically.",
    parameters: WriteSchema,
    async execute(_toolCallId, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "write");
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, params.content, "utf-8");
      return {
        content: [{ type: "text", text: `File written: ${filePath} (${params.content.length} bytes)` }],
        details: { path: filePath, bytes: params.content.length },
      };
    },
  };
}

// === Edit Tool ===

const EditSchema = Type.Object({
  path: Type.String({ description: "Absolute or relative path to the file to edit" }),
  old_text: Type.String({ description: "Exact text to find and replace (must be unique in the file)" }),
  new_text: Type.String({ description: "Replacement text" }),
});

function createEditTool(cwd: string, sandbox: string[]): AgentTool<typeof EditSchema> {
  return {
    name: "edit",
    label: "Edit File",
    description: "Replace a unique string in a file. The old_text must appear exactly once.",
    parameters: EditSchema,
    async execute(_toolCallId, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "edit");
      const content = readFileSync(filePath, "utf-8");
      const occurrences = content.split(params.old_text).length - 1;
      if (occurrences === 0) {
        return {
          content: [{ type: "text", text: `Error: old_text not found in ${filePath}` }],
          details: { path: filePath, error: "not_found" },
        };
      }
      if (occurrences > 1) {
        return {
          content: [{ type: "text", text: `Error: old_text found ${occurrences} times in ${filePath}. Must be unique.` }],
          details: { path: filePath, error: "not_unique", count: occurrences },
        };
      }
      const updated = content.replace(params.old_text, params.new_text);
      writeFileSync(filePath, updated, "utf-8");
      return {
        content: [{ type: "text", text: `Edited ${filePath}: replaced ${params.old_text.length} chars with ${params.new_text.length} chars` }],
        details: { path: filePath },
      };
    },
  };
}

// === Bash Tool ===

const BashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 120000)" })),
});

function createBashTool(cwd: string): AgentTool<typeof BashSchema> {
  return {
    name: "bash",
    label: "Execute Shell",
    description: "Execute a shell command and return its output. Use for running tests, installing packages, git operations, etc.",
    parameters: BashSchema,
    async execute(_toolCallId, params, signal) {
      const timeout = params.timeout ?? 120_000;
      return new Promise<AgentToolResult<any>>((res) => {
        const child = spawnChild(params.command, {
          shell: true,
          cwd,
          env: bashSafeEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });

        const chunks: Buffer[] = [];
        let killed = false;

        const timer = setTimeout(() => {
          killed = true;
          child.kill("SIGTERM");
          setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 3000);
        }, timeout);

        const onAbort = () => { killed = true; child.kill("SIGTERM"); };
        signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout.on("data", (d: Buffer) => chunks.push(d));
        child.stderr.on("data", (d: Buffer) => chunks.push(d));

        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          let output = Buffer.concat(chunks).toString("utf-8");
          if (output.length > MAX_OUTPUT_BYTES) {
            output = output.slice(-MAX_OUTPUT_BYTES) + "\n[truncated to last 30KB]";
          }
          const suffix = killed ? "\n[timed out]" : "";
          res({
            content: [{ type: "text", text: `Exit code: ${code ?? 1}\n${output}${suffix}` }],
            details: { command: params.command, exitCode: code ?? 1 },
          });
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          res({
            content: [{ type: "text", text: `Error: ${err.message}` }],
            details: { command: params.command, error: err.message },
          });
        });
      });
    },
  };
}

// === Glob Tool ===

const GlobSchema = Type.Object({
  pattern: Type.String({ description: "Glob pattern (e.g. '**/*.ts', 'src/**/*.js')" }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default: cwd)" })),
});

function createGlobTool(cwd: string, sandbox: string[]): AgentTool<typeof GlobSchema> {
  return {
    name: "glob",
    label: "Find Files",
    description: "Find files matching a glob pattern. Returns matching file paths.",
    parameters: GlobSchema,
    async execute(_toolCallId, params) {
      const searchDir = params.path ? resolve(cwd, params.path) : cwd;
      assertPathAllowed(searchDir, sandbox, "glob");
      try {
        // Use find command as cross-platform glob
        const result = execSync(
          `find ${JSON.stringify(searchDir)} -type f -name ${JSON.stringify(params.pattern)} 2>/dev/null | head -200`,
          { encoding: "utf-8", timeout: 10_000 },
        ).trim();
        // If find with -name doesn't work well for globs, fallback to shell glob
        if (!result) {
          const shResult = execSync(
            `cd ${JSON.stringify(searchDir)} && ls -1 ${JSON.stringify(params.pattern)} 2>/dev/null | head -200`,
            { encoding: "utf-8", timeout: 10_000, shell: "/bin/bash" },
          ).trim();
          const files = shResult ? shResult.split("\n") : [];
          return {
            content: [{ type: "text", text: files.length > 0 ? files.join("\n") : "No files found" }],
            details: { pattern: params.pattern, count: files.length },
          };
        }
        const files = result.split("\n").map(f => relative(cwd, f));
        return {
          content: [{ type: "text", text: files.join("\n") }],
          details: { pattern: params.pattern, count: files.length },
        };
      } catch {
        return {
          content: [{ type: "text", text: "No files found" }],
          details: { pattern: params.pattern, count: 0 },
        };
      }
    },
  };
}

// === Grep Tool ===

const GrepSchema = Type.Object({
  pattern: Type.String({ description: "Regex pattern to search for" }),
  path: Type.Optional(Type.String({ description: "File or directory to search in (default: cwd)" })),
  include: Type.Optional(Type.String({ description: "File glob filter (e.g. '*.ts')" })),
});

function createGrepTool(cwd: string, sandbox: string[]): AgentTool<typeof GrepSchema> {
  return {
    name: "grep",
    label: "Search Code",
    description: "Search for a regex pattern in files. Returns matching lines with file paths and line numbers.",
    parameters: GrepSchema,
    async execute(_toolCallId, params) {
      const searchPath = params.path ? resolve(cwd, params.path) : cwd;
      assertPathAllowed(searchPath, sandbox, "grep");
      const includeFlag = params.include ? `--include=${JSON.stringify(params.include)}` : "";
      try {
        const result = execSync(
          `grep -rn ${includeFlag} -E ${JSON.stringify(params.pattern)} ${JSON.stringify(searchPath)} 2>/dev/null | head -100`,
          { encoding: "utf-8", timeout: 15_000 },
        ).trim();
        if (!result) {
          return {
            content: [{ type: "text", text: "No matches found" }],
            details: { pattern: params.pattern, count: 0 },
          };
        }
        const lines = result.split("\n");
        return {
          content: [{ type: "text", text: result }],
          details: { pattern: params.pattern, count: lines.length },
        };
      } catch {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: { pattern: params.pattern, count: 0 },
        };
      }
    },
  };
}

// === Ls Tool ===

const LsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: cwd)" })),
});

function createLsTool(cwd: string, sandbox: string[]): AgentTool<typeof LsSchema> {
  return {
    name: "ls",
    label: "List Directory",
    description: "List files and directories in a given path.",
    parameters: LsSchema,
    async execute(_toolCallId, params) {
      const dir = params.path ? resolve(cwd, params.path) : cwd;
      assertPathAllowed(dir, sandbox, "ls");
      const entries = readdirSync(dir).map(name => {
        try {
          const stat = statSync(join(dir, name));
          return stat.isDirectory() ? `${name}/` : name;
        } catch {
          return name;
        }
      });
      return {
        content: [{ type: "text", text: entries.join("\n") }],
        details: { path: dir, count: entries.length },
      };
    },
  };
}

// === Factory ===

/** Tool name to filter by in allowedTools config */
type CodingToolName = "read" | "write" | "edit" | "bash" | "glob" | "grep" | "ls";

const ALL_TOOL_NAMES: CodingToolName[] = ["read", "write", "edit", "bash", "glob", "grep", "ls"];

/**
 * Create the standard set of coding tools scoped to a working directory.
 * If allowedTools is provided, only those tools are included.
 * If allowedPaths is provided, file-based tools enforce path sandboxing.
 */
export function createCodingTools(cwd: string, allowedTools?: string[], allowedPaths?: string[]): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<CodingToolName, () => AgentTool<any>> = {
    read: () => createReadTool(cwd, sandbox),
    write: () => createWriteTool(cwd, sandbox),
    edit: () => createEditTool(cwd, sandbox),
    bash: () => createBashTool(cwd),
    glob: () => createGlobTool(cwd, sandbox),
    grep: () => createGrepTool(cwd, sandbox),
    ls: () => createLsTool(cwd, sandbox),
  };

  const names = allowedTools
    ? ALL_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_TOOL_NAMES;

  return names.map(n => factories[n]());
}

// === Extended Tools Factory ===

import { createBrowserTools, ALL_BROWSER_TOOL_NAMES } from "./browser-tools.js";
import { createHttpTools, ALL_HTTP_TOOL_NAMES } from "./http-tools.js";
import { createGitTools, ALL_GIT_TOOL_NAMES } from "./git-tools.js";
import { createMultifileTools, ALL_MULTIFILE_TOOL_NAMES } from "./multifile-tools.js";
import { createDepTools, ALL_DEP_TOOL_NAMES } from "./dep-tools.js";
import { createExcelTools, ALL_EXCEL_TOOL_NAMES } from "./excel-tools.js";
import { createPdfTools, ALL_PDF_TOOL_NAMES } from "./pdf-tools.js";
import { createDocxTools, ALL_DOCX_TOOL_NAMES } from "./docx-tools.js";
import { createEmailTools, ALL_EMAIL_TOOL_NAMES } from "./email-tools.js";
import { createAudioTools, ALL_AUDIO_TOOL_NAMES } from "./audio-tools.js";
import { createImageTools, ALL_IMAGE_TOOL_NAMES } from "./image-tools.js";
import { createOutcomeTools, ALL_OUTCOME_TOOL_NAMES } from "./outcome-tools.js";

export type { BrowserToolName } from "./browser-tools.js";
export type { HttpToolName } from "./http-tools.js";
export type { GitToolName } from "./git-tools.js";
export type { MultifileToolName } from "./multifile-tools.js";
export type { DepToolName } from "./dep-tools.js";
export type { ExcelToolName } from "./excel-tools.js";
export type { PdfToolName } from "./pdf-tools.js";
export type { DocxToolName } from "./docx-tools.js";
export type { EmailToolName } from "./email-tools.js";
export type { AudioToolName } from "./audio-tools.js";
export type { ImageToolName } from "./image-tools.js";
export type { OutcomeToolName } from "./outcome-tools.js";

/** All known tool names across all categories */
export type ExtendedToolName = CodingToolName
  | import("./browser-tools.js").BrowserToolName
  | import("./http-tools.js").HttpToolName
  | import("./git-tools.js").GitToolName
  | import("./multifile-tools.js").MultifileToolName
  | import("./dep-tools.js").DepToolName
  | import("./excel-tools.js").ExcelToolName
  | import("./pdf-tools.js").PdfToolName
  | import("./docx-tools.js").DocxToolName
  | import("./email-tools.js").EmailToolName
  | import("./audio-tools.js").AudioToolName
  | import("./image-tools.js").ImageToolName
  | import("./outcome-tools.js").OutcomeToolName;

/** All available tool names for documentation/config validation */
export const ALL_EXTENDED_TOOL_NAMES: string[] = [
  ...ALL_TOOL_NAMES,
  ...ALL_BROWSER_TOOL_NAMES,
  ...ALL_HTTP_TOOL_NAMES,
  ...ALL_GIT_TOOL_NAMES,
  ...ALL_MULTIFILE_TOOL_NAMES,
  ...ALL_DEP_TOOL_NAMES,
  ...ALL_EXCEL_TOOL_NAMES,
  ...ALL_PDF_TOOL_NAMES,
  ...ALL_DOCX_TOOL_NAMES,
  ...ALL_EMAIL_TOOL_NAMES,
  ...ALL_AUDIO_TOOL_NAMES,
  ...ALL_IMAGE_TOOL_NAMES,
  ...ALL_OUTCOME_TOOL_NAMES,
];

export interface CreateAllToolsOptions {
  /** Working directory for the agent */
  cwd: string;
  /** Tool name filter — only include tools with these names. If omitted, includes core coding tools + explicitly enabled categories. */
  allowedTools?: string[];
  /** Filesystem sandbox paths */
  allowedPaths?: string[];
  /** Browser session name for isolation (default: "default") */
  browserSession?: string;
  /** Enable browser tools (requires agent-browser installed). Default: false — must be explicitly enabled. */
  enableBrowser?: boolean;
  /** Enable HTTP/fetch tools. Default: false — must be explicitly enabled. */
  enableHttp?: boolean;
  /** Enable git tools. Default: false — must be explicitly enabled. */
  enableGit?: boolean;
  /** Enable multi-file editing tools. Default: false — must be explicitly enabled. */
  enableMultifile?: boolean;
  /** Enable dependency management tools. Default: false — must be explicitly enabled. */
  enableDeps?: boolean;
  /** Enable Excel/CSV tools (requires exceljs). Default: false. */
  enableExcel?: boolean;
  /** Enable PDF tools (requires pdf-lib). Default: false. */
  enablePdf?: boolean;
  /** Enable Word/DOCX tools (requires docx, mammoth). Default: false. */
  enableDocx?: boolean;
  /** Enable email tools (requires nodemailer + SMTP config). Default: false. */
  enableEmail?: boolean;
  /** Enable audio tools for STT/TTS (requires OPENAI_API_KEY / DEEPGRAM_API_KEY / ELEVENLABS_API_KEY). Default: false. */
  enableAudio?: boolean;
  /** Enable image tools for generation/vision (requires OPENAI_API_KEY / REPLICATE_API_TOKEN / ANTHROPIC_API_KEY). Default: false. */
  enableImage?: boolean;
}

/**
 * Create all available tools for an agent, including extended tool categories.
 *
 * By default, only core coding tools (read, write, edit, bash, glob, grep, ls) are included.
 * Extended categories must be explicitly enabled via options or by including their names in allowedTools.
 *
 * When allowedTools is provided, it acts as a filter across ALL categories — any tool whose name
 * appears in allowedTools will be included (and its category auto-enabled).
 */
export function createAllTools(options: CreateAllToolsOptions): AgentTool<any>[] {
  const { cwd, allowedTools, allowedPaths, browserSession } = options;
  const tools: AgentTool<any>[] = [];

  // Helper: check if any tool from a category is in the allowedTools list
  const categoryRequested = (names: readonly string[]) =>
    allowedTools?.some(a => names.some(n => n === a.toLowerCase()));

  // Core coding tools (always included unless filtered out)
  tools.push(...createCodingTools(cwd, allowedTools, allowedPaths));

  // Browser tools
  if (options.enableBrowser || categoryRequested(ALL_BROWSER_TOOL_NAMES)) {
    tools.push(...createBrowserTools(cwd, browserSession, allowedTools));
  }

  // HTTP tools
  if (options.enableHttp || categoryRequested(ALL_HTTP_TOOL_NAMES)) {
    tools.push(...createHttpTools(cwd, allowedPaths, allowedTools));
  }

  // Git tools
  if (options.enableGit || categoryRequested(ALL_GIT_TOOL_NAMES)) {
    tools.push(...createGitTools(cwd, allowedTools));
  }

  // Multi-file tools
  if (options.enableMultifile || categoryRequested(ALL_MULTIFILE_TOOL_NAMES)) {
    tools.push(...createMultifileTools(cwd, allowedPaths, allowedTools));
  }

  // Dependency tools
  if (options.enableDeps || categoryRequested(ALL_DEP_TOOL_NAMES)) {
    tools.push(...createDepTools(cwd, allowedTools));
  }

  // Excel/CSV tools
  if (options.enableExcel || categoryRequested(ALL_EXCEL_TOOL_NAMES)) {
    tools.push(...createExcelTools(cwd, allowedPaths, allowedTools));
  }

  // PDF tools
  if (options.enablePdf || categoryRequested(ALL_PDF_TOOL_NAMES)) {
    tools.push(...createPdfTools(cwd, allowedPaths, allowedTools));
  }

  // Word/DOCX tools
  if (options.enableDocx || categoryRequested(ALL_DOCX_TOOL_NAMES)) {
    tools.push(...createDocxTools(cwd, allowedPaths, allowedTools));
  }

  // Email tools
  if (options.enableEmail || categoryRequested(ALL_EMAIL_TOOL_NAMES)) {
    tools.push(...createEmailTools(cwd, allowedPaths, allowedTools));
  }

  // Audio tools (STT/TTS)
  if (options.enableAudio || categoryRequested(ALL_AUDIO_TOOL_NAMES)) {
    tools.push(...createAudioTools(cwd, allowedPaths, allowedTools));
  }

  // Image tools (generation/vision)
  if (options.enableImage || categoryRequested(ALL_IMAGE_TOOL_NAMES)) {
    tools.push(...createImageTools(cwd, allowedPaths, allowedTools));
  }

  // Outcome registration tool — always included with extended tools so agents
  // can explicitly declare artifacts regardless of how they were produced
  tools.push(...createOutcomeTools(cwd, allowedPaths, allowedTools));

  return tools;
}
