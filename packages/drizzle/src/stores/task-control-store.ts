import { and, desc, eq, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  AgentConversationCheckpoint,
  BackgroundWait,
  TaskControlStore,
  TaskDirection,
} from "@polpo-ai/core";
import { type Dialect, deserializeJson, serializeJson } from "../utils.js";

type AnyTable = any;

export class DrizzleTaskControlStore implements TaskControlStore {
  constructor(
    private readonly db: any,
    private readonly directions: AnyTable,
    private readonly checkpoints: AnyTable,
    private readonly backgroundWaits: AnyTable,
    private readonly dialect: Dialect,
  ) {}

  private rowToDirection(row: any): TaskDirection {
    return {
      id: row.id,
      taskId: row.taskId,
      runId: row.runId ?? undefined,
      mode: row.mode,
      message: row.message,
      status: row.status,
      createdAt: row.createdAt,
      deliveredAt: row.deliveredAt ?? undefined,
      appliedAt: row.appliedAt ?? undefined,
      error: row.error ?? undefined,
    };
  }

  private rowToBackgroundWait(row: any): BackgroundWait {
    return {
      id: row.id,
      taskId: row.taskId,
      sessionId: row.sessionId,
      targetStatus: row.targetStatus ?? undefined,
      state: row.state,
      lastTaskStatus: row.lastTaskStatus ?? undefined,
      attempts: row.attempts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      triggeredAt: row.triggeredAt ?? undefined,
      completedAt: row.completedAt ?? undefined,
      error: row.error ?? undefined,
    };
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
    await this.db.insert(this.directions).values({ ...direction, runId: direction.runId ?? null });
    return direction;
  }

  async claimDirections(taskId: string, runId: string): Promise<TaskDirection[]> {
    const candidates: any[] = await this.db.select().from(this.directions)
      .where(and(
        eq(this.directions.taskId, taskId),
        eq(this.directions.status, "queued"),
        or(isNull(this.directions.runId), eq(this.directions.runId, runId)),
      ))
      .orderBy(this.directions.createdAt);

    const claimed: TaskDirection[] = [];
    for (const candidate of candidates) {
      const deliveredAt = new Date().toISOString();
      const rows: any[] = await this.db.update(this.directions)
        .set({ runId, status: "delivered", deliveredAt })
        .where(and(eq(this.directions.id, candidate.id), eq(this.directions.status, "queued")))
        .returning();
      if (rows.length > 0) claimed.push(this.rowToDirection(rows[0]));
    }
    return claimed;
  }

  async markDirectionApplied(id: string): Promise<void> {
    await this.db.update(this.directions).set({
      status: "applied",
      appliedAt: new Date().toISOString(),
      error: null,
    }).where(eq(this.directions.id, id));
  }

  async failDirection(id: string, error: string): Promise<void> {
    await this.db.update(this.directions).set({ status: "failed", error })
      .where(eq(this.directions.id, id));
  }

  async requeueDirection(id: string): Promise<void> {
    await this.db.update(this.directions).set({
      runId: null,
      status: "queued",
      deliveredAt: null,
      appliedAt: null,
      error: null,
    }).where(eq(this.directions.id, id));
  }

  async listDirections(taskId: string): Promise<TaskDirection[]> {
    const rows: any[] = await this.db.select().from(this.directions)
      .where(eq(this.directions.taskId, taskId))
      .orderBy(this.directions.createdAt);
    return rows.map((row) => this.rowToDirection(row));
  }

  async saveCheckpoint(checkpoint: AgentConversationCheckpoint): Promise<void> {
    const values = {
      taskId: checkpoint.taskId,
      runId: checkpoint.runId,
      messages: serializeJson(checkpoint.messages, this.dialect),
      savedAt: checkpoint.savedAt,
      turnCount: checkpoint.turnCount,
    };
    await this.db.insert(this.checkpoints).values(values)
      .onConflictDoUpdate({
        target: this.checkpoints.taskId,
        set: {
          runId: values.runId,
          messages: values.messages,
          savedAt: values.savedAt,
          turnCount: values.turnCount,
        },
      });
  }

