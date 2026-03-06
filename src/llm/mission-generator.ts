/**
 * Structured mission generation using pi-ai tool-based output.
 *
 * Instead of asking the LLM for raw text (fragile: preamble, fences, malformed output),
 * we define a `submit_mission` tool with a TypeBox schema. The LLM calls the tool
 * with validated JSON data, which we store directly as JSON.
 *
 * Fallback: if tool calling fails, tries to parse JSON from text output.
 *
 * Same proven pattern as src/assessment/llm-review.ts.
 */

import { Type } from "@sinclair/typebox";
import { completeSimple, type Tool, type Message } from "@mariozechner/pi-ai";
import { resolveModel, resolveApiKeyAsync, buildStreamOpts } from "./pi-client.js";
import type { ReasoningLevel } from "../core/types.js";
import { withRetry } from "./retry.js";
import { sanitizeExpectations } from "../core/schemas.js";

// ─── TypeBox Schemas ─────────────────────────────────────────────────

const ExpectationSchema = Type.Object({
  type: Type.Union([
    Type.Literal("test"),
    Type.Literal("file_exists"),
    Type.Literal("script"),
    Type.Literal("llm_review"),
  ]),
  command: Type.Optional(Type.String({ description: "REQUIRED for test/script. Command to run (exit code 0 = pass). Supports multi-line for script type." })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "REQUIRED for file_exists. At least 1 file path to check." })),
  criteria: Type.Optional(Type.String({ description: "For llm_review: review criteria. REQUIRED if no dimensions provided." })),
  threshold: Type.Optional(Type.Number({ description: "For llm_review: score threshold 1-5 (default 3.0). Higher = stricter." })),
  dimensions: Type.Optional(Type.Array(Type.Object({
    name: Type.String({ description: "Dimension name (e.g. correctness, completeness)" }),
    weight: Type.Number({ description: "Weight 0-1 (all weights should sum to ~1.0)" }),
    description: Type.String({ description: "What this dimension evaluates" }),
    rubric: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Score descriptions keyed by level: { '1': 'Poor...', '2': '...', ..., '5': 'Excellent...' }" })),
  }), { description: "For llm_review: evaluation dimensions. REQUIRED if no criteria provided. 3 reviewers score each dimension 1-5." })),
});

