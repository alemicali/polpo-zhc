import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Braces, Check, ChevronRight, Database, FileJson, Filter,
  Gauge, Loader2, Network, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Save,
  Search, ShieldCheck, Table2, Trash2, Unplug,
} from "lucide-react";
import { toast } from "sonner";
import { useAgents, useEvents } from "@polpo-ai/react";
import { DataViewRenderer } from "@/components/data/data-view-renderer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChatSessionState } from "@/hooks/chat-context";
import {
  dataViewRequest,
  useDataSources,
  useDataViews,
  type DataActivity,
  type DataDataset,
  type DataFrame,
  type DataGrant,
  type DataQuery,
  type DataSource,
  type DataSourceInput,
  type DataSourceKind,
  type DataView,
} from "@/hooks/use-data";
import { cn } from "@/lib/utils";

type MainTab = "sources" | "explore";
type SourceTab = "overview" | "schema" | "access" | "activity";

const SOURCE_KINDS: Array<{ kind: DataSourceKind; label: string; description: string }> = [
  { kind: "postgres", label: "PostgreSQL", description: "Live relational database" },
  { kind: "sqlite", label: "SQLite", description: "Local database file" },
  { kind: "rest", label: "REST API", description: "JSON HTTP endpoint" },
  { kind: "json", label: "JSON", description: "Local structured file" },
  { kind: "csv", label: "CSV", description: "Local tabular file" },
];

export function DataPage() {
  const registry = useDataSources();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as MainTab | null) ?? "sources";
  const selectedSource = registry.sources.find((source) => source.id === params.get("source")) ?? registry.sources[0];
  const [sourceDialog, setSourceDialog] = useState<{ open: boolean; source?: DataSource }>({ open: false });

  const switchTab = (next: MainTab) => setParams((current) => {
    const updated = new URLSearchParams(current); updated.set("tab", next); return updated;
  });
  const selectSource = (source: DataSource) => setParams({ tab: "sources", source: source.id });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 bg-background">
      <div className="flex shrink-0 items-center gap-2">
        <Tabs value={tab} onValueChange={(value) => switchTab(value as MainTab)}>
          <TabsList variant="line" className="h-8">
            <TabsTrigger value="sources"><Database className="h-3.5 w-3.5" /><span className={tab === "sources" ? "inline" : "hidden lg:inline"}>Sources</span></TabsTrigger>
            <TabsTrigger value="explore"><Search className="h-3.5 w-3.5" /><span className={tab === "explore" ? "inline" : "hidden lg:inline"}>Explore</span></TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="min-w-0 flex-1" />
        {tab === "sources" && <Button size="sm" className="h-8" onClick={() => setSourceDialog({ open: true })}><Plus className="h-3.5 w-3.5" /> Add source</Button>}
      </div>

      {registry.error && <div className="border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{registry.error}</div>}
      {registry.loading ? <Loading /> : tab === "sources" ? (
        <SourcesWorkspace registry={registry} source={selectedSource} onSelect={selectSource} onEdit={(source) => setSourceDialog({ open: true, source })} />
      ) : <ExploreWorkspace registry={registry} initialSource={selectedSource} onOpenView={(id) => navigate(`/views?view=${encodeURIComponent(id)}`)} />}
      <SourceDialog open={sourceDialog.open} source={sourceDialog.source} registry={registry} onClose={() => setSourceDialog({ open: false })} />
    </div>
  );
}

