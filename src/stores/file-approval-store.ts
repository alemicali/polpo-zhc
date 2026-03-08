import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalStore } from "../core/approval-store.js";
import type { ApprovalRequest, ApprovalStatus } from "../core/types.js";

/**
 * Filesystem-based approval store.
 * Persists approval requests as JSON in .polpo/approvals.json.
 */
export class FileApprovalStore implements ApprovalStore {
  private filePath: string;
  private requests: Map<string, ApprovalRequest>;

  constructor(polpoDir: string) {
    if (!existsSync(polpoDir)) {
      mkdirSync(polpoDir, { recursive: true });
    }
    this.filePath = join(polpoDir, "approvals.json");
    this.requests = new Map();
    this.load();
  }

  async upsert(request: ApprovalRequest): Promise<void> {
    this.requests.set(request.id, request);
    this.save();
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    return this.requests.get(id);
  }

  async list(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    const all = [...this.requests.values()];
    if (status) return all.filter(r => r.status === status);
    return all;
  }

  async listByTask(taskId: string): Promise<ApprovalRequest[]> {
    return [...this.requests.values()].filter(r => r.taskId === taskId);
  }

  async delete(id: string): Promise<boolean> {
    const had = this.requests.delete(id);
    if (had) this.save();
    return had;
  }

  async close(): Promise<void> {
    this.save();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const arr: ApprovalRequest[] = JSON.parse(raw);
        for (const r of arr) {
          this.requests.set(r.id, r);
        }
      }
    } catch { /* corrupted file — start fresh */ }
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify([...this.requests.values()], null, 2));
    } catch { /* best-effort */ }
  }
}
