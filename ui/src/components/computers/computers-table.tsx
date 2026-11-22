/**
 * The Computers page's list: one row per computer (provider mark, name and kind, live status,
 * agents with their engine, harness sessions, egress, last use, snapshots) with its main action
 * inline and the others in a menu. A row opens the computer's page. On a phone the row keeps
 * the name, the status and the menu (the rest is on its page).
 */
import type { KeyboardEvent, MouseEvent } from "react";
import { ChevronRight, Monitor, MoreHorizontal, PanelRightOpen, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ACTION_META, actionLabel } from "@/components/computers/computer-card";
import { StatusBadge } from "@/components/computers/status-badge";
import { BrandIcon } from "@/components/shared/brand-icon";
import { EngineBadge } from "@/components/shared/run-context";
import { HARNESS_NAMES, type HarnessSession } from "@/lib/harnesses-api";
import { computerBrand } from "@/lib/run-context";
import {
  availableActions, formatLastUsed, formatSnapshotSummary, kindLabel, type Computer, type ComputerAction,
} from "@/lib/computers-api";
import { cn } from "@/lib/utils";

const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

function ComputerMark({ computer }: { computer: Computer }) {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
      {computer.kind === "host" ? <Monitor className="h-4 w-4" /> : <BrandIcon name={computerBrand({ kind: computer.kind })} size={18} />}
    </div>
  );
}

function AgentsCell({ computer, agentEngines }: { computer: Computer; agentEngines?: Record<string, string | undefined> }) {
  const agents = computer.agents;
  if (!agents.length) return <span className="text-muted-foreground">none</span>;
  // "This server" serves every agent without a computer: a count is enough
  if (computer.builtin && agents.length > 3) return <span className="text-muted-foreground">{agents.length} agents</span>;
  const shown = agents.slice(0, agents.length > 3 ? 2 : 3);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5" data-testid="computer-agents">
      {shown.map((a, i) => (
        <span key={a.name} className="inline-flex min-w-0 items-center gap-1" title={a.isDefault || computer.builtin ? `${a.name} (default)` : `${a.name} may use it`}>
          <EngineBadge engine={agentEngines?.[a.name]} size={12} />
          <span className={cn("truncate", !a.isDefault && !computer.builtin && "text-muted-foreground")}>{a.name}{i < shown.length - 1 ? "," : ""}</span>
        </span>
      ))}
      {agents.length > shown.length && <span className="text-muted-foreground">+{agents.length - shown.length}</span>}
    </span>
  );
}

function HarnessCell({ sessions }: { sessions: HarnessSession[] }) {
  if (!sessions.length) return <span className="text-muted-foreground">—</span>;
  const harnesses = [...new Set(sessions.map((s) => s.harness))];
  const live = sessions.filter((s) => s.live).length;
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="computer-harness-sessions"
      title={sessions.map((s) => `${HARNESS_NAMES[s.harness]} · ${s.agent}${s.taskId ? ` · task ${s.taskId.slice(0, 8)}` : ""} · ${s.live ? "running" : s.state}`).join("\n")}>
      {harnesses.map((h) => <BrandIcon key={h} name={h} size={14} />)}
      <span className="tabular-nums">{sessions.length}</span>
      {live > 0 && <span className="text-status-running">· {live} live</span>}
    </span>
  );
}

export interface ComputersTableProps {
  computers: Computer[];
  busy: string | null;
  agentEngines?: Record<string, string | undefined>;
  /** Harness sessions (Claude Code, Codex), all computers. */
  sessions: HarnessSession[];
  onOpen: (computer: Computer) => void;
  onAction: (computer: Computer, action: ComputerAction) => void;
  onEdit: (computer: Computer) => void;
  onDelete: (computer: Computer) => void;
}

