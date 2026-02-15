import { useCallback, useEffect, useState } from "react";
import { useOrchestraContext } from "../provider/orchestra-context.js";
import type { ChatSession, ChatMessage } from "../client/types.js";

export interface UseSessionsReturn {
  sessions: ChatSession[];
  isLoading: boolean;
  error: Error | null;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  getMessages: (sessionId: string) => Promise<ChatMessage[]>;
  deleteSession: (sessionId: string) => Promise<void>;
  refetch: () => Promise<void>;
}

export function useSessions(): UseSessionsReturn {
  const { client } = useOrchestraContext();

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const data = await client.getSessions();
      setSessions(data.sessions);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);

  useEffect(() => {
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch]);

  const getMessages = useCallback(
    async (sessionId: string) => {
      const data = await client.getSessionMessages(sessionId);
      return data.messages;
    },
    [client],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      await client.deleteSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
    },
    [client, activeSessionId],
  );

  return {
    sessions,
    isLoading,
    error,
    activeSessionId,
    setActiveSessionId,
    getMessages,
    deleteSession,
    refetch,
  };
}
