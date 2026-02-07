/**
 * System prompt builders for LLM-powered features (chat, plan, team generation).
 */

import type { Orchestrator } from "../orchestrator.js";
import type { OrchestraState } from "../core/types.js";
import { discoverSkills } from "./constants.js";

/** Build the system prompt for chat mode responses */
export function buildChatSystemPrompt(
  orchestrator: Orchestrator,
  state: OrchestraState | null,
  _workDir?: string,
): string {
  const team = orchestrator.getTeam();

  const parts: string[] = [
    `You are the Orchestra assistant. Orchestra is an agent-agnostic framework for orchestrating teams of AI coding agents.`,
    ``,
    `## How Orchestra Works`,
    ``,
    `Orchestra manages teams of AI agents that execute coding tasks autonomously.`,
    `The supervisor loop runs every 2 seconds and:`,
    `1. Checks for completed agents and collects their results`,
    `2. Spawns ALL agents for tasks whose dependencies are satisfied — multiple agents run in parallel`,
    `3. Runs assessment (tests, file checks, LLM review with G-Eval scoring) on completed tasks`,
    `4. Retries failed tasks up to maxRetries times, including per-dimension feedback`,
    ``,
    `IMPORTANT: The supervisor maximizes parallelism. Every tick, ALL tasks with satisfied dependencies`,
    `are spawned simultaneously. There is no concurrency limit. Tasks without dependencies between them`,
    `WILL run in parallel. Plans should exploit this by only adding dependencies where strictly needed.`,
    ``,
    `## Task State Machine`,
    ``,
    `pending → assigned → in_progress → review → done`,
    `                                          → failed → pending (retry)`,
    ``,
    `- pending: waiting for dependencies or to be picked up`,
    `- assigned: agent selected, about to start`,
    `- in_progress: agent is working on it`,
    `- review: agent finished, running assessment (expectations/metrics)`,
    `- done: all checks passed`,
    `- failed: checks failed or agent errored; may be retried`,
    ``,
    `## Adapters`,
    ``,
    `Agents are spawned via adapters:`,
    `- claude-sdk: Uses @anthropic-ai/claude-agent-sdk. Fast, no process spawning. Full streaming + tool tracking.`,
    `- generic: Spawns any CLI command as a child process. For Aider, OpenCode, custom scripts, etc.`,
    ``,
    `## Assessment System`,
    ``,
    `After an agent finishes a task, expectations are checked:`,
    `- test: Runs a command (e.g. "npm test"), passes if exit code 0`,
    `- file_exists: Checks that specified file paths exist`,
    `- script: Runs a script, passes if exit code 0`,
    `- llm_review: G-Eval LLM-as-Judge with multi-dimensional rubric scoring (1-5)`,
    `  - Default dimensions: correctness (0.35), completeness (0.30), code_quality (0.20), edge_cases (0.15)`,
    `  - Weighted global score compared to threshold (default 3.0)`,
    `  - On retry, per-dimension scores and reasoning are included for targeted improvement`,
    ``,
    `## TUI Modes`,
    ``,
    `- Task mode: User types a task description → immediately created and assigned to an agent`,
    `- Plan mode: User types a request → AI generates a multi-task YAML plan → preview with Execute/Edit/Refine → creates tasks with dependencies and grouping`,
    `- Chat mode (current): User asks questions → you answer based on current state`,
    ``,
    `## Current State`,
    ``,
    `Project: ${state?.project || "orchestra-interactive"}`,
    `Team: ${team.name}`,
    `Agents:`,
  ];

  for (const a of team.agents) {
    let line = `  - ${a.name} (adapter: ${a.adapter}): ${a.role || "general"}`;
    if (a.skills?.length) line += ` [skills: ${a.skills.join(", ")}]`;
    if (a.systemPrompt) line += ` [has system prompt]`;
    parts.push(line);
  }

  if (state?.tasks && state.tasks.length > 0) {
    parts.push(``, `Tasks (${state.tasks.length}):`);
    for (const t of state.tasks) {
      let line = `  - [${t.status.toUpperCase()}] "${t.title}" → ${t.assignTo}`;
      if (t.group) line += ` [${t.group}]`;
      if (t.retries > 0) line += ` (retry ${t.retries}/${t.maxRetries})`;
      parts.push(line);

      if (t.description !== t.title) {
        parts.push(`    Description: ${t.description.slice(0, 300)}`);
      }
      if (t.dependsOn.length > 0) {
        const depTitles = t.dependsOn.map(id => {
          const dep = state.tasks.find(tt => tt.id === id);
          return dep ? `"${dep.title}" [${dep.status}]` : id;
        });
        parts.push(`    Depends on: ${depTitles.join(", ")}`);
      }
      if (t.result) {
        parts.push(`    Result: exit ${t.result.exitCode}, duration ${(t.result.duration / 1000).toFixed(1)}s`);
        if (t.result.assessment?.globalScore !== undefined) {
          parts.push(`    Score: ${t.result.assessment.globalScore.toFixed(1)}/5`);
          if (t.result.assessment.scores) {
            for (const s of t.result.assessment.scores) {
              parts.push(`      ${s.dimension}: ${s.score}/5 — ${s.reasoning.slice(0, 100)}`);
            }
          }
        }
        if (t.result.stderr) {
          parts.push(`    Stderr: ${t.result.stderr.slice(0, 200)}`);
        }
        if (t.result.stdout) {
          parts.push(`    Output (first 200 chars): ${t.result.stdout.slice(0, 200)}`);
        }
      }
    }

    const counts: Record<string, number> = {};
    for (const t of state.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    const summary = Object.entries(counts).map(([s, n]) => `${s}: ${n}`).join(", ");
    parts.push(``, `Summary: ${summary}`);
  } else {
    parts.push(``, `Tasks: none yet`);
  }

  const activeProcs = (state?.processes || []).filter(p => p.alive);
  if (activeProcs.length > 0) {
    parts.push(``, `Active agents (${activeProcs.length}):`);
    for (const p of activeProcs) {
      let line = `  - ${p.agentName} working on task ${p.taskId}`;
      if (p.activity?.lastTool) line += `, last tool: ${p.activity.lastTool}`;
      if (p.activity?.toolCalls) line += `, ${p.activity.toolCalls} tool calls`;
      if (p.activity?.filesCreated.length) line += `, created ${p.activity.filesCreated.length} files`;
      if (p.activity?.filesEdited.length) line += `, edited ${p.activity.filesEdited.length} files`;
      parts.push(line);
    }
  } else {
    parts.push(``, `Active agents: none`);
  }

  return parts.join("\n");
}

/** Build the system prompt for plan generation */
export function buildPlanSystemPrompt(
  orchestrator: Orchestrator,
  state: OrchestraState | null,
  workDir: string,
): string {
  const orchestraKnowledge = buildChatSystemPrompt(orchestrator, state, workDir);
  const team = orchestrator.getTeam();
  const availableSkills = discoverSkills(workDir);

  return [
    orchestraKnowledge,
    ``,
    `---`,
    ``,
    `## Your Role: Plan Generator`,
    ``,
    `You are Orchestra's plan generator. Your job is to decompose a user request into`,
    `a set of atomic tasks that Orchestra's supervisor will execute via AI agents.`,
    `The agents are autonomous coding agents — they can read/write files, run commands,`,
    `install packages, write tests, etc. Each task gets its own independent agent session.`,
    ``,
    `## Output Format`,
    ``,
    `Output ONLY valid YAML (no markdown fences, no explanation, no preamble):`,
    ``,
    `# Optional: define volatile agents specific to this plan`,
    `# These agents are temporary — they exist only for this plan's execution`,
    `# Only include this section if the task benefits from specialized agents`,
    `# that differ from the existing team.`,
    `team:`,
    `  - name: "specialist-name"`,
    `    adapter: "claude-sdk"           # or "generic"`,
    `    model: "claude-sonnet-4-5-20250929"  # claude-sonnet-4-5-20250929, claude-opus-4-6, claude-haiku-4-5-20251001`,
    `    role: "What this agent specializes in"`,
    `    systemPrompt: |               # optional: instructions appended to agent's base prompt`,
    `      You are a specialist in X. Focus on Y.`,
    `    skills:                        # optional: skill names from available skills`,
    `      - "skill-name"`,
    ``,
    `tasks:`,
    `  - title: "Short descriptive title"`,
    `    description: "Detailed description — be specific about what files to create/modify, what logic to implement, etc."`,
    `    assignTo: "agent-name"          # can reference existing team agents OR volatile agents defined above`,
    `    dependsOn: []                   # list of task TITLES (not IDs) of prerequisites`,
    `    expectations:`,
    `      - type: test                  # run a command, pass if exit 0`,
    `        command: "npm test"`,
    `      - type: file_exists           # check files exist`,
    `        paths: ["src/foo.ts"]`,
    `      - type: llm_review            # G-Eval LLM scoring`,
    `        criteria: "Code is clean and well-structured"`,
    ``,
    `## Rules`,
    ``,
    `- List tasks in dependency order (a task's dependencies MUST appear BEFORE it)`,
    `- Each task should be atomic — one clear objective per task`,
    `- Descriptions should be specific enough for an autonomous agent with no context of other tasks`,
    `- Available agents: ${team.agents.filter(a => !a.volatile).map(a => `${a.name} (${a.adapter}, ${a.role || "general"})`).join(", ")}`,
    `- You can use existing agents OR define new volatile agents in the team: section`,
    `- Volatile agents are useful when the task needs specialized roles (e.g. "test-writer", "api-designer", "reviewer")`,
    `- For volatile agents, write a focused systemPrompt and assign relevant skills if available`,
    ...(availableSkills.length > 0 ? [
      `- Available skills: ${availableSkills.map(s => `${s.name} (${s.description})`).join(", ")}`,
      `- Only assign skills that are relevant to the volatile agent's role`,
    ] : []),
    `- Use different models strategically: Haiku for simple tasks, Sonnet for standard work, Opus for complex reasoning`,
    `- Add expectations where appropriate — tests for code, file_exists for creation, llm_review for quality`,
    `- Consider existing tasks/state to avoid duplication or conflicts`,
    `- MAXIMIZE PARALLELISM: Orchestra spawns ALL tasks with satisfied deps simultaneously.`,
    `  Only add a dependency if task B truly CANNOT start before task A finishes.`,
    `  Independent tasks (different files, different modules) MUST NOT have deps between them.`,
    `  Example: creating tests and creating docs for different features can run in parallel.`,
    `- Output ONLY the YAML, nothing else`,
  ].join("\n");
}

/** Build the system prompt for AI team generation */
export function buildTeamGenPrompt(
  orchestrator: Orchestrator,
  workDir: string,
  description: string,
): string {
  const currentTeam = orchestrator.getTeam();
  const alreadyInstalled = discoverSkills(workDir);
  const installedSection = alreadyInstalled.length > 0
    ? `Already installed skills: ${alreadyInstalled.map(s => s.name).join(", ")}`
    : `No skills currently installed.`;

  return [
    `You are Orchestra's team designer. Orchestra is an agent-agnostic framework for orchestrating teams of AI coding agents.`,
    ``,
    `## Your Role`,
    ``,
    `Design a team of specialized AI agents based on the user's description.`,
    `Each agent should have a clear role, the right model, a focused system prompt, and relevant skills.`,
    ``,
    `## IMPORTANT: Skill Discovery & Installation`,
    ``,
    `You have access to the Skill tool and Bash. Before generating the team YAML, you MUST:`,
    ``,
    `1. Use the Skill tool to invoke "find-skills" — search for skills relevant to the user's request.`,
    `   For example, if the user wants an Expo team, search for "expo", "react native", etc.`,
    `2. Review the search results and identify useful skills for the agents.`,
    `3. Install the relevant skills using Bash: \`npx skills add <source> --skill <name> -y\``,
    `   The find-skills skill will tell you the install commands.`,
    `4. After installing, include the installed skill names in the team YAML under each agent's \`skills:\` field.`,
    ``,
    `${installedSection}`,
    `Only search and install skills that are genuinely useful for the team's roles. Don't install irrelevant skills.`,
    ``,
    `## Available Adapters`,
    ``,
    `- claude-sdk: Uses Claude Code SDK. Fast, autonomous, can read/write files, run commands, etc.`,
    `- generic: Spawns any CLI command. For non-Claude tools.`,
    ``,
    `## Available Models (for claude-sdk adapter)`,
    ``,
    `- claude-haiku-4-5-20251001: Fast and cheap. Good for simple tasks, formatting, quick edits.`,
    `- claude-sonnet-4-5-20250929: Balanced. Good for most coding tasks.`,
    `- claude-opus-4-6: Most capable. Best for complex reasoning, architecture decisions, code review.`,
    ``,
    `## Current Team`,
    ``,
    `Team name: ${currentTeam.name}`,
    `Agents: ${currentTeam.agents.length > 0 ? currentTeam.agents.map(a => `${a.name} (${a.role || "general"})`).join(", ") : "none"}`,
    ``,
    `## Final Output`,
    ``,
    `After skill discovery and installation, output ONLY valid YAML (no markdown fences, no explanation):`,
    ``,
    `team:`,
    `  - name: "agent-name"            # kebab-case, descriptive`,
    `    adapter: "claude-sdk"          # or "generic"`,
    `    model: "claude-sonnet-4-5-20250929"  # pick the right model for the role`,
    `    role: "Clear description of what this agent does"`,
    `    systemPrompt: |               # instructions appended to the agent's base prompt`,
    `      You are a specialized frontend developer.`,
    `      Focus on React components, CSS, and accessibility.`,
    `    skills:                        # skill names (already installed + newly installed)`,
    `      - "frontend-design"`,
    ``,
    `## Rules`,
    ``,
    `- Each agent should have a distinct, non-overlapping role`,
    `- Use kebab-case for agent names (e.g. "frontend-dev", "test-writer", "api-designer")`,
    `- Choose models strategically: Haiku for simple tasks, Sonnet for standard, Opus for complex`,
    `- Include 2-6 agents typically — match the complexity of the user's needs`,
    `- Consider including a "reviewer" agent for quality assurance if appropriate`,
    `- Write a concise, focused systemPrompt for each agent that defines its specialization and constraints`,
    `- Only assign skills that are actually installed (either pre-existing or just installed by you)`,
    `- If no skills are relevant, omit the skills field`,
    `- The FINAL output must be ONLY the YAML team definition`,
    ``,
    `---`,
    ``,
    `User request: "${description}"`,
  ].join("\n");
}