const ExpectedOutcomeSchema = Type.Object({
  type: Type.Union([
    Type.Literal("file"),
    Type.Literal("text"),
    Type.Literal("url"),
    Type.Literal("json"),
    Type.Literal("media"),
  ], { description: "Outcome type: file (documents, spreadsheets), text (transcriptions, summaries), url (links), json (structured data), media (audio, images, video)" }),
  label: Type.String({ description: "Human-readable label (e.g. 'Sales Report', 'Speech Audio', 'Transcription')" }),
  description: Type.Optional(Type.String({ description: "Hints for the agent about what to produce" })),
  path: Type.Optional(Type.String({ description: "Expected file path (optional — agent can choose)" })),
  mimeType: Type.Optional(Type.String({ description: "Expected MIME type (e.g. 'audio/mpeg', 'application/pdf')" })),
  required: Type.Optional(Type.Boolean({ description: "Whether this outcome is required (default: true)" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
});

const MissionTaskSchema = Type.Object({
  title: Type.String({ description: "Short descriptive title — MUST be unique within the mission (no duplicate titles)" }),
  description: Type.String({ description: "Detailed description — be specific about files, logic, etc." }),
  assignTo: Type.String({ description: "Agent name to assign the task to" }),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task titles this depends on" })),
  expectations: Type.Optional(Type.Array(ExpectationSchema)),
  expectedOutcomes: Type.Optional(Type.Array(ExpectedOutcomeSchema, { description: "Artifacts this task should produce (files, text, URLs, data). Auto-collected from tool results + validated." })),
  maxRetries: Type.Optional(Type.Number({ description: "Max retry attempts (default: 2)" })),
  sideEffects: Type.Optional(Type.Boolean({ description: "Set to true if this task produces irreversible external effects (sending emails, WhatsApp messages, POST/PUT/DELETE API calls). Prevents automatic retry/fix — requires human approval before re-execution." })),
});

const MissionTeamSchema = Type.Object({
  name: Type.String({ description: "Agent name (kebab-case)" }),
  model: Type.Optional(Type.String({ description: "Model spec: 'provider:model' or just 'model'. Uses agent's configured model when omitted." })),
  role: Type.Optional(Type.String({ description: "Agent role description" })),
  systemPrompt: Type.Optional(Type.String({ description: "System prompt appended to agent's base prompt" })),
  skills: Type.Optional(Type.Array(Type.String(), { description: "Skill names" })),
  maxTurns: Type.Optional(Type.Number({ description: "Max agentic turns (default: 150)" })),
  allowedTools: Type.Optional(Type.Array(Type.String(), { description: "Restrict agent to specific tools (e.g. ['read', 'write', 'edit', 'bash'])" })),
  // Browser/email tools are activated by including "browser_*" or "email_*" in allowedTools.
});

const SubmitMissionSchema = Type.Object({
  name: Type.String({ description: "kebab-case mission name, 2-4 words (e.g. implement-auth-system)" }),
  team: Type.Optional(Type.Array(MissionTeamSchema, { description: "Volatile agents specific to this mission" })),
  tasks: Type.Array(MissionTaskSchema, { minItems: 1, description: "Atomic tasks in dependency order" }),
});

const submitMissionTool: Tool = {
  name: "submit_mission",
  description: `Submit your structured execution mission. You MUST call this tool exactly once
with all the tasks for the mission. Each task should be atomic — one clear objective per task.
Every task title MUST be unique within the mission — duplicate titles are rejected.
List tasks in dependency order (a task's dependencies MUST appear before it).
Do NOT output the mission as plain text or YAML — use this tool.`,
  parameters: SubmitMissionSchema,
};

// ─── AskUser Tool (interactive clarification) ───────────────────────

const QuestionOptionSchema = Type.Object({
  label: Type.String({ description: "Option text" }),
  description: Type.Optional(Type.String({ description: "Extra context for the option" })),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique question key (e.g. 'auth-method')" }),
  question: Type.String({ description: "The question text" }),
  options: Type.Array(QuestionOptionSchema, { minItems: 2, description: "Selectable options" }),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple selections (default: false)" })),
});

const AskUserSchema = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 5, description: "Questions to ask" }),
});

const askUserTool: Tool = {
  name: "ask_user",
  description: `Ask the user clarifying questions before generating the mission. Call this ONLY when
you genuinely need more information to produce a good mission. Each question must have 2+ pre-built
options. The user can select options or provide custom text. After receiving answers, call
submit_mission with the final mission. Do NOT ask questions for obvious choices.`,
  parameters: AskUserSchema,
};

const submitTaskTool: Tool = {
  name: "submit_task",
  description: `Submit a single prepared task. You MUST call this tool exactly once.
Enrich the user's input into a well-structured task with a clear title, detailed description,
and appropriate expectations (test, file_exists, script, llm_review).
Do NOT output the task as plain text or YAML — use this tool.`,
  parameters: MissionTaskSchema,
};

const SubmitTeamSchema = Type.Object({
  team: Type.Array(MissionTeamSchema, { minItems: 1, description: "Array of specialized agents" }),
});

const submitTeamTool: Tool = {
  name: "submit_team",
  description: `Submit your team definition. You MUST call this tool exactly once with all agents.
Each agent should have a distinct, non-overlapping role with an appropriate model and system prompt.
Do NOT output the team as plain text or YAML — use this tool.`,
  parameters: SubmitTeamSchema,
};

// ─── Types ───────────────────────────────────────────────────────────

