import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type {
  AgentConversationCheckpoint,
  BackgroundWait,
  TaskControlStore,
  TaskDirection,
} from "../core/task-control-store.js";

function atomicWrite(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${nanoid(6)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

export class FileTaskControlStore implements TaskControlStore {
  private readonly directionsDir: string;
  private readonly checkpointsDir: string;
  private readonly backgroundWaitsDir: string;

  constructor(polpoDir: string) {
    const root = join(polpoDir, "task-control");
    this.directionsDir = join(root, "directions");
    this.checkpointsDir = join(root, "checkpoints");
    this.backgroundWaitsDir = join(root, "background-waits");
    mkdirSync(this.directionsDir, { recursive: true });
    mkdirSync(this.checkpointsDir, { recursive: true });
    mkdirSync(this.backgroundWaitsDir, { recursive: true });
  }

  private directionPath(id: string): string {
    return join(this.directionsDir, `${id}.json`);
  }

  private checkpointPath(taskId: string): string {
    return join(this.checkpointsDir, `${encodeURIComponent(taskId)}.json`);
  }

  private backgroundWaitPath(id: string): string {
    return join(this.backgroundWaitsDir, `${encodeURIComponent(id)}.json`);
  }

  private readDirections(): TaskDirection[] {
    if (!existsSync(this.directionsDir)) return [];
    return readdirSync(this.directionsDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJson<TaskDirection>(join(this.directionsDir, file)))
      .filter((item): item is TaskDirection => item !== undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private readBackgroundWaits(): BackgroundWait[] {
    if (!existsSync(this.backgroundWaitsDir)) return [];
    return readdirSync(this.backgroundWaitsDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJson<BackgroundWait>(join(this.backgroundWaitsDir, file)))
      .filter((item): item is BackgroundWait => item !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async enqueueDirection(input: {
    taskId: string;
    runId?: string;
    mode: TaskDirection["mode"];
    message: string;
  }): Promise<TaskDirection> {
    const direction: TaskDirection = {
      id: nanoid(),
      taskId: input.taskId,
      runId: input.runId,
      mode: input.mode,
      message: input.message,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    atomicWrite(this.directionPath(direction.id), direction);
    return direction;
  }

  async claimDirections(taskId: string, runId: string): Promise<TaskDirection[]> {
    const claimed: TaskDirection[] = [];
    for (const direction of this.readDirections()) {
      if (direction.taskId !== taskId || direction.status !== "queued") continue;
      if (direction.runId && direction.runId !== runId) continue;

      const next: TaskDirection = {
        ...direction,
        runId,
        status: "delivered",
        deliveredAt: new Date().toISOString(),
      };
      atomicWrite(this.directionPath(next.id), next);
      claimed.push(next);
    }
    return claimed;
  }

  async markDirectionApplied(id: string): Promise<void> {
    const path = this.directionPath(id);
    const direction = readJson<TaskDirection>(path);
    if (!direction) return;
    atomicWrite(path, {
      ...direction,
      status: "applied",
      appliedAt: new Date().toISOString(),
      error: undefined,
    });
  }

  async failDirection(id: string, error: string): Promise<void> {
    const path = this.directionPath(id);
    const direction = readJson<TaskDirection>(path);
    if (!direction) return;
    atomicWrite(path, { ...direction, status: "failed", error });
  }

  async requeueDirection(id: string): Promise<void> {
    const path = this.directionPath(id);
    const direction = readJson<TaskDirection>(path);
    if (!direction) return;
    atomicWrite(path, {
      ...direction,
      runId: undefined,
      status: "queued",
      deliveredAt: undefined,
      appliedAt: undefined,
      error: undefined,
    });
  }

  async listDirections(taskId: string): Promise<TaskDirection[]> {
    return this.readDirections().filter((item) => item.taskId === taskId);
  }

  async saveCheckpoint(checkpoint: AgentConversationCheckpoint): Promise<void> {
    atomicWrite(this.checkpointPath(checkpoint.taskId), checkpoint);
  }

  async getCheckpoint(taskId: string): Promise<AgentConversationCheckpoint | undefined> {
    return readJson<AgentConversationCheckpoint>(this.checkpointPath(taskId));
  }

  async createBackgroundWait(input: {
    taskId: string;
    sessionId: string;
    targetStatus?: string;
  }): Promise<BackgroundWait> {
    const now = new Date().toISOString();
    const wait: BackgroundWait = {
      id: nanoid(),
      taskId: input.taskId,
      sessionId: input.sessionId,
      targetStatus: input.targetStatus,
      state: "waiting",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    atomicWrite(this.backgroundWaitPath(wait.id), wait);
    return wait;
  }

  async getBackgroundWait(id: string): Promise<BackgroundWait | undefined> {
    return readJson<BackgroundWait>(this.backgroundWaitPath(id));
  }

  async listBackgroundWaits(sessionId?: string): Promise<BackgroundWait[]> {
    const waits = this.readBackgroundWaits();
    return sessionId ? waits.filter((wait) => wait.sessionId === sessionId) : waits;
  }

  async markBackgroundWaitReady(id: string, taskStatus: string): Promise<boolean> {
    const path = this.backgroundWaitPath(id);
    const wait = readJson<BackgroundWait>(path);
    if (!wait || wait.state !== "waiting") return false;
    const now = new Date().toISOString();
    atomicWrite(path, {
      ...wait,
      state: "ready",
      lastTaskStatus: taskStatus,
      triggeredAt: now,
      updatedAt: now,
      error: undefined,
    });
    return true;
  }

  async claimBackgroundWait(id: string): Promise<BackgroundWait | undefined> {
    const path = this.backgroundWaitPath(id);
    const wait = readJson<BackgroundWait>(path);
    if (!wait || wait.state !== "ready") return undefined;
    const claimed: BackgroundWait = {
      ...wait,
      state: "running",
      attempts: wait.attempts + 1,
      updatedAt: new Date().toISOString(),
      error: undefined,
    };
    atomicWrite(path, claimed);
    return claimed;
  }

  async completeBackgroundWait(id: string): Promise<void> {
    const path = this.backgroundWaitPath(id);
    const wait = readJson<BackgroundWait>(path);
    if (!wait || wait.state !== "running") return;
    const now = new Date().toISOString();
    atomicWrite(path, { ...wait, state: "completed", updatedAt: now, completedAt: now });
  }

  async failBackgroundWait(id: string, error: string): Promise<void> {
    const path = this.backgroundWaitPath(id);
    const wait = readJson<BackgroundWait>(path);
    if (!wait || wait.state === "completed" || wait.state === "cancelled") return;
    const now = new Date().toISOString();
    atomicWrite(path, { ...wait, state: "failed", error, updatedAt: now, completedAt: now });
  }

  async requeueBackgroundWait(id: string): Promise<void> {
    const path = this.backgroundWaitPath(id);
    const wait = readJson<BackgroundWait>(path);
    if (!wait || wait.state !== "running") return;
    atomicWrite(path, {
      ...wait,
      state: "ready",
      updatedAt: new Date().toISOString(),
      error: undefined,
    });
  }

  async cancelBackgroundWait(id: string): Promise<boolean> {
    const path = this.backgroundWaitPath(id);
    const wait = readJson<BackgroundWait>(path);
    if (!wait || ["completed", "failed", "cancelled"].includes(wait.state)) return false;
    const now = new Date().toISOString();
    atomicWrite(path, { ...wait, state: "cancelled", updatedAt: now, completedAt: now });
    return true;
  }

  async recoverBackgroundWaits(): Promise<number> {
    let recovered = 0;
    for (const wait of this.readBackgroundWaits()) {
      if (wait.state !== "running") continue;
      atomicWrite(this.backgroundWaitPath(wait.id), {
        ...wait,
        state: "ready",
        updatedAt: new Date().toISOString(),
      });
      recovered += 1;
    }
    return recovered;
  }
}
