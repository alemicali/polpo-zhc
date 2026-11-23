/** Views: the saved data views that read this source (live dashboards, shown in Artifacts as type "view"). */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Gauge, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DataSource, DataView, DataViewRegistry } from "@/hooks/use-data";
import { errorMessage, relativeTime, viewLink, viewsOfSource } from "./data-utils";
import { DataEmpty, DataLoading } from "./data-states";

export function ViewsTab({ source, registry }: { source: DataSource; registry: DataViewRegistry }) {
  const [deleting, setDeleting] = useState<DataView | null>(null);
  const [busy, setBusy] = useState(false);
  if (registry.loading) return <DataLoading />;
  const views = viewsOfSource(registry.views, source.id);
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try { await registry.deleteView(deleting.id); toast.success("View deleted"); setDeleting(null); }
    catch (error) { toast.error(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="mb-3 text-xs text-muted-foreground">Live views on this source. Save one from a table (with its filters and sort) or from a SQL query; agents can make them too. They open in Artifacts.</p>
      {registry.error && <p role="alert" className="mb-3 text-xs text-destructive">{registry.error}</p>}
      {views.length === 0 ? <DataEmpty icon={Gauge} title="No views on this source" description="In Tables or SQL, use “Save as view”." /> : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {views.map((view) => {
            const sql = view.bindings.some((binding) => binding.sql);
            return (
              <li key={view.id} className="flex items-start gap-3 rounded-card border border-border bg-card p-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-primary/10"><Gauge className="size-4 text-primary" /></span>
                <div className="min-w-0 flex-1">
                  <Link to={viewLink(view.id)} className="block truncate text-sm font-medium hover:underline">{view.name}</Link>
                  <p className="truncate text-xs text-muted-foreground">{view.description || (sql ? "SQL query" : "Table query")}</p>
                  <p className="mt-1 text-micro text-muted-foreground">{view.widgets.length} widgets · {view.persistence} · updated {relativeTime(view.updatedAt)}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button asChild variant="ghost" size="icon-sm" aria-label={`Open ${view.name}`}><Link to={viewLink(view.id)}><ExternalLink /></Link></Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${view.name}`} onClick={() => setDeleting(view)}><Trash2 /></Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={!!deleting} onOpenChange={(value) => { if (!value && !busy) setDeleting(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{deleting?.name}”?</DialogTitle>
            <DialogDescription>The view goes away; the data it reads stays in the source.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={busy}>Cancel</Button>
            <Button variant="destructive" onClick={() => void remove()} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete view</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
