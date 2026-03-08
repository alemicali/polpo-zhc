import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { LogSession, LogEntry } from "@polpo-ai/client";

export interface UseLogsReturn {
  sessions: LogSession[];
  isLoading: boolean;
  error: Error | null;
  getLogEntries: (sessionId: string) => Promise<LogEntry[]>;
  refetch: () => Promise<void>;
}

export function useLogs(): UseLogsReturn {
  const { client } = usePolpoContext();

  const [sessions, setSessions] = useState<LogSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try {
      const s = await client.getLogs();
      setSessions(s);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);

  useEffect(() => {
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch]);

  const getLogEntries = useCallback(
    (sessionId: string) => client.getLogEntries(sessionId),
    [client],
  );

  return { sessions, isLoading, error, getLogEntries, refetch };
}
