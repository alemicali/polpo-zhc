/**
 * Connectors state for the Connectors page and the agent page: the configured connectors (kept
 * fresh by `connector:changed` over the app's single SSE stream) and, on demand, the catalog with
 * the shared OAuth apps and this instance's OAuth redirect URI.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useEvents } from "@polpo-ai/react";
import { connectorsApi, type Catalog, type Connector } from "@/lib/connectors-api";

const CONNECTOR_EVENTS = ["connector:changed"];

export interface UseConnectorsReturn {
  connectors: Connector[];
  catalog: Catalog | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshCatalog: () => Promise<void>;
  /** Put a connector returned by a mutation in the list right away (the SSE refresh follows). */
  upsert: (connector: Connector) => void;
  drop: (id: string) => void;
}

export function useConnectors({ withCatalog = false }: { withCatalog?: boolean } = {}): UseConnectorsReturn {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await connectorsApi.list();
      if (!mounted.current) return;
      setConnectors(list);
      setError(null);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const refreshCatalog = useCallback(async () => {
    try {
      const next = await connectorsApi.catalog();
      if (mounted.current) setCatalog(next);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (withCatalog) void refreshCatalog(); }, [withCatalog, refreshCatalog]);

  // Live: any connector:changed after mount refreshes the list (status, tool count, access).
  const { events } = useEvents(CONNECTOR_EVENTS, 20);
  const latest = events.at(-1);
  const handled = useRef(latest?.id);
  useEffect(() => {
    if (!latest || handled.current === latest.id) return;
    handled.current = latest.id;
    void refresh();
  }, [latest, refresh]);

  const upsert = useCallback((connector: Connector) => {
    setConnectors((list) => {
      const i = list.findIndex((c) => c.id === connector.id);
      if (i < 0) return [...list, connector];
      const next = [...list];
      next[i] = connector;
      return next;
    });
  }, []);

  const drop = useCallback((id: string) => setConnectors((list) => list.filter((c) => c.id !== id)), []);

  return { connectors, catalog, loading, error, refresh, refreshCatalog, upsert, drop };
}
