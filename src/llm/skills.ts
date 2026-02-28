/**
 * Polpo Skills System
 *
 * Skills are markdown files (SKILL.md) with YAML frontmatter that provide
 * specialized knowledge and workflows to agents. They are loaded as additional
 * system prompt context at spawn time.
 *
 * Filesystem layout:
 *
 *   .polpo/skills/               ← shared skill pool (installed by `polpo skills add`)
 *     frontend-design/SKILL.md
 *     testing/SKILL.md
 *
 *   .polpo/agents/               ← per-agent skill assignment via symlinks
 *     dev-1/skills/
 *       frontend-design -> ../../../skills/frontend-design
 *       testing -> ../../../skills/testing
 *     reviewer/skills/
 *       testing -> ../../../skills/testing
 *
 * Discovery:
 *
 *   Project-level:
 *     .polpo/skills/              ← primary (managed by Polpo)
 *
 *   User-level:
 *     ~/.polpo/skills/            ← global skills shared across all projects
 *
 * Assignment priority:
 *   1. .polpo/agents/<name>/skills/ (symlinks → hard enforcement)
 *   2. AgentConfig.skills[] names resolved against the pool (soft/config-based)
 */

import { resolve, basename, join } from "node:path";
import {
  readFileSync, writeFileSync, readdirSync, existsSync, lstatSync, realpathSync,
  mkdirSync, symlinkSync, rmSync, cpSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

// ── Types ──

export interface SkillInfo {
  /** Unique skill name (directory name or frontmatter `name`). */
  name: string;
  /** Human-readable description from frontmatter. */
  description: string;
  /** Tools required by this skill (informational, from frontmatter `allowed-tools`). */
  allowedTools?: string[];
  /** Where this skill was discovered from. */
  source: "project" | "global";
  /** Absolute path to the skill directory. */
  path: string;
}

export interface LoadedSkill extends SkillInfo {
  /** Full SKILL.md content (markdown body without frontmatter). */
  content: string;
}

// ── Parsing ──

/**
 * Parse SKILL.md YAML frontmatter.
 * Returns null if no frontmatter block found at all.
 *
 * Note: `name` is NOT required in frontmatter — the skills.sh spec only
 * requires `name` + `description`, but the name can fall back to the
 * directory name at the caller site. We return `name` as undefined when
 * the frontmatter doesn't contain it.
 */
export function parseSkillFrontmatter(content: string): { name?: string; description: string; allowedTools?: string[] } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const fm = parseYaml(match[1]);
    if (!fm || typeof fm !== "object") return null;
    // Must have at least name or description to be considered a valid skill
    if (!fm.name && !fm.description) return null;
    return {
      name: fm.name ?? undefined,
      description: fm.description ?? "",
      allowedTools: fm["allowed-tools"] ?? fm.allowedTools,
    };
  } catch { return null; }
}

/** Extract the markdown body (everything after the frontmatter block). */
function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

// ── Discovery ──

/** Scan a single skills directory and return discovered skills. */
function scanSkillsDir(dir: string, source: SkillInfo["source"]): SkillInfo[] {
  const skills: SkillInfo[] = [];
  if (!existsSync(dir)) return skills;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Follow symlinks — the entry might be a symlink to a skill dir
      const entryPath = resolve(dir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const real = realpathSync(entryPath);
          const stat = lstatSync(real);
          isDir = stat.isDirectory();
        } catch { continue; /* broken symlink */ }
      }
      if (!isDir) continue;

      const skillPath = resolve(entryPath, "SKILL.md");
      if (!existsSync(skillPath)) continue;

      try {
        const raw = readFileSync(skillPath, "utf-8");
        const fm = parseSkillFrontmatter(raw);
        // Use frontmatter name if available, otherwise directory name
        const name = fm?.name ?? entry.name;
        skills.push({
          name,
          description: fm?.description ?? "",
          allowedTools: fm?.allowedTools,
          source,
          path: entryPath,
        });
      } catch { /* skip unreadable */ }
    }
  } catch { /* skip unreadable dir */ }
  return skills;
}

/**
 * Discover ALL available skills across all sources.
 * Returns deduplicated list (first occurrence wins by name).
 *
 * Search order:
 *   1. <polpoDir>/skills/   — project-level pool (managed by `polpo skills add`)
 *   2. ~/.polpo/skills/     — user-level global pool (shared across projects)
 */
