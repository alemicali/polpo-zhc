import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { MemberPreferences, MemberPreferencesPatch } from "@polpo-ai/sdk";

export interface UsePreferencesReturn {
  /** The signed-in member's preferences (empty object until loaded). */
  preferences: MemberPreferences;
  /** Member the preferences belong to; null when shared (no instance auth). */
  member: string | null;
  isLoading: boolean;
  error: Error | null;
  /** Merge fields into the stored preferences (optimistic). */
  update: (patch: MemberPreferencesPatch) => Promise<void>;
  refetch: () => Promise<void>;
}

/**
 * Per-member dashboard preferences stored on the server, so they follow the
 * person across devices — e.g. which chat was open, the open chat tabs and
 * whether the chat panels were shown.
 */
export function usePreferences(): UsePreferencesReturn {
  const { client } = usePolpoContext();
  const [preferences, setPreferences] = useState<MemberPreferences>({});
  const [member, setMember] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try {
      const data = await client.getPreferences();
      setPreferences(data.preferences);
      setMember(data.member);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);

  useEffect(() => {
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch]);

  const update = useCallback(async (patch: MemberPreferencesPatch) => {
    if (patch.chatNavigation) {
      const chatNavigation = patch.chatNavigation;
      setPreferences((prev) => ({ ...prev, chatNavigation: { ...prev.chatNavigation, ...chatNavigation } }));
    }
    try {
      const data = await client.updatePreferences(patch);
      setPreferences(data.preferences);
      setMember(data.member);
      setError(null);
    } catch (err) {
      setError(err as Error);
      throw err;
    }
  }, [client]);

  return { preferences, member, isLoading, error, update, refetch };
}
