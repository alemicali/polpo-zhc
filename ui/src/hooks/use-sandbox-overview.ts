import { useCallback, useEffect, useState } from "react";
import { sandboxApi, type SandboxOverview } from "@/lib/sandbox-api";

/** Instance sandbox settings and what every agent ends up with (Config → Sandbox, agent Sandbox tab). */
export function useSandboxOverview() {
  const [overview, setOverview] = useState<SandboxOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // state is only updated in the promise callbacks (never synchronously), so the effect can load
  const load = useCallback(() => sandboxApi.overview().then(
    (next) => { setOverview(next); setError(null); },
    (e: Error) => setError(e.message),
  ), []);
  useEffect(() => { void load(); }, [load]);
  return { overview, error, reload: load };
}
