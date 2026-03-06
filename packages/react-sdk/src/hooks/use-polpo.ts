import { useSyncExternalStore } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { PolpoClient } from "@lumea-labs/polpo-client";
import type { ConnectionStatus } from "@lumea-labs/polpo-client";

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
