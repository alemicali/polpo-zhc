import type { Task, TaskResult, AssessmentResult } from "./types.js";

// ── Judge Types ──────────────────────────────────────

export interface JudgeCorrectionFix {
  paths?: string[];
  command?: string;
  threshold?: number;
}

export interface JudgeCorrection {
  type: string;
  verdict: "expectation_wrong" | "work_wrong";
  reason: string;
  fix?: JudgeCorrectionFix;
}

export interface JudgeVerdict {
  corrections: JudgeCorrection[];
}

// ── Prompt Builders ──────────────────────────────────

/** Build a targeted fix prompt — agent's work is on disk, only fix review issues. */
export function buildFixPrompt(task: Task, result: TaskResult): string {
  const base = task.originalDescription ?? task.description;
  const parts = [
    `TARGETED FIX — Your previous execution was successful (exit code 0).`,
    `The code you wrote is already on disk. Do NOT start over.`,
    ``,
    `ORIGINAL TASK: ${base}`,
    ``,
    `The reviewer found these issues:`,
  ];

  if (result.assessment) {
    const failed = result.assessment.checks.filter(c => !c.passed);
    if (failed.length > 0) {
      for (const c of failed) parts.push(`- ${c.type}: ${c.message} ${c.details || ""}`);
    }
    if (result.assessment.scores && result.assessment.scores.length > 0) {
      parts.push(``, `SCORES (1-5):`);
      for (const s of result.assessment.scores) {
        parts.push(`- ${s.dimension}: ${s.score}/5 — ${s.reasoning}`);
      }
      if (result.assessment.globalScore !== undefined) {
        parts.push(`Global score: ${result.assessment.globalScore.toFixed(1)}/5`);
      }
    } else if (result.assessment.llmReview) {
      parts.push(``, `Reviewer feedback:`, result.assessment.llmReview);
    }
  }

  parts.push(``, `Fix ONLY the issues listed above, then the task will be re-assessed.`);
  return parts.join("\n");
}

/** Build the retry prompt with feedback from the previous attempt (full restart). */
export function buildRetryPrompt(task: Task, result: TaskResult): string {
  const base = task.originalDescription ?? task.description;
  const parts = [
    base,
    ``,
    `PREVIOUS ATTEMPT FAILED:`,
    `Exit code: ${result.exitCode}`,
  ];
  if (result.stderr) parts.push(`Stderr: ${result.stderr.slice(0, 2000)}`);
  if (result.assessment) {
    const failed = result.assessment.checks.filter(c => !c.passed);
    if (failed.length > 0) {
      parts.push(`Failed checks:`);
      for (const c of failed) parts.push(`- ${c.type}: ${c.message} ${c.details || ""}`);
    }
    if (result.assessment.scores && result.assessment.scores.length > 0) {
      parts.push(``, `EVALUATION SCORES (1-5):`);
      for (const s of result.assessment.scores) {
        parts.push(`- ${s.dimension}: ${s.score}/5 — ${s.reasoning}`);
      }
      if (result.assessment.globalScore !== undefined) {
        parts.push(`Global score: ${result.assessment.globalScore}/5`);
      }
      parts.push(``, `Focus on improving the lowest-scoring dimensions.`);
    } else if (result.assessment.llmReview) {
      parts.push(``, `LLM Reviewer feedback:`, result.assessment.llmReview);
    }
  }
  parts.push(``, `Please fix the issues and try again.`);
  return parts.join("\n");
}

/** Build LLM judge prompt to decide if expectations or work are wrong. */
export function buildJudgePrompt(
  task: Task,
  result: TaskResult,
  assessment: AssessmentResult,
  failedChecks: Array<{ type: string; passed: boolean; message: string; details?: string }>,
  activity?: { filesCreated: string[]; filesEdited: string[]; toolCalls: number; summary?: string },
): string {
  const parts = [
    `You are a QA judge for Polpo, an AI agent orchestration framework. An agent completed a coding task but some acceptance criteria (expectations) failed.`,
    `Your job: determine if the EXPECTATIONS are wrong (should be corrected) or if the AGENT'S WORK is wrong (needs fixing).`,
    ``,
    `## Task`,
    `Title: ${task.title}`,
    `Description: ${(task.originalDescription || task.description).slice(0, 800)}`,
    ``,
    `## Agent Output`,
    result.stdout ? `Result (last 800 chars): ${result.stdout.slice(-800)}` : "No output captured.",
  ];

  if (activity) {
    if (activity.filesCreated.length > 0) {
      parts.push(``, `Files created by agent: ${activity.filesCreated.join(", ")}`);
    }
    if (activity.filesEdited.length > 0) {
      parts.push(`Files edited by agent: ${activity.filesEdited.join(", ")}`);
    }
    parts.push(`Tool calls: ${activity.toolCalls}`);
  }

  if (assessment.globalScore !== undefined) {
    parts.push(``, `LLM Review Score: ${assessment.globalScore.toFixed(1)}/5`);
  }

  parts.push(``, `## Failed Expectations`);
  for (const check of failedChecks) {
    const expDef = task.expectations.find(e => e.type === check.type);
    parts.push(`- Type: ${check.type}`);
    parts.push(`  Failure: ${check.message}`);
    if (check.details) parts.push(`  Details: ${check.details.slice(0, 300)}`);
    if (expDef?.paths) parts.push(`  Expected paths: ${expDef.paths.join(", ")}`);
    if (expDef?.command) parts.push(`  Command: ${expDef.command}`);
    if (expDef?.threshold) parts.push(`  Threshold: ${expDef.threshold}`);
  }

  parts.push(
    ``,
    `## Instructions`,
    `For EACH failed expectation, decide:`,
    `- "expectation_wrong": The agent did good work but the expectation is misconfigured (wrong path, wrong command, threshold too strict). Provide a corrected version.`,
    `- "work_wrong": The agent genuinely didn't meet this criterion. No correction needed.`,
    ``,
    `Respond with ONLY a JSON object:`,
    `{`,
    `  "corrections": [`,
    `    {`,
    `      "type": "file_exists|test|script|llm_review",`,
    `      "verdict": "expectation_wrong|work_wrong",`,
    `      "reason": "brief explanation",`,
    `      "fix": { "paths": ["corrected/path.ts"], "command": "corrected command", "threshold": 2.5 }`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `Only include "fix" when verdict is "expectation_wrong". Fix fields depend on type:`,
    `- file_exists: { "paths": [...] }`,
    `- test/script: { "command": "..." }`,
    `- llm_review: { "threshold": number }`,
  );

  return parts.join("\n");
}

// ── Utilities ────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
