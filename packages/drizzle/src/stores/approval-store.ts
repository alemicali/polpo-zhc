import { eq } from "drizzle-orm";
import type { ApprovalStore } from "@polpo/core/approval-store";
import type { ApprovalRequest, ApprovalStatus } from "@polpo/core/types";
import { type Dialect, serializeJson, deserializeJson } from "../utils.js";

type AnyTable = any;

export class DrizzleApprovalStore implements ApprovalStore {
  constructor(
    private db: any,
    private approvals: AnyTable,
    private dialect: Dialect,
  ) {}

  private rowToRequest(row: any): ApprovalRequest {
    return {
      id: row.id,
      gateId: row.gateId,
      gateName: row.gateName,
      taskId: row.taskId ?? undefined,
      missionId: row.missionId ?? undefined,
      status: row.status as ApprovalStatus,
      payload: deserializeJson(row.payload, undefined, this.dialect),
      requestedAt: row.requestedAt,
      resolvedAt: row.resolvedAt ?? undefined,
      resolvedBy: row.resolvedBy ?? undefined,
      note: row.note ?? undefined,
    };
  }

  async upsert(request: ApprovalRequest): Promise<void> {
    const values = {
      id: request.id,
      gateId: request.gateId,
      gateName: request.gateName,
      taskId: request.taskId ?? null,
      missionId: request.missionId ?? null,
      status: request.status,
      payload: serializeJson(request.payload, this.dialect),
      requestedAt: request.requestedAt,
      resolvedAt: request.resolvedAt ?? null,
      resolvedBy: request.resolvedBy ?? null,
      note: request.note ?? null,
    };
    await this.db.insert(this.approvals).values(values)
      .onConflictDoUpdate({
        target: this.approvals.id,
        set: {
          status: values.status,
          payload: values.payload,
          resolvedAt: values.resolvedAt,
          resolvedBy: values.resolvedBy,
          note: values.note,
        },
      });
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    const rows: any[] = await this.db.select().from(this.approvals)
      .where(eq(this.approvals.id, id));
    return rows.length > 0 ? this.rowToRequest(rows[0]) : undefined;
  }

  async list(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    let q = this.db.select().from(this.approvals);
    if (status) q = q.where(eq(this.approvals.status, status));
    const rows: any[] = await q;
    return rows.map((r) => this.rowToRequest(r));
  }

  async listByTask(taskId: string): Promise<ApprovalRequest[]> {
    const rows: any[] = await this.db.select().from(this.approvals)
      .where(eq(this.approvals.taskId, taskId));
    return rows.map((r) => this.rowToRequest(r));
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(this.approvals)
      .where(eq(this.approvals.id, id));
    return (result?.rowCount ?? result?.changes ?? 0) > 0;
  }

  async close(): Promise<void> {}
}
