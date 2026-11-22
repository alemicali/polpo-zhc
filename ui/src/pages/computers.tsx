/**
 * Computers: the machines agents work on. "This server" is always there; a computer is a
 * persistent Daytona or E2B machine an agent keeps between chats and tasks (files, installed
 * tools, browser profile). A list like the other pages (search, status and provider filters,
 * sort): each row shows the provider, live status, the agents using it, harness sessions,
 * egress, last use and snapshots, with its main action inline and the others in a menu; a row
 * opens the computer's page (/computers/:id). Machines stop by themselves
 * after their idle time and are never deleted automatically; one deleted at the provider shows as
 * "Deleted at provider", with Recreate and Remove from Polpo.
 * Live: `computer:changed` over SSE. The card, dialog and actions are shared with the agent's
 * Computer tab (components/computers, hooks/use-computer-actions).
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Activity, ArrowUpDown, Check, Cloud, Loader2, Monitor, Plus, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/shared/page-header";
import { MultiSelectFilter } from "@/components/shared/multi-select-filter";
import { ComputerConfirmDialog } from "@/components/computers/computer-confirm-dialog";
import { ComputerDialog } from "@/components/computers/computer-dialog";
import { ComputersTable } from "@/components/computers/computers-table";
import { useComputerActions } from "@/hooks/use-computer-actions";
import { useComputers } from "@/hooks/use-computers";
import { useAgents } from "@polpo-ai/react";
import { harnessesApi, type HarnessSession } from "@/lib/harnesses-api";
import { agentEngineId } from "@/lib/run-context";
import {
  STATUS_ORDER, STATUS_SHORT_LABELS, kindLabel, matchesComputer, sortComputers,
  type Computer, type ComputerSortKey, type ComputerStatus,
} from "@/lib/computers-api";
import { cn } from "@/lib/utils";

const SORT_OPTIONS: { value: ComputerSortKey; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "name", label: "Name" },
  { value: "lastUsed", label: "Last used" },
  { value: "uptime", label: "Uptime" },
];

const toggle = (set: Set<string>, value: string) => {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
};

export function ComputersPage() {
  const { computers, loading, error, refresh, upsert, drop } = useComputers();
  const { busy, pending, setPending, run, confirm } = useComputerActions({ upsert, drop, refresh });
  const [dialog, setDialog] = useState<{ editing?: Computer } | null>(null);
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<ComputerSortKey>("status");
  const [refreshing, setRefreshing] = useState(false);
  // which agents run on a harness (their mark next to them) and the harness sessions per computer
  const { agents } = useAgents();
  const agentEngines = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.name, agentEngineId((a as { engine?: unknown }).engine)])),
    [agents],
  );
  const [sessions, setSessions] = useState<HarnessSession[]>([]);
  useEffect(() => { void harnessesApi.sessions().then(setSessions).catch(() => setSessions([])); }, [computers.length]);

  // /computers#computer-<id> (older links) opens that computer's page
  const { hash } = useLocation();
  useEffect(() => {
    const m = /^#computer-(.+)$/.exec(hash);
    if (m) navigate(`/computers/${m[1]}`, { replace: true });
  }, [hash, navigate]);

  const statusOptions = useMemo(() => {
    const present = new Set(computers.map((c) => c.status));
    return STATUS_ORDER.filter((s) => present.has(s)).map((s) => ({ value: s, label: STATUS_SHORT_LABELS[s as ComputerStatus] }));
  }, [computers]);
  const kindOptions = useMemo(() => [...new Set(computers.map((c) => kindLabel(c)))].map((k) => ({ value: k })), [computers]);

  const shown = useMemo(() => sortComputers(
    computers.filter((c) => matchesComputer(c, search) && (!statuses.size || statuses.has(c.status)) && (!kinds.size || kinds.has(kindLabel(c)))),
    sortKey,
  ), [computers, search, statuses, kinds, sortKey]);
  const filtering = !!search.trim() || statuses.size > 0 || kinds.size > 0;
  const deletedCount = computers.filter((c) => c.status === "deleted").length;

  const refreshNow = async () => {
    setRefreshing(true);
    try { await refresh(true, true); } finally { setRefreshing(false); }
  };
  const askDelete = (c: Computer) => setPending({ computer: c, what: "delete" });

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 pb-bottom-nav sm:p-6 lg:pb-6">
      <PageHeader
        title="Computers"
        icon={Monitor}
        description="Machines agents keep between chats and tasks. Give an agent its computer in its Computer tab."
        actions={<>
          <Button variant="outline" onClick={() => void refreshNow()} disabled={refreshing} aria-label="Refresh status">
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          </Button>
          <Button onClick={() => setDialog({})}><Plus className="h-4 w-4" /> New computer</Button>
        </>}
      />

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          {error}
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => void refresh(true)}>Retry</Button>
        </div>
      )}

      {deletedCount > 0 && !loading && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="status" data-testid="computers-deleted-banner">
          <span className="text-destructive">
            {deletedCount === 1 ? "A computer's machine was" : `${deletedCount} computers' machines were`} deleted at the provider, outside Polpo.
          </span>
          <span className="text-muted-foreground">Recreate it (a new machine from the image, without its files) or remove it from Polpo.</span>
          {!statuses.has("deleted") && (
            <Button size="sm" variant="outline" className="h-7 sm:ml-auto" onClick={() => setStatuses(new Set(["deleted"]))}>Show</Button>
          )}
        </div>
      )}

      {loading ? (
        <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading computers…</p>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input placeholder="Search computers…" aria-label="Search computers" className="h-8 pl-8 pr-8 text-sm" value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && (
                <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex max-w-full items-center gap-1.5 overflow-x-auto scrollbar-none pb-0.5 sm:overflow-visible sm:pb-0">
              <MultiSelectFilter icon={<Activity className="h-3.5 w-3.5" />} label="Status" options={statusOptions} selected={statuses}
                onToggle={(v) => setStatuses((s) => toggle(s, v))} onClear={() => setStatuses(new Set())} />
              <MultiSelectFilter icon={<Cloud className="h-3.5 w-3.5" />} label="Provider" options={kindOptions} selected={kinds}
                onToggle={(v) => setKinds((s) => toggle(s, v))} onClear={() => setKinds(new Set())} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" aria-label="Sort computers">
                    <ArrowUpDown className="h-3 w-3" />
                    {SORT_OPTIONS.find((o) => o.value === sortKey)?.label}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {SORT_OPTIONS.map((o) => (
                    <DropdownMenuItem key={o.value} className={cn("gap-2 text-xs", sortKey === o.value && "font-medium")} onSelect={() => setSortKey(o.value)}>
                      {sortKey === o.value ? <Check className="h-3 w-3" /> : <span className="w-3" />}
                      {o.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {filtering && (
                <button type="button" className="shrink-0 text-micro text-muted-foreground hover:text-foreground"
                  onClick={() => { setSearch(""); setStatuses(new Set()); setKinds(new Set()); }}>
                  Clear
                </button>
              )}
            </div>
            <span className="shrink-0 text-caption tabular-nums text-muted-foreground sm:ml-auto" data-testid="computers-count">
              {filtering ? `${shown.length}/${computers.length}` : computers.length} computer{computers.length === 1 ? "" : "s"}
            </span>
          </div>

          {shown.length > 0 && (
            <ComputersTable
              computers={shown}
              busy={busy}
              agentEngines={agentEngines}
              sessions={sessions}
              onOpen={(c) => navigate(`/computers/${encodeURIComponent(c.id)}`)}
              onAction={(c, a) => void run(c, a)}
              onEdit={(c) => setDialog({ editing: c })}
              onDelete={askDelete}
            />
          )}
          {filtering && shown.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">No computer matches.</p>
          )}
          {!filtering && computers.filter((c) => !c.builtin).length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center">
              <p className="font-medium">No computers yet</p>
              <p className="text-sm text-muted-foreground">Give an agent its own machine: what it installs and saves is there next time.</p>
              <Button size="sm" onClick={() => setDialog({})}><Plus className="h-4 w-4" /> New computer</Button>
            </div>
          )}
        </>
      )}

      {dialog && (
        <ComputerDialog
          key={dialog.editing?.id ?? "new"}
          open
          onOpenChange={(isOpen) => { if (!isOpen) setDialog(null); }}
          editing={dialog.editing}
          existingIds={computers.map((c) => c.id)}
          onSaved={(c) => { upsert(c); void refresh(false); }}
        />
      )}

      <ComputerConfirmDialog pending={pending} onCancel={() => setPending(null)} onConfirm={() => void confirm()} />
    </div>
  );
}
