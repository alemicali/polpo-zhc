import type { ApprovalRequest, ApprovalStatus } from "./types.js";

/**
 * Persistent store for approval requests.
 */
export interface ApprovalStore {
  /** Save or update an approval request. */
  upsert(request: ApprovalRequest): void;
  /** Get a request by ID. */
  get(id: string): ApprovalRequest | undefined;
  /** List all requests, optionally filtered by status. */
  list(status?: ApprovalStatus): ApprovalRequest[];
  /** List pending requests for a specific task. */
  listByTask(taskId: string): ApprovalRequest[];
  /** Delete a request by ID. */
  delete(id: string): boolean;
  /** Close the store (cleanup). */
  close?(): void;
}
