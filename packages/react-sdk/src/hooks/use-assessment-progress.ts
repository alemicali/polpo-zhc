import { useSyncExternalStore } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { selectAssessmentProgress, selectAssessmentChecks } from "@lumea-labs/polpo-client";
import type { AssessmentProgressEntry, AssessmentCheckStatus } from "@lumea-labs/polpo-client";

export interface UseAssessmentProgressReturn {
  /** Live assessment progress messages for this task. Empty when no assessment is running. */
  progress: AssessmentProgressEntry[];
  /** Whether an assessment is currently in progress (progress array is non-empty). */
  isAssessing: boolean;
  /** Per-expectation check status (started/complete). Empty when no assessment is running. */
  checks: AssessmentCheckStatus[];
}

export function useAssessmentProgress(taskId: string): UseAssessmentProgressReturn {
  const { store } = usePolpoContext();

  const progress = useSyncExternalStore(
    store.subscribe,
    () => selectAssessmentProgress(store.getSnapshot(), taskId),
    () => [],
  );

  const checks = useSyncExternalStore(
    store.subscribe,
    () => selectAssessmentChecks(store.getSnapshot(), taskId),
    () => [],
  );

  return { progress, isAssessing: progress.length > 0, checks };
}
