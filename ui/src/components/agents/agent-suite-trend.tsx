/**
 * A suite's trend in the Suites tab: its finished runs over time (pass rate and overall score, the
 * marked baseline highlighted) as a line chart, and the same averaged by version (production's,
 * a published one, the draft) — to see whether a change made the agent better or worse.
 */
import { Loader2, TrendingUp } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { useAgentSuiteTrend } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatMs, formatScore, formatUsd } from "@/lib/agent-suites";

const chartConfig = {
  passRate: { label: "Pass rate", color: "var(--chart-1)" },
  score: { label: "Score", color: "var(--chart-2)" },
} satisfies ChartConfig;

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function AgentSuiteTrend({ agentName, suiteId, suiteName, onClose, onOpenRun }: { agentName: string; suiteId: string; suiteName: string; onClose: () => void; onOpenRun?: (runId: string) => void }) {
  const { trend, isLoading, error } = useAgentSuiteTrend(agentName, suiteId);
  const points = trend?.points ?? [];
  const data = points.map((p) => ({ ...p, when: shortDate(p.startedAt), version: p.version ? `v${p.version}` : p.target }));
  const baseline = points.find((p) => p.isBaseline);
  const hasScore = points.some((p) => p.score !== undefined);
  return (
    <section aria-label="Suite trend" className="rounded-lg border border-border/40 bg-card/80" data-testid="suite-trend">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-4 py-3">
        <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{suiteName} · trend</p>
          <p className="text-caption text-muted-foreground">{points.length} finished run(s): pass rate{hasScore ? " and score" : ""} over time, and by version</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </header>
      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <p className="px-4 py-3 text-caption text-destructive">{error.message}</p>
      ) : !points.length ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">No finished runs yet</p>
      ) : (
        <div className="space-y-3 px-4 py-3">
          <ChartContainer config={chartConfig} className="aspect-auto h-48 w-full" data-testid="suite-trend-chart">
            <LineChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
              onClick={(e) => { const id = (e as { activePayload?: Array<{ payload?: { runId?: string } }> } | null)?.activePayload?.[0]?.payload?.runId; if (id) onOpenRun?.(id); }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="when" tickLine={false} axisLine={false} tickMargin={6} minTickGap={16} />
              <YAxis domain={[0, 1]} ticks={[0, 0.5, 1]} tickLine={false} axisLine={false} width={28} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => {
                const p = (payload?.[0] as { payload?: { when?: string; version?: string; costUsd?: number } } | undefined)?.payload;
                return p ? `${p.when} · ${p.version}${p.costUsd !== undefined ? ` · ${formatUsd(p.costUsd)}` : ""}` : "";
              }} />} />
              {baseline && <ReferenceLine x={shortDate(baseline.startedAt)} stroke="var(--muted-foreground)" strokeDasharray="3 3" />}
              <Line type="monotone" dataKey="passRate" stroke="var(--color-passRate)" strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} />
              {hasScore && <Line type="monotone" dataKey="score" stroke="var(--color-score)" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />}
            </LineChart>
          </ChartContainer>
          <table className="w-full text-caption" data-testid="suite-trend-versions">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 font-medium">Version</th>
                <th className="py-1 font-medium">Runs</th>
                <th className="py-1 font-medium">Pass rate</th>
                <th className="py-1 font-medium">Score</th>
                <th className="py-1 font-medium">Cost</th>
                <th className="py-1 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {(trend?.byVersion ?? []).map((v) => (
                <tr key={v.version} className="border-t border-border/30">
                  <td className="py-1 font-mono">{v.version === "draft" || v.version === "production" ? v.version : `v${v.version}`}</td>
                  <td className="py-1">{v.runs}</td>
                  <td className="py-1">{Math.round(v.passRate * 100)}%</td>
                  <td className="py-1">{formatScore(v.score)}</td>
                  <td className="py-1">{formatUsd(v.costUsd)}</td>
                  <td className="py-1">{formatMs(v.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
