/**
 * Schema: every dataset with its columns (type, the database's own type, nullability, default,
 * primary key), indexes, and relations both ways (the foreign keys it has, and the tables that
 * point to it). A relation opens the other table's schema; "Browse rows" opens it in Tables.
 */
import { useMemo, useState } from "react";
import { ArrowLeftToLine, ArrowRightFromLine, Eye, KeyRound, ListTree, RefreshCw, Rows3, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DataDataset } from "@/hooks/use-data";
import { cn } from "@/lib/utils";
import { datasetLabel, formatCount } from "./data-utils";
import { DataEmpty, DataError, DataLoading } from "./data-states";

export function SchemaTab({ datasets, loading, error, selected, onSelect, onBrowse, onRefresh }: {
  datasets: DataDataset[];
  loading: boolean;
  error?: string;
  selected: string | null;
  onSelect: (name: string) => void;
  onBrowse: (name: string) => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState("");
  if (loading && datasets.length === 0) return <DataLoading label="Reading the schema…" />;
  if (error && datasets.length === 0) return <DataError title="Could not read the schema" message={error} onRetry={onRefresh} />;
  if (datasets.length === 0) return <DataEmpty icon={ListTree} title="No datasets discovered" description="Check the connection and the database user's permissions in Settings." />;
  const current = datasets.find((item) => item.name === selected) ?? datasets[0]!;
  const shown = datasets.filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
      <nav aria-label="Datasets" className="flex max-h-56 shrink-0 flex-col rounded-card border border-border bg-muted/20 lg:max-h-none lg:w-60">
        <div className="flex items-center gap-1 border-b border-border p-2">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`${datasets.length} datasets`} aria-label="Filter datasets" className="h-7 text-xs" />
          <Button variant="ghost" size="icon-sm" onClick={onRefresh} aria-label="Reload schema"><RefreshCw className={cn(loading && "animate-spin")} /></Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-auto p-1.5">
          {shown.map((item) => (
            <li key={item.id}>
              <button type="button" aria-current={item.name === current.name ? "true" : undefined} onClick={() => onSelect(item.name)} className={cn("flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs", item.name === current.name ? "bg-accent text-accent-foreground" : "hover:bg-muted")}>
                {item.kind === "view" ? <Eye className="size-3.5 shrink-0 text-muted-foreground" /> : <Table2 className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate font-mono">{datasetLabel(item)}</span>
                <span className="text-micro text-muted-foreground">{item.columns.length}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <DatasetSchema dataset={current} datasets={datasets} onSelect={onSelect} onBrowse={onBrowse} />
    </div>
  );
}

function DatasetSchema({ dataset, datasets, onSelect, onBrowse }: { dataset: DataDataset; datasets: DataDataset[]; onSelect: (name: string) => void; onBrowse: (name: string) => void }) {
  const referencedBy = useMemo(() => datasets.flatMap((other) => (other.foreignKeys ?? [])
    .filter((fk) => fk.references.dataset === dataset.name || (dataset.namespace === undefined && fk.references.dataset === datasetLabel(dataset)))
    .map((fk) => ({ from: other.name, columns: fk.columns, to: fk.references.columns }))), [dataset, datasets]);
  const known = (name: string) => datasets.some((item) => item.name === name);
  return (
    <section aria-label={`Schema of ${dataset.name}`} className="min-h-0 min-w-0 flex-1 overflow-auto">
      <header className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-h2">{dataset.name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {dataset.kind} · {dataset.columns.length} columns{dataset.rowCount !== undefined ? ` · ${formatCount(dataset.rowCount)}` : ""}
            {dataset.indexes ? ` · ${dataset.indexes.length} indexes` : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => onBrowse(dataset.name)}><Rows3 /> Browse rows</Button>
      </header>

      <h3 className="mb-2 text-xs font-semibold">Columns</h3>
      <div className="overflow-x-auto rounded-card border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted text-left text-muted-foreground">
            <tr><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 font-medium">Nullable</th><th className="px-3 py-2 font-medium">Default</th></tr>
          </thead>
          <tbody>
            {dataset.columns.map((column) => (
              <tr key={column.name} className="border-t border-border">
                <td className="px-3 py-2 font-mono">
                  <span className="flex items-center gap-1.5">
                    {column.primaryKey && <KeyRound className="size-3 text-warning" aria-label="Primary key" />}
                    <span className={cn(column.primaryKey && "font-semibold")}>{column.name}</span>
                  </span>
                </td>
                <td className="px-3 py-2"><span className="font-mono">{column.nativeType ?? column.type}</span>{column.nativeType && <span className="ml-1.5 text-muted-foreground">{column.type}</span>}</td>
                <td className="px-3 py-2 text-muted-foreground">{column.nullable === undefined ? "—" : column.nullable ? "yes" : "no"}</td>
                <td className="max-w-60 truncate px-3 py-2 font-mono text-muted-foreground" title={column.defaultValue ?? undefined}>{column.defaultValue ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dataset.indexes && (
        <>
          <h3 className="mb-2 mt-6 text-xs font-semibold">Indexes</h3>
          {dataset.indexes.length === 0 ? <p className="text-xs text-muted-foreground">No indexes.</p> : (
            <ul className="divide-y divide-border rounded-card border border-border text-xs">
              {dataset.indexes.map((index) => (
                <li key={index.name} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="font-mono">{index.name}</span>
                  {index.primary && <span className="rounded-badge bg-warning/15 px-1.5 text-micro text-warning">primary</span>}
                  {index.unique && !index.primary && <span className="rounded-badge bg-info/15 px-1.5 text-micro text-info">unique</span>}
                  <span className="flex-1" />
                  <span className="font-mono text-muted-foreground">({index.columns.join(", ")})</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {(dataset.foreignKeys || referencedBy.length > 0) && (
        <>
          <h3 className="mb-2 mt-6 text-xs font-semibold">Relations</h3>
          {(dataset.foreignKeys?.length ?? 0) === 0 && referencedBy.length === 0 ? <p className="text-xs text-muted-foreground">No foreign keys to or from this table.</p> : (
            <ul className="divide-y divide-border rounded-card border border-border text-xs">
              {(dataset.foreignKeys ?? []).map((fk, index) => (
                <li key={`out-${index}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <ArrowRightFromLine className="size-3.5 text-primary" aria-label="References" />
                  <span className="font-mono">({fk.columns.join(", ")})</span>
                  <span className="text-muted-foreground">→</span>
                  <RelationTarget name={fk.references.dataset} known={known(fk.references.dataset)} onSelect={onSelect} />
                  <span className="font-mono text-muted-foreground">({fk.references.columns.join(", ")})</span>
                  {(fk.onDelete && fk.onDelete !== "NO ACTION") && <span className="text-micro text-muted-foreground">on delete {fk.onDelete.toLowerCase()}</span>}
                </li>
              ))}
              {referencedBy.map((ref, index) => (
                <li key={`in-${index}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <ArrowLeftToLine className="size-3.5 text-info" aria-label="Referenced by" />
                  <RelationTarget name={ref.from} known onSelect={onSelect} />
                  <span className="font-mono text-muted-foreground">({ref.columns.join(", ")})</span>
                  <span className="text-muted-foreground">→ ({ref.to.join(", ")})</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function RelationTarget({ name, known, onSelect }: { name: string; known: boolean; onSelect: (name: string) => void }) {
  return known
    ? <button type="button" onClick={() => onSelect(name)} className="font-mono text-primary underline-offset-2 hover:underline">{name}</button>
    : <span className="font-mono">{name}</span>;
}
