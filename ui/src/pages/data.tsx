/**
 * Data — modelled on Lumea's backend database panel.
 *
 *   /data                                   the sources: cards with type, health, agents with access
 *   /data?source=<id>&tab=<tab>&table=<t>   a source's workspace: Tables · Schema · SQL · Views ·
 *                                           Access · Activity · Settings
 *
 * Old links keep working: ?tab=sources&source=<id> (MCP), ?tab=explore, and an assistant's setup
 * link (?source=<id>&focus=password&setup=data:<id>:password) which opens Settings on the secret.
 */
import { useCallback, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Activity, ChevronLeft, Code2, Gauge, ListTree, Loader2, Plus, PlugZap, Search, Settings2, ShieldCheck, Table2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccessTab } from "@/components/data/access-tab";
import { ActivityTab } from "@/components/data/activity-tab";
import { DataEmpty, DataError, DataLoading } from "@/components/data/data-states";
import {
  errorMessage, isSqlSource, kindLabel, relativeTime, sourceLocation, useLoader, viewLink, viewsOfSource, workspaceTab, type WorkspaceTab,
} from "@/components/data/data-utils";
import { SchemaTab } from "@/components/data/schema-tab";
import { SourceIcon } from "@/components/data/source-icon";
import { NewSourceDialog, SettingsTab } from "@/components/data/source-settings";
import { SqlTab } from "@/components/data/sql-tab";
import { TablesTab } from "@/components/data/tables-tab";
import { ViewsTab } from "@/components/data/views-tab";
import {
  dataRequest, useDataSources, useDataViews,
  type DataActivity, type DataDataset, type DataRegistry, type DataSource, type DataView, type DataViewRegistry,
} from "@/hooks/use-data";
import { agentColor } from "@/lib/agent-colors";
import { cn } from "@/lib/utils";

export function DataPage() {
  const registry = useDataSources();
  const views = useDataViews();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  // ?tab=explore without a source: the first one
  const sourceId = params.get("source") ?? (params.get("tab") === "explore" ? registry.sources[0]?.id ?? null : null);
  const source = sourceId ? registry.sources.find((item) => item.id === sourceId || item.slug === sourceId) : undefined;

  const open = (id: string | null, tab?: WorkspaceTab) => setParams(id ? { source: id, ...(tab ? { tab } : {}) } : {});

  if (registry.loading) return <DataLoading label="Loading data sources…" />;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {registry.error && <div role="alert" className="mb-3 rounded-card border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{registry.error}</div>}
      {sourceId && !source ? (
        <DataError title="Data source not found" message={`There is no data source "${sourceId}". It may have been deleted.`}>
          <Button variant="outline" size="sm" onClick={() => open(null)}><ChevronLeft /> All sources</Button>
        </DataError>
      ) : source ? (
        <SourceWorkspace key={source.id} source={source} registry={registry} views={views} params={params} setParams={setParams} onBack={() => open(null)} />
      ) : (
        <SourcesList registry={registry} views={views.views} onOpen={(id) => open(id)} onAdd={() => setCreating(true)} />
      )}
      <NewSourceDialog open={creating} registry={registry} onClose={() => setCreating(false)} onCreated={(created) => { setCreating(false); open(created.id); }} />
    </div>
  );
}

// ── Sources (Lumea's table cards, one per source) ──────────────────────

type Health = { status: "ok" | "error" | "unknown"; at?: string; detail?: string };

function healthOf(activity: DataActivity[] | undefined): Health {
  const last = activity?.find((item) => item.action !== "mutate" || item.status === "failed");
  if (!last) return { status: "unknown" };
  return { status: last.status === "succeeded" ? "ok" : "error", at: last.createdAt, detail: last.error };
}

