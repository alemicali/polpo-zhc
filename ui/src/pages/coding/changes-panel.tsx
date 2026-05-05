import { cn } from "@/lib/utils";
import { useGitStatus } from "./use-git-status";
import type { GitFile } from "./types";

export function ChangesPanel({ cwd, refreshKey }: { cwd: string; refreshKey: number }) {
  const files = useGitStatus(cwd, refreshKey);
  const totalIns = files.reduce((acc, f) => acc + f.insertions, 0);
  const totalDel = files.reduce((acc, f) => acc + f.deletions, 0);

  return (
    <aside className="flex h-full w-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/40">
          Working tree
        </span>
        <div className="flex-1" />
        {files.length > 0 ? (
          <span className="flex items-center gap-1.5 text-[10px] font-mono tabular-nums">
            <span className="text-white/35">{files.length}</span>
            {totalIns > 0 && <span className="text-emerald-400/80">+{totalIns}</span>}
            {totalDel > 0 && <span className="text-rose-400/80">−{totalDel}</span>}
          </span>
        ) : (
          <span className="text-[10px] text-white/30 tabular-nums">0</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        {files.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-white/35">
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
  return (
    <div
      title={file.path}
      className="group/file flex items-center gap-2 rounded-md px-2 py-1 hover:bg-white/[0.03]"
    >
      <span className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold",
        file.status === "M" ? "bg-amber-500/15 text-amber-400"
        : file.status === "A" ? "bg-emerald-500/15 text-emerald-400"
        : file.status === "D" ? "bg-rose-500/15 text-rose-400"
        : file.status === "R" ? "bg-sky-500/15 text-sky-400"
        : file.status === "?" ? "bg-white/[0.06] text-white/55"
        : "bg-white/[0.06] text-white/55",
      )}>
        {file.status === "?" ? "U" : file.status}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-mono text-white/85 truncate">{fileName}</div>
        {dir && <div className="text-[10px] font-mono text-white/30 truncate">{dir}</div>}
      </div>
      <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
        {file.insertions > 0 && <span className="text-emerald-400/85">+{file.insertions}</span>}
        {file.deletions > 0 && <span className="text-rose-400/85">−{file.deletions}</span>}
      </span>
    </div>
  );
}
