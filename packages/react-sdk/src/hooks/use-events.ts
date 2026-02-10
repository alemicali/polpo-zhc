import { useRef, useSyncExternalStore } from "react";
import { useOrchestraContext } from "../provider/orchestra-context.js";
import { selectEvents } from "../store/selectors.js";
import { useStableValue } from "./use-stable-value.js";
import type { SSEEvent } from "../client/types.js";

export interface UseEventsReturn {
  events: SSEEvent[];
}

export function useEvents(filter?: string[], maxEvents = 200): UseEventsReturn {
  const { store } = useOrchestraContext();
  const stableFilter = useStableValue(filter);
  const cacheRef = useRef<{ source: SSEEvent[]; result: SSEEvent[] }>({
    source: [],
    result: [],
  });

  const events = useSyncExternalStore(
    store.subscribe,
    () => {
      const selected = selectEvents(store.getSnapshot(), stableFilter);
      // Return cached result if the underlying array hasn't changed
      if (selected === cacheRef.current.source) {
        return cacheRef.current.result;
      }
      const sliced = selected.slice(-maxEvents);
      cacheRef.current = { source: selected, result: sliced };
      return sliced;
    },
    () => [],
  );

  return { events };
}
