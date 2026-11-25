/**
 * One benchmark case side by side: 2–4 variants in columns, each its trace drawn like a chat (the
 * suite report's own parts), with what differs from the first column highlighted — tool calls with
 * other arguments (~), extra (+) or missing (−), and the answer's words added and removed.
 */
import { useEffect, useState } from "react";
import { Columns3, Loader2 } from "lucide-react";
import type { BenchmarkCaseComparison, BenchmarkCompareColumn } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CaseTrace, SuiteStatusIcon } from "@/components/agents/agent-suite-run-report";
import { formatMs, formatScore, formatUsd } from "@/lib/agent-suites";
import { cn } from "@/lib/utils";

const GRID: Record<number, string> = { 1: "md:grid-cols-1", 2: "md:grid-cols-2", 3: "md:grid-cols-2 xl:grid-cols-3", 4: "md:grid-cols-2 xl:grid-cols-4" };

const DIFF_STYLE: Record<string, { mark: string; className: string; title: string }> = {
  same: { mark: "=", className: "text-muted-foreground", title: "Same call as the reference" },
  changed: { mark: "~", className: "bg-warning/10 text-warning", title: "Same tool, other arguments" },
  added: { mark: "+", className: "bg-info/10 text-info", title: "The reference did not call it" },
};

function AnswerDiff({ col }: { col: BenchmarkCompareColumn }) {
  if (!col.textDiff) return <p className="whitespace-pre-wrap break-words text-xs">{col.finalText || "—"}</p>;
  return (
    <p className="whitespace-pre-wrap break-words text-xs" data-testid="bench-answer-diff">
      {col.textDiff.map((s, i) => s.op === "same" ? <span key={i}>{s.text}</span>
        : s.op === "add" ? <ins key={i} className="bg-success/15 text-success no-underline" data-diff="add">{s.text}</ins>
          : <del key={i} className="bg-destructive/15 text-destructive" data-diff="del">{s.text}</del>)}
    </p>
  );
}

export function BenchmarkSideBySideView({ comparison, onClose }: { comparison: BenchmarkCaseComparison; onClose?: () => void }) {
  const [showTrace, setShowTrace] = useState(true);
  const cols = comparison.columns;
  return (
    <section aria-label="Side by side" className="rounded-lg border border-border/40 bg-card/80" data-testid="bench-side-by-side">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-4 py-3">
        <Columns3 className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{comparison.caseName} · side by side</p>
          <p className="truncate text-caption text-muted-foreground">{comparison.key} · differences against {cols[0]?.label}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowTrace(!showTrace)} aria-pressed={showTrace}>{showTrace ? "Hide traces" : "Show traces"}</Button>
        {onClose && <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}
      </header>
      <div className={cn("grid grid-cols-1 gap-px bg-border/40", GRID[cols.length] ?? GRID[4])}>
        {cols.map((c, idx) => (
          <div key={`${c.variantId}-${c.runId}`} className="min-w-0 space-y-3 bg-card px-4 py-3" data-testid="bench-compare-column" data-variant={c.variantId}>
            <div className="flex min-w-0 items-center gap-2">
              <SuiteStatusIcon status={c.status as never} />
              <p className="min-w-0 flex-1 truncate text-xs font-medium">{c.label}</p>
              {idx === 0 ? <Badge variant="outline" className="text-micro">reference</Badge> : (
                <>
                  {!c.sameAsReference.tools && <Badge variant="outline" className="border-warning/40 text-micro text-warning" data-testid="bench-tools-differ">tools differ</Badge>}
                  {!c.sameAsReference.text && <Badge variant="outline" className="border-info/40 text-micro text-info" data-testid="bench-text-differs">answer differs</Badge>}
                </>
              )}
            </div>
            <p className="text-caption text-muted-foreground">
              {c.score !== undefined ? `score ${formatScore(c.score)} · ` : ""}{formatUsd(c.costUsd)} · {formatMs(c.durationMs)} · {c.tokens.input + c.tokens.output} tokens{c.repetition > 1 ? ` · repetition ${c.repetition}` : ""}
            </p>
            <div className="space-y-1">
              <p className="text-micro font-medium uppercase tracking-label text-muted-foreground">Tool calls</p>
              {c.toolCalls.length || c.missingCalls.length ? (
                <ul className="space-y-0.5 font-mono text-micro">
                  {c.toolCalls.map((t, i) => {
                    const st = DIFF_STYLE[t.diff] ?? DIFF_STYLE.same;
                    return (
                      <li key={i} className={cn("break-all rounded-xs px-1 py-0.5", st.className)} data-diff={t.diff} title={t.argChanges?.length ? `${st.title}: ${t.argChanges.join(", ")}` : st.title}>
                        {st.mark} {t.name} <span className="text-muted-foreground">{JSON.stringify(t.args).slice(0, 160)}</span>
                        {t.argChanges?.length ? <span> · changed {t.argChanges.join(", ")}</span> : null}
                        {t.isError ? <span className="text-destructive"> · error</span> : null}
                      </li>
                    );
                  })}
                  {c.missingCalls.map((m, i) => (
                    <li key={`m${i}`} className="rounded-xs bg-destructive/10 px-1 py-0.5 text-destructive" data-diff="missing">− {m} <span className="font-sans">(the reference called it)</span></li>
                  ))}
                </ul>
              ) : <p className="text-caption text-muted-foreground">No tool calls</p>}
            </div>
            <div className="space-y-1">
              <p className="text-micro font-medium uppercase tracking-label text-muted-foreground">Answer</p>
              <AnswerDiff col={c} />
            </div>
            {showTrace && <CaseTrace result={c.result} agentName={c.label} />}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Loads one case's comparison (for the variants picked) and draws it. */
export function BenchmarkSideBySide({ load, caseKey, variants, onClose }: { load: (caseKey: string, opts: { variants?: string[] }) => Promise<BenchmarkCaseComparison>; caseKey: string; variants: string[]; onClose?: () => void }) {
  const [state, setState] = useState<{ key: string; data?: BenchmarkCaseComparison; error?: string } | null>(null);
  const key = `${caseKey}|${variants.join(",")}`;
  useEffect(() => {
    let alive = true;
    load(caseKey, variants.length ? { variants } : {})
      .then((data) => { if (alive) setState({ key, data }); })
      .catch((e) => { if (alive) setState({ key, error: (e as Error).message }); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!state || state.key !== key) return <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  if (state.error || !state.data) return <p className="px-4 py-3 text-caption text-destructive">{state.error ?? "Nothing to compare"}</p>;
  return <BenchmarkSideBySideView comparison={state.data} {...(onClose ? { onClose } : {})} />;
}
