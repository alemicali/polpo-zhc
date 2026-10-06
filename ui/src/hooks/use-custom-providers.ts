/** Custom LLM providers / AI gateways configured on the instance (no secrets). */

import { useCallback, useEffect, useState } from "react";
import type { CustomProviderInfo } from "@polpo-ai/react";

export type ApiResult = { ok: boolean; data?: unknown; error?: string };
export type ApiFetch = (path: string, init?: RequestInit) => Promise<ApiResult>;

export function useCustomProviders(apiFetch: ApiFetch) {
  const [providers, setProviders] = useState<CustomProviderInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    const r = await apiFetch("/providers/custom");
    if (r.ok) setProviders(r.data as CustomProviderInfo[]);
    setLoaded(true);
  }, [apiFetch]);
  useEffect(() => {
    let cancelled = false;
    void apiFetch("/providers/custom").then((r) => {
      if (cancelled) return;
      if (r.ok) setProviders(r.data as CustomProviderInfo[]);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [apiFetch]);
  return { providers, loaded, reload };
}

