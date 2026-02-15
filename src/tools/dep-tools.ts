/**
 * Dependency management tools for npm/pnpm/yarn.
 *
 * Provides structured package management operations:
 * - Install dependencies
 * - Add/remove packages
 * - Audit for vulnerabilities
 * - List outdated packages
 * - View package info
 *
 * Auto-detects the package manager from lockfiles.
 * Uses safe environment variables (no API keys leaked).
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { bashSafeEnv } from "./safe-env.js";

const MAX_OUTPUT = 30_000;
const DEP_TIMEOUT = 120_000; // 2 min for install operations

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/** Detect package manager from lockfiles */
function detectPM(cwd: string): PackageManager {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

function execPM(cmd: string, cwd: string, timeout?: number): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: timeout ?? DEP_TIMEOUT,
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

// ─── Tool: dep_install ───

const DepInstallSchema = Type.Object({
  frozen: Type.Optional(Type.Boolean({ description: "Use frozen lockfile (CI mode, no updates). Default: false" })),
});

function createDepInstallTool(cwd: string): AgentTool<typeof DepInstallSchema> {
  return {
    name: "dep_install",
    label: "Install Dependencies",
    description: "Install all project dependencies from package.json. " +
      "Auto-detects npm/pnpm/yarn/bun from lockfiles.",
    parameters: DepInstallSchema,
    async execute(_id, params) {
      try {
        const pm = detectPM(cwd);
        let cmd = `${pm} install`;
        if (params.frozen) {
          switch (pm) {
            case "pnpm": cmd += " --frozen-lockfile"; break;
            case "npm": cmd = "npm ci"; break;
            case "yarn": cmd += " --frozen-lockfile"; break;
            case "bun": cmd += " --frozen-lockfile"; break;
          }
        }
        const result = execPM(cmd, cwd);
        return {
          content: [{ type: "text", text: `[${pm}] ${truncate(result)}` }],
          details: { pm, command: cmd },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Install error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: dep_add ───

const DepAddSchema = Type.Object({
  packages: Type.Array(Type.String(), { description: "Package names to add (e.g. ['lodash', 'zod@3.22'])", minItems: 1 }),
  dev: Type.Optional(Type.Boolean({ description: "Install as devDependency (-D)" })),
  exact: Type.Optional(Type.Boolean({ description: "Install exact version (-E)" })),
});

function createDepAddTool(cwd: string): AgentTool<typeof DepAddSchema> {
  return {
    name: "dep_add",
    label: "Add Package",
    description: "Add one or more packages to the project. Supports version specifiers (e.g. 'zod@3.22').",
    parameters: DepAddSchema,
    async execute(_id, params) {
      try {
        const pm = detectPM(cwd);
        const addCmd = pm === "npm" ? "install" : "add";
        const flags: string[] = [];
        if (params.dev) flags.push(pm === "npm" ? "--save-dev" : "-D");
        if (params.exact) flags.push(pm === "npm" ? "--save-exact" : "-E");

        const cmd = `${pm} ${addCmd} ${params.packages.join(" ")} ${flags.join(" ")}`.trim();
        const result = execPM(cmd, cwd);
        return {
          content: [{ type: "text", text: `[${pm}] Added: ${params.packages.join(", ")}\n${truncate(result)}` }],
          details: { pm, packages: params.packages, dev: params.dev ?? false },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Add error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: dep_remove ───

const DepRemoveSchema = Type.Object({
  packages: Type.Array(Type.String(), { description: "Package names to remove", minItems: 1 }),
});

function createDepRemoveTool(cwd: string): AgentTool<typeof DepRemoveSchema> {
  return {
    name: "dep_remove",
    label: "Remove Package",
    description: "Remove one or more packages from the project.",
    parameters: DepRemoveSchema,
    async execute(_id, params) {
      try {
        const pm = detectPM(cwd);
        const removeCmd = pm === "npm" ? "uninstall" : "remove";
        const cmd = `${pm} ${removeCmd} ${params.packages.join(" ")}`;
        const result = execPM(cmd, cwd);
        return {
          content: [{ type: "text", text: `[${pm}] Removed: ${params.packages.join(", ")}\n${truncate(result)}` }],
          details: { pm, packages: params.packages },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Remove error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: dep_outdated ───

const DepOutdatedSchema = Type.Object({});

function createDepOutdatedTool(cwd: string): AgentTool<typeof DepOutdatedSchema> {
  return {
    name: "dep_outdated",
    label: "Check Outdated",
    description: "List packages that have newer versions available.",
    parameters: DepOutdatedSchema,
    async execute() {
      try {
        const pm = detectPM(cwd);
        // npm outdated exits with code 1 when outdated packages exist
        const cmd = `${pm} outdated 2>&1 || true`;
        const result = execSync(cmd, {
          cwd,
          encoding: "utf-8",
          timeout: 30_000,
          env: bashSafeEnv(),
        }).trim();

        return {
          content: [{ type: "text", text: `[${pm}] Outdated packages:\n${truncate(result || "(all up to date)")}` }],
          details: { pm },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Outdated check error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: dep_audit ───

const DepAuditSchema = Type.Object({
  fix: Type.Optional(Type.Boolean({ description: "Attempt to auto-fix vulnerabilities" })),
});

function createDepAuditTool(cwd: string): AgentTool<typeof DepAuditSchema> {
  return {
    name: "dep_audit",
    label: "Security Audit",
    description: "Run a security audit on project dependencies. Optionally auto-fix vulnerabilities.",
    parameters: DepAuditSchema,
    async execute(_id, params) {
      try {
        const pm = detectPM(cwd);
        let cmd: string;
        if (params.fix) {
          cmd = pm === "pnpm" ? "pnpm audit --fix" : pm === "npm" ? "npm audit fix" : `${pm} audit`;
        } else {
          cmd = `${pm} audit 2>&1 || true`;
        }
        const result = execSync(cmd, {
          cwd,
          encoding: "utf-8",
          timeout: 60_000,
          env: bashSafeEnv(),
        }).trim();

        return {
          content: [{ type: "text", text: `[${pm}] Audit:\n${truncate(result)}` }],
          details: { pm, fix: params.fix ?? false },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Audit error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: dep_info ───

const DepInfoSchema = Type.Object({
  package: Type.String({ description: "Package name to get info about" }),
});

function createDepInfoTool(cwd: string): AgentTool<typeof DepInfoSchema> {
  return {
    name: "dep_info",
    label: "Package Info",
    description: "Show detailed information about an npm package: version, description, dependencies, homepage.",
    parameters: DepInfoSchema,
    async execute(_id, params) {
      try {
        const result = execPM(`npm view ${params.package} --json`, cwd, 15_000);
        try {
          const info = JSON.parse(result);
          const text = [
            `${info.name}@${info.version}`,
            info.description ?? "",
            `License: ${info.license ?? "unknown"}`,
            `Homepage: ${info.homepage ?? "n/a"}`,
            `Dependencies: ${Object.keys(info.dependencies ?? {}).length}`,
            `Last publish: ${info.time?.modified ?? "unknown"}`,
          ].join("\n");
          return {
            content: [{ type: "text", text }],
            details: { name: info.name, version: info.version },
          };
        } catch {
          return {
            content: [{ type: "text", text: truncate(result) }],
            details: { package: params.package },
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Package info error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Factory ───

export type DepToolName = "dep_install" | "dep_add" | "dep_remove" | "dep_outdated" | "dep_audit" | "dep_info";

export const ALL_DEP_TOOL_NAMES: DepToolName[] = [
  "dep_install", "dep_add", "dep_remove", "dep_outdated", "dep_audit", "dep_info",
];

/**
 * Create dependency management tools.
 *
 * @param cwd - Working directory (must contain package.json)
 * @param allowedTools - Optional filter
 */
export function createDepTools(cwd: string, allowedTools?: string[]): AgentTool<any>[] {
  const factories: Record<DepToolName, () => AgentTool<any>> = {
    dep_install: () => createDepInstallTool(cwd),
    dep_add: () => createDepAddTool(cwd),
    dep_remove: () => createDepRemoveTool(cwd),
    dep_outdated: () => createDepOutdatedTool(cwd),
    dep_audit: () => createDepAuditTool(cwd),
    dep_info: () => createDepInfoTool(cwd),
  };

  const names = allowedTools
    ? ALL_DEP_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_DEP_TOOL_NAMES;

  return names.map(n => factories[n]());
}
