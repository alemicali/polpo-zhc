import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type { SkillInfo } from "@polpo-ai/sdk";

export interface UseOrchestratorSkillsReturn {
  skills: SkillInfo[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch orchestrator skills from .polpo/.agent/skills/.
 * Refetches when orchestrator skills change.
 */
export function useOrchestratorSkills(): UseOrchestratorSkillsReturn {
  const { client } = usePolpoContext();
  const { events } = useEvents(["skill:changed"], 1);
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

  const latestEvent = events.at(-1);
  const handledEventRef = useRef(latestEvent?.id);
  useEffect(() => {
    const data = latestEvent?.data as { scope?: string } | undefined;
    if (!latestEvent || handledEventRef.current === latestEvent.id || data?.scope !== "orchestrator") return;
    handledEventRef.current = latestEvent.id;
    void fetch_();
  }, [fetch_, latestEvent]);

  return { skills, isLoading, error, refetch: fetch_ };
}
