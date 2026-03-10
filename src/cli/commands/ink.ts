/**
 * CLI ink subcommands — add, list, remove, update.
 *
 * polpo ink add <source>     — Clone a registry repo and install packages
 * polpo ink list              — Show installed packages from ink.lock
 * polpo ink remove <source>   — Remove an installed registry source
 * polpo ink update [source]   — Update installed registries (git pull + re-discover)
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

import {
  parseInkSource,
  discoverInkPackages,
  readInkLock,
  writeInkLock,
  upsertInkLockEntry,
  removeInkLockEntry,
  isInkSourceInstalled,
  getInkLockEntry,
  uninstallInkPackages,
} from "../../core/ink.js";
import type { InkPackage, InkLockEntry, InkLockPackage } from "../../core/ink.js";
import { loadPolpoConfig, savePolpoConfig } from "../../core/config.js";
import type { PolpoFileConfig, AgentConfig, Team } from "../../core/types.js";

// ── Helpers ────────────────────────────────────────────────────────────

function getPolpoDir(dir: string): string {
  return resolve(dir, ".polpo");
}

/** Directory where registry repos are cached. */
function getCacheDir(polpoDir: string): string {
  return join(polpoDir, "ink-cache");
}

/** Clone or update a git repo into the cache directory. Returns the local path. */
function cloneOrPull(url: string, cacheKey: string, cacheDir: string): string {
  const repoDir = join(cacheDir, cacheKey);
  mkdirSync(cacheDir, { recursive: true });

  if (existsSync(repoDir)) {
    // Pull latest
    try {
      execSync("git pull --ff-only", { cwd: repoDir, stdio: "pipe" });
    } catch {
      // If pull fails (e.g. diverged), re-clone
      rmSync(repoDir, { recursive: true, force: true });
      execSync(`git clone --depth 1 ${url} ${repoDir}`, { stdio: "pipe" });
    }
  } else {
    execSync(`git clone --depth 1 ${url} ${repoDir}`, { stdio: "pipe" });
  }

  return repoDir;
}

