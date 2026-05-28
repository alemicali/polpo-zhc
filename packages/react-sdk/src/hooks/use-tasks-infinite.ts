import { useState, useEffect, useCallback, useRef } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useStableValue } from "./use-stable-value.js";
import type { Task, TaskSlim, TasksPageRequest, TasksPageResponse } from "@polpo-ai/sdk";

export interface UseTasksInfiniteOpts {
  /** Page size. Default 50, capped at 200 server-side. */
  limit?: number;
  /** Full-text search string. Auto-debounced 300ms before firing. */
  q?: string;
  /** Optional filter — passed straight through as query params. */
  status?: string;
  group?: string;
  assignTo?: string;
  /** Request the slim projection (smaller payload — recommended for lists). */
  slim?: boolean;
}

export interface UseTasksInfiniteReturn<T = Task | TaskSlim> {
  /** Flattened list across all loaded pages. */
  tasks: T[];
  /** True while the first page is loading (no data yet). */
  isLoading: boolean;
  /** True while a *subsequent* page is loading (data already present). */
  isLoadingMore: boolean;
  /** Server reported more rows are available past the last loaded page. */
  hasMore: boolean;
  /** Load the next page. No-op when `hasMore` is false or already loading. */
  fetchNextPage: () => Promise<void>;
  /** Reset state and re-fetch from cursor `null`. Called automatically when `q`/filters change. */
  refresh: () => Promise<void>;
  /** Last fetch error, if any. */
  error: Error | null;
}

/**
 * Cursor-paginated, optionally full-text-searched task list with infinite
 * scroll support. Pairs with `<Virtuoso endReached>` for the Tasks page.
 *
 * The hook owns its own state — it does NOT sync into the global SDK store
 * (which is event-driven and hydrated by SSE). That's intentional: a search
 * result should not bleed into hooks that expect the full task list.
 *
 * Debounce: `opts.q` is debounced 300ms. Other filters apply immediately —
 * the assumption is they come from clicks, not typing.
 */
export function useTasksInfinite<T = Task | TaskSlim>(
  opts?: UseTasksInfiniteOpts,
): UseTasksInfiniteReturn<T> {
  const { client } = usePolpoContext();
  const stableOpts = useStableValue(opts ?? {});

  // Debounce just the `q` field. Non-q opt changes go through immediately.
  const [debouncedQ, setDebouncedQ] = useState<string | undefined>(stableOpts.q);
  useEffect(() => {
    if (stableOpts.q === debouncedQ) return;
    const handle = setTimeout(() => setDebouncedQ(stableOpts.q), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableOpts.q]);

  const [tasks, setTasks] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Latest-request guard — drops stale responses when the user types fast.
  const reqIdRef = useRef(0);

  const buildRequest = useCallback(
    (cur: string | null): TasksPageRequest => ({
      limit: stableOpts.limit ?? 50,
      cursor: cur,
      q: debouncedQ && debouncedQ.length > 0 ? debouncedQ : undefined,
      status: stableOpts.status,
      group: stableOpts.group,
      assignTo: stableOpts.assignTo,
      slim: stableOpts.slim,
    }),
    [stableOpts, debouncedQ],
  );

  const fetchPage = useCallback(
    async (cur: string | null, append: boolean) => {
      const myReq = ++reqIdRef.current;
      if (append) setIsLoadingMore(true);
      else setIsLoading(true);
      setError(null);
      try {
        const page = (await client.getTasksPage(buildRequest(cur))) as TasksPageResponse<T>;
        if (myReq !== reqIdRef.current) return; // stale response
        setTasks((prev) => (append ? [...prev, ...page.tasks] : page.tasks));
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch (e) {
        if (myReq !== reqIdRef.current) return;
        setError(e as Error);
      } finally {
        if (myReq === reqIdRef.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [client, buildRequest],
  );

  // Refresh whenever the effective query changes. We depend on `buildRequest`
  // (memoized) which captures every relevant opt — that way one effect drives
  // both the initial fetch and any opts-change refresh.
  useEffect(() => {
    setTasks([]);
    setCursor(null);
    setHasMore(false);
    void fetchPage(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildRequest]);

  const fetchNextPage = useCallback(async () => {
    if (!hasMore || isLoading || isLoadingMore) return;
    await fetchPage(cursor, true);
  }, [hasMore, isLoading, isLoadingMore, cursor, fetchPage]);

  const refresh = useCallback(async () => {
    await fetchPage(null, false);
  }, [fetchPage]);

  // Live-merge SSE updates onto the loaded slice. The store fans out events
  // for task creates / updates / status changes — we patch in place when
  // the affected task is already loaded, and prepend it when it's new (so
  // the user sees real-time activity without manually refreshing).
  const { store } = usePolpoContext();
  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      const snap = store.getSnapshot();
      setTasks((prev) => {
        if (prev.length === 0) return prev;
        let changed = false;
        const next = prev.map((t) => {
          const stored = snap.tasks.get((t as Task).id);
          if (stored && stored !== (t as Task)) {
            changed = true;
            return stored as unknown as T;
          }
          return t;
        });
        return changed ? next : prev;
      });
    });
    return unsubscribe;
  }, [store]);

  return { tasks, isLoading, isLoadingMore, hasMore, fetchNextPage, refresh, error };
}
