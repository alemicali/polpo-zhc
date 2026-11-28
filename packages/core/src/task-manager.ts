import { isProductionRef, isSemver, parseAgentRef } from "./agent-versions.js";
import { normalizeTaskToolScope, type TaskToolScope } from "./task-tool-scope.js";
import type { TaskStore } from "./task-store.js";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { Mission, MissionStatus, Task, TaskExpectation, TaskPause, ExpectedOutcome, RetryPolicy, ReviewContext, ScopedNotificationRules, WorkOrigin } from "./types.js";
import { PAUSABLE_STATUSES } from "./state-machine.js";
import { setAssessment } from "./types.js";
import { sanitizeExpectations } from "./schemas.js";
import type { TaskDirection } from "./task-control-store.js";
// via sandbox.js (which re-exports computers.js): loading computers.js first breaks that re-export
import { requireTaskSandbox } from "./sandbox.js";
import type { SandboxSettings } from "./sandbox.js";

/**
 * Task CRUD: add, update, retry, reassess, kill, abort, clear.
 */
/** A finished mission that a human continuation (or retry) of one of its tasks put back to work. */
export interface ReopenedMission {
  id: string;
  name: string;
  prevStatus: MissionStatus;
}

/** What a resume did: the task is pending again; `continued`: its stopped run goes on (a continuation). */
export interface ResumedTask {
  task: Task;
  continued: boolean;
  direction?: TaskDirection;
}

