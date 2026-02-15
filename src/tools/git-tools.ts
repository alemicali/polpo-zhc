/**
 * Git tools for structured version control operations.
 *
 * Provides structured git operations instead of relying on raw bash commands.
 * Each tool returns parsed, structured output making it easier for agents to
 * understand and act on git state.
 *
 * All operations run in the agent's working directory (cwd).
 * Uses safe environment variables (no API keys leaked to git subprocesses).
 */

import { execSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { bashSafeEnv } from "./safe-env.js";

const MAX_OUTPUT = 30_000;
const GIT_TIMEOUT = 30_000;

function execGit(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT,
      env: bashSafeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim() ?? "";
    const stdout = err.stdout?.toString().trim() ?? "";
    throw new Error(stderr || stdout || err.message);
  }
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n[truncated]" : text;
}

// ─── Tool: git_status ───

const GitStatusSchema = Type.Object({});

function createGitStatusTool(cwd: string): AgentTool<typeof GitStatusSchema> {
  return {
    name: "git_status",
    label: "Git Status",
    description: "Show the working tree status: staged, unstaged, and untracked files. Returns branch info and change summary.",
    parameters: GitStatusSchema,
    async execute() {
      try {
        const branch = execGit("branch --show-current", cwd);
        const status = execGit("status --porcelain=v1", cwd);
        const ahead = (() => {
          try { return execGit("rev-list --count @{upstream}..HEAD", cwd); } catch { return "?"; }
        })();
        const behind = (() => {
          try { return execGit("rev-list --count HEAD..@{upstream}", cwd); } catch { return "?"; }
        })();

        const lines = status ? status.split("\n") : [];
        const staged = lines.filter(l => l[0] !== " " && l[0] !== "?").length;
        const modified = lines.filter(l => l[1] === "M").length;
        const untracked = lines.filter(l => l.startsWith("??")).length;

        const text = [
          `Branch: ${branch}`,
          `Ahead: ${ahead} | Behind: ${behind}`,
          `Staged: ${staged} | Modified: ${modified} | Untracked: ${untracked}`,
          ``,
          status || "(clean working tree)",
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          details: { branch, staged, modified, untracked },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Git error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: git_diff ───

const GitDiffSchema = Type.Object({
  staged: Type.Optional(Type.Boolean({ description: "Show staged changes (--cached). Default: show unstaged changes." })),
  file: Type.Optional(Type.String({ description: "Limit diff to a specific file path" })),
  commit: Type.Optional(Type.String({ description: "Compare against a specific commit or branch (e.g. 'main', 'HEAD~3')" })),
  stat_only: Type.Optional(Type.Boolean({ description: "Show only file change statistics, not full diff" })),
});

function createGitDiffTool(cwd: string): AgentTool<typeof GitDiffSchema> {
  return {
    name: "git_diff",
    label: "Git Diff",
    description: "Show changes between working tree, staging area, or commits. " +
      "Use staged=true for staged changes, commit='main' to compare against a branch.",
    parameters: GitDiffSchema,
    async execute(_id, params) {
      try {
        const parts = ["diff"];
        if (params.staged) parts.push("--cached");
        if (params.stat_only) parts.push("--stat");
        if (params.commit) parts.push(params.commit);
        parts.push("--");
        if (params.file) parts.push(params.file);

        const diff = execGit(parts.join(" "), cwd);
        return {
          content: [{ type: "text", text: truncate(diff || "(no changes)") }],
          details: { hasChanges: diff.length > 0 },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Git error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: git_log ───

const GitLogSchema = Type.Object({
  count: Type.Optional(Type.Number({ description: "Number of commits to show (default: 10)" })),
  oneline: Type.Optional(Type.Boolean({ description: "Compact one-line format (default: true)" })),
  file: Type.Optional(Type.String({ description: "Show commits affecting a specific file" })),
  author: Type.Optional(Type.String({ description: "Filter by author name/email" })),
  since: Type.Optional(Type.String({ description: "Show commits since date (e.g. '2024-01-01', '2 weeks ago')" })),
  branch: Type.Optional(Type.String({ description: "Branch or commit range (e.g. 'main..feature', 'HEAD~5')" })),
});

function createGitLogTool(cwd: string): AgentTool<typeof GitLogSchema> {
  return {
    name: "git_log",
    label: "Git Log",
    description: "Show commit history with optional filters. Returns commit hashes, authors, dates, and messages.",
    parameters: GitLogSchema,
    async execute(_id, params) {
      try {
        const n = params.count ?? 10;
        const format = (params.oneline ?? true)
          ? "--oneline --decorate"
          : "--format=format:'%h %an %ad %s' --date=short";
        const parts = ["log", `-${n}`, format];
        if (params.author) parts.push(`--author=${JSON.stringify(params.author)}`);
        if (params.since) parts.push(`--since=${JSON.stringify(params.since)}`);
        if (params.branch) parts.push(params.branch);
        parts.push("--");
        if (params.file) parts.push(params.file);

        const log = execGit(parts.join(" "), cwd);
        return {
          content: [{ type: "text", text: truncate(log || "(no commits)") }],
          details: { count: log ? log.split("\n").length : 0 },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Git error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: git_commit ───

const GitCommitSchema = Type.Object({
  message: Type.String({ description: "Commit message" }),
  files: Type.Optional(Type.Array(Type.String(), { description: "Specific files to stage and commit (default: all tracked changes)" })),
  all: Type.Optional(Type.Boolean({ description: "Stage all modified tracked files before committing (-a)" })),
});

function createGitCommitTool(cwd: string): AgentTool<typeof GitCommitSchema> {
  return {
    name: "git_commit",
    label: "Git Commit",
    description: "Stage changes and create a git commit. " +
      "Use files=[] to commit specific files, or all=true to auto-stage all modified files.",
    parameters: GitCommitSchema,
    async execute(_id, params) {
      try {
        // Stage files
        if (params.files && params.files.length > 0) {
          execGit(`add ${params.files.map(f => JSON.stringify(f)).join(" ")}`, cwd);
        } else if (params.all) {
          execGit("add -A", cwd);
        }

        // Commit
        const commitArgs = params.all && !params.files ? "-a" : "";
        const result = execGit(`commit ${commitArgs} -m ${JSON.stringify(params.message)}`, cwd);

        return {
          content: [{ type: "text", text: result }],
          details: { message: params.message },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Git error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: git_branch ───

const GitBranchSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("create"),
    Type.Literal("switch"),
    Type.Literal("delete"),
  ], { description: "Branch action" }),
  name: Type.Optional(Type.String({ description: "Branch name (for create/switch/delete)" })),
  from: Type.Optional(Type.String({ description: "Base branch or commit for create (default: current HEAD)" })),
});

function createGitBranchTool(cwd: string): AgentTool<typeof GitBranchSchema> {
  return {
    name: "git_branch",
    label: "Git Branch",
    description: "Manage git branches: list, create, switch (checkout), or delete branches.",
    parameters: GitBranchSchema,
    async execute(_id, params) {
      try {
        let result: string;
        switch (params.action) {
          case "list":
            result = execGit("branch -a --format='%(refname:short) %(upstream:short) %(objectname:short)'", cwd);
            break;
          case "create":
            if (!params.name) throw new Error("Branch name is required for create");
            const from = params.from ? ` ${params.from}` : "";
            execGit(`branch ${params.name}${from}`, cwd);
            execGit(`checkout ${params.name}`, cwd);
            result = `Created and switched to branch: ${params.name}`;
            break;
          case "switch":
            if (!params.name) throw new Error("Branch name is required for switch");
            execGit(`checkout ${params.name}`, cwd);
            result = `Switched to branch: ${params.name}`;
            break;
          case "delete":
            if (!params.name) throw new Error("Branch name is required for delete");
            result = execGit(`branch -d ${params.name}`, cwd);
            break;
          default:
            result = "Unknown action";
        }
        return {
          content: [{ type: "text", text: truncate(result) }],
          details: { action: params.action, name: params.name },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Git error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: git_stash ───

const GitStashSchema = Type.Object({
  action: Type.Union([
    Type.Literal("push"),
    Type.Literal("pop"),
    Type.Literal("list"),
    Type.Literal("drop"),
  ], { description: "Stash action" }),
  message: Type.Optional(Type.String({ description: "Stash message (for push)" })),
});

function createGitStashTool(cwd: string): AgentTool<typeof GitStashSchema> {
  return {
    name: "git_stash",
    label: "Git Stash",
    description: "Stash or restore uncommitted changes. Use to temporarily save work without committing.",
    parameters: GitStashSchema,
    async execute(_id, params) {
      try {
        let result: string;
        switch (params.action) {
          case "push":
            const msg = params.message ? ` -m ${JSON.stringify(params.message)}` : "";
            result = execGit(`stash push${msg}`, cwd);
            break;
          case "pop":
            result = execGit("stash pop", cwd);
            break;
          case "list":
            result = execGit("stash list", cwd) || "(no stashes)";
            break;
          case "drop":
            result = execGit("stash drop", cwd);
            break;
          default:
            result = "Unknown action";
        }
        return {
          content: [{ type: "text", text: result }],
          details: { action: params.action },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Git error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: git_show ───

const GitShowSchema = Type.Object({
  commit: Type.Optional(Type.String({ description: "Commit hash to show (default: HEAD)" })),
  file: Type.Optional(Type.String({ description: "Show specific file at the given commit" })),
  stat_only: Type.Optional(Type.Boolean({ description: "Show only file change statistics" })),
});

function createGitShowTool(cwd: string): AgentTool<typeof GitShowSchema> {
  return {
    name: "git_show",
    label: "Git Show",
    description: "Show details of a specific commit: message, author, and changes. " +
      "Use to inspect what a commit changed.",
    parameters: GitShowSchema,
    async execute(_id, params) {
      try {
        const ref = params.commit ?? "HEAD";
        const parts = ["show"];
        if (params.stat_only) parts.push("--stat");
        parts.push(ref);
        if (params.file) {
          parts.push("--", params.file);
        }
        const result = execGit(parts.join(" "), cwd);
        return {
          content: [{ type: "text", text: truncate(result) }],
          details: { commit: ref },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Git error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Factory ───

export type GitToolName = "git_status" | "git_diff" | "git_log" | "git_commit" | "git_branch" | "git_stash" | "git_show";

export const ALL_GIT_TOOL_NAMES: GitToolName[] = [
  "git_status", "git_diff", "git_log", "git_commit", "git_branch", "git_stash", "git_show",
];

/**
 * Create git tools scoped to a working directory.
 *
 * @param cwd - Working directory (must be inside a git repository)
 * @param allowedTools - Optional filter
 */
export function createGitTools(cwd: string, allowedTools?: string[]): AgentTool<any>[] {
  const factories: Record<GitToolName, () => AgentTool<any>> = {
    git_status: () => createGitStatusTool(cwd),
    git_diff: () => createGitDiffTool(cwd),
    git_log: () => createGitLogTool(cwd),
    git_commit: () => createGitCommitTool(cwd),
    git_branch: () => createGitBranchTool(cwd),
    git_stash: () => createGitStashTool(cwd),
    git_show: () => createGitShowTool(cwd),
  };

  const names = allowedTools
    ? ALL_GIT_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_GIT_TOOL_NAMES;

  return names.map(n => factories[n]());
}
