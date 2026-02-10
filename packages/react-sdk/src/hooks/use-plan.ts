import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { useOrchestraContext } from "../provider/orchestra-context.js";
import { selectPlan } from "../store/selectors.js";
import type { Plan, UpdatePlanRequest, ExecutePlanResult, ResumePlanResult } from "../client/types.js";

export interface UsePlanReturn {
  plan: Plan | undefined;
  isLoading: boolean;
  error: Error | null;
  updatePlan: (req: UpdatePlanRequest) => Promise<Plan>;
  executePlan: () => Promise<ExecutePlanResult>;
  resumePlan: (opts?: { retryFailed?: boolean }) => Promise<ResumePlanResult>;
  abortPlan: () => Promise<{ aborted: number }>;
  deletePlan: () => Promise<void>;
}

export function usePlan(planId: string): UsePlanReturn {
  const { client, store } = useOrchestraContext();

  const plan = useSyncExternalStore(
    store.subscribe,
    () => selectPlan(store.getSnapshot(), planId),
    () => selectPlan(store.getServerSnapshot(), planId),
  );

  const [isLoading, setIsLoading] = useState(!plan);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (plan) { setIsLoading(false); return; }
    let cancelled = false;
    setIsLoading(true);
    client.getPlan(planId)
      .then((p) => {
        if (!cancelled) {
          // Insert into store
          store.setPlans([...Array.from(store.getSnapshot().plans.values()), p]);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) { setError(err as Error); setIsLoading(false); }
      });
    return () => { cancelled = true; };
  }, [client, store, planId, !!plan]);

  const updatePlan = useCallback(
    (req: UpdatePlanRequest) => client.updatePlan(planId, req),
    [client, planId],
  );

  const executePlan = useCallback(
    () => client.executePlan(planId),
    [client, planId],
  );

  const resumePlan = useCallback(
    (opts?: { retryFailed?: boolean }) => client.resumePlan(planId, opts),
    [client, planId],
  );

  const abortPlan = useCallback(
    () => client.abortPlan(planId),
    [client, planId],
  );

  const deletePlan = useCallback(async () => {
    await client.deletePlan(planId);
  }, [client, planId]);

  return { plan, isLoading, error, updatePlan, executePlan, resumePlan, abortPlan, deletePlan };
}
