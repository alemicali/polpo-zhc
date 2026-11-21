/**
 * The agent's computer, in its Sandbox tab: the machine its chats and tasks run on by default.
 * "This server" keeps the sandbox settings below; a computer is a persistent Daytona/E2B machine
 * (Computers page) that keeps its files between runs. A task can still ask for an ephemeral
 * sandbox (sandbox.computer: "ephemeral").
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Monitor, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/computers/status-badge";
import { useComputers } from "@/hooks/use-computers";
import { KIND_LABELS, computersApi } from "@/lib/computers-api";

export function AgentComputerCard({
  agentName, defaultComputer, computers: allowed, onSaved,
}: { agentName: string; defaultComputer?: string; computers?: string[]; onSaved: () => void | Promise<void> }) {
  const { computers, loading } = useComputers({ live: false });
  const current = defaultComputer || "host";
  const [choice, setChoice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selected = choice ?? current;
  const picked = computers.find((c) => c.id === selected);

  const save = async () => {
    setSaving(true);
    try {
      const list = selected === "host" ? allowed : [...new Set([...(allowed ?? []), selected])];
      await computersApi.assign(agentName, selected, list);
      await onSaved();
      setChoice(null);
      toast.success(selected === "host" ? "Runs on this server" : `Works on ${picked?.name ?? selected}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0" data-testid="agent-computer-card">
      <CardContent className="py-3 px-4 space-y-2 text-xs">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground"><Monitor className="h-3 w-3" /> Computer</div>
        <p className="text-muted-foreground">
          Where its chats and tasks run. A computer keeps its files, installed tools and browser profile between runs;{" "}
          <Link to="/computers" className="underline">manage computers</Link>.
        </p>
        {loading ? (
          <p className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Default computer"
              className="h-8 min-w-[12rem] rounded-md border bg-transparent px-2 text-xs"
              value={selected}
              onChange={(e) => setChoice(e.target.value)}
            >
              {computers.map((c) => (
                <option key={c.id} value={c.id}>{c.builtin ? "This server (sandbox below)" : `${c.name} · ${KIND_LABELS[c.kind]}`}</option>
              ))}
            </select>
            {picked && !picked.builtin && <StatusBadge computer={picked} />}
            <Button size="sm" className="h-8 text-xs" disabled={selected === current || saving} onClick={() => void save()}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
              Save
            </Button>
          </div>
        )}
        {selected !== "host" && (
          <p className="text-[10px] text-muted-foreground">
            The sandbox settings below apply only when a task asks for an ephemeral sandbox; on the computer, its own network rule applies.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
