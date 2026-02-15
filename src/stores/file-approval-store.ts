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

  upsert(request: ApprovalRequest): void {
    this.requests.set(request.id, request);
    this.save();
  }

  get(id: string): ApprovalRequest | undefined {
    return this.requests.get(id);
  }

  list(status?: ApprovalStatus): ApprovalRequest[] {
    const all = [...this.requests.values()];
    if (status) return all.filter(r => r.status === status);
    return all;
  }

  listByTask(taskId: string): ApprovalRequest[] {
    return [...this.requests.values()].filter(r => r.taskId === taskId);
  }

  delete(id: string): boolean {
    const had = this.requests.delete(id);
    if (had) this.save();
    return had;
  }

  close(): void {
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
