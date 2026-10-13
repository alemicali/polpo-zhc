/**
 * Learning tools for an agent chat: set_learning (always), and, while learning with skills is on or
 * with a drive, list_my_skills / create_my_skill / update_my_skill (only skills the agent created itself).
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentConfig, AgentLearningSettings } from "@polpo-ai/core";
import { DEFAULT_LEARNING_EVERY, DEFAULT_LEARNING_IDLE_MINUTES, type LearningManager, type LearningSkillPort } from "../core/learning.js";
import { isSafeSkillName } from "../llm/skills.js";

export interface LearningToolContext {
  agent: AgentConfig;
  manager?: LearningManager;
  skills: LearningSkillPort;
  /** Skill names the agent owns (created by it). */
  ownedSkills(): string[];
  /** Create a skill owned by the agent and give it to the agent; returns the SKILL.md written. */
  createOwnedSkill(name: string, description: string, content: string): Promise<string>;
  /** The SKILL.md for this description and body (frontmatter included). */
  skillFile(name: string, description: string, content: string): string;
  updateLearning(settings: AgentLearningSettings): Promise<void>;
}

type Result = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
const text = (t: string, details: Record<string, unknown> = {}): Result => ({ content: [{ type: "text", text: t }], details });

/** One line for the tool description: the current setting. */
export function describeLearning(settings: AgentLearningSettings | undefined): string {
  if (!settings?.enabled) return "Learning is OFF: you do not review your conversations.";
  return `Learning is ON: every ${settings.everyMessages ?? DEFAULT_LEARNING_EVERY} new messages (or after `
    + `${settings.idleMinutes ?? DEFAULT_LEARNING_IDLE_MINUTES} quiet minutes) you review your conversations and update `
    + `your memory${settings.skills === false ? "" : " and your own skills"}.`;
}

const SetLearningSchema = Type.Object({
  enabled: Type.Boolean({ description: "Turn learning from your conversations on or off" }),
  every_messages: Type.Optional(Type.Number({ minimum: 5, description: `New messages between two reviews (default ${DEFAULT_LEARNING_EVERY})` })),
  idle_minutes: Type.Optional(Type.Number({ minimum: 0, description: `Review after this many quiet minutes (default ${DEFAULT_LEARNING_IDLE_MINUTES}, 0 = never)` })),
  skills: Type.Optional(Type.Boolean({ description: "Also create and update your own skills (default true)" })),
});
const CreateSkillSchema = Type.Object({
  name: Type.String({ description: "Skill name: lowercase letters, digits and dashes (e.g. \"weekly-report\")" }),
  description: Type.String({ description: "One sentence: what the skill is for and when to use it" }),
  content: Type.String({ description: "The procedure, in markdown: steps, commands, pitfalls, examples" }),
});
const UpdateSkillSchema = Type.Object({
  name: Type.String({ description: "One of your own skills (list_my_skills)" }),
  description: Type.String({ description: "One sentence: what the skill is for and when to use it" }),
  content: Type.String({ description: "The whole new procedure, in markdown (replaces the old one)" }),
});

export function createLearningTools(ctx: LearningToolContext): AgentTool<any>[] {
  const { agent } = ctx;
  const tools: AgentTool<any>[] = [{
    name: "set_learning",
    label: "Set learning",
    description: `Turn on or off learning from your conversations (reviewing them every N messages to update your memory and your own skills). ${describeLearning(agent.learning)} `
      + "Change it when someone asks you to learn (or stop learning) from your conversations.",
    parameters: SetLearningSchema,
    async execute(_id, params) {
      const p = params as { enabled: boolean; every_messages?: number; idle_minutes?: number; skills?: boolean };
      const next: AgentLearningSettings = {
        ...agent.learning,
        enabled: p.enabled,
        ...(p.every_messages !== undefined ? { everyMessages: Math.max(5, Math.round(p.every_messages)) } : {}),
        ...(p.idle_minutes !== undefined ? { idleMinutes: Math.max(0, Math.round(p.idle_minutes)) } : {}),
        ...(p.skills !== undefined ? { skills: p.skills } : {}),
      };
      await ctx.updateLearning(next);
      return text(describeLearning(next), { learning: next });
    },
  }];
  // own skills: while learning with skills, or always with a drive (it grows the skills its purpose needs)
  const ownSkills = (agent.learning?.enabled && agent.learning.skills !== false) || !!agent.drive?.enabled;
  if (!ownSkills) return tools;

  tools.push(
    {
      name: "list_my_skills",
      label: "List my skills",
      description: "The skills you created yourself (you may update these), before creating or updating one.",
      parameters: Type.Object({}),
      async execute() {
        const owned = ctx.ownedSkills();
        if (!owned.length) return text("You have not created any skill yet.");
        return text(owned.map((name) => {
          const file = ctx.skills.read(name) ?? "";
          const description = /^description:\s*(.+)$/m.exec(file)?.[1] ?? "";
          return `- ${name}: ${description}`;
        }).join("\n"));
      },
    },
    {
      name: "create_my_skill",
      label: "Create my skill",
      description: "Write down a procedure you use (or were taught) as a skill of yours: it joins your skills and you can update it later.",
      parameters: CreateSkillSchema,
      async execute(_id, params) {
        const p = params as { name: string; description: string; content: string };
        if (!isSafeSkillName(p.name)) return text("Error: the name must be lowercase letters, digits and dashes");
        if (ctx.skills.read(p.name) !== undefined) return text(`Error: a skill "${p.name}" already exists; pick another name or update your own`);
        const written = await ctx.createOwnedSkill(p.name, p.description.replace(/\s+/g, " ").trim(), p.content);
        ctx.manager?.recordSkillChange(agent.name, "skill-created", p.name, "", written);
        return text(`Skill "${p.name}" created and added to your skills.`);
      },
    },
    {
      name: "update_my_skill",
      label: "Update my skill",
      description: "Rewrite one of your own skills (those you created) with what you learned.",
      parameters: UpdateSkillSchema,
      async execute(_id, params) {
        const p = params as { name: string; description: string; content: string };
        if (!ctx.ownedSkills().includes(p.name)) return text(`Error: "${p.name}" is not one of your own skills (list_my_skills)`);
        const before = ctx.skills.read(p.name) ?? "";
        const after = ctx.skillFile(p.name, p.description.replace(/\s+/g, " ").trim(), p.content);
        if (after === before) return text("Nothing changed.");
        ctx.skills.write(p.name, after);
        ctx.manager?.recordSkillChange(agent.name, "skill-updated", p.name, before, after);
        return text(`Skill "${p.name}" updated.`);
      },
    },
  );
  return tools;
}
