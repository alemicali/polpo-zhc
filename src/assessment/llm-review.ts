/**
 * G-Eval LLM-as-Judge review using pi-ai.
 *
 * Architecture: 2-phase review for reliability.
 *
 * Phase 1 — EXPLORATION (tool loop)
 *   The reviewer explores the codebase using read_file, glob, grep.
 *   No submit_review tool is available — the LLM just investigates freely.
 *   After exploration, we collect all assistant text as the "analysis".
 *
 * Phase 2 — SCORING (forced structured output)
 *   A separate LLM call receives the full analysis from Phase 1
 *   and MUST call submit_review. We force this via toolChoice where
 *   supported, and via strong prompting + retry as fallback.
 *
 * This separation makes the system robust: exploration failures don't
 * block scoring, and scoring failures are isolated from exploration.
 *
 * Runs 3 independent reviewers in parallel (multi-evaluator consensus).
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { Type } from "@sinclair/typebox";
import type { TaskExpectation, EvalDimension, DimensionScore, CheckResult, ReviewContext, ReviewerMessage } from "../core/types.js";
import { DEFAULT_DIMENSIONS, buildRubricSection, computeWeightedScore, computeMedianScores } from "./scoring.js";
import { validateReviewPayload, REVIEW_JSON_SCHEMA, type ValidatedReviewPayload } from "./schemas.js";
import { withRetry } from "../llm/retry.js";
import { resolveModel, resolveApiKeyAsync, buildStreamOpts } from "../llm/pi-client.js";
import type { ReasoningLevel } from "../core/types.js";
import { complete, completeSimple, type AssistantMessage, type Message, type Tool } from "@mariozechner/pi-ai";

export type LLMQueryFn = (prompt: string, cwd: string) => Promise<string>;

interface ReviewPayload {
  scores: { dimension: string; score: number; reasoning: string; evidence?: { file: string; line: number; note: string }[] }[];
  summary: string;
  /** Phase 1 exploration trace — carried through for persistence */
  exploration?: {
    analysis: string;
    filesRead: string[];
    messages: import("../core/types.js").ReviewerMessage[];
  };
  /** Errors from Phase 2 scoring strategy attempts */
  scoringAttemptErrors?: string[];
}

// ── Tool Definitions ───────────────────────────────────────────────────

const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file. Returns numbered lines.",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to project root" }),
    limit: Type.Optional(Type.Number({ description: "Max lines to read (default: 500)" })),
  }),
};

const globTool: Tool = {
  name: "glob",
  description: "Find files matching a pattern. Returns file paths.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Glob pattern (e.g. '*.ts', 'src/**/*.js')" }),
  }),
};

const grepTool: Tool = {
  name: "grep",
  description: "Search for a pattern in files. Returns matching lines with paths and line numbers.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Regex pattern to search for" }),
    include: Type.Optional(Type.String({ description: "File glob filter (e.g. '*.ts')" })),
  }),
};

const EXPLORATION_TOOLS: Tool[] = [readFileTool, globTool, grepTool];

const submitReviewTool: Tool = {
  name: "submit_review",
  description: `Submit your final structured code review scores. You MUST call this tool with scores for every dimension.
Each dimension must be scored 1-5 based on the rubric. Each reasoning MUST include specific file:line references.`,
  parameters: Type.Object({
    scores: Type.Array(Type.Object({
      dimension: Type.String({ description: "Dimension name from the rubric" }),
      score: Type.Number({ description: "Score 1-5" }),
      reasoning: Type.String({ description: "Brief reasoning with specific file:line code evidence" }),
      evidence: Type.Optional(Type.Array(Type.Object({
        file: Type.String({ description: "File path relative to project root" }),
        line: Type.Number({ description: "Line number" }),
        note: Type.String({ description: "What this line demonstrates" }),
      }))),
    })),
    summary: Type.String({ description: "Overall review summary" }),
  }),
};

// ── Tool Execution ─────────────────────────────────────────────────────

