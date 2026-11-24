import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { AgentConfig } from "@polpo-ai/sdk";

export interface UseAgentReturn {
  agent: AgentConfig | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** An agent as production runs it; `view: "draft"`: its draft (working copy) with the versioning state. */
export function useAgent(name: string, opts: { view?: "production" | "draft" } = {}): UseAgentReturn {
  const { client } = usePolpoContext();
  const view = opts.view;
  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchAgent = useCallback(async () => {
    try {
      setError(null);
      const data = await client.getAgent(name, view ? { view } : {});
      setAgent(data);
    } catch (err) {
      setError(err as Error);
      setAgent(null);
    }
  }, [client, name, view]);

  useEffect(() => {
    setIsLoading(true);
    fetchAgent().finally(() => setIsLoading(false));
  }, [fetchAgent]);

  return { agent, isLoading, error, refetch: fetchAgent };
}
