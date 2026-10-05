import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowRight, BrainCircuit, Check, CircleDot, Database, FileText, GitMerge, History,
  Loader2, Network, Plus, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, X,
} from "lucide-react";
import { useAgents } from "@polpo-ai/react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCompanyBrain, type BrainEntity, type BrainEntityDetail, type BrainGraph, type BrainRelation, type BrainRun, type BrainStatus } from "@/hooks/use-company-brain";
import { useDataSources, type DataDataset } from "@/hooks/use-data";
import { cn } from "@/lib/utils";

type BrainTab = "graph" | "entities" | "runs" | "access";
type BrainNodeData = { entity: BrainEntity; degree: number };

const TYPE_STYLES = [
  "border-red-500/45 bg-red-500/10 text-red-700 dark:text-red-300",
  "border-teal-500/45 bg-teal-500/10 text-teal-700 dark:text-teal-300",
  "border-blue-500/45 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  "border-amber-500/45 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  "border-fuchsia-500/45 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
  "border-emerald-500/45 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
];

function BrainNode({ data, selected }: NodeProps<Node<BrainNodeData>>) {
  const entity = data.entity;
  const style = TYPE_STYLES[hash(entity.type) % TYPE_STYLES.length];
  return <div className={cn("w-48 border bg-background px-3 py-2 shadow-sm transition-shadow", style, selected && "ring-2 ring-primary ring-offset-2 ring-offset-background shadow-md")}>
    <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-current" />
    <div className="flex items-center gap-2">
      <span className={cn("h-2 w-2 shrink-0", entity.status === "confirmed" ? "bg-emerald-500" : "bg-amber-500")} />
      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{entity.name}</span>
      <span className="text-[9px] tabular-nums text-muted-foreground">{data.degree}</span>
    </div>
    <div className="mt-1 truncate font-mono text-[9px] uppercase text-muted-foreground">{label(entity.type)}</div>
    {entity.summary && <p className="mt-1.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">{entity.summary}</p>}
    <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-current" />
  </div>;
}

const nodeTypes = { brain: BrainNode };

export function CompanyBrainPage() {
  const brain = useCompanyBrain();
  const { getEntity } = brain;
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<BrainTab>("graph");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"active" | BrainStatus>("active");
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get("entity"));
  const [detail, setDetail] = useState<BrainEntityDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [entityOpen, setEntityOpen] = useState(false);

  const loadDetail = useCallback(async (id: string | null) => {
    setSelectedId(id);
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (id) next.set("entity", id); else next.delete("entity");
      return next;
    }, { replace: true });
    if (!id) { setDetail(null); return; }
    setDetailLoading(true);
    try { setDetail(await getEntity(id)); }
    catch (error) { toast.error(message(error)); setDetail(null); }
    finally { setDetailLoading(false); }
  }, [getEntity, setParams]);

  useEffect(() => {
    if (selectedId && brain.graph && !brain.graph.entities.some((entity) => entity.id === selectedId)) void loadDetail(null);
    else if (selectedId) void loadDetail(selectedId);
  }, [brain.graph, loadDetail, selectedId]);

  const filtered = useMemo(() => filterGraph(brain.graph, query, typeFilter, statusFilter), [brain.graph, query, statusFilter, typeFilter]);
  const types = brain.graph?.stats.entityTypes ?? [];

  return <div className="flex h-full min-h-0 flex-col bg-background">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border pb-3">
      <Tabs value={tab} onValueChange={(value) => setTab(value as BrainTab)}>
        <TabsList variant="line" className="h-8">
          <TabsTrigger value="graph"><Network className="h-3.5 w-3.5" /><span className={tab === "graph" ? "inline" : "hidden lg:inline"}>Graph</span></TabsTrigger>
          <TabsTrigger value="entities"><CircleDot className="h-3.5 w-3.5" /><span className={tab === "entities" ? "inline" : "hidden lg:inline"}>Entities</span></TabsTrigger>
          <TabsTrigger value="runs"><History className="h-3.5 w-3.5" /><span className={tab === "runs" ? "inline" : "hidden lg:inline"}>Runs</span></TabsTrigger>
          <TabsTrigger value="access"><ShieldCheck className="h-3.5 w-3.5" /><span className={tab === "access" ? "inline" : "hidden lg:inline"}>Access</span></TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="min-w-0 flex-1" />
      {brain.graph && <div className="hidden items-center gap-3 text-[10px] tabular-nums text-muted-foreground xl:flex">
        <span><b className="text-foreground">{brain.graph.stats.entities}</b> entities</span>
        <span><b className="text-foreground">{brain.graph.stats.relations}</b> relations</span>
        <span><b className="text-foreground">{brain.graph.stats.candidates}</b> to review</span>
      </div>}
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void brain.refetch()} aria-label="Refresh Company Brain"><RefreshCw className={cn("h-3.5 w-3.5", brain.loading && "animate-spin")} /></Button></TooltipTrigger><TooltipContent>Refresh</TooltipContent></Tooltip>
      <Button variant="outline" size="sm" className="h-8" onClick={() => setEntityOpen(true)}><Plus className="h-3.5 w-3.5" /> Entity</Button>
      <Button size="sm" className="h-8" onClick={() => setEnrichOpen(true)}><Sparkles className="h-3.5 w-3.5" /> Enrich</Button>
    </div>

    {brain.error && <div className="mt-3 border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{brain.error}</div>}
    {brain.loading && !brain.graph ? <Loading /> : tab === "graph" ? (
      <GraphWorkspace graph={filtered} types={types} query={query} onQuery={setQuery} typeFilter={typeFilter} onTypeFilter={setTypeFilter}
        statusFilter={statusFilter} onStatusFilter={setStatusFilter} selectedId={selectedId} onSelect={(id) => void loadDetail(id)}
        detail={detail} detailLoading={detailLoading} brain={brain} onCloseDetail={() => void loadDetail(null)} />
    ) : tab === "entities" ? <EntitiesWorkspace graph={filtered} query={query} onQuery={setQuery} onSelect={(id) => { void loadDetail(id); setTab("graph"); }} />
      : tab === "runs" ? <RunsWorkspace runs={brain.runs} /> : <AccessWorkspace brain={brain} types={types.map((item) => item.type)} />}

    {entityOpen && <EntityDialog open onClose={() => setEntityOpen(false)} onSave={async (input) => { await brain.createEntity(input); toast.success("Entity created"); setEntityOpen(false); }} />}
    {enrichOpen && <EnrichDialog open onClose={() => setEnrichOpen(false)} brain={brain} />}
  </div>;
}

