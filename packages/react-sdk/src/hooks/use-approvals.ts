import { useState, useEffect, useCallback } from "react";
import { usePolpo } from "./use-polpo.js";
import { useEvents } from "./use-events.js";
import type { ApprovalRequest, ApprovalStatus } from "@polpo-ai/client";

export interface UseApprovalsReturn {
  approvals: ApprovalRequest[];
  pending: ApprovalRequest[];
  approve: (requestId: string, opts?: { resolvedBy?: string; note?: string }) => Promise<void>;
  reject: (requestId: string, feedback: string, resolvedBy?: string) => Promise<void>;
  refetch: () => void;
  loading: boolean;
}

const APPROVAL_EVENTS = ["approval:requested", "approval:resolved", "approval:rejected", "approval:timeout"];

/**
 * Hook for managing approval gates.
 *
 * Auto-refetches when SSE approval events arrive.
 */
export function useApprovals(status?: ApprovalStatus): UseApprovalsReturn {
  const { client } = usePolpo();
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);

  // Watch for approval SSE events to trigger refetch
  const { events: approvalEvents } = useEvents(APPROVAL_EVENTS, 1);

  const refetch = useCallback(() => {
    setFetchCount((c) => c + 1);
  }, []);

  useEffect(() => {
    if (!client) return;
    setLoading(true);
    client
      .getApprovals(status)
      .then(setApprovals)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [client, status, fetchCount]);

  // Auto-refetch when new approval events arrive
  useEffect(() => {
    if (approvalEvents.length > 0) {
      refetch();
    }
  }, [approvalEvents.length, refetch]);

  const pending = approvals.filter((a) => a.status === "pending");

  const approve = useCallback(
    async (requestId: string, opts?: { resolvedBy?: string; note?: string }) => {
      if (!client) throw new Error("Client not initialized");
      await client.approveRequest(requestId, opts);
      refetch();
    },
    [client, refetch],
  );

  const reject = useCallback(
    async (requestId: string, feedback: string, resolvedBy?: string) => {
      if (!client) throw new Error("Client not initialized");
      await client.rejectRequest(requestId, feedback, resolvedBy);
      refetch();
    },
    [client, refetch],
  );

  return { approvals, pending, approve, reject, refetch, loading };
}