/** Get the current git commit hash for a repo directory. */
function getCommitHash(repoDir: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

// ── Interactive prompt helper ──────────────────────────────────────────

async function askUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * Conflict resolution for a named item (agent, team, skill, playbook).
 * Returns: "merge" | "skip" | "overwrite"
 */
async function resolveConflict(
  type: string,
  name: string,
  interactive: boolean,
): Promise<"merge" | "skip" | "overwrite"> {
  if (!interactive) return "merge"; // non-interactive: default to merge
  const answer = await askUser(
    chalk.yellow(`  ${type} "${name}" already exists. [m]erge / [o]verwrite / [s]kip? `),
  );
  if (answer.startsWith("o")) return "overwrite";
  if (answer.startsWith("s")) return "skip";
  return "merge";
}

// ── Install logic ─────────────────────────────────────────────────────

export interface InstallResult {
  installed: string[];
  skipped: string[];
  merged: string[];
}

/**
 * Install discovered packages into the project by merging into the existing config.
 *
 * - Playbooks: copied to .polpo/playbooks/<name>/ (prompt on conflict)
 * - Agents: merged into polpo.json teams (prompt on name collision)
 * - Companies: full merge — teams/agents into polpo.json, memory appended,
 *   skills copied, system-context appended
 */
async function installPackages(
  packages: InkPackage[],
  polpoDir: string,
  interactive: boolean,
): Promise<InstallResult> {
  const result: InstallResult = { installed: [], skipped: [], merged: [] };

  // Load existing config (or create a minimal one)
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

        if (existsSync(destDir)) {
          const action = await resolveConflict("Playbook", pkg.name, interactive);
          if (action === "skip") {
            result.skipped.push(`playbook: ${pkg.name}`);
            break;
          }
          if (action === "overwrite") {
            rmSync(destDir, { recursive: true, force: true });
          }
          // merge for playbook = overwrite (it's a single unit)
        }

        mkdirSync(destDir, { recursive: true });
        const srcDir = resolve(pkg.path, "..");
        const entries = readdirSync(srcDir);
        for (const entry of entries) {
          cpSync(join(srcDir, entry), join(destDir, entry), { recursive: true });
        }
        result.installed.push(`playbook: ${pkg.name}`);
        break;
      }

      case "agent": {
        const agentContent = pkg.content as AgentConfig;
        const mergeResult = await mergeAgent(agentContent, config, interactive);
        if (mergeResult === "skip") {
          result.skipped.push(`agent: ${pkg.name}`);
        } else {
          configChanged = true;
          if (mergeResult === "merged") {
            result.merged.push(`agent: ${pkg.name}`);
          } else {
            result.installed.push(`agent: ${pkg.name}`);
          }
        }
        break;
      }

      case "company": {
        const companyContent = pkg.content as PolpoFileConfig;
        const srcDir = resolve(pkg.path, "..");

        // 1. Merge teams + agents into config
        const teamMergeResult = await mergeCompanyTeams(companyContent, config, interactive);
        if (teamMergeResult.changed) configChanged = true;
        result.installed.push(...teamMergeResult.installed);
        result.merged.push(...teamMergeResult.merged);
        result.skipped.push(...teamMergeResult.skipped);

        // 2. Merge settings (only fill in missing settings, never overwrite)
        if (companyContent.settings) {
          mergeSettings(config, companyContent.settings);
          configChanged = true;
        }

        // 3. Merge providers (only add missing providers)
        if (companyContent.providers) {
          if (!config.providers) config.providers = {};
          for (const [name, providerConfig] of Object.entries(companyContent.providers)) {
            if (!config.providers[name]) {
              config.providers[name] = providerConfig;
              result.installed.push(`provider: ${name}`);
            }
          }
          configChanged = true;
        }

        // 4. Append memory.md if present in package
        const srcMemory = join(srcDir, "memory.md");
        if (existsSync(srcMemory)) {
          appendFileContent(
            join(polpoDir, "memory.md"),
            readFileSync(srcMemory, "utf-8"),
            `\n\n<!-- Imported from ink package: ${pkg.name} -->\n`,
          );
          result.installed.push(`memory: ${pkg.name}`);
        }

        // 5. Append system-context.md if present in package
        const srcContext = join(srcDir, "system-context.md");
        if (existsSync(srcContext)) {
          appendFileContent(
            join(polpoDir, "system-context.md"),
            readFileSync(srcContext, "utf-8"),
            `\n\n<!-- Imported from ink package: ${pkg.name} -->\n`,
          );
          result.installed.push(`system-context: ${pkg.name}`);
        }

        // 6. Copy skills if present
        const srcSkills = join(srcDir, "skills");
        if (existsSync(srcSkills)) {
          const skillsDestDir = join(polpoDir, "skills");
          mkdirSync(skillsDestDir, { recursive: true });
          const skillEntries = readdirSync(srcSkills, { withFileTypes: true });
          for (const entry of skillEntries) {
            if (!entry.isDirectory()) continue;
            const skillDest = join(skillsDestDir, entry.name);
            if (existsSync(skillDest)) {
              const action = await resolveConflict("Skill", entry.name, interactive);
              if (action === "skip") {
                result.skipped.push(`skill: ${entry.name}`);
                continue;
              }
              if (action === "overwrite") {
                rmSync(skillDest, { recursive: true, force: true });
              }
            }
            cpSync(join(srcSkills, entry.name), skillDest, { recursive: true });
            result.installed.push(`skill: ${entry.name}`);
          }
        }

        break;
      }
    }
  }

  // Save config if changed
  if (configChanged) {
    savePolpoConfig(polpoDir, config);
  }

  return result;
}

// ── Merge helpers ─────────────────────────────────────────────────────

/**
 * Merge a single agent into the config.
 * Adds to the first team (or "default" team). On name collision, asks user.
 */
async function mergeAgent(
  agent: AgentConfig,
  config: PolpoFileConfig,
  interactive: boolean,
): Promise<"added" | "merged" | "skip"> {
  // Find existing agent across all teams
  for (const team of config.teams) {
    const existing = team.agents.find((a) => a.name === agent.name);
    if (existing) {
      const action = await resolveConflict("Agent", agent.name, interactive);
      if (action === "skip") return "skip";
      if (action === "overwrite") {
        // Replace the agent in the team
        team.agents = team.agents.map((a) => (a.name === agent.name ? stripInkMetadata(agent) : a));
        return "merged";
      }
      // merge: combine fields — incoming fills in missing fields, doesn't overwrite
      mergeAgentFields(existing, agent);
      return "merged";
    }
  }

  // No collision — add to first team
  const targetTeam = config.teams[0] ?? { name: "default", agents: [] };
  if (!config.teams.includes(targetTeam)) config.teams.push(targetTeam);
  targetTeam.agents.push(stripInkMetadata(agent));
  return "added";
}

