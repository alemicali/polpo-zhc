import { useSyncExternalStore } from "react";
import { useOrchestraContext } from "../provider/orchestra-context.js";
import type { OrchestraClient } from "../client/orchestra-client.js";
import type { ConnectionStatus } from "../client/event-source.js";

export interface UseOrchestraReturn {
  client: OrchestraClient;
  connectionStatus: ConnectionStatus;
}

export function useOrchestra(): UseOrchestraReturn {
  const { client, store } = useOrchestraContext();

  const connectionStatus = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().connectionStatus,
    () => store.getServerSnapshot().connectionStatus,
  );

  return { client, connectionStatus };
}
