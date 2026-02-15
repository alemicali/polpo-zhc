import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { SkillInfo } from "../client/types.js";

export interface UseSkillsReturn {
  skills: SkillInfo[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch available project-level skills from .claude/skills/ directories.
 * Skills are not reactive (no SSE updates) — they're discovered on demand.
 */
export function useSkills(): UseSkillsReturn {
  const { client } = usePolpoContext();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const data = await client.getSkills();
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