function executeExplorationTool(
  toolName: string,
  args: Record<string, any>,
  cwd: string,
): string {
  switch (toolName) {
    case "read_file": {
      const filePath = resolve(cwd, args.path);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const lines = raw.split("\n");
        const limit = args.limit ?? 500;
        const sliced = lines.slice(0, limit);
        return sliced.map((l, i) => `${i + 1}\t${l}`).join("\n") +
          (lines.length > limit ? `\n... (${lines.length - limit} more lines)` : "");
      } catch (err) {
        return `Error reading ${args.path}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "glob": {
      try {
        const result = execSync(
          `find ${JSON.stringify(cwd)} -type f -name ${JSON.stringify(args.pattern)} 2>/dev/null | head -200`,
          { encoding: "utf-8", timeout: 10_000 },
        ).trim();
        return result ? result.split("\n").map(f => relative(cwd, f)).join("\n") : "No files found";
      } catch {
        return "No files found";
      }
    }
    case "grep": {
      const includeFlag = args.include ? `--include=${JSON.stringify(args.include)}` : "";
      try {
        const result = execSync(
          `grep -rn ${includeFlag} -E ${JSON.stringify(args.pattern)} ${JSON.stringify(cwd)} 2>/dev/null | head -100`,
          { encoding: "utf-8", timeout: 15_000 },
        ).trim();
        return result || "No matches found";
      } catch {
        return "No matches found";
      }
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ── Phase 1: Exploration ───────────────────────────────────────────────

const MAX_EXPLORATION_TURNS = 20;
const NUDGE_AT_TURN = 15;

/** Convert pi-ai Message[] to serializable ReviewerMessage[] */
function serializeMessages(messages: Message[]): ReviewerMessage[] {
  return messages.map(msg => {
    if (msg.role === "user") {
      return {
        role: "user" as const,
        content: typeof msg.content === "string" ? msg.content : msg.content.map(c => c.type === "text" ? c.text : `[image: ${c.mimeType}]`).join("\n"),
        timestamp: msg.timestamp,
      };
    }
    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: ReviewerMessage["toolCalls"] = [];
      for (const block of msg.content) {
        if (block.type === "text") textParts.push(block.text);
        if (block.type === "thinking") textParts.push(`<thinking>${block.thinking}</thinking>`);
        if (block.type === "toolCall") toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments });
      }
      return {
        role: "assistant" as const,
        content: textParts.join("\n"),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        timestamp: msg.timestamp,
      };
    }
    // toolResult
    return {
      role: "toolResult" as const,
      content: msg.content.map(c => c.type === "text" ? c.text : `[image: ${c.mimeType}]`).join("\n"),
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      isError: msg.isError,
      timestamp: msg.timestamp,
    };
  });
}

/**
 * Phase 1: Let the reviewer freely explore the codebase.
 * Returns the accumulated analysis text from all assistant messages.
 */
async function runExploration(
  reviewPrompt: string,
  cwd: string,
  model: string | undefined,
  onProgress?: (msg: string) => void,
  reasoning?: ReasoningLevel,
): Promise<{ analysis: string; filesRead: string[]; messages: ReviewerMessage[] }> {
  const m = resolveModel(model);
  const apiKey = await resolveApiKeyAsync(m.provider as string);
  const opts = buildStreamOpts(apiKey, reasoning, m.maxTokens);

  const filesRead: string[] = [];

  const messages: Message[] = [
    { role: "user", content: reviewPrompt, timestamp: Date.now() },
  ];

  for (let turn = 0; turn < MAX_EXPLORATION_TURNS; turn++) {
    // Nudge at turn threshold to wrap up exploration
    if (turn === NUDGE_AT_TURN) {
      messages.push({
        role: "user",
        content: "You have explored enough. Please finish reading any last critical files. After this, you will be asked to submit your scores.",
        timestamp: Date.now(),
      });
    }

    const response = await completeSimple(m, {
      systemPrompt: "You are a thorough code reviewer. Use tools to explore the codebase. Focus on finding evidence for each evaluation dimension. Do NOT attempt to output scores as text — you will be given a dedicated scoring step after exploration.",
      messages,
      tools: EXPLORATION_TOOLS,
    }, opts);

    messages.push(response);

    const toolCalls = response.content.filter(
      (c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
        c.type === "toolCall"
    );

    // No more tool calls — exploration is done
    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      if (call.name === "read_file") {
        const file = String(call.arguments?.path ?? "");
        filesRead.push(file);
        onProgress?.(`Reading ${file.split("/").pop()}`);
      } else if (call.name === "glob") {
        onProgress?.(`Searching ${call.arguments?.pattern}`);
      } else if (call.name === "grep") {
        onProgress?.(`Grep: ${String(call.arguments?.pattern ?? "").slice(0, 30)}`);
      }

      const resultText = executeExplorationTool(call.name, call.arguments, cwd);
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: resultText }],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }

  // Collect all assistant text as the analysis
  const analysisBlocks: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const assistantMsg = msg as AssistantMessage;
    for (const block of assistantMsg.content) {
      if (block.type === "text" && block.text.trim()) {
        analysisBlocks.push(block.text);
      }
    }
  }

  return {
    analysis: analysisBlocks.join("\n\n") || "The reviewer explored the codebase but produced no written analysis.",
    filesRead,
    messages: serializeMessages(messages),
  };
}

// ── Phase 2: Scoring ───────────────────────────────────────────────────

const SCORING_SYSTEM_PROMPT = `You are a code review scorer. You have received a detailed analysis of code from Phase 1.
Your ONLY job is to convert this analysis into structured scores by calling the submit_review tool.
You MUST call submit_review exactly once. Do NOT output text — ONLY call the tool.`;

/**
 * Phase 2: Given the exploration analysis, force the model to produce
 * structured scores via the submit_review tool.
 *
 * Strategy:
 * 1. Try with toolChoice forced to submit_review (provider-specific)
 * 2. If that fails or isn't supported, try with strong prompting (no toolChoice)
 * 3. If model outputs text instead of tool call, try parsing JSON from text
 */
async function runScoring(
  analysis: string,
  rubricSection: string,
  dimNames: string,
  model: string | undefined,
  onProgress?: (msg: string) => void,
  reasoning?: ReasoningLevel,
): Promise<{ payload: ReviewPayload | null; attemptErrors: string[] }> {
  const m = resolveModel(model);
  const apiKey = await resolveApiKeyAsync(m.provider as string);

  const scoringPrompt = `Based on the following code analysis, score each dimension and call submit_review.

ANALYSIS FROM CODE EXPLORATION:
${analysis.slice(0, 12000)}

EVALUATION DIMENSIONS AND RUBRICS:
${rubricSection}

DIMENSIONS TO SCORE: ${dimNames}

RULES:
- Score each dimension 1-5 as an integer.
- Your reasoning MUST reference specific file:line evidence from the analysis above.
- Call the submit_review tool with ALL dimension scores and a summary.
- Do NOT output text. ONLY call submit_review.`;

  const messages: Message[] = [
    { role: "user", content: scoringPrompt, timestamp: Date.now() },
  ];

  const context = {
    systemPrompt: SCORING_SYSTEM_PROMPT,
    messages,
    tools: [submitReviewTool],
  };

  // Build reasoning option for scoring (reasoning helps produce better structured evaluations)
  const reasoningVal = reasoning && reasoning !== "off" ? reasoning : undefined;

  // Track failures for debugging
  const attemptErrors: string[] = [];

  // Helper: extract text from response for fallback parsing
  const extractText = (response: AssistantMessage): string =>
    response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map(b => b.text).join("\n");

  // Strategy 1: Force toolChoice (works on Anthropic, OpenAI completions, Bedrock)
  onProgress?.("Scoring with forced tool choice...");
  try {
    const response = await complete(m, context, {
      apiKey,
      toolChoice: { type: "tool", name: "submit_review" },
      ...(reasoningVal ? { reasoning: reasoningVal } : {}),
    } as any);

    const payload = extractSubmitReview(response);
    if (payload) return { payload, attemptErrors };

    // toolChoice worked but extraction/validation failed — try text fallback
    const fallbackText = extractText(response);
    const fallback = tryParseReviewJSON(fallbackText);
    if (fallback) return { payload: fallback, attemptErrors };

    attemptErrors.push(`Strategy 1 (toolChoice): tool call received but Zod validation failed. Response types: ${response.content.map(c => c.type).join(", ")}`);
  } catch (err) {
    attemptErrors.push(`Strategy 1 (toolChoice): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Strategy 2: Strong prompting without toolChoice (cross-provider fallback)
  onProgress?.("Scoring with prompt-based enforcement...");
  try {
    const response = await completeSimple(m, context, buildStreamOpts(apiKey, reasoning, m.maxTokens));

    // Check for tool call first
    const payload = extractSubmitReview(response);
    if (payload) return { payload, attemptErrors };

    // Check for text-based JSON fallback
    const fullText = extractText(response);
    const parsed = tryParseReviewJSON(fullText);
    if (parsed) return { payload: parsed, attemptErrors };
    attemptErrors.push(`Strategy 2 (prompt): no tool call, text fallback failed. Response types: ${response.content.map(c => c.type).join(", ")}. Text length: ${fullText.length}`);
  } catch (err) {
    attemptErrors.push(`Strategy 2 (prompt): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Strategy 3: Pure JSON output — no tools, just raw JSON request
  onProgress?.("Fallback: requesting raw JSON scores...");
  try {
    const jsonMessages: Message[] = [
      {
        role: "user",
        content: `Score these dimensions based on the analysis below. Return ONLY a JSON object, no other text.

DIMENSIONS: ${dimNames}

ANALYSIS:
${analysis.slice(0, 8000)}

Return this exact JSON structure (nothing else):
{"scores":[{"dimension":"<name>","score":<1-5>,"reasoning":"<brief>"}],"summary":"<overall summary>"}`,
        timestamp: Date.now(),
      },
    ];
    const response = await completeSimple(m, {
      systemPrompt: "You are a JSON-only scorer. Output ONLY valid JSON matching the requested schema. No markdown fences, no explanations, no commentary — just the raw JSON object.",
      messages: jsonMessages,
      tools: [],
    }, buildStreamOpts(apiKey, reasoning, m.maxTokens));

    const fullText = extractText(response);
    const parsed = tryParseReviewJSON(fullText);
    if (parsed) return { payload: parsed, attemptErrors };
    attemptErrors.push(`Strategy 3 (raw JSON): parse failed. Text preview: ${fullText.slice(0, 200)}`);
  } catch (err) {
    attemptErrors.push(`Strategy 3 (raw JSON): ${err instanceof Error ? err.message : String(err)}`);
  }

  // All strategies failed — report details
  onProgress?.(`All scoring strategies failed (provider: ${m.provider}, api: ${m.api}):\n${attemptErrors.join("\n")}`);
  return { payload: null, attemptErrors };
}

/** Extract ReviewPayload from a submit_review tool call in the response, validated with Zod. */
function extractSubmitReview(response: AssistantMessage): ReviewPayload | null {
  for (const block of response.content) {
    if (block.type === "toolCall" && block.name === "submit_review") {
      const result = validateReviewPayload(block.arguments);
      if (result.success) {
        return result.data as ReviewPayload;
      }
    }
  }
  return null;
}

/** Try to extract a ReviewPayload from free-text JSON output, validated with Zod. */
function tryParseReviewJSON(output: string): ReviewPayload | null {
  if (!output || !output.trim()) return null;
  let text = output.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Find the outermost JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let jsonStr = jsonMatch[0];

  // Common LLM JSON quirks: trailing commas, single quotes, comments
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1");                      // trailing commas
  jsonStr = jsonStr.replace(/\/\/[^\n]*/g, "");                          // single-line comments
  jsonStr = jsonStr.replace(/\/\*[\s\S]*?\*\//g, "");                   // block comments

  // Try parsing and validating with Zod
  const tryParse = (s: string): ReviewPayload | null => {
    try {
      const parsed = JSON.parse(s);
      const result = validateReviewPayload(parsed);
      if (result.success) return result.data as ReviewPayload;
    } catch { /* fall through */ }
    return null;
  };

  // Attempt 1: direct parse
  const direct = tryParse(jsonStr);
  if (direct) return direct;

  // Attempt 2: replace single quotes with double quotes (common LLM mistake)
  if (!jsonStr.includes('"') && jsonStr.includes("'")) {
    const doubleQuoted = jsonStr.replace(/'/g, '"');
    const sq = tryParse(doubleQuoted);
    if (sq) return sq;
  }

  return null;
}

// ── Combined Single Review (Phase 1 + Phase 2) ────────────────────────

async function runSingleReview(
  explorationPrompt: string,
  rubricSection: string,
  dimNames: string,
  cwd: string,
  model: string | undefined,
  onProgress?: (msg: string) => void,
  reasoning?: ReasoningLevel,
  skipExploration?: boolean,
): Promise<ReviewPayload | null> {
  let analysis: string;
  let filesRead: string[] = [];
  let explorationMessages: ReviewerMessage[] = [];

  if (skipExploration) {
    // Output-based review: the prompt already contains all the evidence.
    // Run a single LLM call to produce the analysis from the provided context.
    onProgress?.("Analyzing execution evidence (no file exploration needed)...");
    const m = resolveModel(model);
    const apiKey = await resolveApiKeyAsync(m.provider as string);
    const opts = buildStreamOpts(apiKey, reasoning, m.maxTokens);

    const messages: Message[] = [
      { role: "user", content: explorationPrompt, timestamp: Date.now() },
    ];

    const response = await completeSimple(m, {
      systemPrompt: "You are a thorough reviewer. Analyze the provided execution evidence and write a detailed assessment for each evaluation dimension. Do NOT attempt to output scores as text — you will be given a dedicated scoring step after your analysis.",
      messages,
      tools: [], // No tools — all evidence is in the prompt
    }, opts);

    // Extract analysis text
    const analysisBlocks: string[] = [];
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        analysisBlocks.push(block.text);
      }
    }
    analysis = analysisBlocks.join("\n\n") || "The reviewer analyzed the execution evidence but produced no written analysis.";
    explorationMessages = serializeMessages([...messages, response]);
  } else {
    // File-based review: explore the codebase with tools
    onProgress?.("Phase 1: Exploring codebase...");
    const result = await runExploration(explorationPrompt, cwd, model, onProgress, reasoning);
    analysis = result.analysis;
    filesRead = result.filesRead;
    explorationMessages = result.messages;
    onProgress?.(`Exploration complete — read ${filesRead.length} files, ${analysis.length} chars of analysis.`);
  }

  // Phase 2: Score
  onProgress?.("Phase 2: Producing structured scores...");
  const { payload, attemptErrors } = await runScoring(analysis, rubricSection, dimNames, model, onProgress, reasoning);

  if (payload) {
    onProgress?.(`Scoring complete — ${payload.scores.length} dimensions scored.`);
    // Attach exploration trace and scoring attempt errors to the payload
    payload.exploration = { analysis, filesRead, messages: explorationMessages };
    if (attemptErrors.length > 0) payload.scoringAttemptErrors = attemptErrors;
    return payload;
  } else {
    onProgress?.("Scoring failed — reviewer could not produce structured scores.");
    return null;
  }
}

// ── Single Review with Retry ───────────────────────────────────────────

async function runSingleReviewWithRetry(
  explorationPrompt: string,
  rubricSection: string,
  dimNames: string,
  cwd: string,
  model: string | undefined,
  onProgress?: (msg: string) => void,
  reasoning?: ReasoningLevel,
  skipExploration?: boolean,
): Promise<ReviewPayload | null> {
  try {
    return await withRetry(
      async () => {
        const result = await runSingleReview(explorationPrompt, rubricSection, dimNames, cwd, model, onProgress, reasoning, skipExploration);
        if (!result) throw new Error("Reviewer produced no structured result after Phase 1 + Phase 2");
        return result;
      },
      { maxRetries: 1, initialDelayMs: 2000, checkTransient: false },
    );
  } catch (err) {
    onProgress?.(`Reviewer failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Context Classification ─────────────────────────────────────────────

/**
 * Determine if this review involves file changes that need filesystem exploration,
 * or if the execution evidence (stdout, transcript, outcomes) is sufficient.
 */
function hasFileChanges(context?: ReviewContext): boolean {
  if (!context) return true; // conservative: explore when unknown
  return (context.filesCreated?.length ?? 0) > 0 || (context.filesEdited?.length ?? 0) > 0;
}

// ── Prompt Builder (Phase 1 only — no submit_review instructions) ──────

function buildContextSection(context?: ReviewContext): string {
  if (!context) return "";

  const parts: string[] = [
    `TASK CONTEXT:`,
    `Title: ${context.taskTitle}`,
    `Description: ${context.taskDescription}`,
  ];

  if (context.exitCode !== undefined) parts.push(`Exit code: ${context.exitCode}`);
  if (context.duration !== undefined) parts.push(`Duration: ${Math.round(context.duration / 1000)}s`);
  if (context.toolCalls !== undefined) parts.push(`Total tool calls: ${context.toolCalls}`);
  if (context.toolsSummary) parts.push(`Tools used: ${context.toolsSummary}`);

  if (context.filesCreated?.length) parts.push(`\nFiles created by agent: ${context.filesCreated.join(", ")}`);
  if (context.filesEdited?.length) parts.push(`Files edited by agent: ${context.filesEdited.join(", ")}`);

  if (context.outcomes?.length) {
    parts.push(`\nREGISTERED OUTCOMES:`);
    for (const o of context.outcomes) {
      let desc = `- [${o.type}] ${o.label}`;
      if (o.path) desc += ` (${o.path})`;
      if (o.url) desc += ` → ${o.url}`;
      if (o.text) desc += `: ${o.text.slice(0, 300)}${o.text.length > 300 ? "..." : ""}`;
      parts.push(desc);
    }
  }

  if (context.executionSummary) {
    parts.push(`\n${context.executionSummary}`);
  }

  if (context.agentOutput) {
    parts.push(`\nAGENT FINAL OUTPUT:\n${context.agentOutput.slice(-3000)}`);
  }

  if (context.agentStderr) {
    parts.push(`\nAGENT STDERR:\n${context.agentStderr.slice(-1000)}`);
  }

  return parts.join("\n");
}

function buildExplorationPrompt(
  criteria: string,
  rubricSection: string,
  dimNames: string,
  context?: ReviewContext,
): string {
  const contextSection = buildContextSection(context);

  return `You are a senior code reviewer performing a G-Eval evaluation.
Your task is to EXPLORE the codebase and build a detailed analysis for each evaluation dimension.

ACCEPTANCE CRITERIA:
${criteria}

${contextSection}

EVALUATION DIMENSIONS:
${rubricSection}

INSTRUCTIONS:
1. Use read_file, glob, and grep tools to explore the codebase and find relevant files.
2. Start by examining the files listed above (created/edited by the agent) — they are the primary evidence.
3. Read the code carefully and understand what it does relative to the acceptance criteria.
4. For EACH dimension (${dimNames}), write your analysis noting:
   - Specific file:line references as evidence
   - How the code performs on this dimension
   - What score (1-5) you would give based on the rubric
5. Be thorough — read all relevant files before concluding.

OUTPUT:
Write your analysis as free text. Include specific file:line references for each dimension.
You will be asked to submit structured scores in a separate step after exploration.`;
}

/**
 * Build a prompt for output-based review (no file exploration needed).
 * Used when the agent worked via external tools, APIs, or text output only.
 */
function buildOutputBasedReviewPrompt(
  criteria: string,
  rubricSection: string,
  dimNames: string,
  context: ReviewContext,
): string {
  const contextSection = buildContextSection(context);

  return `You are a senior reviewer performing a G-Eval evaluation.
The agent completed a task that did NOT produce file changes on disk. Instead, the agent's work
is evidenced by its execution timeline, tool usage, registered outcomes, and text output below.

ACCEPTANCE CRITERIA:
${criteria}

${contextSection}

EVALUATION DIMENSIONS:
${rubricSection}

INSTRUCTIONS:
1. Carefully review the execution timeline, agent output, and registered outcomes above.
2. Assess whether the agent correctly completed the task based on the acceptance criteria.
3. For EACH dimension (${dimNames}), write your analysis noting:
   - Specific evidence from the execution timeline or agent output
   - How the agent's work performs on this dimension
   - What score (1-5) you would give based on the rubric
4. Note: the agent may have used external tools (email, APIs, web requests, etc.) — the tool call
   results in the timeline ARE the evidence of work. Do NOT penalize for lack of file changes.

OUTPUT:
Write your analysis as free text. Reference specific timeline entries or output sections as evidence.
You will be asked to submit structured scores in a separate step.`;
}

// ── CheckResult Builder ────────────────────────────────────────────────

function buildCheckResult(
  parsed: ReviewPayload,
  dimensions: import("../core/types.js").EvalDimension[],
  threshold: number,
  individualReviews?: ReviewPayload[],
): CheckResult {
  const dimScores: DimensionScore[] = parsed.scores.map(s => {
    const dim = dimensions.find(d => d.name === s.dimension);
    return {
      dimension: s.dimension,
      score: Math.max(1, Math.min(5, Math.round(s.score))),
      reasoning: s.reasoning,
      weight: dim?.weight ?? (1 / dimensions.length),
      evidence: s.evidence,
    };
  });

  const globalScore = computeWeightedScore(dimScores);
  const passed = globalScore >= threshold;

  const scoreLines = dimScores.map(s =>
    `  ${s.dimension}: ${s.score}/5 (weight: ${s.weight}) — ${s.reasoning}`
  ).join("\n");
  const details = `Global score: ${globalScore.toFixed(2)}/5 (threshold: ${threshold})\n\n${scoreLines}\n\nSummary: ${parsed.summary}`;

  const msg = passed
    ? `Score ${globalScore.toFixed(1)}/5 — ${parsed.summary.slice(0, 100)}`
    : `Score ${globalScore.toFixed(1)}/5 (below ${threshold}) — ${parsed.summary.slice(0, 100)}`;

  // Build individual reviewer results for transparency
  const reviewers: import("../core/types.js").ReviewerResult[] | undefined = individualReviews?.map((review, i) => {
    const reviewDimScores: DimensionScore[] = review.scores.map(s => {
      const dim = dimensions.find(d => d.name === s.dimension);
      return {
        dimension: s.dimension,
        score: Math.max(1, Math.min(5, Math.round(s.score))),
        reasoning: s.reasoning,
        weight: dim?.weight ?? (1 / dimensions.length),
        evidence: s.evidence,
      };
    });
    return {
      index: i + 1,
      scores: review.scores,
      summary: review.summary,
      globalScore: Math.round(computeWeightedScore(reviewDimScores) * 100) / 100,
      exploration: review.exploration,
      scoringAttemptErrors: review.scoringAttemptErrors,
    };
  });

  return {
    type: "llm_review",
    passed,
    message: msg,
    details,
    scores: dimScores,
    globalScore: Math.round(globalScore * 100) / 100,
    reviewers,
  };
}

// ── Dynamic Dimension Generation ───────────────────────────────────────

/**
 * Ask the LLM to generate 3-4 evaluation dimensions tailored to the specific task.
 * Falls back to DEFAULT_DIMENSIONS if the LLM call fails or returns invalid data.
 */
async function generateDimensions(
  context: ReviewContext | undefined,
  model: string | undefined,
  onProgress?: (msg: string) => void,
): Promise<EvalDimension[]> {
  if (!context?.taskTitle) return DEFAULT_DIMENSIONS;

  onProgress?.("Generating task-specific evaluation dimensions...");

  try {
    const m = resolveModel(model);
    const apiKey = await resolveApiKeyAsync(m.provider as string);

    const messages: Message[] = [
      {
        role: "user",
        content: `Generate 3-4 evaluation dimensions for assessing the following task. Each dimension must be specific and relevant to THIS task — do NOT use generic coding metrics unless the task is about writing code.

TASK TITLE: ${context.taskTitle}
TASK DESCRIPTION: ${context.taskDescription}
${context.filesCreated?.length ? `FILES CREATED: ${context.filesCreated.join(", ")}` : ""}

Return ONLY a JSON array (no markdown fences, no explanation). Each element must have:
- "name": snake_case identifier (e.g. "visual_quality", "data_accuracy")  
- "description": one sentence explaining what this dimension measures
- "weight": number 0.15-0.40 (all weights must sum to 1.0)
- "rubric": object with keys 1-5, each a one-sentence description for that score level

Example for an image generation task:
[{"name":"visual_quality","description":"Is the generated image sharp, well-composed, and visually appealing?","weight":0.30,"rubric":{"1":"Unusable — heavily distorted or corrupted","2":"Poor quality — major visual artifacts","3":"Acceptable — meets basic standards","4":"Good — clean and well-composed","5":"Excellent — professional-grade visual quality"}},{"name":"prompt_adherence","description":"Does the image match the requested subject, style, and details?","weight":0.35,"rubric":{"1":"Completely ignores the prompt","2":"Loosely related but misses key elements","3":"Partially matches — some elements present","4":"Good match — most details captured","5":"Perfect match — every detail faithfully rendered"}},{"name":"completeness","description":"Are all requested deliverables produced in the correct formats?","weight":0.35,"rubric":{"1":"No deliverables produced","2":"Partial output — missing files or formats","3":"Core deliverables present but extras missing","4":"Nearly complete — minor omissions","5":"All deliverables produced correctly"}}]`,
        timestamp: Date.now(),
      },
    ];

    const response = await completeSimple(m, {
      systemPrompt: "You are an evaluation expert. Output ONLY a valid JSON array. No markdown fences, no explanations.",
      messages,
      tools: [],
    }, buildStreamOpts(apiKey, undefined, m.maxTokens));

    // Extract text from response
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    text = text.trim();

    // Strip markdown fences if present
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 6) {
      throw new Error(`Expected 2-6 dimensions, got ${Array.isArray(parsed) ? parsed.length : typeof parsed}`);
    }

    // Validate and normalize
    const dimensions: EvalDimension[] = [];
    let totalWeight = 0;
    for (const d of parsed) {
      if (!d.name || !d.description || typeof d.weight !== "number") continue;
      const rubric: Record<number, string> = {};
      if (d.rubric && typeof d.rubric === "object") {
        for (const [k, v] of Object.entries(d.rubric)) {
          const num = Number(k);
          if (num >= 1 && num <= 5 && typeof v === "string") rubric[num] = v;
        }
      }
      dimensions.push({
        name: String(d.name),
        description: String(d.description),
        weight: d.weight,
        ...(Object.keys(rubric).length > 0 ? { rubric } : {}),
      });
      totalWeight += d.weight;
    }

    if (dimensions.length < 2) {
      throw new Error(`Only ${dimensions.length} valid dimensions parsed`);
    }

    // Normalize weights to sum to 1.0
    if (Math.abs(totalWeight - 1.0) > 0.01) {
      for (const dim of dimensions) {
        dim.weight = dim.weight / totalWeight;
      }
    }

    onProgress?.(`Generated ${dimensions.length} task-specific dimensions: ${dimensions.map(d => d.name).join(", ")}`);
    return dimensions;
  } catch (err) {
    onProgress?.(`Dimension generation failed (${err instanceof Error ? err.message : String(err)}), using defaults.`);
    return DEFAULT_DIMENSIONS;
  }
}

// ── Main Entry Point ───────────────────────────────────────────────────

/**
 * Run a G-Eval LLM-as-Judge review (2-phase architecture).
 *
 * Phase 1: Each reviewer explores the codebase with tools (read_file, glob, grep).
 * Phase 2: A forced scoring call extracts structured scores from the analysis.
 *
 * Runs 3 independent reviewers in parallel (multi-evaluator consensus).
 * Falls back to single-reviewer if <2 succeed.
 */
export async function runLLMReview(
  expectation: TaskExpectation,
  cwd: string,
  onProgress?: (msg: string) => void,
  context?: ReviewContext,
  reasoning?: ReasoningLevel,
): Promise<CheckResult> {
  const criteria = expectation.criteria || "The work should be correct, well-structured, and meet the task requirements.";
  const threshold = expectation.threshold ?? 3.0;

  const reviewModel = process.env.POLPO_JUDGE_MODEL || process.env.POLPO_MODEL || "anthropic:claude-sonnet-4-5";

  // Generate task-specific dimensions via LLM when not explicitly provided
  const dimensions = expectation.dimensions ?? await generateDimensions(context, reviewModel, onProgress);

  const dimNames = dimensions.map((d: EvalDimension) => d.name).join(", ");
  const rubricSection = buildRubricSection(dimensions);

  // Decide review mode: file-based (with exploration) or output-based (no exploration)
  const needsExploration = hasFileChanges(context);
  const skipExploration = !needsExploration;

  const reviewPrompt = needsExploration
    ? buildExplorationPrompt(criteria, rubricSection, dimNames, context)
    : buildOutputBasedReviewPrompt(criteria, rubricSection, dimNames, context!);

  // Judge reasoning: explicit param > POLPO_JUDGE_REASONING env var > undefined
  const judgeReasoning = reasoning ?? (process.env.POLPO_JUDGE_REASONING as ReasoningLevel | undefined);

  const modeLabel = skipExploration ? "output-based" : "file-exploration";
  onProgress?.(`Starting 3 independent review agents (${modeLabel} → score)...`);

  // Stagger reviewers by 1s to reduce rate-limit collisions on same provider
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const settled = await Promise.allSettled([
    runSingleReviewWithRetry(reviewPrompt, rubricSection, dimNames, cwd, reviewModel, onProgress, judgeReasoning, skipExploration),
    delay(1000).then(() => runSingleReviewWithRetry(reviewPrompt, rubricSection, dimNames, cwd, reviewModel, onProgress, judgeReasoning, skipExploration)),
    delay(2000).then(() => runSingleReviewWithRetry(reviewPrompt, rubricSection, dimNames, cwd, reviewModel, onProgress, judgeReasoning, skipExploration)),
  ]);

  const successfulReviews: ReviewPayload[] = [];
  const failures: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "fulfilled" && result.value) {
      successfulReviews.push(result.value);
    } else {
      const reason = result.status === "rejected"
        ? (result.reason instanceof Error ? result.reason.message : String(result.reason))
        : "Reviewer returned null — all scoring strategies failed";
      failures.push(reason);
      onProgress?.(`Reviewer ${i + 1}/3 failed: ${reason}`);
    }
  }

  if (successfulReviews.length >= 2) {
    onProgress?.(`Computing consensus from ${successfulReviews.length} reviewers...`);
    const consensus = computeMedianScores(successfulReviews, dimensions);
    return buildCheckResult(consensus, dimensions, threshold, successfulReviews);
  }

  if (successfulReviews.length === 1) {
    onProgress?.("Only 1 reviewer succeeded, using single review...");
    return buildCheckResult(successfulReviews[0], dimensions, threshold, successfulReviews);
  }

  const failureDetail = failures.length > 0
    ? `\n\nFailure reasons:\n${failures.map((f, i) => `  Reviewer ${i + 1}: ${f}`).join("\n")}`
    : "";
  const modelInfo = reviewModel ? ` (judge model: ${reviewModel})` : " (no explicit judge model — using default)";

  return {
    type: "llm_review",
    passed: false,
    message: `Review failed — all evaluators failed to produce structured scores${modelInfo}`,
    details: `All 3 reviewers failed after scoring strategies (toolChoice → prompt → raw JSON) × 2 retries each.${modelInfo}\n\nThis usually means: (1) the judge model doesn't support tool calling well, (2) API auth/rate-limit errors, or (3) the model can't produce valid JSON.\n\nTry: set POLPO_JUDGE_MODEL to a capable model (e.g. claude-sonnet-4-20250514, gpt-4o), check API keys, or reduce concurrent tasks.${failureDetail}`,
  };
}
