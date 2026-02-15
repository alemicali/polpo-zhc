import { useSyncExternalStore } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { PolpoClient } from "../client/polpo-client.js";
import type { ConnectionStatus } from "../client/event-source.js";

export interface UsePolpoReturn {
  client: PolpoClient;
  connectionStatus: ConnectionStatus;
}

export function usePolpo(): UsePolpoReturn {
  const { client, store } = usePolpoContext();

  const connectionStatus = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().connectionStatus,
    () => store.getServerSnapshot().connectionStatus,
  );

  return { client, connectionStatus };
}
