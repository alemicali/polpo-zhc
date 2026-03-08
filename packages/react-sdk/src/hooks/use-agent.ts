import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { AgentConfig } from "@polpo-ai/client";

export interface UseAgentReturn {
  agent: AgentConfig | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch a single agent by name from the `/agents/:name` endpoint.
 */
export function useAgent(name: string): UseAgentReturn {
  const { client } = usePolpoContext();
  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchAgent = useCallback(async () => {
    try {
      setError(null);
      const data = await client.getAgent(name);
      setAgent(data);
    } catch (err) {
      setError(err as Error);
      setAgent(null);
    }
  }, [client, name]);

  useEffect(() => {
    setIsLoading(true);
    fetchAgent().finally(() => setIsLoading(false));
  }, [fetchAgent]);

  return { agent, isLoading, error, refetch: fetchAgent };
}
