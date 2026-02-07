import { resolve } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// ─── Notes & Logo ────────────────────────────────────────

export const NOTES = ["♩", "♪", "♫", "♬"];

export const LOGO_LINES = [
  "    ♪  ╔═══════════════════════════════════╗  ♪",
  "   ♫  ║                                   ║  ♫",
  "       ║   ♩ O R C H E S T R A ♩          ║",
  "       ║                                   ║",
  "       ║   AI Agent Orchestration Framework ║",
  "   ♫  ║                                   ║  ♫",
  "    ♪  ╚═══════════════════════════════════╝  ♪",
];

// ─── Provider & Model Options ────────────────────────────

export interface ProviderOption {
  label: string;
  value: string;
  available: boolean;
}

export const PROVIDERS: ProviderOption[] = [
  { label: "Claude Code", value: "claude-sdk", available: true },
  { label: "OpenCode", value: "opencode", available: false },
  { label: "OpenClaw", value: "openclaw", available: false },
  { label: "AI SDK Vercel", value: "ai-sdk-vercel", available: false },
];

export interface ModelOption {
  label: string;
  value: string;
  adapter: string;
}

export const MODELS: ModelOption[] = [
  { label: "Claude Sonnet 4.5", value: "claude-sonnet-4-5-20250929", adapter: "claude-sdk" },
  { label: "Claude Opus 4.6", value: "claude-opus-4-6", adapter: "claude-sdk" },
  { label: "Claude Haiku 4.5", value: "claude-haiku-4-5-20251001", adapter: "claude-sdk" },
];

// ─── Slash Commands & Shortcuts ──────────────────────────

export const SLASH_COMMANDS: Record<string, string> = {
  "/status": "Detailed task status",
  "/result": "Show last task result",
  "/inspect": "Browse tasks & plans",
  "/edit-plan": "Edit a running plan",
  "/reassess": "Re-run assessment on task",
  "/team": "Show / manage team",
  "/abort": "Abort running plan/task",
  "/clear-tasks": "Clear finished tasks",
  "/tasks": "Browse tasks & plans",
  "/clear": "Clear log",
  "/config": "Show configuration",
  "/help": "Commands & shortcuts",
  "/quit": "Exit Orchestra",
};

export const SHORTCUTS: Record<string, string> = {
  "Alt+T": "Toggle Direct/Plan mode",
  "Ctrl+O": "Toggle task panel",
  "Ctrl+L": "Toggle verbose log",
  "Ctrl+C": "Quit",
  "Enter": "Submit",
  "Escape": "Clear input",
};

// ─── Skill Discovery ─────────────────────────────────────

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