export function ComputersTable({ computers, busy, agentEngines, sessions, onOpen, onAction, onEdit, onDelete }: ComputersTableProps) {
  return (
    <div className="overflow-hidden rounded-card border bg-card">
      <Table data-testid="computers-table">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-3 sm:pl-4">Computer</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden md:table-cell">Agents</TableHead>
            <TableHead className="hidden lg:table-cell">Harness</TableHead>
            <TableHead className="hidden xl:table-cell">Egress</TableHead>
            <TableHead className="hidden sm:table-cell">Last used</TableHead>
            <TableHead className="hidden xl:table-cell">Snapshots</TableHead>
            <TableHead className="w-0 pr-3 text-right sm:pr-4"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {computers.map((c) => {
            const isBusy = busy === c.id;
            const actions = availableActions(c);
            const primary = actions[0];
            const image = c.snapshot ?? c.image ?? c.template;
            return (
              <TableRow
                key={c.id}
                data-testid={`computer-row-${c.id}`}
                tabIndex={0}
                aria-label={`${c.name} details`}
                className={cn("cursor-pointer", c.status === "deleted" && "bg-destructive/[0.03]")}
                onClick={() => onOpen(c)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(c); } }}
              >
                <TableCell className="max-w-0 py-2.5 pl-3 sm:pl-4">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <ComputerMark computer={c} />
                    <div className="min-w-0">
                      <p className="truncate font-medium leading-tight">{c.name}</p>
                      <p className="truncate text-caption text-muted-foreground" data-testid="computer-kind">
                        {kindLabel(c)}{c.builtin ? "" : ` · ${c.id}`}{image ? <span className="hidden lg:inline"> · {image}</span> : null}
                        {!c.builtin && <span className="sm:hidden"> · {formatLastUsed(c.lastUsedAt)}</span>}
                      </p>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="py-2.5">
                  <StatusBadge computer={c} live short className="text-micro" />
                </TableCell>
                <TableCell className="hidden max-w-[16rem] py-2.5 text-caption md:table-cell">
                  <AgentsCell computer={c} agentEngines={agentEngines} />
                </TableCell>
                <TableCell className="hidden py-2.5 text-caption lg:table-cell">
                  <HarnessCell sessions={sessions.filter((s) => s.computerId === c.id)} />
                </TableCell>
                <TableCell className="hidden py-2.5 text-caption xl:table-cell" data-testid="computer-egress">
                  {c.egress ? <span>via {c.egress}</span> : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="hidden py-2.5 text-caption tabular-nums sm:table-cell" data-testid="computer-last-used">
                  {c.builtin ? <span className="text-muted-foreground">—</span> : formatLastUsed(c.lastUsedAt)}
                </TableCell>
                <TableCell className="hidden py-2.5 text-caption tabular-nums xl:table-cell" data-testid="computer-snapshots"
                  title={c.lastSnapshot ? `Newest: ${c.lastSnapshot.at} (snapshot storage is billed)` : undefined}>
                  {formatSnapshotSummary(c)}
                </TableCell>
                <TableCell className="py-2.5 pr-3 text-right sm:pr-4" onClick={stop} onKeyDown={stop}>
                  <div className="flex items-center justify-end gap-1">
                    {primary && (() => {
                      const Icon = ACTION_META[primary].icon;
                      const label = actionLabel(c, primary);
                      return (
                        <Button size="sm" variant={primary === "start" || primary === "recreate" ? "default" : "outline"}
                          className="hidden h-7 px-2.5 text-xs sm:inline-flex" disabled={isBusy}
                          onClick={() => onAction(c, primary)} aria-label={`${label} ${c.name}`}>
                          <Icon className="h-3.5 w-3.5" /> {label}
                        </Button>
                      );
                    })()}
                    {c.builtin ? (
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => onOpen(c)} aria-label={`Open ${c.name}`}>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-7 w-7" disabled={isBusy} aria-label={`More actions for ${c.name}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-44">
                          {actions.map((action) => {
                            const Icon = ACTION_META[action].icon;
                            return (
                              <DropdownMenuItem key={action} className="gap-2 text-xs" onSelect={() => onAction(c, action)}>
                                <Icon className="h-3.5 w-3.5" /> {actionLabel(c, action)}
                              </DropdownMenuItem>
                            );
                          })}
                          {actions.length > 0 && <DropdownMenuSeparator />}
                          <DropdownMenuItem className="gap-2 text-xs" onSelect={() => onOpen(c)}>
                            <PanelRightOpen className="h-3.5 w-3.5" /> Open
                          </DropdownMenuItem>
                          <DropdownMenuItem className="gap-2 text-xs" onSelect={() => onEdit(c)}>
                            <Pencil className="h-3.5 w-3.5" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem className="gap-2 text-xs text-destructive focus:text-destructive" onSelect={() => onDelete(c)}>
                            <Trash2 className="h-3.5 w-3.5" /> {c.status === "deleted" ? "Remove from Polpo" : "Delete"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
