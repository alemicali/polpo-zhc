import { createContext, useContext } from "react";
import type { PolpoClient } from "@polpo-ai/client";
import type { PolpoStore } from "@polpo-ai/client";

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
