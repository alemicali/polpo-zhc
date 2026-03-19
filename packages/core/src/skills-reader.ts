/**
 * Skills reader — pure functions for discovering and loading skills.
 *
 * Uses FileSystem abstraction so it works on any backend:
 *   - NodeFileSystem (self-hosted)
 *   - SandboxProxyFS (cloud, lazy)
 *
 * Write operations (install, remove, create, assign) stay in the shell
 * because they use git clone, symlinks, and other Node-specific ops.
 */

import { resolve, join } from "node:path";
import type { FileSystem } from "./filesystem.js";

// ── Types ──

export interface SkillInfo {
  name: string;
  description: string;
  allowedTools?: string[];
  source: "project" | "global";
  path: string;
  tags?: string[];
  category?: string;
}

export interface LoadedSkill extends SkillInfo {
  content: string;
}

export interface SkillIndexEntry {
  tags?: string[];
  category?: string;
}

export type SkillIndex = Record<string, SkillIndexEntry>;

export interface SkillWithAssignment extends SkillInfo {
  assignedTo: string[];
}

// ── Parsing (pure, no FS) ──

/**
 * Parse SKILL.md YAML frontmatter.
 * Inlined minimal YAML parser for the simple key:value frontmatter format.
 */
export function parseSkillFrontmatter(content: string): { name?: string; description: string; allowedTools?: string[] } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    // Simple YAML-like parsing for flat frontmatter (no nested objects)
    const lines = match[1].split("\n");
    const fm: Record<string, unknown> = {};
    let currentArray: string[] | null = null;
    let currentKey: string | null = null;

    for (const line of lines) {
      const arrayItemMatch = line.match(/^\s+-\s+(.+)/);
      if (arrayItemMatch && currentKey) {
        if (!currentArray) currentArray = [];
        currentArray.push(arrayItemMatch[1].trim());
        fm[currentKey] = currentArray;
        continue;
      }

      if (currentArray) {
        currentArray = null;
        currentKey = null;
      }

      const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.+)?/);
      if (kvMatch) {
        currentKey = kvMatch[1] === "allowed-tools" ? "allowedTools" : kvMatch[1];
        const val = kvMatch[2]?.trim();
        if (val) {
          fm[currentKey] = val;
        }
      }
    }

    if (!fm.name && !fm.description) return null;
    return {
      name: fm.name as string | undefined,
      description: (fm.description as string) ?? "",
      allowedTools: fm.allowedTools as string[] | undefined,
    };
  } catch { return null; }
}

/** Extract the markdown body (everything after the frontmatter block). */
export function extractSkillBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

// ── Build prompt (pure, no FS) ──

/**
 * Build the skill injection block for an agent's system prompt.
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
    parts.push("");
  }

  return parts.join("\n");
}

// ── Discovery (async, uses FileSystem) ──

/** Scan a single skills directory and return discovered skills. */
async function scanSkillsDir(fs: FileSystem, dir: string, source: SkillInfo["source"]): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  if (!(await fs.exists(dir))) return skills;

  try {
    const entries = fs.readdirWithTypes
      ? await fs.readdirWithTypes(dir)
      : (await fs.readdir(dir)).map((n) => ({ name: n, isDirectory: true, isFile: false }));

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const entryPath = resolve(dir, entry.name);
      const skillPath = resolve(entryPath, "SKILL.md");
      if (!(await fs.exists(skillPath))) continue;

      try {
        const raw = await fs.readFile(skillPath);
        const fm = parseSkillFrontmatter(raw);
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
 * Discover ALL available skills from the project's .polpo/skills/ directory.
 * Cloud version — no global ~/.polpo/ (not available in sandbox).
 */
export async function discoverSkills(
  fs: FileSystem,
  polpoDir: string,
  globalPolpoDir?: string,
): Promise<SkillInfo[]> {
  const seen = new Set<string>();
  const all: SkillInfo[] = [];

  const dirs: Array<{ dir: string; source: SkillInfo["source"] }> = [
    { dir: resolve(polpoDir, "skills"), source: "project" },
  ];
  if (globalPolpoDir) {
    dirs.push({ dir: resolve(globalPolpoDir, "skills"), source: "global" });
  }

  for (const { dir, source } of dirs) {
    for (const skill of await scanSkillsDir(fs, dir, source)) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        all.push(skill);
      }
    }
  }

  // Enrich with index metadata
  const index = await loadSkillIndex(fs, polpoDir);
  if (index) {
    for (const skill of all) {
      const entry = index[skill.name];
      if (entry) {
        if (entry.tags) skill.tags = entry.tags;
        if (entry.category) skill.category = entry.category;
      }
    }
  }

  return all;
}