export interface MissionTaskData {
  title: string;
  description: string;
  assignTo: string;
  dependsOn?: string[];
  expectations?: Array<{
    type: "test" | "file_exists" | "script" | "llm_review";
    command?: string;
    paths?: string[];
    criteria?: string;
    threshold?: number;
    dimensions?: Array<{
      name: string;
      weight: number;
      description: string;
      rubric?: Record<string, string>;
    }>;
  }>;
  expectedOutcomes?: Array<{
    type: "file" | "text" | "url" | "json" | "media";
    label: string;
    description?: string;
    path?: string;
    mimeType?: string;
    required?: boolean;
    tags?: string[];
  }>;
  maxRetries?: number;
  /** Whether this task produces irreversible side effects (email sends, API calls, etc.). */
  sideEffects?: boolean;
}

export interface MissionTeamData {
  name: string;
  model?: string;
  role?: string;
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
  allowedTools?: string[];
}

export interface MissionData {
  name: string;
  team?: MissionTeamData[];
  tasks: MissionTaskData[];
}

// ─── AskUser Types ──────────────────────────────────────────────────

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  id: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface UserAnswer {
  questionId: string;
  selected: string[];
  customText?: string;
}

export type GenerateMissionResult =
  | { type: "mission"; data: MissionData }
  | { type: "questions"; questions: UserQuestion[]; messages: Message[] };

// ─── Core Functions ──────────────────────────────────────────────────

/**
 * Generate a structured mission using tool-based output.
 * The LLM calls `submit_mission` with validated JSON → we get typed MissionData.
 * Falls back to text parsing (JSON) if the LLM doesn't use the tool.
 */
export async function generateMission(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  onTokens?: (tokens: number) => void,
  reasoning?: ReasoningLevel,
): Promise<MissionData> {
  return withRetry(async () => {
    const m = resolveModel(model);
    const apiKey = await resolveApiKeyAsync(m.provider);

    const messages: Message[] = [
      { role: "user", content: userPrompt, timestamp: Date.now() },
    ];

    const response = await completeSimple(m, {
      systemPrompt,
      messages,
      tools: [submitMissionTool],
    }, buildStreamOpts(apiKey, reasoning));

    // Track tokens if callback provided
    if (onTokens && "usage" in response && response.usage && typeof response.usage === "object") {
      const u = response.usage as { totalTokens?: number };
      if (typeof u.totalTokens === "number") onTokens(u.totalTokens);
    }

    // Extract from tool call (primary path)
    const toolCall = response.content.find(
      (c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
        c.type === "toolCall" && c.name === "submit_mission"
    );

    if (toolCall) {
      return validateMissionData(toolCall.arguments as MissionData);
    }

    // Fallback: try parsing from text response (JSON)
    const textBlocks = response.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text"
    );
    const fullText = textBlocks.map(b => b.text).join("\n");
    const fallback = tryParseMissionFromText(fullText);
    if (fallback) return validateMissionData(fallback);

    // Debug: show what we got
    const contentTypes = response.content.map(c => c.type).join(", ");
    const preview = fullText.slice(0, 200).replace(/\n/g, "\\n");
    throw new Error(
      `LLM did not produce a valid mission. Response content types: [${contentTypes}]. ` +
      `Text preview: "${preview}"`
    );
  }, { maxRetries: 2 });
}

/**
 * Internal: run a single mission generation step with given tools and messages.
 * Returns either a mission (if submit_mission called) or questions (if ask_user called).
 */
