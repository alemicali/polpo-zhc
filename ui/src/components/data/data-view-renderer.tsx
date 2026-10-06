import { useCallback, useEffect, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart,
  Funnel, FunnelChart, LabelList, Legend, PolarAngleAxis, PolarGrid, Radar, RadarChart,
  RadialBar, RadialBarChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip as RechartsTooltip,
  Treemap, XAxis, YAxis, ZAxis,
} from "recharts";
import { AlertTriangle, Braces, Database, Filter, Loader2, MessageSquarePlus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { sidebarActions } from "@/hooks/chat-context";
import { addDataPromptItem } from "@/hooks/use-data-context";
import { dataRequest, type DataColumn, type DataFrame, type DataView, type DataWidget } from "@/hooks/use-data";
import { cn } from "@/lib/utils";
import { useEvents } from "@polpo-ai/react";

const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function DataViewRenderer({ view, sessionId }: { view: DataView; sessionId: string | null }) {
  const { events } = useEvents(["data-source:changed", "agent:activity", "agent:finished"], 1);
  const [frames, setFrames] = useState<Record<string, DataFrame>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Loads run as async transitions: `loading` stays true until every pending
  // refresh has settled, without a synchronous setState inside the effects.
  const [loading, startLoading] = useTransition();
  const [search, setSearch] = useState("");
  const hasLiveData = view.bindings.some((binding) => Boolean(binding.query));
  const hasInlineData = view.bindings.some((binding) => Boolean(binding.inline));

  const refresh = useCallback(() => {
    startLoading(async () => {
      const results = await Promise.all(view.bindings.map(async (binding) => {
        try {
          if (binding.inline) return { id: binding.id, frame: inlineFrame(binding.id, binding.inline.label, binding.inline.rows) };
          return { id: binding.id, frame: await dataRequest<DataFrame>("/query", { method: "POST", body: JSON.stringify(binding.query) }) };
        } catch (error) {
          return { id: binding.id, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      setFrames(Object.fromEntries(results.filter((item): item is { id: string; frame: DataFrame } => "frame" in item).map((item) => [item.id, item.frame])));
      setErrors(Object.fromEntries(results.filter((item): item is { id: string; error: string } => "error" in item).map((item) => [item.id, item.error])));
    });
  }, [view.bindings]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!view.refreshSeconds) return;
    const timer = window.setInterval(refresh, view.refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [refresh, view.refreshSeconds]);
  const latestEvent = events.at(-1);
  useEffect(() => {
    if (!latestEvent) return;
    const data = latestEvent.data as { sourceId?: string; action?: string; tool?: string } | undefined;
    const mayHaveMutatedData = latestEvent.event === "agent:activity"
      && (data?.tool === "data_mutate" || data?.tool === "data_sql");
    if (latestEvent.event === "agent:finished" || mayHaveMutatedData || (data?.action === "data" && view.bindings.some((binding) => binding.query?.sourceId === data.sourceId))) refresh();
  }, [latestEvent, refresh, view.bindings]);

  const addView = () => {
    const first = view.bindings[0];
    if (!first) return;
    addDataPromptItem(sessionId, { sourceId: first.query?.sourceId ?? "inline", dataset: first.query?.dataset ?? first.inline?.label ?? first.id, viewId: view.id, label: view.name });
    sidebarActions.setSidebarOpen(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            <h2 className="truncate text-sm font-semibold">{view.name}</h2>
            <span className="border border-border px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">{view.persistence}</span>
            {hasLiveData && <span className="inline-flex items-center gap-1 border border-border bg-muted/30 px-1.5 py-0.5 text-[9px] text-muted-foreground"><Database className="h-2.5 w-2.5" />Live source</span>}
            {hasInlineData && <span className="inline-flex items-center gap-1 border border-border bg-muted/30 px-1.5 py-0.5 text-[9px] text-muted-foreground"><Braces className="h-2.5 w-2.5" />Inline data</span>}
          </div>
          {view.description && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{view.description}</p>}
        </div>
        <div className="relative w-44 max-w-full">
          <Filter className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-8 pl-7 text-xs" placeholder="Filter visible data" />
        </div>
        <Tooltip>
          <TooltipTrigger asChild><Button size="icon" variant="ghost" className="h-8 w-8" onClick={addView}><MessageSquarePlus className="h-3.5 w-3.5" /></Button></TooltipTrigger>
          <TooltipContent>Add this view to the next prompt</TooltipContent>
        </Tooltip>
        {hasLiveData && <Button size="icon" variant="ghost" className="h-8 w-8" onClick={refresh} disabled={loading} aria-label="Refresh data view">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        <div className="grid auto-rows-min grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {view.widgets.map((widget) => {
            const frame = widget.binding ? frames[widget.binding] : undefined;
            const error = widget.binding ? errors[widget.binding] : undefined;
            return (
              <WidgetShell key={widget.id} widget={widget} className={widthClass(widget.width)}>
                {error ? <WidgetError error={error} /> : widget.binding && !frame ? <WidgetLoading /> : (
                  <WidgetContent widget={widget} frame={frame} search={search} view={view} sessionId={sessionId} />
                )}
              </WidgetShell>
            );
          })}
          {view.widgets.length === 0 && (
            <div className="col-span-full border border-dashed border-border p-10 text-center text-sm text-muted-foreground">This view has no widgets yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function WidgetShell({ widget, className, children }: { widget: DataWidget; className?: string; children: React.ReactNode }) {
  return (
    <section className={cn("min-w-0 overflow-hidden border border-border bg-card", className)}>
      {(widget.title || widget.description) && (
        <header className="border-b border-border/70 px-3 py-2.5">
          {widget.title && <h3 className="text-xs font-semibold">{widget.title}</h3>}
          {widget.description && <p className="mt-0.5 text-[10px] text-muted-foreground">{widget.description}</p>}
        </header>
      )}
      <div className={cn("min-h-28", widget.height === "compact" && "min-h-20", widget.height === "tall" && "min-h-80")}>{children}</div>
    </section>
  );
}

function WidgetContent({ widget, frame, search, view, sessionId }: { widget: DataWidget; frame?: DataFrame; search: string; view: DataView; sessionId: string | null }) {
  if (widget.type === "markdown") return <div className="prose prose-sm max-w-none p-4 text-sm dark:prose-invert"><ReactMarkdown>{widget.markdown ?? ""}</ReactMarkdown></div>;
  if (!frame) return <WidgetError error="Widget has no data binding" />;
  const rows = filterRows(frame.rows, search);
  if (widget.type === "metric") return <MetricWidget widget={widget} rows={rows} />;
  if (widget.type === "table") return <TableWidget frame={{ ...frame, rows }} view={view} sessionId={sessionId} />;
  if (widget.type === "record") return <RecordWidget frame={{ ...frame, rows }} view={view} sessionId={sessionId} />;
  if (widget.type === "status") return <StatusWidget widget={widget} rows={rows} />;
  if (widget.type === "timeline") return <TimelineWidget widget={widget} rows={rows} />;
  if (widget.type === "list") return <ListWidget widget={widget} rows={rows} />;
  if (widget.type === "progress") return <ProgressWidget widget={widget} rows={rows} />;
  if (widget.type === "gauge") return <GaugeWidget widget={widget} rows={rows} />;
  if (widget.type === "comparison") return <ComparisonWidget widget={widget} rows={rows} />;
  if (widget.type === "ranking") return <RankingWidget widget={widget} rows={rows} />;
  if (widget.type === "heatmap") return <HeatmapWidget widget={widget} rows={rows} />;
  if (widget.type === "histogram") return <HistogramWidget widget={widget} rows={rows} />;
  return <ChartWidget widget={widget} rows={rows} />;
}

function MetricWidget({ widget, rows }: { widget: DataWidget; rows: Record<string, unknown>[] }) {
  const aggregate = widget.aggregate ?? (widget.field ? "sum" : "count");
  const value = aggregateValue(widget, rows);
  return <div className="flex min-h-28 flex-col justify-end p-4"><div className="font-mono text-3xl font-semibold tabular-nums">{formatMetric(value, widget)}</div><div className="mt-1 text-[10px] uppercase text-muted-foreground">{aggregate}{widget.field ? ` · ${widget.field}` : ""}</div></div>;
}

function TableWidget({ frame, view, sessionId }: { frame: DataFrame; view: DataView; sessionId: string | null }) {
  const addRow = (row: Record<string, unknown>) => {
    addDataPromptItem(sessionId, { sourceId: frame.meta.sourceId, dataset: frame.meta.dataset, queryId: frame.meta.queryId, viewId: view.id, row, label: recordLabel(row) });
    sidebarActions.setSidebarOpen(true);
  };
  return (
    <div className="max-h-[420px] overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card"><TableRow>{frame.columns.map((column) => <TableHead key={column.name} className="h-8 text-[10px]">{column.name}</TableHead>)}<TableHead className="w-8" /></TableRow></TableHeader>
        <TableBody>{frame.rows.map((row, index) => (
          <TableRow key={index} className="group cursor-default">
            {frame.columns.map((column) => <TableCell key={column.name} className="max-w-64 truncate py-1.5 text-xs">{displayValue(row[column.name])}</TableCell>)}
            <TableCell className="p-1"><Button size="icon" variant="ghost" className="h-6 w-6 opacity-0 group-hover:opacity-100" onClick={() => addRow(row)}><MessageSquarePlus className="h-3 w-3" /></Button></TableCell>
          </TableRow>
        ))}</TableBody>
      </Table>
      {frame.rows.length === 0 && <div className="p-8 text-center text-xs text-muted-foreground">No rows</div>}
    </div>
  );
}

function RecordWidget({ frame, view, sessionId }: { frame: DataFrame; view: DataView; sessionId: string | null }) {
  const row = frame.rows[0];
  if (!row) return <div className="p-8 text-center text-xs text-muted-foreground">No record</div>;
  return <div className="p-3"><dl className="grid grid-cols-[minmax(90px,0.35fr)_1fr] gap-x-3 gap-y-2">{frame.columns.map((column) => <div className="contents" key={column.name}><dt className="truncate text-[10px] text-muted-foreground">{column.name}</dt><dd className="min-w-0 break-words text-xs">{displayValue(row[column.name])}</dd></div>)}</dl><Button variant="ghost" size="sm" className="mt-3 h-7 px-2 text-[10px]" onClick={() => { addDataPromptItem(sessionId, { sourceId: frame.meta.sourceId, dataset: frame.meta.dataset, queryId: frame.meta.queryId, viewId: view.id, row, label: recordLabel(row) }); sidebarActions.setSidebarOpen(true); }}><MessageSquarePlus className="h-3 w-3" /> Add to prompt</Button></div>;
}

function ListWidget({ widget, rows }: { widget: DataWidget; rows: Record<string, unknown>[] }) {
  const label = widget.category ?? widget.field ?? Object.keys(rows[0] ?? {})[0];
  const detail = widget.value ?? widget.y ?? Object.keys(rows[0] ?? {}).find((field) => field !== label);
  if (!label) return <WidgetError error="List needs a label field" />;
  return <div className="max-h-80 divide-y divide-border/70 overflow-auto">{rows.slice(0, 100).map((row, index) => <div key={index} className="flex items-center gap-3 px-3 py-2.5"><span className="flex h-5 w-5 shrink-0 items-center justify-center border border-border font-mono text-[9px] text-muted-foreground">{index + 1}</span><span className="min-w-0 flex-1 truncate text-xs font-medium">{displayValue(row[label])}</span>{detail && <span className="max-w-[45%] truncate text-[11px] text-muted-foreground">{displayValue(row[detail])}</span>}</div>)}</div>;
}

function ProgressWidget({ widget, rows }: { widget: DataWidget; rows: Record<string, unknown>[] }) {
  const value = aggregateValue(widget, rows);
  const min = widget.min ?? 0;
  const max = widget.target ?? widget.max ?? 100;
  const progress = Math.max(0, Math.min(100, ((value - min) / Math.max(max - min, 1)) * 100));
  return <div className="flex min-h-28 flex-col justify-center p-4"><div className="flex items-end justify-between gap-3"><span className="font-mono text-2xl font-semibold tabular-nums">{formatMetric(value, widget)}</span><span className="text-[10px] text-muted-foreground">of {formatMetric(max, widget)}</span></div><div className="mt-3 h-2 overflow-hidden bg-muted"><div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${progress}%` }} /></div><div className="mt-1.5 text-right font-mono text-[10px] text-muted-foreground">{Math.round(progress)}%</div></div>;
}

function GaugeWidget({ widget, rows }: { widget: DataWidget; rows: Record<string, unknown>[] }) {
  const value = aggregateValue(widget, rows);
  const min = widget.min ?? 0;
  const max = widget.target ?? widget.max ?? 100;
  const progress = Math.max(0, Math.min(100, ((value - min) / Math.max(max - min, 1)) * 100));
  const data = [{ name: "value", value: progress, fill: "var(--chart-1)" }];
  return <div className="relative h-52"><ResponsiveContainer><RadialBarChart innerRadius="68%" outerRadius="88%" data={data} startAngle={210} endAngle={-30}><RadialBar dataKey="value" background={{ fill: "var(--muted)" }} cornerRadius={2} /></RadialBarChart></ResponsiveContainer><div className="pointer-events-none absolute inset-x-0 bottom-10 text-center"><div className="font-mono text-2xl font-semibold">{formatMetric(value, widget)}</div><div className="text-[10px] text-muted-foreground">{Math.round(progress)}% of target</div></div></div>;
}

function ComparisonWidget({ widget, rows }: { widget: DataWidget; rows: Record<string, unknown>[] }) {
  const field = widget.field ?? widget.value ?? numericField(rows);
  if (!field || rows.length < 2) return <WidgetError error="Comparison needs two rows and a numeric field" />;
  const current = Number(rows[0]?.[field] ?? 0);
  const previous = Number(rows[1]?.[field] ?? 0);
  const delta = current - previous;
  const percent = previous === 0 ? 0 : (delta / Math.abs(previous)) * 100;
  return <div className="flex min-h-28 items-end gap-5 p-4"><div className="min-w-0 flex-1"><div className="text-[10px] text-muted-foreground">Current</div><div className="mt-1 truncate font-mono text-2xl font-semibold">{formatMetric(current, widget)}</div></div><div className={cn("pb-1 text-right", delta > 0 ? "text-emerald-500" : delta < 0 ? "text-destructive" : "text-muted-foreground")}><div className="font-mono text-sm font-semibold">{delta > 0 ? "+" : ""}{formatMetric(delta, widget)}</div><div className="text-[10px]">{percent > 0 ? "+" : ""}{percent.toFixed(1)}%</div></div></div>;
}

function RankingWidget({ widget, rows }: { widget: DataWidget; rows: Record<string, unknown>[] }) {
  const label = widget.category ?? widget.x ?? Object.keys(rows[0] ?? {})[0];
  const value = widget.value ?? widget.y ?? widget.field ?? numericField(rows);
  if (!label || !value) return <WidgetError error="Ranking needs category and value fields" />;
  const ranked = rows.map((row) => ({ label: displayValue(row[label]), value: Number(row[value] ?? 0) })).filter((row) => Number.isFinite(row.value)).sort((a, b) => b.value - a.value).slice(0, 10);
  const max = Math.max(...ranked.map((row) => row.value), 1);
  return <div className="space-y-2.5 p-3">{ranked.map((row, index) => <div key={`${row.label}:${index}`} className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2"><span className="font-mono text-[10px] text-muted-foreground">{index + 1}</span><div className="min-w-0"><div className="truncate text-xs">{row.label}</div><div className="mt-1 h-1 bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.max(2, row.value / max * 100)}%` }} /></div></div><span className="font-mono text-[11px] font-semibold">{formatMetric(row.value, widget)}</span></div>)}</div>;
}

function HeatmapWidget({ widget, rows }: { widget: DataWidget; rows: Record<string, unknown>[] }) {
  const x = widget.x ?? widget.category ?? Object.keys(rows[0] ?? {})[0];
  const y = widget.y ?? Object.keys(rows[0] ?? {})[1];
  const value = widget.value ?? widget.field ?? numericField(rows, [x, y].filter(Boolean) as string[]);
  if (!x || !y || !value) return <WidgetError error="Heatmap needs x, y, and value fields" />;
  const xs = [...new Set(rows.map((row) => displayValue(row[x])))].slice(0, 12);
  const ys = [...new Set(rows.map((row) => displayValue(row[y])))].slice(0, 12);
  const lookup = new Map(rows.map((row) => [`${displayValue(row[x])}\u0000${displayValue(row[y])}`, Number(row[value] ?? 0)]));
  const values = [...lookup.values()].filter(Number.isFinite);
  const min = Math.min(...values, 0); const max = Math.max(...values, 1);
  return <div className="overflow-auto p-3"><div className="grid min-w-[360px] gap-1" style={{ gridTemplateColumns: `80px repeat(${xs.length}, minmax(28px, 1fr))` }}><span />{xs.map((item) => <span key={item} className="truncate text-center text-[9px] text-muted-foreground">{item}</span>)}{ys.flatMap((rowLabel) => [<span key={`y:${rowLabel}`} className="truncate py-2 text-[9px] text-muted-foreground">{rowLabel}</span>, ...xs.map((columnLabel) => { const current = lookup.get(`${columnLabel}\u0000${rowLabel}`) ?? 0; const strength = Math.round(8 + ((current - min) / Math.max(max - min, 1)) * 72); return <Tooltip key={`${rowLabel}:${columnLabel}`}><TooltipTrigger asChild><span className="min-h-8" style={{ background: `color-mix(in srgb, var(--chart-1) ${strength}%, var(--background))` }} /></TooltipTrigger><TooltipContent>{columnLabel} · {rowLabel}: {formatMetric(current, widget)}</TooltipContent></Tooltip>; })])}</div></div>;
}

function HistogramWidget({ widget, rows }: { widget: DataWidget; rows: Record<string, unknown>[] }) {
  const field = widget.field ?? widget.value ?? numericField(rows);
  if (!field) return <WidgetError error="Histogram needs a numeric field" />;
  const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
  if (!values.length) return <WidgetError error="Histogram has no numeric values" />;
  const min = Math.min(...values); const max = Math.max(...values); const count = Math.min(12, Math.max(4, Math.ceil(Math.sqrt(values.length)))); const size = Math.max((max - min) / count, 1);
  const bins = Array.from({ length: count }, (_, index) => ({ label: formatValue(min + index * size), count: 0 }));
  values.forEach((value) => { bins[Math.min(count - 1, Math.floor((value - min) / size))]!.count += 1; });
  return <div className="h-64 p-2"><ResponsiveContainer><BarChart data={bins}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} /><YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={34} /><RechartsTooltip /><Bar dataKey="count" fill="var(--chart-1)" /></BarChart></ResponsiveContainer></div>;
}

function ChartWidget({ widget, rows }: { widget: DataWidget; rows: Record<string, unknown>[] }) {
  const x = widget.x ?? widget.category ?? Object.keys(rows[0] ?? {})[0];
  const y = widget.y ?? widget.value ?? Object.keys(rows[0] ?? {}).find((field) => typeof rows[0]?.[field] === "number");
  if (!x || !y) return <WidgetError error="Chart needs x/category and y/value fields" />;
  const data = rows.slice(0, 100).map((row) => ({ ...row, [y]: Number(row[y] ?? 0) }));
  if (widget.type === "pie" || widget.type === "donut") return <div className="h-64 p-2"><ResponsiveContainer><PieChart><Pie data={data} dataKey={y} nameKey={x} innerRadius={widget.type === "donut" ? "45%" : 0} outerRadius="78%">{data.map((_, index) => <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}</Pie><RechartsTooltip />{widget.showLegend && <Legend wrapperStyle={{ fontSize: 10 }} />}</PieChart></ResponsiveContainer></div>;
  if (widget.type === "sparkline") return <div className="h-28 p-2"><ResponsiveContainer><LineChart data={data}><RechartsTooltip /><Line dataKey={y} stroke="var(--chart-1)" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div>;
  if (widget.type === "scatter") return <div className="h-64 p-2"><ResponsiveContainer><ScatterChart><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey={x} type="number" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis dataKey={y} type="number" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={42} /><ZAxis range={[30, 180]} /><RechartsTooltip /><Scatter data={data} fill="var(--chart-1)" /></ScatterChart></ResponsiveContainer></div>;
  if (widget.type === "radar") return <div className="h-64 p-2"><ResponsiveContainer><RadarChart data={data}><PolarGrid stroke="var(--border)" /><PolarAngleAxis dataKey={x} tick={{ fontSize: 10 }} /><Radar dataKey={y} stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.2} /><RechartsTooltip /></RadarChart></ResponsiveContainer></div>;
  if (widget.type === "funnel") return <div className="h-64 p-2"><ResponsiveContainer><FunnelChart><RechartsTooltip /><Funnel dataKey={y} nameKey={x} data={data} fill="var(--chart-1)">{data.map((_, index) => <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}<LabelList position="right" fill="var(--foreground)" stroke="none" dataKey={x} fontSize={10} /></Funnel></FunnelChart></ResponsiveContainer></div>;
  if (widget.type === "treemap") return <div className="h-64 p-2"><ResponsiveContainer><Treemap data={data} dataKey={y} nameKey={x} stroke="var(--background)" fill="var(--chart-1)"><RechartsTooltip /></Treemap></ResponsiveContainer></div>;
  const common = <><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} /><XAxis dataKey={x} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={42} /><RechartsTooltip /></>;
  if (widget.type === "bar") return <div className="h-64 p-2"><ResponsiveContainer><BarChart data={data}>{common}<Bar dataKey={y} fill="var(--chart-1)" radius={[2, 2, 0, 0]} /></BarChart></ResponsiveContainer></div>;
  if (widget.type === "area") return <div className="h-64 p-2"><ResponsiveContainer><AreaChart data={data}>{common}<Area dataKey={y} stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.18} /></AreaChart></ResponsiveContainer></div>;
  return <div className="h-64 p-2"><ResponsiveContainer><LineChart data={data}>{common}<Line dataKey={y} stroke="var(--chart-1)" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div>;
}

function StatusWidget({ widget, rows }: { widget: DataWidget; rows: Record<string, unknown>[] }) {
  const field = widget.field ?? widget.category ?? Object.keys(rows[0] ?? {})[0];
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(String(row[field] ?? "Unknown"), (counts.get(String(row[field] ?? "Unknown")) ?? 0) + 1);
  return <div className="space-y-2 p-3">{[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label, value], index) => <div key={label} className="flex items-center gap-2"><span className="h-2 w-2" style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} /><span className="min-w-0 flex-1 truncate text-xs">{label}</span><span className="font-mono text-xs font-semibold">{value}</span></div>)}</div>;
}

