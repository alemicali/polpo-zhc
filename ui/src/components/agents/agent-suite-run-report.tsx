/**
 * One suite run: the stats, the notes and a row per case; a case opens to its assertions (✓ / ✗,
 * the message, the diff of expected and actual) and its trace drawn like a chat (the chat page's
 * own message parts: the user's message, the agent's text and tool calls, with the mock that
 * answered each call), then approvals, the finish reason and the runner's notes.
 */
import { useState } from "react";
import { toast } from "sonner";
import { AlertOctagon, ArrowDownRight, ArrowUpRight, Ban, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, Disc3, Loader2, MinusCircle, Sparkles, Star, UserRound, XCircle } from "lucide-react";
import { useAgentSuiteRun, type SuiteCaseDelta, type SuiteCaseResult, type SuiteCaseStatus, type SuiteRun, type SuiteRunStatus, type SuiteScoreResult } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Message, MessageResponse } from "@/components/ai-elements/message";
import { AssistantSegments, ChatAssistantAvatar, ChatUserBubble } from "@/components/chat/chat-message-parts";
import { formatDelta, formatMs, formatPointsDelta, formatScore, formatUsd, runIsLive, runTargetLabel, suiteModeLabel, traceAsChat } from "@/lib/agent-suites";
import { cn } from "@/lib/utils";

const STATUS: Record<SuiteRunStatus | SuiteCaseStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  passed: { icon: CheckCircle2, className: "text-success", label: "Passed" },
  failed: { icon: XCircle, className: "text-destructive", label: "Failed" },
  errored: { icon: AlertOctagon, className: "text-warning", label: "Errored" },
  skipped: { icon: MinusCircle, className: "text-muted-foreground", label: "Skipped" },
  cancelled: { icon: Ban, className: "text-muted-foreground", label: "Cancelled" },
  running: { icon: Loader2, className: "animate-spin text-muted-foreground", label: "Running" },
  queued: { icon: CircleSlash, className: "text-muted-foreground", label: "Queued" },
};

export function SuiteStatusIcon({ status, className }: { status: SuiteRunStatus | SuiteCaseStatus; className?: string }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return <Icon className={cn("h-4 w-4 shrink-0", s.className, className)} aria-label={s.label} data-status={status} />;
}

/** A multi-turn case's conversation: the case's message, the simulated (or scripted) user's turns, the agent's replies. */
function Transcript({ trace, agentName }: { trace: SuiteCaseResult["trace"]; agentName: string }) {
  const sim = trace.simulator;
  return (
    <div className="space-y-2" data-testid="suite-transcript">
      <p className="text-micro font-medium uppercase tracking-label text-muted-foreground">
        Conversation · {trace.transcript!.length} messages{sim ? ` · user ${sim.calls ? `simulated${sim.model ? ` by ${sim.model}` : ""}` : "scripted"} · stopped by ${sim.stoppedBy}${sim.goalReached !== undefined ? (sim.goalReached ? " (goal reached)" : " (goal not reached)") : ""}${sim.costUsd ? ` · simulator ${formatUsd(sim.costUsd)}` : ""}` : ""}
      </p>
      {trace.transcript!.map((m, i) => m.role === "user" ? (
        <div key={i} className="flex justify-end" data-testid="suite-transcript-user" data-simulated={!!m.simulated}>
          <div className="max-w-[85%] space-y-0.5">
            <ChatUserBubble text={m.content} />
            <p className="flex items-center justify-end gap-1 text-micro text-muted-foreground"><UserRound className="h-3 w-3" />{m.simulated ? "simulated user" : i === 0 ? "the case's message" : "scripted"}{m.note ? ` · ${m.note}` : ""}</p>
          </div>
        </div>
      ) : (
        <div key={i} className="flex gap-2" data-testid="suite-transcript-agent">
          <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label={agentName} />
          <div className="min-w-0 flex-1 text-xs"><MessageResponse>{m.content || "—"}</MessageResponse>{m.note ? <p className="text-micro text-muted-foreground">{m.note}</p> : null}</div>
        </div>
      ))}
    </div>
  );
}

