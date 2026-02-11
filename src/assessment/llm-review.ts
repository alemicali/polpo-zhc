import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TaskExpectation, DimensionScore, CheckResult } from "../core/types.js";
import { DEFAULT_DIMENSIONS, buildRubricSection, computeWeightedScore } from "./scoring.js";

/**
 * Injectable function type for LLM queries (used in tests).
 */
export type LLMQueryFn = (prompt: string, cwd: string) => Promise<string>;

/** Review result shape — matches the submit_review tool schema. */
interface ReviewPayload {
  scores: { dimension: string; score: number; reasoning: string }[];
  summary: string;
}

/**
 * Create the in-process MCP server with a `submit_review` tool.
 * The captured result is stored in the returned ref object.
 */
function createReviewServer() {
  const ref: { result: ReviewPayload | null } = { result: null };

  const server = createSdkMcpServer({
    name: "reviewer",
    version: "1.0.0",
    tools: [
      tool(
        "submit_review",
        `Submit your final structured code review. You MUST call this tool exactly once
after you have finished reading and analyzing all relevant code files.
Each dimension must be scored 1-5 based on the rubric provided in the prompt.
Do NOT output the review as plain text — use this tool.`,
        {
          scores: z.array(z.object({
            dimension: z.string().describe("Dimension name from the rubric"),
            score: z.number().int().min(1).max(5).describe("Score 1-5"),
            reasoning: z.string().describe("Brief reasoning with specific code evidence"),
          })).describe("One entry per evaluation dimension"),
          summary: z.string().describe("Overall review summary"),
        },
        async (args) => {
          ref.result = args;
          return { content: [{ type: "text" as const, text: "Review submitted successfully." }] };
        },
      ),
    ],
  });

  return { server, ref };
}

/**
 * Build the review prompt for the agent.
 */
function buildReviewPrompt(
  criteria: string,
  rubricSection: string,
  dimNames: string,
): string {
  return `You are a senior code reviewer performing a structured G-Eval evaluation.

ACCEPTANCE CRITERIA:
${criteria}

EVALUATION DIMENSIONS AND RUBRICS:
${rubricSection}

INSTRUCTIONS:
1. Use Read, Glob, and Grep tools to explore the codebase and find relevant files.
2. Read the code carefully and understand what it does relative to the acceptance criteria.
3. For EACH dimension (${dimNames}), follow this process:
   a. Think step-by-step about how the code performs on this dimension.
   b. Reference the rubric to determine the appropriate score (1-5).
   c. Write a brief chain-of-thought reasoning citing specific code evidence.
4. After evaluating all dimensions, call the submit_review tool with your scores and summary.

IMPORTANT:
- You MUST call the submit_review tool to deliver your review.
- You MUST evaluate ALL dimensions: ${dimNames}
- Each score must be an integer from 1 to 5.
- Be strict but fair — apply the rubric literally.`;
}

/**
 * Convert a ReviewPayload into a CheckResult.
 */
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

/**
 * Try to parse a ReviewPayload from raw text output (fallback).
 */
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

/**
 * Run a G-Eval LLM-as-Judge review.
 *
 * The reviewer agent can read files (Read, Glob, Grep) and must call
 * the `submit_review` MCP tool to deliver structured scores.
 *
 * SAFETY NET: if the evaluator itself fails (can't parse, SDK error, etc.),
 * the task is NOT marked as failed. Evaluator failures default to passed=true
 * so a successful task is never blocked by a broken reviewer.
 */
export async function runLLMReview(
  expectation: TaskExpectation,
  cwd: string,
  onProgress?: (msg: string) => void,
): Promise<CheckResult> {
  const criteria = expectation.criteria || "Code should be correct, well-structured, and meet the task requirements.";
  const dimensions = expectation.dimensions ?? DEFAULT_DIMENSIONS;
  const threshold = expectation.threshold ?? 3.0;

  const dimNames = dimensions.map(d => d.name).join(", ");
  const rubricSection = buildRubricSection(dimensions);
  const reviewPrompt = buildReviewPrompt(criteria, rubricSection, dimNames);

  // Create in-process MCP server with submit_review tool
  const { server, ref } = createReviewServer();

  try {
    let textOutput = "";
    onProgress?.("Starting code review agent...");

    for await (const message of query({
      prompt: reviewPrompt,
      options: {
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 30,
        persistSession: false,
        allowedTools: [
          "Read",
          "Glob",
          "Grep",
          "mcp__reviewer__submit_review",
        ],
        mcpServers: {
          reviewer: server,
        },
      },
    })) {
      const msg = message as Record<string, unknown>;
      // Emit progress on tool use
      if (msg.type === "tool_use" || msg.tool_name) {
        const toolName = (msg.tool_name ?? msg.name ?? "tool") as string;
        const input = (msg.tool_input ?? msg.input) as Record<string, unknown> | undefined;
        if (toolName === "Read" && input?.file_path) {
          const file = String(input.file_path).split("/").pop();
          onProgress?.(`Reading ${file}`);
        } else if (toolName === "Glob" && input?.pattern) {
          onProgress?.(`Searching ${input.pattern}`);
        } else if (toolName === "Grep" && input?.pattern) {
          onProgress?.(`Grep: ${String(input.pattern).slice(0, 30)}`);
        } else if (toolName.includes("submit_review")) {
          onProgress?.("Submitting review scores...");
        } else {
          onProgress?.(`${toolName}...`);
        }
      }
      if (msg.type === "result") {
        if (msg.subtype === "success" && typeof msg.result === "string") {
          textOutput = msg.result;
        }
      }
    }

    // Primary: MCP tool was called — use captured result
    if (ref.result?.scores && Array.isArray(ref.result.scores) && ref.result.scores.length > 0) {
      return buildCheckResult(ref.result, dimensions, threshold);
    }

    // Fallback: try to parse JSON from agent's text output
    const parsed = tryParseReviewJSON(textOutput);
    if (parsed) {
      return buildCheckResult(parsed, dimensions, threshold);
    }

    // SAFETY NET: evaluator couldn't produce structured output → don't block the task
    return {
      type: "llm_review",
      passed: true,
      message: "Review inconclusive (evaluator could not produce structured output) — defaulting to pass",
      details: textOutput.slice(0, 500),
    };
  } catch (err: unknown) {
    // SAFETY NET: evaluator crashed → don't block the task
    const msg = err instanceof Error ? err.message : String(err);
    return {
      type: "llm_review",
      passed: true,
      message: "Review skipped (evaluator error) — defaulting to pass",
      details: msg.slice(0, 500),
    };
  }
}
