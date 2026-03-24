import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { selectTasks, type TaskFilter } from "@polpo-ai/sdk";
import { useStableValue } from "./use-stable-value.js";
import { useMutation } from "./use-mutation.js";
import type { Task, CreateTaskRequest } from "@polpo-ai/sdk";

export interface UseTasksReturn {
  tasks: Task[];
  isLoading: boolean;
  error: Error | null;
  createTask: (req: CreateTaskRequest) => Promise<Task>;
  isCreating: boolean;
  deleteTask: (taskId: string) => Promise<void>;
  isDeleting: boolean;
  retryTask: (taskId: string) => Promise<void>;
  isRetrying: boolean;
  refetch: () => Promise<void>;
  invalidate: () => Promise<void>;
}

export function useTasks(filter?: TaskFilter): UseTasksReturn {
  const { client, store } = usePolpoContext();
  const stableFilter = useStableValue(filter);

  const tasks = useSyncExternalStore(
    store.subscribe,
    () => selectTasks(store.getSnapshot(), stableFilter),
    () => selectTasks(store.getServerSnapshot(), stableFilter),
  );

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    client
      .getTasks(stableFilter ? {
        status: Array.isArray(stableFilter.status) ? stableFilter.status.join(",") : stableFilter.status,
        group: stableFilter.group,
        assignTo: stableFilter.assignTo,
      } : undefined)
      .then((t) => {
        if (!cancelled) {
          store.setTasks(t);
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
  }, [client, store, stableFilter]);

  const refetch = useCallback(async () => {
    const t = await client.getTasks();
    store.setTasks(t);
  }, [client, store]);

  const { mutate: createTask, isPending: isCreating } = useMutation(
    useCallback(
      async (req: CreateTaskRequest) => {
        const task = await client.createTask(req);
        return task;
      },
      [client],
    ),
  );

  const { mutate: deleteTask, isPending: isDeleting } = useMutation(
    useCallback(
      async (taskId: string) => {
        await client.deleteTask(taskId);
      },
      [client],
    ),
  );

  const { mutate: retryTask, isPending: isRetrying } = useMutation(
    useCallback(
      async (taskId: string) => {
        await client.retryTask(taskId);
      },
      [client],
    ),
  );

  return {
    tasks,
    isLoading,
    error,
    createTask,
    isCreating,
    deleteTask,
    isDeleting,
    retryTask,
    isRetrying,
    refetch,
    invalidate: refetch,
  };
}
