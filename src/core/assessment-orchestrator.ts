/**
 * Re-export shim: AssessmentOrchestrator from @polpo-ai/core.
 * Source of truth is packages/core/src/assessment-orchestrator.ts.
 *
 * This shim extends the pure-core class to inject Node.js-specific ports
 * (node:fs, node:path, LLM answer generator) so the root orchestrator
 * can keep calling `new AssessmentOrchestrator(ctx)` unchanged.
 */

import { join, basename } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { AssessmentOrchestrator as CoreAssessmentOrchestrator, type AssessmentPorts } from "@polpo-ai/core/assessment-orchestrator";
import type { OrchestratorContext } from "./orchestrator-context.js";
import { generateAnswer } from "../llm/answer-generator.js";
import { classifyAsQuestion } from "./question-detector.js";
import type { Orchestrator } from "./orchestrator.js";
import type { Task, ModelConfig } from "./types.js";

/** Build Node.js-specific ports for the core AssessmentOrchestrator. */
function buildNodePorts(ctx: OrchestratorContext): AssessmentPorts {
  return {
    fileExists: (path: string) => existsSync(path),
    readDir: (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      return entries.map(e => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
      }));
    },
    joinPath: (...parts: string[]) => join(...parts),
    baseName: (path: string) => basename(path),
    generateAnswer: (task: Task, question: string, model?: string | ModelConfig) =>
      generateAnswer(ctx.emitter as unknown as Orchestrator, task, question, model),
    classifyAsQuestion: (stdout: string, model?: string | ModelConfig) =>
      classifyAsQuestion(stdout, model),
  };
}

/**
 * Ensure ctx.queryLLM is populated for the core class.
 * The real orchestrator always sets this, but tests may not.
 * In that case, lazy-import queryOrchestratorText as fallback.
 */
function ensureQueryLLM(ctx: OrchestratorContext): OrchestratorContext {
  if (ctx.queryLLM) return ctx;
  return Object.create(ctx, {
    queryLLM: {
      value: async (prompt: string, model?: string | ModelConfig) => {
        const { queryOrchestratorText } = await import("../llm/query.js");
        return queryOrchestratorText(prompt, model);
      },
      enumerable: true,
    },
  }) as OrchestratorContext;
}

/**
 * Node.js shell wrapper — automatically injects Node.js ports.
 * API-compatible with the old root AssessmentOrchestrator.
 */
export class AssessmentOrchestrator extends CoreAssessmentOrchestrator {
  constructor(ctx: OrchestratorContext) {
    super(ensureQueryLLM(ctx), buildNodePorts(ctx));
  }
}
