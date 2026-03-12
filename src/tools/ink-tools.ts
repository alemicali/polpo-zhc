/**
 * Ink Hub tools — allow agents to search, browse, install, remove, and update
 * packages from the Ink registry during execution.
 *
 * Tools:
 *   - ink_search:    Search available packages on the Ink Hub
 *   - ink_browse:    Browse installed packages in the local project
 *   - ink_add:       Install packages from a registry source (owner/repo)
 *   - ink_remove:    Remove an installed registry source and its packages
 *   - ink_update:    Update installed registries (git pull + re-discover)
 *
 * These are core tools — always available to agents, no activation needed.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  parseInkSource,
  discoverInkPackages,
  readInkLock,
  writeInkLock,
  upsertInkLockEntry,
  removeInkLockEntry,
  getInkLockEntry,
  isInkSourceInstalled,
  uninstallInkPackages,
  type InkPackage,
  type InkLockEntry,
} from "../core/ink.js";
import { loadPolpoConfig, savePolpoConfig } from "../core/config.js";
import type { PolpoFileConfig, AgentConfig, Team } from "../core/types.js";
import { FileTeamStore } from "../stores/file-team-store.js";
import { FileAgentStore } from "../stores/file-agent-store.js";
import { FileMemoryStore } from "../stores/file-memory-store.js";

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
  name: Type.Optional(Type.String({ description: "Install a specific package by name (e.g. 'devops-engineer'). If omitted, all packages from the source are installed." })),
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
        let { packages, errors } = discoverInkPackages(repoDir);

        if (errors.length > 0) {
          return err(`Validation errors:\n${errors.join("\n")}`);
        }

        if (packages.length === 0) {
          return ok(`No packages found in "${sourceLabel}". The repo should contain playbooks/<name>/playbook.json, agents/<name>.json, or companies/<name>/polpo.json.`);
        }

        // Filter by name if provided
        if (params.name) {
          const match = packages.filter(p => p.name === params.name);
          if (match.length === 0) {
            return ok(`Package "${params.name}" not found in "${sourceLabel}". Available: ${packages.map(p => p.name).join(", ")}`);
          }
          packages = match;
        }

        // Install: merge packages via stores
        const installed: string[] = [];
        const teamStore = new FileTeamStore(polpoDir);
        const agentStore = new FileAgentStore(polpoDir);

        // Ensure default team exists
        const existingTeams = await teamStore.getTeams();
        if (existingTeams.length === 0) {
          await teamStore.createTeam({ name: "default", agents: [] });
        }
        const defaultTeamName = (await teamStore.getTeams())[0].name;

        // Load config for settings merging only
        let config: PolpoFileConfig = loadPolpoConfig(polpoDir) ?? {
          org: "",
          teams: [{ name: "default", agents: [] }],
          settings: { maxRetries: 3, workDir: ".", logLevel: "normal" },
        } as any;
        let configChanged = false;

        for (const pkg of packages) {
          switch (pkg.type) {
            case "playbook": {
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
              const agentContent = pkg.content as AgentConfig;
              const cleanAgent = { ...agentContent };
              delete (cleanAgent as any).version;
              delete (cleanAgent as any).author;
              delete (cleanAgent as any).tags;

              const existingAgent = await agentStore.getAgent(cleanAgent.name);
              if (existingAgent) {
                // Merge: fill in missing fields
                const updates: Partial<AgentConfig> = {};
                if (!existingAgent.role && cleanAgent.role) updates.role = cleanAgent.role;
                if (!existingAgent.model && cleanAgent.model) updates.model = cleanAgent.model;
                if (!existingAgent.identity && cleanAgent.identity) updates.identity = cleanAgent.identity;
                if (!existingAgent.allowedTools && cleanAgent.allowedTools) updates.allowedTools = cleanAgent.allowedTools;
                if (!existingAgent.systemPrompt && cleanAgent.systemPrompt) updates.systemPrompt = cleanAgent.systemPrompt;
                if (Object.keys(updates).length > 0) {
                  await agentStore.updateAgent(cleanAgent.name, updates);
                }
                installed.push(`agent: ${pkg.name} (merged)`);
              } else {
                await agentStore.createAgent(cleanAgent, defaultTeamName);
                installed.push(`agent: ${pkg.name}`);
              }
              break;
            }
            case "company": {
              const companyContent = pkg.content as PolpoFileConfig;
              const srcDir = resolve(pkg.path, "..");

              const companyTeams: Team[] = Array.isArray(companyContent.teams)
                ? companyContent.teams
                : (companyContent as any).team
                  ? [(companyContent as any).team]
                  : [];

              for (const incomingTeam of companyTeams) {
                const existingTeam = await teamStore.getTeam(incomingTeam.name);
                if (existingTeam) {
                  for (const agent of incomingTeam.agents) {
                    const cleanAgent = { ...agent };
                    delete (cleanAgent as any).version;
                    delete (cleanAgent as any).author;
                    delete (cleanAgent as any).tags;
                    const existing = await agentStore.getAgent(agent.name);
                    if (!existing) {
                      await agentStore.createAgent(cleanAgent, incomingTeam.name);
                    }
                  }
                } else {
                  await teamStore.createTeam({ name: incomingTeam.name, description: incomingTeam.description, agents: [] });
                  for (const agent of incomingTeam.agents) {
                    const cleanAgent = { ...agent };
                    delete (cleanAgent as any).version;
                    delete (cleanAgent as any).author;
                    delete (cleanAgent as any).tags;
                    await agentStore.createAgent(cleanAgent, incomingTeam.name);
                  }
                }
              }

              // Merge settings (fill missing only)
              if (companyContent.settings && config.settings) {
                const settings = config.settings as unknown as Record<string, unknown>;
                const inc = companyContent.settings as unknown as Record<string, unknown>;
                for (const [key, value] of Object.entries(inc)) {
                  if (settings[key] == null && value != null) settings[key] = value;
                }
                configChanged = true;
              }

              // Append memory.md if present (via MemoryStore)
              const srcMemory = join(srcDir, "memory.md");
              if (existsSync(srcMemory)) {
                const memStore = new FileMemoryStore(polpoDir);
                const existingMem = await memStore.get();
                const memContent = readFileSync(srcMemory, "utf-8");
                const separator = `\n\n<!-- Imported from ink: ${pkg.name} -->\n`;
                await memStore.save(existingMem ? existingMem + separator + memContent : memContent);
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

              installed.push(`company: ${pkg.name}`);
              break;
            }
          }
        }

        // Save config if non-team data changed
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

// ─── ink_remove ───

const InkRemoveSchema = Type.Object({
  source: Type.String({ description: "Package source to remove — GitHub owner/repo (e.g. 'lumea-labs/ink-registry')" }),
});

function createInkRemoveTool(polpoDir: string): AgentTool<typeof InkRemoveSchema> {
  return {
    name: "ink_remove",
    label: "Remove Ink Package",
    description: "Remove an installed Ink registry source and its packages from the project. Playbooks are deleted, agents are removed from polpo.json. Use ink_browse to see what's installed.",
    parameters: InkRemoveSchema,
    async execute(_toolCallId, params) {
      try {
        const lock = readInkLock(polpoDir);
        const entry = getInkLockEntry(lock, params.source);

        if (!entry) {
          return ok(`Source "${params.source}" is not installed. Use ink_browse to see installed packages.`);
        }

        // Uninstall packages via AgentStore
        const removeAgentStore = new FileAgentStore(polpoDir);
        const removed = await uninstallInkPackages(entry, polpoDir, removeAgentStore);

        // Remove from lock file
        writeInkLock(polpoDir, removeInkLockEntry(lock, params.source));

        // Clean up cache directory
        const cacheDir = join(polpoDir, "ink-cache", params.source.replace(/\//g, "--"));
        if (existsSync(cacheDir)) {
          execSync(`rm -rf "${cacheDir}"`);
        }

        return ok(
          `Removed "${params.source}" (${entry.packages.length} package(s)):\n\n${removed.map((r: string) => `  - ${r}`).join("\n")}\n\nLock file updated.`,
          { source: params.source, removed },
        );
      } catch (e: any) {
        return err(`Failed to remove "${params.source}": ${e.message}`);
      }
    },
  };
}

// ─── ink_update ───

const InkUpdateSchema = Type.Object({
  source: Type.Optional(Type.String({ description: "Specific source to update (e.g. 'lumea-labs/ink-registry'). If omitted, all installed sources are updated." })),
});

function createInkUpdateTool(polpoDir: string): AgentTool<typeof InkUpdateSchema> {
  return {
    name: "ink_update",
    label: "Update Ink Packages",
    description: "Update installed Ink packages by pulling the latest from their git repos. Re-discovers and re-installs packages, updating the lock file with new commit hashes.",
    parameters: InkUpdateSchema,
    async execute(_toolCallId, params) {
      try {
        const lock = readInkLock(polpoDir);

        if (lock.registries.length === 0) {
          return ok("No Ink packages installed. Use ink_search to find packages and ink_add to install them.");
        }

        // Determine which sources to update
        let entries = lock.registries;
        if (params.source) {
          const entry = getInkLockEntry(lock, params.source);
          if (!entry) {
            return ok(`Source "${params.source}" is not installed. Use ink_browse to see installed packages.`);
          }
          entries = [entry];
        }

        const results: string[] = [];
        let updatedLock = { ...lock, registries: [...lock.registries] };

        for (const entry of entries) {
          const parsed = parseInkSource(entry.source);
          const cacheDir = join(polpoDir, "ink-cache");
          mkdirSync(cacheDir, { recursive: true });
          const repoDir = join(cacheDir, entry.source.replace(/\//g, "--"));

          // Clone or pull
          if (existsSync(repoDir)) {
            try {
              execSync("git pull --ff-only", { cwd: repoDir, stdio: "pipe", timeout: 30000 });
            } catch {
              rmSync(repoDir, { recursive: true, force: true });
              execSync(`git clone --depth 1 "${parsed.url}" "${repoDir}"`, { stdio: "pipe", timeout: 30000 });
            }
          } else {
            execSync(`git clone --depth 1 "${parsed.url}" "${repoDir}"`, { stdio: "pipe", timeout: 30000 });
          }

          const newHash = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();

          // Check if anything changed
          if (newHash === entry.commitHash) {
            results.push(`${entry.source}: already up to date (${newHash.slice(0, 7)})`);
            continue;
          }

          // Re-discover packages
          const { packages, errors } = discoverInkPackages(repoDir);
          if (errors.length > 0 || packages.length === 0) {
            results.push(`${entry.source}: ${errors.length > 0 ? `errors: ${errors.join("; ")}` : "no packages found"}`);
            continue;
          }

          // Uninstall old packages via AgentStore
          const updateAgentStore = new FileAgentStore(polpoDir);
          const updateTeamStore = new FileTeamStore(polpoDir);
          await uninstallInkPackages(entry, polpoDir, updateAgentStore);

          // Ensure default team exists
          const updateTeams = await updateTeamStore.getTeams();
          if (updateTeams.length === 0) {
            await updateTeamStore.createTeam({ name: "default", agents: [] });
          }
          const updateDefaultTeam = (await updateTeamStore.getTeams())[0].name;

          const installed: string[] = [];

          for (const pkg of packages) {
            switch (pkg.type) {
              case "playbook": {
                const destDir = join(polpoDir, "playbooks", pkg.name);
                mkdirSync(destDir, { recursive: true });
                const srcDir = resolve(pkg.path, "..");
                const srcEntries = readdirSync(srcDir);
                for (const e of srcEntries) {
                  cpSync(join(srcDir, e), join(destDir, e), { recursive: true });
                }
                installed.push(`playbook: ${pkg.name}`);
                break;
              }
              case "agent": {
                const agentContent = pkg.content as AgentConfig;
                const cleanAgent = { ...agentContent };
                delete (cleanAgent as any).version;
                delete (cleanAgent as any).author;
                delete (cleanAgent as any).tags;

                const existingAgent = await updateAgentStore.getAgent(cleanAgent.name);
                if (existingAgent) {
                  const { name: _, ...updates } = cleanAgent;
                  await updateAgentStore.updateAgent(cleanAgent.name, updates);
                  installed.push(`agent: ${pkg.name} (updated)`);
                } else {
                  await updateAgentStore.createAgent(cleanAgent, updateDefaultTeam);
                  installed.push(`agent: ${pkg.name}`);
                }
                break;
              }
              case "company": {
                const companyContent = pkg.content as PolpoFileConfig;
                const companyTeams: Team[] = Array.isArray(companyContent.teams)
                  ? companyContent.teams
                  : (companyContent as any).team ? [(companyContent as any).team] : [];

                for (const incomingTeam of companyTeams) {
                  const existingTeam = await updateTeamStore.getTeam(incomingTeam.name);
                  if (existingTeam) {
                    for (const agent of incomingTeam.agents) {
                      const cleanAgent = { ...agent };
                      delete (cleanAgent as any).version;
                      delete (cleanAgent as any).author;
                      delete (cleanAgent as any).tags;
                      const existing = await updateAgentStore.getAgent(agent.name);
                      if (existing) {
                        const { name: _, ...updates } = cleanAgent;
                        await updateAgentStore.updateAgent(agent.name, updates);
                      } else {
                        await updateAgentStore.createAgent(cleanAgent, incomingTeam.name);
                      }
                    }
                  } else {
                    await updateTeamStore.createTeam({ name: incomingTeam.name, description: incomingTeam.description, agents: [] });
                    for (const agent of incomingTeam.agents) {
                      const cleanAgent = { ...agent };
                      delete (cleanAgent as any).version;
                      delete (cleanAgent as any).author;
                      delete (cleanAgent as any).tags;
                      await updateAgentStore.createAgent(cleanAgent, incomingTeam.name);
                    }
                  }
                }
                installed.push(`company: ${pkg.name}`);
                break;
              }
            }
          }

          // Update lock entry
          const newEntry: InkLockEntry = {
            source: entry.source,
            commitHash: newHash,
            installedAt: new Date().toISOString(),
            packages: packages.map((p) => ({
              type: p.type,
              name: p.name,
              contentHash: p.contentHash,
            })),
          };
          updatedLock = upsertInkLockEntry(updatedLock, newEntry);

          results.push(`${entry.source}: updated ${entry.commitHash.slice(0, 7)} → ${newHash.slice(0, 7)} (${installed.length} packages)`);

          // Clean up cache
          execSync(`rm -rf "${repoDir}"`);
        }

        writeInkLock(polpoDir, updatedLock);

        return ok(
          `Update complete:\n\n${results.map(r => `  - ${r}`).join("\n")}`,
          { updated: results.length },
        );
      } catch (e: any) {
        return err(`Failed to update: ${e.message}`);
      }
    },
  };
}

// ─── Factory ───

export type InkToolName = "ink_search" | "ink_browse" | "ink_add" | "ink_remove" | "ink_update";

export const ALL_INK_TOOL_NAMES: readonly InkToolName[] = ["ink_search", "ink_browse", "ink_add", "ink_remove", "ink_update"];

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
    ink_remove: () => createInkRemoveTool(polpoDir),
    ink_update: () => createInkUpdateTool(polpoDir),
  };

  const names = allowedTools
    ? ALL_INK_TOOL_NAMES.filter((n) => allowedTools.some((a) => a.toLowerCase() === n))
    : [...ALL_INK_TOOL_NAMES];

  return names.map((n) => factories[n]());
}
