import type { OrchestratorContext } from "./orchestrator-context.js";
import type { TaskManager } from "./task-manager.js";
import type { AgentManager } from "./agent-manager.js";
import type { Mission, MissionStatus, MissionReport, Task, TaskExpectation, ExpectedOutcome, MissionQualityGate, MissionCheckpoint, MissionDelay, ScopedNotificationRules } from "./types.js";
import type { QualityController } from "../quality/quality-controller.js";
import { sanitizeExpectations, parseMissionDocument, type MissionDocumentParsed } from "./schemas.js";
import { validateProviderKeys } from "../llm/pi-client.js";
import type { CheckpointStore, CheckpointState } from "@polpo-ai/core/checkpoint-store";
import type { DelayStore, DelayState } from "@polpo-ai/core/delay-store";
import { FileCheckpointStore } from "../stores/file-checkpoint-store.js";
import { FileDelayStore } from "../stores/file-delay-store.js";

/**
 * Mission CRUD + execution + resume + group lifecycle.
 */
export class MissionExecutor {
  private cleanedGroups = new Set<string>();
  /** Quality gates parsed from mission documents, keyed by mission group name */
  private gatesByGroup = new Map<string, MissionQualityGate[]>();
  /** Persistent checkpoint store — survives server restarts */
  private cpStore: CheckpointStore;
  /** In-memory mirror of persisted checkpoint state (synced on every mutation) */
  private cpState!: CheckpointState;
  /** Optional quality controller — set by orchestrator after init */
  private qualityCtrl?: QualityController;
  /** Optional notification router — for checkpoint notification rules */
  private notificationRouter?: import("../notifications/index.js").NotificationRouter;
  /** Track which checkpoint notification rules have been registered (by cpKey) */
  private registeredCheckpointRules = new Set<string>();
  /** Persistent delay store — survives server restarts */
  private delayStore: DelayStore;
  /** In-memory mirror of persisted delay state (synced on every mutation) */
  private delayState!: DelayState;
  /** Track which delay notification rules have been registered (by delayKey) */
  private registeredDelayRules = new Set<string>();
  /** Track the pre-execution status for scheduled/recurring missions (by group name).
   *  When a mission completes/fails, this determines whether to return to scheduled/recurring. */
  private scheduledOrigin = new Map<string, "scheduled" | "recurring">();

  constructor(
    private ctx: OrchestratorContext,
    private taskMgr: TaskManager,
    private agentMgr: AgentManager,
  ) {
    this.cpStore = ctx.checkpointStore ?? new FileCheckpointStore(ctx.polpoDir);
    this.delayStore = ctx.delayStore ?? new FileDelayStore(ctx.polpoDir);

    // Rebuild cleanedGroups from persisted task state — groups where ALL tasks
    // are already terminal don't need to be re-processed after a server restart.
    // Constructor cannot be async — expose ready promise for callers to await.
    this.ready = this.initStoresAndRebuild();
  }

  /** Resolves when async store loading and group rebuild are complete. */
  readonly ready: Promise<void>;

  /** Async init: load checkpoint/delay state and rebuild cleanedGroups. */
  private async initStoresAndRebuild(): Promise<void> {
    this.cpState = await this.cpStore.load();
    this.delayState = await this.delayStore.load();
    await this.rebuildCleanedGroups();
  }

  /** Async init: rebuild cleanedGroups from persisted task state. */
  private async rebuildCleanedGroups(): Promise<void> {
    const allTasks = await this.ctx.registry.getAllTasks();
    const groups = new Set<string>();
    for (const t of allTasks) {
      if (t.group) groups.add(t.group);
    }
    for (const group of groups) {
      const groupTasks = allTasks.filter(t => t.group === group);
      if (groupTasks.every(t => t.status === "done" || t.status === "failed")) {
        this.cleanedGroups.add(group);
      }
    }
  }

  /** Set the quality controller instance (called by Orchestrator after init). */
  setQualityController(ctrl: QualityController): void {
    this.qualityCtrl = ctrl;
  }

  /** Set the notification router — enables per-checkpoint channel routing. */
  setNotificationRouter(router: import("../notifications/index.js").NotificationRouter): void {
    this.notificationRouter = router;
  }

  /** Get quality gates for a mission group. Returns empty array if none defined. */
  getQualityGates(group: string): MissionQualityGate[] {
    return this.gatesByGroup.get(group) ?? [];
  }

  /** Get checkpoints for a mission group. Returns empty array if none defined. */
  getCheckpoints(group: string): MissionCheckpoint[] {
    return this.cpState.definitions[group] ?? [];
  }

  /**
   * Check if a task is blocked by an active (unresumed) checkpoint.
   * Returns the blocking checkpoint if found, undefined if the task can proceed.
   */
  async getBlockingCheckpoint(
    group: string,
    taskTitle: string,
    taskId: string,
    tasks: Task[],
  ): Promise<{ checkpoint: MissionCheckpoint; reachedAt: string } | undefined> {
    const checkpoints = this.cpState.definitions[group];
    if (!checkpoints) return undefined;

    for (const cp of checkpoints) {
      // Task must be in blocksTasks
      if (!cp.blocksTasks.includes(taskTitle) && !cp.blocksTasks.includes(taskId)) {
        continue;
      }

      const cpKey = `${group}:${cp.name}`;

      // Already resumed — don't block
      if (this.cpState.resumed.includes(cpKey)) continue;

      // Check if all afterTasks are done
      const afterTasks = tasks.filter(
        t => cp.afterTasks.includes(t.title) || cp.afterTasks.includes(t.id),
      );
      const allDone = afterTasks.length >= cp.afterTasks.length &&
        afterTasks.every(t => t.status === "done" || t.status === "failed");

      if (!allDone) {
        // afterTasks not finished yet — checkpoint not reached, don't block (deps will block naturally)
        continue;
      }

      // Checkpoint reached — activate it if not already active
      if (!this.cpState.active[cpKey]) {
        const reachedAt = new Date().toISOString();
        this.cpState.active[cpKey] = { checkpoint: cp, reachedAt };
        await this.cpStore.save(this.cpState);

        // Pause the mission — use task.missionId when available
        const taskMissionId = tasks.find(t => t.group === group && t.missionId)?.missionId;
        const mission = taskMissionId
          ? await this.ctx.registry.getMission?.(taskMissionId)
          : await this.ctx.registry.getMissionByName?.(group);
        if (mission && mission.status === "active") {
          await this.ctx.registry.updateMission?.(mission.id, { status: "paused" });
        }

        // Register notification rules for this checkpoint's channels
        this.ensureCheckpointNotificationRules(cpKey, cp);

        // Emit event (picked up by notification router if rules are configured)
        this.ctx.emitter.emit("checkpoint:reached", {
          missionId: mission?.id,
          group,
          checkpointName: cp.name,
          message: cp.message,
          afterTasks: cp.afterTasks,
          blocksTasks: cp.blocksTasks,
          reachedAt,
        });
      }

      // Return the blocking checkpoint
      return this.cpState.active[cpKey];
    }

    return undefined;
  }

