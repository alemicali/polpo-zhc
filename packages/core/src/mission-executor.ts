import { parseAgentRef } from "./agent-versions.js";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { TaskManager } from "./task-manager.js";
import type { AgentManager } from "./agent-manager.js";
import type { Mission, MissionStatus, MissionReport, Task, TaskExpectation, ExpectedOutcome, MissionQualityGate, MissionCheckpoint, MissionDelay, ScopedNotificationRules, TaskOutcome, WorkOrigin } from "./types.js";
import type { QualityController } from "./quality-controller.js";
import { normalizeTaskToolScope, type TaskToolScope } from "./task-tool-scope.js";
import { sanitizeExpectations, parseMissionDocument, dependencyOrder, type MissionDocumentParsed } from "./schemas.js";
import type { CheckpointStore, CheckpointState } from "./checkpoint-store.js";
import type { DelayStore, DelayState } from "./delay-store.js";
import type { NotificationRouterPort } from "./notification-router-port.js";
import { parseISO8601Duration } from "./iso-duration.js";
import { isValidBudgetUsd, missionSpentUsd, tasksOfMission } from "./mission-cost.js";
import type { MissionDecision } from "./types.js";
import {
  decisionCheckpointName, decisionNodeBranch, decisionNodeItems, decisionNodeQuestion, decisionNodeTasks, describeDecisionAnswer, renderDecisionNodeState,
  type DecisionAnswer, type DecisionNodeState, type DecisionNodeStore, type MissionDecider,
} from "./decisions.js";

// ── In-memory fallback stores (no Node.js deps) ─────────────────────────

class InMemoryCheckpointStore implements CheckpointStore {
  private state: CheckpointState = { definitions: {}, active: {}, resumed: [] };
  async load(): Promise<CheckpointState> {
    return this.state;
  }
  async save(state: CheckpointState): Promise<void> {
    this.state = state;
  }
  async removeGroup(state: CheckpointState, group: string): Promise<CheckpointState> {
    delete state.definitions[group];
    for (const key of Object.keys(state.active)) {
      if (key.startsWith(group + ":")) delete state.active[key];
    }
    state.resumed = state.resumed.filter(k => !k.startsWith(group + ":"));
    return state;
  }
}

class InMemoryDecisionNodeStore implements DecisionNodeStore {
  private state: Record<string, DecisionNodeState> = {};
  async load(): Promise<Record<string, DecisionNodeState>> { return this.state; }
  async save(state: Record<string, DecisionNodeState>): Promise<void> { this.state = state; }
}

class InMemoryDelayStore implements DelayStore {
  private state: DelayState = { definitions: {}, active: {}, expired: [] };
  async load(): Promise<DelayState> {
    return this.state;
  }
  async save(state: DelayState): Promise<void> {
    this.state = state;
  }
  async removeGroup(state: DelayState, group: string): Promise<DelayState> {
    delete state.definitions[group];
    for (const key of Object.keys(state.active)) {
      if (key.startsWith(group + ":")) delete state.active[key];
    }
    state.expired = state.expired.filter(k => !k.startsWith(group + ":"));
    return state;
  }
}

const RUN_KEY_SEPARATOR = "\u0000";

/** One run of a mission: its task group plus its mission id (recurring runs share the id). */
function runKey(task: Task): string {
  return `${task.group}${RUN_KEY_SEPARATOR}${task.missionId ?? ""}`;
}

/** Tasks with a group, by run, in first-appearance order (tasks keep snapshot order). */
function groupByRun(tasks: Task[]): Map<string, Task[]> {
  const runs = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.group) continue;
    const key = runKey(t);
    const list = runs.get(key);
    if (list) list.push(t);
    else runs.set(key, [t]);
  }
  return runs;
}

/**
 * Mission CRUD + execution + resume + group lifecycle.
 */

/** An edit inside a mission document, described for mission:updated. */
export interface MissionEdit {
  section: "task" | "checkpoint" | "delay" | "qualityGate" | "team" | "notifications" | "order";
  action: "added" | "updated" | "removed" | "reordered";
  item?: string;
}

/** Key under which an update carries its MissionEdit to the event layer (never persisted). */
export const MISSION_EDIT: unique symbol = Symbol.for("polpo.missionEdit") as never;

