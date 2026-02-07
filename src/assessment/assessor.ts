import { exec } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  Task,
  TaskExpectation,
  TaskMetric,
  AssessmentResult,
  CheckResult,
  MetricResult,
} from "../core/types.js";
import { runLLMReview, type LLMQueryFn } from "./llm-review.js";

const execAsync = promisify(exec);

export async function runCheck(
  expectation: TaskExpectation,
  cwd: string,
  queryFn?: LLMQueryFn,
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
      return await runLLMReview(expectation, cwd, queryFn);
    }
  }
}

export async function runMetric(
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
  cwd: string,
  queryFn?: LLMQueryFn,
): Promise<AssessmentResult> {
  const checks = await Promise.all(
    task.expectations.map((exp) => runCheck(exp, cwd, queryFn))
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
