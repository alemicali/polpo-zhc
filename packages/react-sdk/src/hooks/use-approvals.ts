import { useState, useEffect, useCallback } from "react";
import { usePolpo } from "./use-polpo.js";
import { useEvents } from "./use-events.js";
import { useMutation } from "./use-mutation.js";
import type { ApprovalRequest, ApprovalStatus } from "@polpo-ai/sdk";

export interface UseApprovalsReturn {
  approvals: ApprovalRequest[];
  pending: ApprovalRequest[];
  approve: (requestId: string, opts?: { resolvedBy?: string; note?: string }) => Promise<void>;
  isApproving: boolean;
  reject: (requestId: string, feedback: string, resolvedBy?: string) => Promise<void>;
  isRejecting: boolean;
  refetch: () => void;
  isLoading: boolean;
  /** @deprecated Use `isLoading` instead. */
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
  const [isLoading, setIsLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);

  // Watch for approval SSE events to trigger refetch
  const { events: approvalEvents } = useEvents(APPROVAL_EVENTS, 1);

  const refetch = useCallback(() => {
    setFetchCount((c) => c + 1);
  }, []);

  useEffect(() => {
    if (!client) return;
    setIsLoading(true);
    client
      .getApprovals(status)
      .then(setApprovals)
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [client, status, fetchCount]);

  // Auto-refetch when new approval events arrive
  useEffect(() => {
    if (approvalEvents.length > 0) {
      refetch();
    }
  }, [approvalEvents.length, refetch]);

  const pending = approvals.filter((a) => a.status === "pending");

  const { mutate: approve, isPending: isApproving } = useMutation(
    useCallback(
      async (requestId: string, opts?: { resolvedBy?: string; note?: string }) => {
        if (!client) throw new Error("Client not initialized");
        await client.approveRequest(requestId, opts);
        refetch();
      },
      [client, refetch],
    ),
  );

  const { mutate: reject, isPending: isRejecting } = useMutation(
    useCallback(
      async (requestId: string, feedback: string, resolvedBy?: string) => {
        if (!client) throw new Error("Client not initialized");
        await client.rejectRequest(requestId, feedback, resolvedBy);
        refetch();
      },
      [client, refetch],
    ),
  );

  return { approvals, pending, approve, isApproving, reject, isRejecting, refetch, isLoading, loading: isLoading };
}
