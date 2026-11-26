/**
 * A decision's answers with probability bars: yes / no for a predicate, every option for a choice
 * (the chosen one first), every level for a score (in order), the ranked items for a rank (bars
 * relative to the best). Confidence, threshold and "uncertain" on each. Tokens only.
 */
import type { DecisionAnswer } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { answerBars } from "@/lib/decisions";
import { cn } from "@/lib/utils";

const pct = (v: number) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;

export function DecisionAnswerView({ answer }: { answer: DecisionAnswer }) {
  const { headline, bars, relative } = answerBars(answer);
  return (
    <div className="space-y-1.5" data-answer={answer.name}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-caption text-muted-foreground">{answer.name}</span>
        <span className="text-sm font-semibold break-words">{headline}</span>
        {answer.uncertain && <Badge variant="outline" className="text-micro font-normal text-warning">Uncertain</Badge>}
        {(answer.confidence !== undefined || answer.threshold !== undefined) && (
          <span className="text-micro text-muted-foreground">
            {answer.confidence !== undefined && `confidence ${answer.confidence.toFixed(2)}`}
            {answer.confidence !== undefined && answer.threshold !== undefined && " · "}
            {answer.threshold !== undefined && `threshold ${answer.threshold.toFixed(2)}`}
          </span>
        )}
      </div>
      <div className="space-y-1">
        {bars.map((b) => (
          <div key={b.label} className="space-y-0.5" data-bar={b.label}>
            <div className="flex justify-between gap-2 text-caption">
              <span className={cn("truncate", b.chosen ? "font-medium text-foreground" : "text-muted-foreground")}>{b.label}</span>
              {!relative && <span className="tabular-nums text-muted-foreground">{pct(b.value)}</span>}
            </div>
            <div className="h-1.5 overflow-hidden rounded-pill bg-muted" role="meter" aria-label={b.label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.round(b.value * 1000) / 1000}>
              <div className={cn("h-full rounded-pill", b.chosen ? "bg-primary" : "bg-primary/40")} style={{ width: pct(b.value) }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DecisionAnswers({ answers }: { answers: DecisionAnswer[] }) {
  return <div className="space-y-4" data-testid="decision-answers">{answers.map((a) => <DecisionAnswerView key={a.name} answer={a} />)}</div>;
}
