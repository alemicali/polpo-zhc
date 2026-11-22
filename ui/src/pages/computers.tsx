/**
 * Computers: the machines agents work on. "This server" is always there; a computer is a
 * persistent Daytona or E2B machine an agent keeps between chats and tasks (files, installed
 * tools, browser profile). Cards show the provider, live status, the agents using it, last use
 * and uptime (a rough cost signal), with Start / Stop / Restart / Reset / Delete. Machines stop
 * by themselves after their idle time and are never deleted automatically.
 * Live: `computer:changed` over SSE. The card, dialog and actions are shared with the agent's
 * Computer tab (components/computers, hooks/use-computer-actions).
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, Monitor, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { ComputerCard } from "@/components/computers/computer-card";
import { ComputerConfirmDialog } from "@/components/computers/computer-confirm-dialog";
import { ComputerDialog } from "@/components/computers/computer-dialog";
import { useComputerActions } from "@/hooks/use-computer-actions";
import { useComputers } from "@/hooks/use-computers";
import { useAgents } from "@polpo-ai/react";
import { harnessesApi, type HarnessSession } from "@/lib/harnesses-api";
import { agentEngineId } from "@/lib/run-context";
import type { Computer } from "@/lib/computers-api";

export function ComputersPage() {
  const { computers, loading, error, refresh, upsert, drop } = useComputers();
  const { busy, pending, setPending, run, confirm } = useComputerActions({ upsert, drop, refresh });
  const [dialog, setDialog] = useState<{ editing?: Computer } | null>(null);
  // which agents run on a harness (their mark next to them) and the harness sessions per computer
  const { agents } = useAgents();
  const agentEngines = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.name, agentEngineId((a as { engine?: unknown }).engine)])),
    [agents],
  );
  const [sessions, setSessions] = useState<HarnessSession[]>([]);
  useEffect(() => { void harnessesApi.sessions().then(setSessions).catch(() => setSessions([])); }, [computers.length]);

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 pb-bottom-nav sm:p-6 lg:pb-6">
      <PageHeader
        title="Computers"
        icon={Monitor}
        description="Machines agents keep between chats and tasks. Give an agent its computer in its Computer tab."
        actions={<>
          <Button variant="outline" onClick={() => void refresh(true)} aria-label="Refresh status"><RefreshCw className="h-4 w-4" /></Button>
          <Button onClick={() => setDialog({})}><Plus className="h-4 w-4" /> New computer</Button>
        </>}
      />

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          {error}
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => void refresh(true)}>Retry</Button>
        </div>
      )}

      {loading ? (
        <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading computers…</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {computers.map((c) => (
            <ComputerCard key={c.id} computer={c} busy={busy === c.id} onAction={(a) => void run(c, a)}
              agentEngines={agentEngines} harnessSessions={sessions.filter((s) => s.computerId === c.id)}>
              <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" disabled={busy === c.id} onClick={() => setDialog({ editing: c })} aria-label={`Edit ${c.name}`}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" disabled={busy === c.id} onClick={() => setPending({ computer: c, what: "delete" })} aria-label={`Delete ${c.name}`}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </ComputerCard>
          ))}
          {computers.filter((c) => !c.builtin).length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center">
              <p className="font-medium">No computers yet</p>
              <p className="text-sm text-muted-foreground">Give an agent its own machine: what it installs and saves is there next time.</p>
              <Button size="sm" onClick={() => setDialog({})}><Plus className="h-4 w-4" /> New computer</Button>
            </div>
          )}
        </div>
      )}

      {dialog && (
        <ComputerDialog
          key={dialog.editing?.id ?? "new"}
          open
          onOpenChange={(open) => { if (!open) setDialog(null); }}
          editing={dialog.editing}
          existingIds={computers.map((c) => c.id)}
          onSaved={(c) => { upsert(c); void refresh(false); }}
        />
      )}

      <ComputerConfirmDialog pending={pending} onCancel={() => setPending(null)} onConfirm={() => void confirm()} />
    </div>
  );
}
