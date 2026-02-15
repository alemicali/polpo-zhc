/**
 * Multi-file editing tools for batch operations.
 *
 * Provides tools for operations that span multiple files:
 * - Regex find-and-replace across a directory
 * - Bulk file rename with pattern matching
 * - Multi-file patch (edit multiple files in a single tool call)
 *
 * All operations enforce path sandboxing.
 */

import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join, dirname, basename, relative } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";

const MAX_FILES = 50;
const MAX_REPLACEMENTS = 500;

// ─── Tool: multi_edit ───

const MultiEditSchema = Type.Object({
  edits: Type.Array(
    Type.Object({
      path: Type.String({ description: "File path (absolute or relative to cwd)" }),
      old_text: Type.String({ description: "Exact text to find (must be unique in the file)" }),
      new_text: Type.String({ description: "Replacement text" }),
    }),
    { description: "Array of file edits to apply atomically", minItems: 1, maxItems: 20 },
  ),
});

function createMultiEditTool(cwd: string, sandbox: string[]): AgentTool<typeof MultiEditSchema> {
  return {
    name: "multi_edit",
    label: "Multi-File Edit",
    description: "Apply multiple find-and-replace edits across different files in a single operation. " +
      "Each edit must have a unique old_text in its file. All edits are validated before any are applied.",
    parameters: MultiEditSchema,
    async execute(_id, params) {
      // Phase 1: Validate all edits
      const resolved: Array<{ path: string; content: string; old_text: string; new_text: string }> = [];
      const errors: string[] = [];

      for (const edit of params.edits) {
        const filePath = resolve(cwd, edit.path);
        try {
          assertPathAllowed(filePath, sandbox, "multi_edit");
        } catch (e: any) {
          errors.push(`${edit.path}: ${e.message}`);
          continue;
        }

        try {
          const content = readFileSync(filePath, "utf-8");
          const occurrences = content.split(edit.old_text).length - 1;
          if (occurrences === 0) {
            errors.push(`${edit.path}: old_text not found`);
          } else if (occurrences > 1) {
            errors.push(`${edit.path}: old_text found ${occurrences} times (must be unique)`);
          } else {
            resolved.push({ path: filePath, content, old_text: edit.old_text, new_text: edit.new_text });
          }
        } catch (e: any) {
          errors.push(`${edit.path}: ${e.message}`);
        }
      }

      if (errors.length > 0) {
        return {
          content: [{ type: "text", text: `Validation failed:\n${errors.join("\n")}\n\nNo files were modified.` }],
          details: { errors, applied: 0 },
        };
      }

      // Phase 2: Apply all edits
      const results: string[] = [];
      for (const edit of resolved) {
        const updated = edit.content.replace(edit.old_text, edit.new_text);
        writeFileSync(edit.path, updated, "utf-8");
        results.push(`${relative(cwd, edit.path)}: replaced ${edit.old_text.length} chars with ${edit.new_text.length} chars`);
      }

      return {
        content: [{ type: "text", text: `Applied ${results.length} edits:\n${results.join("\n")}` }],
        details: { applied: results.length, files: resolved.map(e => e.path) },
      };
    },
  };
}

// ─── Tool: regex_replace ───

const RegexReplaceSchema = Type.Object({
  pattern: Type.String({ description: "Regex pattern to search for (JavaScript regex syntax)" }),
  replacement: Type.String({ description: "Replacement string (supports $1, $2 for capture groups)" }),
  path: Type.Optional(Type.String({ description: "File or directory to search in (default: cwd)" })),
  include: Type.Optional(Type.String({ description: "File glob filter (e.g. '*.ts', '*.{ts,tsx}')" })),
  dry_run: Type.Optional(Type.Boolean({ description: "Preview changes without applying them" })),
});

