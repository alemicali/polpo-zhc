/**
 * LiveActivity — panel showing the active process for an agent.
 * Pure component: receives process as props.
 */

import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  Wrench,
  FileCode,
  FilePlus,
  FileEdit,
  Hash,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import type { AgentProcess } from "@lumea-technologies/polpo-react";

export function LiveActivity({ process }: { process: AgentProcess }) {
  const act = process.activity;
  const totalFiles = (act.filesCreated?.length ?? 0) + (act.filesEdited?.length ?? 0);

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={cn("h-2.5 w-2.5 rounded-full", process.alive ? "bg-primary animate-pulse" : "bg-zinc-500")} />
          <span className="text-xs font-semibold text-primary uppercase tracking-wider">
            {process.alive ? "Active" : "Finished"}
          </span>
          <Badge variant="secondary" className="text-[10px]">PID {process.pid}</Badge>
          {act.sessionId && (
            <span className="text-[10px] font-mono text-muted-foreground">session:{act.sessionId.slice(0, 8)}</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          {act.lastUpdate && (
            <span>updated {formatDistanceToNow(new Date(act.lastUpdate), { addSuffix: true })}</span>
          )}
          <span>started {formatDistanceToNow(new Date(process.startedAt), { addSuffix: true })}</span>
        </div>
      </div>

      {/* Summary + task link */}
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground flex-1">
          {act.summary
            ? act.summary
            : act.lastTool && act.lastFile
            ? <>Using <code className="text-foreground font-mono text-xs">{act.lastTool}</code> on <code className="text-foreground font-mono text-xs">{act.lastFile}</code></>
            : act.lastTool
            ? <>Using <code className="text-foreground font-mono text-xs">{act.lastTool}</code></>
            : "Running..."}
        </p>
        <Link
          to={`/tasks/${process.taskId}`}
          className="shrink-0 inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          View task <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      {/* Metrics */}
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Wrench className="h-3.5 w-3.5" />
          <span className="font-mono font-bold text-foreground">{act.toolCalls}</span> calls
        </div>
        {totalFiles > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileCode className="h-3.5 w-3.5" />
            <span className="font-mono font-bold text-foreground">{totalFiles}</span> files
          </div>
        )}
        {act.totalTokens != null && act.totalTokens > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Hash className="h-3.5 w-3.5" />
            <span className="font-mono font-bold text-foreground">{(act.totalTokens / 1000).toFixed(1)}k</span> tokens
          </div>
        )}
      </div>

      {/* File lists */}
      {act.filesCreated && act.filesCreated.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mb-1.5">
            <FilePlus className="h-3 w-3 text-emerald-400" /> Created ({act.filesCreated.length})
          </p>
          <div className="flex flex-wrap gap-1">
            {act.filesCreated.slice(0, 12).map((f) => (
              <Badge key={f} variant="secondary" className="text-[10px] font-mono max-w-[250px] truncate">{f}</Badge>
            ))}
            {act.filesCreated.length > 12 && (
              <Badge variant="secondary" className="text-[10px]">+{act.filesCreated.length - 12}</Badge>
            )}
          </div>
        </div>
      )}
      {act.filesEdited && act.filesEdited.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mb-1.5">
            <FileEdit className="h-3 w-3 text-amber-400" /> Edited ({act.filesEdited.length})
          </p>
          <div className="flex flex-wrap gap-1">
            {act.filesEdited.slice(0, 12).map((f) => (
              <Badge key={f} variant="outline" className="text-[10px] font-mono max-w-[250px] truncate">{f}</Badge>
            ))}
            {act.filesEdited.length > 12 && (
              <Badge variant="outline" className="text-[10px]">+{act.filesEdited.length - 12}</Badge>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
