/**
 * Ink Hub tools — allow agents to search, browse, and install packages
 * from the Ink registry during execution.
 *
 * Tools:
 *   - ink_search:    Search available packages on the Ink Hub
 *   - ink_browse:    Browse installed packages in the local project
 *   - ink_add:       Install packages from a registry source (owner/repo)
 *
 * These are core tools — always available to agents, no activation needed.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  parseInkSource,
  discoverInkPackages,
  readInkLock,
  writeInkLock,
  upsertInkLockEntry,
  isInkSourceInstalled,
  type InkPackage,
  type InkLockEntry,
} from "../core/ink.js";
import { loadPolpoConfig, savePolpoConfig } from "../core/config.js";
import type { PolpoFileConfig, AgentConfig, Team } from "../core/types.js";

const INK_API_URL = "https://polpo.sh/api";

// ─── Helpers ───

function ok(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: { error: true } };
}

/** Fire-and-forget telemetry POST */
function reportInstall(source: string, packages: InkPackage[]): void {
  try {
    const body = {
      source,
      packages: packages.map((p) => ({
        name: p.name,
        type: p.type,
        description: p.metadata?.description,
        tags: p.metadata?.tags,
        version: p.metadata?.version,
      })),
      timestamp: new Date().toISOString(),
    };
    fetch(`${INK_API_URL}/installs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch {
    // Silent
  }
}

// ─── ink_search ───

const InkSearchSchema = Type.Object({
  query: Type.Optional(Type.String({ description: "Search query to filter packages by name, description, or tags" })),
  type: Type.Optional(Type.String({ description: "Filter by package type: playbook, agent, or company" })),
});

function createInkSearchTool(): AgentTool<typeof InkSearchSchema> {
  return {
    name: "ink_search",
    label: "Search Ink Hub",
    description: "Search for available packages on the Ink Hub registry. Returns packages with install counts, descriptions, and tags. Use this to find playbooks, agents, or company configs that can be installed with ink_add.",
    parameters: InkSearchSchema,
    async execute(_toolCallId, params) {
      try {
        const res = await fetch(`${INK_API_URL}/packages`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return err(`Ink Hub API returned HTTP ${res.status}`);

        const data = await res.json() as { packages: Array<{
          source: string; name: string; type: string; description: string;
          tags: string[]; version: string; author: string; installs: number;
          installs24h: number;
        }> };

        let packages = data.packages;

        // Filter by type
        if (params.type) {
          packages = packages.filter((p) => p.type === params.type);
        }

        // Filter by query
        if (params.query) {
          const q = params.query.toLowerCase();
          packages = packages.filter((p) =>
            p.name.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.tags.some((t) => t.toLowerCase().includes(q)),
          );
        }

        if (packages.length === 0) {
          return ok("No packages found matching your search.");
        }

        const lines = packages.map((p) =>
          `- **${p.name}** (${p.type}) — ${p.description}\n  Source: ${p.source} | Installs: ${p.installs} | Tags: ${p.tags.join(", ") || "none"}`,
        );

        return ok(
          `Found ${packages.length} package(s) on Ink Hub:\n\n${lines.join("\n\n")}`,
          { count: packages.length },
        );
      } catch (e: any) {
        return err(`Failed to search Ink Hub: ${e.message}`);
      }
    },
  };
}

// ─── ink_browse ───

const InkBrowseSchema = Type.Object({
  type: Type.Optional(Type.String({ description: "Filter by package type: playbook, agent, or company" })),
});

function createInkBrowseTool(polpoDir: string): AgentTool<typeof InkBrowseSchema> {
  return {
    name: "ink_browse",
    label: "Browse Installed Packages",
    description: "List packages currently installed in this project from the Ink registry. Shows source, type, name, and content hash for each installed package.",
    parameters: InkBrowseSchema,
    async execute(_toolCallId, params) {
      try {
        const lock = readInkLock(polpoDir);

        if (lock.registries.length === 0) {
          return ok("No Ink packages installed in this project. Use ink_search to find packages and ink_add to install them.");
        }

        const lines: string[] = [];
        let total = 0;

        for (const entry of lock.registries) {
          let pkgs = entry.packages;
          if (params.type) {
            pkgs = pkgs.filter((p: { type: string }) => p.type === params.type);
          }
          if (pkgs.length === 0) continue;

          lines.push(`**${entry.source}** (installed ${entry.installedAt.slice(0, 10)}):`);
          for (const p of pkgs) {
            lines.push(`  - ${p.name} (${p.type})`);
            total++;
          }
        }

        if (total === 0) {
          return ok(`No ${params.type ?? ""} packages found in installed sources.`);
        }

        return ok(
          `${total} installed package(s):\n\n${lines.join("\n")}`,
          { total },
        );
      } catch (e: any) {
        return err(`Failed to read ink.lock: ${e.message}`);
      }
    },
  };
}

// ─── ink_add ───

const InkAddSchema = Type.Object({
  source: Type.String({ description: "Package source — GitHub owner/repo (e.g. 'lumea-labs/ink-registry') or a full GitHub URL" }),
});

function createInkAddTool(polpoDir: string): AgentTool<typeof InkAddSchema> {
  return {
    name: "ink_add",
    label: "Install Ink Package",
    description: "Install packages from an Ink registry source (GitHub repo). Clones the repo, discovers packages by convention (playbooks, agents, companies), validates them, and installs into the project. Telemetry is reported automatically.",
    parameters: InkAddSchema,
    async execute(_toolCallId, params) {
      try {
        const parsed = parseInkSource(params.source);
        const sourceLabel = parsed.ownerRepo ?? params.source;

        // Check if already installed
        const lock = readInkLock(polpoDir);
        if (isInkSourceInstalled(lock, sourceLabel)) {
          return ok(`Source "${sourceLabel}" is already installed. Use polpo ink update to refresh it.`);
        }

        // Clone to temp dir (use same cache dir as CLI)
        const cacheDir = join(polpoDir, "ink-cache");
        mkdirSync(cacheDir, { recursive: true });
        const repoDir = join(cacheDir, sourceLabel.replace(/\//g, "--"));
        if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
        execSync(`git clone --depth 1 "${parsed.url}" "${repoDir}"`, { stdio: "pipe", timeout: 30000 });

        // Get commit hash
        const commitHash = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();

        // Discover packages
        const { packages, errors } = discoverInkPackages(repoDir);

        if (errors.length > 0) {
          return err(`Validation errors:\n${errors.join("\n")}`);
        }

        if (packages.length === 0) {
          return ok(`No packages found in "${sourceLabel}". The repo should contain playbooks/<name>/playbook.json, agents/<name>.json, or companies/<name>/polpo.json.`);
        }

        // Install: merge packages into existing config
        const installed: string[] = [];

        // Load existing config (or create minimal one)
        let config: PolpoFileConfig = loadPolpoConfig(polpoDir) ?? {
          org: "",
          teams: [{ name: "default", agents: [] }],
          settings: { maxRetries: 3, workDir: ".", logLevel: "normal" },
        } as any;
        let configChanged = false;

        for (const pkg of packages) {
          switch (pkg.type) {
            case "playbook": {
              // Copy playbook directory
              const destDir = join(polpoDir, "playbooks", pkg.name);
              mkdirSync(destDir, { recursive: true });
              const srcDir = resolve(pkg.path, "..");
              const entries = readdirSync(srcDir);
              for (const entry of entries) {
                cpSync(join(srcDir, entry), join(destDir, entry), { recursive: true });
              }
              installed.push(`playbook: ${pkg.name}`);
              break;
            }
            case "agent": {
              // Merge agent into polpo.json (first team, no collision prompt — agents auto-merge)
              const agentContent = pkg.content as AgentConfig;
              const cleanAgent = { ...agentContent };
              delete (cleanAgent as any).version;
              delete (cleanAgent as any).author;
              delete (cleanAgent as any).tags;

              const targetTeam = config.teams[0] ?? { name: "default", agents: [] };
              if (!config.teams.includes(targetTeam)) config.teams.push(targetTeam);

              const existingIdx = targetTeam.agents.findIndex((a) => a.name === cleanAgent.name);
              if (existingIdx >= 0) {
                // Merge: fill in missing fields
                const existing = targetTeam.agents[existingIdx];
                if (!existing.role && cleanAgent.role) existing.role = cleanAgent.role;
                if (!existing.model && cleanAgent.model) existing.model = cleanAgent.model;
                if (!existing.identity && cleanAgent.identity) existing.identity = cleanAgent.identity;
                if (!existing.allowedTools && cleanAgent.allowedTools) existing.allowedTools = cleanAgent.allowedTools;
                if (!existing.systemPrompt && cleanAgent.systemPrompt) existing.systemPrompt = cleanAgent.systemPrompt;
                installed.push(`agent: ${pkg.name} (merged)`);
              } else {
                targetTeam.agents.push(cleanAgent);
                installed.push(`agent: ${pkg.name}`);
              }
              configChanged = true;
              break;
            }
            case "company": {
              // Merge company teams/agents into config
              const companyContent = pkg.content as PolpoFileConfig;
              const srcDir = resolve(pkg.path, "..");

              const companyTeams: Team[] = Array.isArray(companyContent.teams)
                ? companyContent.teams
                : (companyContent as any).team
                  ? [(companyContent as any).team]
                  : [];

              for (const incomingTeam of companyTeams) {
                const existingTeam = config.teams.find((t) => t.name === incomingTeam.name);
                if (existingTeam) {
                  for (const agent of incomingTeam.agents) {
                    const cleanAgent = { ...agent };
                    delete (cleanAgent as any).version;
                    delete (cleanAgent as any).author;
                    delete (cleanAgent as any).tags;
                    if (!existingTeam.agents.find((a) => a.name === agent.name)) {
                      existingTeam.agents.push(cleanAgent);
                    }
                  }
                } else {
                  config.teams.push(incomingTeam);
                }
              }

              // Merge settings (fill missing only)
              if (companyContent.settings && config.settings) {
                const settings = config.settings as unknown as Record<string, unknown>;
                const inc = companyContent.settings as unknown as Record<string, unknown>;
                for (const [key, value] of Object.entries(inc)) {
                  if (settings[key] == null && value != null) settings[key] = value;
                }
              }

              // Append memory.md if present
              const srcMemory = join(srcDir, "memory.md");
              if (existsSync(srcMemory)) {
                const destMemory = join(polpoDir, "memory.md");
                const memContent = readFileSync(srcMemory, "utf-8");
                if (existsSync(destMemory)) {
                  const existing = readFileSync(destMemory, "utf-8");
                  writeFileSync(destMemory, existing + `\n\n<!-- Imported from ink: ${pkg.name} -->\n` + memContent, "utf-8");
                } else {
                  writeFileSync(destMemory, memContent, "utf-8");
                }
              }

              // Copy skills if present
              const srcSkills = join(srcDir, "skills");
              if (existsSync(srcSkills)) {
                const skillsDest = join(polpoDir, "skills");
                mkdirSync(skillsDest, { recursive: true });
                const skillEntries = readdirSync(srcSkills, { withFileTypes: true });
                for (const entry of skillEntries) {
                  if (!entry.isDirectory()) continue;
                  const dest = join(skillsDest, entry.name);
                  if (!existsSync(dest)) {
                    cpSync(join(srcSkills, entry.name), dest, { recursive: true });
                  }
                }
              }

              configChanged = true;
              installed.push(`company: ${pkg.name}`);
              break;
            }
          }
        }

        // Save config if changed
        if (configChanged) {
          savePolpoConfig(polpoDir, config);
        }

        // Update lock file
        const lockEntry: InkLockEntry = {
          source: sourceLabel,
          commitHash,
          installedAt: new Date().toISOString(),
          packages: packages.map((p) => ({
            type: p.type,
            name: p.name,
            contentHash: p.contentHash,
          })),
        };
        writeInkLock(polpoDir, upsertInkLockEntry(lock, lockEntry));

        // Fire telemetry
        reportInstall(sourceLabel, packages);

        // Clean up cache
        execSync(`rm -rf "${repoDir}"`);

        return ok(
          `Installed ${packages.length} package(s) from "${sourceLabel}":\n\n${installed.map((i) => `  - ${i}`).join("\n")}\n\nLock file updated.`,
          { source: sourceLabel, count: packages.length, packages: installed },
        );
      } catch (e: any) {
        return err(`Failed to install from "${params.source}": ${e.message}`);
      }
    },
  };
}

// ─── Factory ───

export type InkToolName = "ink_search" | "ink_browse" | "ink_add";

export const ALL_INK_TOOL_NAMES: readonly InkToolName[] = ["ink_search", "ink_browse", "ink_add"];

/**
 * Create Ink Hub tools.
 *
 * @param polpoDir - Path to the .polpo directory
 * @param allowedTools - Optional filter
 */
export function createInkTools(
  polpoDir: string,
  allowedTools?: string[],
): AgentTool<any>[] {
  const factories: Record<InkToolName, () => AgentTool<any>> = {
    ink_search: () => createInkSearchTool(),
    ink_browse: () => createInkBrowseTool(polpoDir),
    ink_add: () => createInkAddTool(polpoDir),
  };

  const names = allowedTools
    ? ALL_INK_TOOL_NAMES.filter((n) => allowedTools.some((a) => a.toLowerCase() === n))
    : [...ALL_INK_TOOL_NAMES];

  return names.map((n) => factories[n]());
}