/**
 * Merge company teams/agents into existing config.
 * For each team in the company:
 *   - If a team with the same name exists, merge agents into it
 *   - Otherwise, add the team
 */
async function mergeCompanyTeams(
  company: PolpoFileConfig,
  config: PolpoFileConfig,
  interactive: boolean,
): Promise<{ changed: boolean; installed: string[]; merged: string[]; skipped: string[] }> {
  const installed: string[] = [];
  const merged: string[] = [];
  const skipped: string[] = [];
  let changed = false;

  const companyTeams: Team[] = Array.isArray(company.teams)
    ? company.teams
    : (company as any).team
      ? [(company as any).team]
      : [];

  for (const incomingTeam of companyTeams) {
    const existingTeam = config.teams.find((t) => t.name === incomingTeam.name);

    if (existingTeam) {
      // Merge agents into existing team
      for (const agent of incomingTeam.agents) {
        const existingAgent = existingTeam.agents.find((a) => a.name === agent.name);
        if (existingAgent) {
          const action = await resolveConflict("Agent", agent.name, interactive);
          if (action === "skip") {
            skipped.push(`agent: ${agent.name} (team: ${incomingTeam.name})`);
            continue;
          }
          if (action === "overwrite") {
            existingTeam.agents = existingTeam.agents.map((a) =>
              a.name === agent.name ? stripInkMetadata(agent) : a,
            );
          } else {
            mergeAgentFields(existingAgent, agent);
          }
          merged.push(`agent: ${agent.name} (team: ${incomingTeam.name})`);
        } else {
          existingTeam.agents.push(stripInkMetadata(agent));
          installed.push(`agent: ${agent.name} (team: ${incomingTeam.name})`);
        }
        changed = true;
      }

      // Merge team description if missing
      if (!existingTeam.description && incomingTeam.description) {
        existingTeam.description = incomingTeam.description;
        changed = true;
      }
    } else {
      // Add entire team (strip ink metadata from all agents)
      const cleanTeam: Team = {
        name: incomingTeam.name,
        description: incomingTeam.description,
        agents: incomingTeam.agents.map(stripInkMetadata),
      };
      config.teams.push(cleanTeam);
      installed.push(`team: ${incomingTeam.name} (${incomingTeam.agents.length} agents)`);
      changed = true;
    }
  }

  return { changed, installed, merged, skipped };
}

/**
 * Merge agent fields from incoming into existing.
 * Only fills in fields that are missing in the existing agent.
 * Never overwrites existing values.
 */
function mergeAgentFields(existing: AgentConfig, incoming: AgentConfig): void {
  if (!existing.role && incoming.role) existing.role = incoming.role;
  if (!existing.model && incoming.model) existing.model = incoming.model;
  if (!existing.systemPrompt && incoming.systemPrompt) existing.systemPrompt = incoming.systemPrompt;
  if (!existing.identity && incoming.identity) existing.identity = incoming.identity;
  if (!existing.allowedTools && incoming.allowedTools) existing.allowedTools = incoming.allowedTools;
  if (!existing.skills?.length && incoming.skills?.length) existing.skills = incoming.skills;
  if (!existing.reportsTo && incoming.reportsTo) existing.reportsTo = incoming.reportsTo;
  if (existing.maxTurns == null && incoming.maxTurns != null) existing.maxTurns = incoming.maxTurns;
  if (existing.maxConcurrency == null && incoming.maxConcurrency != null) existing.maxConcurrency = incoming.maxConcurrency;
  if (existing.reasoning == null && incoming.reasoning != null) existing.reasoning = incoming.reasoning;
}

/**
 * Strip ink-specific metadata fields (version, author, tags) from an agent config
 * so they don't end up in polpo.json.
 */
function stripInkMetadata(agent: AgentConfig): AgentConfig {
  const clean = { ...agent };
  delete (clean as any).version;
  delete (clean as any).author;
  delete (clean as any).tags;
  return clean;
}

