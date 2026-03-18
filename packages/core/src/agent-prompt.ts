/**
 * Build the identity/personality section of an agent's system prompt.
 *
 * Pure logic — no runtime dependencies (Node.js, pi-ai, filesystem).
 * Used by both self-hosted (src/adapters/engine.ts) and cloud (handler.ts).
 *
 * This builds the "who you are" part of the prompt. Shell-specific concerns
 * (skills, tool descriptions, cwd, sandbox paths) are appended by the caller.
 */
import type { AgentConfig } from "./types.js";

/**
 * Build the core system prompt for an agent: preamble + identity + responsibilities +
 * communication style + personality + hierarchy + custom systemPrompt.
 *
 * Does NOT include: skills, tool descriptions, cwd, output dir, sandbox paths.
 * Those are shell-specific and appended by the caller.
 */
export function buildAgentSystemPrompt(agent: AgentConfig): string {
  const parts = [
    `You are ${agent.name}, a ${agent.role ?? "helpful assistant"} managed by Polpo, an AI agent orchestrator.`,
    "Complete your assigned task autonomously. Make reasonable decisions and proceed without asking questions.",
    "",
    "Your task description may include context tags:",
    "- <shared-memory> — persistent shared knowledge from previous sessions, visible to all agents",
    "- <agent-memory> — your private memory from previous sessions (specific to you)",
    "- <system-context> — standing instructions from the project owner",
    "- <plan-context> — the plan goal and other tasks being worked on in parallel",
    "Use this context to make better decisions, but focus on YOUR assigned task.",
  ];

  // Identity block
  if (agent.identity) {
    parts.push("", "## Your Identity");
    if (agent.identity.displayName) parts.push(`- Name: ${agent.identity.displayName}`);
    if (agent.identity.title) parts.push(`- Title: ${agent.identity.title}`);
    if (agent.identity.company) parts.push(`- Company: ${agent.identity.company}`);
    if (agent.identity.email) parts.push(`- Email: ${agent.identity.email}`);
    if (agent.identity.bio) parts.push(`- Bio: ${agent.identity.bio}`);
    if (agent.identity.timezone) parts.push(`- Timezone: ${agent.identity.timezone}`);
    if (agent.identity.socials && Object.keys(agent.identity.socials).length > 0) {
      const entries = Object.entries(agent.identity.socials).map(([k, v]) => `${k}: ${v}`).join(", ");
      parts.push(`- Socials: ${entries}`);
    }
    parts.push("Use this identity when communicating externally (emails, messages, etc.).");
  }

  // Responsibilities
  if (agent.identity?.responsibilities?.length) {
    parts.push("", "## Your Responsibilities");
    for (const r of agent.identity.responsibilities) {
      if (typeof r === "string") {
        parts.push(`- ${r}`);
      } else {
        const prio = r.priority ? ` [${r.priority}]` : "";
        parts.push(`- **${r.area}**${prio}: ${r.description}`);
      }
    }
    parts.push("Focus on these responsibilities. Escalate if something falls outside your scope.");
  }

  // Communication tone
  if (agent.identity?.tone) {
    parts.push("", "## Communication Style");
    parts.push(agent.identity.tone);
  }

  // Personality
  if (agent.identity?.personality) {
    parts.push("", "## Personality");
    parts.push(agent.identity.personality);
  }

  // Hierarchy
  if (agent.reportsTo) {
    parts.push("", "## Organization");
    parts.push(`You report to: ${agent.reportsTo}`);
    parts.push("If you encounter blockers or decisions outside your authority, escalate to your manager.");
  }

  // Custom system prompt
  if (agent.systemPrompt) parts.push("", agent.systemPrompt);

  return parts.join("\n");
}
