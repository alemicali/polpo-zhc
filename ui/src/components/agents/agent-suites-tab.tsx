/**
 * Agent suites — the Suites tab of an agent: test and eval suites (cases with an input, a mock
 * mode, tool and model mocks, datasets and assertions), run against a version (production, the
 * draft, a published one), with a report per run and a trace per case (docs/agent-suites.md).
 * Runs that touch real tools ask for a confirmation; the offline "contract" mode never does.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { FlaskRound, History, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useAgentSuites, useAgentVersions, type AgentSuite, type SuiteMockMode } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { SUITE_MODES, blankSuite, editableSuite, formatMs, formatUsd, runTargetLabel, suiteModeLabel, suiteRunUsesRealTools } from "@/lib/agent-suites";
import { cn } from "@/lib/utils";
import { useAgentDetail } from "./agent-detail-context";
import { AgentSuiteEditor } from "./agent-suite-editor";
import { AgentSuiteRunReport, SuiteStatusIcon } from "./agent-suite-run-report";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function AgentSuitesTab() {
  const { meta: { agentName } } = useAgentDetail();
  const suites = useAgentSuites(agentName);
  const versions = useAgentVersions(agentName);
  const [target, setTarget] = useState("production");
  const [mode, setMode] = useState<SuiteMockMode | "own">("own");
  const [editing, setEditing] = useState<{ suite?: AgentSuite; key: number } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "real"; suite: AgentSuite } | { kind: "delete"; suite: AgentSuite } | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  const runs = suites.runs;
  const lastRun = useMemo(() => {
    const m = new Map<string, NonNullable<typeof runs>[number]>();
    for (const r of runs ?? []) if (!m.has(r.suiteId)) m.set(r.suiteId, r);
    return m;
  }, [runs]);

  const start = async (suite: AgentSuite, allowRealTools: boolean) => {
    setStarting(suite.id);
    try {
      const run = await suites.run(suite.id, { ...(target !== "production" ? { target } : {}), ...(mode !== "own" ? { mode } : {}), ...(allowRealTools ? { allowRealTools: true } : {}) });
      setViewing(run.id);
    } catch (e) { toast.error((e as Error).message); } finally { setStarting(null); }
  };
  const runSuite = (suite: AgentSuite) => {
    const real = suiteRunUsesRealTools(suite.cases, suite.defaultMode, mode === "own" ? undefined : mode, suite.mocks?.unmockedTools);
    if (real) setConfirm({ kind: "real", suite });
    else void start(suite, false);
  };
  const versionList = versions.data?.versions ?? [];

  return (
    <div className="space-y-4 pb-bottom-nav lg:pb-4" data-testid="agent-suites">
      <section aria-label="Suites" className="rounded-lg border border-border/40 bg-card/80">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-4 py-3">
          <FlaskRound className="h-3.5 w-3.5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">Suites</p>
            <p className="text-caption text-muted-foreground">Tests and evals with mocked tools and scripted models, run on a version before you deploy it.</p>
          </div>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger size="sm" className="w-36" aria-label="Version to run" data-testid="suite-target"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="production">Production</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              {versionList.map((v) => <SelectItem key={v.version} value={v.version}>v{v.version}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={mode} onValueChange={(m) => setMode(m as SuiteMockMode | "own")}>
            <SelectTrigger size="sm" className="w-44" aria-label="Mode for the run" data-testid="suite-run-mode"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="own">Each case's mode</SelectItem>
              {SUITE_MODES.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => setEditing({ key: Date.now() })} data-testid="suite-new"><Plus className="mr-1 h-3.5 w-3.5" /> New suite</Button>
        </header>
        {suites.error && <p className="px-4 py-3 text-caption text-destructive">{suites.error.message}</p>}
        {suites.isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : !suites.suites?.length ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No suites yet. A suite holds cases: a message, mocks for its tools and model, and what must happen.</p>
        ) : (
          <ul>
            {suites.suites.map((s) => {
              const last = lastRun.get(s.id);
              return (
                <li key={s.id} className="flex min-w-0 items-center gap-3 border-b border-border/40 px-4 py-2 last:border-b-0" data-testid="suite-row" data-suite={s.id}>
                  {last ? <SuiteStatusIcon status={last.status} /> : <span className="h-4 w-4 shrink-0" />}
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing({ suite: s, key: Date.now() })}>
                    <p className="truncate text-xs font-medium">{s.name}</p>
                    <p className="truncate text-caption text-muted-foreground">
                      {s.cases.length} case(s){s.datasets.length ? ` · ${s.datasets.length} dataset(s)` : ""} · {suiteModeLabel(s.defaultMode)}
                      {last ? ` · last ${last.status} ${last.stats.passed}/${last.stats.total - last.stats.skipped} (${runTargetLabel(last)})` : " · never run"}
                    </p>
                  </button>
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setEditing({ suite: s, key: Date.now() })} aria-label={`Edit ${s.name}`}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setConfirm({ kind: "delete", suite: s })} aria-label={`Delete ${s.name}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                  <Button variant="outline" size="sm" className="h-7" disabled={starting === s.id} onClick={() => runSuite(s)} data-testid="suite-run">
                    {starting === s.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />} Run
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {editing && (
        <AgentSuiteEditor
          key={editing.key}
          saved={editing.suite}
          initial={editing.suite ? editableSuite(editing.suite) : blankSuite()}
          suites={suites}
          onSaved={(s) => setEditing({ suite: s, key: Date.now() })}
          onClose={() => setEditing(null)}
        />
      )}

      {viewing && (
        <AgentSuiteRunReport agentName={agentName} runId={viewing} onClose={() => setViewing(null)}
          onCancel={(id) => void suites.cancel(id).catch((e) => toast.error((e as Error).message))} />
      )}

      <section aria-label="Runs" className="rounded-lg border border-border/40 bg-card/80" data-testid="suite-runs">
        <header className="flex items-center gap-2 border-b border-border/40 px-4 py-2">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Runs</span>
        </header>
        {!suites.runs?.length ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No runs yet</p>
        ) : (
          <ul>
            {suites.runs.map((r) => (
              <li key={r.id} className="border-b border-border/40 last:border-b-0">
                <button type="button" onClick={() => setViewing(viewing === r.id ? null : r.id)} aria-pressed={viewing === r.id}
                  className={cn("flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left hover:bg-accent/40", viewing === r.id && "bg-accent/40")} data-testid="suite-run-row">
                  <SuiteStatusIcon status={r.status} />
                  <span className="hidden text-xs sm:inline">{when(r.startedAt)}</span>
                  <Badge variant="outline" className="font-mono text-micro">{runTargetLabel(r)}</Badge>
                  <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                    {r.suiteName}{r.variant.label ? ` · ${r.variant.label}` : ""} · {r.stats.passed}/{r.stats.total - r.stats.skipped} passed · {formatUsd(r.stats.costUsd)} · {formatMs(r.stats.durationMs)}
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
        title={confirm?.kind === "delete" ? `Delete ${confirm.suite.name}?` : "Run with real tools?"}
        description={confirm?.kind === "delete"
          ? "The suite is deleted; its past runs stay in the list."
          : `Some cases of ${confirm?.suite.name ?? ""} run real tools (mode model or live, or unmocked tools run for real): they may send, write or spend. Approvals are never given by a test: a send stops for a person.`}
        confirmLabel={confirm?.kind === "delete" ? "Delete" : "Run with real tools"}
        destructive={confirm?.kind === "delete"}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (!c) return;
          if (c.kind === "delete") {
            void suites.remove(c.suite.id).then(() => { if (editing?.suite?.id === c.suite.id) setEditing(null); }).catch((e) => toast.error((e as Error).message));
          } else void start(c.suite, true);
        }}
      />
    </div>
  );
}
