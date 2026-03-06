import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { RunActivityEntry } from "@lumea-labs/polpo-client";

export interface UseTaskActivityReturn {
  entries: RunActivityEntry[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch the full activity history for a task from its run JSONL log.
 * Pass `null` to skip fetching (e.g. when no task is selected).
 *
 * When `pollIntervalMs` is set and > 0, the hook will automatically
 * re-fetch on that interval (useful for live-tailing running tasks).
 *
 * The hook avoids unnecessary re-renders by comparing new data against
 * the current entries (length + last timestamp) before updating state.
 */
export function useTaskActivity(
  taskId: string | null,
  options?: { pollIntervalMs?: number },
): UseTaskActivityReturn {
  const { client } = usePolpoContext();
  const [entries, setEntries] = useState<RunActivityEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const pollInterval = options?.pollIntervalMs ?? 0;
  const isFetching = useRef(false);
  // Track current entries for stable comparison without re-creating the callback
  const entriesRef = useRef<RunActivityEntry[]>([]);

  const refetch = useCallback(async () => {
    if (!taskId) {
      setEntries([]);
      entriesRef.current = [];
      return;
    }
    // Avoid overlapping fetches during polling
    if (isFetching.current) return;
    isFetching.current = true;

    // Only show loading spinner on the very first fetch (no data yet)
    const isFirstLoad = entriesRef.current.length === 0;
    if (isFirstLoad) setIsLoading(true);

    try {
      const data = await client.getTaskActivity(taskId);
      // Skip state update if data hasn't changed (avoids re-render flicker)
      const prev = entriesRef.current;
      const changed =
        data.length !== prev.length ||
        (data.length > 0 && data[data.length - 1].ts !== prev[prev.length - 1]?.ts);
      if (changed) {
        entriesRef.current = data;
        setEntries(data);
      }
      // Clear any previous error on success
      setError(null);
    } catch (err) {
      // On poll errors, keep existing entries visible (don't flash empty state)
      setError(err as Error);
    } finally {
      isFetching.current = false;
      if (isFirstLoad) setIsLoading(false);
    }
  }, [client, taskId]);

  // Initial fetch
  useEffect(() => {
    refetch();
  }, [refetch]);

  // Auto-poll when interval is set
  useEffect(() => {
    if (pollInterval <= 0 || !taskId) return;
    const timer = setInterval(refetch, pollInterval);
    return () => clearInterval(timer);
  }, [refetch, pollInterval, taskId]);

  return { entries, isLoading, error, refetch };
}
