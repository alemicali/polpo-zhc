/**
 * AgentComputerTab — the machine this agent works on, and its computers.
 *
 * - Header: where its chats and tasks run now (its default computer, or this server) and the
 *   default-computer picker. A task can still ask for an ephemeral sandbox
 *   (sandbox.computer: "ephemeral") or name another of its computers.
 * - Its computers (agent.computers + defaultComputer) as cards, with the Computers page's live
 *   status and Start / Stop / Restart / Reset, plus "Make default" and "Remove from this agent".
 * - Add one: an existing computer of the instance, or a new one (the Computers page's dialog,
 *   prefilled with the agent's name), assigned right after and optionally made the default.
 *
 * Assignments are `PATCH /agents/:name { defaultComputer, computers }`. Live: `computer:changed`.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, Monitor, Plus, RefreshCw, Save, Server, Star, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ComputerCard } from "@/components/computers/computer-card";
import { ComputerConfirmDialog } from "@/components/computers/computer-confirm-dialog";
import { ComputerDialog } from "@/components/computers/computer-dialog";
import { StatusBadge } from "@/components/computers/status-badge";
import { useComputerActions } from "@/hooks/use-computer-actions";
import { useComputers } from "@/hooks/use-computers";
import { KIND_LABELS, computersApi, suggestComputerId, type Computer } from "@/lib/computers-api";
import { useAgentDetail } from "./agent-detail-context";
import { AgentEngineCard } from "./agent-engine-card";

const selectClass = "h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs sm:flex-none sm:min-w-[12rem]";

const unique = (ids: string[]) => [...new Set(ids)];

export function AgentComputerTab() {
  const { state: { agent }, actions: { refetch }, meta: { agentName } } = useAgentDetail();
  const { computers, loading, error, refresh, upsert, drop } = useComputers();
  const { busy, pending, setPending, guard, run, confirm } = useComputerActions({ upsert, drop, refresh });

  const config = agent as { defaultComputer?: string; computers?: string[] };
  const defaultId = config.defaultComputer || "host";
  const allowed = config.computers ?? [];
  const displayName = agent.identity?.displayName ?? agent.name;

  const mineIds = unique([...(defaultId !== "host" ? [defaultId] : []), ...allowed]).filter((id) => id !== "host");
  const mine = mineIds.map((id) => computers.find((c) => c.id === id)).filter((c): c is Computer => !!c);
  const unknown = loading ? [] : mineIds.filter((id) => !computers.some((c) => c.id === id));
  const others = computers.filter((c) => !c.builtin && !mineIds.includes(c.id));
  const current = computers.find((c) => c.id === defaultId);

  // "Make it the default" for Add / New: on by default while the agent works on this server.
  const [makeDefaultChoice, setMakeDefault] = useState<boolean | null>(null);
  const makeDefault = makeDefaultChoice ?? defaultId === "host";
  const [pickedChoice, setPicked] = useState<string | null>(null);
  const picked = pickedChoice && others.some((c) => c.id === pickedChoice) ? pickedChoice : others[0]?.id ?? "";
  const [defaultChoice, setDefaultChoice] = useState<string | null>(null);
  const selectedDefault = defaultChoice ?? defaultId;
  const [creating, setCreating] = useState(false);

  /** PATCH the agent, then reload it and the computers' agent lists. */
  const assign = async (nextDefault: string, nextList: string[], message: string) => {
    await computersApi.assign(agentName, nextDefault, unique(nextList));
    await refetch();
    void refresh(false);
    toast.success(message);
  };

  const makeDefaultOf = (c: Computer) =>
    guard(c.id, () => assign(c.id, [...allowed, c.id], `${displayName} works on ${c.name}`));

  const removeFromAgent = (c: Computer | string) => {
    const id = typeof c === "string" ? c : c.id;
    const name = typeof c === "string" ? c : c.name;
    return guard(id, () => assign(
      defaultId === id ? "host" : defaultId,
      allowed.filter((x) => x !== id),
      defaultId === id ? `Removed ${name}: ${displayName} works on this server` : `Removed ${name} from ${displayName}`,
    ));
  };

  const addExisting = () => {
    const c = others.find((o) => o.id === picked);
    if (!c) return;
    return guard(c.id, async () => {
      await assign(makeDefault ? c.id : defaultId, [...allowed, c.id], makeDefault ? `${displayName} works on ${c.name}` : `Added ${c.name} to ${displayName}`);
      setPicked(null);
    });
  };

  const saveDefault = () => guard(selectedDefault, async () => {
    const chosen = computers.find((c) => c.id === selectedDefault);
    await assign(
      selectedDefault,
      selectedDefault === "host" ? allowed : [...allowed, selectedDefault],
      selectedDefault === "host" ? `${displayName} works on this server` : `${displayName} works on ${chosen?.name ?? selectedDefault}`,
    );
    setDefaultChoice(null);
  });

  const onCreated = async (c: Computer) => {
    upsert(c);
    try {
      await assign(makeDefault ? c.id : defaultId, [...allowed, c.id], makeDefault ? `${displayName} works on ${c.name}` : `Added ${c.name} to ${displayName}`);
    } catch (e) {
      toast.error(`Created ${c.name}, but could not assign it: ${(e as Error).message}`);
    }
  };

  const makeDefaultCheckbox = (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} aria-label="Make it the default computer" />
      Make it {displayName}'s default computer (its chats and tasks run there)
    </label>
  );

  return (
    <div>
      <div className="space-y-4 pb-bottom-nav pr-4 lg:pb-4">
        {/* Where it works now */}
        <Card className="gap-0 py-0" data-testid="agent-computer-header">
          <CardContent className="space-y-3 px-4 py-3 text-xs">
            <div className="flex items-center gap-1.5 text-label text-muted-foreground">
              <Monitor className="h-3 w-3" /> Works on
              <Button size="icon" variant="ghost" className="ml-auto h-6 w-6" onClick={() => void refresh(true)} aria-label="Refresh status">
                <RefreshCw className="h-3 w-3" />
              </Button>
            </div>
            {defaultId === "host" ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-sm font-medium" data-testid="agent-works-on"><Server className="h-4 w-4" /> This server (host)</p>
                <p className="text-muted-foreground">
                  Its chats and tasks run on this server, in a sandbox set in its <Link to="?tab=sandbox" className="underline">Sandbox tab</Link>:
                  what it installs or saves outside its outputs does not stay between runs.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium" data-testid="agent-works-on">
                  <Monitor className="h-4 w-4" /> {current?.name ?? defaultId}
                  {current && <span className="text-xs font-normal text-muted-foreground">{KIND_LABELS[current.kind]}</span>}
                  {current && <StatusBadge computer={current} />}
                </p>
                <p className="text-muted-foreground">
                  Its chats and tasks run on this computer: its files, installed tools and browser profile stay between runs. A task can
                  still ask for an ephemeral sandbox (<code>sandbox.computer: "ephemeral"</code>) or name another of its computers.
                </p>
              </div>
            )}
            {!loading && (
              <div className="flex flex-wrap items-center gap-2">
                <select aria-label="Default computer" className={selectClass} value={selectedDefault} onChange={(e) => setDefaultChoice(e.target.value)}>
                  {computers.map((c) => (
                    <option key={c.id} value={c.id}>{c.builtin ? "This server (host)" : `${c.name} · ${KIND_LABELS[c.kind]}`}</option>
                  ))}
                </select>
                <Button size="sm" className="h-8 text-xs" disabled={selectedDefault === defaultId || busy !== null} onClick={() => void saveDefault()}>
                  <Save className="h-3.5 w-3.5" /> Save default
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <AgentEngineCard />

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
            {error}
            <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => void refresh(true)}>Retry</Button>
          </div>
        )}

        {/* Its computers */}
        {loading ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading computers…</p>
        ) : mine.length === 0 && unknown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-center" data-testid="agent-computer-empty">
            <p className="font-medium">{displayName} has no computer</p>
            <p className="max-w-md text-sm text-muted-foreground">
              It runs on this server, in a fresh sandbox each time. Give it its own computer: the files, tools and browser sign-ins it
              sets up are there next time.
            </p>
            <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Create its computer</Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {mine.map((c) => {
              const isDefault = c.id === defaultId;
              return (
                <ComputerCard
                  key={c.id}
                  computer={c}
                  busy={busy === c.id}
                  onAction={(a) => void run(c, a)}
                  showAgents={false}
                  badge={isDefault ? <Badge variant="secondary" className="h-5 px-1.5 text-micro" data-testid="computer-default">Default</Badge> : undefined}
                >
                  <div className="flex w-full flex-wrap items-center gap-1.5 sm:ml-auto sm:w-auto">
                    {!isDefault && (
                      <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={busy === c.id} onClick={() => void makeDefaultOf(c)} aria-label={`Make ${c.name} the default`}>
                        <Star className="h-3.5 w-3.5" /> Make default
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs text-muted-foreground" disabled={busy === c.id} onClick={() => void removeFromAgent(c)} aria-label={`Remove ${c.name} from this agent`}>
                      <X className="h-3.5 w-3.5" /> Remove from this agent
                    </Button>
                  </div>
                </ComputerCard>
              );
            })}
            {unknown.map((id) => (
              <div key={id} className="flex items-center gap-2 rounded-xl border border-dashed p-4 text-xs text-muted-foreground" data-testid={`computer-unknown-${id}`}>
                <span className="min-w-0 flex-1">Computer <code>{id}</code> is not on this instance any more.</span>
                <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs" disabled={busy === id} onClick={() => void removeFromAgent(id)} aria-label={`Remove ${id} from this agent`}>
                  <X className="h-3.5 w-3.5" /> Remove
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Add one */}
        {!loading && (
          <Card className="gap-0 py-0" data-testid="agent-computer-add">
            <CardContent className="space-y-3 px-4 py-3 text-xs">
              <div className="text-label text-muted-foreground">Add a computer</div>
              <div className="flex flex-wrap items-center gap-2">
                {others.length > 0 && (
                  <>
                    <select aria-label="Existing computer" className={selectClass} value={picked} onChange={(e) => setPicked(e.target.value)}>
                      {others.map((c) => <option key={c.id} value={c.id}>{c.name} · {KIND_LABELS[c.kind]}</option>)}
                    </select>
                    <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!picked || busy !== null} onClick={() => void addExisting()}>
                      Add
                    </Button>
                    <span className="text-muted-foreground">or</span>
                  </>
                )}
                <Button size="sm" className="h-8 text-xs" onClick={() => setCreating(true)}>
                  <Plus className="h-3.5 w-3.5" /> New computer for {displayName}
                </Button>
              </div>
              {others.length > 0 && makeDefaultCheckbox}
              <p className="text-micro text-muted-foreground">
                All the instance's computers are on the <Link to="/computers" className="underline">Computers</Link> page.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {creating && (
        <ComputerDialog
          open
          onOpenChange={(open) => { if (!open) setCreating(false); }}
          initial={{ id: suggestComputerId(agent.name, computers.map((c) => c.id)), name: displayName }}
          existingIds={computers.map((c) => c.id)}
          onSaved={onCreated}
        >
          {makeDefaultCheckbox}
        </ComputerDialog>
      )}

      <ComputerConfirmDialog pending={pending} onCancel={() => setPending(null)} onConfirm={() => void confirm()} />
    </div>
  );
}
