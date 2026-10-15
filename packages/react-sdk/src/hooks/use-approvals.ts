import { useState, useEffect, useCallback, useRef } from "react";
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

  // isLoading covers the first load only: refetches on every approval event keep the current
  // list on screen instead of blanking the page (and its counters) until the answer arrives.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .getApprovals(status)
      .then((list) => { if (!cancelled) setApprovals(list); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [client, status, fetchCount]);

  // Auto-refetch when new approval events arrive
  const latestEventId = approvalEvents.at(-1)?.id;
  const handledEventRef = useRef(latestEventId);
  useEffect(() => {
    if (!latestEventId || handledEventRef.current === latestEventId) return;
    handledEventRef.current = latestEventId;
    refetch();
  }, [latestEventId, refetch]);

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
