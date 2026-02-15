import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { selectPlans } from "../store/selectors.js";
import type { Plan, CreatePlanRequest, UpdatePlanRequest, ExecutePlanResult, ResumePlanResult } from "../client/types.js";

export interface UsePlansReturn {
  plans: Plan[];
  isLoading: boolean;
  error: Error | null;
  createPlan: (req: CreatePlanRequest) => Promise<Plan>;
  updatePlan: (planId: string, req: UpdatePlanRequest) => Promise<Plan>;
  deletePlan: (planId: string) => Promise<void>;
  executePlan: (planId: string) => Promise<ExecutePlanResult>;
  resumePlan: (planId: string, opts?: { retryFailed?: boolean }) => Promise<ResumePlanResult>;
  abortPlan: (planId: string) => Promise<{ aborted: number }>;
  refetch: () => Promise<void>;
}

export function usePlans(): UsePlansReturn {
  const { client, store } = usePolpoContext();

  const plans = useSyncExternalStore(
    store.subscribe,
    () => selectPlans(store.getSnapshot()),
    () => selectPlans(store.getServerSnapshot()),
  );

  const plansStale = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().plansStale,
    () => false,
  );

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchPlans = useCallback(async () => {
    try {
      const p = await client.getPlans();
      store.setPlans(p);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, store]);

  useEffect(() => {
    setIsLoading(true);
    fetchPlans().finally(() => setIsLoading(false));
  }, [fetchPlans]);

  // Auto-refetch when plans are marked stale by SSE events
  useEffect(() => {
    if (plansStale) fetchPlans();
  }, [plansStale, fetchPlans]);

  const createPlan = useCallback(
    (req: CreatePlanRequest) => client.createPlan(req),
    [client],
  );

  const updatePlan = useCallback(
    (planId: string, req: UpdatePlanRequest) => client.updatePlan(planId, req),
    [client],
  );

  const deletePlan = useCallback(
    async (planId: string) => { await client.deletePlan(planId); },
    [client],
  );

  const executePlan = useCallback(
    (planId: string) => client.executePlan(planId),
    [client],
  );

  const resumePlan = useCallback(
    (planId: string, opts?: { retryFailed?: boolean }) => client.resumePlan(planId, opts),
    [client],
  );

  const abortPlan = useCallback(
    (planId: string) => client.abortPlan(planId),
    [client],
  );

  return {
    plans,
    isLoading,
    error,
    createPlan,
    updatePlan,
    deletePlan,
    executePlan,
    resumePlan,
    abortPlan,
    refetch: fetchPlans,
  };
}
