import { useSyncExternalStore } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { PolpoStats } from "@polpo-ai/sdk";

export interface UseStatsReturn {
  stats: PolpoStats | null;
}

export function useStats(): UseStatsReturn {
  const { store } = usePolpoContext();

  const stats = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().stats,
    () => null,
  );

  return { stats };
}