/** Phase 4 extras of a trace: a mission's tasks, a hosted server's HTTP calls, the cassette replayed or recorded. */
function TraceExtras({ trace }: { trace: SuiteCaseResult["trace"] }) {
  return (
    <>
      {trace.tasks?.length ? (
        <ol className="space-y-1" data-testid="suite-trace-tasks" aria-label="Tasks">
          {trace.tasks.map((t) => (
            <li key={t.title} className="flex min-w-0 items-start gap-2 text-xs" data-status={t.status}>
              <SuiteStatusIcon status={t.status === "done" ? "passed" : t.status === "failed" ? "failed" : "skipped"} />
              <span className="min-w-0 break-words"><span className="font-medium">{t.title}</span> <span className="text-muted-foreground">· {t.agent} · {t.toolCalls} call(s) · {formatMs(t.durationMs)}{t.error ? ` — ${t.error}` : t.text ? ` — ${t.text.slice(0, 200)}` : ""}</span></span>
            </li>
          ))}
        </ol>
      ) : null}
      {trace.http?.length ? (
        <ul className="space-y-0.5 font-mono text-micro" data-testid="suite-trace-http" aria-label="HTTP requests">
          {trace.http.map((h, i) => (
            <li key={i} className={cn("break-all", h.mocked === "blocked" ? "text-destructive" : "text-muted-foreground")}>
              {h.method} {h.url} → {h.status || "—"} <span className="font-sans">{h.mocked === "mock" ? `(mock${h.mockId ? ` ${h.mockId}` : ""})` : h.mocked === "blocked" ? "(blocked: no HTTP mock)" : "(real)"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {trace.cassette && (
        <p className="text-caption text-muted-foreground" data-testid="suite-trace-cassette">
          <Disc3 className="mr-1 inline h-3 w-3" />Replayed from <span className="font-mono">{trace.cassette.id}</span>: {trace.cassette.replayedCalls} call(s), {trace.cassette.replayedTurns} turn(s)
          {trace.cassette.unmatched.length ? <span className="text-warning"> · no recording for {trace.cassette.unmatched.join(", ")}</span> : null}
        </p>
      )}
      {trace.recorded && (
        <p className="text-caption text-muted-foreground" data-testid="suite-trace-recorded">
          <Disc3 className="mr-1 inline h-3 w-3" />Recorded into <span className="font-mono">{trace.recorded.cassetteId}</span>: {trace.recorded.calls} call(s), {trace.recorded.turns} turn(s), {trace.recorded.redactions} secret value(s) redacted
        </p>
      )}
    </>
  );
}

function CaseTrace({ result, agentName }: { result: SuiteCaseResult; agentName: string }) {
  const { user, segments } = traceAsChat(result.trace);
  const t = result.trace;
  if (t.transcript?.length) {
    return (
      <div className="space-y-2" data-testid="suite-case-trace">
        <Transcript trace={t} agentName={agentName} />
        <TraceExtras trace={t} />
        <p className="text-caption text-muted-foreground">{t.turns.length} model turn(s) · {t.toolCalls.length} tool call(s){t.toolCalls.length ? `: ${t.toolCalls.map((c) => `${c.name}${c.mocked ? ` (${c.mocked})` : ""}`).join(", ")}` : ""} · {formatUsd(t.usage.costUsd)} · {formatMs(t.durationMs)}</p>
        {t.notes.map((n, i) => <p key={i} className="text-caption text-muted-foreground">{n}</p>)}
      </div>
    );
  }
  return (
    <div className="space-y-1" data-testid="suite-case-trace">
      <TraceExtras trace={t} />
      {user && (
        <div className="flex justify-end py-2">
          <div className="max-w-[85%]"><ChatUserBubble text={user} /></div>
        </div>
      )}
      {segments.length > 0 && (
        <Message from="assistant">
          <div className="flex gap-3">
            <ChatAssistantAvatar name={agentName} isAgent />
            <div className="min-w-0 flex-1">
              <p className="mb-1 text-xs font-semibold">{agentName}</p>
              <AssistantSegments segments={segments} isStreaming={false} />
            </div>
          </div>
        </Message>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-2 text-caption">
        <dt className="text-muted-foreground">Turns</dt>
        <dd>{t.turns.length}{t.turns.some((x) => x.mocked) ? " (scripted)" : ""} · {t.toolCalls.length} tool call(s){t.toolCalls.some((c) => c.mocked) ? ` · mocked: ${t.toolCalls.filter((c) => c.mocked).map((c) => `${c.name} (${c.mocked})`).join(", ")}` : ""}</dd>
        {t.finishReason && <><dt className="text-muted-foreground">Finish</dt><dd className="font-mono">{t.finishReason}</dd></>}
        {t.approvals.length > 0 && <><dt className="text-muted-foreground">Approvals</dt><dd>{t.approvals.map((a) => `${a.tool} (${a.kind === "interactive" ? "stopped for a person" : "queued in Approvals"})`).join(", ")} · never given by a test</dd></>}
        <dt className="text-muted-foreground">Usage</dt>
        <dd>{t.usage.inputTokens} in · {t.usage.outputTokens} out · {formatUsd(t.usage.costUsd)} · {formatMs(t.durationMs)}</dd>
        {t.notes.flatMap((n, i) => [<dt key={`k${i}`} className="text-muted-foreground">{i === 0 ? "Notes" : ""}</dt>, <dd key={`v${i}`}>{n}</dd>])}
      </dl>
    </div>
  );
}

/** A regression (▼) or an improvement (▲) versus the baseline. */
function ChangeBadge({ change }: { change?: string }) {
  if (change === "regressed") return <Badge variant="outline" className="gap-0.5 border-destructive/40 text-micro text-destructive" data-change="regressed"><ArrowDownRight className="h-3 w-3" />Regressed</Badge>;
  if (change === "improved") return <Badge variant="outline" className="gap-0.5 border-success/40 text-micro text-success" data-change="improved"><ArrowUpRight className="h-3 w-3" />Improved</Badge>;
  if (change === "new") return <Badge variant="outline" className="text-micro" data-change="new">New</Badge>;
  return null;
}

function DeltaText({ value, points }: { value?: number; points?: boolean }) {
  if (value === undefined) return null;
  return (
    <span className={cn("font-mono text-micro", value > 0 ? "text-success" : value < 0 ? "text-destructive" : "text-muted-foreground")}>
      {points ? formatPointsDelta(value) : formatDelta(value)}
    </span>
  );
}

/** A case's scores: score vs threshold, why, and the LLM judge's criteria with its reasoning. */
function CaseScores({ scores }: { scores: SuiteScoreResult[] }) {
  return (
    <ul className="space-y-1" aria-label="Scores">
      {scores.map((x) => (
        <li key={x.id} className="text-xs" data-testid="suite-score" data-passed={x.passed} data-scorer={x.id}>
          <span className="flex min-w-0 items-start gap-2">
            {x.passed ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />}
            <span className="min-w-0 break-words">
              <span className="font-mono">{formatScore(x.score)}</span>
              <span className="text-muted-foreground"> / {x.threshold} · </span>
              <span className="font-medium">{x.description}</span>
              {(x.error ?? x.reason) && <span className="text-muted-foreground"> — {x.error ?? x.reason}</span>}
            </span>
          </span>
          {x.judge?.criteria.length ? (
            <ul className="mt-1 space-y-0.5 pl-6 text-caption text-muted-foreground" data-testid="suite-judge">
              {x.judge.criteria.map((c) => <li key={c.name}><span className="font-medium text-foreground">{c.name} {c.score}/5</span>{c.weight !== 1 ? ` (×${c.weight})` : ""}: {c.reasoning}</li>)}
              {x.judge.model && <li className="text-micro">judge {x.judge.model}{x.judge.costUsd !== undefined ? ` · ${formatUsd(x.judge.costUsd)}` : ""}</li>}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The run's evals: scores per scorer with deltas, the baseline comparison, flaky cases. */
function EvalSummary({ run }: { run: SuiteRun }) {
  const a = run.aggregates;
  const b = run.baseline;
  if (!a?.scorers.length && !b && !(a && a.repetitions > 1)) return null;
  const deltas = new Map((b?.scorers ?? []).map((x) => [x.id, x]));
  return (
    <div className="space-y-2 border-b border-border/40 px-4 py-3" data-testid="suite-eval-summary">
      {b && (
        <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control px-3 py-2 text-caption", b.regressions ? "bg-destructive/10" : "bg-muted/40")} data-testid="suite-baseline-compare">
          <span className="text-muted-foreground">vs baseline <span className="font-mono">{b.runId}</span> ({b.source}{b.baselineVersion ? `, v${b.baselineVersion}` : b.baselineTarget ? `, ${b.baselineTarget}` : ""})</span>
          <span>pass rate <DeltaText value={b.passRateDelta} points /></span>
          {b.scoreDelta !== undefined && <span>score <DeltaText value={b.scoreDelta} /></span>}
          <span>cost <span className={cn("font-mono text-micro", b.costDelta > 0 ? "text-warning" : "text-muted-foreground")}>{b.costDelta >= 0 ? "+" : "−"}{formatUsd(Math.abs(b.costDelta))}</span></span>
          {b.regressions > 0 && <Badge variant="outline" className="border-destructive/40 text-micro text-destructive">{b.regressions} regression(s)</Badge>}
          {b.improvements > 0 && <Badge variant="outline" className="border-success/40 text-micro text-success">{b.improvements} improvement(s)</Badge>}
          {!b.regressions && !b.improvements && <span className="text-muted-foreground">no change beyond ±{b.tolerance}</span>}
        </div>
      )}
      {a && a.scorers.length > 0 && (
        <table className="w-full text-caption" data-testid="suite-scorer-table">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 font-medium">Scorer</th>
              <th className="py-1 font-medium">Mean</th>
              <th className="hidden py-1 font-medium sm:table-cell">Median</th>
              <th className="hidden py-1 font-medium sm:table-cell">p10</th>
              <th className="py-1 font-medium">Pass</th>
              <th className="py-1 font-medium">vs baseline</th>
            </tr>
          </thead>
          <tbody>
            {a.scorers.map((x) => (
              <tr key={x.id} className="border-t border-border/30" data-scorer={x.id}>
                <td className="py-1"><span className="font-mono">{x.id}</span> <span className="text-muted-foreground">{x.label}</span></td>
                <td className="py-1 font-mono">{formatScore(x.mean)}</td>
                <td className="hidden py-1 font-mono sm:table-cell">{formatScore(x.median)}</td>
                <td className="hidden py-1 font-mono sm:table-cell">{formatScore(x.p10)}</td>
                <td className="py-1">{Math.round(x.passRate * 100)}%</td>
                <td className="py-1"><DeltaText value={deltas.get(x.id)?.delta} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {a && a.repetitions > 1 && (
        <p className="text-caption text-muted-foreground" data-testid="suite-flaky">
          {a.repetitions} attempts per case · {a.flaky.length ? <span className="text-warning">flaky: {a.flaky.join(", ")}</span> : "no flaky case"}
        </p>
      )}
    </div>
  );
}

function CaseRow({ result, agentName, delta, onOpenCassette }: { result: SuiteCaseResult; agentName: string; delta?: SuiteCaseDelta; onOpenCassette?: (caseId: string) => void }) {
  const [open, setOpen] = useState(result.status === "failed" || result.status === "errored");
  const failed = [...result.assertions.filter((a) => !a.passed).map((a) => a.description), ...(result.scores ?? []).filter((x) => !x.passed).map((x) => `${x.id} ${formatScore(x.score)} < ${x.threshold}`)];
  return (
    <li className="border-b border-border/40 last:border-b-0" data-testid="suite-case-result" data-status={result.status}>
      <button type="button" className="flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left hover:bg-accent/40" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <SuiteStatusIcon status={result.status} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{result.caseName}{result.row ? <span className="text-muted-foreground"> · row {result.row.index + 1}</span> : null}{result.attempt ? <span className="text-muted-foreground"> · attempt {result.attempt}</span> : null}</span>
          <span className="block truncate text-caption text-muted-foreground">
            {result.error ?? (failed.length ? failed.join(" · ") : `${result.assertions.length} assertion(s)${result.scores?.length ? `, ${result.scores.length} scorer(s)` : ""} passed`)}
            {delta && delta.change !== "unchanged" && delta.reasons.length ? ` · ${delta.reasons.join("; ")}` : ""}
          </span>
        </span>
        <ChangeBadge change={delta?.change} />
        {result.score !== undefined && <span className="shrink-0 font-mono text-caption" data-testid="suite-case-score">{formatScore(result.score)}</span>}
        <Badge variant="outline" className="hidden text-micro sm:inline-flex">{suiteModeLabel(result.mode)}</Badge>
        <span className="shrink-0 text-caption text-muted-foreground">{formatMs(result.durationMs)} · {formatUsd(result.costUsd)}</span>
      </button>
      {open && (
        <div className="space-y-3 px-4 pb-3 pl-11">
          {result.error && <p className="text-caption text-destructive">{result.error}</p>}
          {result.assertions.length > 0 && (
            <ul className="space-y-1" aria-label="Assertions">
              {result.assertions.map((a, i) => (
                <li key={i} className="text-xs" data-testid="suite-assertion" data-passed={a.passed}>
                  <span className="flex min-w-0 items-start gap-2">
                    {a.passed ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />}
                    <span className="min-w-0 break-words"><span className="font-medium">{a.description}</span> <span className="text-muted-foreground">— {a.message}</span></span>
                  </span>
                  {!a.passed && a.diff && (
                    <pre className="mt-1 max-h-64 overflow-auto rounded-control bg-muted/50 p-2 font-mono text-micro" data-testid="suite-assertion-diff">
                      {a.diff.split("\n").map((line, j) => (
                        <span key={j} className={cn("block", line.startsWith("+") && !line.startsWith("+++") && "text-success", line.startsWith("-") && !line.startsWith("---") && "text-destructive")}>{line}</span>
                      ))}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
          {result.scores && result.scores.length > 0 && <CaseScores scores={result.scores} />}
          <CaseTrace result={result} agentName={agentName} />
          {onOpenCassette && (
            <Button variant="outline" size="sm" className="h-7" onClick={() => onOpenCassette(result.caseId)} data-testid="suite-case-cassette-open">
              <Disc3 className="mr-1 h-3.5 w-3.5" /> {result.trace.cassette || result.trace.recorded ? "Cassette" : "Record a cassette"}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

interface ReportActions {
  onCancel?: (runId: string) => void;
  onClose: () => void;
  /** Mark (runId) or clear (null) the suite's baseline. */
  onSetBaseline?: (suiteId: string, runId: string | null) => Promise<void>;
  /** "Explain this run": an AI review stored on the run. */
  onReview?: (runId: string) => Promise<unknown>;
  /** Open a case's cassette (record, replay, edit): agent suites. */
  onOpenCassette?: (suiteId: string, caseId: string) => void;
}

export function AgentSuiteRunReport({ agentName, runId, ...actions }: ReportActions & { agentName: string; runId: string }) {
  const { run, isLoading, error, refetch } = useAgentSuiteRun(agentName, runId);
  if (isLoading) return <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  if (error || !run) return <p className="px-4 py-3 text-caption text-destructive">{error?.message ?? "Run not found"}</p>;
  return <SuiteRunReportView run={run} agentName={agentName} refetch={refetch} {...actions} />;
}

/** A run's report (any target: an agent, a hosted server's saved tests, a mission). */
export function SuiteRunReportView({ run, agentName, refetch, onCancel, onClose, onSetBaseline, onReview, onOpenCassette }: ReportActions & { run: SuiteRun; agentName: string; refetch: () => Promise<void> }) {
  const [busy, setBusy] = useState<"baseline" | "review" | null>(null);
  const s = run.stats;
  const pending = run.planned.length - run.results.length;
  const finished = !runIsLive(run) && run.status !== "cancelled";
  const deltas = new Map((run.baseline?.cases ?? []).map((c) => [c.key, c]));
  const act = async (kind: "baseline" | "review", fn: () => Promise<unknown>) => {
    setBusy(kind);
    try { await fn(); await refetch(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <section aria-label="Run report" className="rounded-lg border border-border/40 bg-card/80" data-testid="suite-run-report" data-status={run.status}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-4 py-3">
        <SuiteStatusIcon status={run.status} />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium">
            {run.suiteName} · {runTargetLabel(run)}{run.variant.label ? ` · ${run.variant.label}` : ""}
            {run.isBaseline && <Badge variant="outline" className="gap-0.5 text-micro" data-testid="suite-run-is-baseline"><Star className="h-3 w-3" />Baseline</Badge>}
          </p>
          <p className="text-caption text-muted-foreground">
            {s.passed}/{s.total - s.skipped} passed{s.failed ? ` · ${s.failed} failed` : ""}{s.errored ? ` · ${s.errored} errored` : ""}{s.skipped ? ` · ${s.skipped} skipped` : ""}
            {run.aggregates?.score !== undefined ? ` · score ${formatScore(run.aggregates.score)}` : ""}
            {" · "}{formatUsd(s.costUsd)} · {formatMs(s.durationMs)} · {s.inputTokens + s.outputTokens} tokens{pending > 0 && runIsLive(run) ? ` · ${pending} to go` : ""}
          </p>
        </div>
        {runIsLive(run) && onCancel && <Button variant="outline" size="sm" onClick={() => onCancel(run.id)} data-testid="suite-run-cancel">Cancel</Button>}
        {finished && onSetBaseline && (
          <Button variant={run.isBaseline ? "secondary" : "outline"} size="sm" disabled={busy !== null} aria-pressed={!!run.isBaseline} data-testid="suite-run-baseline"
            onClick={() => void act("baseline", () => onSetBaseline(run.suiteId, run.isBaseline ? null : run.id))}>
            {busy === "baseline" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Star className="mr-1 h-3.5 w-3.5" />}
            {run.isBaseline ? "Baseline" : "Mark as baseline"}
          </Button>
        )}
        {finished && onReview && (
          <Button variant="outline" size="sm" disabled={busy !== null} data-testid="suite-run-review" onClick={() => void act("review", () => onReview(run.id))}>
            {busy === "review" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
            {run.review ? "Explain again" : "Explain this run"}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </header>
      {(run.notes.length > 0 || run.error) && (
        <ul className="border-b border-border/40 px-4 py-2 text-caption text-muted-foreground">
          {run.error && <li className="text-destructive">{run.error}</li>}
          {run.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
      <EvalSummary run={run} />
      {run.review && (
        <div className="space-y-1 border-b border-border/40 px-4 py-3" data-testid="suite-run-review-text">
          <p className="flex items-center gap-1.5 text-micro font-medium uppercase tracking-label text-muted-foreground">
            <Sparkles className="h-3 w-3" /> AI review{run.review.model ? ` · ${run.review.model}` : ""}
          </p>
          <div className="text-xs"><MessageResponse>{run.review.text}</MessageResponse></div>
        </div>
      )}
      <ul>
        {run.results.map((r) => <CaseRow key={r.key} result={r} agentName={agentName} delta={deltas.get(r.key.replace(/~\d+$/, ""))} {...(onOpenCassette && (run.targetKind ?? "agent") === "agent" ? { onOpenCassette: (caseId: string) => onOpenCassette(run.suiteId, caseId) } : {})} />)}
      </ul>
    </section>
  );
}
