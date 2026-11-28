import { useCallback, useEffect, useMemo, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { Connector, ConnectorAccount } from "@polpo-ai/sdk";

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

/** The agent an agent-scoped connector belongs to; undefined for an org or per-identity connector. */
export function connectorOwner(c: Pick<Connector, "scope">): string | undefined {
  return c.scope?.kind === "agent" ? c.scope.agent : undefined;
}

/** Whether the connector is per identity (each agent / person connects its own accounts). */
export function isIdentityConnector(c: Pick<Connector, "scope">): boolean {
  return c.scope?.kind === "identity";
}

/**
 * An identity's own accounts on a per-identity connector, the default first (`identity`: "agent:<name>",
 * "person:<email>", "org"). With `withFallback`, the organization's shared account when the fallback is
 * on and the identity has none (what its calls would use).
 */
export function connectorAccountsFor(c: Pick<Connector, "scope" | "accounts">, identity: string, withFallback = false): ConnectorAccount[] {
  const own = (c.accounts ?? []).filter((a) => a.identity === identity).sort((a, b) => Number(!!b.default) - Number(!!a.default));
  if (own.length || !withFallback || c.scope?.kind !== "identity" || !c.scope.fallback) return own;
  return (c.accounts ?? []).filter((a) => a.identity === "org");
}

export interface UseConnectorAccountsReturn {
  /** The per-identity connector's accounts (with `identity`: only that identity's). */
  accounts: ConnectorAccount[];
  /** Whether identities without an account use the organization's shared one. */
  fallback: boolean;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * A per-identity connector's accounts (`identity`: "agent:<name>", "person:<email>", "org" or "me").
 * Adding, renaming, signing in and removing go through the client (addConnectorAccount,
 * startConnectorAccountOAuth…); call refetch after.
 */
export function useConnectorAccounts(id: string, opts: { identity?: string } = {}): UseConnectorAccountsReturn {
  const { client } = usePolpoContext();
  const [accounts, setAccounts] = useState<ConnectorAccount[]>([]);
  const [fallback, setFallback] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const data = await client.getConnectorAccounts(id, opts.identity);
      setAccounts(data.accounts);
      setFallback(data.fallback);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, id, opts.identity]);

  useEffect(() => {
    setIsLoading(true);
    fetch_().finally(() => setIsLoading(false));
  }, [fetch_]);

  return { accounts, fallback, isLoading, error, refetch: fetch_ };
}

/** Whether `agent` may use the connector: enabled for it, and not another agent's own (the server's rule). */
export function connectorEnabledFor(c: Pick<Connector, "access" | "scope">, agent: string): boolean {
  const owner = connectorOwner(c);
  if (owner !== undefined && owner !== agent) return false;
  return c.access.agents === "*" || c.access.agents.includes(agent);
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
    ? all.filter((c) => connectorEnabledFor(c, opts.agent!))
    : all), [all, opts.agent]);

  return { connectors, isLoading, error, refetch: fetch_ };
}
