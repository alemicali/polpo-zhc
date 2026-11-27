/**
 * A computer's page (/computers/:id): everything about one machine agents work on.
 *
 * - Header: provider mark, name, kind (Daytona v2, Daytona, E2B, This server), live status and the
 *   lifecycle actions its status allows (Start, Stop / Hibernate / Pause, Restart, Reset, Recreate),
 *   Edit and Delete (Remove from Polpo when its machine was deleted at the provider).
 * - Tiles: last use, uptime, when it stops or hibernates by itself, what was spent on it.
 * - Sessions: the agent harness sessions on it (Claude Code, Codex, OpenCode) and the recent task runs that
 *   used it (from each task's runs), with links; its recent activity (status changes, wakes,
 *   rotations, errors, a machine deleted at the provider).
 * - Aside: the agents using it; lifecycle; snapshots (Daytona v2); machine (image, region, size,
 *   ids, dates); network and egress (live Tailscale status of a remote computer's egress).
 *   Lifecycle, network, egress and size are edited with the computer's form.
 * - Live (Daytona computers): its desktop over VNC (the agents' headed browsers), view-only while
 *   the agent holds it; Take control / Give back, and the agents waiting for a person.
 * Live: `computer:changed` for this computer reloads it (from the cached state).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAgents, useEvents } from "@polpo-ai/react";
import { ArrowLeft, Loader2, Monitor, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ACTION_META, actionLabel } from "@/components/computers/computer-actions";
import { ComputerConfirmDialog } from "@/components/computers/computer-confirm-dialog";
import { ComputerDialog } from "@/components/computers/computer-dialog";
import { ComputerLivePanel } from "@/components/computers/computer-live-panel";
import { StatusBadge } from "@/components/computers/status-badge";
import { BrandIcon } from "@/components/shared/brand-icon";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { EngineBadge } from "@/components/shared/run-context";
import { EngineMark, RunModelWithEngine } from "@/components/shared/model-with-engine";
import { StatValue } from "@/components/shared/stat-value";
import { useComputerActions } from "@/hooks/use-computer-actions";
import type { HarnessSession } from "@/lib/harnesses-api";
import { agentEngineId, computerBrand, formatMs, formatUsd } from "@/lib/run-context";
import { NETWORK_MODES } from "@/lib/sandbox-api";
import {
  STATUS_SHORT_LABELS, availableActions, computersApi, formatBytes, formatLastUsed, formatUptime, kindLabel, stopLabel,
  type Computer, type ComputerDetail, type ComputerEgress,
} from "@/lib/computers-api";
import { cn } from "@/lib/utils";

const COMPUTER_EVENTS = ["computer:changed"];

function Section({ title, action, children, testId, className }: { title: string; action?: ReactNode; children: ReactNode; testId?: string; className?: string }) {
  return (
    <section className={cn("min-w-0 rounded-card border bg-card p-4", className)} data-testid={testId}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-heading text-h3">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: Array<[string, ReactNode] | false | undefined> }) {
  const shown = rows.filter((r): r is [string, ReactNode] => !!r);
  return (
    <dl className="grid grid-cols-[minmax(6.5rem,auto)_1fr] gap-x-3 gap-y-1.5 text-xs">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-xs text-muted-foreground">{children}</p>;

/** "in 12 min", "now", "3 h ago". */
function relative(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return formatLastUsed(iso, now);
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? "in a moment" : minutes < 60 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`;
}

const date = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString() : "—");
const size = (mb: number) => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);

function sessionTokens(s: HarnessSession): number | undefined {
  if (!s.tokens) return undefined;
  return s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite;
}

const compact = (n: number | undefined) => (n === undefined ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function SessionsList({ sessions }: { sessions: HarnessSession[] }) {
  if (!sessions.length) return <Empty>No agent harness session has run here (Claude Code and Codex agents keep theirs on their computer).</Empty>;
  return (
    <ul className="divide-y" data-testid="computer-sessions">
      {sessions.map((s) => {
        const ended = !s.live ? s.updatedAt : undefined;
        const duration = s.createdAt ? Date.parse(s.updatedAt) - Date.parse(s.createdAt) : undefined;
        return (
          <li key={s.key} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs first:pt-0 last:pb-0">
            <EngineMark engine={s.harness} size={14} className="font-medium" />
            <Link to={`/agents/${encodeURIComponent(s.agent)}`} className="truncate hover:underline">{s.agent}</Link>
            {s.taskId
              ? <Link to={`/tasks/${encodeURIComponent(s.taskId)}`} className="truncate text-muted-foreground hover:underline">task {s.taskId.slice(0, 8)}</Link>
              : <span className="text-muted-foreground">chat</span>}
            <span className={s.live ? "text-status-running" : s.state === "error" ? "text-destructive" : "text-muted-foreground"}>{s.live ? "running" : s.state}</span>
            <span className="ml-auto flex shrink-0 flex-wrap items-center gap-x-3 tabular-nums text-muted-foreground">
              <span title={s.createdAt ? `Started ${date(s.createdAt)}` : undefined}>{s.createdAt ? `started ${formatLastUsed(s.createdAt)}` : ""}</span>
              {ended && <span title={`Last activity ${date(ended)}`}>ended {formatLastUsed(ended)}</span>}
              {duration !== undefined && duration > 0 && <span>{formatMs(duration)}</span>}
              <span>{s.turns} turn{s.turns === 1 ? "" : "s"}</span>
              <span title="Tokens (input + output + cache)">{compact(sessionTokens(s))} tok</span>
              <span className="text-foreground">{formatUsd(s.costUsd) ?? "—"}</span>
            </span>
            {s.lastError && <p className="basis-full text-destructive">{s.lastError}</p>}
          </li>
        );
      })}
    </ul>
  );
}

const RUN_STATUS_TONE: Record<string, string> = { done: "text-success", failed: "text-destructive", killed: "text-destructive", running: "text-status-running" };

function RunsList({ runs }: { runs: ComputerDetail["runs"] }) {
  if (!runs.length) return <Empty>No task has run on it yet.</Empty>;
  return (
    <ul className="divide-y" data-testid="computer-runs">
      {runs.map((r) => (
        <li key={`${r.taskId}:${r.runId}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs first:pt-0 last:pb-0">
          <Link to={`/tasks/${encodeURIComponent(r.taskId)}`} className="min-w-0 max-w-full truncate font-medium hover:underline sm:max-w-[18rem]">{r.taskTitle}</Link>
          {r.agent && <Link to={`/agents/${encodeURIComponent(r.agent)}`} className="hover:underline">{r.agent}</Link>}
          <RunModelWithEngine run={r} pretty compact size={12} className="text-muted-foreground" testId="computer-run-model" />
          <span className={RUN_STATUS_TONE[r.status] ?? "text-muted-foreground"}>{r.status}</span>
          <span className="ml-auto flex shrink-0 items-center gap-x-3 tabular-nums text-muted-foreground">
            <span title={date(r.startedAt)}>{formatLastUsed(r.startedAt)}</span>
            {r.durationMs !== undefined && <span>{formatMs(r.durationMs)}</span>}
            {r.tokens !== undefined && <span>{compact(r.tokens)} tok</span>}
            <span className="text-foreground">{formatUsd(r.costUsd) ?? "—"}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ActivityList({ activity }: { activity: ComputerDetail["activity"] }) {
  if (!activity.length) return <Empty>Nothing recorded yet: starts, stops, hibernations, wakes and errors show here.</Empty>;
  return (
    <ol className="space-y-1.5" data-testid="computer-activity">
      {activity.map((a, i) => (
        <li key={`${a.at}:${i}`} className="flex min-w-0 gap-3 text-xs">
          <span className="w-20 shrink-0 tabular-nums text-muted-foreground" title={date(a.at)}>{formatLastUsed(a.at)}</span>
          {a.kind === "status" ? (
            <span className={cn("min-w-0", (a.status === "error" || a.status === "deleted") && "text-destructive")}>
              {a.from ? `${STATUS_SHORT_LABELS[a.from] ?? a.from} → ` : ""}{a.status ? STATUS_SHORT_LABELS[a.status] ?? a.status : ""}
              {a.message ? <span className="text-muted-foreground">: {a.message}</span> : null}
            </span>
          ) : (
            <span className={cn("min-w-0", a.level === "warn" ? "text-warning" : "text-muted-foreground")}>{a.message}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function EgressRows({ computer, egress }: { computer: Computer; egress: ComputerEgress | null | undefined }) {
  const network = computer.network
    ? `${NETWORK_MODES.find((m) => m.id === computer.network!.mode)?.label ?? computer.network.mode}${computer.network.allow?.length ? `: ${computer.network.allow.join(", ")}` : ""}`
    : "Inherited (the agent's or the instance's rule)";
  const route = !computer.egress
    ? "Direct"
    : computer.kind === "host" ? `Through the ${computer.egress} proxy` : `Through the ${computer.egress} proxy, via Tailscale in its VM`;
  return (
    <Rows rows={[
      ["Network", network],
      ["Browser egress", route],
      !!computer.egress && egress !== undefined && ["Now", egress === null ? "Could not be checked" : egress.effective ?? egress.note ?? "—"],
      !!egress?.tailnet && ["Tailnet", `${egress.tailnet}${egress.node ? ` as ${egress.node}` : ""}${egress.path ? `, path ${egress.path}` : ""}`],
      !!egress?.checkedAt && ["Checked", formatLastUsed(egress.checkedAt)],
      !!egress?.error && ["Problem", <span className="text-destructive">{egress.error}</span>],
    ]} />
  );
}

export function ComputerDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [computer, setComputer] = useState<ComputerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [egress, setEgress] = useState<ComputerEgress | null | undefined>(undefined);
  const { agents } = useAgents();
  const agentEngines = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.name, agentEngineId((a as { engine?: unknown }).engine)])),
    [agents],
  );

  const load = useCallback(async (live = true, fresh = false) => {
    try {
      const d = await computersApi.detail(id, fresh && live);
      setComputer(d);
      setError(null);
      setNotFound(false);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "NOT_FOUND") setNotFound(true);
      else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  // a remote computer's egress as seen from its VM (never starts it)
  const egressName = computer?.egress;
  const remote = computer?.kind === "daytona" || computer?.kind === "e2b";
  useEffect(() => {
    if (!egressName || !remote) { setEgress(undefined); return; }
    let alive = true;
    void computersApi.egress(id).then((e) => { if (alive) setEgress(e); }).catch(() => { if (alive) setEgress(null); });
    return () => { alive = false; };
  }, [id, egressName, remote, computer?.status]);

  // live: a change of this computer reloads it from the cached state
  const { events } = useEvents(COMPUTER_EVENTS, 20);
  const latest = events.at(-1);
  const [handled, setHandled] = useState(latest?.id);
  useEffect(() => {
    if (!latest || handled === latest.id) return;
    setHandled(latest.id);
    if ((latest.data as { id?: string } | undefined)?.id === id) void load(false);
  }, [latest, handled, id, load]);

  const { busy, pending, setPending, run, confirm } = useComputerActions({
    upsert: (c) => setComputer((cur) => (cur ? { ...cur, ...c } : cur)),
    drop: () => navigate("/computers"),
    refresh: async (live?: boolean) => { await load(live); },
  });

  if (loading && !computer) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }
  if (notFound || !computer) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 p-8 text-center">
        <p className="font-medium">{notFound ? `There is no computer "${id}"` : error ?? "Could not load the computer"}</p>
        <Button variant="outline" asChild><Link to="/computers"><ArrowLeft className="h-4 w-4" /> Computers</Link></Button>
      </div>
    );
  }

  const c = computer;
  const actions = availableActions(c);
  const isBusy = busy === c.id;
  const verb = stopLabel(c);
  const refreshNow = async () => {
    setRefreshing(true);
    try { await load(true, true); } finally { setRefreshing(false); }
  };
  const snapshotsBytes = c.snapshots.filter((s) => s.status === "ready").reduce((sum, s) => sum + (s.diskBytes ?? 0) + (s.memoryBytes ?? 0), 0);
  const editButton = !c.builtin && (
    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing(true)} aria-label={`Edit ${c.name}`}>
      <Pencil className="h-3.5 w-3.5" /> Edit
    </Button>
  );

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 pb-bottom-nav sm:p-6 lg:pb-6" data-testid="computer-page">
      <Link to="/computers" className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Computers
      </Link>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            {c.kind === "host" ? <Monitor className="h-5 w-5" /> : <BrandIcon name={computerBrand({ kind: c.kind })} size={26} />}
          </div>
          <div className="min-w-0">
            <h1 className="font-heading text-h1 flex min-w-0 flex-wrap items-center gap-2 text-foreground">
              <span className="min-w-0 break-words">{c.name}</span>
              <StatusBadge computer={c} live className="text-caption" />
            </h1>
            <p className="text-small text-muted-foreground" data-testid="computer-kind">
              {kindLabel(c)}{c.builtin ? " · agents without a computer work here" : ` · ${c.id}`}{c.description ? ` · ${c.description}` : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {actions.map((action) => {
            const Icon = ACTION_META[action].icon;
            const label = actionLabel(c, action);
            return (
              <Button key={action} size="sm" variant={action === "start" || action === "recreate" ? "default" : "outline"} disabled={isBusy}
                onClick={() => void run(c, action)} aria-label={`${label} ${c.name}`}>
                {isBusy && action === actions[0] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />} {label}
              </Button>
            );
          })}
          <Button size="sm" variant="outline" onClick={() => void refreshNow()} disabled={refreshing} aria-label="Refresh status">
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          </Button>
          {!c.builtin && (
            <Button size="sm" variant="ghost" className="text-destructive" disabled={isBusy} onClick={() => setPending({ computer: c, what: "delete" })}
              aria-label={c.status === "deleted" ? `Remove ${c.name} from Polpo` : `Delete ${c.name}`}>
              <Trash2 className="h-3.5 w-3.5" /> {c.status === "deleted" ? "Remove from Polpo" : "Delete"}
            </Button>
          )}
        </div>
      </header>

      {error && <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</p>}
      {c.status === "deleted" && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="status" data-testid="computer-deleted">
          <p className="font-medium text-destructive">Its machine was deleted at the provider{c.deletedAtProvider ? ` (found ${formatLastUsed(c.deletedAtProvider)})` : ""}.</p>
          <p className="text-muted-foreground">Recreate makes a new machine from its image (what the old one had is lost); or remove it from Polpo.</p>
        </div>
      )}
      {c.lastError && c.status === "error" && <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{c.lastError}</p>}
      {c.notice && c.status !== "deleted" && <p className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning" data-testid="computer-notice">{c.notice}</p>}
      {c.snapshotState && c.snapshotState !== "active" && (
        <p className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
          Snapshot {c.snapshotState}{c.snapshotState === "inactive" ? ": it is activated on the next start (a few minutes longer)" : ""}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 rounded-card border bg-card p-4 lg:grid-cols-4" data-testid="computer-stats">
        <StatValue size="sm" label="Last used" value={c.builtin ? "—" : formatLastUsed(c.lastUsedAt)} hint={c.lastUsedAt ? date(c.lastUsedAt) : undefined} />
        <StatValue size="sm" label="Uptime" value={formatUptime(c.uptimeMinutes)} hint="Time it ran (what the provider bills, roughly)" />
        <StatValue size="sm" label={c.status === "running" ? `${verb === "Stop" ? "Stops" : verb === "Pause" ? "Pauses" : "Hibernates"} when idle` : "Idle stop"}
          value={c.status === "running" && c.idleStopAt ? relative(c.idleStopAt) : c.builtin ? "—" : `${c.lifecycle?.idleStopMinutes ?? 15} min`}
          hint={c.status === "running" ? `after ${c.lifecycle?.idleStopMinutes ?? 15} min without use` : c.builtin ? undefined : "after this long without use"} />
        <StatValue size="sm" label="Spent on it" value={formatUsd(c.cost.totalUsd) ?? "$0"}
          hint={`task runs ${formatUsd(c.cost.runsUsd) ?? "$0"} · chats ${formatUsd(c.cost.chatSessionsUsd) ?? "$0"}`} />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          {c.kind === "daytona" && c.providerApi === "v2" && c.status !== "deleted" && (
            <Section title="Live" testId="computer-live-section"
              action={<span className="text-caption text-muted-foreground">its desktop: watch, take control</span>}>
              <ComputerLivePanel computerId={c.id} />
            </Section>
          )}
          <Section title="Harness sessions" testId="computer-sessions-section"
            action={<Badge variant="secondary" className="text-micro">{c.sessions.length}</Badge>}>
            <SessionsList sessions={c.sessions} />
          </Section>
          <Section title="Recent task runs" testId="computer-runs-section"
            action={<Badge variant="secondary" className="text-micro">{c.runs.length}</Badge>}>
            <RunsList runs={c.runs} />
          </Section>
          {!c.builtin && (
            <Section title="Activity" testId="computer-activity-section">
              <ActivityList activity={c.activity} />
            </Section>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <Section title="Agents" testId="computer-agents-section">
            {c.agents.length ? (
              <ul className="space-y-1.5 text-xs" data-testid="computer-agents">
                {c.agents.map((a) => (
                  <li key={a.name} className="flex min-w-0 items-center gap-1.5">
                    <AgentAvatar name={a.name} size="xs" />
                    <EngineBadge engine={agentEngines[a.name]} size={12} />
                    <Link to={`/agents/${encodeURIComponent(a.name)}`} className="truncate hover:underline">{a.name}</Link>
                    {!c.builtin && <span className="ml-auto shrink-0 text-muted-foreground">{a.isDefault ? "default" : "may use"}</span>}
                  </li>
                ))}
              </ul>
            ) : <Empty>No agent uses it: give it to one in the agent's Computer tab.</Empty>}
          </Section>

          {!c.builtin && (
            <Section title="Lifecycle" action={editButton} testId="computer-lifecycle">
              <Rows rows={[
                ["When idle", `${verb === "Stop" ? "Stops" : verb === "Pause" ? "Pauses" : "Hibernates"} after ${c.lifecycle?.idleStopMinutes ?? 15} min without use`],
                !!c.lifecycle?.autoArchiveDays && ["Archive", `after ${c.lifecycle.autoArchiveDays} d stopped`],
                c.status === "running" && !!c.runningSince && ["Running since", date(c.runningSince)],
                !!c.timeoutAt && ["VM wall clock", `${date(c.timeoutAt)} (rotated before, through a snapshot)`],
                !!c.hibernate && ["Safety snapshot", `every ${c.hibernate.safetySnapshotHours} h while it runs`],
                ["Never deleted", "only Reset and Delete remove its machine"],
              ]} />
            </Section>
          )}

          {c.providerApi === "v2" && (
            <Section title="Snapshots" testId="computer-snapshots"
              action={<span className="text-caption text-muted-foreground">{c.snapshots.length}{c.hibernate ? ` · keeps ${c.hibernate.keepSnapshots}` : ""}{snapshotsBytes ? ` · ${formatBytes(snapshotsBytes)}` : ""}</span>}>
              {c.snapshots.length ? (
                <ul className="space-y-1.5 text-xs">
                  {c.snapshots.map((s) => (
                    <li key={s.id} className="flex min-w-0 items-center gap-2" title={s.name}>
                      <span className="tabular-nums">{formatLastUsed(s.at)}</span>
                      <span className="truncate text-muted-foreground">
                        {[s.memoryBytes !== undefined ? `${formatBytes(s.memoryBytes)} memory` : "", s.diskBytes !== undefined ? `${formatBytes(s.diskBytes)} disk` : ""].filter(Boolean).join(" + ")}
                      </span>
                      <span className={cn("ml-auto shrink-0", s.status === "ready" ? "text-success" : "text-warning")}>{s.status}</span>
                    </li>
                  ))}
                </ul>
              ) : <Empty>No snapshot: it gets one when it hibernates (memory and disk; storage is billed).</Empty>}
            </Section>
          )}

          {!c.builtin && (
            <Section title="Machine" action={editButton} testId="computer-machine">
              <Rows rows={[
                ["Provider", kindLabel(c)],
                ["Made from", c.machine?.snapshot ? `snapshot ${c.machine.snapshot}` : c.machine?.image ? `image ${c.machine.image}` : c.machine?.template ? `template ${c.machine.template}` : "the provider's default"],
                !!c.machine?.region && ["Region", c.machine.region],
                ["Size", c.machine?.resources && (c.machine.resources.cpus || c.machine.resources.memoryMb || c.machine.resources.diskMb)
                  ? [c.machine.resources.cpus ? `${c.machine.resources.cpus} CPU` : "", c.machine.resources.memoryMb ? `${size(c.machine.resources.memoryMb)} memory` : "", c.machine.resources.diskMb ? `${size(c.machine.resources.diskMb)} disk` : ""].filter(Boolean).join(" · ")
                  : "the image's or the provider's"],
                ["Machine id", c.remoteId ? <span className="font-mono">{c.remoteId}</span> : c.status === "hibernated" ? "none while it hibernates" : "none yet"],
                !!c.createdAt && ["Created", date(c.createdAt)],
                !!c.updatedAt && ["Updated", date(c.updatedAt)],
              ]} />
            </Section>
          )}

          {!c.builtin && (
            <Section title="Network and egress" action={editButton} testId="computer-network">
              <EgressRows computer={c} egress={egress} />
            </Section>
          )}

          {c.builtin && (
            <Section title="This server">
              <p className="text-xs text-muted-foreground">
                Agents without a computer work here, in the sandbox set in <Link to="/config?section=sandbox" className="underline">Settings → Sandbox</Link>.
              </p>
            </Section>
          )}
        </aside>
      </div>

      {editing && (
        <ComputerDialog
          open
          onOpenChange={(open) => { if (!open) setEditing(false); }}
          editing={c}
          existingIds={[c.id]}
          onSaved={(saved) => { setComputer((cur) => (cur ? { ...cur, ...saved } : cur)); void load(false); }}
        />
      )}
      <ComputerConfirmDialog pending={pending} onCancel={() => setPending(null)} onConfirm={() => void confirm()} />
    </div>
  );
}
