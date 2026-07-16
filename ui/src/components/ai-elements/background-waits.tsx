import { ClockArrowUp, ExternalLink, Loader2, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { BackgroundWait } from "@/hooks/use-background-waits";

const ACTIVE_STATES = new Set(["waiting", "ready", "running"]);

export function BackgroundWaits({
  waits,
  loading,
  currentSessionId,
  onCancel,
  onClose,
}: {
  waits: BackgroundWait[];
  loading: boolean;
  currentSessionId?: string | null;
  onCancel: (id: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const ordered = [...waits].sort((a, b) => {
    const activeDiff = Number(ACTIVE_STATES.has(b.state)) - Number(ACTIVE_STATES.has(a.state));
    return activeDiff || b.updatedAt.localeCompare(a.updatedAt);
  });

  return (
    <div className="border border-border/60 bg-card/80 shadow-sm">
      <div className="flex h-9 items-center gap-2 border-b border-border/50 px-3">
        <ClockArrowUp className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 text-xs font-medium">Background waits</span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} aria-label="Close background waits">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {ordered.length === 0 ? (
        <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">No background waits.</div>
      ) : (
        <div className="max-h-56 divide-y divide-border/40 overflow-y-auto">
          {ordered.map((wait) => {
            const active = ACTIVE_STATES.has(wait.state);
            return (
              <div key={wait.id} className={cn("flex items-center gap-2 px-3 py-2", wait.sessionId === currentSessionId && "bg-accent/20")}>
                {wait.state === "running" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                ) : (
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", active ? "bg-amber-500" : wait.state === "completed" ? "bg-emerald-500" : "bg-muted-foreground/50")} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <a href={`/tasks/${encodeURIComponent(wait.taskId)}`} className="truncate text-xs font-medium hover:underline">
                      {wait.taskId}
                    </a>
                    <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </div>
                  <p className="truncate text-[10px] text-muted-foreground" title={wait.error}>
                    {wait.targetStatus ? `until ${wait.targetStatus}` : "until done or failed"}
                    {wait.error ? ` · ${wait.error}` : ""}
                  </p>
                </div>
                <Badge variant="outline" className="h-5 text-[9px] font-normal">{wait.state}</Badge>
                {active && (
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => void onCancel(wait.id)} aria-label="Cancel background wait" title="Cancel background wait">
                    <Square className="h-3 w-3 fill-current" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
