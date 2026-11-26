/**
 * Suites of a target other than an agent (docs/agent-suites.md, "Suites for hosted servers and
 * missions"): a hosted MCP server's saved tests (one suite: each case calls a tool with arguments,
 * its upstream API answered by HTTP mocks; required → its deploys are gated) or a mission's suites
 * (its tasks run in test mode, every agent with its own mocks). Run, read the report, edit as JSON.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Braces, FlaskRound, Loader2, Play, Plus, ShieldCheck } from "lucide-react";
import { useTargetSuiteRun, useTargetSuites, type AgentSuite, type SuiteTargetKind } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { SuiteRunReportView, SuiteStatusIcon } from "@/components/agents/agent-suite-run-report";
import { formatMs, formatUsd, runTargetLabel, suiteRunUsesRealTools } from "@/lib/agent-suites";

/** A first mission suite: one case that runs every task, each agent's model scripted. */
function missionTemplate(): Record<string, unknown> {
  return {
    name: "Mission check",
    cases: [{
      name: "Every task finishes",
      input: { kind: "mission", message: "" },
      mocks: { agents: { "agent-name": { model: { turns: [{ text: "Done." }] } } } },
      assertions: [],
    }],
  };
}

/** The editable part of a suite (what the JSON view shows). */
function editable(s: AgentSuite): Record<string, unknown> {
  const { agent: _a, createdAt: _c, updatedAt: _u, updatedBy: _b, revision: _r, target: _t, ...rest } = s;
  return rest;
}

function RunReport({ kind, id, runId, onClose }: { kind: SuiteTargetKind; id: string; runId: string; onClose: () => void }) {
  const { run, isLoading, error, refetch } = useTargetSuiteRun(kind, id, runId);
  if (isLoading) return <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  if (error || !run) return <p className="text-caption text-destructive">{error?.message ?? "Run not found"}</p>;
  return <SuiteRunReportView run={run} agentName={kind === "mission" ? "agents" : id} refetch={refetch} onClose={onClose} />;
}

