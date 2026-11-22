/**
 * A mission's full cost (GET /missions/:id → cost), fetched again whenever `refreshKey` changes
 * (its tasks or the mission changed: a run reported cost, the budget moved), at most every 2 s.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpo, type MissionCost } from "@polpo-ai/react";
import { fullCost } from "@/lib/mission-cost";

export function useMissionCost(missionId: string | undefined, refreshKey: string): {
  cost: MissionCost | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
  saveBudget: (budgetUsd: number | null) => Promise<void>;
} {
  const { client } = usePolpo();
  const [cost, setCost] = useState<MissionCost | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!missionId) return;
    last.current = Date.now();
    setLoading(true);
    try {
      const m = await client.getMission(missionId);
      setCost(fullCost(m.cost));
    } catch { /* best effort: the header keeps the last cost */ }
    finally { setLoading(false); }
  }, [client, missionId]);

  useEffect(() => {
    const wait = Math.max(0, 2000 - (Date.now() - last.current));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void refresh(); }, wait);
    return () => clearTimeout(timer.current);
  }, [refresh, refreshKey]);

  const saveBudget = useCallback(async (budgetUsd: number | null) => {
    if (!missionId) return;
    await client.updateMission(missionId, { budgetUsd });
    await refresh();
  }, [client, missionId, refresh]);

  return { cost, loading, refresh, saveBudget };
}
