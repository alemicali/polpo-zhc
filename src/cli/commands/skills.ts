/**
 * CLI skill subcommands — add, list, remove, assign, tag.
 *
 * `polpo skills add <source>`    — Install skills from GitHub repo or local path
 * `polpo skills list`            — List skills in the pool with agent assignments
 * `polpo skills remove <name>`   — Remove a skill from the pool
 * `polpo skills assign <skill> <agent>` — Assign a skill to an agent
 * `polpo skills tag <skill>`     — Set tags and/or category for a skill
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import {
  discoverSkills,
  installSkills,
  removeSkill,
  assignSkillToAgent,
  listSkillsWithAssignments,
  discoverOrchestratorSkills,
  installOrchestratorSkills,
  removeOrchestratorSkill,
  updateSkillIndex,
  loadSkillIndex,
} from "../../llm/skills.js";
import type { AgentConfig } from "../../core/types.js";
import { FileAgentStore } from "../../stores/file-agent-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPolpoDir(dir: string): string {
  return resolve(dir, ".polpo");
}

function getAgentNames(polpoDir: string): string[] {
  const agentsDir = resolve(polpoDir, "agents");
  if (!existsSync(agentsDir)) return [];
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSkillsCommands(program: Command): void {
  const sk = program
    .command("skills")
    .description("Manage the skill pool — install, list, remove, assign");

  // ---- skills add <source> -----------------------------------------------
  sk
    .command("add <source>")
    .description("Install skills from a GitHub repo or local path")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-s, --skill <names...>", "Install only specific skill names")
    .option("-g, --global", "Install to ~/.polpo/skills/ (shared across projects)", false)
    .option("-f, --force", "Overwrite existing skills", false)
    .action((source: string, opts) => {
      try {
        const polpoDir = getPolpoDir(opts.dir);
        const scope = opts.global ? "global" : "project";

        console.log(chalk.dim(`  Installing skills from ${source} (${scope})...`));
        console.log();

        const result = installSkills(source, polpoDir, {
          skillNames: opts.skill,
          global: opts.global,
          force: opts.force,
        });

        // Report installed
        for (const skill of result.installed) {
          console.log(chalk.green(`  ✓ ${skill.name}`) + chalk.dim(` — ${skill.description || "no description"}`));
        }

        // Report skipped
        for (const skill of result.skipped) {
          console.log(chalk.yellow(`  ⊘ ${skill.name}`) + chalk.dim(" (already installed, use --force to overwrite)"));
        }

        // Report errors
        for (const err of result.errors) {
          console.error(chalk.red(`  ✗ ${err}`));
        }

        // Summary
        console.log();
        if (result.installed.length > 0) {
          console.log(chalk.green(`  ${result.installed.length} skill(s) installed.`));
          console.log(chalk.dim(`  Assign to agents with: polpo skills assign <skill> <agent>`));
        }
        if (result.errors.length > 0 && result.installed.length === 0) {
          process.exit(1);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- skills list -------------------------------------------------------
  sk
    .command("list")
    .alias("ls")
    .description("List skills in the pool with agent assignments")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (opts) => {
      try {
        const cwd = resolve(opts.dir);
        const polpoDir = getPolpoDir(opts.dir);

        // Merge agent names from filesystem AND AgentStore
        const fsAgentNames = getAgentNames(polpoDir);
        const agentStore = new FileAgentStore(polpoDir);
        const storeAgents = await agentStore.getAgents();
        const storeAgentNames = storeAgents.map(a => a.name);

        // Deduplicated agent names
        const agentNames = [...new Set([...fsAgentNames, ...storeAgentNames])];

        // Build agentConfigSkills map from store agents
        const agentConfigSkills = new Map<string, string[]>();
        for (const agent of storeAgents) {
          if (agent.skills?.length) {
            agentConfigSkills.set(agent.name, agent.skills);
          }
        }

        const skills = listSkillsWithAssignments(cwd, polpoDir, agentNames, agentConfigSkills);

        if (skills.length === 0) {
          console.log(chalk.dim("  No skills installed."));
          console.log(chalk.dim("  Install skills with: polpo skills add <owner/repo>"));
          return;
        }

        for (const skill of skills) {
          const sourceTag = skill.source === "global" ? chalk.dim(" [global]") : "";
          const agents = skill.assignedTo.length > 0
            ? chalk.cyan(` → ${skill.assignedTo.join(", ")}`)
            : chalk.dim(" (unassigned)");

          console.log(
            `  ${chalk.bold(skill.name)}${sourceTag}${agents}`,
          );
          if (skill.description) {
            console.log(chalk.dim(`    ${skill.description}`));
          }
          if (skill.category) {
            console.log(chalk.yellow(`    category: ${skill.category}`));
          }
          if (skill.tags?.length) {
            console.log(chalk.blue(`    tags: ${skill.tags.join(", ")}`));
          }
        }

        console.log();
        console.log(chalk.dim(`  ${skills.length} skill(s) in pool.`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- skills remove <name> -----------------------------------------------
  sk
    .command("remove <name>")
    .alias("rm")
    .description("Remove a skill from the pool")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-g, --global", "Remove from ~/.polpo/skills/", false)
    .action((name: string, opts) => {
      try {
        const polpoDir = getPolpoDir(opts.dir);
        const removed = removeSkill(polpoDir, name, opts.global);

        if (removed) {
          console.log(chalk.green(`  Removed skill: ${name}`));
        } else {
          const scope = opts.global ? "global" : "project";
          console.error(chalk.red(`  Skill not found in ${scope} pool: ${name}`));
          process.exit(1);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- skills assign <skill> <agent> --------------------------------------
  sk
    .command("assign <skill> <agent>")
    .description("Assign a skill to an agent (creates symlink)")
    .option("-d, --dir <path>", "Working directory", ".")
    .action((skillName: string, agentName: string, opts) => {
      try {
        const cwd = resolve(opts.dir);
        const polpoDir = getPolpoDir(opts.dir);

        // Find skill in pool
        const pool = discoverSkills(cwd, polpoDir);
        const skill = pool.find(s => s.name === skillName);

        if (!skill) {
          console.error(chalk.red(`  Skill not found: ${skillName}`));
          if (pool.length > 0) {
            console.log(chalk.dim(`  Available: ${pool.map(s => s.name).join(", ")}`));
          }
          process.exit(1);
        }

        assignSkillToAgent(polpoDir, agentName, skillName, skill.path);
        console.log(chalk.green(`  Assigned "${skillName}" to agent "${agentName}"`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- skills tag <skill> -------------------------------------------------
  sk
    .command("tag <skill>")
    .description("Set tags and/or category for a skill in the skills index")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-t, --tags <tags...>", "Freeform tags (space-separated)")
    .option("-c, --category <category>", "Macro-category for grouping")
    .option("--clear-tags", "Remove all tags from this skill", false)
    .option("--clear-category", "Remove the category from this skill", false)
    .action((skillName: string, opts) => {
      try {
        const cwd = resolve(opts.dir);
        const polpoDir = getPolpoDir(opts.dir);

        // Verify skill exists
        const pool = discoverSkills(cwd, polpoDir);
        const skill = pool.find(s => s.name === skillName);
        if (!skill) {
          console.error(chalk.red(`  Skill not found: ${skillName}`));
          if (pool.length > 0) {
            console.log(chalk.dim(`  Available: ${pool.map(s => s.name).join(", ")}`));
          }
          process.exit(1);
        }

        const hasTags = opts.tags && opts.tags.length > 0;
        const hasCategory = !!opts.category;
        const hasClearTags = opts.clearTags;
        const hasClearCategory = opts.clearCategory;

        if (!hasTags && !hasCategory && !hasClearTags && !hasClearCategory) {
          // Show current index entry
          const index = loadSkillIndex(polpoDir);
          const entry = index?.[skillName];
          if (!entry) {
            console.log(chalk.dim(`  No index entry for "${skillName}".`));
          } else {
            console.log(`  ${chalk.bold(skillName)}:`);
            if (entry.tags?.length) console.log(chalk.blue(`    tags: ${entry.tags.join(", ")}`));
            if (entry.category) console.log(chalk.yellow(`    category: ${entry.category}`));
          }
          return;
        }

        const update: { tags?: string[]; category?: string } = {};
        if (hasTags) update.tags = opts.tags;
        if (hasClearTags) update.tags = [];
        if (hasCategory) update.category = opts.category;
        if (hasClearCategory) update.category = "";

        updateSkillIndex(polpoDir, skillName, update);

        console.log(chalk.green(`  Updated index for "${skillName}"`));
        if (update.tags && update.tags.length > 0) console.log(chalk.blue(`    tags: ${update.tags.join(", ")}`));
        if (hasClearTags) console.log(chalk.dim(`    tags: (cleared)`));
        if (update.category) console.log(chalk.yellow(`    category: ${update.category}`));
        if (hasClearCategory) console.log(chalk.dim(`    category: (cleared)`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ═══════════════════════════════════════════════════════
  //  polpo skills orchestrator — manage orchestrator skills
  // ═══════════════════════════════════════════════════════

  const orch = sk
    .command("orchestrator")
    .alias("orch")
    .description("Manage orchestrator skills (.polpo/.agent/skills/)");

  // ---- skills orchestrator list -------------------------------------------
  orch
    .command("list")
    .alias("ls")
    .description("List orchestrator skills")
    .option("-d, --dir <path>", "Working directory", ".")
    .action((opts) => {
      try {
        const polpoDir = getPolpoDir(opts.dir);
        const skills = discoverOrchestratorSkills(polpoDir);

        if (skills.length === 0) {
          console.log(chalk.dim("  No orchestrator skills installed."));
          console.log(chalk.dim("  Install with: polpo skills orchestrator add <owner/repo>"));
          return;
        }

        for (const skill of skills) {
          const sourceTag = skill.source === "global" ? chalk.dim(" [global]") : "";
          console.log(`  ${chalk.bold(skill.name)}${sourceTag}`);
          if (skill.description) {
            console.log(chalk.dim(`    ${skill.description}`));
          }
        }

        console.log();
        console.log(chalk.dim(`  ${skills.length} orchestrator skill(s).`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- skills orchestrator add <source> -----------------------------------
  orch
    .command("add <source>")
    .description("Install orchestrator skills from a GitHub repo or local path")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-s, --skill <names...>", "Install only specific skill names")
    .option("-f, --force", "Overwrite existing skills", false)
    .action((source: string, opts) => {
      try {
        const polpoDir = getPolpoDir(opts.dir);

        console.log(chalk.dim(`  Installing orchestrator skills from ${source}...`));
        console.log();

        const result = installOrchestratorSkills(source, polpoDir, {
          skillNames: opts.skill,
          force: opts.force,
        });

        for (const skill of result.installed) {
          console.log(chalk.green(`  ✓ ${skill.name}`) + chalk.dim(` — ${skill.description || "no description"}`));
        }
        for (const skill of result.skipped) {
          console.log(chalk.yellow(`  ⊘ ${skill.name}`) + chalk.dim(" (already installed, use --force to overwrite)"));
        }
        for (const err of result.errors) {
          console.error(chalk.red(`  ✗ ${err}`));
        }

        console.log();
        if (result.installed.length > 0) {
          console.log(chalk.green(`  ${result.installed.length} orchestrator skill(s) installed.`));
        }
        if (result.errors.length > 0 && result.installed.length === 0) {
          process.exit(1);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- skills orchestrator remove <name> ----------------------------------
  orch
    .command("remove <name>")
    .alias("rm")
    .description("Remove an orchestrator skill")
    .option("-d, --dir <path>", "Working directory", ".")
    .action((name: string, opts) => {
      try {
        const polpoDir = getPolpoDir(opts.dir);
        const removed = removeOrchestratorSkill(polpoDir, name);

        if (removed) {
          console.log(chalk.green(`  Removed orchestrator skill: ${name}`));
        } else {
          console.error(chalk.red(`  Orchestrator skill not found: ${name}`));
          process.exit(1);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });
}
