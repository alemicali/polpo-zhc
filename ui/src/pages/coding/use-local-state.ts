import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useState-like hook that mirrors its value into localStorage. Visual UI
 * preferences (open panels, active tab, sidebar widths…) live here — they're
 * inherently per-browser and don't justify a server roundtrip on every drag.
 *
 * Reads on mount synchronously so the first paint reflects the persisted
 * value (no flash to default). Writes are direct (no debounce) — these
 * payloads are tiny and JSON.stringify is fast.
 */
export function useLocalState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const initialRef = useRef(initial);
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initialRef.current;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return initialRef.current;
      return JSON.parse(raw) as T;
    } catch {
      return initialRef.current;
    }
  });

  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / disabled */ }
  }, [key, value]);

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => (typeof next === "function" ? (next as (p: T) => T)(prev) : next));
  }, []);

  return [value, set];
}