/** Load skills-index.json from polpoDir. */
async function loadSkillIndex(fs: FileSystem, polpoDir: string): Promise<SkillIndex | null> {
  const indexPath = join(polpoDir, "skills-index.json");
  if (!(await fs.exists(indexPath))) return null;
  try {
    const raw = await fs.readFile(indexPath);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as SkillIndex;
  } catch { return null; }
}

// ── Per-agent loading ──

/** Load a single skill's content. */
async function loadSkillContent(fs: FileSystem, info: SkillInfo): Promise<LoadedSkill | null> {
  const skillPath = resolve(info.path, "SKILL.md");
  try {
    const raw = await fs.readFile(skillPath);
    return { ...info, content: extractSkillBody(raw) };
  } catch { return null; }
}

/**
 * Load the skills assigned to a specific agent.
 *
 * Priority:
 *   1. .polpo/agents/<agentName>/skills/ directory
 *   2. AgentConfig.skills[] names resolved against the pool
 */
export async function loadAgentSkills(
  fs: FileSystem,
  polpoDir: string,
  agentName: string,
  configSkillNames?: string[],
  globalPolpoDir?: string,
): Promise<LoadedSkill[]> {
  const agentSkillsDir = resolve(polpoDir, "agents", agentName, "skills");

  // Strategy 1: agent has a skills dir
  if (await fs.exists(agentSkillsDir)) {
    const skills = await scanSkillsDir(fs, agentSkillsDir, "project");
    const loaded = await Promise.all(skills.map((s) => loadSkillContent(fs, s)));
    return loaded.filter((s): s is LoadedSkill => s !== null);
  }

  // Strategy 2: resolve config skill names against the pool
  if (configSkillNames && configSkillNames.length > 0) {
    const pool = await discoverSkills(fs, polpoDir, globalPolpoDir);
    const poolMap = new Map(pool.map((s) => [s.name, s]));
    const loaded: LoadedSkill[] = [];
    for (const name of configSkillNames) {
      const info = poolMap.get(name);
      if (info) {
        const skill = await loadSkillContent(fs, info);
        if (skill) loaded.push(skill);
      }
    }
    return loaded;
  }

  return [];
}

/**
 * List skills with their per-agent assignments.
 */
export async function listSkillsWithAssignments(
  fs: FileSystem,
  polpoDir: string,
  agentNames: string[],
  agentConfigSkills?: Map<string, string[]>,
  globalPolpoDir?: string,
): Promise<SkillWithAssignment[]> {
  const pool = await discoverSkills(fs, polpoDir, globalPolpoDir);
  const result: SkillWithAssignment[] = [];

  for (const skill of pool) {
    const assignedTo = new Set<string>();

    for (const agentName of agentNames) {
      // Strategy 1: check skills dir
      const linkPath = resolve(polpoDir, "agents", agentName, "skills", skill.name);
      if (await fs.exists(linkPath)) {
        assignedTo.add(agentName);
        continue;
      }

      // Strategy 2: check config
      const configSkills = agentConfigSkills?.get(agentName);
      if (configSkills?.includes(skill.name)) {
        assignedTo.add(agentName);
      }
    }

    result.push({ ...skill, assignedTo: [...assignedTo] });
  }

  return result;
}