export function DataViewsPage() {
  const registry = useDataViews();
  const { sessionId } = useChatSessionState();
  const [params, setParams] = useSearchParams();
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem("polpo:data-views-sidebar") !== "closed");
  useEffect(() => { localStorage.setItem("polpo:data-views-sidebar", sidebarOpen ? "open" : "closed"); }, [sidebarOpen]);
  const selected = registry.views.find((view) => view.id === params.get("view")) ?? registry.views[0];
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {registry.error && <div className="mb-3 border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{registry.error}</div>}
      {!registry.loading && registry.views.length > 0 && <div className="mb-3 flex shrink-0 items-center"><Tooltip><TooltipTrigger asChild><Button size="icon" variant="outline" className="h-8 w-8" onClick={() => setSidebarOpen((current) => !current)} aria-label={sidebarOpen ? "Hide views list" : "Show views list"}>{sidebarOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}</Button></TooltipTrigger><TooltipContent>{sidebarOpen ? "Hide views list" : "Show views list"}</TooltipContent></Tooltip></div>}
      {registry.loading ? <Loading /> : <ViewsWorkspace registry={registry} selected={selected} onSelect={(id) => setParams({ view: id })} sessionId={sessionId} sidebarOpen={sidebarOpen} />}
    </div>
  );
}

