/**
 * Skill discovery: scan .claude/skills/ for available SKILL.md files.
 */

import { resolve } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface SkillInfo {
  name: string;
  description: string;
  allowedTools?: string[];
}

/** Scan .claude/skills/ directories for available SKILL.md files */
export function discoverSkills(cwd: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const dirs = [
    resolve(cwd, ".claude", "skills"),
    resolve(process.env.HOME ?? "", ".claude", "skills"),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillPath = resolve(dir, entry.name, "SKILL.md");
        if (!existsSync(skillPath)) continue;

        try {
          const content = readFileSync(skillPath, "utf-8");
          const info = parseSkillFrontmatter(content);
          if (info && !skills.find(s => s.name === info.name)) {
            skills.push(info);
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable dirs */ }
  }
  return skills;
}

/** Parse SKILL.md YAML frontmatter */
export function parseSkillFrontmatter(content: string): SkillInfo | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const fm = parseYaml(match[1]);
    if (!fm?.name) return null;
    return {
      name: fm.name,
      description: fm.description ?? "",
      allowedTools: fm["allowed-tools"],
    };
  } catch { return null; }
}
