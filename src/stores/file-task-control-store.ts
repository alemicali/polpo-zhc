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

  constructor(polpoDir: string) {
    const root = join(polpoDir, "task-control");
    this.directionsDir = join(root, "directions");
    this.checkpointsDir = join(root, "checkpoints");
    mkdirSync(this.directionsDir, { recursive: true });
    mkdirSync(this.checkpointsDir, { recursive: true });
  }

  private directionPath(id: string): string {
    return join(this.directionsDir, `${id}.json`);
  }

  private checkpointPath(taskId: string): string {
    return join(this.checkpointsDir, `${encodeURIComponent(taskId)}.json`);
  }

  private readDirections(): TaskDirection[] {
    if (!existsSync(this.directionsDir)) return [];
    return readdirSync(this.directionsDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJson<TaskDirection>(join(this.directionsDir, file)))
      .filter((item): item is TaskDirection => item !== undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
}
