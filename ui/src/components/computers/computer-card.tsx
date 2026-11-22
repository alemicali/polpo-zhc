/**
 * A computer as a card: provider, live status, snapshot notice, agents, last use, uptime, egress,
 * and the Start / Stop / Restart / Reset buttons its status allows. Shared by the Computers page
 * and the agent's Computer tab, which add their own trailing buttons (children) and badge.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Monitor, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/computers/status-badge";
import {
  KIND_LABELS, availableActions, formatLastUsed, formatSnapshot, formatUptime, type Computer, type ComputerAction,
} from "@/lib/computers-api";

const ACTION_META: Record<ComputerAction, { label: string; icon: typeof Play }> = {
  start: { label: "Start", icon: Play },
  stop: { label: "Stop", icon: Square },
  restart: { label: "Restart", icon: RefreshCw },
  reset: { label: "Reset", icon: RotateCcw },
};

export function ComputerCard({
  computer, busy, onAction, badge, showAgents = true, children,
}: {
  computer: Computer;
  busy: boolean;
  onAction: (action: ComputerAction) => void;
  /** Next to the name (e.g. "Default"). */
  badge?: ReactNode;
  /** The "Agents" row (the agent's own tab leaves it out). */
  showAgents?: boolean;
  /** Trailing buttons after the lifecycle actions (not shown for this server). */
  children?: ReactNode;
}) {
  const image = computer.snapshot ? `snapshot ${computer.snapshot}` : computer.image ? `image ${computer.image}` : computer.template ? `template ${computer.template}` : null;
  return (
    <div data-testid={`computer-card-${computer.id}`} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40"><Monitor className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 font-medium leading-tight">
            <span className="truncate">{computer.name}</span>
            {badge}
          </p>
          <p className="truncate text-xs text-muted-foreground">{KIND_LABELS[computer.kind]}{computer.builtin ? "" : ` · ${computer.id}`}{image ? ` · ${image}` : ""}</p>
        </div>
        <StatusBadge computer={computer} />
      </div>
      {computer.lastError && computer.status === "error" && <p className="text-xs text-destructive" role="alert">{computer.lastError}</p>}
      {computer.notice && <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="computer-notice">{computer.notice}</p>}
      {computer.snapshotState && computer.snapshotState !== "active" && (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="computer-snapshot">
          Snapshot {computer.snapshotState}{computer.snapshotState === "inactive" ? ": it is activated on the next start (a few minutes longer)" : ""}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {showAgents && (
          <>
            <dt className="text-muted-foreground">Agents</dt>
            <dd className="truncate" data-testid="computer-agents">
              {computer.agents.length ? computer.agents.map((a) => `${a.name}${a.isDefault || computer.builtin ? "" : " (may use)"}`).join(", ") : "none"}
            </dd>
          </>
        )}
        {!computer.builtin && (
          <>
            <dt className="text-muted-foreground">Last used</dt><dd>{formatLastUsed(computer.lastUsedAt)}</dd>
            <dt className="text-muted-foreground">Uptime</dt><dd title="Time it ran (what the provider bills, roughly)">{formatUptime(computer.uptimeMinutes)}</dd>
            {computer.kind !== "host" && (
              <><dt className="text-muted-foreground">Stops after</dt><dd>{computer.lifecycle?.idleStopMinutes ?? 15} idle min</dd></>
            )}
            {computer.lastSnapshot && (
              <>
                <dt className="text-muted-foreground">Last snapshot</dt>
                <dd className="truncate" data-testid="computer-last-snapshot" title={`Memory and disk saved at ${computer.lastSnapshot.at} (snapshot storage is billed)`}>
                  {formatSnapshot(computer.lastSnapshot)}
                </dd>
              </>
            )}
            {computer.egress && (
              <><dt className="text-muted-foreground">Egress</dt><dd className="truncate" data-testid="computer-egress">via {computer.egress} proxy</dd></>
            )}
          </>
        )}
      </dl>
      {computer.builtin ? (
        <p className="mt-auto text-xs text-muted-foreground">
          Agents without a computer work here, in the sandbox set in <Link to="/config?section=sandbox" className="underline">Settings → Sandbox</Link>.
        </p>
      ) : (
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          {availableActions(computer).map((action) => {
            const { label, icon: Icon } = ACTION_META[action];
            return (
              <Button key={action} size="sm" variant={action === "start" ? "default" : "outline"} className="h-7 px-2.5 text-xs" disabled={busy}
                onClick={() => onAction(action)} aria-label={`${label} ${computer.name}`}>
                <Icon className="h-3.5 w-3.5" /> {label}
              </Button>
            );
          })}
          {children}
        </div>
      )}
    </div>
  );
}
