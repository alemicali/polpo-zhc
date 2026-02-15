import { createContext, useContext } from "react";
import type { PolpoClient } from "../client/polpo-client.js";
import type { PolpoStore } from "../store/polpo-store.js";

export interface PolpoContextValue {
  client: PolpoClient;
  store: PolpoStore;
}

export const PolpoContext = createContext<PolpoContextValue | null>(null);

export function usePolpoContext(): PolpoContextValue {
  const ctx = useContext(PolpoContext);
  if (!ctx) {
    throw new Error("usePolpoContext must be used within <PolpoProvider>");
  }
  return ctx;
}
