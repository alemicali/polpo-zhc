import { join, basename } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { Task, TaskResult, AssessmentResult, TaskExpectation, ReviewContext } from "./types.js";
import { setAssessment } from "./types.js";
import { buildFixPrompt, buildRetryPrompt, buildJudgePrompt, type JudgeVerdict, type JudgeCorrection } from "./assessment-prompts.js";
import { looksLikeQuestion, classifyAsQuestion } from "./question-detector.js";
import { generateAnswer } from "../llm/answer-generator.js";
import { queryOrchestratorText } from "../llm/query.js";
// resolveModelSpec no longer needed — queryOrchestratorText handles ModelConfig directly
import type { Orchestrator } from "./orchestrator.js";

/**
 * Handles the full assessment pipeline: result collection → question detection →
 * assessment → auto-correction → judge → fix/retry/fail.
 */
export class AssessmentOrchestrator {
  constructor(private ctx: OrchestratorContext) {}

  /**
   * Attempt to transition a task to "done", but first run the before:task:complete
   * hook so approval gates (and any other hooks) can block it.
   * Returns true if the task transitioned to done, false if a hook blocked it.
   */
  private async transitionToDone(
    taskId: string, task: Task, result: TaskResult,
  ): Promise<boolean> {
    const hookResult = await this.ctx.hooks.runBefore("task:complete", {
      taskId, task, result,
    });
    if (hookResult.cancelled) {
      this.ctx.emitter.emit("log", {
        level: "info",
        message: `[${taskId}] Completion blocked by hook: ${hookResult.cancelReason ?? "no reason"}`,
      });
      return false;
    }
    this.ctx.emitter.emit("task:transition", {
      taskId,
      from: task.status,
      to: "done",
      task: { ...task, status: "done" },
    });
    this.ctx.registry.transition(taskId, "done");
    this.ctx.registry.updateTask(taskId, { phase: undefined });

    // Fire after:task:complete (async, fire-and-forget)
    this.ctx.hooks.runAfter("task:complete", { taskId, task, result }).catch(() => {});
    return true;
  }

  /** Resolve effective confidence: explicit field, or default by type. */
  private getConfidence(exp: TaskExpectation): "firm" | "estimated" {
    if (exp.confidence) return exp.confidence;
    return exp.type === "file_exists" ? "estimated" : "firm";
  }

  /** Check if any failed checks correspond to estimated expectations. */
  private hasEstimatedFailures(task: Task, assessment: AssessmentResult): boolean {
    const failedTypes = new Set(assessment.checks.filter(c => !c.passed).map(c => c.type));
    return task.expectations.some(e => failedTypes.has(e.type) && this.getConfidence(e) === "estimated");
  }

  handleResult(taskId: string, result: TaskResult): void {
    const task = this.ctx.registry.getTask(taskId);
    if (!task) return;

    // Skip if already terminal
    if (task.status === "done" || task.status === "failed") return;

    this.ctx.emitter.emit("agent:finished", {
      taskId,
      agentName: task.assignTo,
      exitCode: result.exitCode,
      duration: result.duration,
      sessionId: task.sessionId,
    });

    // Ensure we're in review state
    if (task.status === "in_progress") {
      this.ctx.registry.transition(taskId, "review");
      this.ctx.registry.updateTask(taskId, { phase: "review" });
    }

    // Question detection: intercept before assessment
    const maxQRounds = this.ctx.config.settings.maxQuestionRounds ?? 2;
    const questionRounds = task.questionRounds ?? 0;
    if (result.exitCode === 0 && questionRounds < maxQRounds) {
      // Get activity from RunStore for richer heuristic
      const run = this.ctx.runStore.getRunByTaskId(taskId);
      const activity = run?.activity;
      if (looksLikeQuestion(result, activity)) {
        this.handlePossibleQuestion(taskId, task, result);
        return;
      }
    }

    this.proceedToAssessment(taskId, task, result);
  }

  /**
   * LLM-classify a potential question, then either resolve+rerun or proceed to assessment.
   */
  private handlePossibleQuestion(taskId: string, task: Task, result: TaskResult): void {
    classifyAsQuestion(result.stdout, this.ctx.workDir, this.ctx.config.settings.orchestratorModel).then(classification => {
      if (classification.isQuestion) {
        this.resolveAndRerun(taskId, task, result, classification.question);
      } else {
        this.proceedToAssessment(taskId, task, result);
      }
    }).catch(() => {
      // Classification failed → proceed normally
      this.proceedToAssessment(taskId, task, result);
    });
  }

