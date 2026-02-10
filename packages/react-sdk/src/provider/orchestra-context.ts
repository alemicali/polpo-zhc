import { createContext, useContext } from "react";
import type { OrchestraClient } from "../client/orchestra-client.js";
import type { OrchestraStore } from "../store/orchestra-store.js";

export interface OrchestraContextValue {
  client: OrchestraClient;
  store: OrchestraStore;
}

export const OrchestraContext = createContext<OrchestraContextValue | null>(null);

export function useOrchestraContext(): OrchestraContextValue {
  const ctx = useContext(OrchestraContext);
  if (!ctx) {
    throw new Error("useOrchestraContext must be used within <OrchestraProvider>");
  }
  return ctx;
}
