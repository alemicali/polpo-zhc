/**
 * Custom providers (local model servers such as Ollama or LM Studio, gateways) live in
 * polpo.json `providers`. The server registers them at init, but a task runner is a separate
 * process: it must register them too, or agents on "<custom-id>:<model>" fail with
 * "Model not found". Keys and secret headers come from the same vault as the server's.
 */
import { loadPolpoConfig, parseProviders } from "./config.js";
import { setProviderOverrides } from "../llm/pi-client.js";
import { setProviderSecretsSource } from "../llm/custom-providers.js";
import { readProviderSecrets } from "../llm/provider-secrets.js";
import type { VaultStore } from "./vault-store.js";

export function registerRunnerProviders(polpoDir: string, vault: VaultStore | undefined): void {
  const fileConfig = loadPolpoConfig(polpoDir);
  if (fileConfig?.providers) {
    setProviderOverrides(parseProviders(fileConfig.providers as Record<string, unknown>));
  }
  if (vault) {
    setProviderSecretsSource({ get: (id) => readProviderSecrets(vault, id) });
  }
}
