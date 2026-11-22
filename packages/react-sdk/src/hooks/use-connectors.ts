import { useCallback, useEffect, useMemo, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { Connector } from "@polpo-ai/sdk";

export interface UseConnectorsReturn {
  /** Every connector, or (with `agent`) the ones that agent may use. */
  connectors: Connector[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** The label people see: the name, plus the signed-in account when the name does not say it ("Gmail 2 – info@acme.com"). */
export function connectorLabel(c: Pick<Connector, "name" | "account">): string {
  const account = c.account?.trim();
  return account && !c.name.toLowerCase().includes(account.toLowerCase()) ? `${c.name} – ${account}` : c.name;
}

/**
 * The instance's connectors (external apps over MCP): status, the signed-in account (several
 * accounts of one app have their own ids: gmail, gmail-2…) and who may use them. With `agent`,
 * only the connectors granted to that agent.
 */
export function useConnectors(opts: { agent?: string } = {}): UseConnectorsReturn {
  const { client } = usePolpoContext();
  const [all, setAll] = useState<Connector[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      setAll(await client.getConnectors());
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);

  useEffect(() => {
    setIsLoading(true);
    fetch_().finally(() => setIsLoading(false));
  }, [fetch_]);

  const connectors = useMemo(() => (opts.agent
    ? all.filter((c) => c.access.agents === "*" || c.access.agents.includes(opts.agent!))
    : all), [all, opts.agent]);

  return { connectors, isLoading, error, refetch: fetch_ };
}
