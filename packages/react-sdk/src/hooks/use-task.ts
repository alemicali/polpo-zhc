import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { selectTask } from "@polpo-ai/client";
import type { Task, UpdateTaskRequest } from "@polpo-ai/client";

export interface UseTaskReturn {
  task: Task | undefined;
  isLoading: boolean;
  error: Error | null;
  updateTask: (req: UpdateTaskRequest) => Promise<Task>;
  deleteTask: () => Promise<void>;
  killTask: () => Promise<void>;
  reassessTask: () => Promise<void>;
  retryTask: () => Promise<void>;
  queueTask: () => Promise<void>;
}

export function useTask(taskId: string): UseTaskReturn {
  const { client, store } = usePolpoContext();

  const task = useSyncExternalStore(
    store.subscribe,
    () => selectTask(store.getSnapshot(), taskId),
    () => selectTask(store.getServerSnapshot(), taskId),
  );

  const [isLoading, setIsLoading] = useState(!task);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (task) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    client
      .getTask(taskId)
      .then((t) => {
        if (!cancelled) {
          // Merge into store — setTasks would overwrite, so we use applyEvent
          store.applyEvent({
            id: "",
            event: "task:updated",
            data: { taskId: t.id, task: t },
            timestamp: new Date().toISOString(),
          });
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err as Error);
          setIsLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [client, store, taskId, !!task]);

  const updateTask = useCallback(
    async (req: UpdateTaskRequest) => {
      return client.updateTask(taskId, req);
    },
    [client, taskId],
  );

  const deleteTask = useCallback(async () => {
    await client.deleteTask(taskId);
  }, [client, taskId]);

  const killTask = useCallback(async () => {
    await client.killTask(taskId);
  }, [client, taskId]);

  const reassessTask = useCallback(async () => {
    await client.reassessTask(taskId);
  }, [client, taskId]);

  const retryTask = useCallback(async () => {
    await client.retryTask(taskId);
  }, [client, taskId]);

  const queueTask = useCallback(async () => {
    await client.queueTask(taskId);
  }, [client, taskId]);

  return { task, isLoading, error, updateTask, deleteTask, killTask, reassessTask, retryTask, queueTask };
}
