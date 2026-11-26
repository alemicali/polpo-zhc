/**
 * A computer as a card: provider, live status, snapshot notice, agents, last use, uptime, egress,
 * and the Start / Stop / Restart / Reset buttons its status allows. Shared by the Computers page
 * and the agent's Computer tab, which add their own trailing buttons (children) and badge.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Monitor } from "lucide-react";
import { ACTION_META, actionLabel } from "@/components/computers/computer-actions";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/computers/status-badge";
import { BrandIcon } from "@/components/shared/brand-icon";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { EngineBadge } from "@/components/shared/run-context";
import { CLI_NAMES, HARNESS_NAMES, type HarnessSession } from "@/lib/harnesses-api";
import { computerBrand, formatUsd } from "@/lib/run-context";
import {
  availableActions, formatLastUsed, formatSnapshot, formatUptime, kindLabel, type Computer, type ComputerAction,
} from "@/lib/computers-api";

export function ComputerCard({
  computer, busy, onAction, badge, showAgents = true, agentEngines, harnessSessions, children,
}: {
  computer: Computer;
  busy: boolean;
  onAction: (action: ComputerAction) => void;
  /** Next to the name (e.g. "Default"). */
  badge?: ReactNode;
  /** The "Agents" row (the agent's own tab leaves it out). */
  showAgents?: boolean;
  /** Each agent's engine ("polpo" or { harness }): its mark next to the agent. */
  agentEngines?: Record<string, string | undefined>;
  /** The agent harness sessions (Claude Code, Codex, OpenCode) bound to this computer. */
  harnessSessions?: HarnessSession[];
  /** Trailing buttons after the lifecycle actions (not shown for this server). */
  children?: ReactNode;
}) {
  const image = computer.snapshot ? `snapshot ${computer.snapshot}` : computer.image ? `image ${computer.image}` : computer.template ? `template ${computer.template}` : null;
  return (
    <div id={`computer-${computer.id}`} data-testid={`computer-card-${computer.id}`} className="flex flex-col gap-3 rounded-card border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
          {computer.kind === "host" ? <Monitor className="h-4 w-4" /> : <BrandIcon name={computerBrand({ kind: computer.kind })} size={20} />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 font-medium leading-tight">
            <span className="truncate">{computer.name}</span>
            {badge}
          </p>
          <p className="truncate text-xs text-muted-foreground">{kindLabel(computer)}{computer.builtin ? "" : ` · ${computer.id}`}{image ? ` · ${image}` : ""}</p>
        </div>
        <StatusBadge computer={computer} />
      </div>
      {computer.lastError && computer.status === "error" && <p className="text-xs text-destructive" role="alert">{computer.lastError}</p>}
      {computer.notice && <p className={computer.status === "deleted" ? "text-xs text-destructive" : "text-xs text-warning"} data-testid="computer-notice">{computer.notice}</p>}
      {computer.snapshotState && computer.snapshotState !== "active" && (
        <p className="text-xs text-warning" data-testid="computer-snapshot">
          Snapshot {computer.snapshotState}{computer.snapshotState === "inactive" ? ": it is activated on the next start (a few minutes longer)" : ""}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {showAgents && (
          <>
            <dt className="text-muted-foreground">Agents</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5" data-testid="computer-agents">
              {computer.agents.length ? computer.agents.map((a, i) => (
                <span key={a.name} className="inline-flex min-w-0 items-center gap-1">
                  <AgentAvatar name={a.name} size="xs" />
                  <EngineBadge engine={agentEngines?.[a.name]} size={12} />
                  <span className="truncate">{a.name}{a.isDefault || computer.builtin ? "" : " (may use)"}{i < computer.agents.length - 1 ? "," : ""}</span>
                </span>
              )) : "none"}
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
      {harnessSessions && harnessSessions.length > 0 && (
        <div className="space-y-1" data-testid="computer-harness-sessions">
          <p className="text-label text-muted-foreground">Harness sessions</p>
          {harnessSessions.map((s) => (
            <div key={s.key} className="flex min-w-0 items-center gap-1.5 text-xs" title={`${s.engine === "cli" ? `${CLI_NAMES[s.cli ?? "claude"]} · ${s.account ?? ""}` : HARNESS_NAMES[s.harness]} · ${s.key}`}>
              <BrandIcon name={s.harness} size={14} />
              <span className="truncate">{s.agent}{s.taskId ? <span className="text-muted-foreground"> · task {s.taskId.slice(0, 8)}</span> : null}</span>
              <span className={s.live ? "text-status-running" : s.state === "error" ? "text-destructive" : "text-muted-foreground"}>{s.live ? "running" : s.state}</span>
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{formatUsd(s.costUsd)}</span>
            </div>
          ))}
        </div>
      )}
      {computer.builtin ? (
        <p className="mt-auto text-xs text-muted-foreground">
          Agents without a computer work here, in the sandbox set in <Link to="/config?section=sandbox" className="underline">Settings → Sandbox</Link>.
        </p>
      ) : (
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          {availableActions(computer).map((action) => {
            const { icon: Icon } = ACTION_META[action];
            const label = actionLabel(computer, action);
            return (
              <Button key={action} size="sm" variant={action === "start" || action === "recreate" ? "default" : "outline"} className="h-7 px-2.5 text-xs" disabled={busy}
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