  async getCheckpoint(taskId: string): Promise<AgentConversationCheckpoint | undefined> {
    const rows: any[] = await this.db.select().from(this.checkpoints)
      .where(eq(this.checkpoints.taskId, taskId));
    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      taskId: row.taskId,
      runId: row.runId,
      messages: deserializeJson<unknown[]>(row.messages, [], this.dialect),
      savedAt: row.savedAt,
      turnCount: row.turnCount,
    };
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
    await this.db.insert(this.backgroundWaits).values({
      ...wait,
      targetStatus: wait.targetStatus ?? null,
    });
    return wait;
  }

  async getBackgroundWait(id: string): Promise<BackgroundWait | undefined> {
    const rows: any[] = await this.db.select().from(this.backgroundWaits)
      .where(eq(this.backgroundWaits.id, id));
    return rows[0] ? this.rowToBackgroundWait(rows[0]) : undefined;
  }

  async listBackgroundWaits(sessionId?: string): Promise<BackgroundWait[]> {
    const query = this.db.select().from(this.backgroundWaits);
    const rows: any[] = sessionId
      ? await query.where(eq(this.backgroundWaits.sessionId, sessionId)).orderBy(desc(this.backgroundWaits.createdAt))
      : await query.orderBy(desc(this.backgroundWaits.createdAt));
    return rows.map((row) => this.rowToBackgroundWait(row));
  }

  async markBackgroundWaitReady(id: string, taskStatus: string): Promise<boolean> {
    const now = new Date().toISOString();
    const rows: any[] = await this.db.update(this.backgroundWaits).set({
      state: "ready",
      lastTaskStatus: taskStatus,
      triggeredAt: now,
      updatedAt: now,
      error: null,
    }).where(and(eq(this.backgroundWaits.id, id), eq(this.backgroundWaits.state, "waiting"))).returning();
    return rows.length > 0;
  }

  async claimBackgroundWait(id: string): Promise<BackgroundWait | undefined> {
    const current = await this.getBackgroundWait(id);
    if (!current || current.state !== "ready") return undefined;
    const rows: any[] = await this.db.update(this.backgroundWaits).set({
      state: "running",
      attempts: current.attempts + 1,
      updatedAt: new Date().toISOString(),
      error: null,
    }).where(and(eq(this.backgroundWaits.id, id), eq(this.backgroundWaits.state, "ready"))).returning();
    return rows[0] ? this.rowToBackgroundWait(rows[0]) : undefined;
  }

  async completeBackgroundWait(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.update(this.backgroundWaits).set({ state: "completed", updatedAt: now, completedAt: now })
      .where(and(eq(this.backgroundWaits.id, id), eq(this.backgroundWaits.state, "running")));
  }

  async failBackgroundWait(id: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.update(this.backgroundWaits).set({ state: "failed", error, updatedAt: now, completedAt: now })
      .where(and(
        eq(this.backgroundWaits.id, id),
        or(
          eq(this.backgroundWaits.state, "waiting"),
          eq(this.backgroundWaits.state, "ready"),
          eq(this.backgroundWaits.state, "running"),
        ),
      ));
  }

  async requeueBackgroundWait(id: string): Promise<void> {
    await this.db.update(this.backgroundWaits).set({
      state: "ready",
      updatedAt: new Date().toISOString(),
      error: null,
    }).where(and(eq(this.backgroundWaits.id, id), eq(this.backgroundWaits.state, "running")));
  }

  async cancelBackgroundWait(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const rows: any[] = await this.db.update(this.backgroundWaits).set({
      state: "cancelled",
      updatedAt: now,
      completedAt: now,
    }).where(and(
      eq(this.backgroundWaits.id, id),
      or(
        eq(this.backgroundWaits.state, "waiting"),
        eq(this.backgroundWaits.state, "ready"),
        eq(this.backgroundWaits.state, "running"),
      ),
    )).returning();
    return rows.length > 0;
  }

  async recoverBackgroundWaits(): Promise<number> {
    const rows: any[] = await this.db.update(this.backgroundWaits).set({
      state: "ready",
      updatedAt: new Date().toISOString(),
    }).where(eq(this.backgroundWaits.state, "running")).returning();
    return rows.length;
  }
}
