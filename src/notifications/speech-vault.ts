/**
 * The vault whose speech-to-text key a turn uses: the agent's own (then the environment). Polpo has
 * no vault: the environment, else the first agent's vault with a speech-to-text key.
 */
import type { Orchestrator } from "../core/orchestrator.js";
import { loadAgentVaultEntries, resolveAgentVault } from "../vault/index.js";

export async function speechVaultFor(
  orchestrator: Pick<Orchestrator, "getVaultStore" | "getAgents">,
  agent: string | undefined,
): Promise<ReturnType<typeof resolveAgentVault> | undefined> {
  const store = orchestrator.getVaultStore();
  if (agent) return resolveAgentVault(await loadAgentVaultEntries(store, agent));
  if (process.env.OPENAI_API_KEY || process.env.DEEPGRAM_API_KEY) return undefined;
  for (const a of await orchestrator.getAgents()) {
    const vault = resolveAgentVault(await loadAgentVaultEntries(store, a.name));
    if (vault.getKey("openai", "key") || vault.getKey("deepgram", "key")) return vault;
  }
  return undefined;
}