function SourcesList({ registry, views, onOpen, onAdd }: { registry: DataRegistry; views: DataView[]; onOpen: (id: string) => void; onAdd: () => void }) {
  const [query, setQuery] = useState("");
  const shown = registry.sources.filter((item) => `${item.name} ${item.kind} ${item.description ?? ""} ${item.tags.join(" ")}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-h1">Data</h1>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">Databases, APIs and files your agents can query. Open one to browse its tables, run SQL, save views, and decide which agents may use it.</p>
        </div>
        <Button size="sm" onClick={onAdd}><Plus /> Add source</Button>
      </header>
      {registry.sources.length === 0 ? (
        <DataEmpty title="Connect your first data source" description="PostgreSQL, SQLite, a REST API, a JSON or CSV file. Credentials go to the Vault; you choose which agents may use it." action={<Button size="sm" onClick={onAdd}><Plus /> Add source</Button>} />
      ) : (
        <>
          {registry.sources.length > 6 && (
            <div className="relative mb-3 max-w-xs">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a source" aria-label="Find a source" className="h-8 pl-8 text-xs" />
            </div>
          )}
          <ul className="grid min-h-0 grid-cols-1 gap-3 overflow-auto pb-4 md:grid-cols-2 2xl:grid-cols-3">
            {shown.map((source) => <li key={source.id}><SourceCard source={source} registry={registry} views={viewsOfSource(views, source.id).length} onOpen={() => onOpen(source.id)} /></li>)}
          </ul>
          {shown.length === 0 && <p className="py-8 text-center text-xs text-muted-foreground">No source matches "{query}".</p>}
        </>
      )}
    </div>
  );
}

function SourceCard({ source, registry, views, onOpen }: { source: DataSource; registry: DataRegistry; views: number; onOpen: () => void }) {
  const activity = useLoader<DataActivity[]>(`card-activity:${source.id}:${source.updatedAt}`, () => dataRequest<DataActivity[]>(`/${encodeURIComponent(source.id)}/activity?limit=10`));
  const [checked, setChecked] = useState<Health | null>(null);
  const [checking, setChecking] = useState(false);
  const health = checked ?? healthOf(activity.data);
  const check = async () => {
    setChecking(true);
    try { const result = await registry.testSource(source.id); setChecked({ status: "ok", at: new Date().toISOString(), detail: `${result.latencyMs} ms · ${result.datasets} datasets` }); }
    catch (error) { setChecked({ status: "error", at: new Date().toISOString(), detail: errorMessage(error) }); }
    finally { setChecking(false); }
  };
  const agents = [...new Set(source.grants.map((grant) => grant.agent))];
  return (
    <article className="group relative flex h-full flex-col gap-3 rounded-card border border-border bg-card p-4 transition-colors hover:bg-muted/40">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-muted transition-colors group-hover:bg-background"><SourceIcon kind={source.kind} className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">
            {/* the whole card opens the source; the check button stays its own control */}
            <button type="button" onClick={onOpen} className="text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-card focus-visible:after:ring-2 focus-visible:after:ring-ring">{source.name}</button>
          </h2>
          <p className="truncate text-xs text-muted-foreground">{kindLabel(source.kind)} · <span className="font-mono">{sourceLocation(source)}</span></p>
        </div>
        <EnvironmentBadge environment={source.environment} />
      </div>
      {source.description && <p className="line-clamp-2 text-xs text-muted-foreground">{source.description}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <HealthPill health={health} loading={activity.loading && !checked} />
        <span className="text-muted-foreground">{agents.length === 0 ? "No agents" : <AgentStack agents={agents} />}</span>
        {views > 0 && <span className="text-muted-foreground">{views} view{views === 1 ? "" : "s"}</span>}
        <span className="flex-1" />
        <Button variant="ghost" size="xs" className="relative z-10" onClick={() => void check()} disabled={checking} aria-label={`Test connection to ${source.name}`}>
          {checking ? <Loader2 className="animate-spin" /> : <PlugZap />} Test
        </Button>
      </div>
    </article>
  );
}

function HealthPill({ health, loading }: { health: Health; loading?: boolean }) {
  if (loading) return <span className="flex items-center gap-1.5 text-muted-foreground"><span className="size-2 animate-pulse rounded-pill bg-muted-foreground/40" /> Checking…</span>;
  const label = health.status === "ok" ? "Connected" : health.status === "error" ? "Error" : "Not checked yet";
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", health.status === "error" ? "text-destructive" : "text-muted-foreground")} title={health.detail}>
      <span className={cn("size-2 shrink-0 rounded-pill", health.status === "ok" ? "bg-success" : health.status === "error" ? "bg-destructive" : "bg-muted-foreground/40")} aria-hidden="true" />
      {label}{health.at ? <span className="text-muted-foreground"> · {relativeTime(health.at)}</span> : null}
    </span>
  );
}

function AgentStack({ agents }: { agents: string[] }) {
  return (
    <span className="flex items-center gap-1.5" title={agents.join(", ")}>
      <span className="flex -space-x-1.5">
        {agents.slice(0, 4).map((agent) => (
          <span key={agent} className={cn("flex size-5 items-center justify-center rounded-avatar border border-card text-micro font-semibold", agentColor(agent).solid)}>{agent.slice(0, 1).toUpperCase()}</span>
        ))}
      </span>
      {agents.length} agent{agents.length === 1 ? "" : "s"}
    </span>
  );
}

function EnvironmentBadge({ environment }: { environment: DataSource["environment"] }) {
  return (
    <span className={cn("shrink-0 rounded-badge border px-1.5 py-0.5 text-micro uppercase", environment === "production" ? "border-warning/40 bg-warning/10 text-warning" : "border-border text-muted-foreground")}>
      {environment === "development" ? "dev" : environment}
    </span>
  );
}

// ── A source's workspace ───────────────────────────────────────────────

const TAB_META: Record<WorkspaceTab, { label: string; icon: typeof Table2 }> = {
  tables: { label: "Tables", icon: Table2 },
  schema: { label: "Schema", icon: ListTree },
  sql: { label: "SQL", icon: Code2 },
  views: { label: "Views", icon: Gauge },
  access: { label: "Access", icon: ShieldCheck },
  activity: { label: "Activity", icon: Activity },
  settings: { label: "Settings", icon: Settings2 },
};

function SourceWorkspace({ source, registry, views, params, setParams, onBack }: {
  source: DataSource; registry: DataRegistry; views: DataViewRegistry; params: URLSearchParams;
  setParams: ReturnType<typeof useSearchParams>[1]; onBack: () => void;
}) {
  const navigate = useNavigate();
  const tab = workspaceTab(params, source);
  const table = params.get("table");
  const needsSchema = tab === "tables" || tab === "schema" || tab === "sql" || tab === "access";
  const schema = useLoader<DataDataset[]>(needsSchema ? `schema:${source.id}` : null, () => registry.describeSource(source.id));
  const [testing, setTesting] = useState(false);

  const go = useCallback((patch: { tab?: WorkspaceTab; table?: string | null }) => setParams((current) => {
    const next = new URLSearchParams(current);
    next.set("source", source.id);
    // a setup link's parameters only apply to the first view
    next.delete("setup"); next.delete("focus");
    if (patch.tab) next.set("tab", patch.tab);
    if (patch.table !== undefined) { if (patch.table) next.set("table", patch.table); else next.delete("table"); }
    return next;
  }), [setParams, source.id]);

  const viewSaved = (view: DataView) => {
    toast.success(`View “${view.name}” saved`, { action: { label: "Open", onClick: () => navigate(viewLink(view.id)) } });
  };
  const test = async () => {
    setTesting(true);
    try { const result = await registry.testSource(source.id); toast.success(`Connected in ${result.latencyMs} ms · ${result.datasets} datasets`); }
    catch (error) { toast.error(errorMessage(error)); }
    finally { setTesting(false); }
  };
  const tabs = (Object.keys(TAB_META) as WorkspaceTab[]).filter((item) => item !== "sql" || isSqlSource(source));
  const datasets = schema.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button type="button" onClick={onBack} className="mb-2 flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ChevronLeft className="size-3.5" /> Data sources</button>
      <header className="flex flex-wrap items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control border border-border bg-muted/40"><SourceIcon kind={source.kind} className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate font-heading text-h2">{source.name}</h1>
            <EnvironmentBadge environment={source.environment} />
          </div>
          <p className="truncate text-xs text-muted-foreground">{kindLabel(source.kind)} · <span className="font-mono">{sourceLocation(source)}</span>{source.description ? ` · ${source.description}` : ""}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void test()} disabled={testing}>{testing ? <Loader2 className="animate-spin" /> : <PlugZap />} Test</Button>
      </header>

      <Tabs value={tab} onValueChange={(value) => go({ tab: value as WorkspaceTab })} className="mt-3 shrink-0">
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList variant="line" className="h-9">
            {tabs.map((item) => {
              const Icon = TAB_META[item].icon;
              return <TabsTrigger key={item} value={item}><Icon className="size-3.5" />{TAB_META[item].label}</TabsTrigger>;
            })}
          </TabsList>
        </div>
      </Tabs>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto pt-4">
        {tab === "tables" && (
          <TablesTab source={source} registry={registry} datasets={datasets} datasetsLoading={schema.loading} datasetsError={schema.error}
            table={table} onSelectTable={(name) => go({ tab: "tables", table: name })} onSchemaChanged={schema.reload} onViewSaved={viewSaved} />
        )}
        {tab === "schema" && (
          <SchemaTab datasets={datasets} loading={schema.loading} error={schema.error} selected={table}
            onSelect={(name) => go({ tab: "schema", table: name })} onBrowse={(name) => go({ tab: "tables", table: name })} onRefresh={schema.reload} />
        )}
        {tab === "sql" && (schema.loading && !schema.data ? <DataLoading /> : <SqlTab source={source} registry={registry} datasets={datasets} onViewSaved={viewSaved} />)}
        {tab === "views" && <ViewsTab source={source} registry={views} />}
        {tab === "access" && <AccessTab source={source} registry={registry} datasets={datasets} />}
        {tab === "activity" && <ActivityTab source={source} registry={registry} />}
        {tab === "settings" && <SettingsTab source={source} registry={registry} onDeleted={onBack} />}
      </div>
    </div>
  );
}