  /**
   * Auto-answer an agent's question and re-run the task (no retry burn).
   */
  private resolveAndRerun(taskId: string, task: Task, result: TaskResult, question: string): void {
    this.ctx.emitter.emit("task:question", { taskId, question });

    generateAnswer(this.ctx.emitter as unknown as Orchestrator, task, question, this.ctx.workDir, this.ctx.config.settings.orchestratorModel).then(answer => {
      this.ctx.emitter.emit("task:answered", { taskId, question, answer });

      const current = this.ctx.registry.getTask(taskId);
      if (!current) return;

      // Save original description before first Q&A
      if (!current.originalDescription) {
        this.ctx.registry.updateTask(taskId, { originalDescription: current.description });
      }

      // Append Q&A to description and re-run (no retry burn)
      const qaBlock = `\n\n[Polpo Clarification]\nQ: ${question}\nA: ${answer}`;
      this.ctx.registry.unsafeSetStatus(taskId, "pending", "Q&A re-run — no retry burn");
      this.ctx.registry.updateTask(taskId, {
        phase: "execution",
        description: current.description + qaBlock,
        questionRounds: (current.questionRounds ?? 0) + 1,
      });
    }).catch(() => {
      // Answer generation failed → proceed to assessment normally
      this.proceedToAssessment(taskId, task, result);
    });
  }

  /**
   * Run assessment with retry when all LLM reviewers fail.
   * Retries up to maxAssessmentRetries times before returning the failed result.
   */
  private async runAssessmentWithRetry(
    task: Task, cwd: string, progressCb: (msg: string) => void,
    context?: ReviewContext,
  ): Promise<AssessmentResult> {
    const maxRetries = this.ctx.config.settings.maxAssessmentRetries ?? 1;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const assessment = await this.ctx.assessFn(task, cwd, progressCb, context);

      // Check if failure is due to all evaluators failing (not low scores)
      const allEvalsFailed = !assessment.passed && assessment.checks.some(
        c => c.type === "llm_review" && !c.passed && c.message.includes("all evaluators failed"),
      );

      if (!allEvalsFailed || attempt === maxRetries) {
        return assessment;
      }

      this.ctx.emitter.emit("log", {
        level: "warn",
        message: `[${task.id}] All reviewers failed, retrying assessment (${attempt + 1}/${maxRetries})`,
      });
    }

