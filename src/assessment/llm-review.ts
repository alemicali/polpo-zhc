/**
 * G-Eval LLM-as-Judge review using pi-ai.
 *
 * Runs 3 independent reviewers in parallel with their own tool loop:
 * LLM call → tool execution → LLM call → ... → submit_review
 *
 * Tools: read_file, glob, grep, submit_review (all implemented natively).
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { Type } from "@sinclair/typebox";
import type { TaskExpectation, DimensionScore, CheckResult, ReviewContext } from "../core/types.js";
import { DEFAULT_DIMENSIONS, buildRubricSection, computeWeightedScore, computeMedianScores } from "./scoring.js";
import { withRetry } from "../llm/retry.js";
import { resolveModel } from "../llm/pi-client.js";
import { completeSimple, type AssistantMessage, type Message, type Tool } from "@mariozechner/pi-ai";

export type LLMQueryFn = (prompt: string, cwd: string) => Promise<string>;

interface ReviewPayload {
  scores: { dimension: string; score: number; reasoning: string; evidence?: { file: string; line: number; note: string }[] }[];
  summary: string;
}

// === Review Tools (native, no SDK dependency) ===

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

const submitReviewTool: Tool = {
  name: "submit_review",
  description: `Submit your final structured code review. You MUST call this tool exactly once
after you have finished reading and analyzing all relevant code files.
Each dimension must be scored 1-5 based on the rubric provided in the prompt.
Each reasoning MUST include specific file:line references as evidence.
Do NOT output the review as plain text — use this tool.`,
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

const REVIEW_TOOLS: Tool[] = [readFileTool, globTool, grepTool, submitReviewTool];

/** Execute a review tool call and return text content. */
function executeReviewTool(
  toolName: string,
  args: Record<string, any>,
  cwd: string,
  reviewRef: { result: ReviewPayload | null },
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
    case "submit_review": {
      reviewRef.result = args as ReviewPayload;
      return "Review submitted successfully.";
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// === Prompt Builder ===

function buildReviewPrompt(
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

  return `You are a senior code reviewer performing a structured G-Eval evaluation.

ACCEPTANCE CRITERIA:
${criteria}
${contextSection}
EVALUATION DIMENSIONS AND RUBRICS:
${rubricSection}

INSTRUCTIONS:
1. Use read_file, glob, and grep tools to explore the codebase and find relevant files.
2. Read the code carefully and understand what it does relative to the acceptance criteria.
3. For EACH dimension (${dimNames}), follow this process:
   a. Think step-by-step about how the code performs on this dimension.
   b. Reference the rubric to determine the appropriate score (1-5).
   c. Write a brief chain-of-thought reasoning citing specific code evidence.
   d. Each reasoning MUST include at least one specific file:line reference.
      Example: "correctness: 4/5 — \`src/auth/jwt.ts:45\` validates token expiry correctly but \`src/middleware/auth.ts:12\` doesn't handle refresh tokens"
   e. Optionally provide structured evidence entries with file, line, and note.
4. After evaluating all dimensions, call the submit_review tool with your scores and summary.

IMPORTANT:
- You MUST call the submit_review tool to deliver your review.
- You MUST evaluate ALL dimensions: ${dimNames}
- Each score must be an integer from 1 to 5.
- Be strict but fair — apply the rubric literally.
- Scores without specific code evidence (file:line references) should be considered unreliable.`;
}

// === Single Review Runner (pi-ai tool loop) ===

const MAX_REVIEW_TURNS = 30;

async function runSingleReview(
  reviewPrompt: string,
  cwd: string,
  model?: string,
  onProgress?: (msg: string) => void,
): Promise<ReviewPayload | null> {
  const m = resolveModel(model);
  const reviewRef: { result: ReviewPayload | null } = { result: null };

  const messages: Message[] = [
    { role: "user", content: reviewPrompt, timestamp: Date.now() },
  ];

  for (let turn = 0; turn < MAX_REVIEW_TURNS; turn++) {
    const response = await completeSimple(m, {
      systemPrompt: "You are a thorough code reviewer. Use tools to explore the codebase before submitting your review.",
      messages,
      tools: REVIEW_TOOLS,
    });

    messages.push(response);

    // Extract tool calls
    const toolCalls = response.content.filter(
      (c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
        c.type === "toolCall"
    );

    if (toolCalls.length === 0) break; // Agent done, no more tools

    // Execute each tool call
    for (const call of toolCalls) {
      if (call.name === "read_file" && onProgress) {
        const file = String(call.arguments?.path ?? "").split("/").pop();
        onProgress(`Reading ${file}`);
      } else if (call.name === "glob" && onProgress) {
        onProgress(`Searching ${call.arguments?.pattern}`);
      } else if (call.name === "grep" && onProgress) {
        onProgress(`Grep: ${String(call.arguments?.pattern ?? "").slice(0, 30)}`);
      } else if (call.name === "submit_review" && onProgress) {
        onProgress("Submitting review scores...");
      }

      const resultText = executeReviewTool(call.name, call.arguments, cwd, reviewRef);
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: resultText }],
        isError: false,
        timestamp: Date.now(),
      });
    }

    // If review was submitted, we're done
    if (reviewRef.result) break;
  }

  if (reviewRef.result?.scores && Array.isArray(reviewRef.result.scores) && reviewRef.result.scores.length > 0) {
    return reviewRef.result;
  }

  // Try to extract from the last assistant text as fallback
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant") as AssistantMessage | undefined;
  if (lastAssistant) {
    const textBlocks = lastAssistant.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
    const fullText = textBlocks.map(b => b.text).join("\n");
    return tryParseReviewJSON(fullText);
  }

  return null;
}

