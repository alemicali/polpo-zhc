import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEvents } from "@polpo-ai/react";
import { apiUrl, config } from "@/lib/config";

export type BackgroundWaitState = "waiting" | "ready" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundWait {
  id: string;
  taskId: string;
  sessionId: string;
  targetStatus?: string;
  state: BackgroundWaitState;
  lastTaskStatus?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

function headers(): HeadersInit {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

export function useBackgroundWaits(sessionId?: string | null) {
  const { events } = useEvents([
    "background-wait:created",
    "background-wait:ready",
    "background-wait:running",
    "background-wait:completed",
    "background-wait:failed",
    "background-wait:cancelled",
  ], 1);
  const [waits, setWaits] = useState<BackgroundWait[]>([]);
  const [loading, setLoading] = useState(true);
  const normalizedSessionId = sessionId?.trim() || null;
  const currentSessionIdRef = useRef(normalizedSessionId);
  const requestIdRef = useRef(0);
  currentSessionIdRef.current = normalizedSessionId;

  const refresh = useCallback(async () => {
    if (!normalizedSessionId) {
      setWaits([]);
      setLoading(false);
      return;
    }

    const requestedSessionId = normalizedSessionId;
    const requestId = ++requestIdRef.current;
    try {
      const response = await fetch(apiUrl(`/api/v1/background-waits?sessionId=${encodeURIComponent(requestedSessionId)}`), {
        headers: headers(),
        credentials: "include",
        cache: "no-store",
      });
      const payload = await response.json();
      if (requestId === requestIdRef.current && currentSessionIdRef.current === requestedSessionId && response.ok && payload.ok) {
        setWaits(payload.data);
      }
    } catch {
      // SSE or the next recovery poll will retry without disturbing current data.
    } finally {
      if (requestId === requestIdRef.current && currentSessionIdRef.current === requestedSessionId) setLoading(false);
    }
  }, [normalizedSessionId]);

  useEffect(() => {
    setWaits([]);
    setLoading(Boolean(normalizedSessionId));
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    const onChanged = () => void refresh();
    window.addEventListener("polpo:background-waits-changed", onChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("polpo:background-waits-changed", onChanged);
    };
  }, [normalizedSessionId, refresh]);

  const latestEvent = events.at(-1);
  useEffect(() => {
    if (!latestEvent) return;
    const eventSessionId = (latestEvent.data as { wait?: { sessionId?: string } } | undefined)?.wait?.sessionId;
    if (eventSessionId === normalizedSessionId) void refresh();
  }, [latestEvent, normalizedSessionId, refresh]);

  const cancel = useCallback(async (id: string) => {
    const response = await fetch(apiUrl(`/api/v1/background-waits/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: headers(),
      credentials: "include",
    });
    if (!response.ok) throw new Error("Could not cancel background wait");
    await refresh();
  }, [refresh]);

  const activeCount = useMemo(
    () => waits.filter((wait) => ["waiting", "ready", "running"].includes(wait.state)).length,
    [waits],
  );

  return { waits, activeCount, loading, refresh, cancel };
}
