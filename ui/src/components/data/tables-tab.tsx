/**
 * Tables: Lumea's database panel on a Polpo data source. No table chosen: the tables as cards with
 * their row counts. A table chosen: the table list on the side, and the table's rows in the data
 * grid with filters, sort, columns, paging, a row's details, and (SQL sources) insert, in-place
 * edit and delete — every change confirmed with the rows it will touch, through Polpo's mutation API.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, Eye, Loader2, Plus, RefreshCw, Save, Search, Table2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useEvents } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DataColumn, DataDataset, DataFilter, DataFrame, DataQuery, DataRegistry, DataSource, DataView } from "@/hooks/use-data";
import { dataViewRequest } from "@/hooks/use-data";
import { cn } from "@/lib/utils";
import { DataGrid, type DataGridSort } from "./data-grid";
import { ColumnsPopover, FilterPopover } from "./data-toolbar";
import { canMutate, coerceValue, datasetLabel, errorMessage, formatCount, rowIdentity, rowKey, toQueryFilters, useLoader, type FilterDraft } from "./data-utils";
import { ConfirmMutationDialog, RowFormDialog, RowSheet, type PendingMutation } from "./row-dialogs";
import { DataEmpty, DataError } from "./data-states";

export function TablesTab({ source, registry, datasets, datasetsLoading, datasetsError, table, onSelectTable, onSchemaChanged, onViewSaved }: {
  source: DataSource;
  registry: DataRegistry;
  datasets: DataDataset[];
  datasetsLoading: boolean;
  datasetsError?: string;
  table: string | null;
  onSelectTable: (name: string | null) => void;
  onSchemaChanged: () => void;
  onViewSaved: (view: DataView) => void;
}) {
  const dataset = table ? datasets.find((item) => item.name === table) : undefined;
  if (datasetsLoading && datasets.length === 0) return <TablesSkeleton />;
  if (datasetsError && datasets.length === 0) return <DataError title="Could not read the schema" message={datasetsError} onRetry={onSchemaChanged} />;
  if (!table) return <TablesGrid datasets={datasets} onSelect={onSelectTable} onRefresh={onSchemaChanged} loading={datasetsLoading} />;
  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <TableList datasets={datasets} selected={table} onSelect={onSelectTable} className="hidden w-56 shrink-0 lg:flex" />
      <div className="flex min-w-0 flex-1 flex-col">
        <button type="button" onClick={() => onSelectTable(null)} className="mb-2 flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-3.5" /> All tables
        </button>
        {dataset
          ? <TableBrowser key={`${source.id}:${dataset.name}`} source={source} registry={registry} dataset={dataset} onSchemaChanged={onSchemaChanged} onViewSaved={onViewSaved} />
          : <DataEmpty icon={Table2} title={`No dataset "${table}"`} description="It may have been renamed or dropped. Pick another table." />}
      </div>
    </div>
  );
}

/** Lumea's "cards" mode: every table with its row count. */
function TablesGrid({ datasets, onSelect, onRefresh, loading }: { datasets: DataDataset[]; onSelect: (name: string) => void; onRefresh: () => void; loading: boolean }) {
  const [query, setQuery] = useState("");
  const shown = datasets.filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (datasets.length === 0) return <DataEmpty icon={Table2} title="No tables yet" description="The source has no tables, views, endpoints or files Polpo can read. Ask an agent to create some, or check the connection in Settings." />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Find among ${datasets.length} tables`} aria-label="Find a table" className="h-8 pl-8 text-xs" />
        </div>
        <span className="flex-1" />
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" onClick={onRefresh} aria-label="Reload tables"><RefreshCw className={cn(loading && "animate-spin")} /></Button></TooltipTrigger><TooltipContent>Reload tables</TooltipContent></Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => onSelect(item.name)} className="group flex w-full items-center gap-3 rounded-card border border-border bg-card p-3.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-muted transition-colors group-hover:bg-background">
                  {item.kind === "view" ? <Eye className="size-5 text-muted-foreground" /> : <Table2 className="size-5 text-muted-foreground" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-sm font-medium">{datasetLabel(item)}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.kind !== "table" ? `${item.kind} · ` : ""}{item.rowCount !== undefined ? formatCount(item.rowCount) : `${item.columns.length} columns`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {shown.length === 0 && <p className="py-10 text-center text-xs text-muted-foreground">No table matches "{query}".</p>}
      </div>
    </div>
  );
}

/** Lumea's "sidebar" mode list. */
function TableList({ datasets, selected, onSelect, className }: { datasets: DataDataset[]; selected: string; onSelect: (name: string) => void; className?: string }) {
  const [query, setQuery] = useState("");
  const shown = datasets.filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return (
    <nav aria-label="Tables" className={cn("min-h-0 flex-col rounded-card border border-border bg-muted/20", className)}>
      <div className="border-b border-border p-2">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter tables" aria-label="Filter tables" className="h-7 text-xs" />
      </div>
      <ul className="min-h-0 flex-1 overflow-auto p-1.5">
        {shown.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-current={item.name === selected ? "page" : undefined}
              onClick={() => onSelect(item.name)}
              className={cn("flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs transition-colors", item.name === selected ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
            >
              {item.kind === "view" ? <Eye className="size-3.5 shrink-0" /> : <Table2 className="size-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate font-mono">{datasetLabel(item)}</span>
              {item.rowCount !== undefined && <span className="text-micro tabular-nums opacity-70">{item.rowCount.toLocaleString()}</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function TableBrowser({ source, registry, dataset, onSchemaChanged, onViewSaved }: {
  source: DataSource; registry: DataRegistry; dataset: DataDataset; onSchemaChanged: () => void; onViewSaved: (view: DataView) => void;
}) {
  const [filters, setFilters] = useState<FilterDraft[]>([]);
  const [sort, setSort] = useState<DataGridSort | null>(null);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(50);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openRow, setOpenRow] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState<{ mode: "insert" | "edit"; row?: Record<string, unknown> } | null>(null);
  const [pending, setPending] = useState<PendingMutation | null>(null);
  // rows the pending change will touch: undefined while counting, null when they could not be counted
  const [affected, setAffected] = useState<{ for: PendingMutation; count?: number | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [savingView, setSavingView] = useState(false);

  const mutable = canMutate(source) && dataset.kind === "table";
  const queryFilters = useMemo(() => toQueryFilters(filters, dataset.columns), [filters, dataset.columns]);
  const query: DataQuery = useMemo(() => ({
    sourceId: source.id, dataset: dataset.name, limit, offset, includeTotal: true,
    ...(queryFilters.length ? { filters: queryFilters } : {}),
    ...(sort ? { sort: [sort] } : {}),
  }), [dataset.name, limit, offset, queryFilters, sort, source.id]);
  const rows = useLoader<DataFrame>(`rows:${JSON.stringify(query)}`, () => registry.query(query));
  const { reload } = rows;

  // rows written elsewhere (an agent, MCP) show up without a manual refresh
  const { events } = useEvents(["data-source:changed"], 1);
  const latest = events.at(-1);
  useEffect(() => {
    const data = latest?.data as { sourceId?: string; action?: string } | undefined;
    if (data?.sourceId === source.id && data.action === "data") reload();
  }, [latest, reload, source.id]);

  // the schema's columns carry keys and native types; a REST/file dataset only has the rows' own
  const columns: DataColumn[] = useMemo(() => {
    const known = dataset.columns;
    const extra = (rows.data?.columns ?? []).filter((column) => !known.some((item) => item.name === column.name));
    return [...known, ...extra];
  }, [dataset.columns, rows.data?.columns]);
  const frameRows = useMemo(() => rows.data?.rows ?? [], [rows.data]);
  const getRowKey = useCallback((row: Record<string, unknown>, index: number) => rowKey(row, columns, index), [columns]);
  const selectedRows = frameRows.filter((row, index) => selected.has(getRowKey(row, index)));
  const total = rows.data?.meta.totalCount;

  const changeFilters = (next: FilterDraft[]) => { setFilters(next); setOffset(0); setSelected(new Set()); };
  const changeSort = (field: string) => {
    setSort((current) => current?.field !== field ? { field, direction: "asc" } : current.direction === "asc" ? { field, direction: "desc" } : null);
    setOffset(0);
  };

  // ── changes: review → count → confirm → write ──
  const review = (mutation: PendingMutation) => {
    setPending(mutation);
    setAffected({ for: mutation });
    if (mutation.operation === "insert" || !mutation.targets) return;
    void Promise.all(mutation.targets.map((target) => registry.query({ sourceId: source.id, dataset: dataset.name, filters: target, limit: 1, includeTotal: true })))
      .then((frames) => setAffected((current) => current?.for === mutation ? { for: mutation, count: frames.reduce((sum, frame) => sum + (frame.meta.totalCount ?? frame.rows.length), 0) } : current))
      .catch((error) => { toast.error(`Could not count the rows: ${errorMessage(error)}`); setAffected((current) => current?.for === mutation ? { for: mutation, count: null } : current); });
  };
  const reviewRows = (operation: "update" | "delete", targets: Record<string, unknown>[], values?: Record<string, unknown>) => {
    const identities = targets.map((row) => rowIdentity(row, dataset.columns));
    review({ operation, dataset: dataset.name, values, targets: identities.map((identity) => identity.filters), byAllColumns: identities.some((identity) => identity.by === "all-columns") });
  };

  const confirm = async () => {
    if (!pending) return;
    setRunning(true);
    try {
      let changed = 0;
      const base = { sourceId: source.id, dataset: dataset.name, operation: pending.operation };
      if (pending.operation === "insert") {
        changed = (await registry.mutate({ ...base, values: pending.values })).affectedRows;
      } else {
        const keys = dataset.columns.filter((column) => column.primaryKey);
        const targets = pending.targets ?? [];
        if (keys.length === 1 && targets.length > 1) {
          // one statement for many rows picked by a single-column key
          const values = targets.map((filters) => filters[0]?.value).filter((value) => value !== undefined) as DataFilter["value"][];
          changed = (await registry.mutate({ ...base, values: pending.values, filters: [{ field: keys[0]!.name, operator: "in", value: values as never }] })).affectedRows;
        } else {
          for (const filters of targets) changed += (await registry.mutate({ ...base, values: pending.values, filters })).affectedRows;
        }
      }
      toast.success(`${pending.operation === "insert" ? "Inserted" : pending.operation === "update" ? "Updated" : "Deleted"} ${changed} row${changed === 1 ? "" : "s"}`);
      setPending(null); setForm(null); setOpenRow(null); setSelected(new Set());
      reload();
      if (pending.operation !== "update") onSchemaChanged();
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setRunning(false); }
  };

  const editCell = (row: Record<string, unknown>, column: DataColumn, raw: string) => {
    try {
      const value = coerceValue(raw, column, raw === "" && !!column.nullable && row[column.name] === null);
      if (formatCellEq(value, row[column.name])) return;
      reviewRows("update", [row], { [column.name]: value });
    } catch (error) { toast.error(errorMessage(error)); }
  };

  const saveView = async () => {
    setSavingView(true);
    try {
      const view = await dataViewRequest<DataView>("", { method: "POST", body: JSON.stringify({
        name: `${datasetLabel(dataset)}${queryFilters.length ? " (filtered)" : ""}`,
        description: `Rows of ${dataset.name} in ${source.name}`,
        persistence: "saved",
        bindings: [{ id: "rows", query: { sourceId: source.id, dataset: dataset.name, limit: Math.max(limit, 100), ...(queryFilters.length ? { filters: queryFilters } : {}), ...(sort ? { sort: [sort] } : {}) } }],
        widgets: [
          { type: "metric", title: "Records", binding: "rows", aggregate: "count", width: 1 },
          { type: "table", title: datasetLabel(dataset), binding: "rows", width: 4, height: "tall" },
        ],
      }) });
      onViewSaved(view);
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setSavingView(false); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-h2">{datasetLabel(dataset)}</h2>
        <span className="text-xs text-muted-foreground">
          {dataset.kind}{total !== undefined ? ` · ${formatCount(total)}${queryFilters.length ? " match" : ""}` : dataset.rowCount !== undefined ? ` · ${formatCount(dataset.rowCount)}` : ""}
        </span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {mutable ? "Double-click a value (or press F2) to edit it in place; Enter opens a row. Every change is confirmed first." : dataset.kind === "table" ? "Read-only: Polpo changes rows only on SQLite and PostgreSQL sources." : `Read-only ${dataset.kind}.`}
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2" role="toolbar" aria-label="Table actions">
        <FilterPopover columns={columns} filters={filters} onChange={changeFilters} />
        {mutable && <Button variant="outline" size="sm" onClick={() => setForm({ mode: "insert" })}><Plus /> <span className="hidden sm:inline">Add row</span><span className="sm:hidden">Add</span></Button>}
        {selectedRows.length > 0 && (
          <div className="flex items-center gap-2 rounded-control bg-muted/60 px-2 py-1 text-xs">
            <span>{selectedRows.length} selected</span>
            {mutable && <Button variant="destructive" size="xs" onClick={() => reviewRows("delete", selectedRows)}><Trash2 /> Delete</Button>}
            <Button variant="ghost" size="xs" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}
        <span className="flex-1" />
        <ColumnsPopover columns={columns} hidden={hidden} onChange={setHidden} />
        <Button variant="outline" size="sm" onClick={() => void saveView()} disabled={savingView} aria-label="Save as view">
          {savingView ? <Loader2 className="animate-spin" /> : <Save />} <span className="hidden sm:inline">Save as view</span>
        </Button>
        <Button variant="outline" size="sm" onClick={reload} disabled={rows.loading} aria-label="Refresh rows">
          <RefreshCw className={cn(rows.loading && "animate-spin")} /> <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      <DataGrid
        ariaLabel={`Rows of ${dataset.name}`}
        columns={columns}
        rows={frameRows}
        getRowKey={getRowKey}
        loading={rows.loading}
        error={rows.error}
        emptyLabel={queryFilters.length ? "No rows match these filters." : "This table is empty."}
        hiddenColumns={hidden}
        sort={sort}
        onSort={source.kind === "rest" ? undefined : changeSort}
        selected={mutable ? selected : undefined}
        onSelectedChange={mutable ? setSelected : undefined}
        onOpenRow={(row) => setOpenRow(row)}
        onEditCell={mutable ? editCell : undefined}
        paging={{
          offset, limit, total, hasMore: !!rows.data?.meta.truncated,
          onPage: (next) => { setOffset(next); setSelected(new Set()); },
          onLimit: (next) => { setLimit(next); setOffset(0); },
        }}
      />

      <RowSheet
        open={!!openRow}
        dataset={dataset.name}
        columns={columns}
        row={openRow ?? undefined}
        canEdit={mutable}
        onClose={() => setOpenRow(null)}
        onEdit={() => { setForm({ mode: "edit", row: openRow ?? undefined }); setOpenRow(null); }}
        onDelete={() => { if (openRow) reviewRows("delete", [openRow]); }}
      />
      <RowFormDialog
        open={!!form}
        mode={form?.mode ?? "insert"}
        dataset={dataset.name}
        columns={form?.mode === "insert" ? dataset.columns : columns}
        row={form?.row}
        onClose={() => setForm(null)}
        onSubmit={(values) => {
          if (form?.mode === "insert") review({ operation: "insert", dataset: dataset.name, values });
          else if (form?.row) reviewRows("update", [form.row], values);
        }}
      />
      <ConfirmMutationDialog
        pending={pending}
        sourceName={source.name}
        affected={pending?.operation === "insert" ? undefined : affected?.for === pending ? affected?.count : undefined}
        running={running}
        onCancel={() => setPending(null)}
        onConfirm={() => void confirm()}
      />
    </div>
  );
}

function formatCellEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function TablesSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true" aria-label="Loading tables">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-card border border-border p-3.5">
          <div className="size-10 animate-pulse rounded-control bg-muted" />
          <div className="flex-1 space-y-2"><div className="h-3 w-2/3 animate-pulse rounded-xs bg-muted" /><div className="h-2.5 w-1/3 animate-pulse rounded-xs bg-muted" /></div>
        </div>
      ))}
    </div>
  );
}