export function discoverSkills(cwd: string, polpoDir?: string): SkillInfo[] {
  const seen = new Set<string>();
  const all: SkillInfo[] = [];

  const dirs: Array<{ dir: string; source: SkillInfo["source"] }> = [
    { dir: resolve(polpoDir ?? resolve(cwd, ".polpo"), "skills"), source: "project" },
    { dir: resolve(homedir(), ".polpo", "skills"), source: "global" },
  ];

  for (const { dir, source } of dirs) {
    for (const skill of scanSkillsDir(dir, source)) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        all.push(skill);
      }
    }
  }

  return all;
}

// ── Per-agent loading ──

/**
 * Get the skills assigned to a specific agent.
 *
 * Priority:
 *   1. .polpo/agents/<agentName>/skills/ directory (symlinks to pool skills)
 *   2. AgentConfig.skills[] names resolved against the full pool
 *
 * Returns loaded skills with full content ready for system prompt injection.
 */
export function loadAgentSkills(
  cwd: string,
  polpoDir: string,
  agentName: string,
  configSkillNames?: string[],
): LoadedSkill[] {
  const agentSkillsDir = resolve(polpoDir, "agents", agentName, "skills");

  // Strategy 1: agent has a skills dir with symlinks → hard enforcement
  if (existsSync(agentSkillsDir)) {
    const skills = scanSkillsDir(agentSkillsDir, "project");
    return skills.map(s => loadSkillContent(s)).filter((s): s is LoadedSkill => s !== null);
  }

  // Strategy 2: resolve config skill names against the pool
  if (configSkillNames && configSkillNames.length > 0) {
    const pool = discoverSkills(cwd, polpoDir);
    const poolMap = new Map(pool.map(s => [s.name, s]));
    const loaded: LoadedSkill[] = [];
    for (const name of configSkillNames) {
      const info = poolMap.get(name);
      if (info) {
        const skill = loadSkillContent(info);
        if (skill) loaded.push(skill);
      }
    }
    return loaded;
  }

  return [];
}

/** Load SKILL.md content for a discovered skill. Returns null if unreadable. */
export function loadSkillContent(info: SkillInfo): LoadedSkill | null {
  const skillPath = resolve(info.path, "SKILL.md");
  try {
    const raw = readFileSync(skillPath, "utf-8");
    return {
      ...info,
      content: extractBody(raw),
    };
  } catch { return null; }
}

/**
 * Get a skill's full content by name.
 * Searches the specified pool (agent or orchestrator) and returns the loaded skill,
 * or null if not found / unreadable.
 */
export function getSkillByName(
  cwd: string,
  polpoDir: string,
  name: string,
  pool: "agent" | "orchestrator" = "agent",
): LoadedSkill | null {
  const skills = pool === "orchestrator"
    ? discoverOrchestratorSkills(polpoDir)
    : discoverSkills(cwd, polpoDir);

  const info = skills.find(s => s.name === name);
  if (!info) return null;
  return loadSkillContent(info);
}

// ── Skill assignment helpers ──

/**
 * Assign a skill to an agent by creating a symlink.
 * Creates .polpo/agents/<agentName>/skills/<skillName> → <skillPath>
 */
export function assignSkillToAgent(polpoDir: string, agentName: string, skillName: string, skillPath: string): void {
  const agentSkillsDir = resolve(polpoDir, "agents", agentName, "skills");
  mkdirSync(agentSkillsDir, { recursive: true });
  const linkPath = resolve(agentSkillsDir, skillName);
  if (!existsSync(linkPath)) {
    symlinkSync(skillPath, linkPath);
  }
}

/**
 * Remove a skill assignment (symlink) from a specific agent.
 * Returns true if the symlink existed and was removed, false otherwise.
 */
export function unassignSkillFromAgent(polpoDir: string, agentName: string, skillName: string): boolean {
  const linkPath = resolve(polpoDir, "agents", agentName, "skills", skillName);
  if (!existsSync(linkPath)) return false;
  rmSync(linkPath, { recursive: true, force: true });
  return true;
}

/**
 * Build the skill injection block for an agent's system prompt.
 * Returns empty string if no skills are assigned.
 */
export function buildSkillPrompt(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "";

  const parts = [
    `\n## Assigned Skills\n`,
    `You have ${skills.length} skill${skills.length > 1 ? "s" : ""} loaded. Use this knowledge when applicable:\n`,
  ];

  for (const skill of skills) {
    parts.push(`### ${skill.name}`);
    if (skill.description) parts.push(`> ${skill.description}\n`);
    parts.push(skill.content);
    parts.push(""); // blank line between skills
  }

  return parts.join("\n");
}

