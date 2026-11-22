/**
 * Where and with what a task run executed (Task.runs): the engine with its official mark (Claude
 * Code, Codex, Polpo) and model, the harness authentication (Bedrock, Vertex AI, API key), the
 * computer (Daytona v0/v2, E2B, this server) with its live status, the browser egress (direct, or
 * a proxy through Tailscale), the harness session (new or resumed, bootstrap time), the cost
 * (the harness's estimate or the model's) against the budget, and the runs before it.
 *
 * - RunContextCard: the task detail page.
 * - EngineBadge / RunBadge: small marks for lists, cards and the activity feed.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Globe, History, Timer } from "lucide-react";
import type { TaskRunContext, TaskRunSummary } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { BrandIcon } from "@/components/shared/brand-icon";
import { StatusBadge } from "@/components/computers/status-badge";
import type { Computer } from "@/lib/computers-api";
import {
  agentEngineId, latestRun, AUTH_LABELS, authBrand, computerBrand, computerKindLabel, engineBrand, engineDetail, engineLabel, formatMs, formatUsd, modelLabel,
} from "@/lib/run-context";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<TaskRunContext["status"], string> = {
  running: "border-status-running/30 bg-status-running/10 text-status-running",
  completed: "border-success/30 bg-success/10 text-success",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  killed: "border-warning/30 bg-warning/10 text-warning",
};

/** An engine's mark (and optionally its name and model). Nothing for Polpo's engine unless `showPolpo`. */
export function EngineBadge({
  engine, model, withLabel = false, showPolpo = false, size = 14, className,
}: {
  engine: string | undefined;
  model?: string;
  withLabel?: boolean;
  showPolpo?: boolean;
  size?: number;
  className?: string;
}) {
  if ((!engine || engine === "polpo") && !showPolpo) return null;
  const name = engineLabel(engine);
  const m = modelLabel(model);
  const title = `${name}${m ? ` · ${m}` : ""}`;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)} title={title} data-testid="engine-badge" data-engine={engine ?? "polpo"}>
      <BrandIcon name={engineBrand(engine)} size={size} title={name} />
      {withLabel && <span className="truncate">{name}{m ? <span className="text-muted-foreground"> · {m}</span> : null}</span>}
    </span>
  );
}

/** The latest run's engine (when not Polpo's) and remote computer as small marks, with a tooltip. */
export function RunBadge({ run, size = 14, className }: { run: TaskRunSummary | undefined; size?: number; className?: string }) {
  if (!run) return null;
  const remote = run.computerKind !== "host";
  if (run.engine === "polpo" && !remote) return null;
  const where = run.computerKind === "ephemeral"
    ? `ephemeral ${run.provider ?? ""} sandbox`.replace("  ", " ")
    : run.computerKind === "host" ? "this server" : `${run.computerName ?? run.computerId} (${computerKindLabel({ kind: run.computerKind, provider: run.provider as "daytona" | "e2b" | undefined })})`;
  const m = modelLabel(run.model);
  const title = `${engineLabel(run.engine)}${m ? ` · ${m}` : ""} · on ${where}`;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-0.5", className)} title={title} aria-label={title} data-testid="run-badge" data-engine={run.engine}>
      {run.engine !== "polpo" && <BrandIcon name={engineBrand(run.engine)} size={size} />}
      {remote && <BrandIcon name={computerBrand({ kind: run.computerKind, provider: run.provider as "daytona" | "e2b" | undefined })} size={size - 2} />}
    </span>
  );
}

/**
 * A task's engine mark for lists: its latest run (engine and remote computer), else the engine its
 * agent is set to (before the first run). Nothing for Polpo's engine on this server.
 */
export function TaskEngineBadge({
  task, agentEngine, size = 12, className,
}: {
  task: { runs?: TaskRunContext[]; lastRun?: TaskRunSummary };
  agentEngine?: unknown;
  size?: number;
  className?: string;
}) {
  const run = latestRun(task);
  if (run) return <RunBadge run={run} size={size} className={className} />;
  const engine = agentEngineId(agentEngine);
  return engine === "polpo" ? null : <EngineBadge engine={engine} size={size} className={className} />;
}

