import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { useOrchestraContext } from "../provider/orchestra-context.js";
import { selectTasks, type TaskFilter } from "../store/selectors.js";
import { useStableValue } from "./use-stable-value.js";
import type { Task, CreateTaskRequest } from "../client/types.js";

export interface UseTasksReturn {
  tasks: Task[];
  isLoading: boolean;
  error: Error | null;
  createTask: (req: CreateTaskRequest) => Promise<Task>;
  deleteTask: (taskId: string) => Promise<void>;
  retryTask: (taskId: string) => Promise<void>;
  refetch: () => Promise<void>;
}

export function useTasks(filter?: TaskFilter): UseTasksReturn {
  const { client, store } = useOrchestraContext();
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
        status: Array.isArray(stableFilter.status) ? stableFilter.status[0] : stableFilter.status,
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

  const createTask = useCallback(
    async (req: CreateTaskRequest) => {
      const task = await client.createTask(req);
      return task;
    },
    [client],
  );

  const deleteTask = useCallback(
    async (taskId: string) => {
      await client.deleteTask(taskId);
    },
    [client],
  );

  const retryTask = useCallback(
    async (taskId: string) => {
      await client.retryTask(taskId);
    },
    [client],
  );

  const refetch = useCallback(async () => {
    const t = await client.getTasks();
    store.setTasks(t);
  }, [client, store]);

  return { tasks, isLoading, error, createTask, deleteTask, retryTask, refetch };
}