// ── Installation (skills.sh compatible) ────────────────────────────────

/**
 * Parse a skill source input into a structured format.
 *
 * Supported formats:
 *   - "owner/repo"                     → GitHub shorthand
 *   - "https://github.com/owner/repo"  → Full GitHub URL
 *   - "./local-path"                   → Local directory
 */
export interface ParsedSource {
  type: "github" | "local";
  /** For GitHub: the clone URL. For local: absolute path. */
  url: string;
  /** GitHub owner/repo slug (only for type: "github"). */
  ownerRepo?: string;
}

export function parseSkillSource(input: string): ParsedSource {
  // Local path
  if (input.startsWith("/") || input.startsWith("./") || input.startsWith("../") || input === ".") {
    return { type: "local", url: resolve(input) };
  }

  // Full GitHub URL
  const ghUrlMatch = input.match(/github\.com\/([^/]+\/[^/]+)/);
  if (ghUrlMatch) {
    const ownerRepo = ghUrlMatch[1].replace(/\.git$/, "");
    return {
      type: "github",
      url: `https://github.com/${ownerRepo}.git`,
      ownerRepo,
    };
  }

  // owner/repo shorthand
  if (/^[^/]+\/[^/]+$/.test(input)) {
    return {
      type: "github",
      url: `https://github.com/${input}.git`,
      ownerRepo: input,
    };
  }

  // Assume it's a git URL
  return { type: "github", url: input };
}

/**
 * Scan a directory tree for SKILL.md files.
 * Returns an array of skill directories (parent of each SKILL.md).
 *
 * Searches known skill locations per the skills.sh spec:
 *   - Root (if SKILL.md exists)
 *   - skills/, .agents/skills/, .claude/skills/, .polpo/skills/
 *   - Any other subdirectory with SKILL.md (recursive, max 3 levels)
 */
function findSkillDirsInRepo(repoDir: string): string[] {
  const found: string[] = [];

  // Check root
  if (existsSync(join(repoDir, "SKILL.md"))) {
    found.push(repoDir);
  }

  // Standard locations used by skills.sh repos
  const standardDirs = [
    "skills", ".agents/skills", ".claude/skills", ".polpo/skills",
  ];

  for (const rel of standardDirs) {
    const dir = join(repoDir, rel);
    if (!existsSync(dir)) continue;
    for (const skill of scanSubdirs(dir)) {
      found.push(skill);
    }
  }

  // If nothing found in standard locations, recurse up to 3 levels
  if (found.length === 0) {
    deepScan(repoDir, 0, 3, found);
  }

  return found;
}

/** Scan immediate subdirectories for SKILL.md */
function scanSubdirs(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const entryPath = resolve(dir, entry.name);
      if (existsSync(join(entryPath, "SKILL.md"))) {
        results.push(entryPath);
      }
    }
  } catch { /* skip */ }
  return results;
}

/** Recursive scan for SKILL.md up to maxDepth. */
function deepScan(dir: string, depth: number, maxDepth: number, results: string[]): void {
  if (depth > maxDepth) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".polpo" && entry.name !== ".agents") continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (!entry.isDirectory()) continue;
      const entryPath = resolve(dir, entry.name);
      if (existsSync(join(entryPath, "SKILL.md"))) {
        results.push(entryPath);
      } else {
        deepScan(entryPath, depth + 1, maxDepth, results);
      }
    }
  } catch { /* skip */ }
}

/** Minimal skill info extracted from a found SKILL.md during installation. */
export interface FoundSkill {
  /** Skill name (from frontmatter or directory name). */
  name: string;
  /** Description from frontmatter. */
  description: string;
  /** Absolute path to the skill directory. */
  path: string;
}

/** Read SKILL.md from a directory and extract metadata. */
function readFoundSkill(skillDir: string): FoundSkill | null {
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) return null;
  try {
    const raw = readFileSync(skillFile, "utf-8");
    const fm = parseSkillFrontmatter(raw);
    const dirName = basename(skillDir);
    return {
      name: fm?.name ?? dirName,
      description: fm?.description ?? "",
      path: skillDir,
    };
  } catch { return null; }
}

export interface InstallResult {
  /** Skills successfully installed. */
  installed: FoundSkill[];
  /** Skills skipped (already exist). */
  skipped: FoundSkill[];
  /** Errors encountered. */
  errors: string[];
}