function createRegexReplaceTool(cwd: string, sandbox: string[]): AgentTool<typeof RegexReplaceSchema> {
  return {
    name: "regex_replace",
    label: "Regex Replace",
    description: "Find and replace text using regex across multiple files. " +
      "Supports capture groups ($1, $2). Use dry_run=true to preview changes first.",
    parameters: RegexReplaceSchema,
    async execute(_id, params) {
      const searchPath = params.path ? resolve(cwd, params.path) : cwd;
      assertPathAllowed(searchPath, sandbox, "regex_replace");

      let regex: RegExp;
      try {
        regex = new RegExp(params.pattern, "g");
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Invalid regex: ${e.message}` }],
          details: { error: "invalid_regex" },
        };
      }

      // Find matching files
      const includeFlag = params.include ? `--include=${JSON.stringify(params.include)}` : "";
      let filePaths: string[];
      try {
        const grepResult = execSync(
          `grep -rl ${includeFlag} -E ${JSON.stringify(params.pattern)} ${JSON.stringify(searchPath)} 2>/dev/null | head -${MAX_FILES}`,
          { encoding: "utf-8", timeout: 15_000 },
        ).trim();
        filePaths = grepResult ? grepResult.split("\n") : [];
      } catch {
        filePaths = [];
      }

      if (filePaths.length === 0) {
        return {
          content: [{ type: "text", text: "No files contain matches for the pattern" }],
          details: { matchedFiles: 0 },
        };
      }

      const results: string[] = [];
      let totalReplacements = 0;

      for (const file of filePaths) {
        try {
          assertPathAllowed(file, sandbox, "regex_replace");
        } catch {
          continue;
        }

        const content = readFileSync(file, "utf-8");
        const matches = content.match(regex);
        if (!matches) continue;

        const count = matches.length;
        totalReplacements += count;

        if (totalReplacements > MAX_REPLACEMENTS) {
          results.push(`[stopped — exceeded ${MAX_REPLACEMENTS} total replacements]`);
          break;
        }

        if (params.dry_run) {
          results.push(`${relative(cwd, file)}: ${count} match(es) would be replaced`);
          // Show first few matches as preview
          const preview = matches.slice(0, 3).map(m => `  "${m}" -> "${m.replace(regex, params.replacement)}"`);
          results.push(...preview);
        } else {
          const updated = content.replace(regex, params.replacement);
          writeFileSync(file, updated, "utf-8");
          results.push(`${relative(cwd, file)}: ${count} replacement(s)`);
        }

        // Reset regex lastIndex for next file
        regex.lastIndex = 0;
      }

      const prefix = params.dry_run ? "[DRY RUN] " : "";
      return {
        content: [{ type: "text", text: `${prefix}${totalReplacements} replacements across ${filePaths.length} files:\n${results.join("\n")}` }],
        details: { totalReplacements, matchedFiles: filePaths.length, dryRun: params.dry_run ?? false },
      };
    },
  };
}

// ─── Tool: bulk_rename ───

const BulkRenameSchema = Type.Object({
  directory: Type.Optional(Type.String({ description: "Directory to search in (default: cwd)" })),
  pattern: Type.String({ description: "Regex pattern to match in filenames" }),
  replacement: Type.String({ description: "Replacement string for matched filenames" }),
  include: Type.Optional(Type.String({ description: "File extension filter (e.g. '.ts')" })),
  dry_run: Type.Optional(Type.Boolean({ description: "Preview renames without applying them" })),
  recursive: Type.Optional(Type.Boolean({ description: "Search subdirectories (default: false)" })),
});

function createBulkRenameTool(cwd: string, sandbox: string[]): AgentTool<typeof BulkRenameSchema> {
  return {
    name: "bulk_rename",
    label: "Bulk Rename Files",
    description: "Rename multiple files using regex pattern matching. " +
      "Use dry_run=true to preview renames before applying.",
    parameters: BulkRenameSchema,
    async execute(_id, params) {
      const dir = params.directory ? resolve(cwd, params.directory) : cwd;
      assertPathAllowed(dir, sandbox, "bulk_rename");

      let regex: RegExp;
      try {
        regex = new RegExp(params.pattern);
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Invalid regex: ${e.message}` }],
          details: { error: "invalid_regex" },
        };
      }

      // Collect files
      const files: string[] = [];
      function collect(d: string) {
        for (const entry of readdirSync(d)) {
          const full = join(d, entry);
          try {
            const stat = statSync(full);
            if (stat.isDirectory() && params.recursive) {
              collect(full);
            } else if (stat.isFile()) {
              if (params.include && !entry.endsWith(params.include)) continue;
              if (regex.test(entry)) files.push(full);
            }
          } catch { /* skip inaccessible */ }
        }
      }
      collect(dir);

      if (files.length === 0) {
        return {
          content: [{ type: "text", text: "No files match the pattern" }],
          details: { matched: 0 },
        };
      }

      if (files.length > MAX_FILES) {
        return {
          content: [{ type: "text", text: `Too many matches (${files.length}). Max ${MAX_FILES} files per operation.` }],
          details: { matched: files.length, error: "too_many" },
        };
      }

      const results: string[] = [];
      for (const file of files) {
        const name = basename(file);
        const newName = name.replace(regex, params.replacement);
        if (newName === name) continue;

        const newPath = join(dirname(file), newName);
        assertPathAllowed(newPath, sandbox, "bulk_rename");

        if (params.dry_run) {
          results.push(`${relative(cwd, file)} -> ${relative(cwd, newPath)}`);
        } else {
          renameSync(file, newPath);
          results.push(`${relative(cwd, file)} -> ${relative(cwd, newPath)}`);
        }
      }

      const prefix = params.dry_run ? "[DRY RUN] " : "";
      return {
        content: [{ type: "text", text: `${prefix}${results.length} file(s) renamed:\n${results.join("\n")}` }],
        details: { renamed: results.length, dryRun: params.dry_run ?? false },
      };
    },
  };
}

// ─── Factory ───

export type MultifileToolName = "multi_edit" | "regex_replace" | "bulk_rename";

export const ALL_MULTIFILE_TOOL_NAMES: MultifileToolName[] = ["multi_edit", "regex_replace", "bulk_rename"];

/**
 * Create multi-file editing tools.
 *
 * @param cwd - Working directory
 * @param allowedPaths - Sandbox paths for filesystem access
 * @param allowedTools - Optional filter
 */
export function createMultifileTools(
  cwd: string,
  allowedPaths?: string[],
  allowedTools?: string[],
): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<MultifileToolName, () => AgentTool<any>> = {
    multi_edit: () => createMultiEditTool(cwd, sandbox),
    regex_replace: () => createRegexReplaceTool(cwd, sandbox),
    bulk_rename: () => createBulkRenameTool(cwd, sandbox),
  };

  const names = allowedTools
    ? ALL_MULTIFILE_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_MULTIFILE_TOOL_NAMES;

  return names.map(n => factories[n]());
}
