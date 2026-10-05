import { ChevronDown, ChevronRight, ClockArrowUp, History, Loader2, Square, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { BackgroundWait } from "@/hooks/use-background-waits";
import { sidebarActions } from "@/hooks/chat-context";

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
  const navigate = useNavigate();
  const [historyOpen, setHistoryOpen] = useState(false);
  const activeWaits = waits
    .filter((wait) => ACTIVE_STATES.has(wait.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const finishedWaits = waits
    .filter((wait) => !ACTIVE_STATES.has(wait.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 10);
  const visibleWaits = historyOpen ? [...activeWaits, ...finishedWaits] : activeWaits;

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
      {visibleWaits.length === 0 ? (
        <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">No active background waits.</div>
      ) : (
        <div className="max-h-56 divide-y divide-border/40 overflow-y-auto">
          {visibleWaits.map((wait) => {
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
                    <button
                      type="button"
                      className="truncate text-left text-xs font-medium hover:underline"
                      onClick={() => {
                        navigate(`/tasks/${encodeURIComponent(wait.taskId)}`);
                        sidebarActions.setSidebarOpen(true);
                      }}
                    >
                      {wait.taskId}
                    </button>
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </div>
                  <p className="truncate text-[10px] text-muted-foreground" title={wait.error}>
                    {wait.targetStatus ? `until ${wait.targetStatus}` : "until done or failed"}
                    {wait.error ? ` · ${wait.error}` : ""}
                  </p>
                </div>
                <Badge variant="outline" className="h-5 text-[9px] font-normal">{wait.state}</Badge>
                {active && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => void onCancel(wait.id)}
                    aria-label="Stop background wait"
                    title="Stop background wait"
                  >
                    <Square className="h-3 w-3 fill-current" />
                    Stop
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {finishedWaits.length > 0 && (
        <button
          type="button"
          className="flex h-8 w-full items-center gap-2 border-t border-border/50 px-3 text-[10px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={() => setHistoryOpen((value) => !value)}
          aria-expanded={historyOpen}
        >
          <History className="h-3 w-3" />
          <span className="flex-1 text-left">{historyOpen ? "Hide recent history" : `Recent finished (${finishedWaits.length})`}</span>
          <ChevronDown className={cn("h-3 w-3 transition-transform", historyOpen && "rotate-180")} />
        </button>
      )}
    </div>
  );
}
