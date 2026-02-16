/**
 * Polpo Skills System
 *
 * Skills are markdown files (SKILL.md) with YAML frontmatter that provide
 * specialized knowledge and workflows to agents. They are loaded as additional
 * system prompt context at spawn time.
 *
 * Filesystem layout:
 *
 *   .polpo/skills/               ← project skill pool
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
 * Discovery also scans paths from the skills.sh ecosystem for cross-agent
 * compatibility:
 *
 *   Project-level:
 *     .agents/skills/             ← OpenCode, Codex, Gemini CLI, Copilot, Amp
 *     .claude/skills/             ← Claude Code
 *
 *   User-level:
 *     ~/.polpo/skills/            ← Polpo global
 *     ~/.config/opencode/skills/  ← OpenCode global
 *     ~/.config/agents/skills/    ← shared agents global (Amp, Codex, Gemini)
 *     ~/.claude/skills/           ← Claude Code global
 *
 * Assignment priority:
 *   1. .polpo/agents/<name>/skills/ (symlinks → hard enforcement)
 *   2. AgentConfig.skills[] names resolved against the pool (soft/config-based)
 */

import { resolve, basename } from "node:path";
import { readFileSync, readdirSync, existsSync, lstatSync, realpathSync, mkdirSync, symlinkSync } from "node:fs";
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
  source: "polpo" | "agents" | "claude" | "home";
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
 * Returns deduplicated list (first occurrence wins).
 *
 * Search order:
 *   1. .polpo/skills/ (project pool — highest priority)
 *   2. .claude/skills/ (project-local Claude skills)
 *   3. ~/.claude/skills/ (user-level Claude skills)
 */
export function discoverSkills(cwd: string, polpoDir?: string): SkillInfo[] {
  const seen = new Set<string>();
  const all: SkillInfo[] = [];

  const dirs: Array<{ dir: string; source: SkillInfo["source"] }> = [
    { dir: resolve(polpoDir ?? resolve(cwd, ".polpo"), "skills"), source: "polpo" },
    { dir: resolve(cwd, ".claude", "skills"), source: "claude" },
    { dir: resolve(process.env.HOME ?? "", ".claude", "skills"), source: "home" },
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
    const skills = scanSkillsDir(agentSkillsDir, "polpo");
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
function loadSkillContent(info: SkillInfo): LoadedSkill | null {
  const skillPath = resolve(info.path, "SKILL.md");
  try {
    const raw = readFileSync(skillPath, "utf-8");
    return {
      ...info,
      content: extractBody(raw),
    };
  } catch { return null; }
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