  /**
   * Resume a checkpoint, unblocking its blocksTasks.
   * Returns true if the checkpoint was active and is now resumed, false if not found.
   */
  async resumeCheckpoint(group: string, checkpointName: string): Promise<boolean> {
    const cpKey = `${group}:${checkpointName}`;
    const active = this.cpState.active[cpKey];
    if (!active) return false;

    this.cpState.resumed.push(cpKey);
    delete this.cpState.active[cpKey];
    await this.cpStore.save(this.cpState);

    // Un-pause the mission (back to active) — resolve via missionId from tasks
    const groupTasks = (await this.ctx.registry.getAllTasks()).filter(t => t.group === group);
    const mission = await this.resolveMissionForGroup(groupTasks, group);
    if (mission && mission.status === "paused") {
      await this.ctx.registry.updateMission?.(mission.id, { status: "active" });
    }

    this.ctx.emitter.emit("checkpoint:resumed", {
      missionId: mission?.id,
      group,
      checkpointName,
    });

    return true;
  }

  /** Get all active (unresumed) checkpoints across all mission groups. */
  getActiveCheckpoints(): Array<{ group: string; checkpointName: string; checkpoint: MissionCheckpoint; reachedAt: string }> {
    const result: Array<{ group: string; checkpointName: string; checkpoint: MissionCheckpoint; reachedAt: string }> = [];
    for (const [cpKey, data] of Object.entries(this.cpState.active)) {
      const [group, ...nameParts] = cpKey.split(":");
      const checkpointName = nameParts.join(":");
      result.push({ group, checkpointName, checkpoint: data.checkpoint, reachedAt: data.reachedAt });
    }
    return result;
  }

  /** Register dynamic notification rules for a checkpoint's notifyChannels (once per checkpoint). */
  private ensureCheckpointNotificationRules(cpKey: string, cp: MissionCheckpoint): void {
    if (!this.notificationRouter) return;
    if (!cp.notifyChannels || cp.notifyChannels.length === 0) return;
    if (this.registeredCheckpointRules.has(cpKey)) return;

    this.registeredCheckpointRules.add(cpKey);

    // Rule for checkpoint reached
    this.notificationRouter.addRule({
      id: `checkpoint-reached-${cpKey}`,
      name: `Checkpoint "${cp.name}" Reached (auto-registered)`,
      events: ["checkpoint:reached"],
      condition: { field: "checkpointName", op: "==", value: cp.name },
      channels: cp.notifyChannels,
      severity: "warning",
    });

    // Rule for checkpoint resumed
    this.notificationRouter.addRule({
      id: `checkpoint-resumed-${cpKey}`,
      name: `Checkpoint "${cp.name}" Resumed (auto-registered)`,
      events: ["checkpoint:resumed"],
      condition: { field: "checkpointName", op: "==", value: cp.name },
      channels: cp.notifyChannels,
      severity: "info",
    });
  }

  // ─── Delay runtime ──────────────────────────────────

  /** Get delays for a mission group. Returns empty array if none defined. */
  getDelays(group: string): MissionDelay[] {
    return this.delayState.definitions[group] ?? [];
  }

  /**
   * Check if a task is blocked by an active (unexpired) delay.
   * If afterTasks are all done and the delay hasn't started yet, starts the timer.
   * If the timer has expired, marks the delay as expired and unblocks.
   * Returns the blocking delay if found, undefined if the task can proceed.
   */
  async getBlockingDelay(
    group: string,
    taskTitle: string,
    taskId: string,
    tasks: Task[],
  ): Promise<{ delay: MissionDelay; startedAt: string; expiresAt: string } | undefined> {
    const delays = this.delayState.definitions[group];
    if (!delays) return undefined;

    for (const dl of delays) {
      // Task must be in blocksTasks
      if (!dl.blocksTasks.includes(taskTitle) && !dl.blocksTasks.includes(taskId)) {
        continue;
      }

      const dlKey = `${group}:${dl.name}`;

      // Already expired — don't block
      if (this.delayState.expired.includes(dlKey)) continue;

      // Check if all afterTasks are done
      const afterTasks = tasks.filter(
        t => dl.afterTasks.includes(t.title) || dl.afterTasks.includes(t.id),
      );
      const allDone = afterTasks.length >= dl.afterTasks.length &&
        afterTasks.every(t => t.status === "done" || t.status === "failed");

      if (!allDone) {
        // afterTasks not finished yet — delay not triggered, don't block (deps will block naturally)
        continue;
      }

      // Delay triggered — activate timer if not already active
      if (!this.delayState.active[dlKey]) {
        const startedAt = new Date().toISOString();
        const durationMs = parseISO8601Duration(dl.duration);
        const expiresAt = new Date(Date.now() + durationMs).toISOString();
        this.delayState.active[dlKey] = { delay: dl, startedAt, expiresAt };
        await this.delayStore.save(this.delayState);

        // Register notification rules for this delay's channels
        this.ensureDelayNotificationRules(dlKey, dl);

        // Emit event
        const mission = await this.resolveMissionForGroupByName(group);
        this.ctx.emitter.emit("delay:started", {
          missionId: mission?.id,
          group,
          delayName: dl.name,
          duration: dl.duration,
          message: dl.message,
          afterTasks: dl.afterTasks,
          blocksTasks: dl.blocksTasks,
          startedAt,
          expiresAt,
        });
      }

      // Check if the timer has expired
      const active = this.delayState.active[dlKey];
      if (new Date(active.expiresAt).getTime() <= Date.now()) {
        // Timer expired — mark as expired and unblock
        this.delayState.expired.push(dlKey);
        delete this.delayState.active[dlKey];
        await this.delayStore.save(this.delayState);

        const mission = await this.resolveMissionForGroupByName(group);
        this.ctx.emitter.emit("delay:expired", {
          missionId: mission?.id,
          group,
          delayName: dl.name,
        });

        continue; // Unblocked — check next delay
      }

      // Still waiting — return the blocking delay
      return active;
    }

    return undefined;
  }