export class MissionExecutor {
  /** Finished runs, keyed by run (see runKey): their mission status is already final. */
  private cleanedGroups = new Set<string>();
  /** Delays whose duration could not be read, already reported (once each). */
  private unreadableDelays = new Set<string>();
  /** Quality gates parsed from mission documents, keyed by mission group name */
  private gatesByGroup = new Map<string, MissionQualityGate[]>();
  /** Persistent checkpoint store — survives server restarts */
  private cpStore: CheckpointStore;
  /** In-memory mirror of persisted checkpoint state (synced on every mutation) */
  private cpState!: CheckpointState;
  /** Optional quality controller — set by orchestrator after init */
  private qualityCtrl?: QualityController;
  /** Optional notification router — for checkpoint notification rules */
  private notificationRouter?: NotificationRouterPort;
  /** Track which checkpoint notification rules have been registered (by cpKey) */
  private registeredCheckpointRules = new Set<string>();
  /** Persistent delay store — survives server restarts */
  private delayStore: DelayStore;
  /** In-memory mirror of persisted delay state (synced on every mutation) */
  private delayState!: DelayState;
  /** Track which delay notification rules have been registered (by delayKey) */
  private registeredDelayRules = new Set<string>();
  /** Mission decision nodes: their definitions by group (from the document), their state (persisted). */
  private decisionsByGroup = new Map<string, MissionDecision[]>();
  private nodeStore: DecisionNodeStore;
  private nodeState: Record<string, DecisionNodeState> = {};
  /** Takes a node's decision (the decision service); absent: nodes fail over to onUncertain. */
  private decider?: MissionDecider;
  /** Track the pre-execution status for scheduled/recurring missions (by group name).
   *  When a mission completes/fails, this determines whether to return to scheduled/recurring. */
  private scheduledOrigin = new Map<string, "scheduled" | "recurring">();

  constructor(
    private ctx: OrchestratorContext,
    private taskMgr: TaskManager,
    private agentMgr: AgentManager,
  ) {
    this.cpStore = ctx.checkpointStore ?? new InMemoryCheckpointStore();
    this.delayStore = ctx.delayStore ?? new InMemoryDelayStore();
    this.nodeStore = ctx.decisionNodeStore ?? new InMemoryDecisionNodeStore();

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
    // a decision cut short by a restart is taken again
    this.nodeState = Object.fromEntries(Object.entries(await this.nodeStore.load()).filter(([, s]) => s.status !== "deciding"));
    await this.rebuildCleanedGroups();
  }

  /** Async init: rebuild cleanedGroups from persisted task state. */
  private async rebuildCleanedGroups(): Promise<void> {
    const allTasks = await this.ctx.registry.getAllTasks();
    for (const [key, runTasks] of groupByRun(allTasks)) {
      if (!runTasks.every(t => t.status === "done" || t.status === "failed")) continue;
      // A run whose tasks all ended while its mission is still active was never closed (e.g. it
      // shared its group with another mission): leave it to cleanupCompletedGroups to close now.
      const mid = runTasks[0].missionId;
      const mission = mid ? await this.ctx.registry.getMission?.(mid) : undefined;
      if (mission && (mission.status === "active" || mission.status === "paused")) continue;
      this.cleanedGroups.add(key);
    }
  }

  /** Forget the finished runs of a mission group (and of its numbered recurring runs). */
  private forgetCleanedGroup(group: string): void {
    for (const key of this.cleanedGroups) {
      const keyGroup = key.slice(0, key.indexOf(RUN_KEY_SEPARATOR));
      if (keyGroup === group || keyGroup.startsWith(group + " #")) this.cleanedGroups.delete(key);
    }
  }

  /** Set the quality controller instance (called by Orchestrator after init). */
  setQualityController(ctrl: QualityController): void {
    this.qualityCtrl = ctrl;
  }

  /** Set the notification router — enables per-checkpoint channel routing. */
  setNotificationRouter(router: NotificationRouterPort): void {
    this.notificationRouter = router;
  }

  /** Get quality gates for a mission group. Returns empty array if none defined. */
  getQualityGates(group: string): MissionQualityGate[] {
    return this.gatesByGroup.get(group) ?? [];
  }

  /** Get checkpoints for a mission group. Returns empty array if none defined. */
  getCheckpoints(group: string): MissionCheckpoint[] {
    return this.cpState?.definitions?.[group] ?? [];
  }