function GraphWorkspace({ graph, types, query, onQuery, typeFilter, onTypeFilter, statusFilter, onStatusFilter, selectedId, onSelect, detail, detailLoading, brain, onCloseDetail }: {
  graph: BrainGraph | null; types: Array<{ type: string; count: number }>; query: string; onQuery: (value: string) => void;
  typeFilter: string; onTypeFilter: (value: string) => void; statusFilter: "active" | BrainStatus; onStatusFilter: (value: "active" | BrainStatus) => void;
  selectedId: string | null; onSelect: (id: string | null) => void; detail: BrainEntityDetail | null; detailLoading: boolean;
  brain: ReturnType<typeof useCompanyBrain>; onCloseDetail: () => void;
}) {
  const flow = useMemo(() => makeFlow(graph), [graph]);
  return <div className="mt-3 flex min-h-0 flex-1 overflow-hidden border-y border-border">
    <main className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/15 p-2">
        <div className="relative min-w-48 flex-1 sm:max-w-sm"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => onQuery(event.target.value)} className="h-8 pl-8 text-xs" placeholder="Search entities and concepts" /></div>
        <Select value={typeFilter} onValueChange={onTypeFilter}><SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All entity types</SelectItem>{types.map((item) => <SelectItem key={item.type} value={item.type}>{label(item.type)} · {item.count}</SelectItem>)}</SelectContent></Select>
        <Select value={statusFilter} onValueChange={(value) => onStatusFilter(value as "active" | BrainStatus)}><SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">Active knowledge</SelectItem><SelectItem value="candidate">Candidates</SelectItem><SelectItem value="confirmed">Confirmed</SelectItem><SelectItem value="rejected">Rejected</SelectItem><SelectItem value="archived">Archived</SelectItem></SelectContent></Select>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">{graph?.entities.length ?? 0} visible</span>
      </div>
      <div className="relative min-h-0 flex-1 bg-[radial-gradient(circle_at_center,var(--color-border)_1px,transparent_1px)] bg-[size:22px_22px]">
        {graph && graph.entities.length ? <ReactFlowProvider><ReactFlow nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.15} maxZoom={2} onNodeClick={(_, node) => onSelect(node.id)} onPaneClick={() => onSelect(null)} nodesDraggable selectionOnDrag colorMode="system">
          <Background gap={22} size={0} /><Controls showInteractive={false} />
        </ReactFlow></ReactFlowProvider> : <Empty icon={BrainCircuit} title="No connected knowledge yet" description="Enrich text or ingest a Data Source to build the semantic map." />}
      </div>
    </main>
    {(selectedId || detailLoading) && <EntityInspector detail={detail} loading={detailLoading} graph={brain.graph} brain={brain} onClose={onCloseDetail} />}
  </div>;
}

