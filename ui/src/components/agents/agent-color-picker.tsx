/**
 * The agent's colour (identity.color): one of the look's agent colour tokens (agent1 … agent10,
 * Configuration → Appearance → Agents), or "Auto" — the one picked from its name. Never a raw colour.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Palette } from "lucide-react";
import { useAgents, type AgentConfig } from "@polpo-ai/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { AGENT_COLOR_TOKENS, agentColor, agentColorClasses, agentColorIndexFromName, parseAgentColor } from "@/lib/agent-colors";

export function AgentColorPicker({ agent, onChanged }: { agent: AgentConfig; onChanged?: () => void | Promise<void> }) {
  const { updateAgent } = useAgents();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const chosen = parseAgentColor((agent.identity as { color?: unknown } | undefined)?.color);
  const current = agentColor(agent.name, chosen);
  const auto = agentColorIndexFromName(agent.name);

  const pick = async (token: string | null) => {
    setBusy(true);
    try {
      const identity = { ...(agent.identity ?? {}) } as Record<string, unknown>;
      if (token) identity.color = token;
      else delete identity.color;
      // the dashboard edits the draft: publish and deploy are explicit steps (Versions tab)
      await updateAgent(agent.name, { identity, publish: false } as Parameters<typeof updateAgent>[1]);
      await onChanged?.();
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to change the colour");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Agent colour" data-testid="agent-color-trigger"
          className="ml-auto inline-flex items-center gap-1.5 rounded-control px-1 py-0.5 hover:bg-accent/40">
          <span className={cn("size-3.5 rounded-pill", current.dot)} />
          <span className="text-foreground">{chosen ? `Colour ${current.index}` : "Auto"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-label text-muted-foreground">
          <Palette className="h-3.5 w-3.5" /> Colour
          {busy && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin" />}
        </div>
        <div className="grid grid-cols-5 gap-2">
          {AGENT_COLOR_TOKENS.map((token, i) => {
            const c = agentColorClasses(i + 1);
            const selected = chosen === token;
            return (
              <button key={token} type="button" disabled={busy} title={token} aria-label={token} aria-pressed={selected}
                onClick={() => void pick(token)}
                className={cn("flex size-9 items-center justify-center rounded-avatar text-caption font-semibold ring-offset-2 ring-offset-popover transition-transform hover:scale-105",
                  c.solid, selected && "ring-2 ring-ring")}>
                {selected ? <Check className="h-4 w-4" /> : i + 1}
              </button>
            );
          })}
        </div>
        <button type="button" disabled={busy} onClick={() => void pick(null)}
          className={cn("mt-2 flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs hover:bg-accent/40", !chosen && "bg-accent/30")}>
          <span className={cn("size-3.5 rounded-pill", agentColorClasses(auto).dot)} />
          Auto (from its name: colour {auto})
          {!chosen && <Check className="ml-auto h-3.5 w-3.5" />}
        </button>
        <p className="mt-2 text-micro text-muted-foreground">The colours come from the look: Configuration → Appearance → Agents.</p>
      </PopoverContent>
    </Popover>
  );
}