function tryParseReviewJSON(output: string): ReviewPayload | null {
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let jsonStr = jsonMatch[0];
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1");
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed.scores && Array.isArray(parsed.scores)) return parsed;
  } catch { /* fall through */ }
  return null;
}

// === CheckResult Builder (unchanged) ===

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

// === Single Review with Retry ===

async function runSingleReviewWithRetry(
  reviewPrompt: string,
  cwd: string,
  model?: string,
  onProgress?: (msg: string) => void,
): Promise<ReviewPayload | null> {
  try {
    return await withRetry(
      async () => {
        const result = await runSingleReview(reviewPrompt, cwd, model, onProgress);
        if (!result) throw new Error("Reviewer produced no result");
        return result;
      },
      { maxRetries: 2, initialDelayMs: 2000, checkTransient: false },
    );
  } catch {
    return null;
  }
}

// === Main Entry Point ===

/**
 * Run a G-Eval LLM-as-Judge review.
 *
 * Runs 3 independent reviewers in parallel (multi-evaluator consensus).
 * Falls back to single-reviewer if <2 succeed.
 * Each reviewer gets one retry on failure before being counted as failed.
 *
 * SAFETY NET: if all evaluators fail, the task is NOT marked as failed.
 * Evaluator failures default to passed=true so a successful task is never
 * blocked by a broken reviewer.
 */
export async function runLLMReview(
  expectation: TaskExpectation,
  cwd: string,
  onProgress?: (msg: string) => void,
  context?: ReviewContext,
): Promise<CheckResult> {
  const criteria = expectation.criteria || "Code should be correct, well-structured, and meet the task requirements.";
  const dimensions = expectation.dimensions ?? DEFAULT_DIMENSIONS;
  const threshold = expectation.threshold ?? 3.0;

  const dimNames = dimensions.map(d => d.name).join(", ");
  const rubricSection = buildRubricSection(dimensions);
  const reviewPrompt = buildReviewPrompt(criteria, rubricSection, dimNames, context);

  // Use orchestrator model for reviews (configurable via env or default)
  const reviewModel = process.env.POLPO_JUDGE_MODEL || process.env.POLPO_MODEL || undefined;

  onProgress?.("Starting 3 independent review agents...");

  const settled = await Promise.allSettled([
    runSingleReviewWithRetry(reviewPrompt, cwd, reviewModel, onProgress),
    runSingleReviewWithRetry(reviewPrompt, cwd, reviewModel, onProgress),
    runSingleReviewWithRetry(reviewPrompt, cwd, reviewModel, onProgress),
  ]);

  const successfulReviews: ReviewPayload[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      successfulReviews.push(result.value);
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

  return {
    type: "llm_review",
    passed: false,
    message: "Review failed — all evaluators failed to produce results",
    details: "All 3 reviewers failed to produce structured output after retries. Task marked as failed for safety.",
  };
}