function EntityInspector({ detail, loading, graph, brain, onClose }: { detail: BrainEntityDetail | null; loading: boolean; graph: BrainGraph | null; brain: ReturnType<typeof useCompanyBrain>; onClose: () => void }) {
  const [relationOpen, setRelationOpen] = useState(false);
  if (loading && !detail) return <aside className="flex w-80 shrink-0 items-center justify-center border-l border-border"><Loader2 className="h-4 w-4 animate-spin" /></aside>;
  if (!detail) return null;
  const { entity } = detail;
  const confirm = async () => { await brain.updateEntity(entity.id, { ...entity, status: "confirmed" }); toast.success("Entity confirmed"); };
  const remove = async () => { if (!window.confirm(`Delete ${entity.name} and its connected facts?`)) return; await brain.deleteEntity(entity.id); onClose(); toast.success("Entity deleted"); };
  return <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-background xl:w-96">
    <div className="flex items-start gap-2 border-b border-border p-3">
      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="truncate text-sm font-semibold">{entity.name}</h2><StatusBadge status={entity.status} /></div><div className="mt-1 font-mono text-[10px] uppercase text-muted-foreground">{label(entity.type)} · {percent(entity.confidence)}</div></div>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close entity details"><X className="h-3.5 w-3.5" /></Button>
    </div>
    <ScrollArea className="min-h-0 flex-1"><div className="space-y-5 p-3">
      {entity.summary && <p className="text-xs leading-relaxed text-muted-foreground">{entity.summary}</p>}
      {entity.aliases.length > 0 && <Section title="Aliases"><div className="flex flex-wrap gap-1">{entity.aliases.map((alias) => <Badge key={alias} variant="outline" className="text-[9px]">{alias}</Badge>)}</div></Section>}
      <Section title={`Claims · ${detail.claims.length}`}><div className="divide-y divide-border border-y border-border">{detail.claims.slice(0, 30).map((claim) => <div key={claim.id} className="py-2"><div className="flex gap-2"><span className="min-w-0 flex-1 font-mono text-[10px] text-muted-foreground">{label(claim.predicate)}</span><StatusBadge status={claim.status} /></div><div className="mt-1 break-words text-xs">{formatValue(claim.value)}</div><EvidenceLine count={claim.evidence.length} confidence={claim.confidence} /></div>)}{detail.claims.length === 0 && <Muted>There are no claims yet.</Muted>}</div></Section>
      <Section title={`Relations · ${detail.relations.length}`}><div className="divide-y divide-border border-y border-border">{detail.relations.map((relation) => { const outgoing = relation.fromId === entity.id; const otherId = outgoing ? relation.toId : relation.fromId; const other = graph?.entities.find((item) => item.id === otherId); return <div key={relation.id} className="py-2"><div className="flex items-center gap-1.5 text-xs"><span className="truncate font-medium">{outgoing ? entity.name : other?.name ?? otherId}</span><ArrowRight className={cn("h-3 w-3 shrink-0 text-muted-foreground", !outgoing && "rotate-180")} /><span className="truncate font-medium">{outgoing ? other?.name ?? otherId : entity.name}</span></div><div className="mt-1 flex items-center gap-2 font-mono text-[9px] uppercase text-muted-foreground"><span>{label(relation.type)}</span><span>·</span><span>{percent(relation.confidence)}</span><StatusBadge status={relation.status} /></div>{relation.status === "candidate" && <Button variant="ghost" size="sm" className="mt-1 h-6 px-1.5 text-[10px]" onClick={() => void brain.updateRelation(relation.id, { ...relation, status: "confirmed" }).then(() => toast.success("Relation confirmed"))}><Check className="h-3 w-3" /> Confirm</Button>}</div>; })}{detail.relations.length === 0 && <Muted>No relations yet.</Muted>}</div></Section>
      <Section title={`Evidence · ${entity.evidence.length}`}><div className="space-y-2">{entity.evidence.map((item) => <div key={item.id} className="border-l-2 border-primary/50 pl-2"><div className="font-mono text-[9px] uppercase text-muted-foreground">{item.sourceType} · {item.sourceId}{item.dataset ? ` / ${item.dataset}` : ""}</div>{item.excerpt && <p className="mt-1 line-clamp-4 text-[10px] leading-relaxed text-muted-foreground">{item.excerpt}</p>}</div>)}</div></Section>
    </div></ScrollArea>
    <div className="flex shrink-0 items-center gap-2 border-t border-border p-3">
      {entity.status === "candidate" && <Button size="sm" className="h-8" onClick={() => void confirm()}><Check className="h-3.5 w-3.5" /> Confirm</Button>}
      <Button variant="outline" size="sm" className="h-8" onClick={() => setRelationOpen(true)}><GitMerge className="h-3.5 w-3.5" /> Connect</Button>
      <div className="flex-1" /><Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => void remove()} aria-label="Delete entity"><Trash2 className="h-3.5 w-3.5" /></Button>
    </div>
    {relationOpen && <RelationDialog open from={entity} entities={graph?.entities ?? []} onClose={() => setRelationOpen(false)} onSave={async (input) => { await brain.createRelation(input); toast.success("Relation created"); setRelationOpen(false); }} />}
  </aside>;
}