  /** Get all active (unexpired) delays across all mission groups. */
  getActiveDelays(): Array<{ group: string; delayName: string; delay: MissionDelay; startedAt: string; expiresAt: string }> {
    const result: Array<{ group: string; delayName: string; delay: MissionDelay; startedAt: string; expiresAt: string }> = [];
    for (const [dlKey, data] of Object.entries(this.delayState.active)) {
      const [group, ...nameParts] = dlKey.split(":");
      const delayName = nameParts.join(":");
      result.push({ group, delayName, delay: data.delay, startedAt: data.startedAt, expiresAt: data.expiresAt });
    }
    return result;
  }

  /** Register dynamic notification rules for a delay's notifyChannels (once per delay). */
  private ensureDelayNotificationRules(dlKey: string, dl: MissionDelay): void {
    if (!this.notificationRouter) return;
    if (!dl.notifyChannels || dl.notifyChannels.length === 0) return;
    if (this.registeredDelayRules.has(dlKey)) return;

    this.registeredDelayRules.add(dlKey);

    // Rule for delay started
    this.notificationRouter.addRule({
      id: `delay-started-${dlKey}`,
      name: `Delay "${dl.name}" Started (auto-registered)`,
      events: ["delay:started"],
      condition: { field: "delayName", op: "==", value: dl.name },
      channels: dl.notifyChannels,
      severity: "info",
    });

    // Rule for delay expired
    this.notificationRouter.addRule({
      id: `delay-expired-${dlKey}`,
      name: `Delay "${dl.name}" Expired (auto-registered)`,
      events: ["delay:expired"],
      condition: { field: "delayName", op: "==", value: dl.name },
      channels: dl.notifyChannels,
      severity: "info",
    });
  }

  /** Resolve a mission by group name (helper for delay/checkpoint events). */
  private async resolveMissionForGroupByName(group: string): Promise<Mission | undefined> {
    const groupTasks = (await this.ctx.registry.getAllTasks()).filter(t => t.group === group);
    return this.resolveMissionForGroup(groupTasks, group);
  }

  async saveMission(opts: { data: string; prompt?: string; name?: string; status?: MissionStatus; notifications?: ScopedNotificationRules }): Promise<Mission> {
    if (!this.ctx.registry.saveMission) throw new Error("Store does not support missions");
    const name = opts.name ?? (await this.ctx.registry.nextMissionName?.()) ?? `mission-${Date.now()}`;
    const mission = await this.ctx.registry.saveMission({
      name,
      data: opts.data,
      prompt: opts.prompt,
      status: opts.status ?? "draft",
      notifications: opts.notifications,
    });
    this.ctx.emitter.emit("mission:saved", { missionId: mission.id, name: mission.name, status: mission.status });
    return mission;
  }

  async getMission(missionId: string): Promise<Mission | undefined> {
    return this.ctx.registry.getMission?.(missionId);
  }

  async getMissionByName(name: string): Promise<Mission | undefined> {
    return this.ctx.registry.getMissionByName?.(name);
  }

  async getAllMissions(): Promise<Mission[]> {
    return (await this.ctx.registry.getAllMissions?.()) ?? [];
  }

  async updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission> {
    if (!this.ctx.registry.updateMission) throw new Error("Store does not support missions");
    return this.ctx.registry.updateMission(missionId, updates);
  }

  async deleteMission(missionId: string): Promise<boolean> {
    if (!this.ctx.registry.deleteMission) throw new Error("Store does not support missions");
    const mission = await this.getMission(missionId);
    if (!mission) return false;

    // ── Cascade cleanup ──────────────────────────────────

    // 1. Kill running processes and remove all tasks belonging to this mission
    const missionGroup = mission.name;
    const deletedTasks = await this.taskMgr.clearTasks(
      t => t.missionId === missionId || t.group === missionGroup,
    );

    // 2. Clean up volatile agents registered for this mission group
    await this.agentMgr.cleanupVolatileAgents(missionGroup);

    // 3. Clean up in-memory quality gates
    this.gatesByGroup.delete(missionGroup);
    // Also clean numbered groups for recurring missions (e.g. "mission-1 #2", "mission-1 #3")
    for (const key of this.gatesByGroup.keys()) {
      if (key.startsWith(missionGroup + " #")) this.gatesByGroup.delete(key);
    }

    // 4. Clean up persisted checkpoints
    this.cpState = await this.cpStore.removeGroup(this.cpState, missionGroup);
    for (const key of Object.keys(this.cpState.definitions)) {
      if (key.startsWith(missionGroup + " #")) {
        this.cpState = await this.cpStore.removeGroup(this.cpState, key);
      }
    }

    // 4b. Clean up persisted delays
    this.delayState = await this.delayStore.removeGroup(this.delayState, missionGroup);
    for (const key of Object.keys(this.delayState.definitions)) {
      if (key.startsWith(missionGroup + " #")) {
        this.delayState = await this.delayStore.removeGroup(this.delayState, key);
      }
    }

    // 5. Clean up scheduled origin cache
    this.scheduledOrigin.delete(missionGroup);
    for (const key of this.scheduledOrigin.keys()) {
      if (key.startsWith(missionGroup + " #")) this.scheduledOrigin.delete(key);
    }

    // 6. Allow re-cleanup if the group is ever recreated
    this.cleanedGroups.delete(missionGroup);
    for (const key of this.cleanedGroups) {
      if (key.startsWith(missionGroup + " #")) this.cleanedGroups.delete(key);
    }

    // ── Delete the mission record ────────────────────────
    const result = await this.ctx.registry.deleteMission(missionId);
    if (result) {
      this.ctx.emitter.emit("mission:deleted", { missionId, deletedTasks });
    }
    return result;
  }

