import { exec } from "node:child_process";
import { statSync } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Task,
  TaskExpectation,
  TaskMetric,
  EvalDimension,
  DimensionScore,
  AssessmentResult,
  CheckResult,
  MetricResult,
} from "./types.js";

const execAsync = promisify(exec);

/**
 * Collect recently modified files in the working directory to give the reviewer context.
 * Only includes text files modified in the last 30 minutes, skipping node_modules/.git etc.
 */
async function gatherRecentFiles(cwd: string): Promise<string> {
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

// === G-Eval LLM-as-Judge ===

const DEFAULT_DIMENSIONS: EvalDimension[] = [
  {
    name: "correctness",
    description: "Does the code work correctly? Are there logic errors, runtime exceptions, or incorrect outputs?",
    weight: 0.35,
    rubric: {
      1: "Fundamentally broken — does not run or produces entirely wrong results",
      2: "Major bugs — runs but has significant logic errors affecting core functionality",
      3: "Mostly correct — works for common cases but has edge-case bugs",
      4: "Correct — handles all specified cases properly with minor issues only",
      5: "Flawless — correct in all cases, handles edge cases and boundary conditions perfectly",
    },
  },
  {
    name: "completeness",
    description: "Are all requirements and acceptance criteria fully addressed? Nothing missing?",
    weight: 0.30,
    rubric: {
      1: "Most requirements unmet — major deliverables missing",
      2: "Partially complete — some requirements met but significant gaps remain",
      3: "Core requirements met — main functionality present but extras missing",
      4: "Nearly complete — all requirements met with minor omissions",
      5: "Fully complete — every requirement and criterion addressed comprehensively",
    },
  },
  {
    name: "code_quality",
    description: "Is the code well-structured, readable, and maintainable? Proper naming, organization, and patterns?",
    weight: 0.20,
    rubric: {
      1: "Unreadable — no structure, inconsistent style, impossible to maintain",
      2: "Poor quality — hard to follow, unclear naming, minimal organization",
      3: "Acceptable — readable but could be better structured or more idiomatic",
      4: "Good quality — clean code, clear naming, well-organized",
      5: "Excellent — exemplary structure, idiomatic patterns, easy to extend",
    },
  },
  {
    name: "edge_cases",
    description: "Are edge cases, error conditions, and boundary values handled gracefully?",
    weight: 0.15,
    rubric: {
      1: "No error handling — crashes on any unexpected input",
      2: "Minimal handling — only handles the happy path",
      3: "Some handling — common edge cases covered but gaps exist",
      4: "Good handling — most edge cases and errors handled properly",
      5: "Comprehensive — all edge cases, nulls, empty inputs, and errors handled gracefully",
    },
  },
];

function buildRubricSection(dimensions: EvalDimension[]): string {
  return dimensions.map(dim => {
    const rubricLines = dim.rubric
      ? Object.entries(dim.rubric)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([score, desc]) => `    ${score}: ${desc}`)
          .join("\n")
      : "    1: Very poor\n    2: Below average\n    3: Average\n    4: Good\n    5: Excellent";

    return `  ${dim.name} (weight: ${dim.weight}):
    Description: ${dim.description}
    Scoring rubric:
${rubricLines}`;
  }).join("\n\n");
}

/**
 * Run a G-Eval LLM-as-Judge review using the Claude Agent SDK.
 * Evaluates code across multiple dimensions with chain-of-thought reasoning.
 * Returns structured scores per dimension and a weighted global score.
 */
