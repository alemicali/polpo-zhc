/**
 * Agent tests — the Tests tab of an agent: check everything it has at its disposal (engine and
 * model, tools, connectors, vault, skills, computer and sandbox, channels, versioning), each check
 * on its own or "Run all", with ✓ / ⚠ / ✗, the details and a fix (a link to the setting, or a
 * one-click action such as granting a connector's access). The live smoke run (a real chat turn
 * that calls one harmless tool) runs only on an explicit click. Runs are kept: the history.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FlaskConical, History, Loader2, MinusCircle, Play, Power, Wrench, XCircle } from "lucide-react";
import {
  useAgentTests, useAgentVersions,
  type AgentTestCheckId, type AgentTestCheckResult, type AgentTestItem, type AgentTestRun, type AgentTestStatus,
} from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { cn } from "@/lib/utils";
import { useAgentDetail } from "./agent-detail-context";

const CHECKS: Array<{ id: AgentTestCheckId; title: string; hint: string }> = [
  { id: "engine", title: "Engine & model", hint: "A minimal real request with its engine and auth (a few tokens)" },
  { id: "tools", title: "Tools", hint: "Every allowed tool resolves to a real tool; unknown names flagged" },
  { id: "connectors", title: "Connectors", hint: "Connected, signed in, tools listed; access that leaves the agent out" },
  { id: "vault", title: "Vault", hint: "Referenced entries exist (names only), env_from_vault mappings resolve" },
  { id: "skills", title: "Skills", hint: "Each skill loads with its files; pinned versions exist" },
  { id: "computer", title: "Computer & sandbox", hint: "Computer reachable, sandbox provider, egress proxy" },
  { id: "channels", title: "Channels", hint: "Routes to the agent exist and their channels run" },
  { id: "versioning", title: "Versioning", hint: "Production version, draft state" },
];

const STATUS: Record<AgentTestStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  pass: { icon: CheckCircle2, className: "text-success", label: "Passed" },
  warn: { icon: AlertTriangle, className: "text-warning", label: "Warning" },
  fail: { icon: XCircle, className: "text-destructive", label: "Failed" },
  skip: { icon: MinusCircle, className: "text-muted-foreground", label: "Nothing to check" },
};

function StatusIcon({ status, className }: { status: AgentTestStatus; className?: string }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return <Icon className={cn("h-4 w-4 shrink-0", s.className, className)} aria-label={s.label} data-status={status} />;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function targetLabel(run: Pick<AgentTestRun, "target" | "version">): string {
  if (run.target === "draft") return "draft";
  if (run.target === "production") return run.version ? `production · v${run.version}` : "production";
  return `v${run.target}`;
}

/** The newest result of each check across the history (a single-check run updates only its row). */
function latestPerCheck(history: AgentTestRun[] | undefined, latest: AgentTestRun | undefined): Map<AgentTestCheckId, { result: AgentTestCheckResult; run: AgentTestRun }> {
  const out = new Map<AgentTestCheckId, { result: AgentTestCheckResult; run: AgentTestRun }>();
  const runs = [...(latest ? [latest] : []), ...(history ?? [])];
  for (const run of runs) for (const result of run.checks) if (!out.has(result.id)) out.set(result.id, { result, run });
  return out;
}

function ItemRow({ item, onFix, fixing }: { item: AgentTestItem; onFix: (item: AgentTestItem) => void; fixing: boolean }) {
  return (
    <li className="flex min-w-0 items-start gap-2 py-1" data-testid="test-item" data-status={item.status}>
      <StatusIcon status={item.status} className="mt-0.5 h-3.5 w-3.5" />
      <div className="min-w-0 flex-1">
        <p className="break-words text-xs"><span className="font-medium">{item.label}</span>{item.detail ? <span className="text-muted-foreground"> — {item.detail}</span> : null}</p>
      </div>
      {item.fix?.action ? (
        <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={fixing} onClick={() => onFix(item)} data-testid="test-fix">
          {fixing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wrench className="mr-1 h-3.5 w-3.5" />}{item.fix.label}
        </Button>
      ) : item.fix?.href ? (
        <Button size="sm" variant="ghost" className="h-7 shrink-0" asChild>
          <Link to={item.fix.href} data-testid="test-fix-link">{item.fix.label}</Link>
        </Button>
      ) : null}
    </li>
  );
}

