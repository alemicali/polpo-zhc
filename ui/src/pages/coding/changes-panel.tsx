import { AlertTriangle, ArrowRight, Copy as CopyIcon, HelpCircle, Minus, Pencil, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGitStatus } from "./use-git-status";
import { FileIcon } from "./file-icon";
import type { GitFile } from "./types";

export function ChangesPanel({ cwd, refreshKey }: { cwd: string; refreshKey: number }) {
  const files = useGitStatus(cwd, refreshKey);
  const totalIns = files.reduce((acc, f) => acc + f.insertions, 0);
  const totalDel = files.reduce((acc, f) => acc + f.deletions, 0);

  return (
    <aside className="flex h-full w-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <span className="text-label text-muted-foreground">
          Working tree
        </span>
        <div className="flex-1" />
        {files.length > 0 ? (
          <span className="flex items-center gap-1.5 text-micro font-mono tabular-nums">
            <span className="text-muted-foreground">{files.length}</span>
            {totalIns > 0 && <span className="text-success/80">+{totalIns}</span>}
            {totalDel > 0 && <span className="text-destructive/80">−{totalDel}</span>}
          </span>
        ) : (
          <span className="text-micro text-muted-foreground tabular-nums">0</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        {files.length === 0 ? (
          <div className="px-3 py-6 text-center text-caption text-muted-foreground">
            No changes
          </div>
        ) : (
          files.map((f) => <ChangedFileRow key={f.path} file={f} />)
        )}
      </div>
    </aside>
  );
}

function ChangedFileRow({ file }: { file: GitFile }) {
  const fileName = file.path.split("/").pop() ?? file.path;
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  const status = describeStatus(file.status);
  return (
    <div
      title={`${status.label} · ${file.path}`}
      className="group/file flex h-7 items-center gap-2 rounded-md px-2 hover:bg-muted/50"
    >
      <FileIcon path={file.path} className="h-4 w-4 shrink-0" />
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className={cn(
          "shrink-0 truncate text-small font-mono max-w-[60%]",
          file.status === "D" ? "text-muted-foreground line-through decoration-destructive/40" : "text-foreground/85",
        )}>
          {fileName}
        </span>
        {dir && (
          <span className="min-w-0 truncate font-mono text-micro text-muted-foreground/60">{dir}</span>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-1 font-mono text-micro tabular-nums w-[4.5rem] justify-end">
        {file.insertions > 0 && <span className="text-success/85">+{file.insertions}</span>}
        {file.deletions > 0 && <span className="text-destructive/85">−{file.deletions}</span>}
      </span>
      <span
        title={status.label}
        className={cn("inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-xs", status.bg, status.text)}
      >
        <status.icon className="h-3 w-3" />
      </span>
    </div>
  );
}

/**
 * Maps a git porcelain status code to a human label + colour.
 * "M" modified, "A" added, "D" deleted, "R" renamed, "C" copied,
 * "U" unmerged, "?" untracked.
 */
type StatusVisual = { label: string; text: string; bg: string; icon: typeof Pencil };
function describeStatus(code: string): StatusVisual {
  switch (code) {
    case "M": return { label: "Modified", text: "text-warning", bg: "bg-warning/15", icon: Pencil };
    case "A": return { label: "Added", text: "text-success", bg: "bg-success/15", icon: Plus };
    case "D": return { label: "Deleted", text: "text-destructive", bg: "bg-destructive/15", icon: Minus };
    case "R": return { label: "Renamed", text: "text-info", bg: "bg-info/15", icon: ArrowRight };
    case "C": return { label: "Copied", text: "text-info", bg: "bg-info/15", icon: CopyIcon };
    case "U": return { label: "Conflict", text: "text-chart-5", bg: "bg-chart-5/15", icon: AlertTriangle };
    case "?": return { label: "Untracked", text: "text-muted-foreground", bg: "bg-muted", icon: HelpCircle };
    default: return { label: "Changed", text: "text-muted-foreground", bg: "bg-muted", icon: Pencil };
  }
}
