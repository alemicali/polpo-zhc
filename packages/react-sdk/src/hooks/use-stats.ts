import { useSyncExternalStore } from "react";
import { useOrchestraContext } from "../provider/orchestra-context.js";
import type { OrchestraStats } from "../store/types.js";

export function useStats(): OrchestraStats | null {
  const { store } = useOrchestraContext();

  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().stats,
    () => null,
  );
}