export function AgentTestsTab() {
  const { meta: { agentName } } = useAgentDetail();
  const tests = useAgentTests(agentName, { limit: 30 });
  const versions = useAgentVersions(agentName);
  const [target, setTarget] = useState("production");
  const [viewing, setViewing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<AgentTestCheckId>>(new Set());
  const [confirm, setConfirm] = useState<{ kind: "smoke" } | { kind: "start" } | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);

  const viewed = viewing ? tests.history?.find((r) => r.id === viewing) : undefined;
  const perCheck = useMemo(() => latestPerCheck(viewed ? [viewed] : tests.history, viewed ? undefined : tests.latest), [viewed, tests.history, tests.latest]);
  const smoke = perCheck.get("smoke");
  const busy = tests.running !== null;
  const isRunning = (id: AgentTestCheckId) => tests.running === "all" ? id !== "smoke" : !!tests.running?.includes(id);
  const req = target === "production" ? {} : { target };

  const act = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { toast.error((e as Error).message); }
  };
  const fix = async (check: AgentTestCheckId, item: AgentTestItem) => {
    if (!item.fix?.action) return;
    setFixing(item.label);
    try {
      const r = await tests.fix(item.fix.action, check);
      toast.success(r.message);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setFixing(null);
    }
  };
  const toggle = (id: AgentTestCheckId) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const versionList = versions.data?.versions ?? [];
  const latestRun = viewed ?? tests.latest;

  return (
    <div className="space-y-4 overflow-auto pb-bottom-nav lg:pb-0" data-testid="agent-tests">
      {/* Checks */}
      <section aria-label="Checks" className="rounded-lg border border-border/40 bg-card/80">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-4 py-3">
          <FlaskConical className="h-3.5 w-3.5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">Tests</p>
            <p className="text-caption text-muted-foreground">
              {latestRun
                ? <>Last run {when(latestRun.startedAt)} · {targetLabel(latestRun)}{viewed ? " · viewing a past run" : ""}</>
                : "Check everything this agent has at its disposal before you rely on it."}
            </p>
          </div>
          {viewed && <Button variant="ghost" size="sm" onClick={() => setViewing(null)}>Back to latest</Button>}
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger size="sm" className="w-40" aria-label="What to test" data-testid="test-target"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="production">Production</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              {versionList.map((v) => <SelectItem key={v.version} value={v.version}>v{v.version}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" disabled={busy} onClick={() => void act(tests.runAll(req))} data-testid="run-all">
            {tests.running === "all" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />} Run all
          </Button>
        </header>
        {tests.error && <p className="px-4 py-3 text-caption text-destructive">{tests.error.message}</p>}
        <ul>
          {CHECKS.map((c) => {
            const entry = perCheck.get(c.id);
            const r = entry?.result;
            const problems = r?.items.filter((i) => i.status === "fail" || i.status === "warn") ?? [];
            const open = expanded.has(c.id);
            const shown = open ? r?.items ?? [] : problems;
            const canStart = c.id === "computer" && r?.data?.canStart === true;
            return (
              <li key={c.id} className="border-b border-border/40 px-4 py-2 last:border-b-0" data-testid="test-check" data-check={c.id} data-status={r?.status ?? "none"}>
                <div className="flex min-w-0 items-center gap-3">
                  {isRunning(c.id) ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : r ? <StatusIcon status={r.status} /> : <MinusCircle className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-label="Not run" />}
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => r && toggle(c.id)} aria-expanded={open} disabled={!r}>
                    <p className="text-xs font-medium">{c.title}</p>
                    <p className="truncate text-caption text-muted-foreground">{r ? `${r.summary}${entry && entry.run.target !== "production" ? ` · ${targetLabel(entry.run)}` : ""}` : c.hint}</p>
                  </button>
                  {canStart && (
                    <Button variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => setConfirm({ kind: "start" })} data-testid="start-and-test">
                      <Power className="mr-1 h-3.5 w-3.5" /> Start and test
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="h-7" disabled={busy} onClick={() => void act(tests.runOne(c.id, req))} data-testid={`run-${c.id}`} aria-label={`Run ${c.title}`}>
                    <Play className="mr-1 h-3.5 w-3.5" /> Run
                  </Button>
                </div>
                {shown.length > 0 && (
                  <ul className="mt-1 pl-7">
                    {shown.map((item, i) => <ItemRow key={`${item.label}-${i}`} item={item} fixing={fixing === item.label} onFix={(it) => void fix(c.id, it)} />)}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Live smoke run */}
      <section aria-label="Live smoke run" className="rounded-lg border border-border/40 bg-card/80" data-testid="test-check" data-check="smoke" data-status={smoke?.result.status ?? "none"}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          {isRunning("smoke") ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : smoke ? <StatusIcon status={smoke.result.status} /> : <Play className="h-3.5 w-3.5 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">Live smoke run</p>
            <p className="text-caption text-muted-foreground">
              {smoke ? `${smoke.result.summary} · ${targetLabel(smoke.run)} · ${when(smoke.run.startedAt)}` : "A tiny real chat turn: the agent calls one harmless tool (register_outcome). It costs a few tokens."}
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirm({ kind: "smoke" })} data-testid="run-smoke">
            <Play className="mr-1 h-3.5 w-3.5" /> Run smoke test
          </Button>
        </header>
        {smoke && smoke.result.items.length > 0 && (
          <ul className="border-t border-border/40 px-4 py-2">
            {smoke.result.items.map((item, i) => <ItemRow key={`${item.label}-${i}`} item={item} fixing={false} onFix={() => undefined} />)}
          </ul>
        )}
      </section>

      {/* History */}
      <section aria-label="History" className="rounded-lg border border-border/40 bg-card/80" data-testid="test-history">
        <header className="flex items-center gap-2 border-b border-border/40 px-4 py-2">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">History</span>
        </header>
        {tests.isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : !tests.history?.length ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">Not tested yet</p>
        ) : (
          <ul>
            {tests.history.map((run) => (
              <li key={run.id} className="border-b border-border/40 last:border-b-0">
                <button type="button" onClick={() => setViewing(viewing === run.id ? null : run.id)} aria-pressed={viewing === run.id}
                  className={cn("flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left hover:bg-accent/40", viewing === run.id && "bg-accent/40")} data-testid="history-row">
                  <StatusIcon status={run.status} />
                  <span className="text-xs">{when(run.startedAt)}</span>
                  <Badge variant="outline" className="font-mono text-micro">{targetLabel(run)}</Badge>
                  <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                    {run.checks.length === 1 ? run.checks[0]!.title : `${run.checks.length} checks`}
                    {" · "}{(["fail", "warn"] as const).map((s) => [s, run.checks.filter((c) => c.status === s).length] as const).filter(([, n]) => n).map(([s, n]) => `${n} ${s === "fail" ? "failed" : "warning"}`).join(", ") || "all good"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => { if (!o) setConfirm(null); }}
        title={confirm?.kind === "start" ? "Start the computer and test it?" : "Run a live smoke test?"}
        description={confirm?.kind === "start"
          ? "Its machine starts now (a remote machine may cost while it runs), then the computer check runs again."
          : `A real chat turn with ${agentName}${target === "production" ? "" : ` (${target})`}: it calls one harmless tool and answers. It costs a few tokens; the test chat is not kept.`}
        confirmLabel={confirm?.kind === "start" ? "Start and test" : "Run it"}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c?.kind === "start") void act(tests.runOne("computer", { ...req, startComputer: true }));
          else void act(tests.runOne("smoke", req));
        }}
      />
    </div>
  );
}
