import { resolve } from "node:path";
import chalk from "chalk";
import { parseConfig } from "./config.js";
import { TaskRegistry } from "./task-registry.js";
import { getAdapter, type AgentHandle } from "./adapter.js";
import { assessTask } from "./assessor.js";
import type {
  OrchestraConfig,
  Task,
  TaskResult,
} from "./types.js";

// Import adapters so they self-register
import "./adapter-claude-sdk.js";
import "./adapter-generic.js";

const POLL_INTERVAL = 2000; // 2 seconds

export class Orchestrator {
  private registry!: TaskRegistry;
  private config!: OrchestraConfig;
  private orchestraDir: string;
  private workDir: string;
  private idMap = new Map<string, string>();
  private handles = new Map<string, AgentHandle>(); // taskId → handle

  constructor(workDir: string = ".") {
    this.workDir = resolve(workDir);
    this.orchestraDir = resolve(workDir, ".orchestra");
  }

  async init(): Promise<void> {
    const configPath = resolve(this.workDir, "orchestra.yml");
    this.config = await parseConfig(configPath);
    this.registry = new TaskRegistry(this.orchestraDir);
  }

  private seedTasks(): void {
    const existing = this.registry.getAllTasks();
    if (existing.length > 0) {
      for (const task of existing) this.idMap.set(task.title, task.id);
      return;
    }

    for (const taskDef of this.config.tasks) {
      const created = this.registry.addTask({
        title: taskDef.title,
        description: taskDef.description,
        assignTo: taskDef.assignTo,
        dependsOn: [],
        expectations: taskDef.expectations,
        metrics: taskDef.metrics,
        maxRetries: taskDef.maxRetries ?? this.config.settings.maxRetries,
      });
      this.idMap.set(taskDef.id, created.id);
    }

    for (const taskDef of this.config.tasks) {
      const registryId = this.idMap.get(taskDef.id);
      if (!registryId) continue;
      const resolvedDeps = taskDef.dependsOn
        .map((depId) => this.idMap.get(depId))
        .filter((id): id is string => !!id);
      if (resolvedDeps.length > 0) {
        this.registry.updateTask(registryId, { dependsOn: resolvedDeps });
      }
    }

    this.registry.setState({
      project: this.config.project,
      team: this.config.team,
      startedAt: new Date().toISOString(),
    });
  }

