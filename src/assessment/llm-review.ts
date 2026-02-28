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
import type { TaskExpectation, DimensionScore, CheckResult, ReviewContext } from "../core/types.js";
import { DEFAULT_DIMENSIONS, buildRubricSection, computeWeightedScore, computeMedianScores } from "./scoring.js";
import { withRetry } from "../llm/retry.js";
import { resolveModel, resolveApiKeyAsync, buildStreamOpts } from "../llm/pi-client.js";
import type { ReasoningLevel } from "../core/types.js";
import { complete, completeSimple, type AssistantMessage, type Message, type Tool } from "@mariozechner/pi-ai";

export type LLMQueryFn = (prompt: string, cwd: string) => Promise<string>;

interface ReviewPayload {
  scores: { dimension: string; score: number; reasoning: string; evidence?: { file: string; line: number; note: string }[] }[];
  summary: string;
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
): Promise<{ analysis: string; filesRead: string[] }> {
  const m = resolveModel(model);
  const apiKey = await resolveApiKeyAsync(m.provider as string);
  const opts = buildStreamOpts(apiKey, reasoning);

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
): Promise<ReviewPayload | null> {
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

  // Detect provider API type for strategy selection
  const isOpenAI = m.api === "openai-completions" || m.api === "openai-responses";

  // ── JSON Schema for structured output (OpenAI response_format) ──
  // pi-ai doesn't natively support response_format, but the onPayload callback
  // lets us mutate the request params before they're sent to the API.
  const reviewJsonSchema = {
    type: "json_schema" as const,
    json_schema: {
      name: "review_scores",
      strict: true,
      schema: {
        type: "object",
        properties: {
          scores: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dimension: { type: "string", description: "Dimension name" },
                score: { type: "number", description: "Score 1-5" },
                reasoning: { type: "string", description: "Brief reasoning with file:line evidence" },
              },
              required: ["dimension", "score", "reasoning"],
              additionalProperties: false,
            },
          },
          summary: { type: "string", description: "Overall review summary" },
        },
        required: ["scores", "summary"],
        additionalProperties: false,
      },
    },
  };

  // Attempt 1: Force toolChoice (works on Anthropic, OpenAI completions, Bedrock)
  onProgress?.("Scoring with forced tool choice...");
  try {
    const response = await complete(m, context, {
      apiKey,
      toolChoice: { type: "tool", name: "submit_review" },
      ...(reasoningVal ? { reasoning: reasoningVal } : {}),
    } as any);

    const payload = extractSubmitReview(response);
    if (payload) return payload;
    attemptErrors.push(`Attempt 1 (toolChoice): tool call received but extraction failed. Response types: ${response.content.map(c => c.type).join(", ")}`);
  } catch (err) {
    attemptErrors.push(`Attempt 1 (toolChoice): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Attempt 2: Structured JSON output via response_format (OpenAI only)
  // For OpenAI providers, use the onPayload hack to inject response_format.
  // For others, fall through to prompt-based attempt.
  if (isOpenAI) {
    onProgress?.("Scoring with OpenAI structured output (json_schema)...");
    try {
      const jsonMessages: Message[] = [
        {
          role: "user",
          content: `Score these dimensions based on the code analysis below.

ANALYSIS:
${analysis.slice(0, 12000)}

DIMENSIONS AND RUBRICS:
${rubricSection}

DIMENSIONS TO SCORE: ${dimNames}

Score each dimension 1-5. Reference specific file:line evidence in your reasoning.
Return a JSON object with "scores" array and "summary" string.`,
          timestamp: Date.now(),
        },
      ];
      const response = await complete(m, {
        systemPrompt: "You are a code review scorer. Return structured JSON scores.",
        messages: jsonMessages,
        tools: [],
      }, {
        apiKey,
        ...(reasoningVal ? { reasoning: reasoningVal } : {}),
        // Inject response_format into the API request via onPayload mutation
        onPayload: (payload: any) => {
          payload.response_format = reviewJsonSchema;
        },
      } as any);

      const fullText = extractText(response);
      const parsed = tryParseReviewJSON(fullText);
      if (parsed) return parsed;
      attemptErrors.push(`Attempt 2 (json_schema): structured output parse failed. Text preview: ${fullText.slice(0, 200)}`);
    } catch (err) {
      attemptErrors.push(`Attempt 2 (json_schema): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Attempt 3: Strong prompting without toolChoice (cross-provider)
  onProgress?.("Scoring with prompt-based enforcement...");
  try {
    const response = await completeSimple(m, context, buildStreamOpts(apiKey, reasoning));

    // Check for tool call
    const payload = extractSubmitReview(response);
    if (payload) return payload;

    // Check for text-based JSON fallback
    const fullText = extractText(response);
    const parsed = tryParseReviewJSON(fullText);
    if (parsed) return parsed;
    attemptErrors.push(`Attempt 3 (prompt): no tool call, text fallback failed. Response types: ${response.content.map(c => c.type).join(", ")}. Text length: ${fullText.length}`);
  } catch (err) {
    attemptErrors.push(`Attempt 3 (prompt): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Attempt 4: Minimal forceful prompt — fresh context, tools available
  onProgress?.("Final scoring attempt (forceful)...");
  try {
    const forcefulMessages: Message[] = [
      {
        role: "user",
        content: `You MUST call the submit_review tool NOW with scores for these dimensions: ${dimNames}.
Based on this analysis: ${analysis.slice(0, 6000)}

Call submit_review immediately. No text output.`,
        timestamp: Date.now(),
      },
    ];
    const response = await completeSimple(m, {
      systemPrompt: "Call submit_review immediately with the scores. No other output.",
      messages: forcefulMessages,
      tools: [submitReviewTool],
    }, buildStreamOpts(apiKey, reasoning));

    const payload = extractSubmitReview(response);
    if (payload) return payload;

    const fullText = extractText(response);
    const parsed = tryParseReviewJSON(fullText);
    if (parsed) return parsed;
    attemptErrors.push(`Attempt 4 (forceful): no tool call, text fallback failed. Response types: ${response.content.map(c => c.type).join(", ")}. Text length: ${fullText.length}`);
  } catch (err) {
    attemptErrors.push(`Attempt 4 (forceful): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Attempt 5: Pure JSON output — no tools, no schema, just raw JSON request
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
    }, buildStreamOpts(apiKey, reasoning));

    const fullText = extractText(response);
    const parsed = tryParseReviewJSON(fullText);
    if (parsed) return parsed;
    attemptErrors.push(`Attempt 5 (raw JSON): parse failed. Text preview: ${fullText.slice(0, 200)}`);
  } catch (err) {
    attemptErrors.push(`Attempt 5 (raw JSON): ${err instanceof Error ? err.message : String(err)}`);
  }

  // All attempts failed — report details
  onProgress?.(`All scoring attempts failed (provider: ${m.provider}, api: ${m.api}):\n${attemptErrors.join("\n")}`);
  return null;
}

