import { useCallback, useEffect, useState, useRef } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type { ScheduleEntry } from "@polpo-ai/client";

export interface UseSchedulesReturn {
  schedules: ScheduleEntry[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

const SCHEDULE_EVENTS = ["schedule:created", "schedule:triggered", "schedule:completed"];

export function useSchedules(): UseSchedulesReturn {
  const { client } = usePolpoContext();
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchSchedules = useCallback(async () => {
    try {
      const data = await client.getSchedules();
      setSchedules(data);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);

  useEffect(() => {
    setIsLoading(true);
    fetchSchedules().finally(() => setIsLoading(false));
  }, [fetchSchedules]);

  // Auto-refetch on schedule SSE events
  const { events } = useEvents(SCHEDULE_EVENTS);
  const prevCountRef = useRef(events.length);
  useEffect(() => {
    if (events.length !== prevCountRef.current) {
      prevCountRef.current = events.length;
      fetchSchedules();
    }
  }, [events.length, fetchSchedules]);

  return { schedules, isLoading, error, refetch: fetchSchedules };
}