/**
 * Install skills from a source (GitHub repo or local path) into the
 * project's .polpo/skills/ pool.
 *
 * @param source - GitHub owner/repo, full URL, or local path
 * @param polpoDir - The .polpo directory path
 * @param options.skillNames - Only install specific skill names (undefined = all)
 * @param options.global - Install to ~/.polpo/skills/ instead of project
 * @param options.force - Overwrite existing skills
 */
export function installSkills(
  source: string,
  polpoDir: string,
  options: {
    skillNames?: string[];
    global?: boolean;
    force?: boolean;
  } = {},
): InstallResult {
  const result: InstallResult = { installed: [], skipped: [], errors: [] };
  const parsed = parseSkillSource(source);

  let sourceDir: string;
  let clonedTmpDir: string | null = null;

  // Resolve source to a local directory
  if (parsed.type === "local") {
    if (!existsSync(parsed.url)) {
      result.errors.push(`Local path not found: ${parsed.url}`);
      return result;
    }
    sourceDir = parsed.url;
  } else {
    // Clone to tmp
    try {
      clonedTmpDir = join(tmpdir(), `polpo-skills-${Date.now()}`);
      execSync(`git clone --depth 1 --quiet "${parsed.url}" "${clonedTmpDir}"`, {
        stdio: "pipe",
        timeout: 60_000,
      });
      sourceDir = clonedTmpDir;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to clone ${parsed.url}: ${msg}`);
      return result;
    }
  }

  try {
    // Discover skills in source
    const skillDirs = findSkillDirsInRepo(sourceDir);
    const found: FoundSkill[] = [];
    for (const dir of skillDirs) {
      const skill = readFoundSkill(dir);
      if (skill) found.push(skill);
    }

    if (found.length === 0) {
      result.errors.push(`No skills found in ${source}`);
      return result;
    }

    // Filter by requested names
    const toInstall = options.skillNames
      ? found.filter(s => options.skillNames!.includes(s.name))
      : found;

    if (options.skillNames && toInstall.length === 0) {
      result.errors.push(
        `Requested skills not found: ${options.skillNames.join(", ")}. ` +
        `Available: ${found.map(s => s.name).join(", ")}`,
      );
      return result;
    }

    // Target directory
    const targetBase = options.global
      ? join(homedir(), ".polpo", "skills")
      : join(polpoDir, "skills");
    mkdirSync(targetBase, { recursive: true });

    // Install each skill
    for (const skill of toInstall) {
      const targetDir = join(targetBase, skill.name);

      if (existsSync(targetDir) && !options.force) {
        result.skipped.push(skill);
        continue;
      }

      try {
        // Remove existing if force
        if (existsSync(targetDir)) {
          rmSync(targetDir, { recursive: true, force: true });
        }
        // Copy skill directory
        cpSync(skill.path, targetDir, { recursive: true });
        result.installed.push(skill);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to install "${skill.name}": ${msg}`);
      }
    }
  } finally {
    // Cleanup cloned repo
    if (clonedTmpDir && existsSync(clonedTmpDir)) {
      try { rmSync(clonedTmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  return result;
}

/**
 * Remove a skill from the pool.
 * Returns true if removed, false if not found.
 */
export function removeSkill(polpoDir: string, name: string, global = false): boolean {
  const targetBase = global
    ? join(homedir(), ".polpo", "skills")
    : join(polpoDir, "skills");
  const targetDir = join(targetBase, name);

  if (!existsSync(targetDir)) return false;
  rmSync(targetDir, { recursive: true, force: true });
  return true;
}

/**
 * Create a new skill in the agent skill pool (.polpo/skills/).
 * Writes a SKILL.md with YAML frontmatter and markdown body.
 * Returns the absolute path to the created skill directory.
 */
export function createAgentSkill(
  polpoDir: string,
  name: string,
  description: string,
  content: string,
  options?: { allowedTools?: string[]; global?: boolean },
): string {
  const targetBase = options?.global
    ? join(homedir(), ".polpo", "skills")
    : join(polpoDir, "skills");
  const targetDir = join(targetBase, name);
  mkdirSync(targetDir, { recursive: true });

  const fmLines = [`---`, `name: ${name}`, `description: ${description}`];
  if (options?.allowedTools?.length) {
    fmLines.push(`allowed-tools:`);
    for (const t of options.allowedTools) fmLines.push(`  - ${t}`);
  }
  fmLines.push(`---`, ``);

  const skillMd = fmLines.join("\n") + content;
  writeFileSync(join(targetDir, "SKILL.md"), skillMd, "utf-8");
  return targetDir;
}

/**
 * List skills installed in the pool with their per-agent assignments.
 */
export interface SkillWithAssignment extends SkillInfo {
  /** Agents that have this skill assigned (via symlinks or config). */
  assignedTo: string[];
}

export function listSkillsWithAssignments(cwd: string, polpoDir: string, agentNames: string[]): SkillWithAssignment[] {
  const pool = discoverSkills(cwd, polpoDir);
  const result: SkillWithAssignment[] = [];

  for (const skill of pool) {
    const assignedTo: string[] = [];

    for (const agentName of agentNames) {
      const agentSkillsDir = resolve(polpoDir, "agents", agentName, "skills");
      if (!existsSync(agentSkillsDir)) continue;

      // Check if this agent has this skill via symlink
      const linkPath = resolve(agentSkillsDir, skill.name);
      if (existsSync(linkPath)) {
        assignedTo.push(agentName);
      }
    }

    result.push({ ...skill, assignedTo });
  }

  return result;
}

// ═══════════════════════════════════════════════════════
//  ORCHESTRATOR SKILLS — separate pool in .polpo/.agent/skills/
// ═══════════════════════════════════════════════════════

/** The subdirectory name for the orchestrator's own config/skills. */
const ORCHESTRATOR_AGENT_DIR = ".agent";

/**
 * Discover skills available to the orchestrator.
 *
 * Search order:
 *   1. <polpoDir>/.agent/skills/   — project-level orchestrator skills
 *   2. ~/.polpo/.agent/skills/     — global orchestrator skills
 */
export function discoverOrchestratorSkills(polpoDir: string): SkillInfo[] {
  const seen = new Set<string>();
  const all: SkillInfo[] = [];

  const dirs: Array<{ dir: string; source: SkillInfo["source"] }> = [
    { dir: resolve(polpoDir, ORCHESTRATOR_AGENT_DIR, "skills"), source: "project" },
    { dir: resolve(homedir(), ".polpo", ORCHESTRATOR_AGENT_DIR, "skills"), source: "global" },
  ];

  for (const { dir, source } of dirs) {
    for (const skill of scanSkillsDir(dir, source)) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        all.push(skill);
      }
    }
  }

  return all;
}

/**
 * Load orchestrator skills by name from the orchestrator pool.
 *
 * If `skillNames` is provided, only those skills are loaded.
 * If omitted or empty, ALL discovered orchestrator skills are loaded.
 */
export function loadOrchestratorSkills(
  polpoDir: string,
  skillNames?: string[],
): LoadedSkill[] {
  const pool = discoverOrchestratorSkills(polpoDir);

  // If no filter, load everything in the pool
  const toLoad = skillNames && skillNames.length > 0
    ? pool.filter(s => skillNames.includes(s.name))
    : pool;

  return toLoad
    .map(s => loadSkillContent(s))
    .filter((s): s is LoadedSkill => s !== null);
}

/**
 * Install skills into the orchestrator's pool (.polpo/.agent/skills/).
 *
 * Same mechanics as `installSkills()` but targets the orchestrator directory.
 */
export function installOrchestratorSkills(
  source: string,
  polpoDir: string,
  options: {
    skillNames?: string[];
    global?: boolean;
    force?: boolean;
  } = {},
): InstallResult {
  const result: InstallResult = { installed: [], skipped: [], errors: [] };
  const parsed = parseSkillSource(source);

  let sourceDir: string;
  let clonedTmpDir: string | null = null;

  if (parsed.type === "local") {
    if (!existsSync(parsed.url)) {
      result.errors.push(`Local path not found: ${parsed.url}`);
      return result;
    }
    sourceDir = parsed.url;
  } else {
    try {
      clonedTmpDir = join(tmpdir(), `polpo-orch-skills-${Date.now()}`);
      execSync(`git clone --depth 1 --quiet "${parsed.url}" "${clonedTmpDir}"`, {
        stdio: "pipe",
        timeout: 60_000,
      });
      sourceDir = clonedTmpDir;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to clone ${parsed.url}: ${msg}`);
      return result;
    }
  }

  try {
    const skillDirs = findSkillDirsInRepo(sourceDir);
    const found: FoundSkill[] = [];
    for (const dir of skillDirs) {
      const skill = readFoundSkill(dir);
      if (skill) found.push(skill);
    }

    if (found.length === 0) {
      result.errors.push(`No skills found in ${source}`);
      return result;
    }

    const toInstall = options.skillNames
      ? found.filter(s => options.skillNames!.includes(s.name))
      : found;

    if (options.skillNames && toInstall.length === 0) {
      result.errors.push(
        `Requested skills not found: ${options.skillNames.join(", ")}. ` +
        `Available: ${found.map(s => s.name).join(", ")}`,
      );
      return result;
    }

    const targetBase = options.global
      ? join(homedir(), ".polpo", ORCHESTRATOR_AGENT_DIR, "skills")
      : join(polpoDir, ORCHESTRATOR_AGENT_DIR, "skills");
    mkdirSync(targetBase, { recursive: true });

    for (const skill of toInstall) {
      const targetDir = join(targetBase, skill.name);

      if (existsSync(targetDir) && !options.force) {
        result.skipped.push(skill);
        continue;
      }

      try {
        if (existsSync(targetDir)) {
          rmSync(targetDir, { recursive: true, force: true });
        }
        cpSync(skill.path, targetDir, { recursive: true });
        result.installed.push(skill);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to install "${skill.name}": ${msg}`);
      }
    }
  } finally {
    if (clonedTmpDir && existsSync(clonedTmpDir)) {
      try { rmSync(clonedTmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  return result;
}

/**
 * Remove a skill from the orchestrator's pool.
 * Returns true if removed, false if not found.
 */
export function removeOrchestratorSkill(polpoDir: string, name: string, global = false): boolean {
  const targetBase = global
    ? join(homedir(), ".polpo", ORCHESTRATOR_AGENT_DIR, "skills")
    : join(polpoDir, ORCHESTRATOR_AGENT_DIR, "skills");
  const targetDir = join(targetBase, name);

  if (!existsSync(targetDir)) return false;
  rmSync(targetDir, { recursive: true, force: true });
  return true;
}

/**
 * Create a new skill in the orchestrator's pool by writing a SKILL.md file.
 * Returns the absolute path to the created skill directory.
 */
export function createOrchestratorSkill(
  polpoDir: string,
  name: string,
  description: string,
  content: string,
  options?: { allowedTools?: string[]; global?: boolean },
): string {
  const targetBase = options?.global
    ? join(homedir(), ".polpo", ORCHESTRATOR_AGENT_DIR, "skills")
    : join(polpoDir, ORCHESTRATOR_AGENT_DIR, "skills");
  const targetDir = join(targetBase, name);
  mkdirSync(targetDir, { recursive: true });

  const fmLines = [`---`, `name: ${name}`, `description: ${description}`];
  if (options?.allowedTools?.length) {
    fmLines.push(`allowed-tools:`);
    for (const t of options.allowedTools) fmLines.push(`  - ${t}`);
  }
  fmLines.push(`---`, ``);

  const skillMd = fmLines.join("\n") + content;
  writeFileSync(join(targetDir, "SKILL.md"), skillMd, "utf-8");
  return targetDir;
}

/**
 * Update an existing skill in the orchestrator's pool.
 * Only provided fields are changed. Returns true if updated, false if not found.
 */
export function updateOrchestratorSkill(
  polpoDir: string,
  name: string,
  updates: { description?: string; content?: string; allowedTools?: string[] },
  global = false,
): boolean {
  const targetBase = global
    ? join(homedir(), ".polpo", ORCHESTRATOR_AGENT_DIR, "skills")
    : join(polpoDir, ORCHESTRATOR_AGENT_DIR, "skills");
  const skillFile = join(targetBase, name, "SKILL.md");

  if (!existsSync(skillFile)) return false;

  const raw = readFileSync(skillFile, "utf-8");
  const fm = parseSkillFrontmatter(raw);
  const oldBody = extractBody(raw);

  const newDesc = updates.description ?? fm?.description ?? "";
  const newTools = updates.allowedTools ?? fm?.allowedTools;
  const newBody = updates.content ?? oldBody;

  const fmLines = [`---`, `name: ${name}`, `description: ${newDesc}`];
  if (newTools?.length) {
    fmLines.push(`allowed-tools:`);
    for (const t of newTools) fmLines.push(`  - ${t}`);
  }
  fmLines.push(`---`, ``);

  writeFileSync(skillFile, fmLines.join("\n") + newBody, "utf-8");
  return true;
}
