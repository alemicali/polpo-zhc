import { useCallback, useEffect, useState } from "react";
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
 */
export function useTaskActivity(taskId: string | null): UseTaskActivityReturn {
  const { client } = usePolpoContext();
  const [entries, setEntries] = useState<RunActivityEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    if (!taskId) {
      setEntries([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const data = await client.getTaskActivity(taskId);
      setEntries(data);
    } catch (err) {
      setError(err as Error);
      setEntries([]);
    } finally {
      setIsLoading(false);
    }
  }, [client, taskId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { entries, isLoading, error, refetch };
}
