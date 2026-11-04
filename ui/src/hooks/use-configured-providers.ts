import { useMemo } from "react";
import { useAuthStatus } from "@polpo-ai/react";

/**
 * Providers whose models can actually be called (API key, active login, or a configured
 * custom provider such as a local model server), for ModelPicker.
 */
export function useConfiguredProviders() {
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
