import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, FolderOpen, Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { browseDir, type BrowseResult } from "./use-git-meta";

// ── New workspace popover ────────────────────────────────────────────────
//
// Triggered from the sidebar footer "Add workspace" button. Lets the user
// browse from the server's working directory and pick a folder to use as
// the new workspace's cwd. The folder name becomes the workspace name.
//
// `root` constrains traversal — the browser starts at `root` and won't let
// the user navigate above it. Falls back to the server's default browse
// location (homedir) when not provided.
//
// `extraRoots` widens the picker: when non-empty, the user can switch the
// active root to any whitelisted absolute path (configured via the coding
// settings dialog when "allow outside workspace" is on).
export function NewWorkspacePopover({
  root,
  extraRoots = [],
  onCreate,
}: {
  root?: string;
  extraRoots?: string[];
  onCreate: (cwd: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const roots = useMemo(() => {
    const list = [root, ...extraRoots].filter((p): p is string => !!p && p.length > 0);
    return Array.from(new Set(list));
  }, [root, extraRoots]);
  const [activeRoot, setActiveRoot] = useState<string | undefined>(root);

  useEffect(() => { setActiveRoot(root); }, [root]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 rounded-md px-2 text-[11px] text-white/55 hover:bg-white/[0.05] hover:text-white"
          title="Add workspace"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden lg:inline">Add workspace</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 max-h-[28rem] overflow-hidden p-0 border-white/[0.08] bg-[#141414] text-white/80"
      >
        {roots.length > 1 && (
          <div className="flex flex-wrap gap-1 border-b border-white/[0.06] px-2 py-1.5">
            {roots.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setActiveRoot(r)}
                className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-[10.5px] transition-colors",
                  activeRoot === r
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white",
                )}
                title={r}
              >
                {labelForRoot(r)}
              </button>
            ))}
          </div>
        )}
        <PathBrowser
          key={activeRoot ?? "default"}
          root={activeRoot}
          onConfirm={(path) => {
            const name = path.split("/").filter(Boolean).pop() ?? "Workspace";
            onCreate(path, name);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function labelForRoot(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

// ── Reusable directory browser ───────────────────────────────────────────
//
// `root` constrains parent navigation: the "Up" button is disabled when
// `browse.current` is at or above `root`. Initial fetch starts at `root`
// when provided.
function PathBrowser({ root, onConfirm }: { root?: string; onConfirm: (path: string) => void }) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null);

  useEffect(() => {
    browseDir(root ?? "").then(setBrowse);
  }, [root]);

  const navigate = async (path: string) => {
    if (root && !path.startsWith(root)) return;
    const next = await browseDir(path);
    if (next) setBrowse(next);
  };

  const atRoot = !!root && (!browse || browse.current === root || !browse.current.startsWith(root));
  const canGoUp = !atRoot && !!browse?.parent && (!root || browse.parent.startsWith(root));

  return (
    <>
      <div className="flex items-center gap-1 border-b border-white/[0.06] px-2 py-1.5">
        <button
          type="button"
          disabled={!canGoUp}
          onClick={() => browse?.parent && canGoUp && navigate(browse.parent)}
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-white/[0.06] disabled:opacity-30"
          title="Up"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <code className="flex-1 truncate font-mono text-[11px] text-white/55">{browse?.current || "…"}</code>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {browse && browse.dirs.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-white/35">No subdirectories</div>
        )}
        {browse?.dirs.map((d) => (
          <button
            key={d.path}
            type="button"
            onClick={() => navigate(d.path)}
            className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11.5px] text-white/80 hover:bg-white/[0.05]"
          >
            <FolderOpen className={cn("h-4 w-4", d.hasPolpoConfig ? "text-emerald-400/80" : "text-white/35")} />
            <span className="truncate">{d.name}</span>
            {d.hasPolpoConfig && <span className="ml-auto text-[9px] text-emerald-400/70">polpo</span>}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-1 border-t border-white/[0.06] px-2 py-1.5">
        <span className="text-[10px] text-white/35 truncate">{browse?.dirs.length ?? 0} folders</span>
        <button
          type="button"
          onClick={() => browse?.current && onConfirm(browse.current)}
          disabled={!browse?.current}
          className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
        >
          Use this folder
        </button>
      </div>
    </>
  );
}