async function _runMissionStep(
  systemPrompt: string,
  messages: Message[],
  tools: Tool[],
  model?: string,
  onTokens?: (tokens: number) => void,
  reasoning?: ReasoningLevel,
): Promise<GenerateMissionResult> {
  const m = resolveModel(model);
  const apiKey = await resolveApiKeyAsync(m.provider);

  const response = await completeSimple(m, {
    systemPrompt,
    messages,
    tools,
    }, buildStreamOpts(apiKey, reasoning, m.maxTokens));

    // Track tokens if callback provided
    if (onTokens && "usage" in response && response.usage && typeof response.usage === "object") {
      const u = response.usage as { totalTokens?: number };
    if (typeof u.totalTokens === "number") onTokens(u.totalTokens);
  }

  // Append assistant response to messages for potential multi-turn
  messages.push(response);

  // Check for submit_mission tool call
  const missionCall = response.content.find(
    (c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
      c.type === "toolCall" && c.name === "submit_mission"
  );
  if (missionCall) {
    return { type: "mission", data: validateMissionData(missionCall.arguments as MissionData) };
  }

  // Check for ask_user tool call
  const askCall = response.content.find(
    (c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
      c.type === "toolCall" && c.name === "ask_user"
  );
  if (askCall) {
    const args = askCall.arguments as { questions: UserQuestion[] };
    return { type: "questions", questions: args.questions, messages };
  }

  // Fallback: try parsing from text response
  const textBlocks = response.content.filter(
    (c): c is { type: "text"; text: string } => c.type === "text"
  );
  const fullText = textBlocks.map(b => b.text).join("\n");
  const fallback = tryParseMissionFromText(fullText);
  if (fallback) return { type: "mission", data: validateMissionData(fallback) };

  const contentTypes = response.content.map(c => c.type).join(", ");
  const preview = fullText.slice(0, 200).replace(/\n/g, "\\n");
  throw new Error(
    `LLM did not produce a valid mission. Response content types: [${contentTypes}]. ` +
    `Text preview: "${preview}"`
  );
}

/**
 * Generate a mission interactively — may return questions for user clarification.
 * Used by TUI where user can answer questions. The returned `messages` array
 * should be passed to `continueMissionWithAnswers()` after the user answers.
 */
export async function generateMissionInteractive(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  onTokens?: (tokens: number) => void,
  reasoning?: ReasoningLevel,
): Promise<GenerateMissionResult> {
  return withRetry(async () => {
    const messages: Message[] = [
      { role: "user", content: userPrompt, timestamp: Date.now() },
    ];
    return _runMissionStep(systemPrompt, messages, [askUserTool, submitMissionTool], model, onTokens, reasoning);
  }, { maxRetries: 2 });
}

/**
 * Continue mission generation after user answered questions.
 * Formats answers as toolResult, appends to conversation, and runs another step.
 */
export async function continueMissionWithAnswers(
  systemPrompt: string,
  previousMessages: Message[],
  answers: UserAnswer[],
  model?: string,
  onTokens?: (tokens: number) => void,
  reasoning?: ReasoningLevel,
): Promise<GenerateMissionResult> {
  // Find the last ask_user tool call to get its ID
  const messages = [...previousMessages];
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  let askCallId = "ask_user_call";
  if (lastAssistant && "content" in lastAssistant && Array.isArray((lastAssistant as any).content)) {
    const askCall = (lastAssistant as any).content.find(
      (c: any) => c.type === "toolCall" && c.name === "ask_user"
    );
    if (askCall) askCallId = askCall.id;
  }

  // Format user answers as tool result
  const answerText = answers.map(a => {
    const hasAnswer = a.selected.length > 0 || !!a.customText;
    if (!hasAnswer) {
      return `Question "${a.questionId}": Skipped — decide on your own based on best practices`;
    }
    const parts = [`Question "${a.questionId}":`];
    if (a.selected.length > 0) parts.push(`  Selected: ${a.selected.join(", ")}`);
    if (a.customText) parts.push(`  Custom input: ${a.customText}`);
    return parts.join("\n");
  }).join("\n\n");

  messages.push({
    role: "toolResult",
    toolCallId: askCallId,
    toolName: "ask_user",
    content: [{ type: "text", text: answerText }],
    isError: false,
    timestamp: Date.now(),
  } as any);

  return _runMissionStep(systemPrompt, messages, [askUserTool, submitMissionTool], model, onTokens, reasoning);
}

/**
 * Generate a refined mission given existing mission JSON and feedback.
 */
export async function refineMissionStructured(
  systemPrompt: string,
  originalPrompt: string,
  currentMissionJson: string,
  feedback: string,
  model?: string,
  onTokens?: (tokens: number) => void,
  reasoning?: ReasoningLevel,
): Promise<MissionData> {
  const userPrompt = [
    `Original request: "${originalPrompt}"`,
    "",
    "Current mission:",
    currentMissionJson,
    "",
    `User feedback: "${feedback}"`,
    "",
    "Revise the mission based on the feedback. Call the submit_mission tool with the updated mission.",
  ].join("\n");

  return generateMission(systemPrompt, userPrompt, model, onTokens, reasoning);
}

/**
 * Generate a single prepared task using tool-based output.
 * The LLM calls `submit_task` with validated JSON → we get typed MissionTaskData.
 * Falls back to text parsing if the LLM doesn't use the tool.
 */
export async function generateTaskPrep(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  onTokens?: (tokens: number) => void,
  reasoning?: ReasoningLevel,
): Promise<MissionTaskData> {
  return withRetry(async () => {
    const m = resolveModel(model);
    const apiKey = await resolveApiKeyAsync(m.provider);

    const messages: Message[] = [
      { role: "user", content: userPrompt, timestamp: Date.now() },
    ];

    const response = await completeSimple(m, {
      systemPrompt,
      messages,
      tools: [submitTaskTool],
    }, buildStreamOpts(apiKey, reasoning, m.maxTokens));

    // Track tokens if callback provided
    if (onTokens && "usage" in response && response.usage && typeof response.usage === "object") {
      const u = response.usage as { totalTokens?: number };
      if (typeof u.totalTokens === "number") onTokens(u.totalTokens);
    }

    // Extract from tool call (primary path)
    const toolCall = response.content.find(
      (c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
        c.type === "toolCall" && c.name === "submit_task"
    );

    if (toolCall) {
      return validateTaskData(toolCall.arguments as MissionTaskData);
    }

    // Fallback: try parsing from text response
    const textBlocks = response.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text"
    );
    const fullText = textBlocks.map(b => b.text).join("\n");
    const fallback = tryParseTaskFromText(fullText);
    if (fallback) return validateTaskData(fallback);

    // Fail — return null so caller can fall back to direct creation
    throw new Error("LLM did not produce a prepared task");
  }, { maxRetries: 1 });
}

/**
 * Generate a team using tool-based output.
 * The LLM calls `submit_team` with validated JSON → we get MissionTeamData[].
 * Falls back to text parsing if the LLM doesn't use the tool.
 */
export async function generateTeam(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  reasoning?: ReasoningLevel,
): Promise<MissionTeamData[]> {
  return withRetry(async () => {
    const m = resolveModel(model);
    const apiKey = await resolveApiKeyAsync(m.provider);

    const messages: Message[] = [
      { role: "user", content: userPrompt, timestamp: Date.now() },
    ];

    const response = await completeSimple(m, {
      systemPrompt,
      messages,
      tools: [submitTeamTool],
    }, buildStreamOpts(apiKey, reasoning, m.maxTokens));

    // Extract from tool call (primary path)
    const toolCall = response.content.find(
      (c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
        c.type === "toolCall" && c.name === "submit_team"
    );

    if (toolCall) {
      const data = toolCall.arguments as { team: MissionTeamData[] };
      return validateTeamData(data.team);
    }

    // Fallback: try parsing from text response
    const textBlocks = response.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text"
    );
    const fullText = textBlocks.map(b => b.text).join("\n");
    const fallback = tryParseTeamFromText(fullText);
    if (fallback) return validateTeamData(fallback);

    throw new Error("LLM did not produce a valid team definition");
  }, { maxRetries: 1 });
}

/**
 * Refine a team with user feedback using tool-based output.
 */
export async function refineTeam(
  systemPrompt: string,
  currentTeamJson: string,
  feedback: string,
  model?: string,
  reasoning?: ReasoningLevel,
): Promise<MissionTeamData[]> {
  const userPrompt = [
    "Current team:",
    currentTeamJson,
    "",
    `User feedback: "${feedback}"`,
    "",
    "Revise the team based on the feedback. Call the submit_team tool with the updated team.",
  ].join("\n");

  return generateTeam(systemPrompt, userPrompt, model, reasoning);
}

/**
 * Convert structured MissionData to JSON string (for storage).
 */
export function missionDataToJson(data: MissionData): string {
  return JSON.stringify(data);
}

// ─── Segment type (mirrored from TUI store for independence) ─────────

export interface MissionSeg {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

const s = (text: string, color?: string, bold?: boolean, dim?: boolean): MissionSeg =>
  ({ text, color, bold, dim });

// ─── Expectation type badges ─────────────────────────────────────────

const EXPECT_BADGE: Record<string, { color: string; label: string }> = {
  test:        { color: "green",   label: "TEST" },
  file_exists: { color: "blue",    label: "FILES" },
  script:      { color: "yellow",  label: "SCRIPT" },
  llm_review:  { color: "magenta", label: "REVIEW" },
};

/**
 * Format MissionData as rich colored segments for TUI display.
 * Returns MissionSeg[][] (one Seg[] per line).
 */
/** Word-wrap text to maxWidth, preserving indent on continuation lines. */
function wrapLines(text: string, indent: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const available = maxWidth - indent.length;
  if (available <= 10) return [`${indent}${text}`];

  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) { lines.push(""); continue; }
    let remaining = trimmed;
    while (remaining.length > available) {
      // Find last space within available width
      let breakAt = remaining.lastIndexOf(" ", available);
      if (breakAt <= 0) breakAt = available; // no space — hard break
      lines.push(`${indent}${remaining.slice(0, breakAt)}`);
      remaining = remaining.slice(breakAt).trimStart();
    }
    if (remaining) lines.push(`${indent}${remaining}`);
  }
  return lines;
}

export function formatMissionRich(data: MissionData, termCols?: number): MissionSeg[][] {
  const out: MissionSeg[][] = [];
  const maxWidth = (termCols ?? 100) - 4; // 4 for paddingX
  const SEP = "─".repeat(Math.min(50, maxWidth));
  const INDENT = "     ";

  // (Mission title rendered by the viewer page title — no duplication here)

  // ── Team section ──
  if (data.team && data.team.length > 0) {
    out.push([s("TEAM", "white", true), s(` (${data.team.length} volatile agents)`, "gray")]);
    out.push([s(SEP, "gray", false, true)]);
    for (const a of data.team) {
      out.push([s("  "), s(a.name, "cyan", true), s(a.role ? ` — ${a.role}` : "", "gray")]);
      const meta: string[] = [];
      if (a.model) meta.push(`model: ${a.model}`);
      if (a.skills?.length) meta.push(`skills: ${a.skills.join(", ")}`);
      if (meta.length) out.push([s(`    ${meta.join("  │  ")}`, "gray", false, true)]);
    }
    out.push([]);
  }

  // ── Tasks section ──
  out.push([s("TASKS", "white", true), s(` (${data.tasks.length})`, "gray")]);
  out.push([s(SEP, "gray", false, true)]);
  out.push([]);

  for (let i = 0; i < data.tasks.length; i++) {
    const t = data.tasks[i];

    // Task number + title
    out.push([s(`  ${i + 1}. `, "cyan", true), s(t.title, "white", true)]);

    // Agent
    out.push([s(`${INDENT}Agent:        `, "gray", true), s(t.assignTo, "cyan")]);

    // Dependencies
    if (t.dependsOn?.length) {
      out.push([s(`${INDENT}Depends on:   `, "gray", true), s(t.dependsOn.join(", "), "yellow")]);
    }

    // Max retries
    if (t.maxRetries !== undefined) {
      out.push([s(`${INDENT}Max retries:  `, "gray", true), s(String(t.maxRetries), "yellow")]);
    }

    // Description
    if (t.description && t.description !== t.title) {
      out.push([]);
      out.push([s(`${INDENT}Description:`, "gray", true)]);
      const desc = t.description.length > 500
        ? t.description.slice(0, 497) + "..."
        : t.description;
      const descIndent = `${INDENT}  `;
      for (const wl of wrapLines(desc, descIndent, maxWidth)) {
        out.push([s(wl || " ", "gray")]);
      }
    }

    // Expectations
    if (t.expectations?.length) {
      out.push([]);
      out.push([s(`${INDENT}Expectations:`, "gray", true), s(` (${t.expectations.length})`, "gray", false, true)]);
      for (const e of t.expectations) {
        const badge = EXPECT_BADGE[e.type] ?? { color: "gray", label: e.type.toUpperCase() };
        out.push([s(`${INDENT}  `), s(`[${badge.label}]`, badge.color, true)]);

        if ((e.type === "test" || e.type === "script") && e.command) {
          const cmdLines = e.command.split("\n").filter(l => l.trim());
          if (cmdLines.length === 1) {
            out.push([s(`${INDENT}    Command: `, "gray", false, true), s(cmdLines[0], "white")]);
          } else {
            out.push([s(`${INDENT}    Command:`, "gray", false, true)]);
            for (const l of cmdLines) {
              out.push([s(`${INDENT}      ${l}`, "white")]);
            }
          }
        }

        if (e.type === "file_exists" && e.paths?.length) {
          const pathsIndent = `${INDENT}               `;
          const pathsText = e.paths.join(", ");
          if ((`${INDENT}    Paths: ` + pathsText).length <= maxWidth) {
            out.push([s(`${INDENT}    Paths: `, "gray", false, true), s(pathsText, "blue")]);
          } else {
            out.push([s(`${INDENT}    Paths:`, "gray", false, true)]);
            for (const wl of wrapLines(pathsText, pathsIndent, maxWidth)) {
              out.push([s(wl, "blue")]);
            }
          }
        }

        if (e.type === "llm_review") {
          if (e.threshold) {
            out.push([s(`${INDENT}    Threshold: `, "gray", false, true), s(`≥ ${e.threshold}/5`, "yellow")]);
          }
          if (e.criteria) {
            const criteriaIndent = `${INDENT}              `;
            const wrapped = wrapLines(e.criteria, criteriaIndent, maxWidth);
            if (wrapped.length === 1) {
              out.push([s(`${INDENT}    Criteria: `, "gray", false, true), s(e.criteria, "white")]);
            } else {
              out.push([s(`${INDENT}    Criteria:`, "gray", false, true)]);
              for (const wl of wrapped) {
                out.push([s(wl, "white")]);
              }
            }
          }
          if (e.dimensions?.length) {
            out.push([s(`${INDENT}    Dimensions:`, "gray", false, true)]);
            for (const d of e.dimensions) {
              const pct = Math.round(d.weight * 100);
              out.push([
                s(`${INDENT}      `),
                s(`${d.name}`, "magenta"),
                s(` (${pct}%) `, "gray", false, true),
                s(d.description.slice(0, 80), "gray"),
              ]);
            }
          }
        }
      }
    }

    // Separator between tasks
    if (i < data.tasks.length - 1) {
      out.push([]);
      out.push([s(`  ${"· ".repeat(25)}`, "gray", false, true)]);
    }
    out.push([]);
  }

  return out;
}

/**
 * Format MissionData as a plain string for CLI/non-TUI display.
 */
export function formatMissionReadable(data: MissionData): string {
  return formatMissionRich(data)
    .map((segs) => segs.map((sg) => sg.text).join(""))
    .join("\n");
}

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Validate and sanitize mission data.
 * Runs expectations through Zod sanitization and ensures required fields.
 */
function validateMissionData(data: MissionData): MissionData {
  if (!data.name || typeof data.name !== "string") {
    data.name = "generated-mission";
  }

  if (!data.tasks || !Array.isArray(data.tasks) || data.tasks.length === 0) {
    throw new Error("Mission has no tasks");
  }

  // Sanitize expectations on each task
  for (const task of data.tasks) {
    if (task.expectations && Array.isArray(task.expectations)) {
      const { valid } = sanitizeExpectations(task.expectations);
      task.expectations = valid.length > 0 ? valid as MissionTaskData["expectations"] : undefined;
    }
    // Ensure required fields
    if (!task.title) task.title = "Untitled task";
    if (!task.description) task.description = task.title;
    if (!task.assignTo) task.assignTo = "default";
  }

  // Enforce unique task titles — deduplicate by appending a numeric suffix
  const seen = new Map<string, number>();
  for (const task of data.tasks) {
    const base = task.title;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    if (count > 0) {
      task.title = `${base} #${count + 1}`;
    }
  }

  return data;
}

// ─── Fallback Parsing ────────────────────────────────────────────────

/**
 * Try to parse mission data from LLM text output (JSON only).
 */
function tryParseMissionFromText(text: string): MissionData | null {
  const trimmed = text.trim();

  // Strip markdown fences if present
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const inner = fenceMatch ? fenceMatch[1].trim() : trimmed;

  // Try JSON — find the outermost JSON object
  const candidates = [inner, trimmed];
  for (const candidate of candidates) {
    const objMatch = candidate.match(/\{[\s\S]*\}/);
    if (!objMatch) continue;
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed?.tasks && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
        return {
          name: parsed.name || "generated-mission",
          team: parsed.team,
          tasks: parsed.tasks,
        } as MissionData;
      }
    } catch { /* not valid JSON */ }
  }

  return null;
}

