/** Keeps the agents' chosen colours (identity.color) in lib/agent-colors' store, for every avatar. */
import { useEffect } from "react";
import { useAgents } from "@polpo-ai/react";
import { setAgentColorChoices } from "@/lib/agent-colors";

export function AgentColorsSync() {
  const { agents } = useAgents();
  useEffect(() => {
    if (agents) setAgentColorChoices(agents as Array<{ name: string; identity?: { color?: unknown } | null }>);
  }, [agents]);
  return null;
}