/** Extract ReviewPayload from a submit_review tool call in the response. */
function extractSubmitReview(response: AssistantMessage): ReviewPayload | null {
  for (const block of response.content) {
    if (block.type === "toolCall" && block.name === "submit_review") {
      const args = block.arguments as Record<string, any>;
      if (args?.scores && Array.isArray(args.scores) && args.scores.length > 0) {
        return args as ReviewPayload;
      }
    }
  }
  return null;
}

/** Try to extract a ReviewPayload from free-text JSON output. */
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

  // Try parsing as-is first
  const tryParse = (s: string): ReviewPayload | null => {
    try {
      const parsed = JSON.parse(s);
      if (parsed.scores && Array.isArray(parsed.scores) && parsed.scores.length > 0) {
        // Ensure each score has required fields, fill defaults
        const validScores = parsed.scores.filter(
          (s: any) => s && typeof s.dimension === "string" && typeof s.score === "number",
        ).map((s: any) => ({
          dimension: s.dimension,
          score: Math.max(1, Math.min(5, Math.round(s.score))),  // clamp 1-5
          reasoning: s.reasoning || s.reason || s.explanation || "(no reasoning provided)",
          ...(s.evidence ? { evidence: s.evidence } : {}),
        }));
        if (validScores.length > 0) {
          return { scores: validScores, summary: parsed.summary || "(no summary)" };
        }
      }
    } catch { /* fall through */ }
    return null;
  };

  // Attempt 1: direct parse
  const direct = tryParse(jsonStr);
  if (direct) return direct;

  // Attempt 2: replace single quotes with double quotes (common LLM mistake)
  // Only do this if there are no double quotes in the string (to avoid breaking valid JSON)
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
): Promise<ReviewPayload | null> {
  // Phase 1: Explore
  onProgress?.("Phase 1: Exploring codebase...");
  const { analysis, filesRead } = await runExploration(explorationPrompt, cwd, model, onProgress, reasoning);
  onProgress?.(`Exploration complete — read ${filesRead.length} files, ${analysis.length} chars of analysis.`);

  // Phase 2: Score
  onProgress?.("Phase 2: Producing structured scores...");
  const payload = await runScoring(analysis, rubricSection, dimNames, model, onProgress, reasoning);

  if (payload) {
    onProgress?.(`Scoring complete — ${payload.scores.length} dimensions scored.`);
  } else {
    onProgress?.("Scoring failed — reviewer could not produce structured scores.");
  }

  return payload;
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
): Promise<ReviewPayload | null> {
  try {
    return await withRetry(
      async () => {
        const result = await runSingleReview(explorationPrompt, rubricSection, dimNames, cwd, model, onProgress, reasoning);
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

// ── Prompt Builder (Phase 1 only — no submit_review instructions) ──────

function buildExplorationPrompt(
  criteria: string,
  rubricSection: string,
  dimNames: string,
  context?: ReviewContext,
): string {
  const contextSection = context ? `
TASK CONTEXT:
Title: ${context.taskTitle}
Description: ${context.taskDescription}
${context.filesCreated?.length ? `\nFiles created by agent: ${context.filesCreated.join(", ")}` : ""}${context.filesEdited?.length ? `\nFiles edited by agent: ${context.filesEdited.join(", ")}` : ""}
${context.agentOutput ? `\nAGENT OUTPUT (last 2000 chars):\n${context.agentOutput.slice(-2000)}` : ""}
` : "";

  return `You are a senior code reviewer performing a G-Eval evaluation.
Your task is to EXPLORE the codebase and build a detailed analysis for each evaluation dimension.

ACCEPTANCE CRITERIA:
${criteria}
${contextSection}
EVALUATION DIMENSIONS:
${rubricSection}

INSTRUCTIONS:
1. Use read_file, glob, and grep tools to explore the codebase and find relevant files.
2. Read the code carefully and understand what it does relative to the acceptance criteria.
3. For EACH dimension (${dimNames}), write your analysis noting:
   - Specific file:line references as evidence
   - How the code performs on this dimension
   - What score (1-5) you would give based on the rubric
4. Be thorough — read all relevant files before concluding.

OUTPUT:
Write your analysis as free text. Include specific file:line references for each dimension.
You will be asked to submit structured scores in a separate step after exploration.`;
}

// ── CheckResult Builder ────────────────────────────────────────────────

function buildCheckResult(
  parsed: ReviewPayload,
  dimensions: import("../core/types.js").EvalDimension[],
  threshold: number,
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

  return {
    type: "llm_review",
    passed,
    message: msg,
    details,
    scores: dimScores,
    globalScore: Math.round(globalScore * 100) / 100,
  };
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
  const criteria = expectation.criteria || "Code should be correct, well-structured, and meet the task requirements.";
  const dimensions = expectation.dimensions ?? DEFAULT_DIMENSIONS;
  const threshold = expectation.threshold ?? 3.0;

  const dimNames = dimensions.map(d => d.name).join(", ");
  const rubricSection = buildRubricSection(dimensions);
  const explorationPrompt = buildExplorationPrompt(criteria, rubricSection, dimNames, context);

  const reviewModel = process.env.POLPO_JUDGE_MODEL || process.env.POLPO_MODEL || undefined;
  // Judge reasoning: explicit param > POLPO_JUDGE_REASONING env var > undefined
  const judgeReasoning = reasoning ?? (process.env.POLPO_JUDGE_REASONING as ReasoningLevel | undefined);

  onProgress?.("Starting 3 independent review agents (2-phase: explore → score)...");

  // Stagger reviewers by 1s to reduce rate-limit collisions on same provider
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const settled = await Promise.allSettled([
    runSingleReviewWithRetry(explorationPrompt, rubricSection, dimNames, cwd, reviewModel, onProgress, judgeReasoning),
    delay(1000).then(() => runSingleReviewWithRetry(explorationPrompt, rubricSection, dimNames, cwd, reviewModel, onProgress, judgeReasoning)),
    delay(2000).then(() => runSingleReviewWithRetry(explorationPrompt, rubricSection, dimNames, cwd, reviewModel, onProgress, judgeReasoning)),
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
        : "Reviewer returned null — all scoring strategies failed (toolChoice, json_schema, prompt, forceful, raw JSON)";
      failures.push(reason);
      onProgress?.(`Reviewer ${i + 1}/3 failed: ${reason}`);
    }
  }

  if (successfulReviews.length >= 2) {
    onProgress?.(`Computing consensus from ${successfulReviews.length} reviewers...`);
    const consensus = computeMedianScores(successfulReviews, dimensions);
    return buildCheckResult(consensus, dimensions, threshold);
  }

  if (successfulReviews.length === 1) {
    onProgress?.("Only 1 reviewer succeeded, using single review...");
    return buildCheckResult(successfulReviews[0], dimensions, threshold);
  }

  const failureDetail = failures.length > 0
    ? `\n\nFailure reasons:\n${failures.map((f, i) => `  Reviewer ${i + 1}: ${f}`).join("\n")}`
    : "";
  const modelInfo = reviewModel ? ` (judge model: ${reviewModel})` : " (no explicit judge model — using default)";

  return {
    type: "llm_review",
    passed: false,
    message: `Review failed — all evaluators failed to produce structured scores${modelInfo}`,
    details: `All 3 reviewers failed after 5 scoring strategies (toolChoice → json_schema → prompt → forceful → raw JSON) × 2 retries each.${modelInfo}\n\nThis usually means: (1) the judge model doesn't support tool calling well, (2) API auth/rate-limit errors, or (3) the model can't produce valid JSON.\n\nTry: set POLPO_JUDGE_MODEL to a capable model (e.g. claude-sonnet-4-20250514, gpt-4o), check API keys, or reduce concurrent tasks.${failureDetail}`,
  };
}
