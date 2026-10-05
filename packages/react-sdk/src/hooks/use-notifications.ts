import { useState, useEffect, useCallback, useRef } from "react";
import { usePolpo } from "./use-polpo.js";
import { useEvents } from "./use-events.js";
import { useStableValue } from "./use-stable-value.js";
import type {
  NotificationRecord,
  NotificationStats,
  SendNotificationRequest,
  SendNotificationResult,
} from "@polpo-ai/sdk";

export interface UseNotificationsReturn {
  notifications: NotificationRecord[];
  stats: NotificationStats | null;
  sendNotification: (req: SendNotificationRequest) => Promise<SendNotificationResult>;
  refetch: () => void;
  loading: boolean;
}

/**
 * Hook for notification history, stats, and direct send.
 *
 * @param opts.limit - Max records to fetch (default 100)
 * @param opts.status - Filter by status ("sent" | "failed")
 * @param opts.channel - Filter by channel ID
 */
export function useNotifications(opts?: {
  limit?: number;
  status?: string;
  channel?: string;
}): UseNotificationsReturn {
  const { client } = usePolpo();
  const { events } = useEvents(["notification:sent", "notification:failed"], 1);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [stats, setStats] = useState<NotificationStats | null>(null);
  const [loading, setLoading] = useState(true);

  const stableOpts = useStableValue(opts);

  const refetch = useCallback(() => {
    if (!client) return;
    setLoading(true);
    Promise.all([
      client.getNotifications(stableOpts),
      client.getNotificationStats(),
    ])
      .then(([records, s]) => {
        setNotifications(records);
        setStats(s);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [client, stableOpts]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const latestEventId = events.at(-1)?.id;
  const handledEventRef = useRef(latestEventId);
  useEffect(() => {
    if (!latestEventId || handledEventRef.current === latestEventId) return;
    handledEventRef.current = latestEventId;
    refetch();
  }, [latestEventId, refetch]);

  const sendNotification = useCallback(
    async (req: SendNotificationRequest) => {
      if (!client) throw new Error("Client not initialized");
      const result = await client.sendNotification(req);
      // Refetch after send
      refetch();
      return result;
    },
    [client, refetch],
  );

  return { notifications, stats, sendNotification, refetch, loading };
}