    // Unreachable — satisfies TypeScript
    return this.ctx.assessFn(task, cwd, progressCb, context);
  }

  /**
   * Standard assessment flow: run expectations/metrics, then mark done/failed/fix/retry.
   */
  private proceedToAssessment(taskId: string, task: Task, result: TaskResult): void {
    if (task.expectations.length > 0 || task.metrics.length > 0) {
      // Run before:assessment:run hook (async — assessment is already async)
      this.ctx.hooks.runBefore("assessment:run", { taskId, task }).then(hookResult => {
        if (hookResult.cancelled) {
          this.ctx.emitter.emit("log", {
            level: "info",
            message: `[${taskId}] Assessment blocked by hook: ${hookResult.cancelReason ?? "no reason"}`,
          });
          // Skip assessment — mark done with result as-is
          this.ctx.registry.updateTask(taskId, { result });
          if (result.exitCode === 0) {
            this.transitionToDone(taskId, task, result).catch(() => {});
          } else {
            this.retryOrFail(taskId, task, result);
          }
          return;
        }
        this.runAssessmentFlow(taskId, task, result);
      }).catch(() => {
        this.runAssessmentFlow(taskId, task, result);
      });
    } else {
      this.ctx.registry.updateTask(taskId, { result });
      if (result.exitCode === 0) {
        this.transitionToDone(taskId, task, result).catch(() => {});
      } else {
        this.retryOrFail(taskId, task, result);
      }
    }
  }

  /**
   * Core assessment flow — extracted to allow hook interception in proceedToAssessment.
   */
  private runAssessmentFlow(taskId: string, task: Task, result: TaskResult): void {
    this.ctx.emitter.emit("assessment:started", { taskId });
      const progressCb = (msg: string) => this.ctx.emitter.emit("assessment:progress", { taskId, message: msg });

      // Build review context from RunStore activity
      const run = this.ctx.runStore.getRunByTaskId(taskId);
      const activity = run?.activity;
      const reviewContext: ReviewContext = {
        taskTitle: task.title,
        taskDescription: task.originalDescription ?? task.description,
        agentOutput: result.stdout || undefined,
        filesCreated: activity?.filesCreated,
        filesEdited: activity?.filesEdited,
      };

      this.runAssessmentWithRetry(task, this.ctx.workDir, progressCb, reviewContext).then(assessment => {
        setAssessment(result, assessment, "initial");
        this.ctx.registry.updateTask(taskId, { result });

        if (assessment.passed && result.exitCode === 0) {
          this.ctx.emitter.emit("assessment:complete", {
            taskId,
            passed: true,
            scores: assessment.scores,
            globalScore: assessment.globalScore,
            message: task.title,
          });
          this.transitionToDone(taskId, task, result).catch(() => {});
        } else if (assessment.passed && result.exitCode !== 0) {
          // Checks passed but agent failed (killed, crashed, non-zero exit).
          // Override assessment to failed — the agent didn't complete successfully.
          assessment.passed = false;
          const exitMsg = `Agent exited with code ${result.exitCode}`;
          assessment.checks.push({
            type: "test",
            passed: false,
            message: exitMsg,
            details: result.stderr || undefined,
          });
          this.ctx.registry.updateTask(taskId, { result });
          this.ctx.emitter.emit("assessment:complete", {
            taskId,
            passed: false,
            scores: assessment.scores,
            globalScore: assessment.globalScore,
            message: exitMsg,
          });
          this.retryOrFail(taskId, task, result);
        } else {
          const reasons = [
            ...assessment.checks.filter(c => !c.passed).map(c => `${c.type}: ${c.message}`),
            ...assessment.metrics.filter(m => !m.passed).map(m => `${m.name}: ${m.value} < ${m.threshold}`),
          ];
          this.ctx.emitter.emit("assessment:complete", {
            taskId,
            passed: false,
            scores: assessment.scores,
            globalScore: assessment.globalScore,
            message: reasons.join(", "),
          });
          // Execution OK but review failed → check if estimated expectations can be corrected
          if (result.exitCode === 0) {
            const autoCorrect = this.ctx.config.settings.autoCorrectExpectations !== false;
            const hasEstimatedFailures = this.hasEstimatedFailures(task, assessment);

            if (autoCorrect && hasEstimatedFailures) {
              this.tryAutoCorrectExpectations(taskId, task, result, assessment).then(corrected => {
                if (corrected) return;
                return this.judgeExpectations(taskId, task, result, assessment).then(judged => {
                  if (!judged) this.fixOrRetry(taskId, task, result);
                });
              }).catch(() => {
                this.fixOrRetry(taskId, task, result);
              });
            } else {
              this.fixOrRetry(taskId, task, result);
            }
          } else {
            this.retryOrFail(taskId, task, result);
          }
        }
      }).catch(err => {
        this.ctx.emitter.emit("log", { level: "error", message: `[${taskId}] Assessment error: ${err.message}` });
        this.ctx.registry.updateTask(taskId, { result });
        this.retryOrFail(taskId, task, result);
      });
  }

  /**
   * Auto-correct expectations when assessment fails due to wrong paths.
   * If the only failures are file_exists checks with incorrect paths, search
   * for the actual files using agent activity + filesystem, update expectations,
   * and re-assess. Returns true if auto-correction succeeded (task is done).
   */
  private async tryAutoCorrectExpectations(
    taskId: string, task: Task, result: TaskResult, assessment: AssessmentResult,
  ): Promise<boolean> {
    const failedChecks = assessment.checks.filter(c => !c.passed);
    const failedMetrics = assessment.metrics.filter(m => !m.passed);
    if (failedMetrics.length > 0) return false;
    if (failedChecks.length === 0) return false;

    // Only correct estimated file_exists expectations; firm ones are never touched
    const nonCorrectableFailures = failedChecks.filter(c => {
      if (c.type !== "file_exists") return true;
      const exp = task.expectations.find(e => e.type === c.type);
      return exp ? this.getConfidence(exp) === "firm" : true;
    });
    if (nonCorrectableFailures.length > 0) return false;

    // Gather agent's actual file list from activity
    const run = this.ctx.runStore.getRunByTaskId(taskId);
    const activity = run?.activity;
    const agentFiles = [
      ...(activity?.filesCreated ?? []),
      ...(activity?.filesEdited ?? []),
    ];

    // For each file_exists expectation that failed, try to find the actual path
    const corrections = new Map<number, string[]>(); // expectation index → corrected paths
    let allCorrected = true;

    for (let i = 0; i < task.expectations.length; i++) {
      const exp = task.expectations[i];
      if (exp.type !== "file_exists" || !exp.paths) continue;

      // Check if this expectation's check failed
      const check = assessment.checks.find(c => c.type === "file_exists" && !c.passed);
      if (!check) continue;

      const correctedPaths: string[] = [];
      for (const expectedPath of exp.paths) {
        if (existsSync(expectedPath)) {
          correctedPaths.push(expectedPath);
          continue;
        }

        // Try to find by basename in agent's created/edited files
        const name = basename(expectedPath);
        const match = agentFiles.find(f => basename(f) === name);
        if (match && existsSync(match)) {
          correctedPaths.push(match);
          continue;
        }

        // Try to find by basename in workDir (shallow search in common locations)
        const found = this.findFileByName(name);
        if (found) {
          correctedPaths.push(found);
          continue;
        }

        // Can't find this file — can't auto-correct
        allCorrected = false;
        break;
      }

      if (!allCorrected) break;
      if (correctedPaths.length > 0) {
        corrections.set(i, correctedPaths);
      }
    }

    if (!allCorrected || corrections.size === 0) return false;

    // Apply corrections
    const newExpectations = [...task.expectations];
    for (const [idx, paths] of corrections) {
      newExpectations[idx] = { ...newExpectations[idx], paths };
    }

    this.ctx.registry.updateTask(taskId, { expectations: newExpectations });
    this.ctx.emitter.emit("assessment:corrected", { taskId, corrections: corrections.size });

    // Re-assess with corrected expectations
    const current = this.ctx.registry.getTask(taskId);
    if (!current) return false;

    try {
      const progressCb = (msg: string) => this.ctx.emitter.emit("assessment:progress", { taskId, message: msg });
      const reCtx: ReviewContext = {
        taskTitle: task.title,
        taskDescription: task.originalDescription ?? task.description,
        agentOutput: result.stdout || undefined,
        filesCreated: activity?.filesCreated,
        filesEdited: activity?.filesEdited,
      };
      const newAssessment = await this.ctx.assessFn(current, this.ctx.workDir, progressCb, reCtx);
      setAssessment(result, newAssessment, "auto-correct");
      this.ctx.registry.updateTask(taskId, { result });

      if (newAssessment.passed) {
        this.ctx.emitter.emit("assessment:complete", {
          taskId,
          passed: true,
          scores: newAssessment.scores,
          globalScore: newAssessment.globalScore,
          message: `${task.title} (paths auto-corrected)`,
        });
        return this.transitionToDone(taskId, task, result);
      }
    } catch { /* re-assessment failed */
    }

    return false;
  }

  /** Search for a file by name in common project locations. */
  private findFileByName(name: string): string | null {
    const searchDirs = [this.ctx.workDir, join(this.ctx.workDir, "src")];
    for (const dir of searchDirs) {
      const found = this.searchDir(dir, name, 4);
      if (found) return found;
    }
    return null;
  }

  /**
   * LLM judge: analyze failed estimated expectations vs agent output and decide
   * whether they are wrong (correct them) or the agent's work is wrong (fix phase).
   * Only operates on estimated expectations — firm ones are never touched.
   * Returns true if expectations were corrected and re-assessment passed.
   */
  private async judgeExpectations(
    taskId: string, task: Task, result: TaskResult, assessment: AssessmentResult,
  ): Promise<boolean> {
    // Only judge estimated expectations
    const failedChecks = assessment.checks.filter(c => {
      if (c.passed) return false;
      const exp = task.expectations.find(e => e.type === c.type);
      return exp ? this.getConfidence(exp) === "estimated" : false;
    });
    if (failedChecks.length === 0) return false;

    // Don't judge if score is very low — that's clearly bad work
    if (assessment.globalScore !== undefined && assessment.globalScore < 2.5) return false;

    // Gather context
    const run = this.ctx.runStore.getRunByTaskId(taskId);
    const activity = run?.activity;

    const prompt = buildJudgePrompt(task, result, assessment, failedChecks, activity);

    let response: string;
    try {
      response = (await queryOrchestratorText(prompt, this.ctx.workDir, this.ctx.config.settings.orchestratorModel)).text;
    } catch { /* LLM query failed */
      return false;
    }

    // Parse LLM verdict
    let verdict: JudgeVerdict;
    try {
      const cleaned = response.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      verdict = JSON.parse(cleaned);
      if (!verdict.corrections || !Array.isArray(verdict.corrections)) return false;
    } catch { /* malformed JSON response */
      return false;
    }

    // Apply corrections only if LLM found at least one fixable expectation
    const fixable = verdict.corrections.filter((c: JudgeCorrection) => c.verdict === "expectation_wrong" && c.fix);
    if (fixable.length === 0) return false;

    const newExpectations = [...task.expectations];
    let correctionCount = 0;

    for (const fix of fixable) {
      const idx = task.expectations.findIndex(e => e.type === fix.type);
      if (idx < 0 || !fix.fix) continue;

      // Double-check: never correct firm expectations even if LLM suggests it
      const exp = newExpectations[idx];
      if (this.getConfidence(exp) === "firm") continue;
      const f = fix.fix;
      if (fix.type === "file_exists" && f.paths) {
        newExpectations[idx] = { ...exp, paths: f.paths };
        correctionCount++;
      } else if ((fix.type === "test" || fix.type === "script") && f.command) {
        newExpectations[idx] = { ...exp, command: f.command };
        correctionCount++;
      } else if (fix.type === "llm_review" && f.threshold !== undefined) {
        newExpectations[idx] = { ...exp, threshold: f.threshold };
        correctionCount++;
      }
    }

    if (correctionCount === 0) return false;

    this.ctx.registry.updateTask(taskId, { expectations: newExpectations });
    this.ctx.emitter.emit("assessment:corrected", { taskId, corrections: correctionCount });

    // Re-assess with corrected expectations
    const current = this.ctx.registry.getTask(taskId);
    if (!current) return false;

    try {
      const progressCb = (msg: string) => this.ctx.emitter.emit("assessment:progress", { taskId, message: msg });
      const judgeCtx: ReviewContext = {
        taskTitle: task.title,
        taskDescription: task.originalDescription ?? task.description,
        agentOutput: result.stdout || undefined,
        filesCreated: activity?.filesCreated,
        filesEdited: activity?.filesEdited,
      };
      const newAssessment = await this.ctx.assessFn(current, this.ctx.workDir, progressCb, judgeCtx);
      setAssessment(result, newAssessment, "judge");
      this.ctx.registry.updateTask(taskId, { result });

      if (newAssessment.passed) {
        this.ctx.emitter.emit("assessment:complete", {
          taskId,
          passed: true,
          scores: newAssessment.scores,
          globalScore: newAssessment.globalScore,
          message: `${task.title} (expectations corrected)`,
        });
        return this.transitionToDone(taskId, task, result);
      }
    } catch { /* re-assessment failed */
    }

    return false;
  }

  /** Recursive directory search (bounded depth). */
  private searchDir(dir: string, name: string, maxDepth: number): string | null {
    if (maxDepth <= 0) return null;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name === name) return fullPath;
        if (entry.isDirectory()) {
          const found = this.searchDir(fullPath, name, maxDepth - 1);
          if (found) return found;
        }
      }
    } catch { /* permission error or missing dir */ }
    return null;
  }

  /**
   * Fix phase: when execution succeeded but review failed, try a targeted fix
   * without burning a full retry. After maxFixAttempts, fall back to full retry.
   */
  private fixOrRetry(taskId: string, _task: Task, result: TaskResult): void {
    const current = this.ctx.registry.getTask(taskId);
    if (!current) return;

    const maxFix = this.ctx.config.settings.maxFixAttempts ?? 2;
    const fixAttempts = (current.fixAttempts ?? 0) + 1;

    if (fixAttempts <= maxFix) {
      // Save original description before first fix/retry
      if (!current.originalDescription) {
        this.ctx.registry.updateTask(taskId, { originalDescription: current.description });
      }

      this.ctx.emitter.emit("task:fix", { taskId, attempt: fixAttempts, maxFix });

      // unsafeSetStatus bypasses retry increment (fix attempts are NOT real failures)
      this.ctx.registry.unsafeSetStatus(taskId, "pending", "fix phase — no retry burn");
      this.ctx.registry.updateTask(taskId, {
        phase: "fix",
        fixAttempts,
        description: buildFixPrompt(current, result),
      });
    } else {
      // Fix attempts exhausted → full retry (burns 1 retry)
      this.ctx.emitter.emit("log", { level: "warn", message: `[${taskId}] Fix attempts exhausted (${maxFix}), falling back to full retry` });
      this.ctx.registry.updateTask(taskId, {
        phase: "execution",
        fixAttempts: 0,
      });
      this.retryOrFail(taskId, _task, result);
    }
  }

  /** @internal — exposed for test access via Orchestrator facade */
  retryOrFail(taskId: string, _task: Task, result: TaskResult): void {
    const current = this.ctx.registry.getTask(taskId);
    if (!current) return;

    // Don't retry tasks from cancelled plans
    if (current.group) {
      const plan = this.ctx.registry.getPlanByName?.(current.group);
      if (plan && plan.status === "cancelled") {
        this.ctx.emitter.emit("log", { level: "debug", message: `[${taskId}] Skipping retry — plan cancelled` });
        this.ctx.registry.transition(taskId, "failed");
        return;
      }
    }

    if (current.retries < current.maxRetries) {
      const policy = current.retryPolicy ?? this.ctx.config.settings.defaultRetryPolicy;
      const nextAttempt = current.retries + 1;

      // Save original description before first retry
      if (!current.originalDescription) {
        this.ctx.registry.updateTask(taskId, { originalDescription: current.description });
      }

      // Check if we should escalate to a different agent
      let assignTo = current.assignTo;
      if (policy?.escalateAfter !== undefined && nextAttempt >= policy.escalateAfter) {
        if (policy.fallbackAgent) {
          const fallback = this.ctx.config.team.agents.find(a => a.name === policy.fallbackAgent);
          if (fallback) {
            assignTo = policy.fallbackAgent;
            this.ctx.emitter.emit("log", { level: "info", message: `[${taskId}] Escalating to ${assignTo} (attempt ${nextAttempt})` });
          }
        }
      }

      this.ctx.emitter.emit("task:retry", { taskId, attempt: nextAttempt, maxRetries: current.maxRetries });
      this.ctx.registry.transition(taskId, "failed");
      this.ctx.registry.transition(taskId, "pending");
      this.ctx.registry.updateTask(taskId, {
        description: buildRetryPrompt(current, result),
        assignTo,
        phase: "execution",
        fixAttempts: 0,
      });
    } else {
      this.ctx.emitter.emit("task:maxRetries", { taskId });

      // Run before:task:fail hook — escalation manager can intercept here
      this.ctx.hooks.runBefore("task:fail", {
        taskId,
        task: current,
        result,
        reason: "maxRetries",
      }).then(hookResult => {
        if (hookResult.cancelled) {
          this.ctx.emitter.emit("log", {
            level: "info",
            message: `[${taskId}] Final failure intercepted by hook: ${hookResult.cancelReason ?? "escalation"}`,
          });
          return;  // Escalation manager (or other hook) is handling this
        }
        this.ctx.registry.transition(taskId, "failed");
        this.ctx.registry.updateTask(taskId, { phase: undefined });

        // Fire after:task:fail
        this.ctx.hooks.runAfter("task:fail", {
          taskId,
          task: current,
          result,
          reason: "maxRetries",
        }).catch(() => {});
      }).catch(() => {
        // Hook failed — fail the task normally
        this.ctx.registry.transition(taskId, "failed");
        this.ctx.registry.updateTask(taskId, { phase: undefined });
      });
    }
  }
}
