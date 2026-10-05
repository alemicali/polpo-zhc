import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, CloudDownload, FolderOpen, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { apiUrl } from "@/lib/config";
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
  label = "Add workspace",
  onCreate,
}: {
  root?: string;
  extraRoots?: string[];
  label?: string;
  onCreate: (cwd: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const roots = useMemo(() => {
    const list = [root, ...extraRoots].filter((p): p is string => !!p && p.length > 0);
    return Array.from(new Set(list));
  }, [root, extraRoots]);
  const [activeRoot, setActiveRoot] = useState<string | undefined>(root);
  const [mode, setMode] = useState<"browse" | "clone">("browse");

  useEffect(() => { setActiveRoot(root); }, [root]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          title={label}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden lg:inline">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-[22rem] max-h-[30rem] overflow-hidden p-0 border-border bg-popover text-foreground/80"
      >
        <ModePicker mode={mode} onChange={setMode} />
        {mode === "browse" ? (
          <>
            {roots.length > 1 && (
              <div className="flex flex-wrap gap-1 border-b border-border/70 px-2 py-1.5">
                {roots.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setActiveRoot(r)}
                    className={cn(
                      "rounded px-1.5 py-0.5 font-mono text-[10.5px] transition-colors",
                      activeRoot === r
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground",
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
          </>
        ) : (
          <CloneFromUrl onDone={(path, name) => { onCreate(path, name); setOpen(false); }} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function ModePicker({ mode, onChange }: { mode: "browse" | "clone"; onChange: (m: "browse" | "clone") => void }) {
  return (
    <div className="flex h-12 items-center border-b border-border/70 px-2">
      <Tabs value={mode} onValueChange={(value) => onChange(value as "browse" | "clone")}>
        <TabsList className="h-8">
          <TabsTrigger value="browse" className="h-6 gap-1.5 text-[11px]"><FolderOpen className="h-3.5 w-3.5" />Browse folder</TabsTrigger>
          <TabsTrigger value="clone" className="h-6 gap-1.5 text-[11px]"><CloudDownload className="h-3.5 w-3.5" />From repo URL</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

type GhRepo = {
  nameWithOwner: string;
  description: string | null;
  sshUrl: string;
  url: string;
  updatedAt: string;
  isPrivate: boolean;
};

function CloneFromUrl({ onDone }: { onDone: (path: string, name: string) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<GhRepo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(true);

  // Best-effort `gh repo list` on mount. If it fails (gh not installed,
  // not signed in) we fall back to a plain URL field.
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/api/v1/coding/projects/gh-repos"), { credentials: "include" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) throw new Error(body?.error || "gh-repos");
        return body.data as GhRepo[];
      })
      .then((data) => { if (!cancelled) setRepos(data); })
      .catch(() => { if (!cancelled) setRepos(null); })
      .finally(() => { if (!cancelled) setReposLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    if (!q) return repos.slice(0, 30);
    return repos.filter((r) => r.nameWithOwner.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)).slice(0, 30);
  }, [repos, query]);

  const clone = async (cloneUrl: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/v1/coding/projects/clone"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: cloneUrl }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `Clone failed (${res.status})`);
      toast.success(`Cloned ${body.data.name}`);
      onDone(body.data.path, body.data.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Clone failed");
    } finally {
      setBusy(false);
    }
  };

  // Loading state
  if (reposLoading) {
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-[11px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading your GitHub repos…
      </div>
    );
  }

  // gh signed-in → searchable repo list
  if (repos) {
    return (
      <div className="flex flex-col">
        <div className="border-b border-border/70 p-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${repos.length} repos…`}
            className="h-8 border-border bg-muted/20 text-[11.5px] text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div className="max-h-72 min-h-[8rem] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-3 py-3 text-center text-[11px] text-muted-foreground/80">No matches.</div>
          )}
          {filtered.map((r) => (
            <button
              key={r.nameWithOwner}
              type="button"
              onClick={() => void clone(r.sshUrl || r.url)}
              disabled={busy}
              className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-muted/40 disabled:opacity-40"
            >
              <CloudDownload className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[11.5px] text-foreground">{r.nameWithOwner}</span>
                  {r.isPrivate && (
                    <span className="shrink-0 rounded bg-muted/50 px-1 py-px text-[9px] uppercase tracking-wider text-muted-foreground">
                      private
                    </span>
                  )}
                </div>
                {r.description && (
                  <div className="truncate text-[10.5px] text-muted-foreground">{r.description}</div>
                )}
              </div>
              {busy && <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-emerald-300/80" />}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // gh not available — manual URL fallback
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void clone(url.trim()); }}
      className="flex flex-col gap-2 p-3"
    >
      <label className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">Repository URL</label>
      <Input
        autoFocus
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://github.com/owner/repo.git"
        className="h-8 border-border bg-muted/20 font-mono text-[11.5px] text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      />
      <p className="text-[10.5px] leading-relaxed text-muted-foreground/80">
        Sign in with <code className="font-mono">gh auth login</code> to browse your repos here.
      </p>
      <div className="flex justify-end gap-1.5">
        <Button
          type="submit"
          size="sm"
          disabled={busy || !url.trim()}
          className="h-7 gap-1 px-3 text-[11px] font-medium"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="h-3.5 w-3.5" />}
          Clone
        </Button>
      </div>
    </form>
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
      <div className="flex items-center gap-1 border-b border-border/70 px-2 py-1.5">
        <button
          type="button"
          disabled={!canGoUp}
          onClick={() => browse?.parent && canGoUp && navigate(browse.parent)}
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted disabled:opacity-30"
          title="Up"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <code className="flex-1 truncate font-mono text-[11px] text-muted-foreground">{browse?.current || "…"}</code>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {browse && browse.dirs.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-muted-foreground/80">No subdirectories</div>
        )}
        {browse?.dirs.map((d) => (
          <button
            key={d.path}
            type="button"
            onClick={() => navigate(d.path)}
            className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11.5px] text-foreground/80 hover:bg-muted/50"
          >
            <FolderOpen className={cn("h-4 w-4", d.hasPolpoConfig ? "text-emerald-400/80" : "text-muted-foreground/80")} />
            <span className="truncate">{d.name}</span>
            {d.hasPolpoConfig && <span className="ml-auto text-[9px] text-emerald-400/70">polpo</span>}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-1 border-t border-border/70 px-2 py-1.5">
        <span className="text-[10px] text-muted-foreground/80 truncate">{browse?.dirs.length ?? 0} folders</span>
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