/**
 * Merge settings from incoming company — only fill in missing values.
 */
function mergeSettings(config: PolpoFileConfig, incoming: any): void {
  if (!config.settings) {
    config.settings = incoming;
    return;
  }
  const settings = config.settings as unknown as Record<string, unknown>;
  const inc = incoming as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(inc)) {
    if (settings[key] == null && value != null) {
      settings[key] = value;
    }
  }
}

/**
 * Append content to a file. Creates the file if it doesn't exist.
 */
function appendFileContent(destPath: string, content: string, separator: string): void {
  if (existsSync(destPath)) {
    const existing = readFileSync(destPath, "utf-8");
    writeFileSync(destPath, existing + separator + content, "utf-8");
  } else {
    mkdirSync(resolve(destPath, ".."), { recursive: true });
    writeFileSync(destPath, content, "utf-8");
  }
}

/**
 * Remove installed packages for a registry source.
 * Delegates to the shared `uninstallInkPackages()` from core/ink.ts.
 */
function uninstallPackages(entry: InkLockEntry, polpoDir: string): void {
  uninstallInkPackages(
    entry,
    polpoDir,
    () => loadPolpoConfig(polpoDir),
    (config) => savePolpoConfig(polpoDir, config),
  );
}

/** Format a package type with color. */
function formatType(type: string): string {
  switch (type) {
    case "playbook": return chalk.cyan("playbook");
    case "agent": return chalk.blue("agent");
    case "company": return chalk.magenta("company");
    default: return type;
  }
}

/** Format a verdict level with color. */
function formatVerdict(verdict?: string): string {
  switch (verdict) {
    case "safe": return chalk.green("safe");
    case "warning": return chalk.yellow("warning");
    case "dangerous": return chalk.red("dangerous");
    default: return chalk.dim("unscanned");
  }
}

const INK_API_URL = "https://polpo.sh/api";

/**
 * Fire-and-forget telemetry POST to the Ink Hub API.
 * Records which packages were installed so the leaderboard can track usage.
 * Fails silently — never blocks or interrupts the user.
 */
