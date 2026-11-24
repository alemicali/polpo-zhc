import { memo, useCallback, useEffect, useState } from "react";
import { useEvents, usePolpo } from "@polpo-ai/react";

/** Lightweight pending-approval counter — fetches directly from client to avoid
 *  the useApprovals → useEvents → useSyncExternalStore re-render loop. */
const APPROVAL_EVENTS = ["approval:requested", "approval:resolved", "approval:rejected", "approval:timeout"];

export const PendingBadge = memo(function PendingBadge({ collapsed }: { collapsed: boolean }) {
  const { client, connectionStatus } = usePolpo();
  const { events } = useEvents(APPROVAL_EVENTS, 1);
  const [count, setCount] = useState(0);

  const fetchCount = useCallback(() => {
    if (!client) return;
    client.getApprovals("pending")
      .then((list: unknown[]) => setCount(list.length))
      .catch(() => {});
  }, [client]);

  useEffect(() => {
    if (connectionStatus !== "connected") return;
    fetchCount();
    const recover = () => {
      if (document.visibilityState === "visible") fetchCount();
    };
    const id = window.setInterval(recover, 120_000);
    document.addEventListener("visibilitychange", recover);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [connectionStatus, fetchCount]);

  const latestEventId = events.at(-1)?.id;
  useEffect(() => {
    if (latestEventId) fetchCount();
  }, [fetchCount, latestEventId]);

  if (count === 0) return null;

  return collapsed ? (
    <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-pill bg-warning text-micro font-bold text-warning-foreground px-1">
      {count}
    </span>
  ) : (
    <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-pill bg-warning text-micro font-bold text-warning-foreground px-1.5">
      {count}
    </span>
  );
});
