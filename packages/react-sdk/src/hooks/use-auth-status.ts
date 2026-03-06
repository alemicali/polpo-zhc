import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { AuthStatusResponse } from "@lumea-labs/polpo-client";

export interface UseAuthStatusReturn {
  authStatus: AuthStatusResponse | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch per-provider auth status: config keys, env vars, OAuth profiles.
 * Tokens are NEVER exposed — only safe metadata (email, expiry, status).
 */
export function useAuthStatus(): UseAuthStatusReturn {
  const { client } = usePolpoContext();
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const data = await client.getAuthStatus();
      setAuthStatus(data);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);

  useEffect(() => {
    setIsLoading(true);
    fetch_().finally(() => setIsLoading(false));
  }, [fetch_]);

  return { authStatus, isLoading, error, refetch: fetch_ };
}
