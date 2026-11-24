import { useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { SearchResponse, SearchType } from "@polpo-ai/sdk";

export interface UseSearchOptions {
  /** Only these types (default: all). */
  types?: SearchType[];
  /** Results per page (default 40). */
  limit?: number;
  /** Results per type when several types are searched (default 6). */
  perType?: number;
  /** Wait this long after the last keystroke before asking the server (default 120 ms). */
  debounceMs?: number;
  /** false: do not search (e.g. the palette is closed). Default true. */
  enabled?: boolean;
}

export interface UseSearchReturn {
  /** The latest answer for the current query (null before the first one, or for an empty query). */
  data: SearchResponse | null;
  /** A query is on its way (results shown are those of the previous one). */
  isLoading: boolean;
  error: Error | null;
}

/**
 * The global search (GET /search), as you type: debounced, and every newer query cancels the one
 * in flight, so a slow answer never overwrites a newer one.
 */
export function useSearch(query: string, opts: UseSearchOptions = {}): UseSearchReturn {
  const { client } = usePolpoContext();
  const { limit, perType, debounceMs = 120, enabled = true } = opts;
  const typesKey = opts.types?.join(",") ?? "";
  const [state, setState] = useState<UseSearchReturn>({ data: null, isLoading: false, error: null });
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const mine = ++seq.current;
    if (!enabled || !q) {
      setState({ data: null, isLoading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, isLoading: true }));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const types = typesKey ? (typesKey.split(",") as SearchType[]) : undefined;
      client.search(q, { types, limit, perType, signal: controller.signal }).then(
        (data) => { if (seq.current === mine) setState({ data, isLoading: false, error: null }); },
        (error: Error) => {
          if (controller.signal.aborted || seq.current !== mine) return;
          setState((s) => ({ ...s, isLoading: false, error }));
        },
      );
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, query, typesKey, limit, perType, debounceMs, enabled]);

  return state;
}
