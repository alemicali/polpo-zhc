import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type { SkillWithAssignment } from "@polpo-ai/sdk";

export interface UseSkillsReturn {
  skills: SkillWithAssignment[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch available project-level skills with agent assignment info.
 * Refetches when a skill is created, changed, installed, removed, or reassigned.
 */
export function useSkills(): UseSkillsReturn {
  const { events } = useEvents(["skill:changed", "agent:created", "agent:updated", "agent:removed"], 1);
  const { client } = usePolpoContext();
  const [skills, setSkills] = useState<SkillWithAssignment[]>([]);
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

  const latestEventId = events.at(-1)?.id;
  const handledEventRef = useRef(latestEventId);
  useEffect(() => {
    if (!latestEventId || handledEventRef.current === latestEventId) return;
    handledEventRef.current = latestEventId;
    void fetch_();
  }, [fetch_, latestEventId]);

  return { skills, isLoading, error, refetch: fetch_ };
}