export function TargetSuitesPanel({ kind, id }: { kind: SuiteTargetKind; id: string }) {
  const t = useTargetSuites(kind, id);
  const [viewing, setViewing] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id?: string; text: string; revision?: number } | null>(null);
  const [confirm, setConfirm] = useState<AgentSuite | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const hosted = kind === "mcp-server";

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };
  const start = (s: AgentSuite, allowRealTools: boolean) => act(s.id, async () => {
    const run = await t.run(s.id, allowRealTools ? { allowRealTools: true } : {});
    setViewing(run.id);
  });
  const runSuite = (s: AgentSuite) => {
    if (suiteRunUsesRealTools(s.cases, s.defaultMode, undefined, s.mocks?.unmockedTools) || s.mocks?.unmockedHttp === "real") setConfirm(s);
    else void start(s, false);
  };
  const save = () => act("save", async () => {
    let body: Record<string, unknown>;
    try { body = JSON.parse(editing!.text) as Record<string, unknown>; } catch (e) { throw new Error(`JSON: ${(e as Error).message}`); }
    await t.save({ ...body, ...(editing!.id ? { id: editing!.id } : {}) } as never, editing!.revision);
    toast.success("Suite saved");
    setEditing(null);
  });
  const lastRun = (suiteId: string) => t.runs?.find((r) => r.suiteId === suiteId);

  return (
    <div className="space-y-3" data-testid="target-suites" data-kind={kind}>
      <section aria-label="Suites" className="rounded-lg border border-border/40 bg-card/80">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-4 py-3">
          <FlaskRound className="h-3.5 w-3.5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">{hosted ? "Suite: the saved tests" : "Suites"}</p>
            <p className="text-caption text-muted-foreground">
              {hosted ? "Each test calls a tool with arguments and checks the result; the upstream API is answered by HTTP mocks (offline). Required: deploys run it first."
                : "Each case runs the mission in test mode: its tasks in order, every agent with its own mocks; check outcomes, order and who did what."}
            </p>
          </div>
          {!hosted && <Button size="sm" variant="outline" onClick={() => setEditing({ text: JSON.stringify(missionTemplate(), null, 2) })} data-testid="target-suite-new"><Plus className="mr-1 h-3.5 w-3.5" /> New suite</Button>}
        </header>
        {t.error && <p className="px-4 py-3 text-caption text-destructive">{t.error.message}</p>}
        {t.isLoading ? <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          : !t.suites?.length ? <p className="px-4 py-4 text-center text-sm text-muted-foreground">No suites yet</p>
            : (
              <ul>
                {t.suites.map((s) => {
                  const last = lastRun(s.id);
                  return (
                    <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-3 border-b border-border/40 px-4 py-2 last:border-b-0" data-testid="target-suite-row" data-suite={s.id}>
                      {last ? <SuiteStatusIcon status={last.status} /> : <span className="h-4 w-4 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate text-xs font-medium">
                          <span className="truncate">{s.name}</span>
                          {s.gate?.required && <Badge variant="outline" className="shrink-0 border-warning/30 bg-warning/10 text-micro text-warning"><ShieldCheck className="mr-0.5 h-3 w-3" /> Required</Badge>}
                        </p>
                        <p className="truncate text-caption text-muted-foreground">
                          {s.cases.length} case(s){last ? ` · last ${last.status} ${last.stats.passed}/${last.stats.total - last.stats.skipped} (${runTargetLabel(last)}) · ${formatUsd(last.stats.costUsd)} · ${formatMs(last.stats.durationMs)}` : " · never run"}
                        </p>
                      </div>
                      {hosted && (
                        <label className="flex items-center gap-1.5 text-caption">
                          <Checkbox checked={!!s.gate?.required} aria-label="Required to deploy" data-testid="target-suite-required"
                            onCheckedChange={(v) => void act("gate", async () => { await t.save({ ...editable(s), id: s.id, gate: { ...(s.gate ?? {}), required: v === true } } as never, s.revision); })} />
                          Required to deploy
                        </label>
                      )}
                      <Button variant="ghost" size="sm" className="h-7" onClick={() => setEditing({ id: s.id, text: JSON.stringify(editable(s), null, 2), revision: s.revision })} aria-label={`Edit ${s.name} as JSON`}><Braces className="h-3.5 w-3.5" /></Button>
                      <Button variant="outline" size="sm" className="h-7" disabled={busy === s.id || !s.cases.length} onClick={() => runSuite(s)} data-testid="target-suite-run">
                        {busy === s.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />} Run
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
      </section>

      {editing && (
        <section aria-label="Edit suite" className="space-y-2 rounded-lg border border-border/40 bg-card/80 p-4" data-testid="target-suite-editor">
          <Textarea value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} rows={14} className="font-mono text-micro" aria-label="Suite JSON" />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy === "save"} onClick={() => void save()} data-testid="target-suite-save">Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </section>
      )}

      {viewing && <RunReport kind={kind} id={id} runId={viewing} onClose={() => setViewing(null)} />}

      {t.runs && t.runs.length > 0 && (
        <section aria-label="Runs" className="rounded-lg border border-border/40 bg-card/80">
          <ul>
            {t.runs.slice(0, 10).map((r) => (
              <li key={r.id} className="border-b border-border/40 last:border-b-0">
                <button type="button" className="flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left hover:bg-accent/40" onClick={() => setViewing(viewing === r.id ? null : r.id)} data-testid="target-suite-run-row">
                  <SuiteStatusIcon status={r.status} />
                  <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{r.suiteName} · {runTargetLabel(r)}{r.trigger === "deploy" ? " · deploy gate" : ""} · {r.stats.passed}/{r.stats.total - r.stats.skipped} passed · {new Date(r.startedAt).toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => { if (!o) setConfirm(null); }}
        title="Run with real tools?"
        description={hosted ? "Some tests send real HTTP requests (mode none, or unmocked requests allowed): read-only tools only; destructive ones are skipped." : "Some cases run real tools (mode none or model): they may send, write or spend. Approvals are never given by a test."}
        confirmLabel="Run with real tools"
        onConfirm={() => { const s = confirm; setConfirm(null); if (s) void start(s, true); }}
      />
    </div>
  );
}
