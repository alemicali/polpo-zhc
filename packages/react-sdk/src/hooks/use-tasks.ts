import { useSyncExternalStore, useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { selectTasks, type TaskFilter } from "@polpo-ai/sdk";
import { useStableValue } from "./use-stable-value.js";
import { useMutation } from "./use-mutation.js";
import { readCached, writeCached } from "./use-swr-cache.js";
import type { Task, CreateTaskRequest } from "@polpo-ai/sdk";

export interface UseTasksReturn {
  tasks: Task[];
  /** True only when there's no data at all (no cache, no fetch yet). */
  isLoading: boolean;
  /** True when we have data (stale or fresh) but a background fetch is in flight. */
  isRefreshing: boolean;
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

  // SWR: hydrate the SDK store from localStorage on first mount BEFORE
  // we read the snapshot, so the very first render already sees the
  // stale data. Tasks page paints instantly; the server-side ETag
  // (Fix 2) usually short-circuits the follow-up GET to a 304. We only
  // hydrate if the store is still empty — defends against SSE events
  // landing first.
  const hydratedRef = useRef(false);
  if (!hydratedRef.current && store.getSnapshot().tasks.size === 0) {
    const cached = readCached<Task[]>("tasks");
    if (cached?.data && cached.data.length > 0) {
      store.setTasks(cached.data);
    }
    hydratedRef.current = true;
  }

  const tasks = useSyncExternalStore(
    store.subscribe,
    () => selectTasks(store.getSnapshot(), stableFilter),
    () => selectTasks(store.getServerSnapshot(), stableFilter),
  );

  const [isLoading, setIsLoading] = useState(tasks.length === 0);
  const [isRefreshing, setIsRefreshing] = useState(tasks.length > 0);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    const hasStale = tasks.length > 0;
    if (hasStale) setIsRefreshing(true);
    else setIsLoading(true);
    client
      .getTasks(stableFilter ? {
        status: Array.isArray(stableFilter.status) ? stableFilter.status.join(",") : stableFilter.status,
        group: stableFilter.group,
        assignTo: stableFilter.assignTo,
      } : undefined)
      .then((t) => {
        if (!cancelled) {
          store.setTasks(t);
          // Persist only the unfiltered full list — filtered fetches would
          // pollute the cache key. The store reconstructs filtered views
          // on the client anyway.
          if (!stableFilter) writeCached("tasks", t);
          setIsLoading(false);
          setIsRefreshing(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err as Error);
          setIsLoading(false);
          setIsRefreshing(false);
        }
      });
    return () => { cancelled = true; };
    // tasks.length intentionally read only on mount via the hasStale snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    isRefreshing,
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
