import type { ApprovalRequest, ApprovalStatus } from "./types.js";

/**
 * Persistent store for approval requests.
 */
export interface ApprovalStore {
  /** Save or update an approval request. */
  upsert(request: ApprovalRequest): Promise<void>;
  /** Get a request by ID. */
  get(id: string): Promise<ApprovalRequest | undefined>;
  /** List all requests, optionally filtered by status. */
  list(status?: ApprovalStatus): Promise<ApprovalRequest[]>;
  /** List pending requests for a specific task. */
  listByTask(taskId: string): Promise<ApprovalRequest[]>;
  /** Delete a request by ID. */
  delete(id: string): Promise<boolean>;
  /** Close the store (cleanup). */
  close?(): Promise<void> | void;
}
