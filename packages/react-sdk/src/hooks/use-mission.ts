import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { selectMission, selectMissionReport } from "../store/selectors.js";
import type { Mission, MissionReport, UpdateMissionRequest, ExecuteMissionResult, ResumeMissionResult } from "../client/types.js";

export interface UseMissionReturn {
  mission: Mission | undefined;
  /** Completion report — populated from mission:completed SSE event */
  report: MissionReport | undefined;
  isLoading: boolean;
  error: Error | null;
  updateMission: (req: UpdateMissionRequest) => Promise<Mission>;
  executeMission: () => Promise<ExecuteMissionResult>;
  resumeMission: (opts?: { retryFailed?: boolean }) => Promise<ResumeMissionResult>;
  abortMission: () => Promise<{ aborted: number }>;
  deleteMission: () => Promise<void>;
}

export function useMission(missionId: string): UseMissionReturn {
  const { client, store } = usePolpoContext();

  const mission = useSyncExternalStore(
    store.subscribe,
    () => selectMission(store.getSnapshot(), missionId),
    () => selectMission(store.getServerSnapshot(), missionId),
  );

  const report = useSyncExternalStore(
    store.subscribe,
    () => selectMissionReport(store.getSnapshot(), missionId),
    () => selectMissionReport(store.getServerSnapshot(), missionId),
  );

  const [isLoading, setIsLoading] = useState(!mission);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (mission) { setIsLoading(false); return; }
    let cancelled = false;
    setIsLoading(true);
    client.getMission(missionId)
      .then((m) => {
        if (!cancelled) {
          // Insert into store
          store.setMissions([...Array.from(store.getSnapshot().missions.values()), m]);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) { setError(err as Error); setIsLoading(false); }
      });
    return () => { cancelled = true; };
  }, [client, store, missionId, !!mission]);

  const updateMission = useCallback(
    (req: UpdateMissionRequest) => client.updateMission(missionId, req),
    [client, missionId],
  );

  const executeMission = useCallback(
    () => client.executeMission(missionId),
    [client, missionId],
  );

  const resumeMission = useCallback(
    (opts?: { retryFailed?: boolean }) => client.resumeMission(missionId, opts),
    [client, missionId],
  );

  const abortMission = useCallback(
    () => client.abortMission(missionId),
    [client, missionId],
  );

  const deleteMission = useCallback(async () => {
    await client.deleteMission(missionId);
  }, [client, missionId]);

  return { mission, report, isLoading, error, updateMission, executeMission, resumeMission, abortMission, deleteMission };
}