/**
 * Validate and sanitize a single task.
 */
function validateTaskData(data: MissionTaskData): MissionTaskData {
  if (!data.title) data.title = "Untitled task";
  if (!data.description) data.description = data.title;
  if (!data.assignTo) data.assignTo = "default";

  if (data.expectations && Array.isArray(data.expectations)) {
    const { valid } = sanitizeExpectations(data.expectations);
    data.expectations = valid.length > 0 ? valid as MissionTaskData["expectations"] : undefined;
  }

  return data;
}

/**
 * Try to parse a single task from LLM text output (JSON only).
 */
function tryParseTaskFromText(text: string): MissionTaskData | null {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const inner = fenceMatch ? fenceMatch[1].trim() : trimmed;

  const candidates = [inner, trimmed];

  // Try JSON
  for (const candidate of candidates) {
    const objMatch = candidate.match(/\{[\s\S]*\}/);
    if (!objMatch) continue;
    try {
      const parsed = JSON.parse(objMatch[0]);
      // Could be { tasks: [...] } wrapper or direct task object
      const task = parsed?.tasks?.[0] ?? parsed;
      if (task?.title && task?.description) {
        return task as MissionTaskData;
      }
    } catch { /* not valid JSON */ }
  }

  return null;
}

/**
 * Validate team data — ensure each agent has a name.
 */
function validateTeamData(agents: MissionTeamData[]): MissionTeamData[] {
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error("Team has no agents");
  }
  for (const a of agents) {
    if (!a.name) a.name = "agent";
  }
  return agents;
}

/**
 * Try to parse team data from LLM text output (JSON only).
 */
function tryParseTeamFromText(text: string): MissionTeamData[] | null {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const inner = fenceMatch ? fenceMatch[1].trim() : trimmed;

  const candidates = [inner, trimmed];

  // Try JSON
  for (const candidate of candidates) {
    const objMatch = candidate.match(/[\[{][\s\S]*[\]}]/);
    if (!objMatch) continue;
    try {
      const parsed = JSON.parse(objMatch[0]);
      // Could be { team: [...] } wrapper or direct array
      const team = parsed?.team ?? (Array.isArray(parsed) ? parsed : null);
      if (team && Array.isArray(team) && team.length > 0 && team[0]?.name) {
        return team as MissionTeamData[];
      }
    } catch { /* not valid JSON */ }
  }

  return null;
}