function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <p className="text-label text-muted-foreground">{label}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-small">{children}</div>
    </div>
  );
}

function RunDetail({ run, computer }: { run: TaskRunContext; computer?: Computer }) {
  const isHarness = run.engine !== "polpo";
  const detail = engineDetail(run);
  const usd = run.cost?.harnessUsd ?? run.cost?.modelUsd;
  const costLabel = run.cost?.harnessUsd !== undefined ? `${engineLabel(run.engine)} estimate` : run.cost?.modelUsd !== undefined ? "model cost" : undefined;
  const budgetPct = run.budgetUsd && usd !== undefined ? Math.min(100, (usd / run.budgetUsd) * 100) : undefined;
  const c = run.computer;
  const computerName = c.kind === "host" && c.id === "host" ? "This server" : c.kind === "ephemeral" ? "Ephemeral sandbox" : c.name ?? computer?.name ?? c.id;

  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="run-context-detail" data-run={run.runId}>
      <Cell label="Engine">
        <BrandIcon name={engineBrand(run.engine)} size={18} />
        <span className="font-medium" data-testid="run-engine">{engineLabel(run.engine)}</span>
        {detail && <span className="text-muted-foreground" data-testid="run-model" title={run.model}>{detail}</span>}
        {run.auth && (
          <span className="inline-flex items-center gap-1 text-muted-foreground" title={`${AUTH_LABELS[run.auth.kind] ?? run.auth.kind}${run.auth.region ? ` · ${run.auth.region}` : ""}`}>
            <BrandIcon name={authBrand(run.auth.kind, run.engine)} size={14} />
            {run.auth.region && <span className="text-caption">{run.auth.region}</span>}
          </span>
        )}
        {isHarness && run.permissionMode && run.permissionMode !== "allow-all" && <Badge variant="outline" className="text-micro">{run.permissionMode}</Badge>}
      </Cell>

      <Cell label="Computer">
        <BrandIcon name={computerBrand(c)} size={16} />
        {c.kind === "host" || c.kind === "ephemeral" ? (
          <span className="font-medium" data-testid="run-computer">{computerName}</span>
        ) : (
          <Link to={`/computers#computer-${encodeURIComponent(c.id)}`} className="inline-flex items-center gap-0.5 font-medium hover:underline" data-testid="run-computer">
            {computerName}<ArrowUpRight className="h-3 w-3 text-muted-foreground" />
          </Link>
        )}
        <Badge variant="outline" className="text-micro font-normal" data-testid="run-computer-kind">{computerKindLabel(c)}</Badge>
        {computer && <StatusBadge computer={computer} className="text-micro" />}
        {c.remoteId && <span className="truncate font-mono text-micro text-muted-foreground" title="The provider's machine id">{c.remoteId}</span>}
      </Cell>

      <Cell label="Egress">
        {run.egress.mode === "proxy" ? (
          <span className="inline-flex items-center gap-1" data-testid="run-egress">
            {run.egress.tailscale ? <BrandIcon name="tailscale" size={14} /> : <Globe className="h-3.5 w-3.5 text-muted-foreground" />}
            <span className="font-medium">{run.egress.proxy}</span>
            <span className="text-muted-foreground">{run.egress.tailscale ? "via Tailscale" : "proxy"}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-muted-foreground" data-testid="run-egress"><Globe className="h-3.5 w-3.5" /> Direct</span>
        )}
      </Cell>

      <Cell label="Session">
        {run.session ? (
          <span className="inline-flex items-center gap-1" data-testid="run-session">
            <Badge variant="outline" className={cn("text-micro font-normal", run.session.resumed ? "border-info/30 bg-info/10 text-info" : "")}>
              {run.session.resumed ? "Resumed" : "New"}
            </Badge>
            {run.session.bootstrapMs !== undefined && (
              <span className="inline-flex items-center gap-0.5 text-muted-foreground" title={run.session.resumed ? "Time to re-attach the session" : "Time to start the runtime (bootstrap included)"}>
                <Timer className="h-3 w-3" />{formatMs(run.session.bootstrapMs)}
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground" data-testid="run-session">{isHarness ? (run.status === "running" ? "Starting…" : "—") : run.continuation ? "Continued" : "In process"}</span>
        )}
      </Cell>

      <Cell label="Cost">
        <div className="w-full space-y-1" data-testid="run-cost">
          <div className="flex items-baseline gap-1.5">
            <span className="font-medium tabular-nums">{formatUsd(usd) ?? "—"}</span>
            {run.budgetUsd ? <span className="text-caption text-muted-foreground">of {formatUsd(run.budgetUsd)} budget</span> : costLabel ? <span className="text-caption text-muted-foreground">{costLabel}</span> : null}
          </div>
          {budgetPct !== undefined && (
            <Progress value={budgetPct} className={cn("h-1.5", budgetPct >= 90 && "[&>[data-slot=progress-indicator]]:bg-destructive")} aria-label="Budget used" data-testid="run-budget" />
          )}
          {run.cost?.tokens ? <p className="text-caption text-muted-foreground">{(run.cost.tokens / 1000).toFixed(1)}k tokens</p> : null}
        </div>
      </Cell>
    </div>
  );
}

/** The task detail page's Run card: the latest run (or the one picked) and the runs before it. */
export function RunContextCard({ runs, computers, className }: { runs: TaskRunContext[] | undefined; computers?: Computer[]; className?: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  if (!runs?.length) return null;
  const current = runs.find((r) => r.runId === picked) ?? runs[runs.length - 1]!;
  const index = runs.indexOf(current);
  const computer = computers?.find((c) => c.id === current.computer.id);

  return (
    <Card className={cn("gap-0 py-0", className)} data-testid="run-context-card">
      <CardContent className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-label text-muted-foreground">Run {runs.length > 1 ? `${index + 1} of ${runs.length}` : ""}</span>
          <Badge variant="outline" className={cn("text-micro font-normal capitalize", STATUS_TONE[current.status])}>{current.status}</Badge>
          {current.continuation && <Badge variant="outline" className="text-micro font-normal">continuation</Badge>}
          <span className="text-caption text-muted-foreground">
            {new Date(current.startedAt).toLocaleString()}
            {current.durationMs !== undefined ? ` · ${formatMs(current.durationMs)}` : ""}
            {current.exitCode !== undefined && current.exitCode !== 0 ? ` · exit ${current.exitCode}` : ""}
          </span>
        </div>
        <RunDetail run={current} computer={computer} />
        {runs.length > 1 && (
          <div className="space-y-1 border-t pt-2" data-testid="run-history">
            <p className="flex items-center gap-1 text-label text-muted-foreground"><History className="h-3 w-3" /> Runs</p>
            <ol className="space-y-0.5">
              {runs.map((r, i) => (
                <li key={r.runId}>
                  <button
                    type="button"
                    onClick={() => setPicked(r.runId)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1 text-left text-caption hover:bg-accent/30",
                      r === current && "bg-accent/40",
                    )}
                    aria-pressed={r === current}
                    data-testid={`run-history-${r.runId}`}
                  >
                    <span className="w-5 shrink-0 tabular-nums text-muted-foreground">{i + 1}</span>
                    <BrandIcon name={engineBrand(r.engine)} size={12} />
                    <span className="truncate">{engineLabel(r.engine)}{r.model ? ` · ${modelLabel(r.model)}` : ""}</span>
                    <BrandIcon name={computerBrand(r.computer)} size={12} />
                    <span className="truncate text-muted-foreground">{r.computer.name ?? r.computer.id}</span>
                    {r.continuation && <span className="text-muted-foreground">continuation</span>}
                    <span className={cn("ml-auto shrink-0 capitalize", r.status === "failed" ? "text-destructive" : r.status === "completed" ? "text-success" : "text-muted-foreground")}>{r.status}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{formatUsd(r.cost?.harnessUsd ?? r.cost?.modelUsd) ?? ""}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
