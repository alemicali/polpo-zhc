/**
 * Decisions: typed judgments with probabilities from the decision model (decide()).
 *
 * - Try it: a state (text or JSON) and questions (yes/no, choice, score, rank) → the answers with
 *   probability bars, the model, the cost, whether it is calibrated.
 * - Waiting for you: missions' decision nodes whose answer was uncertain (or failed): pick a branch.
 * - Log: every decision (who asked, the answers, the model, the cost); one opens with its state.
 * Deep link: ?decision=<id> opens that decision.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Loader2, Plus, Scale, Settings2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useDecide, useDecisions, usePolpo } from "@polpo-ai/react";
import type { DecisionLogEntry, DecisionLogSummary, DecisionQuestionType } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/shared/page-header";
import { DecisionAnswers } from "@/components/decisions/decision-answers";
import { draftToQuestion, newQuestionDraft, parseDecisionState, shortAnswer, type QuestionDraft } from "@/lib/decisions";
import { cn } from "@/lib/utils";

const selectClass = "h-8 rounded-md border bg-transparent px-2 text-xs";

const TYPES: Array<{ id: DecisionQuestionType; label: string; list?: string }> = [
  { id: "predicate", label: "Yes / no" },
  { id: "choice", label: "Choice", list: "Options, one per line (value: description)" },
  { id: "score", label: "Score", list: "Levels, lowest first, one per line" },
  { id: "rank", label: "Rank", list: "Items to rank, one per line" },
];

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const callerText = (d: DecisionLogSummary) => [d.caller.kind, d.caller.id ?? d.caller.label].filter(Boolean).join(" · ");

function Meta({ model, costUsd, latencyMs, calibrated }: { model: string; costUsd: number; latencyMs?: number; calibrated: boolean }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
      <span className="font-mono">{model}</span>
      <span className="tabular-nums">${costUsd.toFixed(5)}</span>
      {latencyMs !== undefined && <span className="tabular-nums">{latencyMs} ms</span>}
      {!calibrated && <Badge variant="outline" className="text-micro font-normal text-info">Uncalibrated</Badge>}
    </p>
  );
}

function Playground({ configured, onDone }: { configured: boolean; onDone: () => void }) {
  const { decide, result, isDeciding, error } = useDecide();
  const [state, setState] = useState("");
  const [drafts, setDrafts] = useState<QuestionDraft[]>([newQuestionDraft(1)]);
  const set = (i: number, patch: Partial<QuestionDraft>) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const ready = state.trim() && drafts.every((d) => d.name.trim() && d.instructions.trim());
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-card" data-testid="decisions-playground">
      <div>
        <h2 className="text-h3 font-heading">Try it</h2>
        <p className="text-caption text-muted-foreground">Ask typed questions about a state and see the probabilities. Each run is a real model call (it costs money) and goes to the log.</p>
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium">State</span>
        <Textarea rows={4} value={state} onChange={(e) => setState(e.target.value)} placeholder='Text, or JSON such as {"ticket": "I was charged twice"}' aria-label="State" />
      </label>
      <div className="space-y-3">
        {drafts.map((d, i) => {
          const type = TYPES.find((t) => t.id === d.type)!;
          return (
            <div key={i} className="space-y-2 border-t pt-3" data-testid="question-draft">
              <div className="flex flex-wrap items-center gap-2">
                <Input className="h-8 w-32" value={d.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Question name" />
                <select className={selectClass} value={d.type} onChange={(e) => set(i, { type: e.target.value as DecisionQuestionType })} aria-label="Question type">
                  {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <Input className="h-8 w-28" value={d.threshold} onChange={(e) => set(i, { threshold: e.target.value })} placeholder="Threshold" aria-label="Threshold" inputMode="decimal" />
                {drafts.length > 1 && (
                  <Button size="icon" variant="ghost" className="ml-auto h-8 w-8" aria-label="Remove the question" onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              <Input className="h-8" value={d.instructions} onChange={(e) => set(i, { instructions: e.target.value })} placeholder="What to decide, e.g. Is the customer asking for a refund?" aria-label="Instructions" />
              {type.list && <Textarea rows={3} value={d.list} onChange={(e) => set(i, { list: e.target.value })} placeholder={type.list} aria-label={type.list} />}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setDrafts((ds) => [...ds, newQuestionDraft(ds.length + 1)])}><Plus className="h-3.5 w-3.5" /> Add question</Button>
        <Button size="sm" disabled={!ready || isDeciding} onClick={() => {
          void decide({ state: parseDecisionState(state), questions: drafts.map(draftToQuestion) }).then(onDone, (e: Error) => toast.error(e.message));
        }}>{isDeciding && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Decide</Button>
        {!configured && <span className="text-caption text-muted-foreground">No decision model is configured yet: <Link className="underline" to="/config?section=decisions">set one in Settings</Link>.</span>}
      </div>
      {error && <p className="flex items-start gap-1.5 text-sm text-destructive" role="alert"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error.message}</p>}
      {result && (
        <div className="space-y-3 border-t pt-3" data-testid="decide-result">
          <Meta model={result.model} costUsd={result.costUsd} latencyMs={result.latencyMs} calibrated={result.calibrated} />
          <DecisionAnswers answers={result.answers} />
        </div>
      )}
    </section>
  );
}

function DecisionDetail({ id }: { id: string }) {
  const { client } = usePolpo();
  const [entry, setEntry] = useState<DecisionLogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.getDecision(id).then((e) => { if (live) setEntry(e); }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [client, id]);
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!entry) return <p className="flex items-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>;
  return (
    <div className="space-y-3 pt-2" data-testid="decision-detail">
      {entry.questions.map((q) => <p key={q.name} className="text-caption"><span className="font-medium">{q.name}</span> <span className="text-muted-foreground">({q.type})</span> {q.instructions}</p>)}
      {entry.status === "error" ? <p className="text-sm text-destructive">{entry.error}</p> : <DecisionAnswers answers={entry.answers} />}
      {entry.state !== undefined
        ? <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-control bg-muted/40 p-2 font-mono text-caption">{entry.state}{entry.stateTruncated ? "\n…" : ""}</pre>
        : <p className="text-caption text-muted-foreground">The state is not kept (hash {entry.stateHash.slice(0, 12)}…).</p>}
    </div>
  );
}

export function DecisionsPage() {
  const [params, setParams] = useSearchParams();
  const [onlyUncertain, setOnlyUncertain] = useState(false);
  const { page, status, nodes, isLoading, error, refetch, resolveNode } = useDecisions({ limit: 50, ...(onlyUncertain ? { uncertain: true } : {}) });
  const openId = params.get("decision") ?? undefined;
  const waiting = useMemo(() => nodes.filter((n) => n.status === "awaiting"), [nodes]);
  const open = (id: string | undefined) => {
    const next = new URLSearchParams(params);
    if (id) next.set("decision", id); else next.delete("decision");
    setParams(next, { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <PageHeader title="Decisions" icon={Scale}
        description="Typed judgments with probabilities from a decision model: yes/no, choice, score and rank. Agents, missions, playbooks and suites use them for cheap, calibrated classification and routing."
        actions={<Button size="sm" variant="outline" asChild><Link to="/config?section=decisions"><Settings2 className="h-3.5 w-3.5" /> Settings</Link></Button>} />

      <p className="text-caption text-muted-foreground" data-testid="decision-status">
        {status?.configured
          ? <>Decision model <span className="font-mono text-foreground">{status.model}</span>{status.key && (status.key.ok ? ` · key from ${status.key.detail}` : <span className="text-warning"> · {status.key.detail}</span>)}</>
          : status ? (status.unconfigured === "orchestrator" ? "No decision model: Polpo's own model answers (uncalibrated)." : "No decision model is configured: decide() refuses until one is set.") : null}
      </p>
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      <Playground configured={!!status?.configured || status?.unconfigured === "orchestrator"} onDone={() => void refetch()} />

      {waiting.length > 0 && (
        <section className="space-y-2" data-testid="decision-nodes">
          <h2 className="text-h3 font-heading">Waiting for you</h2>
          {waiting.map((n) => (
            <div key={`${n.group}:${n.node}`} className="space-y-2 border-b py-3 last:border-b-0">
              <p className="text-sm"><span className="font-medium">{n.node}</span> <span className="text-muted-foreground">in {n.group}</span></p>
              {n.reason && <p className="text-caption text-muted-foreground">{n.reason}</p>}
              <div className="flex flex-wrap gap-2">
                {(n.suggested !== undefined) && (
                  <Button size="sm" onClick={() => void resolveNode(n.group, n.node, n.suggested ?? null).then(() => toast.success("The mission goes on"), (e: Error) => toast.error(e.message))}>
                    Take {n.suggested ? `“${n.suggested}”` : "no branch"} (suggested)
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => void resolveNode(n.group, n.node, null).then(() => toast.success("No branch runs"), (e: Error) => toast.error(e.message))}>No branch</Button>
                {n.missionId && <Button size="sm" variant="ghost" asChild><Link to={`/missions/${n.missionId}`}>Open the mission</Link></Button>}
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2" data-testid="decision-log">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-h3 font-heading">Log {page ? <span className="text-caption text-muted-foreground">({page.total})</span> : null}</h2>
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={onlyUncertain} onChange={(e) => setOnlyUncertain(e.target.checked)} aria-label="Only uncertain" /> Only uncertain
          </label>
        </div>
        {isLoading && !page ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : !page?.decisions.length ? (
          <p className="py-8 text-center text-sm text-muted-foreground" data-testid="decisions-empty">No decisions yet.</p>
        ) : page.decisions.map((d) => (
          <div key={d.id} className="border-b py-2 last:border-b-0" data-decision={d.id}>
            <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => open(openId === d.id ? undefined : d.id)}>
              <span className={cn("min-w-0 flex-1 truncate text-sm", d.status === "error" && "text-destructive")}>
                {d.status === "error" ? d.error : d.answers.map(shortAnswer).join(" · ")}
              </span>
              {d.uncertain && <Badge variant="outline" className="text-micro font-normal text-warning">Uncertain</Badge>}
              {!d.calibrated && <Badge variant="outline" className="text-micro font-normal text-info">Uncalibrated</Badge>}
              <span className="text-caption text-muted-foreground">{callerText(d)} · {when(d.at)} · ${d.costUsd.toFixed(5)}</span>
            </button>
            {openId === d.id && <DecisionDetail id={d.id} />}
          </div>
        ))}
      </section>
    </div>
  );
}