  private log(msg: string): void {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${msg}`);
  }

  /**
   * Main supervisor loop. Runs forever until all tasks are done/failed.
   * Never crashes - catches all errors and keeps going.
   */
  async run(): Promise<void> {
    await this.init();
    this.seedTasks();

    this.log(chalk.bold(`Orchestra started — ${this.config.project}`));
    this.log(chalk.dim(`Team: ${this.config.team.name} | Agents: ${this.config.team.agents.map(a => a.name).join(", ")}`));
    this.log(chalk.dim(`Tasks: ${this.config.tasks.length}`));
    console.log();

    // Supervisor loop
    while (true) {
      try {
        const allDone = this.tick();
        if (allDone) break;
      } catch (err: any) {
        this.log(chalk.red(`[supervisor] Error in tick: ${err.message}`));
      }
      await sleep(POLL_INTERVAL);
    }

    this.printReport();
  }

  /**
   * Single tick of the supervisor loop. Returns true when all work is done.
   */
  private tick(): boolean {
    const tasks = this.registry.getAllTasks();
    const pending = tasks.filter(t => t.status === "pending");
    const inProgress = tasks.filter(t => t.status === "in_progress" || t.status === "assigned" || t.status === "review");

    // Check if all tasks are terminal (done or failed)
    const terminal = tasks.filter(t => t.status === "done" || t.status === "failed");
    if (terminal.length === tasks.length) return true;

    // 1. Collect results from finished agents
    this.collectResults();

    // 2. Spawn agents for ready tasks
    const ready = pending.filter(task =>
      task.dependsOn.every(depId => {
        const dep = tasks.find(t => t.id === depId);
        return dep && dep.status === "done";
      })
    );

    // Check for deadlock
    if (ready.length === 0 && inProgress.length === 0 && pending.length > 0) {
      this.log(chalk.red("Deadlock detected: tasks have unresolvable dependencies."));
      for (const t of pending) {
        this.registry.transition(t.id, "assigned");
        this.registry.transition(t.id, "in_progress");
        this.registry.transition(t.id, "failed");
      }
      return true;
    }

    for (const task of ready) {
      if (this.handles.has(task.id)) continue; // already spawned
      this.spawnForTask(task);
    }

    // Update process list in state with activity info
    const processes = Array.from(this.handles.values()).map(h => ({
      agentName: h.agentName,
      pid: 0,
      taskId: h.taskId,
      startedAt: h.startedAt,
      alive: h.isAlive(),
      activity: h.activity,
    }));
    this.registry.setState({ processes });

    return false;
  }

  /**
   * Check all handles for completed agents and process their results.
   */
  private collectResults(): void {
    for (const [taskId, handle] of this.handles) {
      if (handle.isAlive()) continue; // still running

      // Agent finished - process result
      handle.done.then(result => {
        this.handleResult(taskId, result);
      }).catch(err => {
        this.log(chalk.red(`[collect] Error getting result for ${taskId}: ${err.message}`));
        this.handleResult(taskId, {
          exitCode: 1,
          stdout: "",
          stderr: `Orchestra error: ${err.message}`,
          duration: 0,
        });
      });

      this.handles.delete(taskId);
    }
  }

  private handleResult(taskId: string, result: TaskResult): void {
    const task = this.registry.getTask(taskId);
    if (!task) return;

    // Skip if already terminal
    if (task.status === "done" || task.status === "failed") return;

    this.log(`[${taskId}] Agent finished — exit ${result.exitCode} (${(result.duration / 1000).toFixed(1)}s)`);

    // Ensure we're in review state
    if (task.status === "in_progress") {
      this.registry.transition(taskId, "review");
    }

    if (task.expectations.length > 0 || task.metrics.length > 0) {
      this.log(chalk.dim(`[${taskId}] Running assessment...`));
      assessTask(task, this.workDir).then(assessment => {
        result.assessment = assessment;
        this.registry.updateTask(taskId, { result });

        if (assessment.passed) {
          const scoreInfo = assessment.globalScore !== undefined
            ? ` (score: ${assessment.globalScore.toFixed(1)}/5)`
            : "";
          this.log(chalk.green(`[${taskId}] PASSED${scoreInfo} — ${task.title}`));
          this.registry.transition(taskId, "done");
        } else {
          const reasons = [
            ...assessment.checks.filter(c => !c.passed).map(c => `${c.type}: ${c.message}`),
            ...assessment.metrics.filter(m => !m.passed).map(m => `${m.name}: ${m.value} < ${m.threshold}`),
          ];
          this.log(chalk.red(`[${taskId}] FAILED — ${reasons.join(", ")}`));
          this.retryOrFail(taskId, task, result);
        }
      }).catch(err => {
        this.log(chalk.red(`[${taskId}] Assessment error: ${err.message}`));
        this.registry.updateTask(taskId, { result });
        this.retryOrFail(taskId, task, result);
      });
    } else {
      this.registry.updateTask(taskId, { result });
      if (result.exitCode === 0) {
        this.log(chalk.green(`[${taskId}] DONE — ${task.title}`));
        this.registry.transition(taskId, "done");
      } else {
        this.log(chalk.red(`[${taskId}] FAILED (exit ${result.exitCode}) — ${task.title}`));
        this.retryOrFail(taskId, task, result);
      }
    }
  }

  private retryOrFail(taskId: string, task: Task, result: TaskResult): void {
    const current = this.registry.getTask(taskId);
    if (!current) return;

    if (current.retries < current.maxRetries) {
      this.log(chalk.yellow(`[${taskId}] Retrying (${current.retries + 1}/${current.maxRetries})...`));
      this.registry.transition(taskId, "failed");
      this.registry.transition(taskId, "pending");
      this.registry.updateTask(taskId, {
        description: this.buildRetryPrompt(task, result),
      });
    } else {
      this.log(chalk.red(`[${taskId}] Max retries reached — giving up`));
      this.registry.transition(taskId, "failed");
    }
  }

  private spawnForTask(task: Task): void {
    const agent = this.config.team.agents.find(a => a.name === task.assignTo);
    if (!agent) {
      this.log(chalk.red(`No agent "${task.assignTo}" for task "${task.title}"`));
      this.registry.transition(task.id, "assigned");
      this.registry.transition(task.id, "in_progress");
      this.registry.transition(task.id, "failed");
      return;
    }

    this.log(chalk.blue(`[${task.id}] Spawning "${agent.name}" (adapter: ${agent.adapter}) for: ${task.title}`));

    this.registry.transition(task.id, "assigned");
    this.registry.transition(task.id, "in_progress");

    try {
      const adapter = getAdapter(agent.adapter);
      const handle = adapter.spawn(agent, task, this.workDir);

      this.log(chalk.dim(`[${task.id}] Agent started via ${adapter.name}`));
      this.handles.set(task.id, handle);

      // When the handle finishes, it will be picked up in the next tick
      handle.done.then(() => {}).catch(() => {});
    } catch (err: any) {
      this.log(chalk.red(`[${task.id}] Failed to spawn agent: ${err.message}`));
      this.registry.transition(task.id, "failed");
    }
  }

  private buildRetryPrompt(task: Task, result: TaskResult): string {
    const parts = [
      task.description,
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
      // Include dimension scores for targeted feedback
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

  private printReport(): void {
    const tasks = this.registry.getAllTasks();
    const done = tasks.filter(t => t.status === "done");
    const failed = tasks.filter(t => t.status === "failed");

    console.log(chalk.bold(`\n${"=".repeat(50)}`));
    console.log(chalk.bold(`Orchestra Report`));
    console.log(chalk.bold(`${"=".repeat(50)}`));
    console.log(`Total: ${tasks.length} | ${chalk.green(`Done: ${done.length}`)} | ${chalk.red(`Failed: ${failed.length}`)}`);

    for (const task of tasks) {
      const icon = task.status === "done" ? chalk.green("✓") : chalk.red("✗");
      const dur = task.result ? ` (${(task.result.duration / 1000).toFixed(1)}s)` : "";
      const score = task.result?.assessment?.globalScore !== undefined
        ? chalk.dim(` [${task.result.assessment.globalScore.toFixed(1)}/5]`)
        : "";
      console.log(`  ${icon} ${task.title}${dur}${score}`);
      if (task.result?.assessment?.scores) {
        for (const s of task.result.assessment.scores) {
          const color = s.score >= 4 ? chalk.green : s.score >= 3 ? chalk.yellow : chalk.red;
          console.log(chalk.dim(`     ${color(`${s.score}/5`)} ${s.dimension}`));
        }
      }
    }
    console.log(chalk.bold(`${"=".repeat(50)}\n`));
  }

  async status(): Promise<void> {
    await this.init();
    this.printReport();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
