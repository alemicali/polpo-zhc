import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type {
  SendTaskDirectionRequest,
  SendTaskDirectionResult,
  TaskDirection,
} from "@polpo-ai/sdk";

export interface UseTaskDirectionsReturn {
  directions: TaskDirection[];
  isLoading: boolean;
  isSending: boolean;
  error: Error | null;
  sendDirection: (request: SendTaskDirectionRequest) => Promise<SendTaskDirectionResult>;
  refetch: () => Promise<void>;
}

export function useTaskDirections(
  taskId: string | null,
  options?: { pollIntervalMs?: number },
): UseTaskDirectionsReturn {
  const { client } = usePolpoContext();
  const [directions, setDirections] = useState<TaskDirection[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const fetching = useRef(false);
  const loaded = useRef(false);
  const pollInterval = options?.pollIntervalMs ?? 0;

  const refetch = useCallback(async () => {
    if (!taskId || fetching.current) return;
    fetching.current = true;
    if (!loaded.current) setIsLoading(true);
    try {
      setDirections(await client.getTaskDirections(taskId));
      loaded.current = true;
      setError(null);
    } catch (cause) {
      setError(cause as Error);
    } finally {
      fetching.current = false;
      setIsLoading(false);
    }
  }, [client, taskId]);

  useEffect(() => {
    loaded.current = false;
    setDirections([]);
  }, [taskId]);

  const sendDirection = useCallback(async (request: SendTaskDirectionRequest) => {
    if (!taskId) throw new Error("Task ID is required");
    setIsSending(true);
    try {
      const result = await client.sendTaskDirection(taskId, request);
      setDirections((current) => [...current, result.direction]);
      setError(null);
      return result;
    } catch (cause) {
      setError(cause as Error);
      throw cause;
    } finally {
      setIsSending(false);
    }
  }, [client, taskId]);

  useEffect(() => { void refetch(); }, [refetch]);
  useEffect(() => {
    if (!taskId || pollInterval <= 0) return;
    const timer = setInterval(() => { void refetch(); }, pollInterval);
    return () => clearInterval(timer);
  }, [pollInterval, refetch, taskId]);

  return { directions, isLoading, isSending, error, sendDirection, refetch };
}