function EntitiesWorkspace({ graph, query, onQuery, onSelect }: { graph: BrainGraph | null; query: string; onQuery: (value: string) => void; onSelect: (id: string) => void }) {
  return <div className="mt-3 min-h-0 flex-1 overflow-auto border-y border-border">
    <div className="sticky top-0 z-10 flex items-center border-b border-border bg-background p-2"><div className="relative w-full max-w-sm"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => onQuery(event.target.value)} className="h-8 pl-8 text-xs" placeholder="Filter entities" /></div></div>
    <Table><TableHeader><TableRow><TableHead className="h-9">Entity</TableHead><TableHead className="h-9">Type</TableHead><TableHead className="h-9">Status</TableHead><TableHead className="h-9 text-right">Confidence</TableHead><TableHead className="h-9 text-right">Evidence</TableHead></TableRow></TableHeader><TableBody>{graph?.entities.map((entity) => <TableRow key={entity.id} className="cursor-pointer" onClick={() => onSelect(entity.id)}><TableCell className="py-2"><div className="text-xs font-medium">{entity.name}</div><div className="max-w-xl truncate text-[10px] text-muted-foreground">{entity.summary || entity.aliases.join(", ")}</div></TableCell><TableCell className="py-2 font-mono text-[10px] uppercase">{label(entity.type)}</TableCell><TableCell className="py-2"><StatusBadge status={entity.status} /></TableCell><TableCell className="py-2 text-right text-xs tabular-nums">{percent(entity.confidence)}</TableCell><TableCell className="py-2 text-right text-xs tabular-nums">{entity.evidence.length}</TableCell></TableRow>)}</TableBody></Table>
    {graph?.entities.length === 0 && <Empty icon={CircleDot} title="No matching entities" />}
  </div>;
}

