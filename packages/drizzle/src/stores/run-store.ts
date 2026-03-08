import { eq, desc, inArray } from "drizzle-orm";
import type { RunStore, RunRecord, RunStatus } from "@polpo/core/run-store";
import type { AgentActivity, TaskResult, TaskOutcome } from "@polpo/core/types";
import { type Dialect, serializeJson, deserializeJson } from "../utils.js";

type AnyTable = any;

const TERMINAL_STATUSES: RunStatus[] = ["completed", "failed", "killed"];

export class DrizzleRunStore implements RunStore {
  constructor(
    private db: any,
    private runs: AnyTable,
    private dialect: Dialect,
  ) {}

  private rowToRecord(row: any): RunRecord {
    const d = this.dialect;
    const activity = deserializeJson<AgentActivity>(row.activity, {
      filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: "",
    }, d);

    return {
      id: row.id,
      taskId: row.taskId,
      pid: row.pid,
      agentName: row.agentName,
      sessionId: row.sessionId ?? activity.sessionId,
      status: row.status as RunStatus,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      activity,
      result: deserializeJson<TaskResult | undefined>(row.result, undefined, d),
      outcomes: deserializeJson<TaskOutcome[] | undefined>(row.outcomes, undefined, d),
      configPath: row.configPath,
    };
  }

  async upsertRun(run: RunRecord): Promise<void> {
    const d = this.dialect;
    const values = {
      id: run.id,
      taskId: run.taskId,
      pid: run.pid,
      agentName: run.agentName,
      adapterType: "sdk",
      sessionId: run.sessionId ?? null,
      status: run.status,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      activity: serializeJson(run.activity, d),
      result: serializeJson(run.result, d),
      outcomes: serializeJson(run.outcomes, d),
      configPath: run.configPath,
    };
    await this.db.insert(this.runs).values(values)
      .onConflictDoUpdate({
        target: this.runs.id,
        set: {
          pid: values.pid,
          sessionId: values.sessionId,
          status: values.status,
          updatedAt: values.updatedAt,
          activity: values.activity,
          result: values.result,
          outcomes: values.outcomes,
        },
      });
  }

  async updateActivity(runId: string, activity: AgentActivity): Promise<void> {
    const now = new Date().toISOString();
    await this.db.update(this.runs).set({
      activity: serializeJson(activity, this.dialect),
      sessionId: activity.sessionId ?? null,
      updatedAt: now,
    }).where(eq(this.runs.id, runId));
  }

  async updateOutcomes(runId: string, outcomes: TaskOutcome[]): Promise<void> {
    await this.db.update(this.runs).set({
      outcomes: serializeJson(outcomes, this.dialect),
      updatedAt: new Date().toISOString(),
    }).where(eq(this.runs.id, runId));
  }

  async completeRun(runId: string, status: RunStatus, result: TaskResult): Promise<void> {
    // Race-condition guard: don't overwrite terminal states
    const rows: any[] = await this.db.select({ status: this.runs.status })
      .from(this.runs).where(eq(this.runs.id, runId));
    if (rows.length > 0 && TERMINAL_STATUSES.includes(rows[0].status as RunStatus)) {
      return;
    }

    await this.db.update(this.runs).set({
      status,
      result: serializeJson(result, this.dialect),
      updatedAt: new Date().toISOString(),
    }).where(eq(this.runs.id, runId));
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const rows: any[] = await this.db.select().from(this.runs)
      .where(eq(this.runs.id, runId));
    return rows.length > 0 ? this.rowToRecord(rows[0]) : undefined;
  }

  async getRunByTaskId(taskId: string): Promise<RunRecord | undefined> {
    const rows: any[] = await this.db.select().from(this.runs)
      .where(eq(this.runs.taskId, taskId))
      .orderBy(desc(this.runs.startedAt))
      .limit(1);
    return rows.length > 0 ? this.rowToRecord(rows[0]) : undefined;
  }

  async getActiveRuns(): Promise<RunRecord[]> {
    const rows: any[] = await this.db.select().from(this.runs)
      .where(eq(this.runs.status, "running"));
    return rows.map((r) => this.rowToRecord(r));
  }

  async getTerminalRuns(): Promise<RunRecord[]> {
    const rows: any[] = await this.db.select().from(this.runs)
      .where(inArray(this.runs.status, TERMINAL_STATUSES));
    return rows.map((r) => this.rowToRecord(r));
  }

  async deleteRun(runId: string): Promise<void> {
    await this.db.delete(this.runs).where(eq(this.runs.id, runId));
  }

  async close(): Promise<void> {
    // Connection lifecycle managed externally
  }
}
