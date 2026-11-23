/**
 * SQL: one read-only statement (SELECT, WITH, EXPLAIN) on a SQLite or PostgreSQL source, run in a
 * read-only transaction / handle. Highlighted editor, results in the data grid, this browser's
 * history per source, and "Save as view" (a live SQL binding). Writes go through Tables.
 */
import { useMemo, useState } from "react";
import { Clock, History, Loader2, Play, Save, ShieldCheck, Table2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { DataDataset, DataFrame, DataRegistry, DataSource, DataView } from "@/hooks/use-data";
import { dataViewRequest } from "@/hooks/use-data";
import { cn } from "@/lib/utils";
import { DataGrid } from "./data-grid";
import { datasetLabel, errorMessage, pushSqlHistory, readSqlHistory, relativeTime, type SqlHistoryEntry } from "./data-utils";
import { SqlEditor } from "./sql-editor";
import { looksReadOnly } from "./sql-highlight";

export function SqlTab({ source, registry, datasets, onViewSaved }: { source: DataSource; registry: DataRegistry; datasets: DataDataset[]; onViewSaved: (view: DataView) => void }) {
  const [history, setHistory] = useState<SqlHistoryEntry[]>(() => readSqlHistory(source.id));
  const [sql, setSql] = useState(() => history[0]?.sql ?? (datasets[0] ? `SELECT *\nFROM ${quoteName(datasets[0].name, source.kind)}\nLIMIT 100;` : "SELECT 1;"));
  const [result, setResult] = useState<{ frame?: DataFrame; error?: string; sql: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [page, setPage] = useState({ offset: 0, limit: 50 });
  const [saveOpen, setSaveOpen] = useState(false);

  const run = async () => {
    const statement = sql.trim();
    if (!statement || running) return;
    if (!looksReadOnly(statement)) {
      setResult({ sql: statement, error: "Only SELECT, WITH and EXPLAIN run here. To insert, update or delete rows use Tables (every change is confirmed); schema changes are not possible through Polpo." });
      return;
    }
    setRunning(true);
    try {
      const frame = await registry.rawSql(source.id, statement);
      setResult({ frame, sql: statement });
      setPage((current) => ({ ...current, offset: 0 }));
      setHistory(pushSqlHistory(source.id, { sql: statement, at: new Date().toISOString(), rows: frame.meta.rowCount }));
    } catch (error) {
      setResult({ error: errorMessage(error), sql: statement });
      setHistory(pushSqlHistory(source.id, { sql: statement, at: new Date().toISOString(), error: errorMessage(error) }));
    } finally { setRunning(false); }
  };

  const rows = useMemo(() => result?.frame?.rows.slice(page.offset, page.offset + page.limit) ?? [], [page, result]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 xl:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck className="size-3.5 text-success" /> Read-only: the database refuses anything that writes.</span>
          <span className="flex-1" />
          <Button variant="outline" size="sm" disabled={!result?.frame} onClick={() => setSaveOpen(true)}><Save /> <span className="hidden sm:inline">Save as view</span></Button>
          <Button size="sm" onClick={() => void run()} disabled={running || !sql.trim()} aria-keyshortcuts="Control+Enter Meta+Enter">
            {running ? <Loader2 className="animate-spin" /> : <Play />} Run <kbd className="hidden rounded-xs bg-primary-foreground/20 px-1 font-sans text-micro sm:inline">⌘↵</kbd>
          </Button>
        </div>
        <SqlEditor value={sql} onChange={setSql} onRun={() => void run()} ariaLabel={`SQL for ${source.name}`} />
        <div className="mt-4 flex min-h-64 flex-1 flex-col">
          {result ? (
            <>
              {result.frame && (
                <p className="mb-2 flex flex-wrap gap-x-3 text-xs text-muted-foreground" aria-live="polite">
                  <span>{result.frame.meta.rowCount.toLocaleString()} rows{result.frame.meta.truncated ? " (first 1,000)" : ""}</span>
                  <span>{result.frame.meta.durationMs} ms</span>
                </p>
              )}
              <DataGrid
                ariaLabel="Query results"
                columns={result.frame?.columns ?? []}
                rows={rows}
                error={result.error}
                loading={running}
                emptyLabel="The query returned no rows."
                paging={result.frame && result.frame.rows.length > 25 ? {
                  offset: page.offset, limit: page.limit, total: result.frame.rows.length, hasMore: false,
                  onPage: (offset) => setPage((current) => ({ ...current, offset })),
                  onLimit: (limit) => setPage({ offset: 0, limit }),
                } : undefined}
              />
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-card border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
              Write a query and press Run (Ctrl/⌘ + Enter). Results appear here, at most 1,000 rows.
            </div>
          )}
        </div>
      </div>

      <aside className="flex shrink-0 flex-col gap-4 xl:w-72">
        <section aria-label="Tables" className="rounded-card border border-border">
          <h3 className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-xs font-semibold"><Table2 className="size-3.5" /> Tables</h3>
          <ul className="max-h-48 overflow-auto p-1.5">
            {datasets.map((dataset) => (
              <li key={dataset.id}>
                <button type="button" className="w-full truncate rounded-control px-2 py-1 text-left font-mono text-xs hover:bg-muted" title={`Query ${dataset.name}`}
                  onClick={() => setSql(`SELECT *\nFROM ${quoteName(dataset.name, source.kind)}\nLIMIT 100;`)}>
                  {datasetLabel(dataset)}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="History" className="min-h-0 rounded-card border border-border">
          <div className="flex items-center border-b border-border px-3 py-2">
            <h3 className="flex flex-1 items-center gap-1.5 text-xs font-semibold"><History className="size-3.5" /> History</h3>
            {history.length > 0 && <Button variant="ghost" size="icon-xs" aria-label="Clear history" onClick={() => { localStorage.removeItem(`polpo:data-sql-history:${source.id}`); setHistory([]); }}><Trash2 /></Button>}
          </div>
          {history.length === 0 ? <p className="px-3 py-4 text-xs text-muted-foreground">Queries you run here are kept in this browser.</p> : (
            <ul className="max-h-72 divide-y divide-border overflow-auto">
              {history.map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  <button type="button" onClick={() => setSql(entry.sql)} className="w-full px-3 py-2 text-left hover:bg-muted/60">
                    <span className="line-clamp-2 break-all font-mono text-micro">{entry.sql}</span>
                    <span className={cn("mt-1 flex items-center gap-1 text-micro", entry.error ? "text-destructive" : "text-muted-foreground")}>
                      <Clock className="size-3" /> {relativeTime(entry.at)} · {entry.error ? "failed" : `${entry.rows ?? 0} rows`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      <SaveSqlViewDialog open={saveOpen} source={source} sql={result?.sql ?? sql} onClose={() => setSaveOpen(false)} onSaved={(view) => { setSaveOpen(false); onViewSaved(view); }} />
    </div>
  );
}

function SaveSqlViewDialog({ open, source, sql, onClose, onSaved }: { open: boolean; source: DataSource; sql: string; onClose: () => void; onSaved: (view: DataView) => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const view = await dataViewRequest<DataView>("", { method: "POST", body: JSON.stringify({
        name: name.trim(), description: `SQL on ${source.name}`, persistence: "saved",
        bindings: [{ id: "result", sql: { sourceId: source.id, statement: sql } }],
        widgets: [{ type: "metric", title: "Rows", binding: "result", aggregate: "count", width: 1 }, { type: "table", title: name.trim(), binding: "result", width: 4, height: "tall" }],
      }) });
      setName("");
      onSaved(view);
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 border-b px-6 pb-4 pt-6 pr-12">
          <DialogTitle>Save as view</DialogTitle>
          <DialogDescription>A view runs this statement live each time it opens (read-only), with a row count and a table you can change later.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label className="grid gap-1.5 text-xs font-medium">Name<Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Open orders by region" /></label>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-card border border-border bg-muted/40 p-2 font-mono text-micro">{sql}</pre>
            <DialogFooter sticky>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={saving || !name.trim()}>{saving ? <Loader2 className="animate-spin" /> : <Save />} Save view</Button>
            </DialogFooter>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function quoteName(name: string, kind: DataSource["kind"]): string {
  const parts = kind === "postgres" ? name.split(".") : [name];
  return parts.map((part) => (/^[a-z_][a-z0-9_]*$/.test(part) ? part : `"${part.replaceAll('"', '""')}"`)).join(".");
}
