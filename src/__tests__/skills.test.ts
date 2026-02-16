import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import {
  discoverSkills,
  parseSkillFrontmatter,
  loadAgentSkills,
  assignSkillToAgent,
  removeSkill,
  installSkills,
  parseSkillSource,
  listSkillsWithAssignments,
} from "../llm/skills.js";

const TMP = "/tmp/polpo-skills-test";
const POLPO_DIR = join(TMP, ".polpo");
const SKILLS_DIR = join(POLPO_DIR, "skills");

function writeSkill(name: string, content: string): void {
  const dir = join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

const SKILL_WITH_NAME = `---
name: typescript-patterns
description: TypeScript best practices
allowedTools:
  - read
  - write
---

## TypeScript Patterns

Use const by default.
`;

const SKILL_WITHOUT_NAME = `---
description: React component patterns
---

## React Patterns

Use functional components.
`;

const SKILL_MINIMAL = `---
name: minimal
description: Minimal skill
---

Do things.
`;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(SKILLS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ── parseSkillFrontmatter ──────────────────────────────────────────────

describe("parseSkillFrontmatter", () => {
  it("parses full frontmatter with name and description", () => {
    const result = parseSkillFrontmatter(SKILL_WITH_NAME);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("typescript-patterns");
    expect(result!.description).toBe("TypeScript best practices");
    expect(result!.allowedTools).toEqual(["read", "write"]);
  });

  it("parses frontmatter without name (name is optional)", () => {
    const result = parseSkillFrontmatter(SKILL_WITHOUT_NAME);
    expect(result).not.toBeNull();
    expect(result!.name).toBeUndefined();
    expect(result!.description).toBe("React component patterns");
  });

  it("returns null for content without frontmatter", () => {
    const result = parseSkillFrontmatter("Just some markdown content");
    expect(result).toBeNull();
  });

  it("returns null for empty frontmatter", () => {
    const result = parseSkillFrontmatter("---\n---\nContent");
    expect(result).toBeNull();
  });

  it("supports allowedTools with dash format", () => {
    const content = `---
name: test
description: test
allowed-tools:
  - read
  - glob
---
Content`;
    const result = parseSkillFrontmatter(content);
    expect(result!.allowedTools).toEqual(["read", "glob"]);
  });

  it("supports allowedTools with camelCase format", () => {
    const content = `---
name: test
description: test
allowedTools:
  - edit
---
Content`;
    const result = parseSkillFrontmatter(content);
    expect(result!.allowedTools).toEqual(["edit"]);
  });
});

// ── discoverSkills ─────────────────────────────────────────────────────

describe("discoverSkills", () => {
  it("discovers skills from .polpo/skills/", () => {
    writeSkill("ts-patterns", SKILL_WITH_NAME);
    writeSkill("react-patterns", SKILL_WITHOUT_NAME);

    const skills = discoverSkills(TMP, POLPO_DIR);
    expect(skills).toHaveLength(2);

    const tsSkill = skills.find(s => s.name === "typescript-patterns");
    expect(tsSkill).toBeDefined();
    expect(tsSkill!.source).toBe("project");

    // Without name in frontmatter, falls back to directory name
    const reactSkill = skills.find(s => s.name === "react-patterns");
    expect(reactSkill).toBeDefined();
    expect(reactSkill!.description).toBe("React component patterns");
  });

  it("returns empty array when no skills exist", () => {
    const skills = discoverSkills(TMP, POLPO_DIR);
    expect(skills).toHaveLength(0);
  });

  it("skips directories without SKILL.md", () => {
    mkdirSync(join(SKILLS_DIR, "empty-dir"), { recursive: true });
    writeSkill("valid", SKILL_MINIMAL);

    const skills = discoverSkills(TMP, POLPO_DIR);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("minimal");
  });

  it("deduplicates by name (first wins)", () => {
    // Create two skills with same frontmatter name in different dirs
    writeSkill("dir-one", SKILL_MINIMAL);
    writeSkill("dir-two", SKILL_MINIMAL); // same name: "minimal"

    const skills = discoverSkills(TMP, POLPO_DIR);
    // Only one should survive deduplication
    expect(skills.filter(s => s.name === "minimal")).toHaveLength(1);
  });
});

// ── loadAgentSkills ────────────────────────────────────────────────────

describe("loadAgentSkills", () => {
  it("loads skills via config names from the pool", () => {
    writeSkill("ts-patterns", SKILL_WITH_NAME);
    writeSkill("react-patterns", SKILL_WITHOUT_NAME);

    const loaded = loadAgentSkills(TMP, POLPO_DIR, "dev-1", ["typescript-patterns"]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("typescript-patterns");
    expect(loaded[0].content).toContain("Use const by default");
  });

  it("returns empty when agent has no skills", () => {
    writeSkill("ts-patterns", SKILL_WITH_NAME);
    const loaded = loadAgentSkills(TMP, POLPO_DIR, "dev-1");
    expect(loaded).toHaveLength(0);
  });

  it("loads skills from agent symlink directory", () => {
    writeSkill("ts-patterns", SKILL_WITH_NAME);

    // Create agent skill dir with symlink
    const agentSkillsDir = join(POLPO_DIR, "agents", "dev-1", "skills");
    mkdirSync(agentSkillsDir, { recursive: true });
    const { symlinkSync } = require("node:fs");
    symlinkSync(join(SKILLS_DIR, "ts-patterns"), join(agentSkillsDir, "ts-patterns"));

    const loaded = loadAgentSkills(TMP, POLPO_DIR, "dev-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("typescript-patterns");
  });
});

// ── assignSkillToAgent ─────────────────────────────────────────────────

describe("assignSkillToAgent", () => {
  it("creates symlink from agent to skill", () => {
    writeSkill("ts-patterns", SKILL_WITH_NAME);

    assignSkillToAgent(POLPO_DIR, "dev-1", "ts-patterns", join(SKILLS_DIR, "ts-patterns"));

    const linkPath = join(POLPO_DIR, "agents", "dev-1", "skills", "ts-patterns");
    expect(existsSync(linkPath)).toBe(true);
  });

  it("does not overwrite existing symlink", () => {
    writeSkill("ts-patterns", SKILL_WITH_NAME);

    assignSkillToAgent(POLPO_DIR, "dev-1", "ts-patterns", join(SKILLS_DIR, "ts-patterns"));
    // Call again — should not throw
    assignSkillToAgent(POLPO_DIR, "dev-1", "ts-patterns", join(SKILLS_DIR, "ts-patterns"));

    const linkPath = join(POLPO_DIR, "agents", "dev-1", "skills", "ts-patterns");
    expect(existsSync(linkPath)).toBe(true);
  });
});

// ── removeSkill ────────────────────────────────────────────────────────

describe("removeSkill", () => {
  it("removes an existing skill", () => {
    writeSkill("ts-patterns", SKILL_WITH_NAME);
    expect(existsSync(join(SKILLS_DIR, "ts-patterns"))).toBe(true);

    const removed = removeSkill(POLPO_DIR, "ts-patterns");
    expect(removed).toBe(true);
    expect(existsSync(join(SKILLS_DIR, "ts-patterns"))).toBe(false);
  });

  it("returns false for non-existent skill", () => {
    const removed = removeSkill(POLPO_DIR, "nonexistent");
    expect(removed).toBe(false);
  });
});

// ── parseSkillSource ───────────────────────────────────────────────────

describe("parseSkillSource", () => {
  it("parses owner/repo shorthand", () => {
    const parsed = parseSkillSource("vercel-labs/agent-skills");
    expect(parsed.type).toBe("github");
    expect(parsed.url).toBe("https://github.com/vercel-labs/agent-skills.git");
    expect(parsed.ownerRepo).toBe("vercel-labs/agent-skills");
  });

  it("parses full GitHub URL", () => {
    const parsed = parseSkillSource("https://github.com/anthropics/skills");
    expect(parsed.type).toBe("github");
    expect(parsed.ownerRepo).toBe("anthropics/skills");
  });

  it("parses local path", () => {
    const parsed = parseSkillSource("./my-skills");
    expect(parsed.type).toBe("local");
  });

  it("parses absolute path", () => {
    const parsed = parseSkillSource("/home/user/skills");
    expect(parsed.type).toBe("local");
    expect(parsed.url).toBe("/home/user/skills");
  });
});

// ── installSkills (local) ──────────────────────────────────────────────

describe("installSkills (local source)", () => {
  const LOCAL_SOURCE = join(TMP, "source-repo");

  beforeEach(() => {
    // Create a mock repo with skills
    const skillDir = join(LOCAL_SOURCE, "skills", "mock-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---
name: mock-skill
description: A mock skill for testing
---

Mock instructions.
`);

    const skillDir2 = join(LOCAL_SOURCE, "skills", "another-skill");
    mkdirSync(skillDir2, { recursive: true });
    writeFileSync(join(skillDir2, "SKILL.md"), `---
name: another-skill
description: Another mock skill
---

More instructions.
`);
  });

  it("installs skills from a local directory", () => {
    const result = installSkills(LOCAL_SOURCE, POLPO_DIR);
    expect(result.errors).toHaveLength(0);
    expect(result.installed).toHaveLength(2);
    expect(result.installed.map(s => s.name).sort()).toEqual(["another-skill", "mock-skill"]);

    // Verify files exist in .polpo/skills/
    expect(existsSync(join(SKILLS_DIR, "mock-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(SKILLS_DIR, "another-skill", "SKILL.md"))).toBe(true);
  });

  it("installs only specific skills when names provided", () => {
    const result = installSkills(LOCAL_SOURCE, POLPO_DIR, {
      skillNames: ["mock-skill"],
    });
    expect(result.installed).toHaveLength(1);
    expect(result.installed[0].name).toBe("mock-skill");
    expect(existsSync(join(SKILLS_DIR, "another-skill"))).toBe(false);
  });

  it("skips already installed skills", () => {
    // Pre-install
    installSkills(LOCAL_SOURCE, POLPO_DIR);

    // Try again
    const result = installSkills(LOCAL_SOURCE, POLPO_DIR);
    expect(result.installed).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
  });

  it("overwrites with force flag", () => {
    installSkills(LOCAL_SOURCE, POLPO_DIR);

    const result = installSkills(LOCAL_SOURCE, POLPO_DIR, { force: true });
    expect(result.installed).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  it("reports error for nonexistent local path", () => {
    const result = installSkills("/nonexistent/path", POLPO_DIR);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Local path not found");
  });

  it("reports error when requested skill names not found", () => {
    const result = installSkills(LOCAL_SOURCE, POLPO_DIR, {
      skillNames: ["nonexistent"],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Requested skills not found");
  });
});

// ── listSkillsWithAssignments ──────────────────────────────────────────

describe("listSkillsWithAssignments", () => {
  it("lists skills with agent assignments", () => {
    writeSkill("ts-patterns", SKILL_WITH_NAME);
    writeSkill("react-patterns", SKILL_WITHOUT_NAME);

    // Assign ts-patterns to dev-1 (using the frontmatter name, as the CLI does)
    assignSkillToAgent(POLPO_DIR, "dev-1", "typescript-patterns", join(SKILLS_DIR, "ts-patterns"));

    const result = listSkillsWithAssignments(TMP, POLPO_DIR, ["dev-1", "dev-2"]);
    expect(result).toHaveLength(2);

    const tsSkill = result.find(s => s.name === "typescript-patterns");
    expect(tsSkill!.assignedTo).toEqual(["dev-1"]);

    const reactSkill = result.find(s => s.name === "react-patterns");
    expect(reactSkill!.assignedTo).toEqual([]);
  });

  it("returns empty assignments when no agents exist", () => {
    writeSkill("ts-patterns", SKILL_WITH_NAME);

    const result = listSkillsWithAssignments(TMP, POLPO_DIR, []);
    expect(result).toHaveLength(1);
    expect(result[0].assignedTo).toEqual([]);
  });
});
