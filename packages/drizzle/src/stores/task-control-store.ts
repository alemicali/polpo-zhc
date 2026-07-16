import { and, eq, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  AgentConversationCheckpoint,
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
}