function TimelineWidget({ widget, rows }: { widget: DataWidget; rows: Record<string, unknown>[] }) {
  const date = widget.x ?? Object.keys(rows[0] ?? {}).find((field) => /date|time|at$/i.test(field));
  const label = widget.y ?? widget.field ?? Object.keys(rows[0] ?? {}).find((field) => field !== date);
  if (!date || !label) return <WidgetError error="Timeline needs date and label fields" />;
  return <div className="max-h-80 overflow-auto p-3">{rows.slice(0, 100).map((row, index) => <div key={index} className="relative border-l border-border pb-4 pl-4 last:pb-0"><span className="absolute -left-1 top-1 h-2 w-2 bg-primary" /><div className="text-[10px] text-muted-foreground">{displayValue(row[date])}</div><div className="mt-0.5 text-xs">{displayValue(row[label])}</div></div>)}</div>;
}

function WidgetLoading() { return <div className="flex min-h-28 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>; }
function WidgetError({ error }: { error: string }) { return <div className="flex min-h-28 items-center justify-center gap-2 p-4 text-xs text-destructive"><AlertTriangle className="h-4 w-4 shrink-0" /><span>{error}</span></div>; }
function widthClass(width: DataWidget["width"]) { return width === 4 ? "md:col-span-2 xl:col-span-4" : width === 3 ? "md:col-span-2 xl:col-span-3" : width === 2 ? "md:col-span-2 xl:col-span-2" : ""; }
function filterRows(rows: Record<string, unknown>[], search: string) { const q = search.trim().toLocaleLowerCase(); return q ? rows.filter((row) => Object.values(row).some((value) => displayValue(value).toLocaleLowerCase().includes(q))) : rows; }
function displayValue(value: unknown): string { if (value == null) return "—"; if (typeof value === "object") return JSON.stringify(value); return String(value); }
function formatValue(value: number): string { return new Intl.NumberFormat(undefined, { notation: Math.abs(value) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0); }
function recordLabel(row: Record<string, unknown>): string { const candidate = row.name ?? row.title ?? row.label ?? row.id; return candidate ? String(candidate) : "Selected data record"; }

function aggregateValue(widget: DataWidget, rows: Record<string, unknown>[]): number {
  const field = widget.field ?? widget.value ?? numericField(rows);
  const aggregate = widget.aggregate ?? (field ? "sum" : "count");
  if (aggregate === "count") return rows.length;
  const values = field ? rows.map((row) => Number(row[field])).filter(Number.isFinite) : [];
  if (!values.length) return 0;
  if (aggregate === "avg") return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (aggregate === "min") return Math.min(...values);
  if (aggregate === "max") return Math.max(...values);
  return values.reduce((sum, value) => sum + value, 0);
}

function numericField(rows: Record<string, unknown>[], excluded: string[] = []): string | undefined {
  const blocked = new Set(excluded);
  return Object.keys(rows[0] ?? {}).find((field) => !blocked.has(field) && rows.some((row) => typeof row[field] === "number"));
}

function formatMetric(value: number, widget: DataWidget): string {
  if (widget.format === "currency") return new Intl.NumberFormat(undefined, { style: "currency", currency: widget.currency ?? "USD", maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0);
  if (widget.format === "percent") return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(Number.isFinite(value) ? value : 0)}%`;
  if (widget.format === "compact") return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0);
  return formatValue(value);
}

function inlineFrame(id: string, label: string | undefined, rows: Record<string, unknown>[]): DataFrame {
  return {
    columns: inferInlineColumns(rows),
    rows,
    meta: {
      sourceId: "inline",
      dataset: label ?? id,
      queryId: `inline:${id}`,
      rowCount: rows.length,
      truncated: false,
      durationMs: 0,
      fetchedAt: new Date().toISOString(),
    },
  };
}

function inferInlineColumns(rows: Record<string, unknown>[]): DataColumn[] {
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return names.map((name) => {
    const value = rows.map((row) => row[name]).find((candidate) => candidate != null);
    const type: DataColumn["type"] = typeof value === "number" ? "number"
      : typeof value === "boolean" ? "boolean"
        : typeof value === "object" ? "json"
          : typeof value === "string" && !Number.isNaN(Date.parse(value)) && /[-T:]/.test(value) ? "datetime"
            : typeof value === "string" ? "string" : "unknown";
    return { name, type, nullable: rows.some((row) => row[name] == null) };
  });
}
