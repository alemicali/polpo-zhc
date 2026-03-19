import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { PolpoClient } from "@polpo-ai/sdk";
import { EventSourceManager } from "@polpo-ai/sdk";
import type { SSEEvent } from "@polpo-ai/sdk";
import { PolpoStore } from "@polpo-ai/sdk";
import { PolpoContext } from "./polpo-context.js";

export interface PolpoProviderProps {
  baseUrl: string;
  /** @deprecated No longer used. Kept for backwards compatibility. */
  projectId?: string;
  apiKey?: string;
  children: ReactNode;
  autoConnect?: boolean;
  eventFilter?: string[];
}

export function PolpoProvider({
  baseUrl,
  apiKey,
  children,
  autoConnect = true,
  eventFilter,
}: PolpoProviderProps) {
  const configKey = `${baseUrl}|${apiKey ?? ""}`;
  const storeRef = useRef<PolpoStore>(null as unknown as PolpoStore);
  const clientRef = useRef<PolpoClient>(null as unknown as PolpoClient);
  const lastConfigKey = useRef("");

  if (lastConfigKey.current !== configKey) {
    lastConfigKey.current = configKey;
    clientRef.current = new PolpoClient({ baseUrl, apiKey });
    storeRef.current = new PolpoStore();
  }

  const client = clientRef.current!;
  const store = storeRef.current!;

  // SSE connection lifecycle
  useEffect(() => {
    if (!autoConnect) return;

    let pendingEvents: SSEEvent[] = [];
    let batchScheduled = false;

    const flushBatch = () => {
      if (pendingEvents.length > 0) {
        store.applyEventBatch(pendingEvents);
        pendingEvents = [];
      }
      batchScheduled = false;
    };

    const es = new EventSourceManager({
      url: client.getEventsUrl(eventFilter),
      onEvent: (event) => {
        pendingEvents.push(event);
        if (!batchScheduled) {
          batchScheduled = true;
          queueMicrotask(flushBatch);
        }
      },
      onStatusChange: (status) => {
        store.setConnectionStatus(status);
        if (status === "connected") {
          // Re-fetch all resources to fill any SSE gaps
          Promise.all([
            client.getTasks().then((t) => store.setTasks(t)),
            client.getMissions().then((m) => store.setMissions(m)),
            client.getAgents().then((a) => store.setAgents(a)),
            client.getProcesses().then((p) => store.setProcesses(p)),
          ]).catch(() => {
            /* individual errors handled by hooks */
          });
        }
      },
    });

    es.connect();
    return () => es.disconnect();
  }, [configKey, autoConnect, eventFilter?.join(",")]);

  const value = useMemo(() => ({ client, store }), [client, store]);

  return (
    <PolpoContext.Provider value={value}>
      {children}
    </PolpoContext.Provider>
  );
}
