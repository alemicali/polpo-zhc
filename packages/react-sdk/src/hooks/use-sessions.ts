import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { ChatSession, ChatMessage } from "@polpo-ai/sdk";

export interface UseSessionsReturn {
  sessions: ChatSession[];
  isLoading: boolean;
  error: Error | null;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  getMessages: (sessionId: string) => Promise<ChatMessage[]>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  /** Sync update of the local cached title — used when the server has
   *  already renamed (e.g. set_session_title tool emitted a SSE chunk)
   *  and we just need to mirror the change client-side without firing
   *  another PATCH. No-op if the session is unknown locally. */
  updateLocalTitle: (sessionId: string, title: string) => void;
  setStarred: (sessionId: string, starred: boolean) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  refetch: () => Promise<void>;
}

export function useSessions(): UseSessionsReturn {
  const { client } = usePolpoContext();

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

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      await client.renameSession(sessionId, title);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title } : s)),
      );
    },
    [client],
  );

  const setStarred = useCallback(
    async (sessionId: string, starred: boolean) => {
      await client.setSessionStarred(sessionId, starred);
      // Optimistic local update — mirror of renameSession. Note: we deliberately
      // do NOT touch updatedAt so the sidebar "recent" ordering stays put.
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, starred } : s)),
      );
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

  const updateLocalTitle = useCallback((sessionId: string, title: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, title } : s)),
    );
  }, []);

  return {
    sessions,
    isLoading,
    error,
    activeSessionId,
    setActiveSessionId,
    getMessages,
    renameSession,
    updateLocalTitle,
    setStarred,
    deleteSession,
    refetch,
  };
}
