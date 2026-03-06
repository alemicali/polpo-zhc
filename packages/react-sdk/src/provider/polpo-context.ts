import { createContext, useContext } from "react";
import type { PolpoClient } from "@lumea-labs/polpo-client";
import type { PolpoStore } from "@lumea-labs/polpo-client";

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
