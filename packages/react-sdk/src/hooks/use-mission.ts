import { useSyncExternalStore, useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { selectMission, selectMissionReport } from "@lumea-labs/polpo-client";
import type {
  Mission, MissionReport, UpdateMissionRequest, ExecuteMissionResult, ResumeMissionResult,
  AddMissionTaskRequest, UpdateMissionTaskRequest, ReorderMissionTasksRequest,
  AddMissionCheckpointRequest, UpdateMissionCheckpointRequest,
  AddMissionQualityGateRequest, UpdateMissionQualityGateRequest,
  AddMissionTeamMemberRequest, UpdateMissionTeamMemberRequest,
  UpdateMissionNotificationsRequest,
} from "@lumea-labs/polpo-client";

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
  // ── Atomic mission data operations ──
  addTask: (req: AddMissionTaskRequest) => Promise<Mission>;
  updateTask: (taskTitle: string, req: UpdateMissionTaskRequest) => Promise<Mission>;
  removeTask: (taskTitle: string) => Promise<Mission>;
  reorderTasks: (req: ReorderMissionTasksRequest) => Promise<Mission>;
  addCheckpoint: (req: AddMissionCheckpointRequest) => Promise<Mission>;
  updateCheckpoint: (name: string, req: UpdateMissionCheckpointRequest) => Promise<Mission>;
  removeCheckpoint: (name: string) => Promise<Mission>;
  addQualityGate: (req: AddMissionQualityGateRequest) => Promise<Mission>;
  updateQualityGate: (name: string, req: UpdateMissionQualityGateRequest) => Promise<Mission>;
  removeQualityGate: (name: string) => Promise<Mission>;
  addTeamMember: (req: AddMissionTeamMemberRequest) => Promise<Mission>;
  updateTeamMember: (name: string, req: UpdateMissionTeamMemberRequest) => Promise<Mission>;
  removeTeamMember: (name: string) => Promise<Mission>;
  updateNotifications: (req: UpdateMissionNotificationsRequest) => Promise<Mission>;
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

  const missionsStale = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().missionsStale,
    () => false,
  );

  const [isLoading, setIsLoading] = useState(!mission);
  const [error, setError] = useState<Error | null>(null);

  // ── Initial fetch (only when mission is not yet in the store) ──
  useEffect(() => {
    if (mission) { setIsLoading(false); return; }
    let cancelled = false;
    setIsLoading(true);
    client.getMission(missionId)
      .then((m) => {
        if (!cancelled) {
          store.upsertMission(m);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) { setError(err as Error); setIsLoading(false); }
      });
    return () => { cancelled = true; };
  }, [client, store, missionId, !!mission]);

  // ── Auto-refetch when missions are marked stale by SSE events ──
  // (e.g. mission:saved after atomic data modifications from the orchestrator)
  const fetchingRef = useRef(false);
  useEffect(() => {
    if (missionsStale && missionId && !fetchingRef.current) {
      fetchingRef.current = true;
      client.getMission(missionId)
        .then((m) => { store.upsertMission(m); })
        .catch(() => { /* swallow — stale refetch is best-effort */ })
        .finally(() => { fetchingRef.current = false; });
    }
  }, [missionsStale, client, store, missionId]);

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

  // ── Atomic mission data callbacks ──

  const addTask = useCallback(
    (req: AddMissionTaskRequest) => client.addMissionTask(missionId, req),
    [client, missionId],
  );
  const updateTask = useCallback(
    (taskTitle: string, req: UpdateMissionTaskRequest) => client.updateMissionTask(missionId, taskTitle, req),
    [client, missionId],
  );
  const removeTask = useCallback(
    (taskTitle: string) => client.removeMissionTask(missionId, taskTitle),
    [client, missionId],
  );
  const reorderTasks = useCallback(
    (req: ReorderMissionTasksRequest) => client.reorderMissionTasks(missionId, req),
    [client, missionId],
  );
  const addCheckpoint = useCallback(
    (req: AddMissionCheckpointRequest) => client.addMissionCheckpoint(missionId, req),
    [client, missionId],
  );
  const updateCheckpoint = useCallback(
    (name: string, req: UpdateMissionCheckpointRequest) => client.updateMissionCheckpoint(missionId, name, req),
    [client, missionId],
  );
  const removeCheckpoint = useCallback(
    (name: string) => client.removeMissionCheckpoint(missionId, name),
    [client, missionId],
  );
  const addQualityGate = useCallback(
    (req: AddMissionQualityGateRequest) => client.addMissionQualityGate(missionId, req),
    [client, missionId],
  );
  const updateQualityGate = useCallback(
    (name: string, req: UpdateMissionQualityGateRequest) => client.updateMissionQualityGate(missionId, name, req),
    [client, missionId],
  );
  const removeQualityGate = useCallback(
    (name: string) => client.removeMissionQualityGate(missionId, name),
    [client, missionId],
  );
  const addTeamMember = useCallback(
    (req: AddMissionTeamMemberRequest) => client.addMissionTeamMember(missionId, req),
    [client, missionId],
  );
  const updateTeamMember = useCallback(
    (name: string, req: UpdateMissionTeamMemberRequest) => client.updateMissionTeamMember(missionId, name, req),
    [client, missionId],
  );
  const removeTeamMember = useCallback(
    (name: string) => client.removeMissionTeamMember(missionId, name),
    [client, missionId],
  );
  const updateNotifications = useCallback(
    (req: UpdateMissionNotificationsRequest) => client.updateMissionNotifications(missionId, req),
    [client, missionId],
  );

  return {
    mission, report, isLoading, error,
    updateMission, executeMission, resumeMission, abortMission, deleteMission,
    addTask, updateTask, removeTask, reorderTasks,
    addCheckpoint, updateCheckpoint, removeCheckpoint,
    addQualityGate, updateQualityGate, removeQualityGate,
    addTeamMember, updateTeamMember, removeTeamMember,
    updateNotifications,
  };
}
