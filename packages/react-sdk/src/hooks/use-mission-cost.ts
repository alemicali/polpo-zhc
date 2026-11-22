import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { MissionCost } from "@polpo-ai/sdk";

export interface UseMissionCostReturn {
  /** What the mission cost so far (every run of its tasks: USD, tokens, by agent and engine) against its budget. */
  cost: MissionCost | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Set the budget in USD, or clear it (null). Raising or clearing it lets a mission paused by its budget go on. */
  setBudget: (budgetUsd: number | null) => Promise<void>;
}

/**
 * A mission's full cost (GET /missions/:id → cost). It is fetched again when `refreshKey`
 * changes (e.g. the mission's updatedAt, or a run that reported cost), at most every 2 s.
 */
export function useMissionCost(missionId: string | undefined, refreshKey?: string): UseMissionCostReturn {
  const { client } = usePolpoContext();
  const [cost, setCost] = useState<MissionCost | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const last = useRef(0);

  const refetch = useCallback(async () => {
    if (!missionId) return;
    last.current = Date.now();
    setIsLoading(true);
    try {
      const m = await client.getMission(missionId);
      // lists carry a compact cost; the full one has byAgent
      setCost(m.cost && "byAgent" in m.cost ? m.cost : undefined);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  }, [client, missionId]);

  useEffect(() => {
    const wait = Math.max(0, 2000 - (Date.now() - last.current));
    const timer = setTimeout(() => { void refetch(); }, last.current === 0 ? 0 : wait);
    return () => clearTimeout(timer);
  }, [refetch, refreshKey]);

  const setBudget = useCallback(async (budgetUsd: number | null) => {
    if (!missionId) return;
    await client.updateMission(missionId, { budgetUsd });
    await refetch();
  }, [client, missionId, refetch]);

  return { cost, isLoading, error, refetch, setBudget };
}
