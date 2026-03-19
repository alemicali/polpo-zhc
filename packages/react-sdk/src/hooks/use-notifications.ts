import { useState, useEffect, useCallback } from "react";
import { usePolpo } from "./use-polpo.js";
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
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [stats, setStats] = useState<NotificationStats | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    if (!client) return;
    setLoading(true);
    Promise.all([
      client.getNotifications(opts),
      client.getNotificationStats(),
    ])
      .then(([records, s]) => {
        setNotifications(records);
        setStats(s);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [client, opts?.limit, opts?.status, opts?.channel]);

  useEffect(() => {
    refetch();
  }, [refetch]);

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
