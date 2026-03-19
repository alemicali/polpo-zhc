import { useSyncExternalStore } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { PolpoClient } from "@polpo-ai/sdk";
import type { ConnectionStatus } from "@polpo-ai/sdk";

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
