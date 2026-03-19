/**
 * Shell shim — delegates to @polpo-ai/core assessor with Node.js adapters.
 *
 * Wires NodeFileSystem + NodeShell + runLLMReview into the core's
 * AssessmentDeps interface. All callers keep their existing signatures.
 */
import { resolve } from "node:path";
import { getPolpoDir } from "../core/constants.js";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";
import {
  assessTask as coreAssessTask,
  runCheck as coreRunCheck,
  runMetric as coreRunMetric,
  type AssessmentDeps,
} from "@polpo-ai/core/assessor";
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

// Re-export CheckProgressEvent from core for backward compatibility
export type { CheckProgressEvent } from "@polpo-ai/core/assessor";

// ── Lazy-initialized shared adapters ────────────────────────────────────

let _fs: NodeFileSystem | undefined;
let _shell: NodeShell | undefined;

function getFS(): NodeFileSystem {
  if (!_fs) _fs = new NodeFileSystem();
  return _fs;
}

function getShell(): NodeShell {
  if (!_shell) _shell = new NodeShell();
  return _shell;
}

function makeDeps(cwd: string): AssessmentDeps {
  return {
    fs: getFS(),
    shell: getShell(),
    polpoDir: getPolpoDir(cwd),
    runLLMReview,
  };
}

// ── Backward-compatible signatures (same as before) ─────────────────────

export async function runCheck(
  expectation: TaskExpectation,
  cwd: string,
  onProgress?: (msg: string) => void,
  context?: ReviewContext,
  reasoning?: ReasoningLevel,
): Promise<CheckResult> {
  return coreRunCheck(makeDeps(cwd), expectation, cwd, onProgress, context, reasoning);
}

export async function runMetric(
  metric: TaskMetric,
  cwd: string,
): Promise<MetricResult> {
  return coreRunMetric(makeDeps(cwd), metric, cwd);
}

export async function assessTask(
  task: Task,
  cwd: string,
  onProgress?: (msg: string) => void,
  context?: ReviewContext,
  reasoning?: ReasoningLevel,
  onCheckProgress?: (event: import("@polpo-ai/core/assessor").CheckProgressEvent) => void,
): Promise<AssessmentResult> {
  return coreAssessTask(makeDeps(cwd), task, cwd, onProgress, context, reasoning, onCheckProgress);
}