async function runLLMReview(
  expectation: TaskExpectation,
  cwd: string,
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
      let output = "";

      for await (const message of query({
        prompt: attempt === 1
          ? reviewPrompt
          : reviewPrompt + "\n\nPREVIOUS ATTEMPT FAILED: your output was not valid JSON. You MUST respond with ONLY a JSON object. No markdown, no explanation, no text before or after the JSON.",
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

      output = output.trim();

      // Strip markdown fences if present
      const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (fenceMatch) output = fenceMatch[1].trim();

      // Extract JSON object — use lazy match to avoid grabbing trailing text
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        if (attempt < MAX_ATTEMPTS) continue; // retry
        return {
          type: "llm_review",
          passed: false,
          message: "LLM review returned non-JSON output",
          details: output.slice(0, 500),
        };
      }

      let jsonStr = jsonMatch[0];

      // Try to repair common JSON issues: trailing commas, single quotes
      jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1"); // trailing commas
      jsonStr = jsonStr.replace(/'/g, '"'); // single quotes → double quotes

      let parsed: {
        scores: { dimension: string; score: number; reasoning: string }[];
        summary: string;
      };
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        if (attempt < MAX_ATTEMPTS) continue; // retry
        return {
          type: "llm_review",
          passed: false,
          message: "LLM review returned malformed JSON",
          details: jsonStr.slice(0, 500),
        };
      }

      if (!parsed.scores || !Array.isArray(parsed.scores)) {
        if (attempt < MAX_ATTEMPTS) continue; // retry
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

      // Compute weighted global score
      const totalWeight = dimScores.reduce((sum, s) => sum + s.weight, 0);
      const globalScore = totalWeight > 0
        ? dimScores.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight
        : 0;

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
      if (attempt < MAX_ATTEMPTS) continue; // retry on unexpected errors
      const msg = err instanceof Error ? err.message : String(err);
      return {
        type: "llm_review",
        passed: false,
        message: "LLM review process failed",
        details: msg.slice(0, 500),
      };
    }
  }

  // Should never reach here, but TypeScript needs it
  return {
    type: "llm_review",
    passed: false,
    message: "LLM review exhausted all attempts",
  };
}

async function runCheck(
  expectation: TaskExpectation,
  cwd: string
): Promise<CheckResult> {
  switch (expectation.type) {
    case "test": {
      const cmd = expectation.command ?? "npm test";
      try {
        await execAsync(cmd, { cwd });
        return { type: "test", passed: true, message: `Test passed: ${cmd}` };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          type: "test",
          passed: false,
          message: `Test failed: ${cmd}`,
          details: msg,
        };
      }
    }

    case "file_exists": {
      const paths = expectation.paths ?? [];
      const missing: string[] = [];
      for (const p of paths) {
        try {
          await access(p);
        } catch {
          missing.push(p);
        }
      }
      if (missing.length === 0) {
        return {
          type: "file_exists",
          passed: true,
          message: `All ${paths.length} file(s) exist`,
        };
      }
      return {
        type: "file_exists",
        passed: false,
        message: `Missing files: ${missing.join(", ")}`,
      };
    }

    case "script": {
      const cmd = expectation.command;
      if (!cmd) {
        return {
          type: "script",
          passed: false,
          message: "No script command provided",
        };
      }
      try {
        await execAsync(cmd, { cwd });
        return {
          type: "script",
          passed: true,
          message: `Script passed: ${cmd}`,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          type: "script",
          passed: false,
          message: `Script failed: ${cmd}`,
          details: msg,
        };
      }
    }

    case "llm_review": {
      return await runLLMReview(expectation, cwd);
    }
  }
}

async function runMetric(
  metric: TaskMetric,
  cwd: string
): Promise<MetricResult> {
  try {
    const { stdout } = await execAsync(metric.command, { cwd });
    const value = parseFloat(stdout.trim());
    if (isNaN(value)) {
      return {
        name: metric.name,
        value: 0,
        threshold: metric.threshold,
        passed: false,
      };
    }
    return {
      name: metric.name,
      value,
      threshold: metric.threshold,
      passed: value >= metric.threshold,
    };
  } catch {
    return {
      name: metric.name,
      value: 0,
      threshold: metric.threshold,
      passed: false,
    };
  }
}

export async function assessTask(
  task: Task,
  cwd: string
): Promise<AssessmentResult> {
  const checks = await Promise.all(
    task.expectations.map((exp) => runCheck(exp, cwd))
  );
  const metrics = await Promise.all(
    task.metrics.map((m) => runMetric(m, cwd))
  );

  const passed =
    checks.every((c) => c.passed) && metrics.every((m) => m.passed);

  // Extract LLM review details and scores
  const llmCheck = checks.find(c => c.type === "llm_review");
  const llmReview = llmCheck?.details;
  const scores = llmCheck?.scores;
  const globalScore = llmCheck?.globalScore;

  return {
    passed,
    checks,
    metrics,
    llmReview,
    scores,
    globalScore,
    timestamp: new Date().toISOString(),
  };
}
