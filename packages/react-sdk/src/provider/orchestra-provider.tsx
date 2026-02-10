import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { OrchestraClient } from "../client/orchestra-client.js";
import { EventSourceManager } from "../client/event-source.js";
import type { SSEEvent } from "../client/types.js";
import { OrchestraStore } from "../store/orchestra-store.js";
import { OrchestraContext } from "./orchestra-context.js";

export interface OrchestraProviderProps {
  baseUrl: string;
  projectId: string;
  apiKey?: string;
  children: ReactNode;
  autoConnect?: boolean;
  eventFilter?: string[];
}

export function OrchestraProvider({
  baseUrl,
  projectId,
  apiKey,
  children,
  autoConnect = true,
  eventFilter,
}: OrchestraProviderProps) {
  const configKey = `${baseUrl}|${projectId}|${apiKey ?? ""}`;
  const storeRef = useRef<OrchestraStore>(null as unknown as OrchestraStore);
  const clientRef = useRef<OrchestraClient>(null as unknown as OrchestraClient);
  const lastConfigKey = useRef("");

  if (lastConfigKey.current !== configKey) {
    lastConfigKey.current = configKey;
    clientRef.current = new OrchestraClient({ baseUrl, projectId, apiKey });
    storeRef.current = new OrchestraStore();
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
            client.getPlans().then((p) => store.setPlans(p)),
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
    <OrchestraContext.Provider value={value}>
      {children}
    </OrchestraContext.Provider>
  );
}
