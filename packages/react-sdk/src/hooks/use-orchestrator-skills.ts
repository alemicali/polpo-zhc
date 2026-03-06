import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { SkillInfo } from "@lumea-labs/polpo-client";

export interface UseOrchestratorSkillsReturn {
  skills: SkillInfo[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch orchestrator skills from .polpo/.agent/skills/.
 * Not reactive — discovered on demand.
 */
export function useOrchestratorSkills(): UseOrchestratorSkillsReturn {
  const { client } = usePolpoContext();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const data = await client.getOrchestratorSkills();
      setSkills(data);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);

  useEffect(() => {
    setIsLoading(true);
    fetch_().finally(() => setIsLoading(false));
  }, [fetch_]);

  return { skills, isLoading, error, refetch: fetch_ };
}
