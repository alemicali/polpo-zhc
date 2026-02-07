import { statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TaskExpectation, DimensionScore, CheckResult } from "../core/types.js";
import { DEFAULT_DIMENSIONS, buildRubricSection, computeWeightedScore } from "./scoring.js";

/**
 * Injectable function type for LLM queries.
 * Default uses the Claude Agent SDK; can be replaced in tests.
 */
export type LLMQueryFn = (prompt: string, cwd: string) => Promise<string>;

/** Default LLM query function using Claude Agent SDK. */
export const defaultLLMQuery: LLMQueryFn = async (prompt, cwd) => {
  let output = "";
  for await (const message of query({
    prompt,
    options: {
      cwd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: ["Read", "Glob", "Grep"],
      persistSession: false,
      maxTurns: 3,
    },
  })) {
    if (message.type === "result") {
      const result = message as unknown as { subtype: string; result?: string };
      if (result.subtype === "success" && result.result) {
        output = result.result;
      }
    }
  }
  return output;
};

/**
 * Collect recently modified files in the working directory to give the reviewer context.
 * Only includes text files modified in the last 30 minutes, skipping node_modules/.git etc.
 */
export async function gatherRecentFiles(cwd: string): Promise<string> {
  const SKIP = new Set(["node_modules", ".git", ".orchestra", "dist", "build", "coverage", "__pycache__"]);
  const MAX_FILES = 15;
  const MAX_FILE_SIZE = 8000; // chars per file
  const CUTOFF = Date.now() - 30 * 60 * 1000;

  const results: { path: string; content: string; mtime: number }[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4 || results.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;
      if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const { mtimeMs } = statSync(full);
          if (mtimeMs < CUTOFF) continue;
          const content = await readFile(full, "utf-8");
          if (content.length > 0) {
            results.push({
              path: relative(cwd, full),
              content: content.slice(0, MAX_FILE_SIZE),
              mtime: mtimeMs,
            });
          }
        } catch { /* skip binary/unreadable files */ }
      }
    }
  }

  await walk(cwd, 0);
  results.sort((a, b) => b.mtime - a.mtime);

  if (results.length === 0) return "(no recently modified files found)";

  return results.map(f =>
    `--- ${f.path} ---\n${f.content}${f.content.length >= MAX_FILE_SIZE ? "\n[...truncated]" : ""}`
  ).join("\n\n");
}

/**
 * Run a G-Eval LLM-as-Judge review.
 * Evaluates code across multiple dimensions with chain-of-thought reasoning.
 * Returns structured scores per dimension and a weighted global score.
 *
 * @param queryFn — injectable LLM query function (default: Claude Agent SDK)
 */
export async function runLLMReview(
  expectation: TaskExpectation,
  cwd: string,
  queryFn: LLMQueryFn = defaultLLMQuery,
): Promise<CheckResult> {
  const criteria = expectation.criteria || "Code should be correct, well-structured, and meet the task requirements.";
  const dimensions = expectation.dimensions ?? DEFAULT_DIMENSIONS;
  const threshold = expectation.threshold ?? 3.0;

  let recentFiles: string;
  try {
    recentFiles = await gatherRecentFiles(cwd);
  } catch {
    recentFiles = "(could not gather files)";
  }

  const dimNames = dimensions.map(d => d.name).join(", ");
  const rubricSection = buildRubricSection(dimensions);

  const reviewPrompt = `You are a senior code reviewer performing a structured evaluation.
Your task is to score code against specific dimensions using a rubric-based approach (G-Eval pattern).

ACCEPTANCE CRITERIA:
${criteria}

RECENTLY MODIFIED FILES:
${recentFiles}

EVALUATION DIMENSIONS AND RUBRICS:
${rubricSection}

INSTRUCTIONS:
1. Read the code carefully and understand what it does.
2. For EACH dimension (${dimNames}), follow this process:
   a. Think step-by-step about how the code performs on this dimension.
   b. Reference the rubric to determine the appropriate score (1-5).
   c. Write a brief chain-of-thought reasoning explaining your score.
3. After evaluating all dimensions, provide an overall summary.

Respond with EXACTLY this JSON format (no markdown fences, no extra text):
{
  "scores": [
    {
      "dimension": "<name>",
      "score": <1-5>,
      "reasoning": "<chain-of-thought reasoning for this score>"
    }
  ],
  "summary": "<one paragraph overall assessment>"
}

IMPORTANT:
- You must evaluate ALL dimensions: ${dimNames}
- Each score must be an integer from 1 to 5
- Be strict but fair — apply the rubric literally
- The reasoning should reference specific code evidence`;

  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const promptToSend = attempt === 1
        ? reviewPrompt
        : reviewPrompt + "\n\nPREVIOUS ATTEMPT FAILED: your output was not valid JSON. You MUST respond with ONLY a JSON object. No markdown, no explanation, no text before or after the JSON.";

      let output = await queryFn(promptToSend, cwd);
      output = output.trim();

      // Strip markdown fences if present
      const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (fenceMatch) output = fenceMatch[1].trim();

      // Extract JSON object
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        if (attempt < MAX_ATTEMPTS) continue;
        return {
          type: "llm_review",
          passed: false,
          message: "LLM review returned non-JSON output",
          details: output.slice(0, 500),
        };
      }

      let jsonStr = jsonMatch[0];

      // Try to repair common JSON issues: trailing commas, single quotes
      jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1");
      jsonStr = jsonStr.replace(/'/g, '"');

      let parsed: {
        scores: { dimension: string; score: number; reasoning: string }[];
        summary: string;
      };
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        if (attempt < MAX_ATTEMPTS) continue;
        return {
          type: "llm_review",
          passed: false,
          message: "LLM review returned malformed JSON",
          details: jsonStr.slice(0, 500),
        };
      }

      if (!parsed.scores || !Array.isArray(parsed.scores)) {
        if (attempt < MAX_ATTEMPTS) continue;
        return {
          type: "llm_review",
          passed: false,
          message: "LLM review JSON missing 'scores' array",
          details: jsonStr.slice(0, 500),
        };
      }

      // Build dimension scores with weights
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

      // Build readable details
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
    } catch (err: unknown) {
      if (attempt < MAX_ATTEMPTS) continue;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        type: "llm_review",
        passed: false,
        message: "LLM review process failed",
        details: msg.slice(0, 500),
      };
    }
  }

  return {
    type: "llm_review",
    passed: false,
    message: "LLM review exhausted all attempts",
  };
}