async function reportInkInstall(source: string, packages: InkPackage[]): Promise<void> {
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

    await fetch(`${INK_API_URL}/installs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000), // 5s timeout
    });
  } catch {
    // Silently ignore — telemetry should never fail the install
  }
}

// ── Registration ───────────────────────────────────────────────────────

export function registerInkCommands(program: Command): void {
  const ink = program
    .command("ink")
    .description("Ink registry — install and manage playbooks, agents, and company configs");

  // ── ink add ──────────────────────────────────────────────────────────

  ink
    .command("add <source>")
    .description("Install packages from a registry (owner/repo, GitHub URL, or local path)")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-y, --yes", "Skip confirmation prompts", false)
    .option("-n, --name <name>", "Install a specific package by name")
    .option("--list", "List available packages without installing", false)
    .action(async (source: string, opts: { dir: string; yes: boolean; list: boolean; name?: string }) => {
      const polpoDir = getPolpoDir(opts.dir);
      const cacheDir = getCacheDir(polpoDir);

      // Parse source
      const parsed = parseInkSource(source);
      const sourceLabel = parsed.ownerRepo ?? source;

      console.log(chalk.bold(`\n  Ink — adding from ${chalk.white(sourceLabel)}\n`));

      // Check if already installed
      const lock = readInkLock(polpoDir);
      if (isInkSourceInstalled(lock, sourceLabel) && !opts.list) {
        console.log(chalk.yellow(`  Already installed. Use ${chalk.white("polpo ink update")} to refresh.\n`));
        return;
      }

      // Clone or use local path
      let registryDir: string;
      let commitHash: string;

      if (parsed.type === "local") {
        registryDir = parsed.url;
        commitHash = "local";
        console.log(chalk.dim(`  Source: local path ${registryDir}`));
      } else {
        console.log(chalk.dim(`  Cloning ${parsed.url}...`));
        try {
          const cacheKey = sourceLabel.replace(/\//g, "--");
          registryDir = cloneOrPull(parsed.url, cacheKey, cacheDir);
          commitHash = getCommitHash(registryDir);
          console.log(chalk.dim(`  Cloned at ${commitHash.slice(0, 8)}`));
        } catch (err: any) {
          console.error(chalk.red(`  Failed to clone: ${err.message}`));
          process.exit(1);
        }
      }

      // Discover packages
      let { packages, errors } = discoverInkPackages(registryDir);

      if (errors.length > 0) {
        console.log(chalk.yellow(`\n  Validation errors:`));
        for (const err of errors) {
          console.log(chalk.red(`    - ${err}`));
        }
      }

      if (packages.length === 0) {
        console.log(chalk.yellow(`\n  No packages found in ${sourceLabel}\n`));
        return;
      }

      // Filter by --name if provided
      if (opts.name) {
        const match = packages.filter(p => p.name === opts.name);
        if (match.length === 0) {
          console.log(chalk.yellow(`\n  Package "${opts.name}" not found in ${sourceLabel}.`));
          console.log(chalk.dim(`  Available: ${packages.map(p => p.name).join(", ")}\n`));
          return;
        }
        packages = match;
      }

      // Display discovered packages
      console.log(chalk.bold(`\n  Found ${packages.length} package${packages.length === 1 ? "" : "s"}:\n`));

      const grouped = groupByType(packages);
      for (const [type, pkgs] of Object.entries(grouped)) {
        console.log(`  ${formatType(type)} (${pkgs.length}):`);
        for (const pkg of pkgs) {
          const ver = pkg.metadata.version ? chalk.dim(` v${pkg.metadata.version}`) : "";
          const desc = pkg.metadata.description ? chalk.dim(` — ${pkg.metadata.description}`) : "";
          const tags = pkg.metadata.tags?.length ? chalk.dim(` [${pkg.metadata.tags.join(", ")}]`) : "";
          console.log(`    ${chalk.white(pkg.name)}${ver}${desc}${tags}`);

          // Show security warnings from validation
          const warnings = getPackageWarnings(pkg);
          for (const w of warnings) {
            console.log(chalk.yellow(`      ! ${w}`));
          }
        }
        console.log();
      }

      // List-only mode
      if (opts.list) {
        return;
      }

      // Confirmation
      if (!opts.yes) {
        const warnings = packages.flatMap(p => getPackageWarnings(p));
        if (warnings.length > 0) {
          console.log(chalk.yellow.bold(`  ${warnings.length} security warning${warnings.length === 1 ? "" : "s"} detected. Review above before installing.\n`));
        }

        // Simple confirmation — in a real CLI we'd use inquirer/prompts
        // For now, --yes is needed for non-interactive use
        console.log(chalk.dim(`  Use ${chalk.white("--yes")} to confirm installation.\n`));
        return;
      }

      // Install packages with merge
      console.log(chalk.bold(`  Installing...\n`));

      const installResult = await installPackages(packages, polpoDir, !opts.yes);

      for (const item of installResult.installed) {
        console.log(`  ${chalk.green("+")} ${item}`);
      }
      for (const item of installResult.merged) {
        console.log(`  ${chalk.yellow("~")} merged ${item}`);
      }
      for (const item of installResult.skipped) {
        console.log(`  ${chalk.dim("-")} skipped ${item}`);
      }

      // Update lock file
      const lockPackages: InkLockPackage[] = packages.map(p => ({
        type: p.type,
        name: p.name,
        contentHash: p.contentHash,
      }));

      const entry: InkLockEntry = {
        source: sourceLabel,
        commitHash,
        installedAt: new Date().toISOString(),
        packages: lockPackages,
      };

      const updatedLock = upsertInkLockEntry(lock, entry);
      writeInkLock(polpoDir, updatedLock);

      console.log(chalk.green(`\n  Installed ${packages.length} package${packages.length === 1 ? "" : "s"} from ${sourceLabel}\n`));

      // Telemetry — fire-and-forget POST to Ink Hub API
      reportInkInstall(sourceLabel, packages).catch(() => {});
    });

  // ── ink list ─────────────────────────────────────────────────────────

  ink
    .command("list")
    .alias("ls")
    .description("List installed packages")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (opts: { dir: string }) => {
      const polpoDir = getPolpoDir(opts.dir);
      const lock = readInkLock(polpoDir);

      if (lock.registries.length === 0) {
        console.log(chalk.dim("\n  No packages installed via Ink.\n"));
        console.log(chalk.dim(`  Run ${chalk.white("polpo ink add <owner/repo>")} to install from a registry.\n`));
        return;
      }

      console.log(chalk.bold(`\n  Ink — installed packages\n`));

      for (const reg of lock.registries) {
        const commitShort = reg.commitHash === "local" ? "local" : reg.commitHash.slice(0, 8);
        const date = new Date(reg.installedAt).toLocaleDateString();
        console.log(`  ${chalk.white.bold(reg.source)} ${chalk.dim(`(${commitShort} · ${date})`)}`);

        for (const pkg of reg.packages) {
          const verdict = formatVerdict(pkg.verdict);
          console.log(`    ${formatType(pkg.type)} ${chalk.white(pkg.name)} ${verdict}`);
        }
        console.log();
      }
    });

  // ── ink remove ───────────────────────────────────────────────────────

  ink
    .command("remove <source>")
    .alias("rm")
    .description("Remove an installed registry and its packages")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (source: string, opts: { dir: string }) => {
      const polpoDir = getPolpoDir(opts.dir);
      const lock = readInkLock(polpoDir);

      const entry = getInkLockEntry(lock, source);
      if (!entry) {
        console.error(chalk.red(`\n  Registry '${source}' is not installed.\n`));
        console.log(chalk.dim(`  Run ${chalk.white("polpo ink list")} to see installed registries.\n`));
        process.exit(1);
      }

      // Remove installed files
      uninstallPackages(entry, polpoDir);

      // Remove from lock
      const updatedLock = removeInkLockEntry(lock, source);
      writeInkLock(polpoDir, updatedLock);

      // Remove cached repo
      const cacheDir = getCacheDir(polpoDir);
      const cacheKey = source.replace(/\//g, "--");
      const cachedRepo = join(cacheDir, cacheKey);
      if (existsSync(cachedRepo)) {
        rmSync(cachedRepo, { recursive: true, force: true });
      }

      console.log(chalk.green(`\n  Removed ${entry.packages.length} package${entry.packages.length === 1 ? "" : "s"} from ${source}\n`));

      for (const pkg of entry.packages) {
        console.log(`  ${chalk.red("-")} ${formatType(pkg.type)} ${chalk.white(pkg.name)}`);
      }
      console.log();
    });

  // ── ink update ───────────────────────────────────────────────────────

  ink
    .command("update [source]")
    .description("Update installed registries to latest (or a specific one)")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-y, --yes", "Skip confirmation prompts", false)
    .action(async (source: string | undefined, opts: { dir: string; yes: boolean }) => {
      const polpoDir = getPolpoDir(opts.dir);
      const cacheDir = getCacheDir(polpoDir);
      const lock = readInkLock(polpoDir);

      if (lock.registries.length === 0) {
        console.log(chalk.dim("\n  No registries installed. Nothing to update.\n"));
        return;
      }

      // Filter to specific source or update all
      const toUpdate = source
        ? lock.registries.filter(r => r.source === source)
        : lock.registries;

      if (source && toUpdate.length === 0) {
        console.error(chalk.red(`\n  Registry '${source}' is not installed.\n`));
        process.exit(1);
      }

      console.log(chalk.bold(`\n  Ink — updating ${toUpdate.length} registr${toUpdate.length === 1 ? "y" : "ies"}\n`));

      let totalUpdated = 0;

      for (const reg of toUpdate) {
        const parsed = parseInkSource(reg.source);

        if (parsed.type === "local") {
          console.log(chalk.dim(`  ${reg.source}: local source, re-scanning...`));
        } else {
          console.log(chalk.dim(`  ${reg.source}: pulling latest...`));
        }

        let registryDir: string;
        let newCommitHash: string;

        if (parsed.type === "local") {
          registryDir = parsed.url;
          newCommitHash = "local";
        } else {
          try {
            const cacheKey = reg.source.replace(/\//g, "--");
            registryDir = cloneOrPull(parsed.url, cacheKey, cacheDir);
            newCommitHash = getCommitHash(registryDir);
          } catch (err: any) {
            console.error(chalk.red(`  ${reg.source}: failed to update — ${err.message}`));
            continue;
          }
        }

        // Check if anything changed
        if (newCommitHash === reg.commitHash && parsed.type !== "local") {
          console.log(chalk.dim(`  ${reg.source}: already up to date (${newCommitHash.slice(0, 8)})`));
          continue;
        }

        // Re-discover
        const { packages, errors } = discoverInkPackages(registryDir);

        if (errors.length > 0) {
          for (const err of errors) {
            console.log(chalk.yellow(`    ! ${err}`));
          }
        }

        // Show diff
        const oldNames = new Set(reg.packages.map(p => `${p.type}:${p.name}`));
        const newNames = new Set(packages.map(p => `${p.type}:${p.name}`));

        const added = packages.filter(p => !oldNames.has(`${p.type}:${p.name}`));
        const removed = reg.packages.filter(p => !newNames.has(`${p.type}:${p.name}`));
        const changed = packages.filter(p => {
          const old = reg.packages.find(op => op.type === p.type && op.name === p.name);
          return old && old.contentHash !== p.contentHash;
        });

        if (added.length === 0 && removed.length === 0 && changed.length === 0) {
          console.log(chalk.dim(`  ${reg.source}: no changes`));
          continue;
        }

        console.log(`  ${chalk.white.bold(reg.source)}:`);
        for (const p of added) {
          console.log(`    ${chalk.green("+ new")} ${formatType(p.type)} ${p.name}`);
        }
        for (const p of changed) {
          console.log(`    ${chalk.yellow("~ changed")} ${formatType(p.type)} ${p.name}`);
        }
        for (const p of removed) {
          console.log(`    ${chalk.red("- removed")} ${formatType(p.type)} ${p.name}`);
        }

        if (!opts.yes) {
          console.log(chalk.dim(`\n  Use ${chalk.white("--yes")} to confirm update.\n`));
          continue;
        }

        // Uninstall old packages, install new ones
        uninstallPackages(reg, polpoDir);
        await installPackages(packages, polpoDir, !opts.yes);

        // Update lock
        const lockPackages: InkLockPackage[] = packages.map(p => ({
          type: p.type,
          name: p.name,
          contentHash: p.contentHash,
        }));

        const updatedEntry: InkLockEntry = {
          source: reg.source,
          commitHash: newCommitHash,
          installedAt: new Date().toISOString(),
          packages: lockPackages,
        };

        const updatedLock = upsertInkLockEntry(readInkLock(polpoDir), updatedEntry);
        writeInkLock(polpoDir, updatedLock);

        totalUpdated++;
        console.log(chalk.green(`  Updated ${reg.source} (${newCommitHash.slice(0, 8)})`));
      }

      console.log(chalk.bold(`\n  ${totalUpdated} registr${totalUpdated === 1 ? "y" : "ies"} updated.\n`));
    });
}

// ── Internal helpers ───────────────────────────────────────────────────

function groupByType(packages: InkPackage[]): Record<string, InkPackage[]> {
  const groups: Record<string, InkPackage[]> = {};
  for (const pkg of packages) {
    if (!groups[pkg.type]) groups[pkg.type] = [];
    groups[pkg.type].push(pkg);
  }
  return groups;
}

/** Extract security warnings from a package based on its content. */
function getPackageWarnings(pkg: InkPackage): string[] {
  const warnings: string[] = [];
  const content = pkg.content as unknown as Record<string, unknown>;

  if (pkg.type === "agent") {
    if (typeof content.systemPrompt === "string" && content.systemPrompt.length > 0) {
      warnings.push("Custom systemPrompt detected — review for prompt injection");
    }
    if (Array.isArray(content.allowedTools)) {
      const dangerous = ["bash", "exec"];
      const found = (content.allowedTools as string[]).filter(t => dangerous.some(d => t.includes(d)));
      if (found.length > 0) {
        warnings.push(`Allows dangerous tools: ${found.join(", ")}`);
      }
    }
  }

  if (pkg.type === "company") {
    const teams = (Array.isArray(content.teams) ? content.teams : content.team ? [content.team] : []) as Array<Record<string, unknown>>;
    for (const team of teams) {
      const agents = (Array.isArray(team.agents) ? team.agents : []) as Array<Record<string, unknown>>;
      for (const agent of agents) {
        if (typeof agent.systemPrompt === "string" && agent.systemPrompt.length > 0) {
          warnings.push(`Agent '${agent.name}' has custom systemPrompt`);
        }
      }
    }
  }

  return warnings;
}
