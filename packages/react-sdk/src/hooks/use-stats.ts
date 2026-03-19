import { useSyncExternalStore } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { PolpoStats } from "@polpo-ai/sdk";

export function useStats(): PolpoStats | null {
  const { store } = usePolpoContext();

  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().stats,
    () => null,
  );
}
