/**
 * AgentCommunicationSection — the agent's place in the org chart and its communication lines:
 * who it reports to, which agents it may talk to (ask_agent, message_agent, rooms) and whether it
 * refuses senders outside its own lines. Polpo always talks to every agent and an agent can always
 * escalate to its manager. Saving goes through the agent's normal update (draft → publish → deploy).
 * An agent without lines (created before them) talks to anyone: a hint suggests restricting it.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Loader2, Network } from "lucide-react";
import { toast } from "sonner";
import { useAgents } from "@polpo-ai/react";
import type { AgentConfig, AgentTalksTo } from "@polpo-ai/react";
import { reachableAgents, resolveAgentLines } from "@polpo-ai/core/agent-lines";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionHeader } from "@/components/shared/section-header";
import { cn } from "@/lib/utils";
import { useAgentDetail } from "./agent-detail-context";

type Mode = AgentTalksTo["mode"];

export const LINES_MODES: Array<{ id: Mode; label: string; help: string }> = [
  { id: "org", label: "Org chart", help: "Its manager, its direct reports and the extra agents below" },
  { id: "list", label: "Only listed agents", help: "Only the agents selected below" },
  { id: "anyone", label: "Anyone", help: "Every agent of the team" },
  { id: "none", label: "Nobody", help: "No other agent (Polpo still talks to it)" },
];

const NO_MANAGER = "__none__";

export function AgentCommunicationSection() {
  const { state: { agent }, actions: { refetch }, meta: { agentName } } = useAgentDetail();
  const { agents, updateAgent } = useAgents();

  const stored = agent.talksTo;
  const [mode, setMode] = useState<Mode | null>(null);
  const [extra, setExtra] = useState<string[] | null>(null);
  const [acceptLines, setAcceptLines] = useState<boolean | null>(null);
  const [manager, setManager] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const currentMode: Mode = mode ?? stored?.mode ?? "anyone";
  const currentExtra = extra ?? stored?.agents ?? [];
  const currentAccept = acceptLines ?? stored?.acceptFrom === "lines";
  const currentManager = manager ?? agent.reportsTo ?? NO_MANAGER;
  const others = useMemo(() => agents.filter((a: AgentConfig) => a.name !== agentName && !a.volatile), [agents, agentName]);
  const dirty = mode !== null || extra !== null || acceptLines !== null || manager !== null;

  const edited: AgentTalksTo = {
    mode: currentMode,
    ...(currentExtra.length && (currentMode === "org" || currentMode === "list") ? { agents: currentExtra } : {}),
    ...(currentAccept ? { acceptFrom: "lines" as const } : {}),
  };

  // who it would reach with the edited values (the team as it is, this agent edited)
  const preview = useMemo(() => {
    const self = { name: agentName, reportsTo: currentManager === NO_MANAGER ? undefined : currentManager, talksTo: edited };
    const team = [...agents.filter((a: AgentConfig) => a.name !== agentName), self];
    const lines = resolveAgentLines(self, team);
    return { reachable: reachableAgents(agentName, team), manager: lines.manager };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, agentName, currentManager, currentMode, currentExtra.join(","), currentAccept]);

  const reset = () => { setMode(null); setExtra(null); setAcceptLines(null); setManager(null); };

  const save = async (override?: { talksTo: AgentTalksTo }) => {
    setSaving(true);
    try {
      await updateAgent(agentName, {
        talksTo: override?.talksTo ?? edited,
        ...(override ? {} : { reportsTo: currentManager === NO_MANAGER ? "" : currentManager }),
      });
      reset();
      await refetch();
      toast.success("Communication lines saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleExtra = (name: string) => {
    setExtra(currentExtra.includes(name) ? currentExtra.filter((n) => n !== name) : [...currentExtra, name]);
  };

  return (
    <div data-testid="agent-communication">
      <SectionHeader title="Communication" icon={Network} />
      <Card className="py-0 gap-0">
        <CardContent className="pt-3 pb-3 space-y-4">
          {!stored && (
            <div className="flex flex-wrap items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2" data-testid="lines-unrestricted">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                Not restricted: this agent was created before communication lines and can talk to any agent.
                Restrict it to its org chart (its manager and direct reports).
              </p>
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={saving} onClick={() => save({ talksTo: { mode: "org" } })}>
                Use org chart lines
              </Button>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <p className="text-label text-muted-foreground">Reports to</p>
              <Select value={currentManager} onValueChange={setManager}>
                <SelectTrigger className="h-8 w-full text-xs" aria-label="Reports to">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MANAGER}>Nobody (top of the org chart)</SelectItem>
                  {others.map((a: AgentConfig) => (
                    <SelectItem key={a.name} value={a.name}>{a.identity?.displayName ?? a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-caption text-muted-foreground">It can always escalate to its manager.</p>
            </div>

            <div className="space-y-1.5">
              <p className="text-label text-muted-foreground">Talks to</p>
              <Select value={currentMode} onValueChange={(v) => setMode(v as Mode)}>
                <SelectTrigger className="h-8 w-full text-xs" aria-label="Communication lines">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LINES_MODES.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-caption text-muted-foreground">{LINES_MODES.find((m) => m.id === currentMode)?.help}</p>
            </div>
          </div>

          {(currentMode === "org" || currentMode === "list") && (
            <div className="space-y-1.5">
              <p className="text-label text-muted-foreground">{currentMode === "org" ? "Extra agents" : "Agents"}</p>
              {others.length === 0 ? (
                <p className="text-xs text-muted-foreground">No other agents yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5" data-testid="lines-agents">
                  {others.map((a: AgentConfig) => {
                    const on = currentExtra.includes(a.name);
                    return (
                      <button
                        key={a.name}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleExtra(a.name)}
                        className={cn(
                          "rounded-pill border px-2.5 py-0.5 text-xs transition-colors",
                          on ? "border-primary/40 bg-primary/15 text-primary" : "border-border/50 text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {a.identity?.displayName ?? a.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 text-xs">
            <Switch checked={currentAccept} onCheckedChange={(v) => setAcceptLines(!!v)} aria-label="Accept only its lines" />
            <span>Accept messages only from agents in its own lines</span>
          </label>

          <div className="space-y-1 border-t border-border/30 pt-3" data-testid="lines-preview">
            <p className="text-label text-muted-foreground">{dirty ? "Would talk to" : "Talks to now"}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {currentMode === "anyone" ? (
                <Badge variant="outline" className="text-micro">Any agent</Badge>
              ) : preview.reachable.length === 0 ? (
                <span className="text-xs text-muted-foreground">No other agent</span>
              ) : preview.reachable.map((n) => (
                <Link key={n} to={`/agents/${encodeURIComponent(n)}`}>
                  <Badge variant="secondary" className="text-micro">{n}</Badge>
                </Link>
              ))}
              <Badge variant="outline" className="text-micro">Polpo</Badge>
            </div>
          </div>

          {dirty && (
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={reset} disabled={saving}>Cancel</Button>
              <Button size="sm" className="h-7 text-xs" onClick={() => save()} disabled={saving}>
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                Save
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
