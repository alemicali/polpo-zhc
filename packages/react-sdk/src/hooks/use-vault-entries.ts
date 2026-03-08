import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { VaultEntryMeta } from "@polpo-ai/client";

export interface UseVaultEntriesReturn {
  entries: VaultEntryMeta[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch vault entry metadata for an agent (service names, types, credential key names).
 * Never exposes secret values — only field names with "***" masking.
 */
export function useVaultEntries(agentName: string): UseVaultEntriesReturn {
  const { client } = usePolpoContext();
  const [entries, setEntries] = useState<VaultEntryMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch_ = useCallback(async () => {
    if (!agentName) {
      setEntries([]);
      return;
    }
    try {
      const data = await client.listVaultEntries(agentName);
      setEntries(data);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, agentName]);

  useEffect(() => {
    setIsLoading(true);
    fetch_().finally(() => setIsLoading(false));
  }, [fetch_]);

  return { entries, isLoading, error, refetch: fetch_ };
}
