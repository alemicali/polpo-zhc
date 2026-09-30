import { useEffect, useState } from "react";
import type { PolpoApi } from "@/components/config/telegram-connect";

/** Sorted agent names of the instance (empty until loaded). */
export function useAgentNames(api: PolpoApi): string[] {
  const [agents, setAgents] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api("/agents").then((res) => {
      if (!cancelled && res.ok) setAgents(((res.data ?? []) as { name: string }[]).map((a) => a.name).sort());
    });
    return () => { cancelled = true; };
  }, [api]);
  return agents;
}
