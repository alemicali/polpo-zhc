import { exec } from "node:child_process";
import { access } from "node:fs/promises";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import type {
  Task,
  TaskExpectation,
  TaskMetric,
  AssessmentResult,
  CheckResult,
  MetricResult,
  ReviewContext,
  ReasoningLevel,
} from "../core/types.js";
import { runLLMReview } from "./llm-review.js";

const execAsync = promisify(exec);
const SCRIPT_MAX_BUFFER = 5 * 1024 * 1024; // 5 MB

export async function runCheck(
  expectation: TaskExpectation,
  cwd: string,
  onProgress?: (msg: string) => void,
  context?: ReviewContext,
  reasoning?: ReasoningLevel,
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
      if (paths.length === 0) {
        return { type: "file_exists", passed: false, message: "No paths specified" };
      }
      const missing: string[] = [];
      for (const p of paths) {
        const resolvedPath = resolve(cwd, p);
        try {
          await access(resolvedPath);
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
        message: `Missing ${missing.length}/${paths.length} file(s)`,
        details: missing.join(", "),
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

      const isMultiLine = cmd.includes("\n");
      const label = isMultiLine
        ? `script (${cmd.split("\n").length} lines)`
        : cmd;

      if (!isMultiLine) {
        // Single-line: execute directly
        try {
          await execAsync(cmd, { cwd, maxBuffer: SCRIPT_MAX_BUFFER });
          return { type: "script", passed: true, message: `Script passed: ${label}` };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { type: "script", passed: false, message: `Script failed: ${label}`, details: msg };
        }
      }

      // Multi-line: write to temp file, execute with bash, cleanup
      const tmpDir = join(cwd, ".polpo", "tmp");
      const scriptFile = join(tmpDir, `check-${nanoid(8)}.sh`);
      try {
        await mkdir(tmpDir, { recursive: true });
        // set -euo pipefail: fail on first error, like CI/CD
        const scriptContent = `#!/usr/bin/env bash\nset -euo pipefail\n\n${cmd}\n`;
        await writeFile(scriptFile, scriptContent);
        const { stdout, stderr } = await execAsync(`bash "${scriptFile}"`, {
          cwd,
          maxBuffer: SCRIPT_MAX_BUFFER,
        });
        return {
          type: "script",
          passed: true,
          message: `Script passed: ${label}`,
          details: stdout || stderr || undefined,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          type: "script",
          passed: false,
          message: `Script failed: ${label}`,
          details: msg,
        };
      } finally {
        try { await unlink(scriptFile); } catch { /* file already removed */ }
      }
    }

    case "llm_review": {
      return await runLLMReview(expectation, cwd, onProgress, context, reasoning);
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
  } catch { /* metric command failed */
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
  onProgress?: (msg: string) => void,
  context?: ReviewContext,
  reasoning?: ReasoningLevel,
): Promise<AssessmentResult> {
  const checks = await Promise.all(
    task.expectations.map((exp) => runCheck(exp, cwd, onProgress, context, reasoning))
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