  /**
   * Re-register a mission's checkpoint definitions from its document when the persisted
   * state lost them (state kept in memory before a restart). Without them a mission paused
   * at a checkpoint can never be resumed. Returns the definitions now known for the group.
   */
  async restoreCheckpointDefinitions(group: string, missionData: string | undefined): Promise<MissionCheckpoint[]> {
    const known = this.getCheckpoints(group);
    if (known.length > 0 || !missionData) return known;
    try {
      const doc = JSON.parse(missionData) as { checkpoints?: MissionCheckpoint[] };
      if (Array.isArray(doc.checkpoints) && doc.checkpoints.length > 0) {
        this.cpState.definitions[group] = doc.checkpoints;
        await this.cpStore.save(this.cpState);
      }
    } catch { /* malformed mission data: nothing to restore */ }
    return this.getCheckpoints(group);
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
    const checkpoints = this.cpState?.definitions?.[group];
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
          await this.ctx.registry.updateMission?.(mission.id, { status: "paused", ...(mission.pauseReason ? { pauseReason: undefined } : {}) });
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
  async resumeCheckpoint(group: string, checkpointName: string, resolvedBy?: string): Promise<boolean> {
    const cpKey = `${group}:${checkpointName}`;
    const active = this.cpState.active[cpKey];
    if (!active) return false;
    // a decision node waiting for a person: resuming its checkpoint takes the model's suggestion
    const waiting = Object.values(this.nodeState).find((s) => s.group === group && s.status === "awaiting" && decisionCheckpointName(s.node) === checkpointName);
    if (waiting) await this.resolveDecisionNode(group, waiting.node, waiting.suggested ?? null, resolvedBy ?? "person", { resume: false });

    this.cpState.resumed.push(cpKey);
    delete this.cpState.active[cpKey];
    await this.cpStore.save(this.cpState);

    // Un-pause the mission (back to active) — resolve via missionId from tasks
    const groupTasks = (await this.ctx.registry.getAllTasks()).filter(t => t.group === group);
    const mission = await this.resolveMissionForGroup(groupTasks, group);
    if (mission && mission.status === "paused") {
      // the budget check pauses it again at the next tick if it is still over its budget
      await this.ctx.registry.updateMission?.(mission.id, { status: "active", ...(mission.pauseReason ? { pauseReason: undefined } : {}) });
    }

    this.ctx.emitter.emit("checkpoint:resumed", {
      missionId: mission?.id,
      group,
      checkpointName,
    });

    return true;
  }

  /** Drop a group's checkpoint and delay state (its mission was aborted). */
  async releaseGroupFlow(group: string): Promise<void> {
    this.cpState = await this.cpStore.removeGroup(this.cpState, group);
    this.delayState = await this.delayStore.removeGroup(this.delayState, group);
    await this.dropDecisionNodes(group);
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
    return this.delayState?.definitions?.[group] ?? [];
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
    const delays = this.delayState?.definitions?.[group];
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
        // A duration that cannot be read (missions saved before durations were validated) must
        // not stop the supervisor, which would hold every mission: report it and do not wait.
        let durationMs: number;
        try {
          durationMs = parseISO8601Duration(dl.duration);
        } catch (err) {
          if (!this.unreadableDelays.has(dlKey)) {
            this.unreadableDelays.add(dlKey);
            this.ctx.emitter.emit("log", { level: "warn", message: `[delay] "${dl.name}" of "${group}" ignored: ${err instanceof Error ? err.message : String(err)}` });
          }
          continue;
        }
        const startedAt = new Date().toISOString();
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

  // ─── Decision nodes ──────────────────────────────────

  /** Set who takes node decisions (the decision service, wired by the server). */
  setDecider(decider: MissionDecider | undefined): void {
    this.decider = decider;
  }

  /** A group's decision nodes: known since the run started, else read from the mission's document (after a restart). */
  getDecisionNodes(group: string, missionData?: string): MissionDecision[] {
    const known = this.decisionsByGroup.get(group);
    if (known) return known;
    if (!missionData) return [];
    try {
      const doc = JSON.parse(missionData) as { decisions?: MissionDecision[] };
      const list = Array.isArray(doc.decisions) ? doc.decisions : [];
      this.decisionsByGroup.set(group, list);
      return list;
    } catch { return []; }
  }

  /** Every node's state (deciding, decided, waiting for a person), newest first. */
  listDecisionNodes(): DecisionNodeState[] {
    return Object.values(this.nodeState).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Decisions in flight or waiting for a person: the engine does not call that a deadlock. */
  hasPendingDecisions(): boolean {
    return Object.values(this.nodeState).some((s) => s.status !== "decided");
  }

  /**
   * Is a task held by a decision node? A task in a node's branches waits until the node decides
   * (the decision starts once its after tasks have all finished); then the chosen branch's tasks
   * go on and the others are skipped. Returns the node holding it, undefined when it may proceed.
   */
  async getBlockingDecision(group: string, taskTitle: string, taskId: string, tasks: Task[], missionData?: string): Promise<{ decision: MissionDecision; state?: DecisionNodeState } | undefined> {
    for (const d of this.getDecisionNodes(group, missionData)) {
      const held = decisionNodeTasks(d);
      if (!held.includes(taskTitle) && !held.includes(taskId)) continue;
      const key = `${group}:${d.name}`;
      const st = this.nodeState[key];
      if (st?.status === "decided") {
        const chosen = st.branch ? d.branches[st.branch] ?? [] : [];
        if (chosen.includes(taskTitle) || chosen.includes(taskId)) continue;
        return { decision: d, state: st };
      }
      if (st) return { decision: d, state: st };
      const after = tasks.filter((t) => d.afterTasks.includes(t.title) || d.afterTasks.includes(t.id));
      const finished = after.length >= d.afterTasks.length && after.every((t) => t.status === "done" || t.status === "failed");
      if (!finished) return { decision: d };
      return { decision: d, state: this.startDecision(group, d, tasks) };
    }
    return undefined;
  }

  /** Take a node's decision in the background; its outcome is applied when it arrives. */
  private startDecision(group: string, d: MissionDecision, tasks: Task[]): DecisionNodeState {
    const key = `${group}:${d.name}`;
    const missionId = tasks.find((t) => t.group === group && t.missionId)?.missionId;
    const st: DecisionNodeState = { group, ...(missionId ? { missionId } : {}), node: d.name, status: "deciding", startedAt: new Date().toISOString() };
    this.nodeState[key] = st;
    void this.nodeStore.save(this.nodeState);
    this.ctx.emitter.emit("decision:node", { group, missionId, node: d.name, status: "deciding" });
    const run = async () => {
      if (!this.decider) throw new Error("Decisions are not available here (no server)");
      const items = decisionNodeItems(d, tasks);
      return this.decider({
        state: renderDecisionNodeState(d, tasks) || "(the tasks before this decision produced no result)",
        questions: [decisionNodeQuestion(d, items)],
        ...(d.model ? { model: d.model } : {}),
        caller: { kind: "mission", ...(missionId ? { id: missionId } : {}), label: `${group} → ${d.name}` },
      });
    };
    void run().then(
      (r) => this.decisionOutcome(group, d, { id: r.id, answer: r.answers[0], calibrated: r.calibrated }),
      (err) => this.decisionOutcome(group, d, { error: err instanceof Error ? err.message : String(err) }),
    ).catch((err) => this.ctx.emitter.emit("log", { level: "error", message: `Decision "${d.name}" (${group}): ${err instanceof Error ? err.message : String(err)}` }));
    return st;
  }

  /** A node's decision arrived (or failed): take its branch, the onUncertain branch, or wait for a person. */
  private async decisionOutcome(group: string, d: MissionDecision, r: { id?: string; answer?: DecisionAnswer; calibrated?: boolean; error?: string }): Promise<void> {
    const key = `${group}:${d.name}`;
    const st = this.nodeState[key];
    if (!st || st.status !== "deciding") return; // the run was aborted meanwhile
    const suggested = r.answer ? decisionNodeBranch(d, r.answer) ?? null : null;
    const base = { ...st, ...(r.id ? { decisionId: r.id } : {}), ...(r.answer ? { answer: r.answer } : {}), ...(r.calibrated !== undefined ? { calibrated: r.calibrated } : {}), suggested };
    const unsure = r.error ? `The decision failed: ${r.error}` : r.answer?.uncertain ? `The answer is uncertain (confidence ${r.answer.confidence?.toFixed(2) ?? "unknown"} below ${r.answer.threshold})` : undefined;
    if (!unsure) { await this.applyDecisionBranch(group, d, { ...base, branch: suggested }, "model"); return; }
    const u = d.onUncertain;
    if (u && u !== "human") { await this.applyDecisionBranch(group, d, { ...base, branch: u.branch, reason: unsure }, "onUncertain"); return; }
    // a person chooses: the mission pauses at a checkpoint (the existing notification, resume, events)
    this.nodeState[key] = { ...base, status: "awaiting", reason: unsure };
    await this.nodeStore.save(this.nodeState);
    const cp: MissionCheckpoint = {
      name: decisionCheckpointName(d.name), afterTasks: d.afterTasks, blocksTasks: decisionNodeTasks(d),
      message: `${unsure}.${r.answer ? ` Model: ${describeDecisionAnswer(r.answer)}.` : ""} Resume to take ${suggested ? `"${suggested}"` : "no branch"}, or choose a branch on the Decisions page (polpo_decision_resolve).`,
      ...(d.notifyChannels?.length ? { notifyChannels: d.notifyChannels } : {}),
    };
    const defs = (this.cpState.definitions[group] ?? []).filter((c) => c.name !== cp.name);
    this.cpState.definitions[group] = [...defs, cp];
    this.cpState.resumed = this.cpState.resumed.filter((k) => k !== `${group}:${cp.name}`);
    await this.cpStore.save(this.cpState);
    this.ctx.emitter.emit("decision:node", { group, missionId: st.missionId, node: d.name, status: "awaiting", suggested, ...(r.id ? { decisionId: r.id } : {}), reason: unsure });
  }

  /**
   * A person chooses a waiting node's branch (null: none of its tasks run). The node's checkpoint
   * is resumed (the mission goes on). Throws when the node is not waiting or the branch is unknown.
   */
  async resolveDecisionNode(group: string, node: string, branch: string | null, by: string, opts: { resume?: boolean } = {}): Promise<DecisionNodeState> {
    const key = `${group}:${node}`;
    const st = this.nodeState[key];
    if (!st) throw new Error(`No decision "${node}" in "${group}"`);
    if (st.status !== "awaiting") throw new Error(`The decision "${node}" is not waiting for a person (${st.status})`);
    const d = this.getDecisionNodes(group).find((x) => x.name === node);
    if (!d) throw new Error(`The decision "${node}" is no longer in "${group}"`);
    if (branch !== null && !(branch in d.branches)) throw new Error(`"${branch}" is not a branch of "${node}" (${Object.keys(d.branches).join(", ")})`);
    const next = await this.applyDecisionBranch(group, d, { ...st, branch }, by);
    const cpName = decisionCheckpointName(node);
    this.cpState.definitions[group] = (this.cpState.definitions[group] ?? []).filter((c) => c.name !== cpName);
    await this.cpStore.save(this.cpState);
    if (opts.resume !== false && this.cpState.active[`${group}:${cpName}`]) await this.resumeCheckpoint(group, cpName, by);
    return next;
  }

  /**
   * Take a branch: its tasks go on (with the decision in their description), every other branch
   * task is skipped (done, its result says why), and so are the tasks whose dependencies are all skipped.
   */
  private async applyDecisionBranch(group: string, d: MissionDecision, st: DecisionNodeState, decidedBy: string): Promise<DecisionNodeState> {
    const key = `${group}:${d.name}`;
    // the node is marked decided only once its tasks are skipped / annotated: until then they stay held
    const next: DecisionNodeState = { ...st, status: "decided", branch: st.branch ?? null, decidedAt: new Date().toISOString(), decidedBy };
    const groupTasks = (await this.ctx.registry.getAllTasks()).filter((t) => t.group === group && (!st.missionId || t.missionId === st.missionId));
    const chosen = new Set(next.branch ? d.branches[next.branch] ?? [] : []);
    const held = new Set(decisionNodeTasks(d));
    const open = (t: Task) => t.status === "pending" || t.status === "draft";
    const skipped = new Set(groupTasks.filter((t) => held.has(t.title) && !chosen.has(t.title) && open(t)).map((t) => t.id));
    for (let grew = true; grew;) {
      grew = false;
      for (const t of groupTasks) {
        if (skipped.has(t.id) || !open(t) || chosen.has(t.title) || t.dependsOn.length === 0) continue;
        if (t.dependsOn.every((dep) => skipped.has(dep))) { skipped.add(t.id); grew = true; }
      }
    }
    const answerText = next.answer ? describeDecisionAnswer(next.answer) : "no answer";
    const why = `Skipped: the decision "${d.name}" took ${next.branch ? `the branch "${next.branch}"` : "no branch"} (${answerText})`;
    for (const t of groupTasks.filter((x) => skipped.has(x.id))) {
      const from = t.status;
      await this.ctx.registry.updateTask(t.id, { result: { exitCode: 0, stdout: why, stderr: "", duration: 0 } });
      const done = await this.ctx.registry.unsafeSetStatus(t.id, "done", `skipped by decision "${d.name}"`);
      this.ctx.emitter.emit("task:transition", { taskId: t.id, from, to: "done", task: done, reason: `skipped by decision "${d.name}"` });
    }
    const ranking = next.answer?.ranking?.length ? `\n${next.answer.ranking.map((r, i) => `${i + 1}. ${r.label} (score ${r.score.toFixed(2)})`).join("\n")}` : "";
    const note = `\n\n## Decision "${d.name}"\n${d.question.instructions}\nAnswer: ${answerText}${ranking}${decidedBy !== "model" ? `\nBranch "${next.branch ?? "none"}" chosen by ${decidedBy}${next.reason ? ` (${next.reason})` : ""}.` : ""}`;
    for (const t of groupTasks.filter((x) => chosen.has(x.title) && open(x))) {
      await this.ctx.registry.updateTask(t.id, { description: `${t.description}${note}` });
    }
    this.nodeState[key] = next;
    await this.nodeStore.save(this.nodeState);
    this.ctx.emitter.emit("decision:node", { group, missionId: st.missionId, node: d.name, status: "decided", branch: next.branch ?? null, decidedBy, ...(st.decisionId ? { decisionId: st.decisionId } : {}), skipped: skipped.size });
    return next;
  }

  /** Forget a group's decision nodes (its run ended or was aborted). */
  private async dropDecisionNodes(group: string): Promise<void> {
    this.decisionsByGroup.delete(group);
    let changed = false;
    for (const [k, s] of Object.entries(this.nodeState)) if (s.group === group) { delete this.nodeState[k]; changed = true; }
    if (changed) await this.nodeStore.save(this.nodeState);
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

  async saveMission(opts: { data: string; prompt?: string; name?: string; status?: MissionStatus; notifications?: ScopedNotificationRules; budgetUsd?: number; owner?: string; origin?: WorkOrigin }): Promise<Mission> {
    if (!this.ctx.registry.saveMission) throw new Error("Store does not support missions");
    if (opts.budgetUsd !== undefined && !isValidBudgetUsd(opts.budgetUsd)) throw new Error("budgetUsd must be a positive number of USD");
    const requested = opts.name ?? (await this.ctx.registry.nextMissionName?.()) ?? `mission-${Date.now()}`;
    const name = await this.uniqueMissionName(requested);
    const mission = await this.ctx.registry.saveMission({
      name,
      data: opts.data,
      prompt: opts.prompt,
      status: opts.status ?? "draft",
      notifications: opts.notifications,
      ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
      ...(opts.owner ? { owner: opts.owner.toLowerCase() } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    });
    this.ctx.emitter.emit("mission:saved", { missionId: mission.id, name: mission.name, status: mission.status });
    return mission;
  }

  /**
   * A mission's name is its task group, so two missions with the same name (e.g. running a
   * playbook twice) would share tasks, checkpoints and completion: the second run would see the
   * first run's finished tasks and never be marked completed. Later missions get "name (2)", "(3)"…
   */
  private async uniqueMissionName(name: string): Promise<string> {
    const taken = new Set((await this.ctx.registry.getAllMissions?.() ?? []).map(m => m.name));
    if (!taken.has(name)) return name;
    let n = 2;
    while (taken.has(`${name} (${n})`)) n++;
    return `${name} (${n})`;
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

  /**
   * Update a mission. `budgetUsd: undefined` (the key present) or null clears the budget; a mission
   * leaving "paused" forgets why it was paused (pauseReason). A budget raised or cleared on a
   * mission the budget paused lets it go on at the next tick (OrchestratorEngine).
   */
  async updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission> {
    if (!this.ctx.registry.updateMission) throw new Error("Store does not support missions");
    let next = updates;
    if ("budgetUsd" in updates) {
      const b = (updates as { budgetUsd?: number | null }).budgetUsd;
      if (b !== undefined && b !== null && !isValidBudgetUsd(b)) throw new Error("budgetUsd must be a positive number of USD (null clears it)");
      next = { ...next, budgetUsd: b ?? undefined };
    }
    if (updates.status !== undefined && updates.status !== "paused" && !("pauseReason" in updates)
      && (await this.getMission(missionId))?.pauseReason) {
      next = { ...next, pauseReason: undefined };
    }
    return this.ctx.registry.updateMission(missionId, next);
  }

  async deleteMission(missionId: string): Promise<boolean> {
    if (!this.ctx.registry.deleteMission) throw new Error("Store does not support missions");
    const mission = await this.getMission(missionId);
    if (!mission) return false;

    // ── Cascade cleanup ──────────────────────────────────

    // 1. Kill running processes and remove all tasks belonging to this mission
    const missionGroup = mission.name;
    // Tasks of other missions with the same name (created before names were unique) stay.
    const deletedTasks = await this.taskMgr.clearTasks(
      t => t.missionId === missionId || (!t.missionId && t.group === missionGroup),
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
    this.forgetCleanedGroup(missionGroup);

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
    if (mission.status === "paused" && mission.pauseReason === "budget" && isValidBudgetUsd(mission.budgetUsd)) {
      const spent = missionSpentUsd(tasksOfMission(mission, await this.ctx.registry.getAllTasks()));
      if (spent >= mission.budgetUsd) {
        throw new Error(`Mission "${mission.name}" is over its budget ($${spent.toFixed(2)} spent of $${mission.budgetUsd.toFixed(2)}): raise or clear budgetUsd and it goes on by itself.`);
      }
    }

    // Re-register volatile agents if they were cleaned up
    this.forgetCleanedGroup(mission.name);
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

  /** Whether a run that started before a restart came from a recurring or a one-shot schedule. */
  private async storedScheduleOrigin(mission: Mission): Promise<"scheduled" | "recurring" | undefined> {
    if (!mission.schedule) return undefined;
    const state = await this.ctx.scheduleStore?.getSchedule(mission.id).catch(() => undefined);
    if (!state || state.expression !== mission.schedule) return undefined;
    return state.recurring ? "recurring" : "scheduled";
  }

  /**
   * `requestedBy`: the member this run is for (who started it, or the schedule's owner): its tasks
   * carry it (a CLI engine on a personal sign-in runs only its owner's work).
   */
  async executeMission(missionId: string, opts: { requestedBy?: string; origin?: WorkOrigin } = {}): Promise<{ tasks: Task[]; group: string }> {
    const mission = await this.ctx.registry.getMission?.(missionId);
    if (!mission) throw new Error("Mission not found");
    const executableStates = ["draft", "scheduled", "recurring", "failed", "cancelled"];
    if (!executableStates.includes(mission.status)) {
      throw new Error(`Cannot execute mission in "${mission.status}" state (must be ${executableStates.map(s => `"${s}"`).join(", ")})`);
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
      // "writer@1.2.0": the agent, pinned to a published version
      const agentName = t.assignTo ? parseAgentRef(t.assignTo).name : allAgents[0]?.name;
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
    if (referencedModels.length > 0 && this.ctx.validateProviderKeys) {
      const missing = this.ctx.validateProviderKeys(referencedModels);
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
    // A task may be listed before one it depends on: create dependencies first, or the id is unknown
    for (const t of dependencyOrder(doc.tasks)) {
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
        maxRetries: t.maxRetries,
        retryPolicy: t.retryPolicy,
        notifications: t.notifications,
        sideEffects: t.sideEffects,
        ...(normalizeTaskToolScope(t.toolScope) ? { toolScope: normalizeTaskToolScope(t.toolScope) } : {}),
        ...(opts.requestedBy ? { requestedBy: opts.requestedBy.toLowerCase() } : {}),
        // what started this run (a trigger's delivery), else what started the mission
        ...((opts.origin ?? mission.origin) ? { origin: opts.origin ?? mission.origin } : {}),
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
    // Decision nodes: a new run decides again
    await this.dropDecisionNodes(group);
    if (doc.decisions && doc.decisions.length > 0) {
      this.decisionsByGroup.set(group, doc.decisions as MissionDecision[]);
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
    // One pass per run (a group and its mission): two missions sharing a name (created before
    // names were unique) are closed separately, each with its own tasks.
    for (const [runKeyValue, groupTasks] of groupByRun(tasks)) {
      const group = groupTasks[0].group!;
      const allTerminal = groupTasks.every(t => t.status === "done" || t.status === "failed");

      // If tasks went back to non-terminal (e.g. individual retry via retryTask),
      // clear the cleaned flag so the group will be re-evaluated when done again.
      if (!allTerminal && this.cleanedGroups.has(runKeyValue)) {
        this.cleanedGroups.delete(runKeyValue);
        continue;
      }

      if (this.cleanedGroups.has(runKeyValue)) continue;
      if (!allTerminal) continue;

      const cleanupPolicy = this.ctx.config.settings.volatileCleanup ?? "on_complete";
      if (cleanupPolicy === "on_complete") {
        await this.agentMgr.cleanupVolatileAgents(group);
      }
      this.cleanedGroups.add(runKeyValue);

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
        // in memory since the run started; after a restart, from the schedule's stored state
        const origin = this.scheduledOrigin.get(group) ?? await this.storedScheduleOrigin(mission);
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
        // and its decision nodes (the decision log keeps the decisions)
        await this.dropDecisionNodes(group);
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
  private async persistMissionData(missionId: string, doc: MissionDocumentParsed, edit: MissionEdit): Promise<Mission> {
    // Re-validate to catch any structural issue before persisting
    parseMissionDocument(doc);
    // The edit rides along (symbol key, never stored) so mission:updated can say what changed.
    const mission = await this.updateMission(missionId, { data: JSON.stringify(doc), [MISSION_EDIT]: edit } as Partial<Mission>);
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
    sideEffects?: boolean;
    /** null clears it (back to the agent's tools). */
    toolScope?: TaskToolScope | null;
  }): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    // Enforce unique title
    if (doc.tasks.some(t => t.title === task.title)) {
      throw new Error(`Task title "${task.title}" already exists in this mission`);
    }
    doc.tasks.push(task as MissionDocumentParsed["tasks"][number]);
    return this.persistMissionData(missionId, doc, { section: "task", action: "added", item: task.title });
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
    sideEffects?: boolean;
    /** null clears it (back to the agent's tools). */
    toolScope?: TaskToolScope | null;
  }): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    const idx = doc.tasks.findIndex(t => t.title === taskTitle);
    if (idx === -1) throw new Error(`Task "${taskTitle}" not found in mission`);
    // If renaming, enforce unique title
    if (updates.title && updates.title !== taskTitle && doc.tasks.some(t => t.title === updates.title)) {
      throw new Error(`Task title "${updates.title}" already exists in this mission`);
    }
    doc.tasks[idx] = { ...doc.tasks[idx], ...updates } as MissionDocumentParsed["tasks"][number];
    if (updates.toolScope === null) delete (doc.tasks[idx] as { toolScope?: unknown }).toolScope;
    // A rename keeps the links to the task: dependsOn of the others and the flow-control lists
    if (updates.title && updates.title !== taskTitle) {
      const rename = (titles: string[]) => titles.map(t => (t === taskTitle ? updates.title! : t));
      for (const t of doc.tasks) if (t.dependsOn) t.dependsOn = rename(t.dependsOn);
      for (const fc of [...(doc.qualityGates ?? []), ...(doc.checkpoints ?? []), ...(doc.delays ?? [])]) {
        fc.afterTasks = rename(fc.afterTasks);
        fc.blocksTasks = rename(fc.blocksTasks);
      }
      for (const d of doc.decisions ?? []) {
        d.afterTasks = rename(d.afterTasks);
        for (const k of Object.keys(d.branches)) d.branches[k] = rename(d.branches[k]);
      }
    }
    return this.persistMissionData(missionId, doc, { section: "task", action: "updated", item: taskTitle });
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
    if (doc.decisions) {
      for (const d of doc.decisions) {
        d.afterTasks = d.afterTasks.filter(t => t !== taskTitle);
        for (const k of Object.keys(d.branches)) d.branches[k] = d.branches[k].filter(t => t !== taskTitle);
      }
      doc.decisions = doc.decisions.filter(d => d.afterTasks.length > 0);
      if (doc.decisions.length === 0) delete (doc as { decisions?: unknown }).decisions;
    }
    // Ensure at least 1 task remains (Zod will catch this, but give a nicer error)
    if (doc.tasks.length === 0) throw new Error("Cannot remove the last task from a mission");
    return this.persistMissionData(missionId, doc, { section: "task", action: "removed", item: taskTitle });
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
    return this.persistMissionData(missionId, doc, { section: "order", action: "reordered", item: undefined });
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
    return this.persistMissionData(missionId, doc, { section: "checkpoint", action: "added", item: checkpoint.name });
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
    return this.persistMissionData(missionId, doc, { section: "checkpoint", action: "updated", item: checkpointName });
  }

  /** Remove a checkpoint from the mission data (by name). */
  async removeMissionCheckpoint(missionId: string, checkpointName: string): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.checkpoints) throw new Error(`Checkpoint "${checkpointName}" not found in mission`);
    const idx = doc.checkpoints.findIndex(c => c.name === checkpointName);
    if (idx === -1) throw new Error(`Checkpoint "${checkpointName}" not found in mission`);
    doc.checkpoints.splice(idx, 1);
    if (doc.checkpoints.length === 0) delete (doc as any).checkpoints;
    return this.persistMissionData(missionId, doc, { section: "checkpoint", action: "removed", item: checkpointName });
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
    return this.persistMissionData(missionId, doc, { section: "delay", action: "added", item: delay.name });
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
    return this.persistMissionData(missionId, doc, { section: "delay", action: "updated", item: delayName });
  }

  /** Remove a delay from the mission data (by name). */
  async removeMissionDelay(missionId: string, delayName: string): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.delays) throw new Error(`Delay "${delayName}" not found in mission`);
    const idx = doc.delays.findIndex(d => d.name === delayName);
    if (idx === -1) throw new Error(`Delay "${delayName}" not found in mission`);
    doc.delays.splice(idx, 1);
    if (doc.delays.length === 0) delete (doc as any).delays;
    return this.persistMissionData(missionId, doc, { section: "delay", action: "removed", item: delayName });
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
    return this.persistMissionData(missionId, doc, { section: "qualityGate", action: "added", item: gate.name });
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
    return this.persistMissionData(missionId, doc, { section: "qualityGate", action: "updated", item: gateName });
  }

  /** Remove a quality gate from the mission data (by name). */
  async removeMissionQualityGate(missionId: string, gateName: string): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc.qualityGates) throw new Error(`Quality gate "${gateName}" not found in mission`);
    const idx = doc.qualityGates.findIndex(g => g.name === gateName);
    if (idx === -1) throw new Error(`Quality gate "${gateName}" not found in mission`);
    doc.qualityGates.splice(idx, 1);
    if (doc.qualityGates.length === 0) delete (doc as any).qualityGates;
    return this.persistMissionData(missionId, doc, { section: "qualityGate", action: "removed", item: gateName });
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
    return this.persistMissionData(missionId, doc, { section: "team", action: "added", item: member.name });
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
    return this.persistMissionData(missionId, doc, { section: "team", action: "updated", item: memberName });
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
    return this.persistMissionData(missionId, doc, { section: "team", action: "removed", item: memberName });
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
    return this.persistMissionData(missionId, doc, { section: "notifications", action: "updated", item: undefined });
  }

  async buildMissionReport(missionId: string, group: string, groupTasks: Task[], allPassed: boolean): Promise<MissionReport> {
    const state = await this.ctx.registry.getState();
    const processes = state?.processes ?? [];

    const allFilesCreated = new Set<string>();
    const allFilesEdited = new Set<string>();
    let totalDuration = 0;
    const scores: number[] = [];
    const allOutcomes: TaskOutcome[] = [];

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