function RunsWorkspace({ runs }: { runs: BrainRun[] }) {
  return <div className="mx-auto mt-3 w-full max-w-5xl min-h-0 flex-1 overflow-auto border-y border-border"><div className="divide-y divide-border">{runs.map((run) => <div key={run.id} className="grid gap-2 py-3 sm:grid-cols-[18px_minmax(160px,1fr)_auto] sm:items-center"><span className={cn("h-2.5 w-2.5", run.status === "succeeded" ? "bg-emerald-500" : run.status === "failed" ? "bg-destructive" : run.status === "running" ? "animate-pulse bg-blue-500" : "bg-amber-500")} /><div className="min-w-0"><div className="truncate text-xs font-medium">{run.label}</div><div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{run.kind}{run.sourceId ? ` · ${run.sourceId}` : ""}{run.dataset ? ` / ${run.dataset}` : ""}{run.error ? ` · ${run.error}` : ""}</div>{run.warnings.map((warning) => <div key={warning} className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">{warning}</div>)}</div><div className="flex gap-3 text-[10px] tabular-nums text-muted-foreground"><span>{run.entitiesCreated} new</span><span>{run.entitiesUpdated} enriched</span><span>{run.relationsCreated} relations</span><span>{run.claimsCreated} claims</span></div></div>)}{runs.length === 0 && <Empty icon={History} title="No enrichment runs" description="Runs keep provenance and operational errors visible." />}</div></div>;
}

function AccessWorkspace({ brain, types }: { brain: ReturnType<typeof useCompanyBrain>; types: string[] }) {
  const { agents } = useAgents();
  const [saving, setSaving] = useState<string | null>(null);
  const update = async (agent: string, capability: "none" | "read" | "write" | "admin") => { setSaving(agent); try { await brain.setGrant(agent, capability, ["*"]); toast.success(`Brain access updated for ${agent}`); } catch (error) { toast.error(message(error)); } finally { setSaving(null); } };
  return <div className="mx-auto mt-3 w-full max-w-4xl"><div className="mb-4 flex gap-3 border-y border-border py-3"><ShieldCheck className="mt-0.5 h-4 w-4 text-primary" /><div><h3 className="text-xs font-semibold">Scoped semantic access</h3><p className="mt-1 text-[11px] text-muted-foreground">Tool assignment enables Company Brain capabilities. Grants restrict which entity types each agent can read or modify. {types.length} types are currently mapped.</p></div></div><div className="divide-y divide-border border-y border-border">{agents.map((agent) => { const grant = brain.grants.find((item) => item.agent === agent.name); const value = grant?.capabilities.includes("admin") ? "admin" : grant?.capabilities.includes("write") ? "write" : grant?.capabilities.includes("read") ? "read" : "none"; return <div key={agent.name} className="flex items-center gap-3 py-3"><div className="flex h-8 w-8 items-center justify-center border border-border bg-muted/30 text-xs font-semibold">{agent.name.slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="truncate text-xs font-medium">{agent.identity?.displayName ?? agent.name}</div><div className="truncate text-[10px] text-muted-foreground">{grant ? grant.entityTypes.join(", ") : "No Company Brain access"}</div></div>{saving === agent.name && <Loader2 className="h-3.5 w-3.5 animate-spin" />}<Select value={value} onValueChange={(next) => void update(agent.name, next as typeof value)}><SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No access</SelectItem><SelectItem value="read">Reader</SelectItem><SelectItem value="write">Editor</SelectItem><SelectItem value="admin">Steward</SelectItem></SelectContent></Select></div>; })}</div></div>;
}

function EntityDialog({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (input: { name: string; type: string; summary?: string; status: BrainStatus }) => Promise<void> }) {
  const [name, setName] = useState(""); const [type, setType] = useState("concept"); const [summary, setSummary] = useState(""); const [saving, setSaving] = useState(false);
  return <Dialog open={open} onOpenChange={(value) => !value && onClose()}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>Add canonical entity</DialogTitle><DialogDescription>Create a reviewed entity manually. Enrichment can add aliases, evidence, facts, and relations later.</DialogDescription></DialogHeader><div className="grid gap-3 py-2"><Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></Field><Field label="Entity type"><Input value={type} onChange={(event) => setType(event.target.value)} placeholder="customer, product, project" /></Field><Field label="Summary"><Textarea value={summary} onChange={(event) => setSummary(event.target.value)} className="min-h-24" /></Field></div><DialogFooter><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!name.trim() || !type.trim() || saving} onClick={() => { setSaving(true); void onSave({ name: name.trim(), type: type.trim(), summary: summary.trim() || undefined, status: "confirmed" }).finally(() => setSaving(false)); }}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Add entity</Button></DialogFooter></DialogContent></Dialog>;
}

function RelationDialog({ open, from, entities, onClose, onSave }: { open: boolean; from: BrainEntity; entities: BrainEntity[]; onClose: () => void; onSave: (input: Pick<BrainRelation, "fromId" | "toId" | "type"> & Partial<BrainRelation>) => Promise<void> }) {
  const options = entities.filter((entity) => entity.id !== from.id); const [toId, setToId] = useState(options[0]?.id ?? ""); const [type, setType] = useState("related_to"); const [saving, setSaving] = useState(false);
  return <Dialog open={open} onOpenChange={(value) => !value && onClose()}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>Connect entity</DialogTitle><DialogDescription>Create a directed relation from {from.name}.</DialogDescription></DialogHeader><div className="grid gap-3 py-2"><Field label="Target"><Select value={toId} onValueChange={setToId}><SelectTrigger><SelectValue placeholder="Choose an entity" /></SelectTrigger><SelectContent>{options.map((entity) => <SelectItem key={entity.id} value={entity.id}>{entity.name} · {label(entity.type)}</SelectItem>)}</SelectContent></Select></Field><Field label="Relation type"><Input value={type} onChange={(event) => setType(event.target.value)} placeholder="owns, depends_on, works_with" /></Field></div><DialogFooter><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!toId || !type.trim() || saving} onClick={() => { setSaving(true); void onSave({ fromId: from.id, toId, type: type.trim(), status: "confirmed", confidence: 1 }).finally(() => setSaving(false)); }}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />} Connect</Button></DialogFooter></DialogContent></Dialog>;
}

function EnrichDialog({ open, onClose, brain }: { open: boolean; onClose: () => void; brain: ReturnType<typeof useCompanyBrain> }) {
  const { sources, describeSource } = useDataSources(); const [mode, setMode] = useState<"text" | "source">("text"); const [text, setText] = useState(""); const [labelValue, setLabelValue] = useState(""); const [sourceId, setSourceId] = useState(""); const [datasets, setDatasets] = useState<DataDataset[]>([]); const [dataset, setDataset] = useState(""); const [entityType, setEntityType] = useState(""); const [semantic, setSemantic] = useState(true); const [saving, setSaving] = useState(false);
  useEffect(() => { if (open && !sourceId && sources[0]) setSourceId(sources[0].id); }, [open, sourceId, sources]);
  useEffect(() => { if (!sourceId || !open) return; void describeSource(sourceId).then((items) => { setDatasets(items); setDataset(items[0]?.name ?? ""); }).catch((error) => toast.error(message(error))); }, [describeSource, open, sourceId]);
  const run = async () => { setSaving(true); try { const result = mode === "text" ? await brain.enrichText({ text, label: labelValue || undefined, sourceType: "manual" }) : await brain.ingestDataSource({ sourceId, dataset, entityType: entityType || undefined, semantic, limit: 250 }); toast.success(result.status === "partial" ? "Mapped with enrichment warnings" : "Company Brain enriched"); onClose(); } catch (error) { toast.error(message(error)); } finally { setSaving(false); } };
  return <Dialog open={open} onOpenChange={(value) => !value && onClose()}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Enrich Company Brain</DialogTitle><DialogDescription>Map grounded knowledge from text or an existing Data Source. LLM-derived facts remain reviewable candidates with evidence.</DialogDescription></DialogHeader><Tabs value={mode} onValueChange={(value) => setMode(value as typeof mode)}><TabsList variant="line" className="h-8"><TabsTrigger value="text"><FileText className="h-3.5 w-3.5" /> Text</TabsTrigger><TabsTrigger value="source"><Database className="h-3.5 w-3.5" /> Data Source</TabsTrigger></TabsList></Tabs>{mode === "text" ? <div className="grid gap-3 py-2"><Field label="Source label"><Input value={labelValue} onChange={(event) => setLabelValue(event.target.value)} placeholder="Meeting notes, strategy document, customer research" /></Field><Field label="Content"><Textarea value={text} onChange={(event) => setText(event.target.value)} className="min-h-60 resize-y" placeholder="Paste grounded company knowledge here" /></Field></div> : <div className="grid gap-3 py-2 sm:grid-cols-2"><Field label="Data Source"><Select value={sourceId} onValueChange={setSourceId}><SelectTrigger><SelectValue placeholder="Choose source" /></SelectTrigger><SelectContent>{sources.map((source) => <SelectItem key={source.id} value={source.id}>{source.name}</SelectItem>)}</SelectContent></Select></Field><Field label="Dataset"><Select value={dataset} onValueChange={setDataset}><SelectTrigger><SelectValue placeholder="Choose dataset" /></SelectTrigger><SelectContent>{datasets.map((item) => <SelectItem key={item.id} value={item.name}>{item.name}</SelectItem>)}</SelectContent></Select></Field><Field label="Entity type override"><Input value={entityType} onChange={(event) => setEntityType(event.target.value)} placeholder="Infer from dataset" /></Field><label className="flex min-h-16 items-center gap-3 border border-border px-3"><input type="checkbox" checked={semantic} onChange={(event) => setSemantic(event.target.checked)} className="h-4 w-4 accent-primary" /><span><span className="block text-xs font-medium">Semantic enrichment</span><span className="mt-0.5 block text-[10px] text-muted-foreground">Infer supported concepts beyond IDs and columns</span></span></label></div>}<DialogFooter><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={saving || (mode === "text" ? !text.trim() : !sourceId || !dataset)} onClick={() => void run()}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Enrich</Button></DialogFooter></DialogContent></Dialog>;
}

function makeFlow(graph: BrainGraph | null): { nodes: Node<BrainNodeData>[]; edges: Edge[] } {
  if (!graph) return { nodes: [], edges: [] };
  const degree = new Map<string, number>();
  for (const relation of graph.relations) { degree.set(relation.fromId, (degree.get(relation.fromId) ?? 0) + 1); degree.set(relation.toId, (degree.get(relation.toId) ?? 0) + 1); }
  const groups = new Map<string, BrainEntity[]>();
  for (const entity of graph.entities) groups.set(entity.type, [...(groups.get(entity.type) ?? []), entity]);
  const sortedGroups = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const nodes: Node<BrainNodeData>[] = [];
  for (const [column, [, entities]] of sortedGroups.entries()) {
    const sorted = entities.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.name.localeCompare(b.name));
    sorted.forEach((entity, row) => nodes.push({ id: entity.id, type: "brain", position: { x: column * 270, y: row * 130 + (column % 2) * 55 }, data: { entity, degree: degree.get(entity.id) ?? 0 } }));
  }
  const edges: Edge[] = graph.relations.map((relation) => ({ id: relation.id, source: relation.fromId, target: relation.toId, label: relation.label || label(relation.type), type: "smoothstep", animated: relation.status === "candidate", markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 }, style: { strokeWidth: relation.confidence > 0.85 ? 1.7 : 1, strokeDasharray: relation.status === "candidate" ? "5 4" : undefined }, labelStyle: { fontSize: 9 } }));
  return { nodes, edges };
}

