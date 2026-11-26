import { useMemo } from "react";
import { useAuthStatus } from "@polpo-ai/react";

/** The providers a person can call (authenticated, or a configured custom one), as the model pickers show them. */
export function useConfiguredProviders(): { configuredProviders: string[]; providerSources: Record<string, string> } {
  const { authStatus } = useAuthStatus();
  return useMemo(() => {
    if (!authStatus) return { configuredProviders: [] as string[], providerSources: {} as Record<string, string> };
    const active = Object.entries(authStatus.providers).filter(
      ([, info]) => (info.custom ? !!info.configured : info.hasEnvKey) || info.profiles.some((p) => p.status === "active"),
    );
    return {
      configuredProviders: active.map(([n]) => n),
      providerSources: Object.fromEntries(active.map(([n, info]) => [n, info.custom ? "custom" : info.hasEnvKey ? "env" : "oauth"])),
    };
  }, [authStatus]);
}