function SourcesWorkspace({ registry, source, onSelect, onEdit }: { registry: ReturnType<typeof useDataSources>; source?: DataSource; onSelect: (source: DataSource) => void; onEdit: (source: DataSource) => void }) {
  const [query, setQuery] = useState("");
  const filtered = registry.sources.filter((item) => `${item.name} ${item.kind} ${item.tags.join(" ")}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/15 xl:w-72">
        <div className="relative border-b border-border p-2"><Search className="absolute left-4 top-4 h-3.5 w-3.5 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a source" className="h-8 pl-8 text-xs" /></div>
        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {filtered.map((item) => <button key={item.id} onClick={() => onSelect(item)} className={cn("mb-1 flex w-full items-center gap-2 border px-2.5 py-2 text-left transition-colors", source?.id === item.id ? "border-primary/40 bg-primary/5" : "border-transparent hover:bg-muted/60")}><SourceIcon kind={item.kind} /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{item.name}</span><span className="block truncate text-[10px] text-muted-foreground">{sourceLabel(item)}</span></span><ChevronRight className="h-3 w-3 text-muted-foreground" /></button>)}
          {filtered.length === 0 && <Empty compact title="No sources found" />}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden">{source ? <SourceDetail source={source} registry={registry} onEdit={() => onEdit(source)} /> : <Empty title="Connect your first data source" description="Register a database, API, or local structured file." />}</main>
    </div>
  );
}

function SourceDetail({ source, registry, onEdit }: { source: DataSource; registry: ReturnType<typeof useDataSources>; onEdit: () => void }) {
  const { events } = useEvents(["data-source:changed"], 1);
  const [tab, setTab] = useState<SourceTab>("overview");
  const [datasets, setDatasets] = useState<DataDataset[]>([]);
  const [activity, setActivity] = useState<DataActivity[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const loadSchema = useCallback(async () => { setBusy("schema"); try { setDatasets(await registry.describeSource(source.id)); } catch (error) { toast.error(message(error)); } finally { setBusy(null); } }, [registry.describeSource, source.id]);
  const loadActivity = useCallback(async () => { try { setActivity(await registry.sourceActivity(source.id)); } catch (error) { toast.error(message(error)); } }, [registry.sourceActivity, source.id]);
  useEffect(() => { setDatasets([]); setActivity([]); setTab("overview"); }, [source.id]);
  useEffect(() => { if (tab === "schema" && datasets.length === 0) void loadSchema(); if (tab === "activity") void loadActivity(); }, [datasets.length, loadActivity, loadSchema, tab]);
  const latestEvent = events.at(-1);
  useEffect(() => {
    const data = latestEvent?.data as { sourceId?: string; action?: string } | undefined;
    if (tab === "activity" && data?.sourceId === source.id && (data.action === "activity" || data.action === "data")) void loadActivity();
  }, [latestEvent, loadActivity, source.id, tab]);

  const test = async () => { setBusy("test"); try { const result = await registry.testSource(source.id); toast.success(`Connected in ${result.latencyMs}ms · ${result.datasets} datasets`); } catch (error) { toast.error(message(error)); } finally { setBusy(null); } };
  const remove = async () => { if (!window.confirm(`Delete ${source.name}? Existing Views will be kept, but their unavailable bindings will need to be updated.`)) return; try { await registry.deleteSource(source.id); toast.success("Data source removed"); } catch (error) { toast.error(message(error)); } };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-5 py-4">
        <div className="flex items-start gap-3"><div className="flex h-10 w-10 items-center justify-center border border-border bg-muted/30"><SourceIcon kind={source.kind} className="h-5 w-5" /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">{source.name}</h2><span className="border border-border px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">{source.environment}</span></div><p className="mt-1 max-w-2xl text-xs text-muted-foreground">{source.description || sourceLabel(source)}</p></div><Button variant="outline" size="sm" className="h-8" onClick={() => void test()} disabled={busy === "test"}>{busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />} Test</Button><Button variant="ghost" size="sm" className="h-8" onClick={onEdit}>Settings</Button></div>
        <Tabs value={tab} onValueChange={(value) => setTab(value as SourceTab)} className="mt-4"><TabsList variant="line"><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="schema">Schema</TabsTrigger><TabsTrigger value="access">Access</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList></Tabs>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {tab === "overview" && <SourceOverview source={source} onDelete={() => void remove()} />}
        {tab === "schema" && <SchemaView datasets={datasets} loading={busy === "schema"} refresh={() => void loadSchema()} />}
        {tab === "access" && <AccessView source={source} registry={registry} />}
        {tab === "activity" && <ActivityView activity={activity} />}
      </div>
    </div>
  );
}

function SourceOverview({ source, onDelete }: { source: DataSource; onDelete: () => void }) {
  const entries = [["Connector", source.kind.toUpperCase()], [source.kind === "postgres" ? "Host" : source.kind === "rest" ? "Base URL" : "Location", source.config.location], ["Default dataset", source.config.defaultDataset || "Automatic discovery"], ["Agent grants", String(source.grants.length)]];
  return <div className="mx-auto max-w-4xl space-y-6"><section><h3 className="text-xs font-semibold">Connection</h3><dl className="mt-3 divide-y divide-border border-y border-border">{entries.map(([label, value]) => <div key={label} className="grid grid-cols-[150px_1fr] gap-4 py-3 text-xs"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-all font-mono">{value}</dd></div>)}</dl></section><section><h3 className="text-xs font-semibold">Categories</h3><div className="mt-3 flex flex-wrap gap-1.5">{source.tags.length ? source.tags.map((tag) => <span key={tag} className="border border-border bg-muted/30 px-2 py-1 text-[10px]">{tag}</span>) : <span className="text-xs text-muted-foreground">No categories</span>}</div></section><section className="border-t border-border pt-5"><h3 className="text-xs font-semibold text-destructive">Danger zone</h3><p className="mt-1 text-xs text-muted-foreground">Deleting the registry entry never deletes the underlying database or file.</p><Button variant="outline" size="sm" className="mt-3 h-8 border-destructive/40 text-destructive hover:bg-destructive/10" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /> Delete source</Button></section></div>;
}

function SchemaView({ datasets, loading, refresh }: { datasets: DataDataset[]; loading: boolean; refresh: () => void }) {
  // Nothing explicitly expanded falls back to the first dataset (derived, not synced in an effect).
  const [expandedChoice, setExpanded] = useState<string | null>(null);
  const expanded = expandedChoice ?? datasets[0]?.id ?? null;
  if (loading) return <Loading />;
  return <div className="mx-auto max-w-5xl"><div className="mb-3 flex items-center"><div className="min-w-0 flex-1"><h3 className="text-xs font-semibold">Datasets</h3><p className="text-[10px] text-muted-foreground">{datasets.length} discovered tables, views, endpoints, or files</p></div><Button size="icon" variant="ghost" className="h-8 w-8" onClick={refresh}><RefreshCw className="h-3.5 w-3.5" /></Button></div><div className="divide-y divide-border border-y border-border">{datasets.map((dataset) => <div key={dataset.id}><button className="flex w-full items-center gap-2 py-3 text-left" onClick={() => setExpanded(expanded === dataset.id ? null : dataset.id)}><Table2 className="h-3.5 w-3.5 text-primary" /><span className="min-w-0 flex-1 truncate font-mono text-xs">{dataset.name}</span><span className="text-[10px] text-muted-foreground">{dataset.kind} · {dataset.columns.length} fields</span><ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded === dataset.id && "rotate-90")} /></button>{expanded === dataset.id && <div className="mb-3 ml-5 border-l border-border pl-4"><Table><TableHeader><TableRow><TableHead className="h-8 text-[10px]">Field</TableHead><TableHead className="h-8 text-[10px]">Type</TableHead><TableHead className="h-8 text-[10px]">Constraints</TableHead></TableRow></TableHeader><TableBody>{dataset.columns.map((column) => <TableRow key={column.name}><TableCell className="py-1.5 font-mono text-xs">{column.name}</TableCell><TableCell className="py-1.5 text-xs text-muted-foreground">{column.type}</TableCell><TableCell className="py-1.5 text-[10px] text-muted-foreground">{column.primaryKey ? "primary key" : column.nullable ? "nullable" : "required"}</TableCell></TableRow>)}</TableBody></Table></div>}</div>)}</div>{datasets.length === 0 && <Empty title="No datasets discovered" description="Check the connection and permissions." />}</div>;
}

function AccessView({ source, registry }: { source: DataSource; registry: ReturnType<typeof useDataSources> }) {
  const { agents } = useAgents();
  const [saving, setSaving] = useState<string | null>(null);
  const role = (grant?: DataGrant) => grant?.capabilities.includes("admin") ? "admin" : grant?.capabilities.includes("write") ? "write" : grant ? "read" : "none";
  const update = async (agent: string, value: string) => {
    setSaving(agent);
    const existing = source.grants.find((grant) => grant.agent === agent);
    const grants = value === "none" ? source.grants.filter((grant) => grant.agent !== agent) : [
      ...source.grants.filter((grant) => grant.agent !== agent),
      { id: existing?.id ?? crypto.randomUUID(), agent, capabilities: [value as "read" | "write" | "admin"], datasets: existing?.datasets ?? ["*"], excludedFields: existing?.excludedFields },
    ];
    try { await registry.updateSource(source.id, sourceInput(source, { grants })); toast.success(`Access updated for ${agent}`); } catch (error) { toast.error(message(error)); } finally { setSaving(null); }
  };
  return <div className="mx-auto max-w-4xl"><div className="mb-4 flex items-start gap-3 border border-border bg-muted/20 p-3"><ShieldCheck className="mt-0.5 h-4 w-4 text-primary" /><div><h3 className="text-xs font-semibold">Source-scoped access</h3><p className="mt-1 text-[11px] text-muted-foreground">Tool assignment controls whether an agent can use data capabilities. This grant controls which source it can access. Credentials remain central and encrypted.</p></div></div><div className="divide-y divide-border border-y border-border">{agents.map((agent) => { const grant = source.grants.find((item) => item.agent === agent.name); return <div key={agent.name} className="flex items-center gap-3 py-3"><div className="flex h-8 w-8 items-center justify-center border border-border bg-muted/30 text-xs font-semibold">{agent.name.slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="truncate text-xs font-medium">{agent.identity?.displayName ?? agent.name}</div><div className="truncate text-[10px] text-muted-foreground">{grant ? `${grant.datasets.join(", ")} · ${(grant.excludedFields ?? []).length} hidden fields` : "No access"}</div></div>{saving === agent.name && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}<Select value={role(grant)} onValueChange={(value) => void update(agent.name, value)}><SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No access</SelectItem><SelectItem value="read">Viewer</SelectItem><SelectItem value="write">Operator</SelectItem><SelectItem value="admin">Steward</SelectItem></SelectContent></Select></div>; })}</div></div>;
}

function ActivityView({ activity }: { activity: DataActivity[] }) {
  return <div className="mx-auto max-w-5xl"><div className="mb-3"><h3 className="text-xs font-semibold">Audit activity</h3><p className="text-[10px] text-muted-foreground">Queries and mutations are recorded without storing result data.</p></div><div className="divide-y divide-border border-y border-border">{activity.map((item) => <div key={item.id} className="grid grid-cols-[18px_minmax(90px,0.6fr)_1fr_auto] items-center gap-3 py-2.5 text-xs"><span className={cn("h-2 w-2", item.status === "succeeded" ? "bg-emerald-500" : "bg-destructive")} /><span className="font-medium">{item.action}</span><span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">{item.agent || "platform"}{item.dataset ? ` · ${item.dataset}` : ""}{item.error ? ` · ${item.error}` : ""}</span><span className="text-[10px] tabular-nums text-muted-foreground">{item.durationMs}ms</span></div>)}{activity.length === 0 && <Empty compact title="No activity yet" />}</div></div>;
}

function ExploreWorkspace({ registry, initialSource, onOpenView }: { registry: ReturnType<typeof useDataSources>; initialSource?: DataSource; onOpenView: (id: string) => void }) {
  const [sourceId, setSourceId] = useState(initialSource?.id ?? registry.sources[0]?.id ?? "");
  const [datasets, setDatasets] = useState<DataDataset[]>([]);
  const [dataset, setDataset] = useState("");
  const [frame, setFrame] = useState<DataFrame | null>(null);
  const [filterField, setFilterField] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [limit, setLimit] = useState("100");
  const [mode, setMode] = useState<"builder" | "sql">("builder");
  const [sql, setSql] = useState("SELECT * FROM ");
  const [busy, setBusy] = useState(false);
  const currentSource = registry.sources.find((source) => source.id === sourceId);
  const currentDataset = datasets.find((item) => item.name === dataset);

  useEffect(() => { if (!sourceId && registry.sources[0]) setSourceId(registry.sources[0].id); }, [registry.sources, sourceId]);
  useEffect(() => {
    if (!sourceId) return;
    setDatasets([]); setDataset(""); setFrame(null);
    void registry.describeSource(sourceId).then((items) => { setDatasets(items); setDataset(items[0]?.name ?? ""); }).catch((error) => toast.error(message(error)));
  }, [registry.describeSource, sourceId]);
  useEffect(() => { setFilterField(currentDataset?.columns[0]?.name ?? ""); }, [currentDataset]);

  const querySpec = (): DataQuery => ({ sourceId, dataset, filters: filterField && filterValue ? [{ field: filterField, operator: "contains", value: filterValue }] : undefined, limit: Math.max(1, Math.min(Number(limit) || 100, 1000)) });
  const run = async () => { if (!sourceId || (!dataset && mode === "builder")) return; setBusy(true); try { setFrame(mode === "sql" ? await registry.rawSql(sourceId, sql) : await registry.query(querySpec())); } catch (error) { toast.error(message(error)); } finally { setBusy(false); } };
  const saveView = async () => { if (!frame || mode === "sql") { toast.error("Create views from the structured query builder"); return; } try { const view = await dataViewRequest<DataView>("", { method: "POST", body: JSON.stringify({ name: `${currentDataset?.name ?? "Data"} explorer`, description: `Generated from ${currentSource?.name ?? "source"}`, persistence: "saved", bindings: [{ id: "data", query: querySpec() }], widgets: [{ id: crypto.randomUUID(), type: "metric", title: "Records", binding: "data", aggregate: "count", width: 1 }, { id: crypto.randomUUID(), type: "table", title: currentDataset?.name ?? "Data", binding: "data", width: 4, height: "tall" }] }) }); toast.success("View saved"); onOpenView(view.id); } catch (error) { toast.error(message(error)); } };

  if (registry.sources.length === 0) return <Empty title="No data sources" description="Register a source before exploring data." />;
  return <div className="flex min-h-0 flex-1 flex-col"><div className="shrink-0 border-b border-border p-3"><div className="flex flex-wrap items-center gap-2"><Select value={sourceId} onValueChange={setSourceId}><SelectTrigger className="h-8 w-48 text-xs"><Database className="h-3.5 w-3.5" /><SelectValue placeholder="Source" /></SelectTrigger><SelectContent>{registry.sources.map((source) => <SelectItem key={source.id} value={source.id}>{source.name}</SelectItem>)}</SelectContent></Select><Tabs value={mode} onValueChange={(value) => setMode(value as "builder" | "sql")}><TabsList className="h-8"><TabsTrigger value="builder" className="text-xs"><Filter className="h-3 w-3" /> Builder</TabsTrigger>{currentSource && ["sqlite", "postgres"].includes(currentSource.kind) && <TabsTrigger value="sql" className="text-xs"><Braces className="h-3 w-3" /> SQL</TabsTrigger>}</TabsList></Tabs><div className="min-w-0 flex-1" /><Button variant="outline" size="sm" className="h-8" disabled={!frame || mode === "sql"} onClick={() => void saveView()}><Save className="h-3.5 w-3.5" /> Save as view</Button><Button size="sm" className="h-8" onClick={() => void run()} disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />} Run</Button></div>{mode === "builder" ? <div className="mt-2 flex flex-wrap gap-2"><Select value={dataset} onValueChange={setDataset}><SelectTrigger className="h-8 w-56 font-mono text-xs"><SelectValue placeholder="Dataset" /></SelectTrigger><SelectContent>{datasets.map((item) => <SelectItem key={item.id} value={item.name}>{item.name}</SelectItem>)}</SelectContent></Select><Select value={filterField} onValueChange={setFilterField}><SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Field" /></SelectTrigger><SelectContent>{currentDataset?.columns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}</SelectContent></Select><Input value={filterValue} onChange={(event) => setFilterValue(event.target.value)} className="h-8 w-48 text-xs" placeholder="Contains…" /><Input value={limit} onChange={(event) => setLimit(event.target.value)} className="h-8 w-20 font-mono text-xs" type="number" min={1} max={1000} /></div> : <Textarea value={sql} onChange={(event) => setSql(event.target.value)} className="mt-2 min-h-20 resize-y font-mono text-xs" />}</div><div className="min-h-0 flex-1 overflow-auto">{frame ? <DataFrameTable frame={frame} /> : <Empty title="Run a query" description="Results stay bounded and show provenance, freshness, and truncation." />}</div></div>;
}

function DataFrameTable({ frame }: { frame: DataFrame }) {
  return <div><div className="flex h-9 items-center gap-3 border-b border-border bg-muted/20 px-3 text-[10px] text-muted-foreground"><span>{frame.meta.rowCount} rows{frame.meta.truncated ? "+" : ""}</span><span>{frame.meta.durationMs}ms</span><span className="font-mono">{frame.meta.queryId}</span></div><Table><TableHeader className="sticky top-0 z-10 bg-background"><TableRow>{frame.columns.map((column) => <TableHead key={column.name} className="h-9 text-[10px]">{column.name}<span className="ml-1 font-normal text-muted-foreground">{column.type}</span></TableHead>)}</TableRow></TableHeader><TableBody>{frame.rows.map((row, index) => <TableRow key={index}>{frame.columns.map((column) => <TableCell key={column.name} className="max-w-80 truncate py-1.5 font-mono text-[11px]">{formatCell(row[column.name])}</TableCell>)}</TableRow>)}</TableBody></Table></div>;
}

function ViewsWorkspace({ registry, selected, onSelect, sessionId, sidebarOpen }: { registry: ReturnType<typeof useDataViews>; selected?: DataView; onSelect: (id: string) => void; sessionId: string | null; sidebarOpen: boolean }) {
  const remove = async (id: string) => { if (!window.confirm("Delete this data view?")) return; try { await registry.deleteView(id); toast.success("View deleted"); } catch (error) { toast.error(message(error)); } };
  if (registry.views.length === 0) return <Empty title="No views yet" description="Ask an agent to compose one, or save a query from Data Explorer." />;
  return <div className="flex min-h-0 flex-1 overflow-hidden">{sidebarOpen && <aside className="w-64 shrink-0 overflow-auto border-r border-border bg-background pr-2 xl:w-72">{registry.views.map((view) => <button key={view.id} onClick={() => onSelect(view.id)} className={cn("group mb-1 flex w-full items-center gap-2 border px-2.5 py-2 text-left transition-colors", selected?.id === view.id ? "border-primary/40 bg-primary/5" : "border-transparent hover:bg-muted/60")}><Gauge className="h-3.5 w-3.5 text-primary" /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{view.name}</span><span className="block truncate text-[10px] text-muted-foreground">{view.persistence} · {view.widgets.length} widgets · {viewBindingLabel(view)}</span></span><Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" aria-label={`Delete ${view.name}`} onClick={(event) => { event.stopPropagation(); void remove(view.id); }}><Trash2 className="h-3 w-3" /></Button></button>)}</aside>}<main className="flex min-w-0 flex-1">{selected ? <DataViewRenderer view={selected} sessionId={sessionId} /> : <Empty title="Select a view" />}</main></div>;
}

function SourceDialog({ open, source, registry, onClose }: { open: boolean; source?: DataSource; registry: ReturnType<typeof useDataSources>; onClose: () => void }) {
  const [kind, setKind] = useState<DataSourceKind>(source?.kind ?? "postgres");
  const [name, setName] = useState(source?.name ?? "");
  const [description, setDescription] = useState(source?.description ?? "");
  const [location, setLocation] = useState(source?.config.location ?? "");
  const [port, setPort] = useState(source?.config.port ? String(source.config.port) : "5432");
  const [database, setDatabase] = useState(source?.config.database ?? "");
  const [username, setUsername] = useState(source?.config.username ?? "");
  const [password, setPassword] = useState("");
  const [defaultDataset, setDefaultDataset] = useState(source?.config.defaultDataset ?? "");
  const [environment, setEnvironment] = useState<DataSource["environment"]>(source?.environment ?? "development");
  const [tags, setTags] = useState(source?.tags.join(", ") ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!open) return; setKind(source?.kind ?? "postgres"); setName(source?.name ?? ""); setDescription(source?.description ?? ""); setLocation(source?.config.location ?? ""); setPort(source?.config.port ? String(source.config.port) : "5432"); setDatabase(source?.config.database ?? ""); setUsername(source?.config.username ?? ""); setPassword(""); setDefaultDataset(source?.config.defaultDataset ?? ""); setEnvironment(source?.environment ?? "development"); setTags(source?.tags.join(", ") ?? ""); }, [open, source]);
  const save = async () => { if (!name.trim() || !location.trim()) return; setSaving(true); const input: DataSourceInput = { name: name.trim(), slug: source?.slug ?? slugify(name), description: description.trim() || undefined, kind, environment, config: { location: location.trim(), ...(kind === "postgres" ? { port: Number(port) || 5432, database: database.trim() || undefined, username: username.trim() || undefined } : {}), ...(["rest", "json", "csv"].includes(kind) ? { defaultDataset: defaultDataset.trim() || undefined } : {}) }, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), grants: source?.grants ?? [], ...(password ? { credentials: kind === "rest" ? { authorization: password } : { password } } : {}) }; try { const saved = source ? await registry.updateSource(source.id, input) : await registry.createSource(input); toast.success(source ? "Data source updated" : "Data source connected"); onClose(); void registry.testSource(saved.id).then((result) => toast.success(`Connection verified in ${result.latencyMs}ms`)).catch((error) => toast.warning(`Saved, but connection test failed: ${message(error)}`)); } catch (error) { toast.error(message(error)); } finally { setSaving(false); } };
  return <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}><DialogContent className="max-h-[90vh] max-w-2xl overflow-auto"><DialogHeader><DialogTitle>{source ? "Data source settings" : "Connect a data source"}</DialogTitle><DialogDescription>Credentials are encrypted in Vault and never returned to the browser.</DialogDescription></DialogHeader><div className="grid gap-4 py-2"><div><label className="text-xs font-medium">Connector</label><div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">{SOURCE_KINDS.map((item) => <button key={item.kind} type="button" onClick={() => setKind(item.kind)} className={cn("border p-2 text-left", kind === item.kind ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50")}><SourceIcon kind={item.kind} /><span className="mt-2 block text-[11px] font-medium">{item.label}</span></button>)}</div></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Environment"><Select value={environment} onValueChange={(value) => setEnvironment(value as DataSource["environment"])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="development">Development</SelectItem><SelectItem value="staging">Staging</SelectItem><SelectItem value="production">Production</SelectItem></SelectContent></Select></Field></div><Field label="Description"><Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this source contains" /></Field><Field label={kind === "postgres" ? "Host" : kind === "rest" ? "Base URL" : "File path"}><Input value={location} onChange={(event) => setLocation(event.target.value)} className="font-mono" placeholder={kind === "postgres" ? "db.example.com" : kind === "rest" ? "https://api.example.com/v1/" : "/path/to/data"} /></Field>{kind === "postgres" && <div className="grid gap-3 sm:grid-cols-3"><Field label="Port"><Input value={port} onChange={(event) => setPort(event.target.value)} type="number" /></Field><Field label="Database"><Input value={database} onChange={(event) => setDatabase(event.target.value)} /></Field><Field label="Username"><Input value={username} onChange={(event) => setUsername(event.target.value)} /></Field></div>}{["rest", "json", "csv"].includes(kind) && <Field label={kind === "rest" ? "Default endpoint" : "Dataset label"}><Input value={defaultDataset} onChange={(event) => setDefaultDataset(event.target.value)} placeholder={kind === "rest" ? "/customers" : "records"} /></Field>}{["postgres", "rest"].includes(kind) && <Field label={kind === "rest" ? "Authorization header value" : source ? "New password (optional)" : "Password"}><Input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder={kind === "rest" ? "Bearer …" : source ? "Leave blank to keep existing" : "Stored in encrypted Vault"} /></Field>}<Field label="Categories"><Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="internal, production" /></Field></div><DialogFooter><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={saving || !name.trim() || !location.trim()}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{source ? "Save changes" : "Connect source"}</Button></DialogFooter></DialogContent></Dialog>;
}

function SourceIcon({ kind, className }: { kind: DataSourceKind; className?: string }) { const Icon = kind === "rest" ? Network : kind === "json" ? FileJson : kind === "csv" ? Table2 : Database; return <Icon className={cn("h-4 w-4 shrink-0 text-primary", className)} />; }
function sourceLabel(source: DataSource) { return source.kind === "postgres" ? `${source.config.location}:${source.config.port ?? 5432}/${source.config.database ?? ""}` : source.config.location; }
function viewBindingLabel(view: DataView) { const live = view.bindings.some((binding) => binding.query); const inline = view.bindings.some((binding) => binding.inline); return live && inline ? "mixed data" : live ? "live source" : inline ? "inline data" : "no data"; }
function sourceInput(source: DataSource, override?: Partial<DataSourceInput>): DataSourceInput { return { name: source.name, slug: source.slug, description: source.description, kind: source.kind, environment: source.environment, config: source.config, tags: source.tags, grants: source.grants, ...override }; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-1.5"><span className="text-xs font-medium">{label}</span>{children}</label>; }
function Loading() { return <div className="flex min-h-0 flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>; }
function Empty({ title, description, compact }: { title: string; description?: string; compact?: boolean }) { return <div className={cn("flex min-h-0 flex-1 flex-col items-center justify-center text-center", compact ? "px-3 py-8" : "p-10")}><Database className="h-6 w-6 text-muted-foreground/50" /><h3 className="mt-3 text-sm font-medium">{title}</h3>{description && <p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p>}</div>; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function slugify(value: string) { return value.toLocaleLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `source-${Date.now()}`; }
function formatCell(value: unknown) { return value == null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value); }