  async getResumableMissions(): Promise<Mission[]> {
    const missions = await this.getAllMissions();
    const state = await this.ctx.registry.getState();
    return missions.filter(m => {
      // Non-resumable statuses: draft (never executed), scheduled/recurring (scheduler handles),
      // completed (done), cancelled (aborted)
      if (m.status === "draft" || m.status === "scheduled" || m.status === "recurring" ||
          m.status === "completed" || m.status === "cancelled") return false;
      const tasks = state.tasks.filter(t => t.group === m.name);
      if (tasks.length === 0) return false;
      return tasks.some(t => t.status === "pending" || t.status === "failed");
    });
  }

  async resumeMission(missionId: string, opts?: { retryFailed?: boolean }): Promise<{ retried: number; pending: number }> {
    const mission = await this.getMission(missionId);
    if (!mission) throw new Error("Mission not found");

    // Re-register volatile agents if they were cleaned up
    this.cleanedGroups.delete(mission.name);
    const enableVolatile = this.ctx.config.settings.enableVolatileTeams !== false;
    if (enableVolatile && mission.data) {
      try {
        const doc = JSON.parse(mission.data) as MissionDocumentParsed;
        if (doc?.team && Array.isArray(doc.team)) {
          for (const a of doc.team) {
            if (!a.name) continue;
            const { name, ...rest } = a;
            await this.agentMgr.addVolatileAgent({ name, ...rest }, mission.name);
          }
        }
      } catch (err) {
        this.ctx.emitter.emit("log", { level: "warn", message: `Failed to re-register volatile agents for ${mission.name}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    const state = await this.ctx.registry.getState();
    const tasks = state.tasks.filter(t => t.group === mission.name);
    const failedTasks = tasks.filter(t => t.status === "failed");
    const pendingTasks = tasks.filter(t => t.status === "pending");

    let retried = 0;
    if (opts?.retryFailed) {
      for (const task of failedTasks) {
        try {
          await this.taskMgr.retryTask(task.id);
          retried++;
        } catch { /* no retries left — skip */
        }
      }
    }

    if (mission.status === "failed") {
      await this.updateMission(missionId, { status: "active" });
    }

    this.ctx.emitter.emit("mission:resumed", { missionId, name: mission.name, retried, pending: pendingTasks.length });
    return { retried, pending: pendingTasks.length };
  }

  async executeMission(missionId: string): Promise<{ tasks: Task[]; group: string }> {
    const mission = await this.ctx.registry.getMission?.(missionId);
    if (!mission) throw new Error("Mission not found");
    const executableStates = ["draft", "scheduled", "recurring"];
    if (!executableStates.includes(mission.status)) {
      throw new Error(`Cannot execute mission in "${mission.status}" state (must be "draft", "scheduled", or "recurring")`);
    }
    // Remember whether this is a scheduled/recurring mission so we can restore status after completion
    const scheduledStatus = mission.status === "scheduled" || mission.status === "recurring" ? mission.status : undefined;

    // Increment execution count (tracks how many times this mission has run — useful for recurring)
    const runNumber = (mission.executionCount ?? 0) + 1;
    await this.ctx.registry.updateMission?.(missionId, { executionCount: runNumber });

    // Validate mission document through Zod schema — throws with clear error on invalid shape
    const raw = JSON.parse(mission.data);
    const doc = parseMissionDocument(raw);

    // For recurring/scheduled missions with multiple runs, disambiguate the group with a run number
    const group = runNumber > 1 ? `${mission.name} #${runNumber}` : mission.name;

    // Run before:mission:execute hook
    const hookResult = this.ctx.hooks.runBeforeSync("mission:execute", {
      missionId,
      mission,
      taskCount: doc.tasks.length,
    });
    if (hookResult.cancelled) {
      throw new Error(`Mission execution blocked by hook: ${hookResult.cancelReason ?? "no reason"}`);
    }

    // Register volatile agents from the mission's team section
    const enableVolatile = this.ctx.config.settings.enableVolatileTeams !== false;
    if (enableVolatile && doc.team && Array.isArray(doc.team)) {
      for (const a of doc.team) {
        if (!a.name) continue;
        const { name, ...rest } = a;
        await this.agentMgr.addVolatileAgent({ name, ...rest }, group);
      }
    }

    // Validate API keys for all agents referenced in the mission
    const allAgents = await this.agentMgr.getAgents();
    const referencedModels: string[] = [];
    for (const t of doc.tasks) {
      const agentName = t.assignTo || allAgents[0]?.name;
      const agent = allAgents.find(a => a.name === agentName);
      if (agent?.model) {
        referencedModels.push(agent.model);
      } else if (!agent) {
        throw new Error(
          `Mission references agent "${agentName}" (task "${t.title}") but no such agent exists. ` +
          `Available agents: ${allAgents.map(a => a.name).join(", ")}`
        );
      }
    }
    if (referencedModels.length > 0) {
      const missing = validateProviderKeys(referencedModels);
      if (missing.length > 0) {
        const details = missing
          .map(m => `${m.provider} (model: ${m.modelSpec})`)
          .join(", ");
        throw new Error(
          `Missing API keys for providers: ${details}. ` +
          `Set the corresponding environment variables or add them to polpo.json providers section.`
        );
      }
    }

    // Create tasks with dependency resolution
    const titleToId = new Map<string, string>();
    const tasks: Task[] = [];
    for (const t of doc.tasks) {
      const deps = (t.dependsOn || [])
        .map((title: string) => titleToId.get(title))
        .filter((id: string | undefined): id is string => !!id);

      // Validate expectations through Zod schemas
      let expectations: TaskExpectation[] = [];
      if (t.expectations && Array.isArray(t.expectations) && t.expectations.length > 0) {
        const { valid, warnings } = sanitizeExpectations(t.expectations);
        expectations = valid;
        for (const w of warnings) {
          this.ctx.emitter.emit("log", { level: "warn", message: `Mission task "${t.title}": ${w}` });
        }
      }

      const task = await this.taskMgr.addTask({
        title: t.title,
        description: t.description || t.title,
        assignTo: t.assignTo || (await this.agentMgr.getAgents())[0]?.name || "default",
        dependsOn: deps,
        expectations,
        expectedOutcomes: t.expectedOutcomes,
        group,
        missionId,
        maxDuration: t.maxDuration,
        retryPolicy: t.retryPolicy,
        notifications: t.notifications,
        sideEffects: t.sideEffects,
      });
      titleToId.set(t.title, task.id);
      tasks.push(task);
    }

    // Store quality gates (in-memory) and checkpoints (persisted to disk)
    if (doc.qualityGates && doc.qualityGates.length > 0) {
      this.gatesByGroup.set(group, doc.qualityGates as MissionQualityGate[]);
    }
    if (doc.checkpoints && doc.checkpoints.length > 0) {
      this.cpState.definitions[group] = doc.checkpoints as MissionCheckpoint[];
      await this.cpStore.save(this.cpState);
    }
    if (doc.delays && doc.delays.length > 0) {
      this.delayState.definitions[group] = doc.delays as MissionDelay[];
      await this.delayStore.save(this.delayState);
    }

    // Track scheduled origin so we know where to return after completion
    if (scheduledStatus) {
      this.scheduledOrigin.set(group, scheduledStatus);
    }

    // Persist mission-level notifications from document onto the Mission record
    if (doc.notifications) {
      await this.ctx.registry.updateMission?.(missionId, { status: "active", notifications: doc.notifications });
    } else {
      // Mark mission as active
      await this.ctx.registry.updateMission?.(missionId, { status: "active" });
    }
    this.ctx.emitter.emit("mission:executed", { missionId, group, taskCount: tasks.length });

    return { tasks, group };
  }

  /**
   * Resolve the Mission for a group of tasks.
   * Uses task.missionId (direct FK) when available, falls back to getMissionByName
   * for legacy tasks that pre-date the missionId field.
   */
  private async resolveMissionForGroup(groupTasks: Task[], group: string): Promise<Mission | undefined> {
    // Prefer the direct ID reference from any task in the group
    const mid = groupTasks.find(t => t.missionId)?.missionId;
    if (mid) return this.ctx.registry.getMission?.(mid);
    // Fallback: strip run-number suffix (e.g. "Mission #3" → "Mission") for legacy compat
    return this.ctx.registry.getMissionByName?.(group.replace(/ #\d+$/, ""));
  }

  /** Check if any mission groups have all tasks terminal, and clean up their volatile agents */
  async cleanupCompletedGroups(tasks: Task[]): Promise<void> {
    const groups = new Set<string>();
    for (const t of tasks) {
      if (t.group) groups.add(t.group);
    }
    for (const group of groups) {
      const groupTasks = tasks.filter(t => t.group === group);
      const allTerminal = groupTasks.every(t => t.status === "done" || t.status === "failed");

      // If tasks went back to non-terminal (e.g. individual retry via retryTask),
      // clear the cleaned flag so the group will be re-evaluated when done again.
      if (!allTerminal && this.cleanedGroups.has(group)) {
        this.cleanedGroups.delete(group);
        continue;
      }

      if (this.cleanedGroups.has(group)) continue;
      if (!allTerminal) continue;

      const cleanupPolicy = this.ctx.config.settings.volatileCleanup ?? "on_complete";
      if (cleanupPolicy === "on_complete") {
        await this.agentMgr.cleanupVolatileAgents(group);
      }
      this.cleanedGroups.add(group);

      // Auto-update mission status
      const mission = await this.resolveMissionForGroup(groupTasks, group);
      if (mission && mission.status === "active") {
        let allDone = groupTasks.every(t => t.status === "done");

        // Check mission quality threshold (only if all tasks passed structurally)
        if (allDone && this.qualityCtrl) {
          const thresholdResult = this.qualityCtrl.checkMissionThreshold(
            mission,
            groupTasks,
            this.ctx.config.settings.defaultQualityThreshold,
          );
          if (!thresholdResult.passed) {
            allDone = false; // Quality threshold not met — mark mission as failed
            this.ctx.emitter.emit("log", {
              level: "warn",
              message: `Mission "${group}" quality threshold not met: ${thresholdResult.avgScore?.toFixed(2) ?? "N/A"} < ${thresholdResult.threshold}`,
            });
          }
        }

        // Determine final status based on scheduled origin
        const origin = this.scheduledOrigin.get(group);
        let finalStatus: MissionStatus;
        if (origin === "recurring") {
          // Recurring missions always return to "recurring" — ready for next cron tick
          finalStatus = "recurring";
        } else if (origin === "scheduled" && !allDone) {
          // One-shot scheduled missions return to "scheduled" on failure for retry
          finalStatus = "scheduled";
        } else {
          // Normal missions or successful one-shot scheduled missions
          finalStatus = allDone ? "completed" : "failed";
        }
        await this.ctx.registry.updateMission?.(mission.id, { status: finalStatus });
        const report = await this.buildMissionReport(mission.id, group, groupTasks, allDone);
        this.ctx.emitter.emit("mission:completed", { missionId: mission.id, group, allPassed: allDone, report });

        // Aggregate mission metrics
        this.qualityCtrl?.aggregateMissionMetrics(mission.id, groupTasks);

        // Clean up gate, checkpoint, delay, and scheduled-origin caches
        this.gatesByGroup.delete(group);
        this.scheduledOrigin.delete(group);
        // Clean up persisted checkpoint entries for this group
        this.cpState = await this.cpStore.removeGroup(this.cpState, group);
        // Clean up persisted delay entries for this group
        this.delayState = await this.delayStore.removeGroup(this.delayState, group);
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  //  ATOMIC MISSION DATA OPERATIONS
  //  Read-modify-write the `data` JSON blob without full replacement.
  // ═══════════════════════════════════════════════════════

  /**
   * Parse a mission's `data` JSON and return the structured document.
   * Throws if the mission is not found or if `data` is not valid JSON.
   */
  private async parseMissionData(missionId: string): Promise<{ mission: Mission; doc: MissionDocumentParsed }> {
    const mission = await this.getMission(missionId);
    if (!mission) throw new Error("Mission not found");
    const doc = parseMissionDocument(JSON.parse(mission.data));
    return { mission, doc };
  }

  /**
   * Persist an updated document back onto the mission record.
   * Re-validates through Zod to ensure integrity.
   */
  private async persistMissionData(missionId: string, doc: MissionDocumentParsed): Promise<Mission> {
    // Re-validate to catch any structural issue before persisting
    parseMissionDocument(doc);
    const mission = await this.updateMission(missionId, { data: JSON.stringify(doc) });
    // Notify listeners so SSE clients (e.g. mission detail page) refetch updated data
    this.ctx.emitter.emit("mission:saved", { missionId: mission.id, name: mission.name, status: mission.status });
    return mission;
  }

  // ─── Task operations ────────────────────────────────

  /** Add a task to a draft mission's data. */
  async addMissionTask(missionId: string, task: {
    title: string;
    description: string;
    assignTo?: string;
    dependsOn?: string[];
    expectations?: unknown[];
    expectedOutcomes?: unknown[];
    maxDuration?: number;
    retryPolicy?: { escalateAfter?: number; fallbackAgent?: string };
    notifications?: unknown;
  }): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    // Enforce unique title
    if (doc.tasks.some(t => t.title === task.title)) {
      throw new Error(`Task title "${task.title}" already exists in this mission`);
    }
    doc.tasks.push(task as MissionDocumentParsed["tasks"][number]);
    return this.persistMissionData(missionId, doc);
  }

  /** Update a specific task within the mission data (matched by title). */
  async updateMissionTask(missionId: string, taskTitle: string, updates: {
    title?: string;
    description?: string;
    assignTo?: string;
    dependsOn?: string[];
    expectations?: unknown[];
    expectedOutcomes?: unknown[];
    maxDuration?: number;
    retryPolicy?: { escalateAfter?: number; fallbackAgent?: string };
    notifications?: unknown;
  }): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    const idx = doc.tasks.findIndex(t => t.title === taskTitle);
    if (idx === -1) throw new Error(`Task "${taskTitle}" not found in mission`);
    // If renaming, enforce unique title
    if (updates.title && updates.title !== taskTitle && doc.tasks.some(t => t.title === updates.title)) {
      throw new Error(`Task title "${updates.title}" already exists in this mission`);
    }
    doc.tasks[idx] = { ...doc.tasks[idx], ...updates } as MissionDocumentParsed["tasks"][number];
    return this.persistMissionData(missionId, doc);
  }

  /** Remove a task from the mission data (by title). Also cleans up dependsOn references. */
  async removeMissionTask(missionId: string, taskTitle: string): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    const idx = doc.tasks.findIndex(t => t.title === taskTitle);
    if (idx === -1) throw new Error(`Task "${taskTitle}" not found in mission`);
    doc.tasks.splice(idx, 1);
    // Clean up dependsOn references in remaining tasks
    for (const t of doc.tasks) {
      if (t.dependsOn) {
        t.dependsOn = t.dependsOn.filter(d => d !== taskTitle);
      }
    }
    // Clean up quality gates and checkpoints that reference this task
    if (doc.qualityGates) {
      for (const gate of doc.qualityGates) {
        gate.afterTasks = gate.afterTasks.filter(t => t !== taskTitle);
        gate.blocksTasks = gate.blocksTasks.filter(t => t !== taskTitle);
      }
      // Remove gates that became empty
      doc.qualityGates = doc.qualityGates.filter(g => g.afterTasks.length > 0 && g.blocksTasks.length > 0);
    }
    if (doc.checkpoints) {
      for (const cp of doc.checkpoints) {
        cp.afterTasks = cp.afterTasks.filter(t => t !== taskTitle);
        cp.blocksTasks = cp.blocksTasks.filter(t => t !== taskTitle);
      }
      doc.checkpoints = doc.checkpoints.filter(cp => cp.afterTasks.length > 0 && cp.blocksTasks.length > 0);
    }
    if (doc.delays) {
      for (const dl of doc.delays) {
        dl.afterTasks = dl.afterTasks.filter(t => t !== taskTitle);
        dl.blocksTasks = dl.blocksTasks.filter(t => t !== taskTitle);
      }
      doc.delays = doc.delays.filter(dl => dl.afterTasks.length > 0 && dl.blocksTasks.length > 0);
    }
    // Ensure at least 1 task remains (Zod will catch this, but give a nicer error)
    if (doc.tasks.length === 0) throw new Error("Cannot remove the last task from a mission");
    return this.persistMissionData(missionId, doc);
  }

  /** Reorder tasks within the mission data. Accepts an array of task titles in the desired order. */
  async reorderMissionTasks(missionId: string, titles: string[]): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    const titleSet = new Set(titles);
    if (titleSet.size !== titles.length) throw new Error("Duplicate titles in reorder list");
    const existing = new Set(doc.tasks.map(t => t.title));
    for (const t of titles) {
      if (!existing.has(t)) throw new Error(`Task "${t}" not found in mission`);
    }
    if (titles.length !== doc.tasks.length) throw new Error("Reorder list must include all task titles");
    const taskMap = new Map(doc.tasks.map(t => [t.title, t]));
    doc.tasks = titles.map(t => taskMap.get(t)!);
    return this.persistMissionData(missionId, doc);
  }

  // ─── Checkpoint operations ──────────────────────────

  /** Add a checkpoint to a mission's data. */
  async addMissionCheckpoint(missionId: string, checkpoint: {
    name: string;
    afterTasks: string[];
    blocksTasks: string[];
    notifyChannels?: string[];
    message?: string;
  }): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.checkpoints) doc.checkpoints = [];
    if (doc.checkpoints.some(c => c.name === checkpoint.name)) {
      throw new Error(`Checkpoint "${checkpoint.name}" already exists in this mission`);
    }
    doc.checkpoints.push(checkpoint);
    return this.persistMissionData(missionId, doc);
  }

  /** Update a checkpoint in the mission data (matched by name). */
  async updateMissionCheckpoint(missionId: string, checkpointName: string, updates: {
    name?: string;
    afterTasks?: string[];
    blocksTasks?: string[];
    notifyChannels?: string[];
    message?: string;
  }): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.checkpoints) throw new Error(`Checkpoint "${checkpointName}" not found in mission`);
    const idx = doc.checkpoints.findIndex(c => c.name === checkpointName);
    if (idx === -1) throw new Error(`Checkpoint "${checkpointName}" not found in mission`);
    if (updates.name && updates.name !== checkpointName && doc.checkpoints.some(c => c.name === updates.name)) {
      throw new Error(`Checkpoint "${updates.name}" already exists in this mission`);
    }
    doc.checkpoints[idx] = { ...doc.checkpoints[idx], ...updates };
    return this.persistMissionData(missionId, doc);
  }

  /** Remove a checkpoint from the mission data (by name). */
  async removeMissionCheckpoint(missionId: string, checkpointName: string): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.checkpoints) throw new Error(`Checkpoint "${checkpointName}" not found in mission`);
    const idx = doc.checkpoints.findIndex(c => c.name === checkpointName);
    if (idx === -1) throw new Error(`Checkpoint "${checkpointName}" not found in mission`);
    doc.checkpoints.splice(idx, 1);
    if (doc.checkpoints.length === 0) delete (doc as any).checkpoints;
    return this.persistMissionData(missionId, doc);
  }

  // ─── Delay operations ───────────────────────────────

  /** Add a delay to a mission's data. */
  async addMissionDelay(missionId: string, delay: {
    name: string;
    afterTasks: string[];
    blocksTasks: string[];
    duration: string;
    notifyChannels?: string[];
    message?: string;
  }): Promise<Mission> {
    // Validate duration format
    parseISO8601Duration(delay.duration);
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.delays) doc.delays = [];
    if (doc.delays.some(d => d.name === delay.name)) {
      throw new Error(`Delay "${delay.name}" already exists in this mission`);
    }
    doc.delays.push(delay);
    return this.persistMissionData(missionId, doc);
  }

  /** Update a delay in the mission data (matched by name). */
  async updateMissionDelay(missionId: string, delayName: string, updates: {
    name?: string;
    afterTasks?: string[];
    blocksTasks?: string[];
    duration?: string;
    notifyChannels?: string[];
    message?: string;
  }): Promise<Mission> {
    if (updates.duration) parseISO8601Duration(updates.duration);
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.delays) throw new Error(`Delay "${delayName}" not found in mission`);
    const idx = doc.delays.findIndex(d => d.name === delayName);
    if (idx === -1) throw new Error(`Delay "${delayName}" not found in mission`);
    if (updates.name && updates.name !== delayName && doc.delays.some(d => d.name === updates.name)) {
      throw new Error(`Delay "${updates.name}" already exists in this mission`);
    }
    doc.delays[idx] = { ...doc.delays[idx], ...updates };
    return this.persistMissionData(missionId, doc);
  }

  /** Remove a delay from the mission data (by name). */
  async removeMissionDelay(missionId: string, delayName: string): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.delays) throw new Error(`Delay "${delayName}" not found in mission`);
    const idx = doc.delays.findIndex(d => d.name === delayName);
    if (idx === -1) throw new Error(`Delay "${delayName}" not found in mission`);
    doc.delays.splice(idx, 1);
    if (doc.delays.length === 0) delete (doc as any).delays;
    return this.persistMissionData(missionId, doc);
  }

  // ─── Quality gate operations ────────────────────────

  /** Add a quality gate to a mission's data. */
  async addMissionQualityGate(missionId: string, gate: {
    name: string;
    afterTasks: string[];
    blocksTasks: string[];
    minScore?: number;
    requireAllPassed?: boolean;
    condition?: string;
    notifyChannels?: string[];
  }): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.qualityGates) doc.qualityGates = [];
    if (doc.qualityGates.some(g => g.name === gate.name)) {
      throw new Error(`Quality gate "${gate.name}" already exists in this mission`);
    }
    doc.qualityGates.push(gate);
    return this.persistMissionData(missionId, doc);
  }

  /** Update a quality gate in the mission data (matched by name). */
  async updateMissionQualityGate(missionId: string, gateName: string, updates: {
    name?: string;
    afterTasks?: string[];
    blocksTasks?: string[];
    minScore?: number;
    requireAllPassed?: boolean;
    condition?: string;
    notifyChannels?: string[];
  }): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.qualityGates) throw new Error(`Quality gate "${gateName}" not found in mission`);
    const idx = doc.qualityGates.findIndex(g => g.name === gateName);
    if (idx === -1) throw new Error(`Quality gate "${gateName}" not found in mission`);
    if (updates.name && updates.name !== gateName && doc.qualityGates.some(g => g.name === updates.name)) {
      throw new Error(`Quality gate "${updates.name}" already exists in this mission`);
    }
    doc.qualityGates[idx] = { ...doc.qualityGates[idx], ...updates };
    return this.persistMissionData(missionId, doc);
  }

  /** Remove a quality gate from the mission data (by name). */
  async removeMissionQualityGate(missionId: string, gateName: string): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.qualityGates) throw new Error(`Quality gate "${gateName}" not found in mission`);
    const idx = doc.qualityGates.findIndex(g => g.name === gateName);
    if (idx === -1) throw new Error(`Quality gate "${gateName}" not found in mission`);
    doc.qualityGates.splice(idx, 1);
    if (doc.qualityGates.length === 0) delete (doc as any).qualityGates;
    return this.persistMissionData(missionId, doc);
  }

  // ─── Team (volatile agents) operations ──────────────

  /** Add a team member to the mission's volatile team. */
  async addMissionTeamMember(missionId: string, member: {
    name: string;
    role?: string;
    model?: string;
    [key: string]: unknown;
  }): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.team) doc.team = [];
    if ((doc.team as any[]).some((m: any) => m.name === member.name)) {
      throw new Error(`Team member "${member.name}" already exists in this mission`);
    }
    (doc.team as any[]).push(member);
    return this.persistMissionData(missionId, doc);
  }

  /** Update a team member in the mission data (matched by name). */
  async updateMissionTeamMember(missionId: string, memberName: string, updates: {
    name?: string;
    role?: string;
    model?: string;
    [key: string]: unknown;
  }): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.team) throw new Error(`Team member "${memberName}" not found in mission`);
    const team = doc.team as any[];
    const idx = team.findIndex((m: any) => m.name === memberName);
    if (idx === -1) throw new Error(`Team member "${memberName}" not found in mission`);
    if (updates.name && updates.name !== memberName && team.some((m: any) => m.name === updates.name)) {
      throw new Error(`Team member "${updates.name}" already exists in this mission`);
    }
    team[idx] = { ...team[idx], ...updates };
    return this.persistMissionData(missionId, doc);
  }

  /** Remove a team member from the mission data (by name). */
  async removeMissionTeamMember(missionId: string, memberName: string): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.team) throw new Error(`Team member "${memberName}" not found in mission`);
    const team = doc.team as any[];
    const idx = team.findIndex((m: any) => m.name === memberName);
    if (idx === -1) throw new Error(`Team member "${memberName}" not found in mission`);
    team.splice(idx, 1);
    if (team.length === 0) delete (doc as any).team;
    return this.persistMissionData(missionId, doc);
  }

  // ─── Notifications operations ───────────────────────

  /** Update the mission-level notification rules. */
  async updateMissionNotifications(missionId: string, notifications: ScopedNotificationRules | null): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (notifications === null) {
      delete (doc as any).notifications;
    } else {
      (doc as any).notifications = notifications;
    }
    return this.persistMissionData(missionId, doc);
  }

  async buildMissionReport(missionId: string, group: string, groupTasks: Task[], allPassed: boolean): Promise<MissionReport> {
    const state = await this.ctx.registry.getState();
    const processes = state?.processes ?? [];

    const allFilesCreated = new Set<string>();
    const allFilesEdited = new Set<string>();
    let totalDuration = 0;
    const scores: number[] = [];
    const allOutcomes: import("./types.js").TaskOutcome[] = [];

    const taskReports = groupTasks.map(t => {
      const duration = t.result?.duration ?? 0;
      totalDuration += duration;
      const score = t.result?.assessment?.globalScore;
      if (score !== undefined) scores.push(score);

      // Get file activity from processes (may already be gone for completed tasks)
      const proc = processes.find(p => p.taskId === t.id);
      const filesCreated = proc?.activity?.filesCreated ?? [];
      const filesEdited = proc?.activity?.filesEdited ?? [];
      for (const f of filesCreated) allFilesCreated.add(f);
      for (const f of filesEdited) allFilesEdited.add(f);

      // Aggregate outcomes across all tasks
      if (t.outcomes) {
        for (const o of t.outcomes) allOutcomes.push(o);
      }

      return {
        title: t.title,
        status: t.status as "done" | "failed",
        duration,
        score,
        filesCreated,
        filesEdited,
        outcomes: t.outcomes,
      };
    });

    const avgScore = scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : undefined;

    return {
      missionId,
      group,
      allPassed,
      totalDuration,
      tasks: taskReports,
      filesCreated: [...allFilesCreated],
      filesEdited: [...allFilesEdited],
      outcomes: allOutcomes.length > 0 ? allOutcomes : undefined,
      avgScore,
    };
  }
}

// ── ISO 8601 Duration Parser ──────────────────────────────────────────
// Supports: P[nY][nM][nW][nD][T[nH][nM][nS]]
// Examples: PT2H (2 hours), PT30M (30 min), P1D (1 day), P1DT6H (1 day 6 hours)

const ISO_DURATION_RE = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

function parseISO8601Duration(duration: string): number {
  const m = ISO_DURATION_RE.exec(duration);
  if (!m) throw new Error(`Invalid ISO 8601 duration: "${duration}"`);
  const years   = parseInt(m[1] || "0", 10);
  const months  = parseInt(m[2] || "0", 10);
  const weeks   = parseInt(m[3] || "0", 10);
  const days    = parseInt(m[4] || "0", 10);
  const hours   = parseInt(m[5] || "0", 10);
  const minutes = parseInt(m[6] || "0", 10);
  const seconds = parseFloat(m[7] || "0");
  // Approximate: 1 year ≈ 365.25 days, 1 month ≈ 30.44 days
  const totalDays = years * 365.25 + months * 30.44 + weeks * 7 + days;
  return ((totalDays * 24 + hours) * 60 + minutes) * 60000 + seconds * 1000;
}
