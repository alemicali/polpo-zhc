import { useSyncExternalStore, useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { selectMissions } from "@polpo-ai/sdk";
import { useMutation } from "./use-mutation.js";
import { readCached, writeCached } from "./use-swr-cache.js";
import type { Mission, CreateMissionRequest, UpdateMissionRequest, ExecuteMissionResult, ResumeMissionResult } from "@polpo-ai/sdk";

export interface UseMissionsReturn {
  missions: Mission[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  createMission: (req: CreateMissionRequest) => Promise<Mission>;
  isCreating: boolean;
  updateMission: (missionId: string, req: UpdateMissionRequest) => Promise<Mission>;
  isUpdating: boolean;
  deleteMission: (missionId: string) => Promise<void>;
  isDeleting: boolean;
  executeMission: (missionId: string) => Promise<ExecuteMissionResult>;
  isExecuting: boolean;
  resumeMission: (missionId: string, opts?: { retryFailed?: boolean }) => Promise<ResumeMissionResult>;
  isResuming: boolean;
  abortMission: (missionId: string) => Promise<{ aborted: number }>;
  isAborting: boolean;
  refetch: () => Promise<void>;
  invalidate: () => Promise<void>;
}

export function useMissions(): UseMissionsReturn {
  const { client, store } = usePolpoContext();

  // SWR hydrate — same pattern as use-tasks. Done BEFORE useSyncExternalStore
  // so the very first render sees the stale data. Cold-loading /missions is
  // the worst single page (full payload includes the `data` JSON blob); the
  // pre-paint from cache is a big perceived-latency win.
  const hydratedRef = useRef(false);
  if (!hydratedRef.current && store.getSnapshot().missions.size === 0) {
    const cached = readCached<Mission[]>("missions");
    if (cached?.data && cached.data.length > 0) {
      store.setMissions(cached.data);
    }
    hydratedRef.current = true;
  }

  const missions = useSyncExternalStore(
    store.subscribe,
    () => selectMissions(store.getSnapshot()),
    () => selectMissions(store.getServerSnapshot()),
  );

  const missionsStale = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().missionsStale,
    () => false,
  );

  const [isLoading, setIsLoading] = useState(missions.length === 0);
  const [isRefreshing, setIsRefreshing] = useState(missions.length > 0);
  const [error, setError] = useState<Error | null>(null);

  const fetchMissions = useCallback(async () => {
    try {
      const m = await client.getMissions();
      store.setMissions(m);
      writeCached("missions", m);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, store]);

  useEffect(() => {
    const hasStale = missions.length > 0;
    if (hasStale) setIsRefreshing(true);
    else setIsLoading(true);
    fetchMissions().finally(() => {
      setIsLoading(false);
      setIsRefreshing(false);
    });
    // missions.length intentionally captured on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchMissions]);

  // Auto-refetch when missions are marked stale by SSE events.
  // Guard against concurrent fetches to prevent cascading loops when
  // rapid SSE events (mission:saved + mission:executed) toggle stale repeatedly.
  const fetchingRef = useRef(false);
  useEffect(() => {
    if (missionsStale && !fetchingRef.current) {
      fetchingRef.current = true;
      fetchMissions().finally(() => { fetchingRef.current = false; });
    }
  }, [missionsStale, fetchMissions]);

  const { mutate: createMission, isPending: isCreating } = useMutation(
    useCallback(
      (req: CreateMissionRequest) => client.createMission(req),
      [client],
    ),
  );

  const { mutate: updateMission, isPending: isUpdating } = useMutation(
    useCallback(
      (missionId: string, req: UpdateMissionRequest) => client.updateMission(missionId, req),
      [client],
    ),
  );

  const { mutate: deleteMission, isPending: isDeleting } = useMutation(
    useCallback(
      async (missionId: string) => { await client.deleteMission(missionId); },
      [client],
    ),
  );

  const { mutate: executeMission, isPending: isExecuting } = useMutation(
    useCallback(
      (missionId: string) => client.executeMission(missionId),
      [client],
    ),
  );

  const { mutate: resumeMission, isPending: isResuming } = useMutation(
    useCallback(
      (missionId: string, opts?: { retryFailed?: boolean }) => client.resumeMission(missionId, opts),
      [client],
    ),
  );

  const { mutate: abortMission, isPending: isAborting } = useMutation(
    useCallback(
      (missionId: string) => client.abortMission(missionId),
      [client],
    ),
  );

  return {
    missions,
    isLoading,
    isRefreshing,
    error,
    createMission,
    isCreating,
    updateMission,
    isUpdating,
    deleteMission,
    isDeleting,
    executeMission,
    isExecuting,
    resumeMission,
    isResuming,
    abortMission,
    isAborting,
    refetch: fetchMissions,
    invalidate: fetchMissions,
  };
}
