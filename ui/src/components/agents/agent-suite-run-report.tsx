/**
 * One suite run: the stats, the notes and a row per case; a case opens to its assertions (✓ / ✗,
 * the message, the diff of expected and actual) and its trace drawn like a chat (the chat page's
 * own message parts: the user's message, the agent's text and tool calls, with the mock that
 * answered each call), then approvals, the finish reason and the runner's notes.
 */
import { useState } from "react";
import { AlertOctagon, Ban, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, Loader2, MinusCircle, XCircle } from "lucide-react";
import { useAgentSuiteRun, type SuiteCaseResult, type SuiteCaseStatus, type SuiteRunStatus } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Message } from "@/components/ai-elements/message";
import { AssistantSegments, ChatAssistantAvatar, ChatUserBubble } from "@/components/chat/chat-message-parts";
import { formatMs, formatUsd, runIsLive, runTargetLabel, suiteModeLabel, traceAsChat } from "@/lib/agent-suites";
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

function CaseTrace({ result, agentName }: { result: SuiteCaseResult; agentName: string }) {
  const { user, segments } = traceAsChat(result.trace);
  const t = result.trace;
  return (
    <div className="space-y-1" data-testid="suite-case-trace">
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

function CaseRow({ result, agentName }: { result: SuiteCaseResult; agentName: string }) {
  const [open, setOpen] = useState(result.status === "failed" || result.status === "errored");
  const failed = result.assertions.filter((a) => !a.passed);
  return (
    <li className="border-b border-border/40 last:border-b-0" data-testid="suite-case-result" data-status={result.status}>
      <button type="button" className="flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left hover:bg-accent/40" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <SuiteStatusIcon status={result.status} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{result.caseName}{result.row ? <span className="text-muted-foreground"> · row {result.row.index + 1}</span> : null}</span>
          <span className="block truncate text-caption text-muted-foreground">
            {result.error ?? (failed.length ? failed.map((a) => a.description).join(" · ") : `${result.assertions.length} assertion(s) passed`)}
          </span>
        </span>
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
          <CaseTrace result={result} agentName={agentName} />
        </div>
      )}
    </li>
  );
}

export function AgentSuiteRunReport({ agentName, runId, onCancel, onClose }: { agentName: string; runId: string; onCancel: (runId: string) => void; onClose: () => void }) {
  const { run, isLoading, error } = useAgentSuiteRun(agentName, runId);
  if (isLoading) return <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  if (error || !run) return <p className="px-4 py-3 text-caption text-destructive">{error?.message ?? "Run not found"}</p>;
  const s = run.stats;
  const pending = run.planned.length - run.results.length;
  return (
    <section aria-label="Run report" className="rounded-lg border border-border/40 bg-card/80" data-testid="suite-run-report" data-status={run.status}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-4 py-3">
        <SuiteStatusIcon status={run.status} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{run.suiteName} · {runTargetLabel(run)}{run.variant.label ? ` · ${run.variant.label}` : ""}</p>
          <p className="text-caption text-muted-foreground">
            {s.passed}/{s.total - s.skipped} passed{s.failed ? ` · ${s.failed} failed` : ""}{s.errored ? ` · ${s.errored} errored` : ""}{s.skipped ? ` · ${s.skipped} skipped` : ""}
            {" · "}{formatUsd(s.costUsd)} · {formatMs(s.durationMs)} · {s.inputTokens + s.outputTokens} tokens{pending > 0 && runIsLive(run) ? ` · ${pending} to go` : ""}
          </p>
        </div>
        {runIsLive(run) && <Button variant="outline" size="sm" onClick={() => onCancel(run.id)} data-testid="suite-run-cancel">Cancel</Button>}
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </header>
      {(run.notes.length > 0 || run.error) && (
        <ul className="border-b border-border/40 px-4 py-2 text-caption text-muted-foreground">
          {run.error && <li className="text-destructive">{run.error}</li>}
          {run.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
      <ul>
        {run.results.map((r) => <CaseRow key={r.key} result={r} agentName={agentName} />)}
      </ul>
    </section>
  );
}
