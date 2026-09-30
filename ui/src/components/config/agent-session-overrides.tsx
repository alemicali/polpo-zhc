/**
 * Per-agent conversation settings for an inbound channel.
 *
 * Edits `gateway.agentSessions`: for each agent, whether channel messages
 * continue the web chat ("shared") or stay separate ("per-peer"), and when a
 * conversation expires (0 = never). Unset values inherit the channel defaults.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, X } from "lucide-react";
import type { PolpoApi } from "./telegram-connect";

type SessionMode = "per-peer" | "shared";
export interface AgentSessionSettings { sessionMode?: SessionMode; sessionIdleMinutes?: number }

const INHERIT = "inherit";
const NEVER = "never";

export function AgentSessionOverrides({ api, value, onChange }: {
  api: PolpoApi;
  value: Record<string, AgentSessionSettings> | undefined;
  onChange: (next: Record<string, AgentSessionSettings> | undefined) => void;
}) {
  const [agents, setAgents] = useState<string[]>([]);
  const overrides = value ?? {};

  useEffect(() => {
    let cancelled = false;
    void api("/agents").then((res) => {
      if (!cancelled && res.ok) setAgents(((res.data ?? []) as { name: string }[]).map((a) => a.name).sort());
    });
    return () => { cancelled = true; };
  }, [api]);

  const update = (agent: string, patch: AgentSessionSettings | null) => {
    const next = { ...overrides };
    if (patch === null) delete next[agent];
    else next[agent] = Object.fromEntries(Object.entries({ ...next[agent], ...patch }).filter(([, v]) => v !== undefined));
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };

  const available = agents.filter((a) => !(a in overrides));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium">Per-agent conversations</span>
        {available.length > 0 && (
          <Select value="" onValueChange={(agent) => update(agent, { sessionMode: "shared" })}>
            <SelectTrigger className="h-7 w-auto text-[11px] gap-1"><Plus className="h-3 w-3" /><SelectValue placeholder="Add agent" /></SelectTrigger>
            <SelectContent>
              {available.map((a) => <SelectItem key={a} value={a} className="text-xs">{a}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>
      {Object.keys(overrides).length === 0 && (
        <p className="text-[10px] leading-relaxed text-muted-foreground">All agents use the channel settings above. Add an agent to give it its own behaviour.</p>
      )}
      {Object.entries(overrides).map(([agent, settings]) => {
        const idle = settings.sessionIdleMinutes;
        return (
          <div key={agent} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-1.5">
            <code className="font-mono text-[11px] truncate">{agent}</code>
            <Select value={settings.sessionMode ?? INHERIT} onValueChange={(v) => update(agent, { sessionMode: v === INHERIT ? undefined : v as SessionMode })}>
              <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT} className="text-xs">Channel default</SelectItem>
                <SelectItem value="per-peer" className="text-xs">Separate</SelectItem>
                <SelectItem value="shared" className="text-xs">Continue web chat</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1">
              <Select
                value={idle === undefined ? INHERIT : idle === 0 ? NEVER : "custom"}
                onValueChange={(v) => update(agent, { sessionIdleMinutes: v === INHERIT ? undefined : v === NEVER ? 0 : (idle || 60) })}
              >
                <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT} className="text-xs">Default timeout</SelectItem>
                  <SelectItem value={NEVER} className="text-xs">Never expires</SelectItem>
                  <SelectItem value="custom" className="text-xs">Minutes…</SelectItem>
                </SelectContent>
              </Select>
              {idle !== undefined && idle > 0 && (
                <Input className="h-7 w-16 text-[11px] font-mono" type="number" min={1} value={idle}
                  onChange={(e) => update(agent, { sessionIdleMinutes: Math.max(1, Number(e.target.value) || 1) })} />
              )}
            </div>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => update(agent, null)} aria-label={`Remove ${agent}`}>
              <X className="h-3 w-3" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