/** Longest pause reason or resume message kept. */
const PAUSE_TEXT_MAX = 2_000;
/** How long a resume waits for the run its pause stopped to end. */
const RESUME_WAIT_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What the agent is told when its paused task is resumed (the continuation's message). */
export function resumeMessage(pause: TaskPause | undefined, o: { by?: string; message?: string } = {}): string {
  const paused = pause
    ? `Your task was paused${pause.by ? ` by ${pause.by}` : ""}${pause.reason ? ` (${pause.reason})` : ""} at ${pause.at}`
    : "Your task was paused";
  const lines = [
    `${paused} and has now been resumed${o.by ? ` by ${o.by}` : ""}.`,
    "Continue where you left off. The pause stopped you mid-step: check the current state first (a step you were doing may be half done) before going on.",
  ];
  if (o.message?.trim()) lines.push("", `Message${o.by ? ` from ${o.by}` : ""}: ${o.message.trim()}`);
  return lines.join("\n");
}

/** Mission states a human continuation or retry reopens: the mission runs again while its task does. */
const REOPENABLE_MISSION_STATES: ReadonlySet<MissionStatus> = new Set<MissionStatus>(["completed", "failed"]);

export class TaskManager {
  private idMap = new Map<string, string>();
  private missionReopenListeners: Array<(mission: Mission) => void> = [];

  constructor(private ctx: OrchestratorContext) {}

  /** Called when a task's finished mission is reopened (the mission executor forgets it was closed). */
  onMissionReopened(listener: (mission: Mission) => void): void {
    this.missionReopenListeners.push(listener);
  }

  private async missionOfTask(task: Task): Promise<Mission | undefined> {
    if (task.missionId) return this.ctx.registry.getMission?.(task.missionId);
    if (task.group) return this.ctx.registry.getMissionByName?.(task.group);
    return undefined;
  }

  /**
   * A task of a finished mission runs again (a human continued or retried it): the mission goes
   * back to active while it runs, and is closed again (completed or failed) when its tasks end.
   * Without this the orchestrator never starts a pending task of a completed mission, finds it
   * stuck and fails it as a deadlock (seen live: the continue direction stayed queued forever).
   *
   * Order matters, as the tick runs concurrently: the mission is active BEFORE the task is pending
   * (a pending task of a completed mission is a deadlock), and the executor forgets that it closed
   * the mission only AFTER (an active mission whose tasks all ended would be closed again at once).
   */
  private async reopeningMissionOf(
    task: Task,
    mission: Mission | undefined,
    makePending: () => Promise<void>,
  ): Promise<ReopenedMission | undefined> {
    const reopen = !!mission && REOPENABLE_MISSION_STATES.has(mission.status) && !!this.ctx.registry.updateMission;
    if (!reopen) {
      await makePending();
      return undefined;
    }
    const updated = await this.ctx.registry.updateMission!(mission.id, { status: "active" });
    try {
      await makePending();
    } catch (error) {
      await this.ctx.registry.updateMission!(mission.id, { status: mission.status }).catch(() => undefined);
      throw error;
    }
    for (const listener of this.missionReopenListeners) {
      try { listener(updated); } catch { /* a listener never blocks the reopen */ }
    }
    this.ctx.emitter.emit("log", {
      level: "info",
      message: `[${task.id}] Mission "${mission.name}" reopened (${mission.status} → active) for "${task.title}"`,
    });
    return { id: mission.id, name: mission.name, prevStatus: mission.status };
  }

  async addTask(opts: {
    title: string;
    description: string;
    assignTo: string;
    expectations?: TaskExpectation[];
    expectedOutcomes?: ExpectedOutcome[];
    dependsOn?: string[];
    group?: string;
    missionId?: string;
    maxDuration?: number;
    retryPolicy?: RetryPolicy;
    notifications?: ScopedNotificationRules;
    sideEffects?: boolean;
    draft?: boolean;
    /** Retries for this task (e.g. a mission task's maxRetries); default: settings.maxRetries. */
    maxRetries?: number;
    /** Narrowing of the run's tools; absent: everything the agent has. Validated by the caller. */
    toolScope?: TaskToolScope;
    /** The member (email) who started it, when known. */
    requestedBy?: string;
    /** A published version of the assignee to run (absent: production). `assignTo: "name@1.2.0"` sets it too. */
    agentVersion?: string;
    /** What started it, when not a person (a trigger's delivery). */
    origin?: WorkOrigin;
    /** The task level of the sandbox cascade, above all `computer` (validated against the agent). */
    sandbox?: SandboxSettings | null;
  }): Promise<Task> {
    if (!this.ctx.registry) throw new Error("Orchestrator not initialized");
    // "writer@1.2.0": the agent and the version it is pinned to
    {
      const parsed = parseAgentRef(opts.assignTo);
      const pinned = opts.agentVersion ?? parsed.ref;
      opts = { ...opts, assignTo: parsed.name };
      if (pinned && !isProductionRef(pinned)) {
        if (!isSemver(pinned)) throw new Error(`"${pinned}" is not a version of ${parsed.name}: use a published version like 1.2.0 (or no version for production)`);
        if (this.ctx.agentVersions && !(await this.ctx.agentVersions.getVersion(parsed.name, pinned).catch(() => undefined))) {
          throw new Error(`Agent "${parsed.name}" has no published version ${pinned}`);
        }
        opts.agentVersion = pinned;
      } else {
        delete opts.agentVersion;
      }
    }
    // a computer the agent may not use is refused here (TaskComputerError), not silently replaced
    let sandbox: SandboxSettings | undefined;
    if (opts.sandbox) {
      const agent = await this.ctx.agentStore.getAgent(opts.assignTo).catch(() => undefined);
      sandbox = requireTaskSandbox(agent ?? undefined, opts.sandbox, opts.assignTo);
    }

    // Run before:task:create hook (sync — addTask is synchronous)
    const hookResult = this.ctx.hooks.runBeforeSync("task:create", {
      title: opts.title,
      description: opts.description,
      assignTo: opts.assignTo,
      expectations: opts.expectations,
      expectedOutcomes: opts.expectedOutcomes,
      dependsOn: opts.dependsOn,
      group: opts.group,
      missionId: opts.missionId,
      maxDuration: opts.maxDuration,
      retryPolicy: opts.retryPolicy,
      notifications: opts.notifications,
      sideEffects: opts.sideEffects,
      draft: opts.draft,
    });
    if (hookResult.cancelled) {
      throw new Error(`Task creation blocked by hook: ${hookResult.cancelReason ?? "no reason"}`);
    }
    // Apply any modifications from hooks
    const hookData = hookResult.data;

    // Enforce unique title among active (non-terminal) tasks of the same group: missions refer to
    // their tasks by title, while two runs of one playbook (separate groups) reuse the same titles.
    const existingTasks = await this.ctx.registry.getAllTasks();
    const duplicate = existingTasks.find(
      t => t.title === hookData.title && (t.group ?? undefined) === (hookData.group ?? undefined)
        && t.status !== "done" && t.status !== "failed",
    );
    if (duplicate) {
      throw new Error(
        `A task with title "${hookData.title}" already exists (id: ${duplicate.id}, status: ${duplicate.status}). ` +
        `Task titles must be unique among active tasks.`,
      );
    }

    const rawExps = hookData.expectations ?? [];
    const { valid: expectations, warnings } = sanitizeExpectations(rawExps);
    for (const w of warnings) this.ctx.emitter.emit("log", { level: "warn", message: `[addTask "${hookData.title}"] ${w}` });
    const task = await this.ctx.registry.addTask({
      title: hookData.title,
      description: hookData.description,
      assignTo: hookData.assignTo,
      group: hookData.group,
      missionId: hookData.missionId ?? opts.missionId,
      dependsOn: hookData.dependsOn ?? [],
      expectations,
      expectedOutcomes: hookData.expectedOutcomes,
      metrics: [],
      maxRetries: opts.maxRetries ?? this.ctx.config.settings.maxRetries,
      maxDuration: hookData.maxDuration,
      retryPolicy: hookData.retryPolicy,
      notifications: hookData.notifications,
      sideEffects: hookData.sideEffects,
      ...(normalizeTaskToolScope(opts.toolScope) ? { toolScope: normalizeTaskToolScope(opts.toolScope) } : {}),
      ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
      ...(opts.agentVersion ? { agentVersion: opts.agentVersion } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(sandbox ? { sandbox } : {}),
      status: hookData.draft ? "draft" : undefined,
    });
    this.ctx.emitter.emit("task:created", { task });

    // Fire after:task:create hook (async, fire-and-forget)
    this.ctx.hooks.runAfter("task:create", {
      title: task.title,
      description: task.description,
      assignTo: task.assignTo,
      expectations: task.expectations,
      dependsOn: task.dependsOn,
      group: task.group,
    }).catch(() => { /* hook errors are logged internally */ });

    return task;
  }

  async updateTaskDescription(taskId: string, description: string): Promise<void> {
    await this.ctx.registry.updateTask(taskId, { description });
  }

  /** Reassign a task: "name" (production) or "name@1.2.0" (pinned to that published version). */
  async updateTaskAssignment(taskId: string, agentName: string): Promise<void> {
    const { name, ref } = parseAgentRef(agentName);
    const pinned = ref && !isProductionRef(ref) ? ref : undefined;
    if (pinned && !isSemver(pinned)) throw new Error(`"${pinned}" is not a version of ${name}: use a published version like 1.2.0`);
    if (pinned && this.ctx.agentVersions && !(await this.ctx.agentVersions.getVersion(name, pinned).catch(() => undefined))) {
      throw new Error(`Agent "${name}" has no published version ${pinned}`);
    }
    await this.ctx.registry.updateTask(taskId, { assignTo: name, agentVersion: pinned });
  }

  async updateTaskExpectations(taskId: string, expectations: TaskExpectation[]): Promise<void> {
    const task = await this.ctx.registry.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const editable = ["pending", "failed", "done"];
    if (!editable.includes(task.status)) {
      throw new Error(`Cannot edit expectations of task in "${task.status}" state`);
    }
    const { valid, warnings } = sanitizeExpectations(expectations);
    for (const w of warnings) this.ctx.emitter.emit("log", { level: "warn", message: `[updateExpectations "${taskId}"] ${w}` });
    const updated = await this.ctx.registry.updateTask(taskId, { expectations: valid });
    // The shell's registry announces every field change; a bare store does not
    if (!(this.ctx.registry as TaskStore & { __emitsTaskTransitionEvents?: boolean }).__emitsTaskTransitionEvents) {
      this.ctx.emitter.emit("task:updated", { taskId, task: updated, fields: ["expectations"] });
    }
  }

  async retryTask(taskId: string): Promise<void> {
    const task = await this.ctx.registry.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== "failed") throw new Error(`Cannot retry task in "${task.status}" state`);
    await this.reopeningMissionOf(task, await this.missionOfTask(task), async () => {
      await this.ctx.registry.transition(taskId, "pending");
    });
    this.ctx.emitter.emit("task:retried", { taskId, title: task.title });
  }

  async sendDirection(
    taskId: string,
    message: string,
    opts: {
      mode?: "auto" | "steer" | "follow_up" | "continue";
      confirmSideEffects?: boolean;
    } = {},
  ): Promise<{ action: TaskDirection["mode"]; direction: TaskDirection; reopenedMission?: ReopenedMission }> {
    const store = this.ctx.taskControlStore;
    if (!store) throw new Error("Task steering is not available for this runtime");

    const task = await this.ctx.registry.getTask(taskId);
    if (!task) throw new Error("Task not found");

    const normalized = message.trim();
    if (!normalized) throw new Error("Direction message cannot be empty");
    if (normalized.length > 8_000) throw new Error("Direction message exceeds 8000 characters");

    const requestedMode = opts.mode ?? "auto";
    const run = await this.ctx.runStore.getRunByTaskId(taskId);
    const activeRun = run?.status === "running" ? run : undefined;
    const liveMode = requestedMode === "steer" || requestedMode === "follow_up"
      ? requestedMode
      : requestedMode === "auto" && activeRun && (task.status === "in_progress" || task.status === "assigned")
        ? "steer"
        : undefined;

    if (liveMode) {
      if (!activeRun) {
        throw new Error(`Task has no active runner to steer (it is ${task.status}): send it with mode "continue" to run it again with this message`);
      }
      const direction = await store.enqueueDirection({
        taskId,
        runId: activeRun.id,
        mode: liveMode,
        message: normalized,
      });
      this.ctx.emitter.emit("task:direction", { taskId, action: liveMode, direction });
      return { action: liveMode, direction };
    }

    if (activeRun) {
      throw new Error("Task runner is still stopping; wait before continuing");
    }
    if (task.sideEffects && !opts.confirmSideEffects) {
      throw new Error("Continuing this task may repeat side effects; explicit confirmation is required");
    }
    if (task.status === "draft" || task.status === "awaiting_approval") {
      throw new Error(`Cannot continue task in "${task.status}" state`);
    }
    const mission = await this.missionOfTask(task);
    if (mission?.status === "cancelled") {
      throw new Error(`Cannot continue a task of mission "${mission.name}": the mission was cancelled (run the mission again)`);
    }

    const direction = await store.enqueueDirection({
      taskId,
      mode: "continue",
      message: normalized,
    });
    let reopenedMission: ReopenedMission | undefined;
    try {
      // A finished mission runs again with its continued task: otherwise the tick never starts a
      // pending task of a completed mission and fails it as a deadlock, the direction left queued.
      reopenedMission = await this.reopeningMissionOf(task, mission, async () => {
        if (task.status !== "pending" && task.status !== "assigned") {
          await this.ctx.registry.unsafeSetStatus(taskId, "pending", "manual continuation from human direction");
        }
        await this.ctx.registry.updateTask(taskId, { phase: "execution" });
      });
    } catch (error) {
      await store.failDirection(direction.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.ctx.emitter.emit("task:direction", { taskId, action: "continue", direction });
    return { action: "continue", direction, ...(reopenedMission ? { reopenedMission } : {}) };
  }

  /**
   * Pause a task (pending, assigned or in_progress): it is not scheduled until resumed. A running
   * task's run is stopped (SIGTERM, like kill) but ends as "paused", not failed: its session,
   * transcript and conversation checkpoint stay, and resuming continues it. Its mission stays
   * active and does not complete meanwhile; dependents wait.
   */
  async pauseTask(taskId: string, opts: { reason?: string; by?: string; takeover?: TaskPause["takeover"] } = {}): Promise<Task> {
    const task = await this.ctx.registry.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status === "paused") throw new Error("Task is already paused");
    if (!PAUSABLE_STATUSES.includes(task.status)) {
      throw new Error(`Cannot pause a task that is ${task.status}: only pending, assigned or in-progress tasks can be paused`);
    }
    // stores may hand out live objects: keep what it was before changing it
    const from = task.status;
    const title = task.title;
    const run = await this.ctx.runStore.getRunByTaskId(taskId);
    const active = run?.status === "running" ? run : undefined;
    const reason = opts.reason?.trim().slice(0, PAUSE_TEXT_MAX);
    const pause: TaskPause = {
      at: new Date().toISOString(),
      from,
      ...(opts.by ? { by: opts.by } : {}),
      ...(reason ? { reason } : {}),
      ...(active ? { runId: active.id } : {}),
      ...(opts.takeover ? { takeover: opts.takeover } : {}),
    };
    // the record first (task:transition carries it), then the status: the tick no longer starts,
    // assesses or retries it; then the run is stopped
    await this.ctx.registry.updateTask(taskId, { pause });
    let paused: Task;
    try {
      paused = await this.ctx.registry.transition(taskId, "paused");
    } catch {
      paused = await this.ctx.registry.unsafeSetStatus(taskId, "paused", "pause transition race fallback");
    }
    if (active && active.pid > 0 && this.ctx.killProcess) {
      try { this.ctx.killProcess(active.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    this.ctx.emitter.emit("task:paused", {
      taskId, title, from,
      ...(reason ? { reason } : {}), ...(opts.by ? { pausedBy: opts.by } : {}),
      ...(active ? { runId: active.id } : {}), ...(opts.takeover ? { takeover: opts.takeover } : {}),
    });
    return { ...paused, pause };
  }

  /**
   * Resume a paused task: back to pending; when its pause stopped a run, the next run continues it
   * (a "continue" direction: same session and transcript) and is told it was paused, by whom and
   * why, with the optional message.
   */
  async resumeTask(taskId: string, opts: { by?: string; message?: string } = {}): Promise<ResumedTask> {
    const task = await this.ctx.registry.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== "paused") throw new Error(`Task is ${task.status}, not paused`);
    const before = task.pause ? { ...task.pause } : undefined;
    const message = opts.message?.trim().slice(0, PAUSE_TEXT_MAX);

    // the run the pause stopped must have ended: its continuation could otherwise go to it
    const deadline = Date.now() + RESUME_WAIT_MS;
    for (;;) {
      const run = await this.ctx.runStore.getRunByTaskId(taskId);
      if (run?.status !== "running") break;
      if (Date.now() >= deadline) throw new Error("The paused run is still stopping: resume it again in a moment");
      await sleep(250);
    }

    const store = this.ctx.taskControlStore;
    const continued = !!before?.runId && !!store;
    let direction: TaskDirection | undefined;
    if (continued) {
      direction = await store!.enqueueDirection({ taskId, mode: "continue", message: resumeMessage(before, { ...(opts.by ? { by: opts.by } : {}), ...(message ? { message } : {}) }) });
    }
    const pause: TaskPause | undefined = before
      ? { ...before, resumedAt: new Date().toISOString(), ...(opts.by ? { resumedBy: opts.by } : {}) }
      : undefined;
    try {
      await this.ctx.registry.updateTask(taskId, { ...(pause ? { pause } : {}), ...(continued ? { phase: "execution" as const } : {}) });
      try {
        await this.ctx.registry.transition(taskId, "pending");
      } catch {
        await this.ctx.registry.unsafeSetStatus(taskId, "pending", "resume transition race fallback");
      }
    } catch (error) {
      if (direction) await store!.failDirection(direction.id, error instanceof Error ? error.message : String(error)).catch(() => undefined);
      throw error;
    }
    const resumed = (await this.ctx.registry.getTask(taskId)) ?? { ...task, status: "pending" as const, ...(pause ? { pause } : {}) };
    this.ctx.emitter.emit("task:resumed", {
      taskId, title: task.title, continued,
      ...(opts.by ? { resumedBy: opts.by } : {}), ...(message ? { message } : {}),
      ...(before?.reason ? { reason: before.reason } : {}),
      ...(before ? { pausedMs: Math.max(0, Date.now() - Date.parse(before.at)) } : {}),
      ...(before?.takeover ? { takeover: before.takeover } : {}),
    });
    if (direction) this.ctx.emitter.emit("task:direction", { taskId, action: "continue", direction });
    return { task: resumed, continued, ...(direction ? { direction } : {}) };
  }

  async listDirections(taskId: string): Promise<TaskDirection[]> {
    const store = this.ctx.taskControlStore;
    if (!store) throw new Error("Task steering is not available for this runtime");
    if (!await this.ctx.registry.getTask(taskId)) throw new Error("Task not found");
    return store.listDirections(taskId);
  }

  async reassessTask(taskId: string): Promise<void> {
    const task = await this.ctx.registry.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== "done" && task.status !== "failed") {
      throw new Error(`Cannot reassess task in "${task.status}" state`);
    }
    if (task.expectations.length === 0 && task.metrics.length === 0) {
      throw new Error("Task has no expectations or metrics to assess");
    }

    this.ctx.emitter.emit("assessment:started", { taskId });
    const result = task.result ?? { exitCode: 0, stdout: "", stderr: "", duration: 0 };
    const onProgress = (msg: string) => this.ctx.emitter.emit("assessment:progress", { taskId, message: msg });

    // Build rich ReviewContext from RunStore, JSONL transcript, and outcomes
    const run = await this.ctx.runStore.getRunByTaskId(taskId);
    const activity = run?.activity;
    const outcomes = run?.outcomes ?? task.outcomes;

    let executionSummary: string | undefined;
    let toolsSummary: string | undefined;
    try {
      if (this.ctx.findLogForTask && this.ctx.buildExecutionSummary) {
        const logPath = this.ctx.findLogForTask(this.ctx.polpoDir, taskId, run?.id);
        if (logPath) {
          const summaryResult = this.ctx.buildExecutionSummary(logPath);
          executionSummary = summaryResult.summary;
          toolsSummary = summaryResult.toolsSummary;
        }
      }
    } catch { /* best effort */ }

    const reviewContext: ReviewContext = {
      taskTitle: task.title,
      taskDescription: task.originalDescription ?? task.description,
      agentOutput: result.stdout || undefined,
      agentStderr: result.stderr || undefined,
      exitCode: result.exitCode,
      duration: result.duration,
      filesCreated: activity?.filesCreated,
      filesEdited: activity?.filesEdited,
      toolCalls: activity?.toolCalls,
      toolsSummary: toolsSummary || undefined,
      executionSummary,
      outcomes: outcomes?.length ? outcomes : undefined,
    };

    try {
      const assessment = await this.ctx.assessFn(task, this.ctx.agentWorkDir, onProgress, reviewContext, this.ctx.config.settings.reasoning);
      setAssessment(result, assessment, "reassess");
      await this.ctx.registry.updateTask(taskId, { result });

      if (assessment.passed) {
        this.ctx.emitter.emit("assessment:complete", {
          taskId,
          passed: true,
          scores: assessment.scores,
          globalScore: assessment.globalScore,
          message: `Reassessment PASSED`,
        });
        if (task.status === "failed") {
          await this.ctx.registry.transition(taskId, "pending");
          await this.ctx.registry.transition(taskId, "assigned");
          await this.ctx.registry.transition(taskId, "in_progress");
          await this.ctx.registry.transition(taskId, "review");
          await this.ctx.registry.transition(taskId, "done");
        }
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
          message: `Reassessment FAILED — ${reasons.join(", ")}`,
        });
        if (task.status === "done") {
          await this.ctx.registry.unsafeSetStatus(taskId, "failed", "reassessment invalidated done task");
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.emitter.emit("log", { level: "error", message: `[${taskId}] Reassessment error: ${message}` });
    }
  }

  async killTask(taskId: string): Promise<boolean> {
    const run = await this.ctx.runStore.getRunByTaskId(taskId);
    const running = !!run && run.status === "running" && run.pid > 0;
    if (running) {
      if (this.ctx.killProcess) {
        try { this.ctx.killProcess(run.pid, "SIGTERM"); } catch { /* already dead */ }
      }
    }
    const task = await this.ctx.registry.getTask(taskId);
    if (!task) return false;
    const active = task.status !== "done" && task.status !== "failed";
    if (running || active) {
      this.ctx.emitter.emit("task:killed", { taskId, title: task.title, ...(running ? { runId: run.id, pid: run.pid } : {}) });
    }
    if (active) {
      try {
        if (task.status === "pending") await this.ctx.registry.transition(taskId, "assigned");
        if (task.status === "assigned") await this.ctx.registry.transition(taskId, "in_progress");
        await this.ctx.registry.transition(taskId, "failed");
      } catch { /* transition race — force status */
        await this.ctx.registry.unsafeSetStatus(taskId, "failed", "killTask transition race fallback");
      }
    }
    return true;
  }

  /**
   * Kill a mission group's unfinished tasks and cancel its mission. With `missionId`, only that
   * mission's tasks: missions created before names were unique can share a group.
   */
  async abortGroup(group: string, missionId?: string): Promise<number> {
    const tasks = await this.ctx.registry.getAllTasks();
    const groupTasks = tasks.filter(t => t.group === group && (!missionId || !t.missionId || t.missionId === missionId));
    let count = 0;
    for (const task of groupTasks) {
      if (task.status === "done" || task.status === "failed") continue;
      await this.killTask(task.id);
      count++;
    }
    // Resolve mission via task.missionId (direct FK) first, fallback to group name
    const mid = missionId ?? groupTasks.find(t => t.missionId)?.missionId;
    const mission = mid
      ? await this.ctx.registry.getMission?.(mid)
      : await this.ctx.registry.getMissionByName?.(group);
    // A mission paused at a checkpoint can be aborted too.
    if (mission && (mission.status === "active" || mission.status === "paused")) {
      await this.ctx.registry.updateMission?.(mission.id, { status: "cancelled" });
    }
    this.ctx.emitter.emit("mission:aborted", { missionId: mission?.id, name: mission?.name, group, killedTasks: count });
    return count;
  }

  async clearTasks(filter: (task: Task) => boolean): Promise<number> {
    const tasks = (await this.ctx.registry.getAllTasks()).filter(filter);
    for (const task of tasks) {
      const run = await this.ctx.runStore.getRunByTaskId(task.id);
      if (run && run.status === "running" && run.pid > 0) {
        if (this.ctx.killProcess) {
          try { this.ctx.killProcess(run.pid, "SIGTERM"); } catch { /* already dead */ }
        }
      }
    }
    return await this.ctx.registry.removeTasks(filter);
  }

  /** Load initial tasks from config (non-interactive mode). */
  async seedTasks(): Promise<void> {
    if (!this.ctx.config.tasks.length) return;

    for (const ct of this.ctx.config.tasks) {
      const rawExps = ct.expectations ?? [];
      const { valid: expectations, warnings } = sanitizeExpectations(rawExps);
      for (const w of warnings) this.ctx.emitter.emit("log", { level: "warn", message: `[seed "${ct.title}"] ${w}` });

      const task = await this.ctx.registry.addTask({
        title: ct.title,
        description: ct.description,
        assignTo: ct.assignTo,
        dependsOn: [],
        expectations,
        metrics: [],
        maxRetries: this.ctx.config.settings.maxRetries,
        maxDuration: ct.maxDuration,
        retryPolicy: ct.retryPolicy,
      });

      this.idMap.set(ct.title, task.id);
      this.idMap.set(task.id, task.id);
      this.ctx.emitter.emit("task:created", { task });
    }

    // Resolve dependencies by title → id
    for (const ct of this.ctx.config.tasks) {
      if (!ct.dependsOn?.length) continue;
      const taskId = this.idMap.get(ct.title);
      if (!taskId) continue;
      const resolved = ct.dependsOn
        .map(dep => this.idMap.get(dep))
        .filter((id): id is string => !!id);
      if (resolved.length > 0) {
        await this.ctx.registry.updateTask(taskId, { dependsOn: resolved });
      }
    }
  }

  /** Force a task through the state machine to failed (used by deadlock resolver). */
  async forceFailTask(taskId: string, reason?: string): Promise<void> {
    const task = await this.ctx.registry.getTask(taskId);
    if (!task || task.status === "done" || task.status === "failed") return;
    this.ctx.emitter.emit("task:force-failed", { taskId, title: task.title, ...(reason ? { reason } : {}) });
    try {
      if (task.status === "pending") await this.ctx.registry.transition(taskId, "assigned");
      if (task.status === "assigned") await this.ctx.registry.transition(taskId, "in_progress");
      await this.ctx.registry.transition(taskId, "failed");
    } catch { /* transition race — force status */
      await this.ctx.registry.unsafeSetStatus(taskId, "failed", "forceFailTask transition race fallback");
    }
  }
}
