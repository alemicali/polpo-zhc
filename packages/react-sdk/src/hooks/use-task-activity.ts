import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { RunActivityEntry } from "../client/types.js";

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

  const refetch = useCallback(async () => {
    if (!taskId) {
      setEntries([]);
      return;
    }
    // Avoid overlapping fetches during polling
    if (isFetching.current) return;
    isFetching.current = true;
    setIsLoading((prev) => (entries.length === 0 ? true : prev));
    setError(null);
    try {
      const data = await client.getTaskActivity(taskId);
      setEntries(data);
    } catch (err) {
      setError(err as Error);
      setEntries([]);
    } finally {
      isFetching.current = false;
      setIsLoading(false);
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
