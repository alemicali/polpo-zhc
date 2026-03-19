import { nanoid } from "nanoid";
import type { FileSystem } from "./filesystem.js";
import type { Shell } from "./shell.js";
import type {
  Task,
  TaskExpectation,
  TaskMetric,
  AssessmentResult,
  CheckResult,
  MetricResult,
  ReviewContext,
  ReasoningLevel,
} from "./types.js";

// ── Pure path helpers (no node:path dependency) ─────────────────────────

/** Join path segments with '/'. */
function pathJoin(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter(Boolean)
    .join("/");
}

/** Resolve a possibly-relative path against a base directory. */
function pathResolve(base: string, relative: string): string {
  if (relative.startsWith("/")) return relative;
  return pathJoin(base, relative);
}

// ── Assessment Dependencies (ports) ─────────────────────────────────────

/**
 * Runtime dependencies for the assessment pipeline.
 *
 * The shell layer (Node.js) provides NodeFileSystem + NodeShell.
 * The cloud layer provides SandboxProxyFS + SandboxProxyShell.
 * Tests can provide mocks/stubs.
 */
export interface AssessmentDeps {
  /** File system abstraction. */
  fs: FileSystem;
  /** Shell command execution abstraction. */
  shell: Shell;
  /** Path to the per-project .polpo directory. */
  polpoDir: string;
  /**
   * LLM review function — injected by the shell layer.
   * When not provided, llm_review expectations will fail with an error message.
   */
  runLLMReview?: (
    expectation: TaskExpectation,
    cwd: string,
    onProgress?: (msg: string) => void,
    context?: ReviewContext,
    reasoning?: ReasoningLevel,
  ) => Promise<CheckResult>;
}

const SCRIPT_MAX_BUFFER = 5 * 1024 * 1024; // 5 MB

export async function runCheck(
  deps: AssessmentDeps,
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
        await deps.shell.execute(cmd, { cwd });
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
        const resolvedPath = pathResolve(cwd, p);
        const exists = await deps.fs.exists(resolvedPath);
        if (!exists) {
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
          const result = await deps.shell.execute(cmd, { cwd });
          if (result.exitCode !== 0) {
            return { type: "script", passed: false, message: `Script failed: ${label}`, details: result.stderr || result.stdout };
          }
          return { type: "script", passed: true, message: `Script passed: ${label}` };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { type: "script", passed: false, message: `Script failed: ${label}`, details: msg };
        }
      }

      // Multi-line: write to temp file, execute with bash, cleanup
      const tmpDir = pathJoin(deps.polpoDir, "tmp");
      const scriptFile = pathJoin(tmpDir, `check-${nanoid(8)}.sh`);
      try {
        await deps.fs.mkdir(tmpDir);
        // set -euo pipefail: fail on first error, like CI/CD
        const scriptContent = `#!/usr/bin/env bash\nset -euo pipefail\n\n${cmd}\n`;
        await deps.fs.writeFile(scriptFile, scriptContent);
        const result = await deps.shell.execute(`bash "${scriptFile}"`, { cwd });
        if (result.exitCode !== 0) {
          return {
            type: "script",
            passed: false,
            message: `Script failed: ${label}`,
            details: result.stderr || result.stdout,
          };
        }
        return {
          type: "script",
          passed: true,
          message: `Script passed: ${label}`,
          details: result.stdout || result.stderr || undefined,
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
        try { await deps.fs.remove(scriptFile); } catch { /* file already removed */ }
      }
    }

    case "llm_review": {
      if (!deps.runLLMReview) {
        return {
          type: "llm_review",
          passed: false,
          message: "LLM review not available — no runLLMReview port provided",
        };
      }
      return await deps.runLLMReview(expectation, cwd, onProgress, context, reasoning);
    }
  }
}

export async function runMetric(
  deps: AssessmentDeps,
  metric: TaskMetric,
  cwd: string
): Promise<MetricResult> {
  try {
    const result = await deps.shell.execute(metric.command, { cwd });
    const value = parseFloat(result.stdout.trim());
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

/** Label for an expectation — used in progress events. */
function expectationLabel(exp: TaskExpectation): string {
  if (exp.type === "test") return exp.command ?? "npm test";
  if (exp.type === "file_exists") return (exp.paths ?? []).join(", ") || "file_exists";
  if (exp.type === "script") {
    const cmd = exp.command ?? "";
    return cmd.includes("\n") ? `script (${cmd.split("\n").length} lines)` : cmd;
  }
  if (exp.type === "llm_review") return exp.criteria ? exp.criteria.slice(0, 60) : "LLM review";
  return exp.type;
}

export interface CheckProgressEvent {
  index: number;
  total: number;
  type: string;
  label: string;
  phase: "started" | "complete";
  passed?: boolean;
  message?: string;
}

export async function assessTask(
  deps: AssessmentDeps,
  task: Task,
  cwd: string,
  onProgress?: (msg: string) => void,
  context?: ReviewContext,
  reasoning?: ReasoningLevel,
  onCheckProgress?: (event: CheckProgressEvent) => void,
): Promise<AssessmentResult> {
  const total = task.expectations.length;
  const checks = await Promise.all(
    task.expectations.map(async (exp, i) => {
      const label = expectationLabel(exp);
      onCheckProgress?.({ index: i, total, type: exp.type, label, phase: "started" });
      const result = await runCheck(deps, exp, cwd, onProgress, context, reasoning);
      onCheckProgress?.({ index: i, total, type: exp.type, label, phase: "complete", passed: result.passed, message: result.message });
      return result;
    })
  );
  const metrics = await Promise.all(
    task.metrics.map((m) => runMetric(deps, m, cwd))
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
