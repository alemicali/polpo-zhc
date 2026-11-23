/**
 * Activity: every test, schema read, query, SQL statement and row change on this source, by whom
 * (an agent or Polpo), with rows, duration and errors — never the data itself. Live.
 */
import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useEvents } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DataActivity, DataRegistry, DataSource } from "@/hooks/use-data";
import { cn } from "@/lib/utils";
import { relativeTime, useLoader } from "./data-utils";
import { DataEmpty, DataError, DataLoading } from "./data-states";

const ACTIONS = ["all", "query", "sql", "mutate", "discover", "test"] as const;
const ACTION_LABEL: Record<string, string> = { query: "Query", sql: "SQL", mutate: "Row change", discover: "Schema read", test: "Connection test" };

export function ActivityTab({ source, registry }: { source: DataSource; registry: DataRegistry }) {
  const activity = useLoader<DataActivity[]>(`activity:${source.id}`, () => registry.sourceActivity(source.id));
  const { reload } = activity;
  const [action, setAction] = useState<(typeof ACTIONS)[number]>("all");
  const [failedOnly, setFailedOnly] = useState(false);
  const { events } = useEvents(["data-source:changed"], 1);
  const latest = events.at(-1);
  useEffect(() => {
    const data = latest?.data as { sourceId?: string; action?: string } | undefined;
    if (data?.sourceId === source.id && (data.action === "activity" || data.action === "data")) reload();
  }, [latest, reload, source.id]);

  const items = useMemo(() => (activity.data ?? []).filter((item) => (action === "all" || item.action === action) && (!failedOnly || item.status === "failed")), [action, activity.data, failedOnly]);
  if (activity.loading && !activity.data) return <DataLoading />;
  if (activity.error && !activity.data) return <DataError title="Could not read the activity" message={activity.error} onRetry={reload} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs text-muted-foreground">Recorded without the data itself: who, what, how many rows, how long.</p>
        <Select value={action} onValueChange={(value) => setAction(value as (typeof ACTIONS)[number])}>
          <SelectTrigger size="sm" className="w-40 text-xs" aria-label="Action"><SelectValue /></SelectTrigger>
          <SelectContent>{ACTIONS.map((item) => <SelectItem key={item} value={item}>{item === "all" ? "All actions" : ACTION_LABEL[item]}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant={failedOnly ? "secondary" : "outline"} size="sm" aria-pressed={failedOnly} onClick={() => setFailedOnly((value) => !value)}>Failed only</Button>
        <Button variant="ghost" size="icon-sm" aria-label="Reload activity" onClick={reload}><RefreshCw className={cn(activity.loading && "animate-spin")} /></Button>
      </div>
      {items.length === 0 ? <DataEmpty title="No activity" description={activity.data?.length ? "Nothing matches these filters." : "Queries, SQL and row changes appear here as they happen."} /> : (
        <div className="min-h-0 flex-1 overflow-auto rounded-card border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
              <tr><th className="px-3 py-2 font-medium">When</th><th className="px-3 py-2 font-medium">Action</th><th className="px-3 py-2 font-medium">By</th><th className="hidden px-3 py-2 font-medium md:table-cell">Dataset</th><th className="px-3 py-2 text-right font-medium">Rows</th><th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Time</th></tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-border align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground" title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)}</td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span className={cn("size-2 shrink-0 rounded-pill", item.status === "succeeded" ? "bg-success" : "bg-destructive")} aria-label={item.status} />
                      {ACTION_LABEL[item.action] ?? item.action}
                    </span>
                    {item.error && <span className="mt-1 block break-words text-destructive">{item.error}</span>}
                  </td>
                  <td className="px-3 py-2">{item.agent ?? <span className="text-muted-foreground">Polpo</span>}</td>
                  <td className="hidden px-3 py-2 font-mono md:table-cell">{item.dataset ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{item.rowCount ?? "—"}</td>
                  <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground sm:table-cell">{item.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