function filterGraph(graph: BrainGraph | null, query: string, type: string, status: "active" | BrainStatus): BrainGraph | null {
  if (!graph) return null; const needle = query.trim().toLocaleLowerCase(); const entities = graph.entities.filter((entity) => (type === "all" || entity.type === type) && (status === "active" ? entity.status === "candidate" || entity.status === "confirmed" : entity.status === status) && (!needle || `${entity.name} ${entity.type} ${entity.aliases.join(" ")} ${entity.summary ?? ""}`.toLocaleLowerCase().includes(needle))); const ids = new Set(entities.map((entity) => entity.id)); return { ...graph, entities, relations: graph.relations.filter((relation) => ids.has(relation.fromId) && ids.has(relation.toId)), claims: graph.claims.filter((claim) => ids.has(claim.entityId)) };
}

function StatusBadge({ status }: { status: BrainStatus }) { return <Badge variant="outline" className={cn("h-4 px-1 text-[8px] uppercase", status === "confirmed" ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400" : status === "candidate" ? "border-amber-500/30 text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{status}</Badge>; }
function EvidenceLine({ count, confidence }: { count: number; confidence: number }) { return <div className="mt-1 font-mono text-[9px] text-muted-foreground">{count} evidence · {percent(confidence)}</div>; }
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section><h3 className="mb-2 text-[10px] font-bold uppercase text-muted-foreground">{title}</h3>{children}</section>; }
function Field({ label: fieldLabel, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-1.5"><span className="text-xs font-medium">{fieldLabel}</span>{children}</label>; }
function Muted({ children }: { children: React.ReactNode }) { return <div className="py-3 text-center text-[10px] text-muted-foreground">{children}</div>; }
function Loading() { return <div className="flex min-h-0 flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>; }
function Empty({ icon: Icon, title, description }: { icon: typeof BrainCircuit; title: string; description?: string }) { return <div className="flex h-full min-h-52 flex-col items-center justify-center p-8 text-center"><Icon className="h-7 w-7 text-muted-foreground/50" /><h3 className="mt-3 text-sm font-medium">{title}</h3>{description && <p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p>}</div>; }
function label(value: string) { return value.replace(/_/g, " "); }
function percent(value: number) { return `${Math.round(value * 100)}%`; }
function formatValue(value: unknown) { return value == null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function hash(value: string) { return [...value].reduce((total, character) => total + character.charCodeAt(0), 0); }
